"""1D 診断の単位・保存則・読み取り専用性を検証する。"""
import copy
import json

import numpy as np
import pytest

from es_sim.constants import EPS0, ME, MP, QE
from es_sim.mcc import KB
from es_sim.pic1d import Pic1dSimulation, build_pic1d_result
from es_sim.schema import Pic1dSettings, Project
from reference_cases import get_presets


def make_sim(**overrides):
    settings = dict(gap_m=0.01, n_cells=8, init_density_m3=1e12,
                    n_macro=10, dt=1e-12, n_steps=10, frame_every=3,
                    avg_steps=10, parallel=False, convergence={"enabled": False})
    settings.update(overrides)
    return Pic1dSimulation(Project(pic1d=Pic1dSettings(**settings)))


def test_weighted_moments_conserve_charge_current_energy_and_remove_drift():
    sim = make_sim()
    electron = sim.species["electron"]
    electron.x = np.array([sim.gap / 2, sim.gap / 2])
    electron.w = np.array([1.0, 3.0])
    electron.v = np.array([[1e5, 2e5, 0.0], [3e5, 0.0, 4e5]])
    ion = sim.species["ion"]
    ion.x, ion.w, ion.v = np.empty(0), np.empty(0), np.empty((0, 3))
    moments = {name: sim.kernels.moments(sp.x, sp.v, sp.w, sim.dx, sim.n_nodes)
               for name, sp in sim.species.items()}
    fields = sim._moment_fields(moments)
    idx = sim.n_cells // 2
    weighted_u = np.average(electron.v, weights=electron.w, axis=0)
    weighted_v2 = np.average(electron.v**2, weights=electron.w, axis=0)
    weighted_variance = np.average((electron.v - weighted_u)**2, weights=electron.w, axis=0)
    assert fields["u_e_x"][idx] == pytest.approx(weighted_u[0])
    assert fields["thermal_e"][idx] == pytest.approx(ME / QE / 3 * weighted_variance.sum())
    assert fields["energy_e"][idx] == pytest.approx(ME / QE / 2 * weighted_v2.sum())
    assert fields["thermal_e"][idx] < fields["t_e"][idx]
    assert np.sum(fields["rho"] * sim.node_vol) == pytest.approx(-QE * electron.w.sum())
    for axis, axis_name in enumerate(("x", "y", "z")):
        assert np.sum(fields[f"j_e_{axis_name}"] * sim.node_vol) == pytest.approx(
            -QE * np.sum(electron.w * electron.v[:, axis]))
        assert fields[f"t_e_{axis_name}"][idx] == pytest.approx(ME / QE * weighted_variance[axis])
    assert np.sum(fields["kinetic_density_e"] * sim.node_vol) == pytest.approx(
        ME / 2 * np.sum(electron.w * np.sum(electron.v**2, axis=1)))
    assert fields["omega_pe"][idx] == pytest.approx(np.sqrt(fields["n_e"][idx] * QE**2 / (EPS0 * ME)))
    assert np.isnan(fields["lambda_debye"][0])


def test_wall_flux_power_current_and_continue_interval_are_normalized():
    sim = make_sim(n_macro=1, n_steps=1, frame_every=1, avg_steps=1)
    for sp in sim.species.values():
        sp.x[:] = sim.gap / 2
        sp.v[:] = 0
        sp.w[:] = 2.0
    ion = sim.species["ion"]
    ion.v[0, 0] = 2 * sim.gap / sim.dt
    impact_energy = 0.5 * ion.m * ion.v[0, 0]**2 * ion.w[0]
    sim.run_batch()
    h = sim.diagnostics_data()["history"]
    assert h["wall_flux_right_i"] == pytest.approx([2 / sim.dt])
    assert h["wall_power_right_i"] == pytest.approx([impact_energy / sim.dt])
    assert h["wall_current_right"] == pytest.approx([2 * QE / sim.dt])
    sim.prepare_continue(1, frame_every=1, avg_steps=1)
    sim.run_batch()
    h = sim.diagnostics_data()["history"]
    assert h["step"] == [2]
    assert h["wall_flux_right_i"] == [0]
    assert h["wall_power_right_i"] == [0]
    assert h["wall_current_right"] == [0]


