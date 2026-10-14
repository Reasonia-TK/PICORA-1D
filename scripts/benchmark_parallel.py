"""ウォームアップ後の逐次/並列CPU速度を比較しreportsへ保存する。"""
from __future__ import annotations

import json
import argparse
from pathlib import Path
import time

import numpy as np

from es_sim.parallel import ParticleKernels, environment_info
from es_sim.pic1d import Pic1dSimulation
from es_sim.schema import Pic1dSettings, Project


def timed(call, repeat=40):
    samples = []
    call()
    for _ in range(3):
        start = time.perf_counter()
        for _ in range(repeat):
            call()
        samples.append((time.perf_counter() - start) / repeat)
    return min(samples)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kernels-only", action="store_true")
    args = parser.parse_args()
    rng = np.random.default_rng(22)
    report = {"environment": environment_info(), "kernels": [], "simulation": []}
    for n in (5_000, 20_000, 200_000):
        x = rng.uniform(0, 0.025, n)
        values = rng.uniform(1, 10, n)
        nodes = rng.normal(0, 1e4, 129)
        v = rng.normal(0, 1e5, (n, 3))
        for threads in (None, 2, 4):
            seq = ParticleKernels(False)
            par = ParticleKernels(True, threads)
            ops = {
                "deposit": lambda k: k.deposit(x, values, 0.025 / 128, 129),
                "push": lambda k: k.push(x, v.copy(), nodes, 0.025 / 128, 128, 1e-11, -1.7588e11),
                "moments": lambda k: k.moments(x, v, values, 0.025 / 128, 129),
            }
            for name, op in ops.items():
                serial_s = timed(lambda: op(seq))
                parallel_s = timed(lambda: op(par))
                report["kernels"].append({"particles_per_species": n, "threads": par.threads,
                                           "op": name, "sequential_s": serial_s,
                                           "parallel_s": parallel_s, "speedup": serial_s / parallel_s})
        for parallel in (() if args.kernels_only else (False, True)):
            s = Pic1dSettings(gap_m=0.025, n_cells=128, init_density_m3=1e14,
                              n_macro=n, n_steps=100, dt=1e-11, frame_every=100,
                              avg_steps=25, parallel=parallel,
                              convergence={"enabled": False})
            # 一度同じ設定を実行して、JIT初回コンパイルを計測から外す。
            Pic1dSimulation(Project(pic1d=s)).run_batch(store_frames=False)
            sim = Pic1dSimulation(Project(pic1d=s))
            start = time.perf_counter()
            sim.run_batch(store_frames=False)
            report["simulation"].append({"particles_per_species": n, "parallel": parallel,
                                          "elapsed_s": time.perf_counter() - start,
                                          "timing": sim.timing})
    output = Path(__file__).resolve().parents[1] / "reports" / "parallel-benchmark.json"
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
