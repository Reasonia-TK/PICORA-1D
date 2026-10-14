"""PICのCPUカーネル。CIC散布はチャンク専用配列で加算競合を避ける。

乱数を消費せず、fastmathは使用しない。チャンクと縮約順序をスレッド数から
独立に固定するので、並列モード内ではスレッド数を変えても結果が一致する。
逐次モードとNumbaなしの経路は、元のNumPy演算を保持する。
"""
from __future__ import annotations

import math
import os

import numpy as np

from ._numba_kernels import HAVE_NUMBA, numba

PARALLEL_MIN_PARTICLES = 4_096
CHUNK_PARTICLES = 4_096
MAX_CHUNKS = 64
MAX_SCRATCH_ELEMENTS = 2_000_000  # 最大16MB/呼び出し


def environment_info() -> dict:
    """UIのCPU数設定に用いる、この実行環境の上限。"""
    available = int(numba.config.NUMBA_NUM_THREADS) if HAVE_NUMBA else 1
    return {
        "available": HAVE_NUMBA,
        "backend": "numba" if HAVE_NUMBA else "numpy",
        "max_threads": available,
        "auto_threads": min(4, available, os.cpu_count() or 1),
    }


def _numpy_index(x: np.ndarray, dx: float, n_cells: int):
    idx = np.clip(np.floor(x / dx).astype(np.int64), 0, n_cells - 1)
    return idx, np.clip(x / dx - idx, 0.0, 1.0)


def _numpy_deposit(x, values, dx, n_nodes):
    idx, frac = _numpy_index(x, dx, n_nodes - 1)
    out = np.bincount(idx, weights=values * (1.0 - frac), minlength=n_nodes)
    out += np.bincount(idx + 1, weights=values * frac, minlength=n_nodes)
    return out


if HAVE_NUMBA:
    njit, prange = numba.njit, numba.prange

    @njit(cache=True, inline="always")
    def _index(position, dx, n_cells):
        scaled = position / dx
        idx = min(max(int(math.floor(scaled)), 0), n_cells - 1)
        frac = min(max(scaled - idx, 0.0), 1.0)
        return idx, frac

    @njit(cache=True, nogil=True)
    def _deposit_serial(x, values, dx, n_nodes):
        # 左寄与/右寄与を分離して、元の2回のbincountと同じ加算順序にする。
        left = np.zeros(n_nodes)
        right = np.zeros(n_nodes)
        for p in range(len(x)):
            i, f = _index(x[p], dx, n_nodes - 1)
            left[i] += values[p] * (1.0 - f)
            right[i + 1] += values[p] * f
        return left + right

    @njit(cache=True, nogil=True, parallel=True)
    def _deposit_parallel(x, values, dx, n_nodes, n_chunks):
        left = np.zeros((n_chunks, n_nodes))
        right = np.zeros((n_chunks, n_nodes))
        # 同じ節点へ粒子が集まっても、各chunkは専用行だけを書き換える。
        for chunk in prange(n_chunks):
            start = len(x) * chunk // n_chunks
            end = len(x) * (chunk + 1) // n_chunks
            for p in range(start, end):
                i, f = _index(x[p], dx, n_nodes - 1)
                left[chunk, i] += values[p] * (1.0 - f)
                right[chunk, i + 1] += values[p] * f
        out = np.zeros(n_nodes)
        for node in prange(n_nodes):
            sum_left = 0.0
            sum_right = 0.0
            for chunk in range(n_chunks):
                sum_left += left[chunk, node]
                sum_right += right[chunk, node]
            out[node] = sum_left + sum_right
        return out

    @njit(cache=True, nogil=True)
    def _gather_serial(nodes, x, dx, n_cells):
        out = np.empty(len(x))
        for p in range(len(x)):
            i, f = _index(x[p], dx, n_cells)
            out[p] = (1.0 - f) * nodes[i] + f * nodes[i + 1]
        return out

    @njit(cache=True, nogil=True, parallel=True)
    def _gather_parallel(nodes, x, dx, n_cells):
        out = np.empty(len(x))
        for p in prange(len(x)):
            i, f = _index(x[p], dx, n_cells)
            out[p] = (1.0 - f) * nodes[i] + f * nodes[i + 1]
        return out

    @njit(cache=True, nogil=True)
    def _push_serial(x, v, nodes, dx, n_cells, dt, qm):
        out = np.empty(len(x))
        for p in range(len(x)):
            i, f = _index(x[p], dx, n_cells)
            e = (1.0 - f) * nodes[i] + f * nodes[i + 1]
            v[p, 0] += qm * e * dt
            out[p] = x[p] + v[p, 0] * dt
        return out

    @njit(cache=True, nogil=True, parallel=True)
    def _push_parallel(x, v, nodes, dx, n_cells, dt, qm):
        out = np.empty(len(x))
        for p in prange(len(x)):
            i, f = _index(x[p], dx, n_cells)
            e = (1.0 - f) * nodes[i] + f * nodes[i + 1]
            v[p, 0] += qm * e * dt
            out[p] = x[p] + v[p, 0] * dt
        return out

    @njit(cache=True, nogil=True, parallel=True)
    def _moments_parallel(x, v, w, dx, n_nodes, n_chunks):
        accum = np.zeros((n_chunks, 7, n_nodes))
        for chunk in prange(n_chunks):
            start = len(x) * chunk // n_chunks
            end = len(x) * (chunk + 1) // n_chunks
            for p in range(start, end):
                i, f = _index(x[p], dx, n_nodes - 1)
                wl = w[p] * (1.0 - f)
                wr = w[p] * f
                accum[chunk, 0, i] += wl
                accum[chunk, 0, i + 1] += wr
                for component in range(3):
                    velocity = v[p, component]
                    accum[chunk, component + 1, i] += wl * velocity
                    accum[chunk, component + 1, i + 1] += wr * velocity
                    accum[chunk, component + 4, i] += wl * velocity * velocity
                    accum[chunk, component + 4, i + 1] += wr * velocity * velocity
        out = np.zeros((7, n_nodes))
        for row in prange(7):
            for node in range(n_nodes):
                for chunk in range(n_chunks):
                    out[row, node] += accum[chunk, row, node]
        return out