def test_live_result_has_all_components_and_diagnostic_reads_do_not_change_rng():
    settings = get_presets()["edupic_ar"]["pic1d"]
    settings.update(n_cells=8, n_macro=200, n_steps=10, frame_every=3, avg_steps=10, parallel=False)
    sim = Pic1dSimulation(Project(pic1d=Pic1dSettings(**settings)))
    sim.run_batch()
    particles = {name: (sp.x.copy(), sp.v.copy(), sp.w.copy()) for name, sp in sim.species.items()}
    mcc_rng = copy.deepcopy(sim.mcc.rng.bit_generator.state)
    see_rng = copy.deepcopy(sim._see_rng.bit_generator.state)
    result = build_pic1d_result(sim, 0.0)
    frame = sim._make_frame(sim._last_phi)
    for sample in (frame["sample"], frame["ion_sample"]):
        for key in ("vx", "vy", "vz", "w", "energy", "ex", "ax"):
            assert len(sample[key]) == len(sample["x"])
    assert result["diagnostics"]["latest"]["step"] == 10
    assert result["diagnostics"]["history"]["step"] == [1, 3, 6, 9, 10]
    assert frame["diagnostic_counts"]["step"] == 10
    assert frame["diagnostics"]["catalog"]
    assert sim.mcc.rng.bit_generator.state == mcc_rng
    assert sim._see_rng.bit_generator.state == see_rng
    for name, sp in sim.species.items():
        for actual, expected in zip((sp.x, sp.v, sp.w), particles[name]):
            assert np.array_equal(actual, expected)
    for key in ("rho", "j_e_x", "u_i_z", "thermal_e", "energy_i", "power", "e_rms", "rho_solve"):
        assert len(result["profiles"][key]) == sim.n_nodes
    np.testing.assert_allclose(result["profiles"]["rho"],
                               QE * (np.array(result["profiles"]["n_i"]) - result["profiles"]["n_e"]), atol=1e-20)
    for table in result["diagnostics"]["cross_sections"]:
        np.testing.assert_allclose(table["nu_s"], sim.mcc.n_gas * np.array(table["sigma_m2"]) * table["speed_m_s"])
    json.dumps(result, allow_nan=False)


def test_average_uses_mean_square_field_and_phase_bins_have_sample_counts():
    sim = make_sim(n_steps=4, frame_every=2, avg_steps=4, phase_bins=8,
                   left={"voltage_rf": {"amplitude": 20, "freq_hz": 1e9}}, dt=1e-12)
    electric = []
    sim.enable_density_accum(1)
    for _ in range(4):
        sim.step()
        electric.append(sim._last_ex.copy())
    fields = sim.averaged_fields()
    np.testing.assert_allclose(fields["e_rms"], np.sqrt(np.mean(np.asarray(electric)**2, axis=0)))
    np.testing.assert_allclose(fields["electric_energy_density"], EPS0 / 2 * np.mean(np.asarray(electric)**2, axis=0))
    cycle = sim.cycle_data()
    assert np.sum(cycle["samples"]) == 4
    assert np.count_nonzero(cycle["samples"]) < 8
    assert cycle["e"].shape == (8, sim.n_nodes)
    assert cycle["ionization"].shape == (8, sim.n_nodes)


def test_stopping_before_average_preserves_last_profiles_and_empty_species_is_json_safe():
    sim = make_sim(n_macro=5001, n_steps=20, avg_steps=1)
    sim.run_batch(should_stop=lambda: sim.step_count >= 1)
    result = build_pic1d_result(sim, 0)
    assert result["profiles"] is None
    latest = result["diagnostics"]["latest"]
    for species in ("electron", "ion"):
        assert latest["particles"][species]["total_count"] == len(sim.species[species].x)
        assert len(latest["particles"][species]["x"]) <= 2000
    for sp in sim.species.values():
        sp.x, sp.v, sp.w = np.empty(0), np.empty((0, 3)), np.empty(0)
    sim.prepare_continue(1, frame_every=1, avg_steps=1)
    sim.run_batch()
    result = build_pic1d_result(sim, 0)
    assert result["diagnostics"]["latest"]["particles"]["ion"]["x"] == []
    assert result["profiles"]["lambda_debye"] == [None] * sim.n_nodes
    json.dumps(result, allow_nan=False)


