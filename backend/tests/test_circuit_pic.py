"""One-dimensional regression tests extracted from ES-Sim."""
import warnings
import numpy as np
import pytest
from es_sim.constants import EPS0
from es_sim.pic1d import Pic1dSimulation, build_pic1d_result, electrode_voltage
from reference_cases import edupic_ar_processes
from es_sim.schema import BlockingCapacitor1d, Pic1dElectrode, Pic1dSettings, Project, VoltageRF
F0 = 13.56e6


GAP = 0.025


@pytest.fixture(autouse=True)
def _quiet():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        yield


def _mcc(seed: int = 0) -> dict:
    e_procs, i_procs = edupic_ar_processes()
    return {"gas": {"name": "Ar", "pressure_pa": 10.0, "temperature_k": 350.0},
            "electron_processes": [p.model_dump() for p in e_procs],
            "ion_processes": [p.model_dump() for p in i_procs], "seed": seed}


def _project_1d(left=None, right=None, dens=1e15, mcc=True, n_macro=4000, gamma=0.1, **kw) -> Project:
    """eduPIC の Ar 条件 (10 Pa・ギャップ 2.5 cm) に左 250 V・13.56 MHz。両側の γ = 0.1。"""
    s = Pic1dSettings(
        gap_m=GAP, n_cells=128,
        left=Pic1dElectrode(v_dc=0.0, voltage_rf=VoltageRF(amplitude=250.0, freq_hz=F0), see_gamma=gamma,
                            blocking_capacitor=left),
        right=Pic1dElectrode(v_dc=0.0, see_gamma=gamma, blocking_capacitor=right),
        init_density_m3=dens, init_te_ev=2.0, init_ti_ev=0.03, ion_mass_amu=39.948, n_macro=n_macro,
        dt=1.0 / (400.0 * F0), n_steps=100, frame_every=1_000_000, phase_bins=0,
        mcc=_mcc() if mcc else None, **kw,
    )
    return Project(pic1d=s)


def _total_charge_1d(sim: Pic1dSimulation) -> float:
    q = sum(sp.q * float(sp.w.sum()) for sp in sim.species.values())
    return q + float(np.sum(sim.circuit.q_node))


def test_vacuum_divider_pic1d():
    cb = 1.0e-8
    sim = Pic1dSimulation(_project_1d(BlockingCapacitor1d(capacitance=cb, initial_bias_v=-20.0), dens=1e3,
                                      mcc=False, n_macro=10))
    c = EPS0 / GAP
    assert sim.circuit.c[0, 0] == pytest.approx(c, rel=1e-12)
    for _ in range(300):
        t = sim.t
        phi = sim.step()
        expected = -20.0 + electrode_voltage(sim.s.left, t) * cb / (cb + c)
        assert phi[0] == pytest.approx(expected, abs=1e-8)
        assert phi[0] == sim.circuit.v[0]


def test_charge_identity_and_conservation_pic1d():
    """両側にコンデンサ (MCC・二次電子あり): 恒等式は電束の形で丸め誤差、粒子 + Q_N の電荷は保存。"""
    sim = Pic1dSimulation(_project_1d(BlockingCapacitor1d(capacitance=1.0e-7, initial_bias_v=5.0),
                                      BlockingCapacitor1d(capacitance=3.0e-7)))
    solve = sim._solve_phi
    worst = []

    def checked(f_dep, t):
        phi = solve(f_dep, t)
        r = sim.circuit.residual(sim.electrode_charges(phi, f_dep))
        worst.append(float(np.max(np.abs(r))) / float(np.max(np.abs(sim.circuit.q_node))))
        return phi

    sim._solve_phi = checked
    q0 = _total_charge_1d(sim)
    for _ in range(1500):
        sim.step()
    assert max(worst) < 1e-11
    absorbed = sum(sum(w.values()) for w in sim.wall.values()) * 1.602176634e-19
    assert absorbed > 1e-7 and sim.see_events > 0.0
    assert abs(_total_charge_1d(sim) - q0) < 1e-13 * absorbed


def test_fn_emission_charges_the_electrode_pic1d():
    """FN 電界放出の電子の分 +e·w が電極の Q_N に入り、粒子 + Q_N の電荷が保存する (ギャップ 2.5 mm・−3 kV)。"""
    s = Pic1dSettings(
        gap_m=0.0025, n_cells=64,
        left=Pic1dElectrode(v_dc=-3000.0, fn={"phi_ev": 4.5, "beta": 2500.0, "init_energy_ev": 0.5, "macro_weight": 1e9},
                            blocking_capacitor=BlockingCapacitor1d(capacitance=1e-5)),
        right=Pic1dElectrode(v_dc=0.0, blocking_capacitor=BlockingCapacitor1d(capacitance=1e-5)),
        init_density_m3=1e12, init_te_ev=1.0, n_macro=200, dt=1e-12, n_steps=10, frame_every=1_000_000, phase_bins=0,
    )
    sim = Pic1dSimulation(Project(pic1d=s))
    sim.step()
    q0 = _total_charge_1d(sim)
    for _ in range(60):
        sim.step()
    emitted = sim.fn_total_w["left"] * 1.602176634e-19
    assert emitted > 1e-6
    assert abs(_total_charge_1d(sim) - q0) < 1e-12 * emitted


def test_large_capacitance_matches_direct_coupling_pic1d():
    direct = Pic1dSimulation(_project_1d())
    cap = Pic1dSimulation(_project_1d(BlockingCapacitor1d(capacitance=1.0e6)))
    for _ in range(200):
        p_direct = direct.step()
        p_cap = cap.step()
    assert np.max(np.abs(p_direct - p_cap)) < 1e-6
    np.testing.assert_allclose(direct.species["electron"].x, cap.species["electron"].x, rtol=0, atol=1e-9)


def test_continue_and_result_pic1d():
    cap = BlockingCapacitor1d(capacitance=1.0e-7, initial_bias_v=-10.0)
    full = Pic1dSimulation(_project_1d(cap, n_macro=2000))
    full.s.n_steps = 1000
    full.run_batch(store_frames=False)
    part = Pic1dSimulation(_project_1d(cap, n_macro=2000))
    part.s.n_steps = 450
    part.s.frame_every = 150
    _, frames = part.run_batch()
    assert frames[-1]["circuit"][0]["label"] == "left"
    part.prepare_continue(extra_steps=550)
    part.run_batch(store_frames=False)
    np.testing.assert_array_equal(full.species["electron"].x, part.species["electron"].x)
    np.testing.assert_array_equal(full.circuit.q_node, part.circuit.q_node)
    # 1 周期 = 400 ステップ: 450 ステップ目は 2 周期目の途中。続きで 2 周期目が閉じる
    assert full.circuit.history["t"][-1:] == part.circuit.history["t"]
    assert full.circuit.history["v_dc"][-1:] == part.circuit.history["v_dc"]
    bundle = build_pic1d_result(part, elapsed_s=1.0)
    res = bundle["circuit"]
    assert res["units"]["capacitance"] == "F/m^2" and res["period_s"] == pytest.approx(1.0 / F0)
    e = res["electrodes"][0]
    assert e["label"] == "left" and e["c_self"] == pytest.approx(EPS0 / GAP) and len(e["v_dc"]) == 1
    plain = Pic1dSimulation(_project_1d(n_macro=100))
    plain.step()
    assert build_pic1d_result(plain, elapsed_s=0.0)["circuit"] is None

