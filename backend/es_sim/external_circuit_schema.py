"""External circuit documents shared by the editor and PIC solver (SI units)."""
from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

PORTS = {
    "R": ["p", "n"], "C": ["p", "n"], "L": ["p", "n"],
    "D": ["p", "n"], "S": ["p", "n"], "V": ["p", "n"],
    "GND": ["g"], "PIC": ["left", "right"],
    "COAX": ["p1", "n1", "p2", "n2"], "COAX_GND": ["p1", "p2"],
}


def number(value: Any, name: str, *, positive=False, nonnegative=False) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} は有限の数値で指定してください")
    try:
        n = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} は有限の数値で指定してください") from exc
    if not math.isfinite(n) or (positive and n <= 0) or (nonnegative and n < 0):
        raise ValueError(f"{name} は{'正' if positive else '非負' if nonnegative else '有限'}の数値で指定してください")
    return n


def source_parameters(parameters: dict) -> dict:
    p = dict(parameters)
    p["dc_v"] = number(p.get("dc_v", 0), "電圧源 DC [V]")
    waveform = p.get("waveform") or {"kind": "dc"}
    if not isinstance(waveform, dict):
        raise ValueError("電圧源 waveform はオブジェクトで指定してください")
    w = dict(waveform)
    kind = str(w.get("kind", "dc")).lower()
    w["kind"] = kind
    if kind == "sin":
        for k, default in (("offset_v", p["dc_v"]), ("amplitude_v", 100), ("phase_deg", 0)):
            w[k] = number(w.get(k, default), f"電圧源 {k}")
        w["frequency_hz"] = number(w.get("frequency_hz", 13.56e6), "電圧源周波数 [Hz]", positive=True)
        w["delay_s"] = number(w.get("delay_s", 0), "電圧源遅延 [s]", nonnegative=True)
    elif kind == "pulse":
        for k, default in (("initial_v", 0), ("pulsed_v", 100)):
            w[k] = number(w.get(k, default), f"電圧源 {k}")
        for k, default in (("delay_s", 0), ("rise_s", 1e-9), ("fall_s", 1e-9), ("width_s", 1e-6)):
            w[k] = number(w.get(k, default), f"電圧源 {k}", nonnegative=True)
        w["period_s"] = number(w.get("period_s", 2e-6), "電圧源周期 [s]", positive=True)
        if w["rise_s"] + w["width_s"] + w["fall_s"] > w["period_s"]:
            raise ValueError("パルスの立上り・ON幅・立下りの合計は周期以下にしてください")
    elif kind == "pwl":
        points = w.get("points", [])
        if not isinstance(points, list) or not 2 <= len(points) <= 10000:
            raise ValueError("PWL は 2〜10000 個の [時刻s,電圧V] ペアで指定してください")
        normalized = []
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise ValueError("PWL の各点は [時刻s,電圧V] で指定してください")
            normalized.append([number(point[0], "PWL 時刻", nonnegative=True), number(point[1], "PWL 電圧")])
        if any(b[0] <= a[0] for a, b in zip(normalized, normalized[1:])):
            raise ValueError("PWL の時刻は厳密な昇順にしてください")
        w["points"] = normalized
    elif kind != "dc":
        raise ValueError(f"未対応の電源波形です: {kind}")
    p["waveform"] = w
    return p


def switch_parameters(parameters: dict) -> dict:
    p = dict(parameters)
    for key, default in (("on_resistance_ohm", .01), ("off_resistance_ohm", 1e12)):
        p[key] = number(p.get(key, default), f"スイッチ {key}", positive=True)
    if p["off_resistance_ohm"] < p["on_resistance_ohm"]:
        raise ValueError("スイッチのOFF抵抗はON抵抗以上にしてください")
    state = p.get("initial_state", False)
    if not isinstance(state, bool):
        raise ValueError("スイッチ initial_state は真偽値で指定してください")
    p["initial_state"] = state
    p["on_time_s"] = number(p.get("on_time_s", 0), "スイッチ ON時刻 [s]", nonnegative=True)
    for k in ("off_time_s", "period_s"):
        if p.get(k) is not None:
            p[k] = number(p[k], f"スイッチ {k}", positive=k == "period_s", nonnegative=True)
    if p.get("off_time_s") is not None and p["off_time_s"] <= p["on_time_s"]:
        raise ValueError("スイッチ OFF時刻はON時刻より後にしてください")
    p["duty"] = number(p.get("duty", .5), "スイッチデューティ")
    if not 0 <= p["duty"] <= 1:
        raise ValueError("スイッチデューティは0〜1にしてください")
    return p