class ParticleKernels:
    """1つの計算が使うCPU設定と演算経路。workerごとにthread maskを適用する。"""

    def __init__(self, parallel: bool = True, cpu_threads: int | None = None):
        info = environment_info()
        self.requested_parallel = parallel
        self.enabled = bool(parallel and HAVE_NUMBA)
        self.max_threads = info["max_threads"]
        self.threads = min(cpu_threads or info["auto_threads"], self.max_threads) if self.enabled else 1
        self.fallback_reason = "Numbaが利用できないためNumPy逐次計算" if parallel and not HAVE_NUMBA else None
        self._activate_threads()

    def metadata(self) -> dict:
        return {
            "requested_parallel": self.requested_parallel,
            "enabled": self.enabled,
            "threads": self.threads,
            "max_threads": self.max_threads,
            "backend": "numba" if self.enabled else "numpy",
            "parallel_min_particles": PARALLEL_MIN_PARTICLES,
            "fallback_reason": self.fallback_reason,
        }

    def _activate_threads(self):
        if HAVE_NUMBA and numba.get_num_threads() != self.threads:
            numba.set_num_threads(self.threads)

    def _parallel(self, n):
        return self.enabled and self.threads > 1 and n >= PARALLEL_MIN_PARTICLES

    def _chunks(self, n, n_nodes, rows):
        return min(MAX_CHUNKS, max(1, math.ceil(n / CHUNK_PARTICLES)),
                   max(1, MAX_SCRATCH_ELEMENTS // (rows * n_nodes)))

    def deposit(self, x, values, dx, n_nodes):
        self._activate_threads()
        if not self.enabled:
            return _numpy_deposit(x, values, dx, n_nodes)
        chunks = self._chunks(len(x), n_nodes, 2)
        if self._parallel(len(x)) and chunks > 1:
            return _deposit_parallel(x, values, dx, n_nodes, chunks)
        return _deposit_serial(x, values, dx, n_nodes)

    def gather(self, nodes, x, dx, n_cells):
        self._activate_threads()
        if not self.enabled:
            i, f = _numpy_index(x, dx, n_cells)
            return (1.0 - f) * nodes[i] + f * nodes[i + 1]
        kernel = _gather_parallel if self._parallel(len(x)) else _gather_serial
        return kernel(nodes, x, dx, n_cells)

    def push(self, x, v, nodes, dx, n_cells, dt, qm):
        """v[:,0]を更新してx_newを返す。元のxは境界処理まで保持する。"""
        self._activate_threads()
        if not self.enabled:
            e = self.gather(nodes, x, dx, n_cells)
            v[:, 0] += qm * e * dt
            return x + v[:, 0] * dt
        kernel = _push_parallel if self._parallel(len(x)) else _push_serial
        return kernel(x, v, nodes, dx, n_cells, dt, qm)

    def moments(self, x, v, w, dx, n_nodes):
        self._activate_threads()
        if self.enabled and self._parallel(len(x)):
            return _moments_parallel(x, v, w, dx, n_nodes, self._chunks(len(x), n_nodes, 7))
        # 種ごと・平均区間ごとの診断なので、少数粒子にはNumPyが適する。
        values = [w, *(w * v[:, k] for k in range(3)),
                  *(w * v[:, k] ** 2 for k in range(3))]
        return np.stack([_numpy_deposit(x, value, dx, n_nodes) for value in values])
