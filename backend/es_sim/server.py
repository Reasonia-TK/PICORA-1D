"""PICORA-1D local API. Run with uvicorn es_sim.server:app --port 8321."""
from __future__ import annotations

import asyncio
import json
import secrets
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import numpy as np

from . import __version__, _numba_kernels
from .lxcat import parse_lxcat
from .pic1d import Pic1dSimulation, build_pic1d_result
from .parallel import environment_info
from .constants import EPS0
from .external_circuit_schema import ExternalCircuitSettings
from .external_circuit import ExternalCircuit
from .schema import LxcatParseRequest, LxcatParseResult, Pic1dSettings, Project

app = FastAPI(title="PICORA-1D backend", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?|tauri://localhost",
    allow_methods=["*"],
    allow_headers=["*"],
)

SERVER_INSTANCE = secrets.token_hex(8)
_last_sim1d: Pic1dSimulation | None = None
_last_sim1d_owner: WebSocket | None = None
_pic1d_lock = asyncio.Lock()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok", "app": "PICORA-1D", "version": __version__,
        "instance": SERVER_INSTANCE, "numba": _numba_kernels.HAVE_NUMBA,
        "solver": "1d3v PIC-MCC", "gpu": False, "execution": environment_info(),
    }


@app.get("/schema")
def schema_endpoint() -> dict:
    return Project.model_json_schema()


class CircuitCheckRequest(BaseModel):
    external_circuit: ExternalCircuitSettings
    gap_m: float = Field(default=0.02, gt=0, allow_inf_nan=False)


@app.post("/circuit/validate")
def circuit_check_endpoint(req: CircuitCheckRequest) -> dict:
    """編集した回路を保存・PIC実行せずに組み立て、初期連立方程式を確認する。"""
    try:
        settings = req.external_circuit.model_copy(update={"enabled": True})
        capacitance = EPS0 / req.gap_m * np.array([[1., -1.], [-1., 1.]])
        solver = ExternalCircuit(settings, capacitance)
        voltage = solver.solve(np.zeros(2), 0., 0., np.zeros(2))
        result = solver.result()
        return {"valid": True, "electrode_voltage_v": voltage.tolist(), "nodes": result.get("nodes", []), "metadata": result.get("metadata", {})}
    except (ValueError, RuntimeError, np.linalg.LinAlgError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/lxcat/parse", response_model=LxcatParseResult)
def lxcat_parse_endpoint(req: LxcatParseRequest) -> LxcatParseResult:
    try:
        processes, warnings = parse_lxcat(req.text, req.species)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return LxcatParseResult(processes=processes, warnings=warnings)


async def _run_pic1d_session(ws: WebSocket, project_dict: dict) -> None:
    global _last_sim1d, _last_sim1d_owner
    try:
        project = Project.model_validate(project_dict)
        sim = await asyncio.to_thread(Pic1dSimulation, project)
    except Exception as exc:
        await ws.send_json({"type": "error", "detail": str(exc)})
        return
    _last_sim1d = sim
    _last_sim1d_owner = ws
    await _stream_run_1d(ws, sim)


async def _continue_pic1d_session(ws: WebSocket, msg: dict) -> None:
    sim = _last_sim1d
    if sim is None:
        await ws.send_json({"type": "error", "detail": "保持中の実行状態がありません (先に start してください)"})
        return
    if _last_sim1d_owner is not ws:
        await ws.send_json({"type": "error", "detail": "別の接続で開始された実行状態は継続できません。新しく実行してください"})
        return
    try:
        # Validate the complete updated settings before mutating a held simulation.
        updates = {"n_steps": msg.get("extra_steps", sim.s.n_steps)}
        for name in ("frame_every", "avg_steps", "phase_bins"):
            if name in msg:
                updates[name] = msg[name]
        validated = Pic1dSettings.model_validate({**sim.s.model_dump(), **updates})
        # Explicit JSON null returns averaging to automatic; omission retains it.
        sim.s.avg_steps = validated.avg_steps
        sim.prepare_continue(validated.n_steps, validated.frame_every, validated.avg_steps, validated.phase_bins)
    except Exception as exc:
        await ws.send_json({"type": "error", "detail": str(exc)})
        return
    await _stream_run_1d(ws, sim)


async def _stream_run_1d(ws: WebSocket, sim: Pic1dSimulation) -> None:
    loop = asyncio.get_running_loop()
    stop = threading.Event()
    queue: asyncio.Queue = asyncio.Queue(maxsize=1)
    await ws.send_json({
        "type": "started", "n_steps": sim.s.n_steps, "step_offset": sim.step_count,
        "dt": sim.dt, "x": sim.xg.tolist(), "warnings": sim.warnings,
        "execution": sim.execution,
    })

    def on_frame(frame: dict) -> None:
        def offer_latest() -> None:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(frame)
        loop.call_soon_threadsafe(offer_latest)

    t_run0 = time.perf_counter()
    run_task = asyncio.create_task(asyncio.to_thread(sim.run_batch, on_frame, stop.is_set, False))

    async def watch_stop() -> None:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except (WebSocketDisconnect, RuntimeError):
                stop.set()
                return
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "detail": "JSON を読み込めません"})
                continue
            if not isinstance(msg, dict):
                await ws.send_json({"type": "error", "detail": "メッセージは JSON オブジェクトで指定してください"})
            elif msg.get("cmd") == "stop":
                stop.set()
                return
            else:
                await ws.send_json({"type": "error", "detail": "実行中は stop のみ受け付けます"})

    stop_task = asyncio.create_task(watch_stop())
    try:
        while not (run_task.done() and queue.empty()):
            try:
                frame = await asyncio.wait_for(queue.get(), timeout=0.1)
            except asyncio.TimeoutError:
                continue
            await ws.send_json(frame)
        await run_task
        # Stop the receiver before announcing completion; otherwise an immediate
        # continue from the client can be consumed by the previous run's watcher.
        stop_task.cancel()
        await asyncio.gather(stop_task, return_exceptions=True)
        await ws.send_json({"type": "done", "result": build_pic1d_result(sim, time.perf_counter() - t_run0)})
    except Exception as exc:
        try:
            await ws.send_json({"type": "error", "detail": str(exc)})
        except (WebSocketDisconnect, RuntimeError):
            pass
    finally:
        stop.set()
        stop_task.cancel()
        await asyncio.gather(stop_task, run_task, return_exceptions=True)


@app.websocket("/ws/pic1d")
async def ws_pic1d(ws: WebSocket) -> None:
    await ws.accept()
    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "detail": "JSON を読み込めません"})
                continue
            if not isinstance(msg, dict):
                await ws.send_json({"type": "error", "detail": "メッセージは JSON オブジェクトで指定してください"})
                continue
            cmd = msg.get("cmd")
            if cmd in ("start", "continue"):
                if _pic1d_lock.locked():
                    await ws.send_json({"type": "error", "detail": "別の 1D PIC 実行が進行中です"})
                    continue
                async with _pic1d_lock:
                    if cmd == "start":
                        await _run_pic1d_session(ws, msg.get("project", {}))
                    else:
                        await _continue_pic1d_session(ws, msg)
            elif cmd != "stop":
                await ws.send_json({"type": "error", "detail": f"不明なコマンド: {cmd}"})
    except WebSocketDisconnect:
        pass


# API routes must be registered before the catch-all UI mount.
_ui_dist = Path(__file__).resolve().parents[2] / "ui" / "dist"
if (_ui_dist / "index.html").is_file():
    app.mount("/", StaticFiles(directory=_ui_dist, html=True), name="ui")
