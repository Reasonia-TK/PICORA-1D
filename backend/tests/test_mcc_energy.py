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
M_HE = 6.67e-27  # He+ 質量 [kg] (Turner)


def test_ionization_half_split_energy():
    """ionization_split='half' (既定): 散乱電子・生成電子のエネルギーが余剰の半分ずつ。"""
    threshold = 10.0
    e0 = 20.0  # 入射エネルギー [eV] → 余剰 10 eV → 各 5 eV
    proc = XsProcess(
        kind="ionization",
        label="synthetic ionization",
        threshold_ev=threshold,
        energy_ev=[threshold, threshold + 1e-6, 1000.0],
        sigma_m2=[0.0, 2.0e-20, 2.0e-20],
    )
    settings = MccSettings(
        gas=MccGas(name="He", pressure_pa=100.0, temperature_k=300.0),
        electron_processes=[proc],
        ion_processes=[],
        seed=9,
    )
    assert settings.ionization_split == "half"  # 既定が等分であること
    model = MccModel(settings, m_ion=M_HE)

    n = 20000
    v0 = math.sqrt(2.0 * e0 * QE / ME)
    v = np.tile(np.array([v0, 0.0, 0.0]), (n, 1))
    x = np.zeros(n)
    w = np.ones(n)
    elem = np.zeros(n, dtype=np.int64)
    dt = 0.3 / model.numax_e  # 衝突が十分起きる dt

    res = model.collide_electrons(x, v, w, elem, dt)
    assert res.n_ionization > 100

    excess = e0 - threshold
    # 生成電子のエネルギーは全て余剰の半分
    e_eject = 0.5 * ME * np.sum(res.new_v_e**2, axis=1) / QE
    assert np.allclose(e_eject, 0.5 * excess, rtol=1e-9)
    # 散乱電子 (衝突した入射電子) も余剰の半分 → 2電子のエネルギー和 = 残余
    e_after = 0.5 * ME * np.sum(v**2, axis=1) / QE
    scattered = np.abs(e_after - 0.5 * excess) < 1e-6
    assert int(scattered.sum()) == res.n_ionization
    e_sum = e_after[scattered][: res.n_ionization] + e_eject
    assert np.allclose(e_sum, excess, rtol=1e-9)
    # 衝突しなかった電子は入射エネルギーのまま
    assert np.allclose(e_after[~scattered], e0, rtol=1e-9)


def test_ionization_random_split_energy():
    """ionization_split='random': 分配比は乱数だが 2 電子の和は常に余剰と一致。"""
    threshold = 10.0
    e0 = 20.0
    proc = XsProcess(
        kind="ionization",
        label="synthetic ionization",
        threshold_ev=threshold,
        energy_ev=[threshold, threshold + 1e-6, 1000.0],
        sigma_m2=[0.0, 2.0e-20, 2.0e-20],
    )
    settings = MccSettings(
        gas=MccGas(name="He", pressure_pa=100.0, temperature_k=300.0),
        electron_processes=[proc],
        ion_processes=[],
        seed=9,
        ionization_split="random",
    )
    model = MccModel(settings, m_ion=M_HE)

    n = 20000
    v0 = math.sqrt(2.0 * e0 * QE / ME)
    v = np.tile(np.array([v0, 0.0, 0.0]), (n, 1))
    res = model.collide_electrons(
        np.zeros((n, 2)), v, np.ones(n), np.zeros(n, dtype=np.int64),
        0.3 / model.numax_e,
    )
    assert res.n_ionization > 100

    excess = e0 - threshold
    e_after = 0.5 * ME * np.sum(v**2, axis=1) / QE
    e_eject = 0.5 * ME * np.sum(res.new_v_e**2, axis=1) / QE
    scattered = e_after < e0 - 1e-6
    assert int(scattered.sum()) == res.n_ionization
    # 散乱電子 e_scat と生成電子 e_eject は同一イベントで e_scat + e_eject = excess。
    # 生成順はインデックス昇順で保存されるので直接和を取る
    assert np.allclose(e_after[scattered] + e_eject, excess, rtol=1e-9)
    # 等分ではない (分配比がばらつく)
    assert np.std(e_eject) > 0.1


def _ion_step_process(e_c: float) -> XsProcess:
    """閾値 e_c [eV] 未満で σ=0、以上で一定 σ のステップ型イオン断面積。"""
    return XsProcess(
        kind="isotropic",
        label="step sigma",
        energy_ev=[0.0, e_c - 1e-6, e_c, 100.0],
        sigma_m2=[0.0, 0.0, 3.0e-19, 3.0e-19],
    )


def test_ion_energy_frame_com_vs_lab():
    """E_lab = 8 eV、E_com = ½μg² ≈ 4 eV のイオンとステップ断面積 (6 eV):
    lab 参照では衝突するが、com 参照では衝突しない。"""
    e_lab = 8.0
    e_c = 6.0  # E_com (4 eV) < e_c < E_lab (8 eV)
    v0 = math.sqrt(2.0 * e_lab * QE / M_HE)
    gas = MccGas(name="He", pressure_pa=100.0, temperature_k=300.0)

    counts = {}
    for frame in ("lab", "com"):
        settings = MccSettings(
            gas=gas,
            electron_processes=[],
            ion_processes=[_ion_step_process(e_c)],
            seed=13,
            ion_energy_frame=frame,
        )
        model = MccModel(settings, m_ion=M_HE)
        assert model.numax_i > 0.0
        n = 20000
        v = np.tile(np.array([v0, 0.0, 0.0]), (n, 1))
        counts[frame] = model.collide_ions(v, 0.3 / model.numax_i)

    assert counts["lab"] > 100   # 実験室系参照: σ(8 eV) > 0 → 衝突する
    assert counts["com"] == 0    # 重心系参照: σ(≈4 eV) = 0 → 衝突しない


def test_ion_com_energy_value():
    """重心系エネルギーの値の確認: 閾値を E_com の上下に置いたときの衝突有無が
    E = ½μg² (μ = m/2、冷ガス極限で g ≈ v_ion) と整合する。"""
    e_lab = 8.0
    e_com = 0.5 * e_lab  # 等質量・冷ガス極限で E_com = E_lab/2
    v0 = math.sqrt(2.0 * e_lab * QE / M_HE)
    # ガス温度を極低温にして熱ばらつきをなくす (n_gas は pressure/kT で決まるだけ)
    gas = MccGas(name="He", pressure_pa=1.0, temperature_k=1e-3)

    for e_c, expect_coll in ((e_com * 0.98, True), (e_com * 1.02, False)):
        settings = MccSettings(
            gas=gas,
            electron_processes=[],
            ion_processes=[_ion_step_process(e_c)],
            seed=17,
            ion_energy_frame="com",
        )
        model = MccModel(settings, m_ion=M_HE)
        n = 20000
        v = np.tile(np.array([v0, 0.0, 0.0]), (n, 1))
        n_coll = model.collide_ions(v, 0.3 / model.numax_i)
        if expect_coll:
            assert n_coll > 100
        else:
            assert n_coll == 0