def test_parameter_metadata_reports_exact_constants_and_active_physical_inputs():
    sim = make_sim(left={"v_dc": 25, "see_gamma": 0.2,
                         "voltage_rf": {"amplitude": 7, "freq_hz": 1e7, "phase_deg": 30},
                         "fn": {"phi_ev": 4.5, "beta": 2},
                         "blocking_capacitor": {"capacitance": 1e-5, "initial_bias_v": -2}})
    parameters = {p["key"]: p for p in sim.diagnostic_parameters()}
    for key, value in (("QE", QE), ("ME", ME), ("MP", MP), ("EPS0", EPS0), ("KB", KB)):
        assert parameters[key]["value"] == value
        assert parameters[key]["unit"]
    assert parameters["ion.m"]["value"] == sim.s.ion_mass_amu * MP
    assert parameters["left.fn.weight"]["value"] == sim.initial_macro_weight
    assert parameters["left.capacitance"]["unit"] == "F/m^2"
    assert parameters["left.rf.0.frequency"]["value"] == 1e7
    assert not any("seed" in key for key in parameters)


def test_initial_snapshot_preserves_field_time_and_leapfrog_half_step():
    sim = make_sim()
    latest = sim.diagnostic_latest()
    assert latest["step"] == 0
    assert latest["t"] == latest["field_t"] == 0
    assert latest["velocity_t"] == -sim.dt / 2
    assert sim.diagnostics_data()["history"]["step"] == []


def test_adaptive_mcc_diagnostic_is_the_value_used_for_candidate_sampling():
    settings = get_presets()["edupic_ar"]["pic1d"]
    settings.update(n_cells=8, n_macro=200, n_steps=1, frame_every=1, avg_steps=1, parallel=False)
    sim = Pic1dSimulation(Project(pic1d=Pic1dSettings(**settings)))
    used_numax = []
    original = sim.mcc._candidates

    def record_candidates(n, numax, dt, elem=None):
        used_numax.append(numax)
        return original(n, numax, dt, elem)

    sim.mcc._candidates = record_candidates
    sim.run_batch()
    h = sim.diagnostics_data()["history"]
    assert len(used_numax) == 2
    for suffix, actual in zip(("e", "i"), used_numax):
        assert h[f"adaptive_numax_{suffix}"] == [actual]
        assert h[f"candidate_probability_{suffix}"] == pytest.approx([1 - np.exp(-actual * sim.dt)])
        assert actual <= h[f"numax_{suffix}"][0]


def test_circuit_charge_diagnostics_match_solver_identity_and_current_update():
    sim = make_sim(n_steps=3, frame_every=1, avg_steps=3,
                   left={"v_dc": 25, "blocking_capacitor": {"capacitance": 1e-5, "initial_bias_v": -2}},
                   right={"blocking_capacitor": {"capacitance": 3e-5}})
    sim.run_batch()
    h = sim.diagnostics_data()["history"]
    for side in ("left", "right"):
        start = np.array(h[f"q_node_start_{side}"])
        end = np.array(h[f"q_node_end_{side}"])
        surface = np.array(h[f"electrode_charge_{side}"])
        capacitor = np.array(h[f"capacitor_charge_{side}"])
        np.testing.assert_allclose(start, surface + capacitor, rtol=1e-9, atol=1e-18)
        np.testing.assert_allclose(end - start, np.array(h[f"wall_current_{side}"]) * sim.dt, atol=1e-18)
        np.testing.assert_allclose(capacitor, np.array(h[f"blocking_capacitance_{side}"]) * h[f"capacitor_bias_{side}"])
    inactive = make_sim(n_steps=1, frame_every=1, avg_steps=1)
    inactive.run_batch()
    disabled = inactive.diagnostics_data()["history"]
    assert disabled["q_node_end_left"] == [None]
    assert disabled["adaptive_numax_e"] == [None]
    assert disabled["collision_e_rate"] == [None]
