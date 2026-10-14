"""PIC の電極電荷と外部回路の連成・壁伝導電荷・継続状態を検証する。"""
import copy
import json

import numpy as np
import pytest

from es_sim.constants import EPS0, QE
from es_sim.pic1d import Pic1dSimulation, build_pic1d_result
from es_sim.schema import Pic1dSettings, Project


def graph(parts):
    """同じ名前のノードを配線で結ぶ、PIC 端子付き回路。"""
    components, nodes, wires = [], {}, []
    for identifier, kind, pins, parameters in parts:
        components.append({"id": identifier, "kind": kind, "ports": list(pins), "parameters": parameters})
        for port, node in pins.items():
            nodes.setdefault(node, []).append({"component_id": identifier, "port": port})
    components.append({"id": "gnd", "kind": "GND", "ports": ["g"], "parameters": {}})
    nodes.setdefault("0", []).append({"component_id": "gnd", "port": "g"})
    for endpoints in nodes.values():
        for endpoint in endpoints[1:]:
            wires.append({"id": f"w{len(wires)}", "source": endpoints[0], "target": endpoint})
    return {"schema_version": 1, "name": "PIC coupling test", "components": components, "wires": wires}


def network(extra=(), amplitude=10.0, frequency=1e8):
    return graph([
        ("pic", "PIC", {"left": "electrode", "right": "0"}, {}),
        ("v1", "V", {"p": "source", "n": "0"}, {
            "dc_v": 0.0, "waveform": {"kind": "sin", "offset_v": 0.0, "amplitude_v": amplitude,
                                      "frequency_hz": frequency, "phase_deg": 0.0},
        }),
        ("r1", "R", {"p": "source", "n": "electrode"}, {"value": 100.0}),
        *extra,
    ])


def project(document=None, enabled=True, **settings):
    data = dict(gap_m=0.01, n_cells=8, init_density_m3=1e12, init_te_ev=2.0,
                n_macro=20, dt=1e-12, n_steps=20, frame_every=2, avg_steps=20,
                parallel=False, phase_bins=0, convergence={"enabled": False},
                external_circuit={"enabled": enabled, "area_m2": 0.01,
                                  "document": document or network()})
    data.update(settings)
    return Project(pic1d=Pic1dSettings(**data))


def test_vacuum_series_resistor_obeys_backward_euler_and_port_current_balance():
    """真空 PIC の容量が R と同時に解かれ、電流は離散変位電流と一致する。"""
    sim = Pic1dSimulation(project(init_density_m3=1.0, dt=1e-11, n_macro=4,
                                 left={"v_dc": 999.0}, right={"v_dc": 333.0}))
    capacitance = EPS0 / sim.gap * sim.s.external_circuit.area_m2
    previous_voltage = 0.0
    previous_charge = sim.electrode_charges(sim._last_phi, sim._last_f_dep)[0]
    for _ in range(120):
        field_time = sim.t
        conduction = sim._external_pending_charge[0]
        phi = sim.step()
        source = 10.0 * np.sin(2 * np.pi * 1e8 * field_time)
        if field_time > 0.0:
            expected = (capacitance / sim.dt * previous_voltage + source / 100.0) / (capacitance / sim.dt + 0.01)
            assert phi[0] == pytest.approx(expected, abs=1e-8)
            charge = sim.electrode_charges(phi, sim._last_f_dep)[0]
            total_current = (charge - previous_charge - conduction) * sim.s.external_circuit.area_m2 / sim.dt
            assert total_current == pytest.approx((source - phi[0]) / 100.0, abs=1e-10)
            previous_charge = charge
        assert phi[-1] == pytest.approx(0.0, abs=1e-14)
        previous_voltage = phi[0]
    assert sim.external_circuit is not None and sim.circuit is None
    assert sim.diagnostics_data()["history"]["source_left"][-1] is None


def test_green_induced_charge_matches_gauss_surface_charge_with_particles():
    sim = Pic1dSimulation(project())
    for _ in range(25):
        phi = sim.step()
        induced = -(sim._external_psi @ sim._last_f_dep)
        capacitance = EPS0 / sim.gap * np.array([[1.0, -1.0], [-1.0, 1.0]])
        surface = sim.electrode_charges(phi, sim._last_f_dep)
        np.testing.assert_allclose(surface, capacitance @ phi[[0, -1]] + induced, rtol=1e-11, atol=1e-21)
        assert surface.sum() + sim._last_f_dep.sum() == pytest.approx(0.0, abs=1e-21)


@pytest.mark.parametrize("species,side,gamma,multiplier", [
    ("electron", "left", 0.0, -1.0),
    ("ion", "right", 0.0, 1.0),
    ("ion", "left", 1.0, 2.0),
])
def test_absorption_and_see_have_correct_charge_sign_and_are_passed_once(species, side, gamma, multiplier):
    sim = Pic1dSimulation(project(n_macro=1, left={"see_gamma": gamma}))
    for sp in sim.species.values():
        sp.x[:] = sim.gap / 2
        sp.v[:] = 0.0
        sp.w[:] = 2.0
    sp = sim.species[species]
    sp.v[:, 0] = (-1 if side == "left" else 1) * 2 * sim.gap / sim.dt
    sim.step()
    index = 0 if side == "left" else 1
    expected = multiplier * QE * 2.0
    assert sim._external_pending_charge[index] == pytest.approx(expected)
    captured = []
    original_solve = sim.external_circuit.solve

    def record(q_induced, time, dt, conduction):
        captured.append(np.array(conduction))
        return original_solve(q_induced, time, dt, conduction)

    sim.external_circuit.solve = record
    sim.step()
    assert captured[0][index] == pytest.approx(expected)
    metadata = sim.external_circuit_data()["metadata"]
    assert metadata["field_t_s"] == sim.t - sim.dt
    assert metadata["particle_t_s"] == sim.t
    assert metadata["pending_conduction_charge_c"] == pytest.approx(
        sim._external_pending_charge * sim.s.external_circuit.area_m2)


