import json
import math

from fastapi.testclient import TestClient

from es_sim import server
from circuit_examples import all_components_circuit


def test_editor_validates_initial_circuit_without_replacing_held_pic_state():
    sentinel = object()
    server._last_sim1d = sentinel
    with TestClient(server.app) as client:
        response = client.post("/circuit/validate", json={"gap_m": .02, "external_circuit": all_components_circuit()})
    assert response.status_code == 200, response.text
    assert response.json()["valid"] and response.json()["nodes"]
    assert server._last_sim1d is sentinel
    server._last_sim1d = None


def test_editor_reports_unconnected_electrode_and_invalid_numeric_input():
    c = all_components_circuit(); c["document"]["wires"] = []
    with TestClient(server.app) as client:
        assert client.post("/circuit/validate", json={"external_circuit": c}).status_code == 422
        c = all_components_circuit(); c["area_m2"] = -1
        assert client.post("/circuit/validate", json={"external_circuit": c}).status_code == 422


def test_all_requested_components_run_over_websocket_and_continue():
    settings = {"gap_m": .02, "n_cells": 16, "init_density_m3": 1e12, "n_macro": 50,
                "dt": 1e-10, "n_steps": 30, "frame_every": 10, "phase_bins": 0,
                "external_circuit": all_components_circuit(), "convergence": {"enabled": False}}
    with TestClient(server.app) as client, client.websocket_connect("/ws/pic1d") as ws:
        ws.send_json({"cmd": "start", "project": {"pic1d": settings}})
        assert ws.receive_json()["type"] == "started"
        frames = []
        while True:
            msg = ws.receive_json(); assert msg["type"] != "error", msg
            if msg["type"] == "frame": frames.append(msg)
            if msg["type"] == "done": break
        circuit = msg["result"]["external_circuit"]
        assert circuit["enabled"] and len(circuit["catalog"]) > 20
        assert "coax" in circuit["metadata"]
        assert any("current_a" in x["key"] for x in circuit["catalog"])
        assert all(math.isfinite(v) for values in circuit["history"].values() for v in values if v is not None)
        assert frames and frames[-1]["external_circuit"]["catalog"]
        json.dumps(msg, allow_nan=False)
        ws.send_json({"cmd": "continue", "extra_steps": 10})
        assert ws.receive_json()["step_offset"] == 30
        while True:
            msg = ws.receive_json(); assert msg["type"] != "error", msg
            if msg["type"] == "done": break
        assert msg["result"]["history"]["step"][-1] == 40
    server._last_sim1d = None
