"""One-dimensional regression tests extracted from ES-Sim."""
import warnings
import numpy as np
import pytest
import math
from pathlib import Path
from fastapi.testclient import TestClient
from es_sim.constants import ME, MP, QE
from es_sim.lxcat import parse_lxcat
from es_sim.mcc import KB, MccModel
from es_sim.schema import MccGas, MccSettings, XsProcess
from es_sim.server import app
DATA = Path(__file__).parent / "data"


SYN_E = DATA / "synthetic_electron.txt"


SYN_I = DATA / "synthetic_ion.txt"


def test_parse_synthetic_electron():
    """標準ブロック形式: ELASTIC/EFFECTIVE/EXCITATION/IONIZATION/ATTACHMENT。"""
    procs, warnings = parse_lxcat(SYN_E.read_text(encoding="utf-8"), "electron")
    # prompts/120 で意図的に変更 (物理の修正): Ar は ELASTIC と EFFECTIVE の両方を持つ。
    # 旧実装は両方を elastic として取り込み運動量移行断面積を二重計上していた
    # (4 プロセス)。新実装は ELASTIC を採用し EFFECTIVE を警告付きで除外、ATTACHMENT は
    # 従来どおり警告付きでスキップ → 3 プロセス + 警告 2 件
    assert [p.kind for p in procs] == ["elastic", "excitation", "ionization"]
    assert len(warnings) == 2
    assert any("EFFECTIVE" in w for w in warnings)
    assert any("ATTACHMENT" in w for w in warnings)

    elastic, excitation, ionization = procs
    assert abs(elastic.mass_ratio - 1.36e-5) < 1e-12
    assert elastic.threshold_ev == 0.0
    assert len(elastic.energy_ev) == 4 and len(elastic.sigma_m2) == 4
    assert abs(excitation.threshold_ev - 11.55) < 1e-9
    assert abs(ionization.threshold_ev - 15.759) < 1e-9
    assert "Elastic" in elastic.label  # PROCESS 行由来のラベル
    for p in procs:
        assert len(p.energy_ev) == len(p.sigma_m2) >= 2
        assert np.all(np.diff(p.energy_ev) >= 0.0)  # エネルギー昇順


def test_parse_synthetic_ion():
    """タイプ行なし形式 (SPECIES:/PROCESS: ブロック): Backscat + Isotropic。"""
    procs, warnings = parse_lxcat(SYN_I.read_text(encoding="utf-8"), "ion")
    assert [p.kind for p in procs] == ["backscat", "isotropic"]
    assert warnings == []
    for p in procs:
        assert p.threshold_ev == 0.0 and p.mass_ratio == 0.0
        assert len(p.energy_ev) == len(p.sigma_m2) == 3
        assert np.all(np.diff(p.energy_ev) >= 0.0)


def test_parse_species_filter():
    """種別フィルタ: 電子ファイルを species='ion' で読むと全て警告スキップ。"""
    procs, warnings = parse_lxcat(SYN_E.read_text(encoding="utf-8"), "ion")
    assert procs == []
    assert len(warnings) >= 3  # elastic×2 + excitation + ionization 分のスキップ警告


def test_parse_invalid_text_raises():
    """ブロックが 1 つも無いテキストは ValueError (エンドポイントでは 422)。"""
    with pytest.raises(ValueError):
        parse_lxcat("これは LXCat ファイルではありません\n1.0 2.0\n", "electron")


def test_lxcat_endpoint():
    """POST /lxcat/parse: 正常系 200、パース失敗 422。"""
    client = TestClient(app)
    r = client.post(
        "/lxcat/parse",
        json={"text": SYN_E.read_text(encoding="utf-8"), "species": "electron"},
    )
    assert r.status_code == 200
    body = r.json()
    # prompts/120 の意図的な変更: EFFECTIVE (ELASTIC と二重計上) を除外 → 4 → 3 プロセス
    assert len(body["processes"]) == 3
    assert len(body["warnings"]) == 2

    r = client.post("/lxcat/parse", json={"text": "no blocks here", "species": "electron"})
    assert r.status_code == 422


def test_collision_frequency_constant_sigma():
    """一定断面積 σ・電場なし・単色電子で、測定衝突率が ν = n_g σ v と数%で一致。"""
    sigma0 = 1.0e-19
    e0 = 10.0  # [eV]
    pressure = 10.0
    temperature = 300.0
    proc = XsProcess(
        kind="elastic",
        label="const sigma",
        mass_ratio=0.0,  # エネルギー損失なし → 速さ一定 → ν 一定
        energy_ev=[0.0, 40.0],
        sigma_m2=[sigma0, sigma0],
    )
    settings = MccSettings(
        gas=MccGas(name="Ar", pressure_pa=pressure, temperature_k=temperature),
        electron_processes=[proc],
        ion_processes=[],
        seed=7,
    )
    model = MccModel(settings, m_ion=40.0 * MP)

    n_gas = pressure / (KB * temperature)
    v0 = math.sqrt(2.0 * e0 * QE / ME)
    nu = n_gas * sigma0 * v0
    dt = 0.01 / nu  # ν·dt = 0.01 (1ステップ1衝突近似のバイアスを抑える)

    n = 50000
    rng = np.random.default_rng(3)
    th = rng.random(n) * 2.0 * np.pi
    # 2d3v: 速度は3成分 (vz = 0 の単色電子)
    v = v0 * np.stack([np.cos(th), np.sin(th), np.zeros(n)], axis=1)
    x = np.zeros(n)
    w = np.ones(n)
    elem = np.zeros(n, dtype=np.int64)

    steps = 40
    count = 0
    for _ in range(steps):
        res = model.collide_electrons(x, v, w, elem, dt)
        count += res.n_coll
        # mass_ratio=0 の弾性衝突なので速さは保存される
        assert np.allclose(np.linalg.norm(v, axis=1), v0, rtol=1e-10)

    rate = count / (n * steps * dt)
    assert abs(rate - nu) / nu < 0.05


_IONIZATION_PROC = {
    "kind": "ionization",
    "label": "synthetic ionization",
    "threshold_ev": 10.0,
    "mass_ratio": 0.0,
    "energy_ev": [10.0, 20.0, 1000.0],
    "sigma_m2": [0.0, 2.0e-20, 2.0e-20],
}


def test_no_ionization_below_threshold():
    """閾値 (10 eV) 未満の単色電子 (5 eV) では電離が一切起きない。"""
    settings = MccSettings(
        gas=MccGas(name="Ar", pressure_pa=100.0, temperature_k=300.0),
        electron_processes=[XsProcess(**_IONIZATION_PROC)],
        ion_processes=[],
        seed=1,
    )
    model = MccModel(settings, m_ion=40.0 * MP)

    n = 10000
    v0 = math.sqrt(2.0 * 5.0 * QE / ME)
    v = np.tile(np.array([v0, 0.0, 0.0]), (n, 1))
    x = np.zeros(n)
    w = np.ones(n)
    elem = np.zeros(n, dtype=np.int64)
    dt = 1e-10

    for _ in range(200):
        res = model.collide_electrons(x, v, w, elem, dt)
        assert res.n_coll == 0
        assert res.n_ionization == 0
    assert np.array_equal(v, np.tile(np.array([v0, 0.0, 0.0]), (n, 1)))  # 速度不変

