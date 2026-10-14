"""Independent circuit invariants and analytical transient reference cases."""
import math

import numpy as np
import pytest
from pydantic import ValidationError
from scipy.integrate import solve_ivp

from es_sim.external_circuit import ExternalCircuit, source_voltage, switch_on
from es_sim.external_circuit_schema import ExternalCircuitSettings, CircuitDocument, PORTS, circuit_frequency
from es_sim.external_coax import CoaxModel
from es_sim.external_diode import DiodeModel


def settings(parts, *, area=1, enabled=True):
    """Create a graph from (id,kind,nodes,parameters), independent of MNA."""
    components = []
    node_ports = {"0": []}
    for cid, kind, nodes, p in [("pic", "PIC", ["load", "0"], {}), ("g", "GND", ["0"], {}), *parts]:
        components.append({"id": cid, "kind": kind, "ports": PORTS[kind], "parameters": p})
        for port, node in zip(PORTS[kind], nodes):
            node_ports.setdefault(node, []).append({"component_id": cid, "port": port})
    wires = []
    labels = []
    for node, endpoints in node_ports.items():
        for e in endpoints[1:]:
            wires.append({"id": f"w{len(wires)}", "source": endpoints[0], "target": e})
        if node != "0":
            labels.append({**endpoints[0], "name": node})
    return ExternalCircuitSettings(enabled=enabled, area_m2=area,
        document={"components": components, "wires": wires, "node_labels": labels})


def step_source(value=1):
    return {"dc_v": 0, "waveform": {"kind": "pwl", "points": [[0, 0], [1e-15, value]]}}


def value(solver, key):
    return solver.frame()["latest"][key]


def test_rc_backward_euler_and_area_conversion():
    r, c, cp, area = 2000., 3e-9, 2e-10, .02
    s = settings([("v", "V", ["src", "0"], step_source(10)),
                  ("r", "R", ["src", "load"], {"value": r}),
                  ("c", "C", ["load", "0"], {"value": c})], area=area)
    solver = ExternalCircuit(s, [[cp, -cp], [-cp, cp]])
    assert solver.solve([0, 0], 0, 0) == pytest.approx([0, 0])
    total_c = c + cp * area
    dt = r * total_c / 50
    for k in range(1, 151):
        v = solver.solve([0, 0], k * dt, dt)
        expected = 10 * (1 - (1 + dt / (r * total_c)) ** -k)
        assert v[0] == pytest.approx(expected, rel=2e-12, abs=1e-12)
        # KCL with displacement and particle conduction uses a consistent sign.
        assert value(solver, "branch/r/current_a") == pytest.approx(
            value(solver, "branch/c/current_a") + value(solver, "pic/left/total_current_a"), abs=1e-13)
    assert value(solver, "circuit/stored_energy_j") == pytest.approx(.5 * total_c * v[0] ** 2)


def test_induced_and_particle_charge_enter_integrated_kcl():
    c, r, area, dt = 1e-9, 1e6, .1, 1e-7
    solver = ExternalCircuit(settings([("r", "R", ["load", "0"], {"value": r})], area=area), [[c, -c], [-c, c]])
    solver.solve([0, 0], 0, 0)
    qcond = 3e-10
    qind = -2e-10
    v = solver.solve([qind, -qind], dt, dt, [qcond, 0])
    assert v[0] == pytest.approx(area * (qcond - qind) / (area * c + dt / r))
    assert value(solver, "pic/left/conduction_current_a") == pytest.approx(area * qcond / dt)
    assert value(solver, "branch/r/current_a") + value(solver, "pic/left/total_current_a") == pytest.approx(0, abs=1e-13)


def test_floating_blocking_capacitor_start_and_charge_identity():
    cp, cb = 2e-10, 1e-8
    solver = ExternalCircuit(settings([("v", "V", ["src", "0"], {"dc_v": 20}),
                                       ("cb", "C", ["src", "load"], {"value": cb})]), [[cp, -cp], [-cp, cp]])
    assert solver.solve([0, 0], 0, 0)[0] == pytest.approx(20 * cb / (cb + cp))
    oldq = value(solver, "pic/left/electrode_charge_c") - value(solver, "branch/cb/charge_c")
    solver.solve([-1e-10, 1e-10], 1e-9, 1e-9, [2e-11, 0])
    newq = value(solver, "pic/left/electrode_charge_c") - value(solver, "branch/cb/charge_c")
    assert newq - oldq == pytest.approx(2e-11, abs=1e-23)


