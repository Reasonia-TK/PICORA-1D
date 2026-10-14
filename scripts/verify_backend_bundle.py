"""同梱バックエンドの起動、Numba/MCC、停止、即時継続を実通信で確認する。"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import math
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[1]


def get_json(port: int, path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=1) as response:
        return json.load(response)


async def receive_done(ws) -> tuple[dict, list[str]]:
    events = []
    while True:
        message = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
        events.append(message["type"])
        if message["type"] == "error":
            raise AssertionError(message["detail"])
        if message["type"] == "done":
            return message["result"], events


async def verify(port: int) -> dict:
    sys.path.insert(0, str(ROOT / "backend" / "tests"))
    from reference_cases import get_presets
    from circuit_examples import all_components_circuit
    settings = copy.deepcopy(get_presets()["edupic_ar"]["pic1d"])
    settings.update(n_cells=32, n_macro=8192, n_steps=200, frame_every=20, avg_steps=100, phase_bins=8, parallel=True, cpu_threads=2)
    settings["eedf_regions"] = [{"x1": 0, "x2": settings["gap_m"], "label": "smoke", "bins": 30}]
    # 場・粒子・断面積の診断を含む done は 1 MiB を超える。
    async with connect(f"ws://127.0.0.1:{port}/ws/pic1d", max_size=32 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"cmd": "start", "project": {"pic1d": settings}}))
        result, events = await receive_done(ws)
        assert events[0] == "started" and "frame" in events
        assert len(result["profiles"]["x"]) == 33
        assert result["history"]["step"][-1] == 200
        assert result["eedf"]
        assert "diagnostics" in result and "execution" in result
        assert result["execution"]["enabled"] and result["execution"]["threads"] == 2
        await ws.send(json.dumps({"cmd": "continue", "extra_steps": 200, "avg_steps": 100}))
        continued, continue_events = await receive_done(ws)
        assert continued["history"]["step"][-1] == 400
        settings["n_steps"] = 100000
        await ws.send(json.dumps({"cmd": "start", "project": {"pic1d": settings}}))
        started = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
        assert started["type"] == "started"
        await ws.send(json.dumps({"cmd": "stop"}))
        stopped, _ = await receive_done(ws)
        stop_step = stopped["history"]["step"][-1] if stopped["history"]["step"] else 0
        assert stop_step < 100000
        external = {"gap_m": .02, "n_cells": 16, "init_density_m3": 1e12, "n_macro": 100,
                    "dt": 1e-10, "n_steps": 30, "frame_every": 10, "phase_bins": 0,
                    "external_circuit": all_components_circuit(), "convergence": {"enabled": False}}
        request = urllib.request.Request(f"http://127.0.0.1:{port}/circuit/validate",
            data=json.dumps({"gap_m": .02, "external_circuit": external["external_circuit"]}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            assert json.load(response)["valid"]
        await ws.send(json.dumps({"cmd": "start", "project": {"pic1d": external}}))
        coupled, external_events = await receive_done(ws)
        circuit = coupled["external_circuit"]
        assert circuit["enabled"] and len(circuit["catalog"]) > 20
        assert all(math.isfinite(v) for values in circuit["history"].values() for v in values if v is not None)
        await ws.send(json.dumps({"cmd": "continue", "extra_steps": 10}))
        external_continued, _ = await receive_done(ws)
        assert external_continued["history"]["step"][-1] == 40
        return {"events": events, "continue_events": continue_events, "result_keys": sorted(result),
                "execution": result["execution"],
                "diagnostic_catalog_entries": len(result["diagnostics"]["catalog"]),
                "physical_parameters": len(result["diagnostics"]["parameters"]),
                "continued_step": 400, "stop_step": stop_step,
                "external_circuit": {"events": external_events, "catalog_entries": len(circuit["catalog"]),
                                     "method": circuit["method"], "continued_step": 40}}


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, default=ROOT / "backend/dist/picora-backend/picora-backend.exe")
    args = parser.parse_args()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    reports = ROOT / "reports"
    reports.mkdir(exist_ok=True)
    with (reports / "bundle-backend.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([str(args.exe), "--port", str(port)], stdout=log, stderr=log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"同梱バックエンドが終了しました: {process.returncode}")
                try:
                    health = get_json(port, "/health")
                    break
                except (OSError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            assert health["app"] == "PICORA-1D"
            assert health["numba"], "配布バックエンドのNumbaが無効です"
            report = {"passed": True, "executable": str(args.exe), "health": health, **asyncio.run(verify(port))}
            (reports / "bundle-smoke.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print("配布バックエンド: 起動/MCC/Numba/停止/継続/全素子外部回路連成 合格")
        finally:
            process.terminate()
            process.wait(timeout=10)


if __name__ == "__main__":
    main()
