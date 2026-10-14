"""One-dimensional regression tests extracted from ES-Sim."""
import warnings
import numpy as np
import pytest
from es_sim.pic1d import Pic1dSimulation, build_pic1d_result, electrode_voltage
from es_sim.schema import Pic1dSettings, Pic1dElectrode, Project
def _project1d(pic1d):
    return Project(pic1d=pic1d)
def test_pic1d_wall_iedf_disabled_when_bins_zero():
    s = Pic1dSettings(
        gap_m=0.01, n_cells=20, init_density_m3=1e14, n_macro=500, dt=2e-10,
        n_steps=50, frame_every=50, wall_iedf_bins=0,
    )
    sim = Pic1dSimulation(_project1d(pic1d=s))
    sim.run_batch()
    assert sim.wall_iedf is None
    result = build_pic1d_result(sim, 0.0)
    assert result["wall_iedf"] is None


def test_pic1d_wall_iedf_dc_bias_mean_energy_matches_sheath_potential():
    """DC 強バイアス (無衝突・左電極 -100V、右電極 0V) の左壁 IEDF。

    ionization/MCC 無しの単純な系では電子は自由拡散で速やかに失われるため、
    シース構造が確立し (電子がほぼ枯渇した) 十分後の時間窓で平均をとる。
    このとき左壁へ吸収されるイオンは (右寄りのバルク電位 ≈ 0V) から
    (左電極電位 -100V) までをほぼ無衝突で自由落下するので、平均エネルギーは
    印加電位差 100 eV に近い値になる (rtol 10%)。重み和はこの区間中に実際に
    左壁で吸収されたイオンの重み (self.wall["left"]["ion"] の増分) と一致する。
    """
    s = Pic1dSettings(
        gap_m=0.02, n_cells=64, init_density_m3=1.0e14, init_te_ev=2.0, init_ti_ev=0.05,
        n_macro=8000, n_steps=1, frame_every=100000, seed=3,
        left=Pic1dElectrode(v_dc=-100.0), right=Pic1dElectrode(v_dc=0.0),
        wall_iedf_bins=80,
    )
    sim = Pic1dSimulation(_project1d(pic1d=s))
    for _ in range(21000):
        sim.step()

    sim.enable_density_accum(sim.step_count + 1)
    wall_i_before = sim.wall["left"]["ion"]
    for _ in range(1500):
        sim.step()
    wall_i_after = sim.wall["left"]["ion"]

    sim.fields = sim.averaged_fields()
    sim.wall_iedf = sim.wall_iedf_data()
    assert sim.wall_iedf is not None
    left = sim.wall_iedf["left"]

    assert left["total_weight"] == pytest.approx(wall_i_after - wall_i_before, rel=1e-9)
    assert wall_i_after > wall_i_before  # 実際にこの区間でイオンが吸収されている
    assert left["mean_energy_ev"] == pytest.approx(100.0, rel=0.10)

    # electrode_voltage は fluid1d/pic1d 共通の電圧評価関数 (回帰確認を兼ねる)
    assert electrode_voltage(sim.s.left, sim.t) == pytest.approx(-100.0)