def test_rlc_transient_matches_independent_ode():
    r, l, c = 10., 2e-6, 3e-9
    solver = ExternalCircuit(settings([("v", "V", ["src", "0"], step_source()),
        ("r", "R", ["src", "middle"], {"value": r}),
        ("l", "L", ["middle", "load"], {"value": l}),
        ("c", "C", ["load", "0"], {"value": c})]), np.zeros((2, 2)))
    solver.solve([0, 0], 0, 0)
    tau = math.sqrt(l * c)
    dt = tau / 200
    n = 1200
    times = np.arange(1, n + 1) * dt
    actual = [solver.solve([0, 0], t, dt)[0] for t in times]
    reference = solve_ivp(lambda t, y: [(1 - r * y[0] - y[1]) / l, y[0] / c],
        (0, times[-1]), [0, 0], t_eval=times, rtol=1e-11, atol=1e-13).y[1]
    assert np.max(np.abs(np.array(actual) - reference)) < .015


def test_explicit_capacitor_inductor_initial_conditions_and_conflicts():
    s = settings([("v", "V", ["src", "0"], {"dc_v": 10}),
                  ("r", "R", ["src", "middle"], {"value": 5}),
                  ("l", "L", ["middle", "load"], {"value": 1e-6, "initial_current_a": .2}),
                  ("c", "C", ["load", "0"], {"value": 1e-9, "initial_voltage_v": 1})])
    solver = ExternalCircuit(s, [[2e-10, -2e-10], [-2e-10, 2e-10]])
    assert solver.solve([0, 0], 0, 0)[0] == pytest.approx(1)
    assert value(solver, "branch/l/current_a") == pytest.approx(.2)
    assert value(solver, "branch/r/current_a") == pytest.approx(.2)
    solver.solve([0, 0], 1e-10, 1e-10)
    assert value(solver, "branch/c/voltage_v") > 1
    # Equal capacitor constraints are compatible and have no artificial
    # startup current; a conflicting constraint is a user-visible error.
    parallel = settings([("r", "R", ["load", "0"], {"value": 5}),
        ("c1", "C", ["load", "0"], {"value": 1e-9, "initial_voltage_v": 2}),
        ("c2", "C", ["load", "0"], {"value": 2e-9, "initial_voltage_v": 2})])
    assert ExternalCircuit(parallel, np.zeros((2, 2))).solve([0, 0], 0, 0)[0] == pytest.approx(2)
    conflicting = settings([("v", "V", ["load", "0"], {"dc_v": 5}),
        ("c", "C", ["load", "0"], {"value": 1e-9, "initial_voltage_v": 0})])
    with pytest.raises(ValueError, match="初期電圧.*矛盾"):
        ExternalCircuit(conflicting, np.zeros((2, 2))).solve([0, 0], 0, 0)


def test_diode_dc_resistance_breakdown_and_temperature():
    solver = ExternalCircuit(settings([("v", "V", ["src", "0"], {"dc_v": 5}),
        ("r", "R", ["src", "load"], {"value": 1000}),
        ("d", "D", ["load", "0"], {"model_parameters": {"CJO": 0, "RS": 2}})]), np.zeros((2, 2)))
    v = solver.solve([0, 0], 0, 0)[0]
    i = value(solver, "branch/d/current_a")
    junction_v = value(solver, "branch/d/junction_voltage_v")
    assert .6 < v < .8
    assert (5 - v) / 1000 == pytest.approx(i, rel=1e-7)
    assert v - junction_v == pytest.approx(i * 2, rel=1e-7)
    d = DiodeModel.parse({"model_parameters": {"BV": 30, "IBV": .001}}).at_temperature(300.15)
    assert d.conduction(-30)[0] == pytest.approx(-.001, abs=1e-12)
    hot = DiodeModel.parse({}).at_temperature(350)
    cold = DiodeModel.parse({}).at_temperature(300)
    assert hot.conduction(.5)[0] > cold.conduction(.5)[0]


def test_diode_newton_pulse_limiting_and_small_saturation_current():
    for saturation in (1e-14, 1e-20):
        solver = ExternalCircuit(settings([("v", "V", ["src", "0"], step_source(100)),
            ("r", "R", ["src", "load"], {"value": 10}),
            ("d", "D", ["load", "0"], {"model_parameters": {"IS": saturation, "RS": .1,
                                             "CJO": 2e-12, "TT": 1e-9}})]), np.zeros((2, 2)))
        solver.solve([0, 0], 0, 0)
        solver.solve([0, 0], 1e-9, 1e-9)
        assert value(solver, "branch/r/current_a") == pytest.approx(value(solver, "branch/d/current_a"), rel=1e-6)
        assert value(solver, "branch/d/current_a") > 1


