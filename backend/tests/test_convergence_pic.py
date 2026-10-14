"""One-dimensional regression tests extracted from ES-Sim."""
import warnings
import numpy as np
import pytest
import json
from es_sim.convergence import TOL_PIC
from es_sim.pic1d import Pic1dSimulation, build_pic1d_result
from es_sim.schema import Project
F0 = 13.56e6


T = 1.0 / F0


SPP = 200


@pytest.fixture(autouse=True)
def _quiet():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        yield


def _force_convergence(sim, period: int) -> None:
    """判定の結果に関係なく、period を閉じたところで収束とする (エンジンの止める配線だけを確かめる)。"""
    mon = sim.conv
    judge = mon._judge

    def forced(t, step, k_closed):
        judge(t, step, k_closed)
        if k_closed == period and not mon.converged:
            mon.converged = True
            mon.converged_at = {"t": t, "step": step, "period": k_closed}
            mon.stop_now = mon.stop and not mon._converged_at_run_start

    mon._judge = forced


def _p1d(periods: int, **conv) -> Project:
    return Project.model_validate({
        "pic1d": {
            "gap_m": 0.02, "n_cells": 64, "n_macro": 4000, "init_density_m3": 1e15, "init_te_ev": 2.0,
            "left": {"voltage_rf": {"amplitude": 100.0, "freq_hz": F0},
                     "blocking_capacitor": {"capacitance": 1e-2, "initial_bias_v": 0.0}},
            "dt": T / SPP, "n_steps": periods * SPP, "frame_every": SPP, "avg_steps": 2 * SPP,
            "convergence": conv,
        },
    })


def _check_periods(r: dict, n: int) -> None:
    json.dumps(r, allow_nan=False)
    assert r["basis"] == "rf" and r["tol"] == TOL_PIC
    assert r["period"] == list(range(n))
    assert np.allclose(np.asarray(r["t"]) / T, np.arange(1, n + 1), rtol=1e-9)


def test_pic1d_judges_each_rf_period():
    frames = []
    sim = Pic1dSimulation(_p1d(8))
    sim.run_batch(callback=frames.append, store_frames=False)
    r = build_pic1d_result(sim, 0.0)["convergence"]
    _check_periods(r, 8)
    assert set(r["d"]) == {"phi", "n_e", "N_e", "N_i", "V_dc:left"}
    assert sim.conv.stride == SPP // 64            # 1 周期に 64 回ほど足し込む
    assert r["window"][-1] is not None              # 雑音から窓を決めている
    assert [f["convergence"]["checks"] for f in frames] == list(range(1, 9))


def test_pic1d_stop_takes_the_averaging_window():
    sim = Pic1dSimulation(_p1d(40, stop=True))
    _force_convergence(sim, 3)
    sim.run_batch(store_frames=False)
    r = build_pic1d_result(sim, 0.0)["convergence"]
    assert r["converged"] and r["stopped"] and r["converged_period"] == 3
    assert sim.step_count == r["converged_step"] + 2 * SPP == 6 * SPP
    assert len(sim.history["step"]) == sim.step_count
    assert sim.fields["avg_steps"] == 2 * SPP


def test_disabled_judgement_adds_nothing():
    sim = Pic1dSimulation(_p1d(2, enabled=False))
    sim.run_batch(store_frames=False)
    assert sim.conv is None and build_pic1d_result(sim, 0.0)["convergence"] is None

