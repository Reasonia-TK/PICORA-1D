"""Standalone API contracts and held-state validation."""
import json

import pytest
from fastapi.testclient import TestClient

import es_sim.server as server
from es_sim.schema import Project


@pytest.fixture
def client():
    server._last_sim1d = None
    with TestClient(server.app) as client:
        yield client
    server._last_sim1d = None


def settings():
    return {
        "gap_m": 0.01, "n_cells": 16, "init_density_m3": 1e12,
        "n_macro": 100, "dt": 1e-10, "n_steps": 20, "frame_every": 5,
    }


def receive_done(ws):
    while True:
        msg = ws.receive_json()
        assert msg["type"] != "error", msg
        if msg["type"] == "done":
            return msg["result"]


def test_health_identifies_application(client):
    body = client.get("/health").json()
    assert body["app"] == "PICORA-1D" and body["status"] == "ok"
    assert body["instance"] == client.get("/health").json()["instance"]


def test_project_accepts_legacy_file_and_direct_settings():
    legacy = {
        "version": 1, "unit": "mm", "geometry": {"irrelevant": True},
        "mesh": {"size": 0.001}, "fluid1d": {"enabled": True}, "pic1d": settings(),
    }
    parsed = Project.model_validate(legacy)
    assert set(parsed.model_dump()) == {"version", "unit", "pic1d"}
    assert parsed.pic1d == Project.model_validate(settings()).pic1d


def test_ws_bad_message_recovers(client):
    with client.websocket_connect("/ws/pic1d") as ws:
        for message in ("not-json", "[]", '{"cmd":"unknown"}'):
            ws.send_text(message)
            assert ws.receive_json()["type"] == "error"
        ws.send_json({"cmd": "start", "project": {"pic1d": settings()}})
        assert ws.receive_json()["type"] == "started"
        assert len(receive_done(ws)["history"]["step"]) == 20


@pytest.mark.parametrize("changes", [
    {"extra_steps": 0}, {"extra_steps": 5, "frame_every": 0},
    {"extra_steps": 5, "phase_bins": -1}, {"extra_steps": 5, "avg_steps": 0},
])
def test_invalid_continue_preserves_held_state(client, changes):
    with client.websocket_connect("/ws/pic1d") as ws:
        ws.send_json({"cmd": "start", "project": {"pic1d": settings()}})
        receive_done(ws)
        before = server._last_sim1d.s.model_dump()
        ws.send_json({"cmd": "continue", **changes})
        assert ws.receive_json()["type"] == "error"
        assert server._last_sim1d.s.model_dump() == before
        ws.send_json({"cmd": "continue", "extra_steps": 2})
        assert ws.receive_json()["step_offset"] == 20
        assert len(receive_done(ws)["history"]["step"]) == 2


def test_stop_returns_partial_result_and_allows_continue(client):
    s = {**settings(), "n_steps": 1_000_000, "frame_every": 1}
    with client.websocket_connect("/ws/pic1d") as ws:
        ws.send_json({"cmd": "start", "project": {"pic1d": s}})
        assert ws.receive_json()["type"] == "started"
        ws.send_json({"cmd": "stop"})
        result = receive_done(ws)
        assert len(result["history"]["step"]) < s["n_steps"]
        step = server._last_sim1d.step_count
        ws.send_json({"cmd": "continue", "extra_steps": 2})
        assert ws.receive_json()["step_offset"] == step
        receive_done(ws)


def test_continue_can_reset_manual_averaging_to_automatic(client):
    with client.websocket_connect("/ws/pic1d") as ws:
        ws.send_json({"cmd": "start", "project": {"pic1d": {**settings(), "avg_steps": 4}}})
        assert receive_done(ws)["profiles"]["avg_steps"] == 4
        ws.send_json({"cmd": "continue", "extra_steps": 8, "avg_steps": None})
        result = receive_done(ws)
        assert result["settings"]["avg_steps"] is None
        assert result["profiles"]["avg_steps"] == 2


def test_continue_rejects_another_clients_held_state(client):
    with client.websocket_connect("/ws/pic1d") as first, client.websocket_connect("/ws/pic1d") as second:
        first.send_json({"cmd": "start", "project": {"pic1d": settings()}})
        receive_done(first)
        second.send_json({"cmd": "start", "project": {"pic1d": {**settings(), "init_density_m3": 2e12}}})
        receive_done(second)
        step = server._last_sim1d.step_count
        first.send_json({"cmd": "continue", "extra_steps": 2})
        assert first.receive_json()["type"] == "error"
        assert server._last_sim1d.step_count == step
        second.send_json({"cmd": "continue", "extra_steps": 2})
        assert receive_done(second)["settings"]["init_density_m3"] == 2e12


def test_removed_solver_routes_are_unavailable(client):
    for path in ("/mesh", "/solve", "/trace", "/ws/fluid1d", "/ws/pic"):
        assert client.post(path, json={}).status_code in (404, 405)


def test_schema_is_one_dimensional(client):
    schema = client.get("/schema").json()
    assert "pic1d" in schema["properties"]
    assert "geometry" not in schema["properties"]


def test_result_is_strict_json(client):
    with client.websocket_connect("/ws/pic1d") as ws:
        ws.send_json({"cmd": "start", "project": {"pic1d": settings()}})
        result = receive_done(ws)
        json.dumps(result, allow_nan=False)
        assert {"history", "profiles", "wall_iedf", "convergence", "settings"} <= result.keys()