@pytest.mark.parametrize("m", [0, .5, 1, 2])
def test_diode_charge_derivative_continuous_and_energy_nonnegative(m):
    d = DiodeModel.parse({"model_parameters": {"CJO": 2e-10, "M": m, "TT": 2e-9}}).at_temperature(300.15)
    for v in [-100, -.5, 0, .49999, .5, .50001, .65]:
        q, cap, energy = d.charge(v)
        h = 1e-6
        derivative = (d.charge(v + h)[0] - d.charge(v - h)[0]) / (2 * h)
        assert derivative == pytest.approx(cap, rel=2e-5, abs=1e-16)
        assert energy >= 0
    assert d.charge(.5 - 1e-9)[1] == pytest.approx(d.charge(.5 + 1e-9)[1], rel=1e-7)


def test_switch_schedule_and_source_waveforms():
    s = settings([("v", "V", ["src", "0"], {"dc_v": 10}),
                  ("sw", "S", ["src", "load"], {"on_time_s": 1e-6, "off_time_s": 3e-6,
                      "on_resistance_ohm": 1, "off_resistance_ohm": 1e9}),
                  ("r", "R", ["load", "0"], {"value": 100})])
    solver = ExternalCircuit(s, np.zeros((2, 2)))
    assert solver.solve([0, 0], 0, 0)[0] < 1e-5
    assert solver.solve([0, 0], 1e-6, 1e-6)[0] == pytest.approx(10 * 100 / 101)
    solver.solve([0, 0], 2e-6, 1e-6)
    assert solver.solve([0, 0], 3e-6, 1e-6)[0] < 1e-5
    vcomponent = settings([("v", "V", ["load", "0"], {"waveform": {"kind": "sin", "offset_v": 3,
                         "amplitude_v": 2, "frequency_hz": 1e6, "phase_deg": 90}})]).document.components[-1]
    assert source_voltage(vcomponent.parameters, 0) == pytest.approx(5)
    assert source_voltage(vcomponent.parameters, .5e-6) == pytest.approx(1)
    assert circuit_frequency(ExternalCircuitSettings(enabled=False)) is None
    pulse = settings([("v", "V", ["load", "0"], {"waveform": {"kind": "pulse", "rise_s": 1,
        "width_s": 2, "fall_s": 1, "period_s": 5, "initial_v": 0, "pulsed_v": 10}})]).document.components[-1]
    assert [source_voltage(pulse.parameters, t) for t in [0, .5, 2, 3.5, 4.5, 5.5]] == pytest.approx([0, 5, 10, 5, 0, 5])


def coax_settings(segments=8, grounded=True, loss=True):
    p = {"segments": segments}
    if not loss:
        p.update(inner_resistivity_ohm_m=0, shield_resistivity_ohm_m=0, loss_tangent=0)
    kind = "COAX_GND" if grounded else "COAX"
    terminals = ["input", "load"] if grounded else ["input", "0", "load", "0"]
    return settings([("v", "V", ["src", "0"], step_source()),
        ("r", "R", ["src", "input"], {"value": 50}),
        ("cx", kind, terminals, p), ("loadr", "R", ["load", "0"], {"value": 50})])


def test_coax_geometry_passive_reference_loss_fit_and_dc():
    cable = CoaxModel.parse({})
    m = cable.metadata()
    assert m["nominal_impedance_ohm"] == pytest.approx(50.021, rel=1e-4)
    assert m["tem_delay_s"] == pytest.approx(4.834e-9, rel=1e-3)
    omega = 2 * math.pi * cable.parameters["reference_frequency_hz"]
    rl = 1 / (1 / cable.skin_resistance_ohm_m + 1 / (1j * omega * cable.skin_inductance_h_m))
    assert cable.dc_resistance_ohm_m + rl.real == pytest.approx(cable.rf_resistance_ohm_m)
    assert rl.imag == pytest.approx(cable.internal_reactance_ohm_m)
    rc = 1 / (cable.relaxation_resistance_ohm_m + 1 / (1j * omega * cable.relaxation_capacitance_f_m))
    y = 1j * omega * cable.dielectric_capacitance_f_m + rc
    assert y == pytest.approx(omega * cable.capacitance_f_m * complex(cable.parameters["loss_tangent"], 1))
    s = coax_settings(2)
    s.document.components[2].parameters = {"dc_v": 1, "waveform": {"kind": "dc"}}
    solver = ExternalCircuit(s, np.zeros((2, 2)))
    v = solver.solve([0, 0], 0, 0)[0]
    assert v == pytest.approx(50 / (100 + cable.dc_resistance_ohm_m), rel=1e-9)
    assert value(solver, "branch/cx/input_current_a") == pytest.approx(-value(solver, "branch/cx/output_current_a"))
    assert value(solver, "branch/cx/power_w") > 0


