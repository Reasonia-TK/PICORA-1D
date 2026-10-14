"""外部回路のAPI・配布ビルド検証に使うテスト専用回路。"""
def all_components_circuit():
    components = []
    for cid, kind, parameters, ports in [
        ("pic", "PIC", {}, ["left", "right"]),
        ("v1", "V", {"dc_v": 0, "waveform": {"kind": "sin", "amplitude_v": 10, "frequency_hz": 13.56e6}}, ["p", "n"]),
        ("s1", "S", {"on_resistance_ohm": 1, "off_resistance_ohm": 1e8, "on_time_s": 0}, ["p", "n"]),
        ("r1", "R", {"value": 50}, ["p", "n"]),
        ("l1", "L", {"value": 1e-7}, ["p", "n"]),
        ("cx1", "COAX_GND", {"length_m": .1, "segments": 2}, ["p1", "p2"]),
        ("c1", "C", {"value": 1e-9}, ["p", "n"]),
        ("d1", "D", {"area": 1, "model_parameters": {"IS": 1e-14, "N": 1.5, "RS": 1, "BV": 100, "CJO": 1e-12, "TT": 1e-9}}, ["p", "n"]),
        ("g1", "GND", {}, ["g"]),
    ]:
        components.append({"id": cid, "kind": kind, "label": cid.upper(), "ports": ports,
                           "parameters": parameters, "position": {"x": len(components) * 100, "y": 100}, "rotation": 0})
    wires = []
    for a, b in [("v1.p", "s1.p"), ("s1.n", "r1.p"), ("r1.n", "l1.p"), ("l1.n", "cx1.p1"),
                 ("cx1.p2", "c1.p"), ("c1.n", "pic.left"), ("pic.left", "d1.p"),
                 ("pic.right", "g1.g"), ("v1.n", "g1.g"), ("d1.n", "g1.g")]:
        ac, ap = a.split("."); bc, bp = b.split(".")
        wires.append({"id": f"w{len(wires)}", "source": {"component_id": ac, "port": ap}, "target": {"component_id": bc, "port": bp}})
    return {"enabled": True, "area_m2": .01, "temperature_k": 300, "max_iterations": 50,
            "document": {"schema_version": 1, "name": "API検証", "components": components, "wires": wires, "node_labels": []}}
