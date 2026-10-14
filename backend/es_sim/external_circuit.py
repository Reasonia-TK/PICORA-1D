"""Incremental, charge-conserving external circuit / electrostatic PIC coupling.

For each electrode Qe = A*(Cpic V + Qind). KCL is integrated over the
preceding PIC interval: external outgoing charge + ΔQe = Qconduction.
The caller supplies absorbed/emitted particle charge, positive into electrode.
RLC and diode junction charge use backward Euler. No plasma equivalent circuit
is inserted: the electrode capacitance and actual PIC-induced charge are used.
"""
from __future__ import annotations

import math
import warnings
from dataclasses import dataclass

import numpy as np
from scipy.linalg import LinAlgWarning, lu_factor, lu_solve
from scipy.sparse import csc_matrix
from scipy.sparse.linalg import splu

from .external_circuit_schema import ExternalCircuitSettings, compile_topology, circuit_frequency
from .external_coax import CoaxModel, MU0
from .external_diode import DiodeModel, MODEL_UNITS


def source_voltage(parameters: dict, t: float) -> float:
    w = parameters["waveform"]
    kind = w["kind"]
    if kind == "dc":
        return parameters["dc_v"]
    if kind == "sin":
        elapsed = max(0., t - w["delay_s"])
        return w["offset_v"] + w["amplitude_v"] * math.sin(2 * math.pi * w["frequency_hz"] * elapsed + math.radians(w["phase_deg"]))
    if kind == "pwl":
        points = np.asarray(w["points"])
        return float(np.interp(t, points[:, 0], points[:, 1]))
    if t < w["delay_s"]:
        return w["initial_v"]
    phase = (t - w["delay_s"]) % w["period_s"]
    rise, width, fall = w["rise_s"], w["width_s"], w["fall_s"]
    if phase < rise:
        fraction = phase / rise
    elif phase < rise + width:
        fraction = 1.
    elif phase < rise + width + fall:
        fraction = 1 - (phase - rise - width) / fall
    else:
        fraction = 0.
    return w["initial_v"] + fraction * (w["pulsed_v"] - w["initial_v"])


def switch_on(parameters: dict, t: float) -> bool:
    if t < parameters["on_time_s"]:
        return parameters["initial_state"]
    if parameters.get("off_time_s") is not None and t >= parameters["off_time_s"]:
        return False
    period = parameters.get("period_s")
    return (t - parameters["on_time_s"]) % period < parameters["duty"] * period if period else True


@dataclass
class Branch:
    id: str
    kind: str
    p: str
    n: str
    value: float = 0.
    parameters: dict | None = None
    owner: str | None = None
    initial: float | None = None
    index: int | None = None
    diode: object | None = None