def test_coax_propagation_delay_and_grounded_four_terminal_equivalence():
    grounded = ExternalCircuit(coax_settings(16, loss=False), np.zeros((2, 2)))
    four = ExternalCircuit(coax_settings(16, grounded=False, loss=False), np.zeros((2, 2)))
    grounded.solve([0, 0], 0, 0); four.solve([0, 0], 0, 0)
    delay = grounded.coax["cx"]["tem_delay_s"]
    dt = delay / 100
    trace = []
    for k in range(1, 221):
        a, b = grounded.solve([0, 0], k * dt, dt), four.solve([0, 0], k * dt, dt)
        assert a == pytest.approx(b, abs=1e-13)
        trace.append(a[0])
    assert trace[29] < .01
    crossing = np.argmax(np.asarray(trace) > .25) * dt
    assert crossing == pytest.approx(delay, rel=.2)
    assert trace[-1] == pytest.approx(.5, abs=.015)


def test_snapshot_restore_repeat_and_bounded_complete_results():
    solver = ExternalCircuit(settings([("v", "V", ["load", "0"], {"dc_v": 3})]), [[1e-9, -1e-9], [-1e-9, 1e-9]])
    solver.solve([0, 0], 0, 0)
    for k in range(1, 2010):
        saved = solver.snapshot() if k == 20 else None
        solver.solve([0, 0], k * 1e-9, 1e-9, [1e-13, -1e-13])
        if saved:
            expected = solver.frame()
            solver.restore(saved)
            solver.solve([0, 0], k * 1e-9, 1e-9, [1e-13, -1e-13])
            assert solver.frame() == expected
    result = solver.result()
    assert len(result["history"]["t"]) <= 2001
    assert result["history"]["t"][-1] == pytest.approx(2009e-9)
    assert len(solver.frame()["history"]["t"]) == 1
    assert all(len(v) == len(result["history"]["t"]) for v in result["history"].values())
    assert set(result["latest"]) == {row["key"] for row in result["catalog"]}
    assert result["parameters"]
    solver.reset_history()
    assert solver.result()["latest"] == result["latest"]


@pytest.mark.parametrize("change", ["missing_ground", "duplicate_component", "duplicate_wire", "unknown_endpoint", "short_pic", "floating"])
def test_invalid_topologies_are_rejected(change):
    d = settings([("r", "R", ["load", "0"], {})]).model_dump()
    doc = d["document"]
    if change == "missing_ground":
        doc["components"] = [c for c in doc["components"] if c["kind"] != "GND"]
        doc["wires"] = [w for w in doc["wires"] if w["source"]["component_id"] != "g" and w["target"]["component_id"] != "g"]
    elif change == "duplicate_component":
        doc["components"].append(doc["components"][-1])
    elif change == "duplicate_wire":
        doc["wires"].append(doc["wires"][0])
    elif change == "unknown_endpoint":
        doc["wires"][0]["target"]["port"] = "missing"
    elif change == "short_pic":
        doc["wires"].append({"id": "short", "source": {"component_id": "pic", "port": "left"}, "target": {"component_id": "pic", "port": "right"}})
    else:
        doc["components"].append({"id": "floating", "kind": "R", "parameters": {"value": 1}})
    with pytest.raises(ValidationError):
        ExternalCircuitSettings.model_validate(d)


def test_ideal_source_conflict_and_numeric_model_ranges():
    solver = ExternalCircuit(settings([("v1", "V", ["load", "0"], {"dc_v": 1}),
        ("v2", "V", ["load", "0"], {"dc_v": 2})]), np.zeros((2, 2)))
    with pytest.raises(ValueError, match="理想電圧源"):
        solver.solve([0, 0], 0, 0)
    for p in [{"segments": 2.5}, {"inner_diameter_m": 1e-250}, {"loss_tangent": 1}]:
        with pytest.raises(ValueError):
            CoaxModel.parse(p)
    assert ExternalCircuitSettings(enabled=False).document.components == []
