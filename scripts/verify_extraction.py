"""旧 ES-Sim と抽出した PICORA-1D を別環境で実行し、物理状態をビット比較する。

実行例: uv run --project backend python scripts/verify_extraction.py
旧リポジトリは読み取りだけ行い、Numba の一時キャッシュも一時ディレクトリへ隔離する。
永続的な出力は reports/extraction-regression.json のみ。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ORIGINAL = Path(r"C:\Works\20260928_ES-Sim")
MARKER = "__PICORA_REGRESSION__="
FORBIDDEN_MODULES = (
    "gmsh", "cupy", "pyamg", "boltzpmp", "ezdxf",
    "es_sim.pic", "es_sim.fem", "es_sim.meshing", "es_sim.particles",
    "es_sim.dsmc", "es_sim.fluid1d", "es_sim.fluid2d", "es_sim.gpic",
    "es_sim.amr", "es_sim.cad", "es_sim.trace", "es_sim.boltz",
)


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      allow_nan=False, separators=(",", ":")).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def original_contract(value: Any, reference: Any) -> Any:
    """追加した診断を除き、元ソルバーに存在する全量を比較する。"""
    if isinstance(value, dict) and isinstance(reference, dict):
        return {key: original_contract(value[key], item)
                for key, item in reference.items() if key in value}
    if isinstance(value, list) and isinstance(reference, list):
        return [original_contract(item, reference[i]) if i < len(reference) else item
                for i, item in enumerate(value)]
    return value


def difference(left: Any, right: Any, path: str = "$", limit: int = 12) -> list[dict]:
    """配列は生バイト、float は IEEE 754 のビットで比較する。"""
    found: list[dict] = []

    def visit(a, b, p):
        if len(found) >= limit:
            return
        if type(a) is not type(b):
            found.append({"path": p, "reason": "type", "old": type(a).__name__, "new": type(b).__name__})
        elif isinstance(a, dict):
            if set(a) != set(b):
                found.append({"path": p, "reason": "keys", "old_only": sorted(set(a) - set(b)), "new_only": sorted(set(b) - set(a))})
            for key in sorted(set(a) & set(b)):
                visit(a[key], b[key], f"{p}.{key}")
        elif isinstance(a, list):
            if len(a) != len(b):
                found.append({"path": p, "reason": "length", "old": len(a), "new": len(b)})
            for i, (av, bv) in enumerate(zip(a, b)):
                visit(av, bv, f"{p}[{i}]")
        elif isinstance(a, float):
            if struct.pack("!d", a) != struct.pack("!d", b):
                found.append({"path": p, "reason": "float_bits", "old": a, "new": b, "abs_difference": abs(a - b)})
        elif a != b:
            # 巨大な ndarray の base64 全体を診断ファイルに書かない。
            if p.endswith(".bytes"):
                found.append({"path": p, "reason": "array_bytes", "old_sha256": hashlib.sha256(base64.b64decode(a)).hexdigest(), "new_sha256": hashlib.sha256(base64.b64decode(b)).hexdigest()})
            else:
                found.append({"path": p, "reason": "value", "old": a, "new": b})

    visit(left, right, path)
    return found


def worker(backend: Path, probe_dependencies: bool) -> None:
    sys.path.insert(0, str(backend.resolve()))
    import numpy as np
    from es_sim.pic1d import Pic1dSimulation, build_pic1d_result
    if backend.resolve() == (ROOT / "backend").resolve():
        sys.path.insert(0, str(ROOT / "backend" / "tests"))
        from reference_cases import get_presets
    else:
        from es_sim.pic1d_presets import get_presets
    from es_sim.schema import Pic1dSettings, Project
    from es_sim import _numba_kernels

    def normalize(value):
        if isinstance(value, np.ndarray):
            arr = np.ascontiguousarray(value)
            return {"dtype": arr.dtype.str, "shape": list(arr.shape),
                    "bytes": base64.b64encode(arr.tobytes()).decode("ascii")}
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, dict):
            return {str(k): normalize(v) for k, v in value.items()}
        if isinstance(value, (tuple, list)):
            return [normalize(v) for v in value]
        return value

    def state(sim):
        # 継続でリセットする診断履歴/タイマーを除き、次ステップを決める状態を比較する。
        out = {
            "species": {name: {"q": sp.q, "m": sp.m, "x": sp.x, "v": sp.v, "w": sp.w}
                        for name, sp in sim.species.items()},
            "t": sim.t, "step_count": sim.step_count, "dt": sim.dt,
            "wall": sim.wall, "ion_events": sim.ion_events, "see_events": sim.see_events,
            "coll_e": sim.coll_e, "fn_events": sim.fn_events, "fn_total_w": sim.fn_total_w,
            "fn_fraction": sim._fn_frac,
            "see_rng": sim._see_rng.bit_generator.state,
            "mcc_rng": None if sim.mcc is None else sim.mcc.rng.bit_generator.state,
            "fields": sim.fields, "cycle": sim.cycle,
        }
        if sim.circuit is not None:
            out["circuit_state"] = {key: getattr(sim.circuit, key) for key in
                                    ("q_node", "v", "v_src", "_k", "_acc", "_dur", "_wave_t", "_wave_v", "last_wave")}
        return normalize(out)

    def project(settings):
        # 元 Project の必須 CAD フィールド。抽出側はこれを無視し、1D のみを読む。
        return Project.model_validate({
            "geometry": {"domain": {"polygon": [[0, 0], [1, 0], [1, 1], [0, 1]]}},
            "mesh": {"size": 0.1}, "pic1d": settings,
        })

    base = {
        "gap_m": 0.02, "n_cells": 32, "init_density_m3": 1e13,
        "init_te_ev": 2.0, "init_ti_ev": 0.03, "n_macro": 256,
        "dt": 1e-10, "n_steps": 120, "frame_every": 40, "avg_steps": 40,
        "phase_bins": 8, "seed": 7,
        "left": {"v_dc": 10.0}, "right": {"v_dc": 0.0},
        "eedf_regions": [{"x1": 0.0, "x2": 0.02, "label": "gap", "bins": 30, "e_max_ev": 30.0}],
        "wall_iedf_bins": 40,
    }
    ar = get_presets()["edupic_ar"]["pic1d"]
    ar = {**ar, "n_cells": 48, "n_macro": 1200, "n_steps": 1600,
          "frame_every": 400, "avg_steps": 400, "phase_bins": 12, "seed": 11,
          "eedf_regions": [{"x1": 0.005, "x2": 0.02, "label": "bulk", "bins": 40, "e_max_ev": 100.0}],
          "wall_iedf_bins": 50}
    ar["mcc"] = {**ar["mcc"], "seed": 13}
    capacitor = {**ar, "n_macro": 1000, "n_steps": 1200, "avg_steps": 300,
                 "frame_every": 400, "init_ti_ev": 5.0,
                 "left": {**ar["left"], "see_gamma": 1.0,
                          "blocking_capacitor": {"capacitance": 1e-7, "initial_bias_v": -10.0}},
                 "right": {"v_dc": 0.0, "see_gamma": 1.0,
                           "blocking_capacitor": {"capacitance": 3e-7, "initial_bias_v": 5.0}}}
    fn = {"gap_m": 1e-6, "n_cells": 10, "init_density_m3": 1e6, "n_macro": 2,
          "dt": 1e-16, "n_steps": 20, "frame_every": 5, "avg_steps": 5, "seed": 17,
          "left": {"v_dc": 0.0},
          "right": {"v_dc": -100.0, "fn": {"phi_ev": 4.5, "beta": 50.0, "macro_weight": 1e12}},
          "convergence": {"enabled": False}}
    cases = {}
    for name, settings, split in (("dc", base, 55), ("argon_rf", ar, 650),
                                  ("capacitor_see", capacitor, 450), ("fn", fn, 9)):
        def make(data):
            sim = Pic1dSimulation(project(Pic1dSettings.model_validate({**data, "parallel": False}).model_dump()))
            if name == "fn":
                for sp in sim.species.values():
                    sp.w = np.zeros_like(sp.w)
            return sim

        full = make(settings)
        frames = []
        full.run_batch(callback=frames.append, store_frames=False)
        result = build_pic1d_result(full, elapsed_s=0.0)
        result.pop("elapsed_s")
        result.pop("timing")
        frames = [{k: v for k, v in f.items() if k != "elapsed_s"} for f in frames]
        continued = make({**settings, "n_steps": split})
        continued.run_batch(store_frames=False)
        continued.prepare_continue(settings["n_steps"] - split, avg_steps=settings["avg_steps"])
        continued.run_batch(store_frames=False)
        # 総放出・総電離が正のことも確認し、空のケースで一致するだけの検証を避ける。
        active = {
            "electrons": len(full.species["electron"].x), "ions": len(full.species["ion"].x),
            "ionization_events": full.ion_events, "see_weight": full.see_events,
            "fn_events": sum(full.fn_events.values()),
        }
        cases[name] = {"result": normalize(result), "frames": normalize(frames),
                       "state": state(full), "continued_state": state(continued), "activity": active}

    dependencies = {}
    if probe_dependencies:
        # API を import しても、別ソルバー/2D/CAD 依存が入らないことを確かめる。
        importlib.import_module("es_sim.server")
        importlib.import_module("es_sim.lxcat")
        dependencies["forbidden_imports"] = sorted(
            m for m in sys.modules if any(m == prefix or m.startswith(prefix + ".") for prefix in FORBIDDEN_MODULES))
        dependencies["es_sim_modules"] = sorted(m for m in sys.modules if m.startswith("es_sim"))
    versions = {}
    for package in ("numpy", "scipy", "numba", "pydantic", "fastapi"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    output = {"cases": cases, "runtime": {"python": sys.version.split()[0], "packages": versions,
                                           "numba_enabled": _numba_kernels.HAVE_NUMBA,
                                           "core_path": str(importlib.import_module("es_sim.pic1d").__file__)},
              "dependencies": dependencies}
    print(MARKER + canonical(output).decode("utf-8"))


def run_worker(python: Path, backend: Path, probe: bool, cache: Path, timeout: int) -> dict:
    cmd = [str(python), "-B", str(Path(__file__).resolve()), "--worker", str(backend)]
    if probe:
        cmd.append("--probe-dependencies")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", NUMBA_CACHE_DIR=str(cache), PYTHONUTF8="1")
    proc = subprocess.run(cmd, cwd=backend, env=env, text=True, encoding="utf-8",
                          capture_output=True, timeout=timeout, check=False)
    if proc.returncode:
        raise RuntimeError(f"{python}: exit={proc.returncode}\n{proc.stderr[-6000:]}\n{proc.stdout[-2000:]}")
    payload = next((line[len(MARKER):] for line in reversed(proc.stdout.splitlines()) if line.startswith(MARKER)), None)
    if payload is None:
        raise RuntimeError(f"worker output missing: {proc.stdout[-2000:]} {proc.stderr[-2000:]}")
    return json.loads(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", type=Path, default=DEFAULT_ORIGINAL)
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / "extraction-regression.json")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--probe-dependencies", action="store_true")
    args = parser.parse_args()
    if args.worker:
        worker(args.worker, args.probe_dependencies)
        return 0
    started = time.perf_counter()
    old_backend = args.original / "backend"
    new_backend = ROOT / "backend"
    executable = "Scripts/python.exe" if os.name == "nt" else "bin/python"
    report = {"generated_at": datetime.now(timezone.utc).isoformat(),
              "original_backend": str(old_backend), "extracted_backend": str(new_backend),
              "comparison": "bit exact; sequential mode; original result fields/live frames and particle state/RNG/continuation; added diagnostics and elapsed_s/timing excluded",
              "passed": False}
    try:
        with tempfile.TemporaryDirectory(prefix="picora-regression-") as cache:
            old = run_worker(old_backend / ".venv" / executable, old_backend, False, Path(cache) / "old", args.timeout)
            new = run_worker(new_backend / ".venv" / executable, new_backend, True, Path(cache) / "new", args.timeout)
        report["runtimes"] = {"original": old["runtime"], "extracted": new["runtime"]}
        report["dependency_check"] = new["dependencies"]
        comparisons = {}
        for name, old_case in old["cases"].items():
            new_case = original_contract(new["cases"][name], old_case)
            diffs = difference(old_case, new_case)
            continuation_old = difference(old_case["state"], old_case["continued_state"])
            continuation_new = difference(new_case["state"], new_case["continued_state"])
            active = new_case["activity"]
            activity_passed = ((name != "argon_rf" or active["ionization_events"] > 0)
                               and (name != "capacitor_see" or active["see_weight"] > 0)
                               and (name != "fn" or active["fn_events"] > 0))
            comparisons[name] = {"passed": not diffs and not continuation_old and not continuation_new and activity_passed,
                                 "original_sha256": digest(old_case), "extracted_sha256": digest(new_case),
                                 "differences": diffs, "continuation_original": continuation_old,
                                 "continuation_extracted": continuation_new, "activity_passed": activity_passed,
                                 "activity": active}
        report["cases"] = comparisons
        report["passed"] = all(c["passed"] for c in comparisons.values()) and not new["dependencies"]["forbidden_imports"]
    except Exception as exc:
        report["error"] = str(exc)
    report["elapsed_s"] = time.perf_counter() - started
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "report": str(args.output),
                      "cases": {k: v["passed"] for k, v in report.get("cases", {}).items()},
                      "error": report.get("error")}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