class ExternalCircuit:
    """Stateful MNA solver. ``solve(t=0,dt=0)`` initializes without advancing time."""
    def __init__(self, settings: ExternalCircuitSettings | dict, capacitance_f_m2):
        self.settings = settings if isinstance(settings, ExternalCircuitSettings) else ExternalCircuitSettings.model_validate(settings)
        if not self.settings.enabled:
            raise ValueError("外部回路が有効になっていません")
        self.topology = compile_topology(self.settings.document)
        self.area = self.settings.area_m2
        self.capacitance_f_m2 = np.asarray(capacitance_f_m2, dtype=float).reshape(2, 2)
        if not np.isfinite(self.capacitance_f_m2).all() or not np.allclose(self.capacitance_f_m2, self.capacitance_f_m2.T, rtol=1e-10, atol=1e-25):
            raise ValueError("PICの電極容量行列が不正です")
        if np.linalg.eigvalsh(self.capacitance_f_m2).min() < -1e-10 * max(1e-30, np.abs(self.capacitance_f_m2).max()):
            raise ValueError("PICの電極容量行列は半正定値である必要があります")
        self.pic_c = self.area * self.capacitance_f_m2
        self.pic_nodes = [self.topology["nets"][("pic", p)] for p in ("left", "right")]
        self.branches: list[Branch] = []
        self.coax = {}
        self.diodes = {}
        self.coax_senses = {}
        self._expand_components()
        self.warnings = [f"{cid}: {message}" for cid, model in self.coax.items() for message in model["warnings"]]
        all_nodes = list(self.topology["node_names"])
        for b in self.branches:
            for name in (b.p, b.n):
                if name not in all_nodes:
                    all_nodes.append(name)
        self.node_index = {n: i for i, n in enumerate(n for n in all_nodes if n != "0")}
        self.n_nodes = len(self.node_index)
        self.n_unknown = self.n_nodes
        for b in self.branches:
            if b.kind in ("V", "L", "C"):
                b.index = self.n_unknown
                self.n_unknown += 1
        self._dc_reachable = self._dc_nodes()
        self._x = np.zeros(self.n_unknown)
        self._capacitor_v = {b.id: b.initial or 0. for b in self.branches if b.kind == "C"}
        self._inductor_i = {b.id: b.initial or 0. for b in self.branches if b.kind == "L"}
        self._diode_q = {b.id: 0. for b in self.branches if b.kind == "D"}
        self._q_pic = None
        self._last_t = None
        self._latest = {}
        self._records: list[tuple[float, dict]] = []
        self._sample_count, self._sample_stride = 0, 1
        self._linear_cache = None
        self._last_iterations = 0
        self._initialization = "未指定の初期値はDC動作点。明示C電圧/L電流はt0の拘束条件。容量のみで接地される節点は初期電荷0の制約。"
        self._catalog = self._make_catalog()
        self._parameters = self._make_parameters()

    def _expand_components(self):
        nets = self.topology["nets"]
        def add(id, kind, p, n, value=0., parameters=None, owner=None, initial=None, diode=None):
            self.branches.append(Branch(id, kind, p, n, value, parameters, owner, initial, diode=diode))
        for c in self.settings.document.components:
            cid, k, p = c.id, c.kind, c.parameters
            if k in ("GND", "PIC"):
                continue
            if k not in ("COAX", "COAX_GND"):
                a, b = nets[(cid, "p")], nets[(cid, "n")]
                if k == "D":
                    model = DiodeModel.parse(p).at_temperature(self.settings.temperature_k)
                    self.diodes[cid] = model.metadata()
                    if model.series_ohm:
                        junction = f"@{cid}/junction"
                        add(f"@{cid}/series", "R", a, junction, model.series_ohm, owner=cid)
                    else:
                        junction = a
                    add(cid, k, junction, b, owner=cid, diode=model)
                else:
                    initial = p.get("initial_voltage_v") if k == "C" else p.get("initial_current_a")
                    add(cid, k, a, b, p.get("value", 0.), parameters=p, owner=cid, initial=initial)
                continue
            cable = CoaxModel.parse(p)
            self.coax[cid] = {**cable.metadata(), "component_kind": k,
                "shield_reference_node": "0" if k == "COAX_GND" else nets[(cid, "n1")]}
            n, length = p["segments"], p["length_m"]
            dx = length / n
            shield = self.coax[cid]["shield_reference_node"]
            nodes = [f"@{cid}/p{i}" for i in range(n + 1)]
            sense_in, sense_out = f"@{cid}/input", f"@{cid}/output"
            add(sense_in, "V", nets[(cid, "p1")], nodes[0], parameters={"dc_v": 0., "waveform": {"kind": "dc"}}, owner=cid)
            add(sense_out, "V", nets[(cid, "p2")], nodes[-1], parameters={"dc_v": 0., "waveform": {"kind": "dc"}}, owner=cid)
            self.coax_senses[cid] = (sense_in, sense_out, shield)
            for i in range(n):
                previous = nodes[i]
                if cable.dc_resistance_ohm_m:
                    next_node = f"@{cid}/r{i}"
                    add(f"@{cid}/dc{i}", "R", previous, next_node, cable.dc_resistance_ohm_m * dx, owner=cid)
                    previous = next_node
                if cable.skin_inductance_h_m:
                    next_node = f"@{cid}/skin{i}"
                    add(f"@{cid}/skinL{i}", "L", previous, next_node, cable.skin_inductance_h_m * dx, owner=cid)
                    if cable.skin_resistance_ohm_m:
                        add(f"@{cid}/skinR{i}", "R", previous, next_node, cable.skin_resistance_ohm_m * dx, owner=cid)
                    previous = next_node
                add(f"@{cid}/L{i}", "L", previous, nodes[i + 1], cable.inductance_h_m * dx, owner=cid)
            for i, node in enumerate(nodes):
                distance = dx * (.5 if i in (0, n) else 1.)
                add(f"@{cid}/C{i}", "C", node, shield, cable.dielectric_capacitance_f_m * distance, owner=cid)
                if cable.relaxation_capacitance_f_m:
                    loss_node = f"@{cid}/dielectric{i}"
                    add(f"@{cid}/lossR{i}", "R", node, loss_node, cable.relaxation_resistance_ohm_m / distance, owner=cid)
                    add(f"@{cid}/lossC{i}", "C", loss_node, shield, cable.relaxation_capacitance_f_m * distance, owner=cid)

    def _dc_nodes(self):
        graph = {"0": set()}
        for n in self.node_index:
            graph[n] = set()
        for b in self.branches:
            if (b.kind != "C" or b.initial is not None) and not (b.kind == "L" and b.initial is not None):
                graph[b.p].add(b.n)
                graph[b.n].add(b.p)
        seen, todo = {"0"}, ["0"]
        while todo:
            for n in graph[todo.pop()]:
                if n not in seen:
                    seen.add(n)
                    todo.append(n)
        return seen

    def _v(self, node, x=None):
        return 0. if node == "0" else float((self._x if x is None else x)[self.node_index[node]])

    def _difference(self, branch, x=None):
        return self._v(branch.p, x) - self._v(branch.n, x)

    def _initial_cap_constraints(self, t):
        """Prune equal initial capacitor constraints; reject conflicting ones.

        Parallel capacitors share an initial voltage, so adding one ideal
        voltage branch per capacitor would make the initial MNA singular.
        """
        graph = {n: [] for n in ("0", *self.node_index)}
        def known_voltage(a, b):
            todo, seen = [(a, 0.)], {a}
            while todo:
                node, voltage = todo.pop()
                if node == b:
                    return voltage
                for neighbor, drop in graph[node]:
                    if neighbor not in seen:
                        seen.add(neighbor)
                        todo.append((neighbor, voltage + drop))
            return None
        def connect(a, b, voltage):
            graph[a].append((b, voltage))
            graph[b].append((a, -voltage))
        for branch in self.branches:
            if branch.kind == "V":
                voltage = source_voltage(branch.parameters, t)
                known = known_voltage(branch.p, branch.n)
                if known is not None and not math.isclose(known, voltage, rel_tol=1e-9, abs_tol=1e-9):
                    raise ValueError("理想電圧源の電圧条件が矛盾しています")
                connect(branch.p, branch.n, voltage)
        redundant = set()
        for branch in self.branches:
            if branch.kind != "C" or branch.initial is None:
                continue
            known = known_voltage(branch.p, branch.n)
            if known is not None:
                if not math.isclose(known, branch.initial, rel_tol=1e-9, abs_tol=1e-9):
                    raise ValueError(f"キャパシタ {branch.id} の初期電圧が理想電圧源または他の初期電圧と矛盾しています")
                redundant.add(branch.id)
            else:
                connect(branch.p, branch.n, branch.initial)
        return redundant

    def _assemble(self, dt, t, initial, q_induced, q_conduction):
        entries = {}
        rhs = np.zeros(self.n_unknown)
        def put(i, j, value):
            if i is not None and j is not None and value:
                entries[(i, j)] = entries.get((i, j), 0.) + value
        def stamp(a, b, g, current=0., charge=False):
            ia, ib = self.node_index.get(a), self.node_index.get(b)
            for row, own, other, sign in ((ia, ia, ib, 1.), (ib, ib, ia, -1.)):
                if row is None:
                    continue
                if initial and (charge == (list(self.node_index)[row] in self._dc_reachable)):
                    continue
                put(row, own, g)
                put(row, other, -g)
                rhs[row] -= sign * current
        for b in self.branches:
            if b.kind == "R":
                stamp(b.p, b.n, 1 / b.value)
            elif b.kind == "S":
                resistance = b.parameters["on_resistance_ohm"] if switch_on(b.parameters, t) else b.parameters["off_resistance_ohm"]
                stamp(b.p, b.n, 1 / resistance)
            elif b.kind in ("V", "L", "C"):
                ia, ib, j = self.node_index.get(b.p), self.node_index.get(b.n), b.index
                if not (initial and b.kind == "L" and b.initial is not None and b.p not in self._dc_reachable):
                    put(ia, j, 1.)
                if not (initial and b.kind == "L" and b.initial is not None and b.n not in self._dc_reachable):
                    put(ib, j, -1.)
                if b.kind == "C" and initial and (b.initial is None or b.id in self._redundant_initial_caps):
                    put(j, j, 1.)
                    if b.initial is None:
                        stamp(b.p, b.n, b.value, charge=True)
                    continue
                if b.kind == "L" and initial and b.initial is not None:
                    put(j, j, 1.)
                    rhs[j] = b.initial
                    continue
                put(j, ia, 1.)
                put(j, ib, -1.)
                if b.kind == "C":
                    if initial:
                        rhs[j] = b.initial
                    else:
                        put(j, j, -dt / b.value)
                        rhs[j] = self._capacitor_v[b.id]
                elif b.kind == "V":
                    rhs[j] = source_voltage(b.parameters, t)
                elif not initial:
                    put(j, j, -b.value / dt)
                    rhs[j] = -b.value * self._inductor_i[b.id] / dt
        # PIC capacitance is an actual two-port Maxwell matrix, not two
        # independent capacitances to ground.
        for i, a in enumerate(self.pic_nodes):
            row = self.node_index.get(a)
            if row is None or (initial and a in self._dc_reachable):
                continue
            for j, b in enumerate(self.pic_nodes):
                put(row, self.node_index.get(b), self.pic_c[i, j] if initial else self.pic_c[i, j] / dt)
            if not initial:
                rhs[row] += (self._q_pic[i] - q_induced[i] + q_conduction[i]) / dt
        if entries:
            keys = list(entries)
            rows, columns = zip(*keys)
            matrix = csc_matrix(([entries[k] for k in keys], (rows, columns)), shape=(self.n_unknown, self.n_unknown))
        else:
            matrix = csc_matrix((self.n_unknown, self.n_unknown))
        return matrix, rhs, stamp

    def _factor(self, matrix):
        try:
            # Row equilibration avoids mixed current/voltage/charge scales at
            # startup and supports both very small PIC capacitance and L/dt.
            scale = np.asarray(abs(matrix).max(axis=1).toarray()).ravel()
            if np.any(scale == 0) or not np.isfinite(scale).all():
                raise ValueError()
            reciprocal = 1 / scale
            equilibrated = matrix.multiply(reciprocal[:, None]).tocsc()
            if self.n_unknown < 64:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", LinAlgWarning)
                    factor = lu_factor(equilibrated.toarray(), check_finite=False)
                return lambda rhs: lu_solve(factor, rhs * reciprocal, check_finite=False)
            factor = splu(equilibrated)
            return lambda rhs: factor.solve(rhs * reciprocal)
        except (ValueError, RuntimeError, LinAlgWarning) as exc:
            raise ValueError("外部回路を解けません。浮遊節点、理想電圧源の重複・矛盾、初期電荷条件を確認してください") from exc

    def solve(self, q_induced_c_m2, t: float, dt: float, conduction_charge_c_m2=(0., 0.)) -> np.ndarray:
        try:
            return self._solve(q_induced_c_m2, t, dt, conduction_charge_c_m2)
        except (ZeroDivisionError, OverflowError, FloatingPointError) as exc:
            raise ValueError("外部回路の物理量が計算可能範囲を超えています。素子の数値・温度・dtを確認してください") from exc

    def _solve(self, q_induced_c_m2, t: float, dt: float, conduction_charge_c_m2=(0., 0.)) -> np.ndarray:
        q_induced = self.area * np.asarray(q_induced_c_m2, dtype=float).reshape(2)
        q_conduction = self.area * np.asarray(conduction_charge_c_m2, dtype=float).reshape(2)
        if not np.isfinite(q_induced).all() or not np.isfinite(q_conduction).all() or not math.isfinite(t) or not math.isfinite(dt):
            raise ValueError("外部回路に渡された時刻または電荷が非有限です")
        initial = self._last_t is None
        if initial:
            if dt != 0:
                raise ValueError("外部回路の最初のsolveはdt=0で初期化してください")
            self._redundant_initial_caps = self._initial_cap_constraints(t)
        elif dt <= 0 or not math.isclose(t - self._last_t, dt, rel_tol=1e-7, abs_tol=1e-24):
            raise ValueError("外部回路の時刻増分はPICのdtと一致させてください")
        states = tuple(switch_on(b.parameters, t) for b in self.branches if b.kind == "S")
        key = (dt, initial, states)
        if self._linear_cache is None or self._linear_cache[0] != key:
            base, _, _ = self._assemble(dt, t, initial, q_induced, q_conduction)
            factor = self._factor(base) if not self.diodes else None
            self._linear_cache = (key, base, factor)
        matrix, rhs, _ = self._assemble(dt, t, initial, q_induced, q_conduction)
        x = self._x.copy()
        if not self.diodes:
            x = self._linear_cache[2](rhs)
            iterations = 1
        else:
            diode_branches = [b for b in self.branches if b.kind == "D"]
            iteration_voltages = {b.id: self._difference(b, x) for b in diode_branches}
            converged = False
            for iterations in range(1, self.settings.max_iterations + 1):
                rows, columns, values = [], [], []
                target = rhs.copy()
                for b in diode_branches:
                    v = b.diode.limit_iteration_voltage(self._difference(b, x), iteration_voltages[b.id])
                    iteration_voltages[b.id] = v
                    current, conductance = b.diode.conduction(v)
                    if not initial:
                        charge, capacitance, _ = b.diode.charge(v)
                        current += (charge - self._diode_q[b.id]) / dt
                        conductance += capacitance / dt
                    equivalent = current - conductance * v
                    ia, ib = self.node_index.get(b.p), self.node_index.get(b.n)
                    for i, j, sign in ((ia, ia, 1), (ib, ib, 1), (ia, ib, -1), (ib, ia, -1)):
                        if i is not None and j is not None:
                            rows.append(i); columns.append(j); values.append(sign * conductance)
                    if ia is not None:
                        target[ia] -= equivalent
                    if ib is not None:
                        target[ib] += equivalent
                jacobian = matrix + csc_matrix((values, (rows, columns)), shape=matrix.shape)
                updated = self._factor(jacobian)(target)
                if not np.isfinite(updated).all():
                    raise ValueError("外部回路の解が非有限です。回路条件を確認してください")
                junctions_match = all(math.isclose(self._difference(b, updated), iteration_voltages[b.id],
                                                   rel_tol=1e-7, abs_tol=1e-9) for b in diode_branches)
                if junctions_match and np.all(np.abs(updated - x) <= 1e-9 + 1e-7 * np.maximum(np.abs(x), np.abs(updated))):
                    x = updated
                    converged = True
                    break
                x = updated
            if not converged:
                raise ValueError(f"外部回路のダイオード反復が{self.settings.max_iterations}回で収束しません。dt・RS・回路条件を見直してください")
            for b in diode_branches:
                b.diode.assert_exponential_range(self._difference(b, x))
        if not np.isfinite(x).all():
            raise ValueError("外部回路の解が非有限です")
        previous_q = None if self._q_pic is None else self._q_pic.copy()
        previous_cap = dict(self._capacitor_v)
        previous_diode = dict(self._diode_q)
        self._x = x
        electrode_v = np.array([self._v(n) for n in self.pic_nodes])
        self._q_pic = self.pic_c @ electrode_v + q_induced
        self._last_t = float(t)
        self._last_iterations = iterations
        self._latest = self._quantities(dt, initial, previous_q, q_conduction, previous_cap, previous_diode)
        for b in self.branches:
            if b.kind == "C":
                self._capacitor_v[b.id] = self._difference(b)
            elif b.kind == "L":
                self._inductor_i[b.id] = float(x[b.index])
            elif b.kind == "D":
                self._diode_q[b.id] = b.diode.charge(self._difference(b))[0]
        self._record(t)
        return electrode_v.copy()

    def _quantities(self, dt, initial, previous_q, q_conduction, previous_cap, previous_diode):
        values = {f"node/{n}/voltage_v": self._v(n) for n in self.node_index}
        values["node/0/voltage_v"] = 0.
        currents, energies = {}, {}
        total_dissipation = 0.
        for b in self.branches:
            v = self._difference(b)
            energy = 0.
            if b.kind == "R":
                current = v / b.value
                total_dissipation += v * current
            elif b.kind == "S":
                on = switch_on(b.parameters, self._last_t)
                resistance = b.parameters["on_resistance_ohm"] if on else b.parameters["off_resistance_ohm"]
                current = v / resistance
                total_dissipation += v * current
                values[f"branch/{b.id}/state"] = int(on)
                values[f"branch/{b.id}/resistance_ohm"] = resistance
            elif b.kind == "C":
                current = 0. if initial else float(self._x[b.index])
                energy = .5 * b.value * v * v
                values[f"branch/{b.id}/charge_c"] = b.value * v
            elif b.kind in ("V", "L"):
                current = float(self._x[b.index])
                if b.kind == "L":
                    energy = .5 * b.value * current * current
            else:
                conduction, _ = b.diode.conduction(v)
                charge, capacitance, energy = b.diode.charge(v)
                capacitive = 0. if initial else (charge - previous_diode[b.id]) / dt
                current = conduction + capacitive
                total_dissipation += v * conduction
                for suffix, quantity in (("junction_voltage_v", v), ("conduction_current_a", conduction),
                                         ("capacitive_current_a", capacitive), ("charge_c", charge), ("capacitance_f", capacitance)):
                    values[f"branch/{b.id}/{suffix}"] = quantity
            currents[b.id], energies[b.id] = current, energy
            # Show every internal circuit quantity as well; it is needed to
            # inspect TEM ladder discretization and charge conservation.
            for suffix, quantity in (("voltage_v", v), ("current_a", current), ("power_w", v * current), ("energy_j", energy)):
                values[f"branch/{b.id}/{suffix}"] = quantity
        for c in self.settings.document.components:
            if c.kind == "D" and c.parameters["model_parameters"]["RS"]:
                v = self._v(self.topology["nets"][(c.id, "p")]) - self._v(self.topology["nets"][(c.id, "n")])
                values[f"branch/{c.id}/voltage_v"] = v
                values[f"branch/{c.id}/power_w"] = v * currents[c.id]
        for cid, (input_id, output_id, shield) in self.coax_senses.items():
            c = self.topology["components"][cid]
            total_power = 0.
            for port, sense, terminal in (("input", input_id, "p1"), ("output", output_id, "p2")):
                v = self._v(self.topology["nets"][(cid, terminal)]) - self._v(shield)
                current = currents[sense]
                total_power += v * current
                for suffix, quantity in (("voltage_v", v), ("current_a", current), ("power_w", v * current)):
                    values[f"branch/{cid}/{port}_{suffix}"] = quantity
            values[f"branch/{cid}/power_w"] = total_power
            values[f"branch/{cid}/energy_j"] = sum(energy for id, energy in energies.items() if id.startswith(f"@{cid}/"))
        pic_voltage = np.array([self._v(n) for n in self.pic_nodes])
        pic_energy = .5 * float(pic_voltage @ self.pic_c @ pic_voltage)
        for i, port in enumerate(("left", "right")):
            conduction = 0. if initial else q_conduction[i] / dt
            displacement = 0. if initial else (self._q_pic[i] - previous_q[i]) / dt
            total = displacement - conduction
            for suffix, quantity in (("voltage_v", pic_voltage[i]), ("electrode_charge_c", self._q_pic[i]),
                                      ("conduction_current_a", conduction), ("displacement_current_a", displacement),
                                      ("total_current_a", total), ("power_w", pic_voltage[i] * total)):
                values[f"pic/{port}/{suffix}"] = quantity
        values["circuit/stored_energy_j"] = pic_energy + sum(energies.values())
        values["circuit/dissipation_power_w"] = total_dissipation
        values["circuit/pic_vacuum_energy_j"] = pic_energy
        values["circuit/newton_iterations"] = self._last_iterations
        return values

    def _make_catalog(self):
        labels = {c.id: c.label or c.id for c in self.settings.document.components}
        suffixes = {
            "voltage_v": ("電圧", "V"), "current_a": ("電流 p→n", "A"), "power_w": ("入力電力", "W"),
            "energy_j": ("蓄積エネルギー", "J"), "charge_c": ("電荷", "C"), "state": ("ON状態", "1"),
            "resistance_ohm": ("実効抵抗", "Ω"), "junction_voltage_v": ("接合電圧", "V"),
            "conduction_current_a": ("伝導電流", "A"), "capacitive_current_a": ("容量電流", "A"),
            "capacitance_f": ("接合微分容量", "F"),
        }
        catalog = []
        def add(key, label, unit, note=""):
            catalog.append({"key": key, "label": label, "unit": unit, "note": note})
        for node in ("0", *self.node_index):
            add(f"node/{node}/voltage_v", f"節点 {node} 電圧", "V", "GNDを基準。@で始まる節点は同軸・ダイオード内部節点。")
        for b in self.branches:
            name = labels.get(b.id, b.id)
            keys = ["voltage_v", "current_a", "power_w", "energy_j"]
            if b.kind == "C":
                keys += ["charge_c"]
            if b.kind == "S":
                keys += ["state", "resistance_ohm"]
            if b.kind == "D":
                keys += ["junction_voltage_v", "conduction_current_a", "capacitive_current_a", "charge_c", "capacitance_f"]
            for suffix in keys:
                label, unit = suffixes[suffix]
                add(f"branch/{b.id}/{suffix}", name + " " + label, unit,
                    "p→nを電流の正方向とする受動符号規約。正の電圧源電力は電源への入力。初期化点のC/接合容量電流は0。")
        for cid in self.coax:
            for port, japanese in (("input", "入力端"), ("output", "出力端")):
                for suffix in ("voltage_v", "current_a", "power_w"):
                    label, unit = suffixes[suffix]
                    add(f"branch/{cid}/{port}_{suffix}", labels[cid] + " " + japanese + " " + label, unit, "両端ともケーブルへ流れ込む電流が正。電圧は内部導体−シールド。")
            add(f"branch/{cid}/power_w", labels[cid] + " 正味入力電力", "W", "両端の入力電力の合計。蓄積エネルギーの増減を含む。")
            add(f"branch/{cid}/energy_j", labels[cid] + " 蓄積エネルギー", "J")
        for port, name in (("left", "左電極"), ("right", "右電極")):
            for suffix, label, unit in (("voltage_v", "電圧", "V"), ("electrode_charge_c", "電極電荷", "C"),
                ("conduction_current_a", "粒子伝導電流", "A"), ("displacement_current_a", "電極電荷変化率", "A"),
                ("total_current_a", "外部回路からの全電流", "A"), ("power_w", "外部回路からの電力", "W")):
                add(f"pic/{port}/{suffix}", name + " " + label, unit,
                    "粒子伝導は電極への正電荷流入。全電流 = 電極電荷変化率 − 粒子伝導。前PIC区間の平均値、面積換算済み。初期点電流は0。")
        for suffix, label, unit in (("stored_energy_j", "回路蓄積エネルギー", "J"), ("dissipation_power_w", "回路散逸電力", "W"),
                                  ("pic_vacuum_energy_j", "PIC真空容量エネルギー", "J"), ("newton_iterations", "回路反復数", "1")):
            add("circuit/" + suffix, label, unit, "蓄積エネルギーは外部回路+PIC真空容量。プラズマ粒子・空間電荷のエネルギーはPIC診断で扱う。")
        return catalog

    def _make_parameters(self):
        rows = []
        def add(key, label, value, unit="1", note=""):
            if isinstance(value, (float, int)) and math.isfinite(value):
                rows.append({"key": "external_circuit/" + key, "label": label, "value": float(value), "unit": unit, "note": note})
        add("area_m2", "外部回路 / 電極面積", self.area, "m²")
        add("temperature_k", "外部回路 / 動作温度", self.settings.temperature_k, "K")
        add("vacuum_permeability_h_m", "真空透磁率 μ₀", MU0, "H/m")
        for i, a in enumerate(("left", "right")):
            for j, b in enumerate(("left", "right")):
                add(f"pic_capacitance/{a}/{b}", f"PIC容量 C({a},{b})", self.pic_c[i, j], "F")
        def infer(key):
            exact_units = {
                "tem_velocity_m_s": "m/s", "attenuation_db_m": "dB/m", "reference_phase_rad_m": "rad/m",
                "dc_resistance_ohm_m": "Ω/m", "rf_resistance_ohm_m": "Ω/m",
                "internal_reactance_ohm_m": "Ω/m", "skin_resistance_ohm_m": "Ω/m",
                "relaxation_resistance_ohm_m": "Ω·m", "inner_resistivity_ohm_m": "Ω·m",
                "shield_resistivity_ohm_m": "Ω·m", "relative_permittivity": "1", "relative_permeability": "1",
                "phase_deg": "deg", "effective_series_resistance_ohm": "Ω", "thermal_voltage_v": "V",
            }
            if key in exact_units:
                return exact_units[key]
            for ending, unit in (("ohm_m", "Ω·m"), ("h_m", "H/m"), ("f_m", "F/m"), ("ohm", "Ω"),
                ("_m2", "m²"), ("_m", "m"), ("_hz", "Hz"), ("_s", "s"), ("_v", "V"), ("_a", "A"),
                ("_k", "K"), ("_f", "F"), ("_deg", "deg"), ("_rad", "rad"), ("_db", "dB"), ("_j", "J")):
                if key.endswith(ending):
                    return unit
            return "1"
        for c in self.settings.document.components:
            label = c.label or c.id
            p = c.parameters
            if c.kind in ("R", "C", "L"):
                for key, value in p.items():
                    add(f"{c.id}/{key}", label + " " + key, value,
                        {"R": "Ω", "C": "F", "L": "H"}[c.kind] if key == "value" else infer(key))
            elif c.kind == "D":
                add(c.id + "/area", label + " 面積倍率", p["area"])
                for key, value in p["model_parameters"].items():
                    add(f"{c.id}/{key}", label + " " + key, value, MODEL_UNITS[key])
                for key, value in self.diodes[c.id].items():
                    add(f"{c.id}/{key}", label + " " + key, value, infer(key))
            elif c.kind in ("COAX", "COAX_GND"):
                for source in (p, self.coax[c.id]):
                    for key, value in source.items():
                        add(f"{c.id}/{key}", label + " " + key, value, infer(key))
            elif c.kind in ("S", "V"):
                for key, value in p.items():
                    add(f"{c.id}/{key}", label + " " + key, value, infer(key))
                for key, value in p.get("waveform", {}).items():
                    add(f"{c.id}/waveform/{key}", label + " " + key, value, infer(key))
                for i, point in enumerate(p.get("waveform", {}).get("points", [])):
                    add(f"{c.id}/waveform/point{i}/t", label + f" PWL点{i} 時刻", point[0], "s")
                    add(f"{c.id}/waveform/point{i}/v", label + f" PWL点{i} 電圧", point[1], "V")
        # Derived coax values also repeat a few input parameters: stable unique IDs.
        return list({row["key"]: row for row in rows}.values())

    def _record(self, t):
        self._sample_count += 1
        if (self._sample_count - 1) % self._sample_stride == 0:
            self._records.append((float(t), self._latest.copy()))
        if len(self._records) > 2000:
            self._records = self._records[::2]
            self._sample_stride *= 2

    def snapshot(self):
        return {"x": self._x.copy(), "capacitor_v": dict(self._capacitor_v), "inductor_i": dict(self._inductor_i),
            "diode_q": dict(self._diode_q), "q_pic": None if self._q_pic is None else self._q_pic.copy(),
            "last_t": self._last_t, "latest": dict(self._latest), "records": list(self._records),
            "sample_count": self._sample_count, "sample_stride": self._sample_stride,
            "last_iterations": self._last_iterations}

    def restore(self, state):
        self._x = state["x"].copy()
        self._capacitor_v = dict(state["capacitor_v"])
        self._inductor_i = dict(state["inductor_i"])
        self._diode_q = dict(state["diode_q"])
        self._q_pic = None if state["q_pic"] is None else state["q_pic"].copy()
        self._last_t = state["last_t"]
        self._latest = dict(state["latest"])
        self._records = list(state["records"])
        self._sample_count, self._sample_stride = state["sample_count"], state["sample_stride"]
        self._last_iterations = state["last_iterations"]

    def reset_history(self):
        self._records = []
        self._sample_count, self._sample_stride = 0, 1

    def result(self, *, latest_only=False) -> dict:
        records = [] if latest_only else list(self._records)
        if self._last_t is not None and (not records or records[-1][0] != self._last_t):
            records.append((self._last_t, self._latest))
        keys = [d["key"] for d in self._catalog]
        history = {"t": [r[0] for r in records]}
        history.update({key: [row.get(key) for _, row in records] for key in keys})
        nodes = [{"id": n, "label": n, "endpoints": [{"component_id": cid, "port": p}
                   for (cid, p), name in self.topology["nets"].items() if name == n]}
                 for n in self.topology["node_names"]]
        return {"enabled": True, "method": "backward_euler_mna", "area_m2": self.area,
            "t_s": self._last_t, "history": history, "catalog": self._catalog,
            "latest": dict(self._latest), "parameters": self._parameters, "nodes": nodes,
            "metadata": {"coax": self.coax, "diodes": self.diodes,
                "initialization": self._initialization, "history_stride": self._sample_stride,
                "pic_capacitance_f": self.pic_c.tolist(),
                "current_sign": "枝電流p→n。PIC全電流は回路→電極。粒子伝導は粒子→電極。",
                "integration": "後退Euler: ΔQelectrode + dt*Iexternal_out = Qparticle_into_electrode。",
                "time_resolution_note": "回路もPICのdtで積分。パルス・同軸遅延・最速RLC時間より十分小さいdtで感度を確認。"}}

    def frame(self) -> dict:
        # Full histories contain many internal ladder quantities and are sent
        # once with done.result. A live frame carries their latest sample.
        return self.result(latest_only=True)