def test_fn_emission_adds_positive_electrode_charge():
    document = graph([
        ("pic", "PIC", {"left": "electrode", "right": "0"}, {}),
        ("v1", "V", {"p": "electrode", "n": "0"}, {"dc_v": -3000.0}),
    ])
    sim = Pic1dSimulation(project(document, gap_m=0.0025, n_cells=32, init_density_m3=1e12,
                                 left={"fn": {"phi_ev": 4.5, "beta": 2500.0, "init_energy_ev": 0.5,
                                              "macro_weight": 1e9}}))
    for sp in sim.species.values():
        sp.x, sp.w, sp.v = np.empty(0), np.empty(0), np.empty((0, 3))
    sim.step()
    assert sim.fn_total_w["left"] > 0.0
    assert sim._external_pending_charge[0] == pytest.approx(QE * sim.fn_total_w["left"])
    assert sim._external_pending_charge[1] == 0.0


def test_continue_keeps_circuit_and_pending_wall_charge_and_stop_is_read_only():
    document = network([("c1", "C", {"p": "electrode", "n": "0"}, {"value": 1e-10})], amplitude=40.0)
    full = Pic1dSimulation(project(document, n_steps=100))
    full.run_batch(store_frames=False)
    part = Pic1dSimulation(project(document, n_steps=37))
    part.run_batch(store_frames=False)
    state_before = (part._external_pending_charge.copy(), part._external_last_voltage.copy(),
                    part._external_last_solve_t, copy.deepcopy(part.external_circuit.frame()))
    part.prepare_continue(63)
    assert np.array_equal(part._external_pending_charge, state_before[0])
    part.run_batch(store_frames=False)
    for name in full.species:
        for attr in ("x", "v", "w"):
            np.testing.assert_array_equal(getattr(full.species[name], attr), getattr(part.species[name], attr))
    np.testing.assert_array_equal(full._external_last_voltage, part._external_last_voltage)
    np.testing.assert_array_equal(full._external_pending_charge, part._external_pending_charge)
    final_state = part.external_circuit.frame()["latest"]
    assert final_state == full.external_circuit.frame()["latest"]
    part.prepare_continue(5)
    part.run_batch(should_stop=lambda: True, store_frames=False)
    assert final_state == part.external_circuit.frame()["latest"]
    result = build_pic1d_result(part, 0.0)
    assert result["external_circuit"]["metadata"]["particle_t_s"] == part.t
    assert result["external_circuit"]["metadata"]["field_t_s"] == full._external_last_solve_t
    json.dumps(result, allow_nan=False)


def test_disabled_external_circuit_preserves_legacy_particle_state():
    enabled_false = project(enabled=False, left={"v_dc": 20.0})
    legacy = enabled_false.model_copy(deep=True)
    legacy.pic1d.external_circuit = None
    a, b = Pic1dSimulation(enabled_false), Pic1dSimulation(legacy)
    for _ in range(20):
        np.testing.assert_array_equal(a.step(), b.step())
    for name in a.species:
        np.testing.assert_array_equal(a.species[name].x, b.species[name].x)
        np.testing.assert_array_equal(a.species[name].v, b.species[name].v)
    assert build_pic1d_result(a, 0.0)["external_circuit"] is None


def test_external_circuit_and_legacy_blocking_capacitor_are_rejected():
    with pytest.raises(ValueError, match="同時"):
        project(left={"blocking_capacitor": {"capacitance": 1e-6}})


def test_cycle_frequency_comes_from_actual_external_sources():
    sim = Pic1dSimulation(project(phase_bins=8, left={"voltage_rf": {"amplitude": 100.0, "freq_hz": 1e6}}))
    assert sim._cycle_enabled
    assert sim._cycle_freq == 1e8
    parameters = {p["key"] for p in sim.diagnostic_parameters()}
    assert "left.dc" not in parameters
    assert "left.rf.0.frequency" not in parameters
    assert "external.area" in parameters


def test_frame_reports_circuit_time_and_initial_stop_is_json_safe():
    sim = Pic1dSimulation(project(n_steps=2, frame_every=1))
    sim.run_batch(should_stop=lambda: True)
    initial = build_pic1d_result(sim, 0.0)["external_circuit"]
    assert initial["metadata"]["field_t_s"] == initial["metadata"]["particle_t_s"] == 0.0
    sim.prepare_continue(2, frame_every=1)
    _, frames = sim.run_batch()
    assert frames[-1]["external_circuit"]["catalog"]
    assert frames[-1]["external_circuit"]["metadata"]["field_t_s"] == sim.t - sim.dt
    json.dumps(frames, allow_nan=False)