class Position(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float = Field(default=0, allow_inf_nan=False)
    y: float = Field(default=0, allow_inf_nan=False)


class CircuitComponent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")
    kind: Literal["R", "C", "L", "D", "COAX", "COAX_GND", "S", "V", "GND", "PIC"]
    label: str = Field(default="", max_length=100)
    ports: list[str] = Field(default_factory=list, max_length=4)
    parameters: dict[str, Any] = Field(default_factory=dict)
    position: Position = Field(default_factory=Position)
    rotation: int = 0

    @model_validator(mode="after")
    def validate_component(self):
        expected = PORTS[self.kind]
        if not self.ports:
            self.ports = list(expected)
        if self.ports != expected:
            raise ValueError(f"{self.id} ({self.kind}) の端子は {', '.join(expected)} です")
        if self.rotation not in (0, 90, 180, 270):
            raise ValueError("回路素子の回転角は0/90/180/270度です")
        p = dict(self.parameters)
        if self.kind in ("R", "C", "L"):
            p["value"] = number(p.get("value", {"R": 50, "C": 1e-9, "L": 1e-6}[self.kind]), self.id + " value", positive=True)
            if self.kind == "C":
                p["initial_voltage_v"] = (None if p.get("initial_voltage_v") is None
                    else number(p["initial_voltage_v"], self.id + " 初期電圧"))
            if self.kind == "L":
                p["initial_current_a"] = (None if p.get("initial_current_a") is None
                    else number(p["initial_current_a"], self.id + " 初期電流"))
        elif self.kind == "D":
            from .external_diode import DiodeModel
            p = DiodeModel.parse(p).parameters
        elif self.kind in ("COAX", "COAX_GND"):
            from .external_coax import CoaxModel
            p = CoaxModel.parse(p).parameters
        elif self.kind == "V":
            p = source_parameters(p)
        elif self.kind == "S":
            p = switch_parameters(p)
        elif p:
            raise ValueError(f"{self.kind} は部品パラメータを持ちません")
        self.parameters = p
        return self


class CircuitEndpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    component_id: str = Field(min_length=1, max_length=80)
    port: str = Field(min_length=1, max_length=20)


class CircuitWire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    source: CircuitEndpoint
    target: CircuitEndpoint


class CircuitNodeLabel(CircuitEndpoint):
    name: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")


class CircuitDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    name: str = Field(default="外部回路", min_length=1, max_length=200)
    components: list[CircuitComponent] = Field(default_factory=list, max_length=200)
    wires: list[CircuitWire] = Field(default_factory=list, max_length=2000)
    node_labels: list[CircuitNodeLabel] = Field(default_factory=list, max_length=800)

    @model_validator(mode="after")
    def validate_document(self):
        component_ids = [c.id for c in self.components]
        if len(set(component_ids)) != len(component_ids):
            raise ValueError("回路部品のIDが重複しています")
        wire_ids = [w.id for w in self.wires]
        if len(set(wire_ids)) != len(wire_ids):
            raise ValueError("回路配線のIDが重複しています")
        endpoints = {(c.id, p) for c in self.components for p in c.ports}
        pairs = set()
        for wire in self.wires:
            a, b = endpoint_key(wire.source), endpoint_key(wire.target)
            if a not in endpoints or b not in endpoints:
                raise ValueError(f"配線 {wire.id} が存在しない端子を参照しています")
            if a == b:
                raise ValueError(f"配線 {wire.id} は同じ端子同士を接続しています")
            pair = frozenset((a, b))
            if pair in pairs:
                raise ValueError("同じ端子間の配線が重複しています")
            pairs.add(pair)
        for label in self.node_labels:
            if endpoint_key(label) not in endpoints:
                raise ValueError(f"節点ラベル {label.name} が存在しない端子を参照しています")
        return self


class ExternalCircuitSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    area_m2: float = Field(default=1, gt=0, allow_inf_nan=False)
    temperature_k: float = Field(default=300, gt=0, allow_inf_nan=False)
    document: CircuitDocument = Field(default_factory=CircuitDocument)
    max_iterations: int = Field(default=50, ge=10, le=200)

    @model_validator(mode="after")
    def validate_enabled(self):
        if self.enabled:
            compile_topology(self.document)
        return self


def endpoint_key(e) -> tuple[str, str]:
    return e.component_id, e.port


def compile_topology(document: CircuitDocument) -> dict:
    """Wires merge nodes; labels name nodes but never create hidden connections."""
    components = {c.id: c for c in document.components}
    pics = [c for c in document.components if c.kind == "PIC"]
    if len(pics) != 1 or pics[0].id != "pic":
        raise ValueError("有効な外部回路には固定PIC部品 (id=pic) が1個必要です")
    grounds = [(c.id, "g") for c in document.components if c.kind == "GND"]
    if not grounds:
        raise ValueError("外部回路には接地 (GND) が必要です")
    parent = {(c.id, p): (c.id, p) for c in document.components for p in c.ports}
    def find(e):
        while parent[e] != e:
            parent[e] = parent[parent[e]]
            e = parent[e]
        return e
    def union(a, b):
        parent[find(b)] = find(a)
    for wire in document.wires:
        union(endpoint_key(wire.source), endpoint_key(wire.target))
    for g in grounds[1:]:
        union(grounds[0], g)
    # Both shield terminals denote a common ideal TEM reference.
    for c in document.components:
        if c.kind == "COAX":
            union((c.id, "n1"), (c.id, "n2"))
    ground = find(grounds[0])
    labels = {}
    reverse_labels = {}
    for label in document.node_labels:
        node = find(endpoint_key(label))
        if node == ground:
            raise ValueError("GNDの節点名は0に固定されています")
        if node in labels and labels[node] != label.name:
            raise ValueError("同じ節点に異なるラベルが付いています")
        if label.name.lower() in reverse_labels and reverse_labels[label.name.lower()] != node:
            raise ValueError("異なる節点に同じラベルが付いています")
        labels[node] = label.name
        reverse_labels[label.name.lower()] = node
    names = {ground: "0"}
    for endpoint in parent:
        node = find(endpoint)
        if node not in names:
            suggested = labels.get(node)
            if suggested is None:
                k = len(names)
                while f"n{k}".lower() in reverse_labels or f"n{k}" in names.values():
                    k += 1
                suggested = f"n{k}"
            names[node] = suggested
    nets = {e: names[find(e)] for e in parent}
    if nets[("pic", "left")] == nets[("pic", "right")]:
        raise ValueError("PICの左右電極を同じ節点に接続できません")
    adjacency = {n: set() for n in names.values()}
    dc_adjacency = {n: set() for n in names.values()}
    def connect(graph, a, b):
        graph[a].add(b)
        graph[b].add(a)
    segments = 0
    for c in document.components:
        if c.kind == "GND":
            continue
        if c.kind in ("COAX", "COAX_GND"):
            segments += c.parameters["segments"]
            a, b = nets[(c.id, "p1")], nets[(c.id, "p2")]
            shield = "0" if c.kind == "COAX_GND" else nets[(c.id, "n1")]
            connect(adjacency, a, shield)
            connect(adjacency, b, shield)
            connect(adjacency, a, b)
            connect(dc_adjacency, a, b)
        else:
            a, b = (nets[(c.id, p)] for p in c.ports)
            if a == b:
                raise ValueError(f"部品 {c.id} の両端が短絡されています")
            connect(adjacency, a, b)
            if c.kind not in ("C", "PIC"):
                connect(dc_adjacency, a, b)
    if segments > 512:
        raise ValueError("同軸ケーブルの分割数の合計は512以下にしてください")
    def reachable(graph):
        seen, pending = {"0"}, ["0"]
        while pending:
            for n in graph[pending.pop()]:
                if n not in seen:
                    seen.add(n)
                    pending.append(n)
        return seen
    floating = set(adjacency) - reachable(adjacency)
    if floating:
        raise ValueError("GNDにつながらない浮遊節点があります: " + ", ".join(sorted(floating)))
    return {"nets": nets, "node_names": list(names.values()), "dc_reachable": reachable(dc_adjacency), "components": components}


def circuit_frequency(settings: ExternalCircuitSettings | None) -> float | None:
    if settings is None or not settings.enabled:
        return None
    frequencies = []
    for component in settings.document.components:
        if component.kind == "V":
            w = component.parameters["waveform"]
            if w["kind"] == "sin":
                frequencies.append(w["frequency_hz"])
            elif w["kind"] == "pulse":
                frequencies.append(1 / w["period_s"])
        elif component.kind == "S" and component.parameters.get("period_s"):
            frequencies.append(1 / component.parameters["period_s"])
    return min(frequencies) if frequencies else None
