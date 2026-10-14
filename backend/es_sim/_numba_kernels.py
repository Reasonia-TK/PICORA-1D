"""Optional Numba acceleration for MCC only (extracted from ES-Sim)."""
from __future__ import annotations
import os
import numpy as np
HAVE_NUMBA = False
try:
    if os.environ.get("PICORA_NO_NUMBA", os.environ.get("ES_SIM_NO_NUMBA")) == "1":
        raise ImportError("Numba disabled")
    import numba
    from numba import njit, prange
    HAVE_NUMBA = True
except ImportError:
    numba = None
_MCC_PARALLEL_MIN_CANDIDATES = 32_768

if HAVE_NUMBA:
    @njit(cache=True, nogil=True)
    def _interp_packed_table(x, xs, ys, n):
        """np.interp と同じ端点クランプ・右側探索で1点を線形補間する。

        prompts/83①でlog10(E)等間隔グリッド+O(1)参照を試したが、本リポジトリの
        断面積テーブル規模 (数十〜百点程度) では二分探索のほうが実測で速かった
        ため不採用・撤去し、この二分探索実装に戻した。
        """
        if x < xs[0]:
            return ys[0]
        if x >= xs[n - 1]:
            return ys[n - 1]
        # searchsorted(..., side="right") 相当。重複xがある場合も右側を選ぶ。
        lo = 0
        hi = n
        while lo < hi:
            mid = (lo + hi) // 2
            if x < xs[mid]:
                hi = mid
            else:
                lo = mid + 1
        right = lo
        left = right - 1
        dx = xs[right] - xs[left]
        if dx == 0.0:
            return ys[right]
        return ys[left] + (x - xs[left]) * (ys[right] - ys[left]) / dx

    @njit(cache=True, nogil=True)
    def _mcc_choose_process_kernel(
        e_ev, speed, numax, n_ref, rel, use_rel, e_table, s_table, lengths, random_u
    ):
        """候補ごとの断面積補間と累積頻度選択を一時2D配列なしで行う。"""
        n = e_ev.shape[0]
        n_procs = lengths.shape[0]
        out = np.full(n, -1, dtype=np.int64)
        for i in range(n):
            density_scale = rel[i] if use_rel else 1.0
            # 分母はセル別 ν_max,c = numax·density_scale (非一様ガス場、
            # prompts/83②)。一様ガスは density_scale=1.0 でno-op (ビット一致)。
            target = random_u[i] * numax * density_scale
            cumulative = 0.0
            for j in range(n_procs):
                sigma = _interp_packed_table(
                    e_ev[i], e_table[j], s_table[j], lengths[j]
                )
                # numpy経路の (n_ref * sigma * speed) * rel と演算順を揃える。
                nu_j = (n_ref * sigma * speed[i]) * density_scale
                cumulative += nu_j
                if target < cumulative:
                    out[i] = j
                    break
        return out

    @njit(inline="always")
    def _mcc_select_velocity_one(
        v,
        cand,
        energy_scale,
        charge_ev,
        numax,
        n_ref,
        rel_elem,
        elem,
        use_rel,
        e_table,
        s_table,
        lengths,
        random_u,
        out_proc,
        out_energy,
        out_speed,
        k,
    ):
        """候補1粒子の速度・エネルギー評価とプロセス選択を行う。"""
        n_procs = lengths.shape[0]
        i = cand[k]
        v0 = v[i, 0]
        v1 = v[i, 1]
        v2 = v[i, 2]
        speed2 = (v0 * v0 + v1 * v1) + v2 * v2
        speed = np.sqrt(speed2)
        e_ev = (energy_scale * speed * speed) / charge_ev
        out_speed[k] = speed
        out_energy[k] = e_ev

        density_scale = rel_elem[elem[i]] if use_rel else 1.0
        # 分母はセル別 ν_max,c = numax·density_scale (prompts/83②、_candidates
        # のセル別抽選と揃える。一様ガスは density_scale=1.0 でビット一致)。
        target = random_u[k] * numax * density_scale
        cumulative = 0.0
        selected = -1
        for j in range(n_procs):
            sigma = _interp_packed_table(
                e_ev, e_table[j], s_table[j], lengths[j]
            )
            cumulative += (n_ref * sigma * speed) * density_scale
            if target < cumulative:
                selected = j
                break
        out_proc[k] = selected

    @njit(cache=True, nogil=True)
    def _mcc_select_velocity_kernel(
        v,
        cand,
        energy_scale,
        charge_ev,
        numax,
        n_ref,
        rel_elem,
        elem,
        use_rel,
        e_table,
        s_table,
        lengths,
        random_u,
        out_proc,
        out_energy,
        out_speed,
    ):
        """小～中規模候補をスレッド起動なしの1ループで選択する。"""
        n = cand.shape[0]
        for k in range(n):
            _mcc_select_velocity_one(
                v,
                cand,
                energy_scale,
                charge_ev,
                numax,
                n_ref,
                rel_elem,
                elem,
                use_rel,
                e_table,
                s_table,
                lengths,
                random_u,
                out_proc,
                out_energy,
                out_speed,
                k,
            )

    @njit(cache=True, nogil=True, parallel=True)
    def _mcc_select_velocity_parallel_kernel(
        v,
        cand,
        energy_scale,
        charge_ev,
        numax,
        n_ref,
        rel_elem,
        elem,
        use_rel,
        e_table,
        s_table,
        lengths,
        random_u,
        out_proc,
        out_energy,
        out_speed,
    ):
        """大規模候補を粒子ごとに独立なprangeで選択する。"""
        for k in prange(cand.shape[0]):
            _mcc_select_velocity_one(
                v,
                cand,
                energy_scale,
                charge_ev,
                numax,
                n_ref,
                rel_elem,
                elem,
                use_rel,
                e_table,
                s_table,
                lengths,
                random_u,
                out_proc,
                out_energy,
                out_speed,
                k,
            )

    @njit(cache=True, nogil=True)
    def _mcc_group_process_positions_kernel(
        proc_idx, energy, thresholds, use_threshold,
    ):
        """実衝突候補位置をプロセス別・元順序の連続領域へまとめる。"""
        n_procs = thresholds.shape[0]
        counts = np.zeros(n_procs, dtype=np.int64)
        for k in range(proc_idx.shape[0]):
            j = proc_idx[k]
            if j < 0:
                continue
            if use_threshold[j] and energy[k] < thresholds[j]:
                continue
            counts[j] += 1

        offsets = np.empty(n_procs + 1, dtype=np.int64)
        offsets[0] = 0
        for j in range(n_procs):
            offsets[j + 1] = offsets[j] + counts[j]
        positions = np.empty(offsets[n_procs], dtype=np.int64)
        cursor = offsets[:-1].copy()
        for k in range(proc_idx.shape[0]):
            j = proc_idx[k]
            if j < 0:
                continue
            if use_threshold[j] and energy[k] < thresholds[j]:
                continue
            positions[cursor[j]] = k
            cursor[j] += 1
        return positions, offsets

    @njit(cache=True, nogil=True)
    def _mcc_scatter_electrons_kernel(
        v,
        cand,
        selected,
        e_ev,
        speed,
        direction,
        kind,
        threshold_ev,
        mass_ratio,
        scatter_energy,
        charge_ev,
        electron_mass,
    ):
        """選択済み電子衝突の速度更新をin-placeで行う。"""
        n = selected.shape[0]
        for k in range(n):
            pos = selected[k]
            i = cand[pos]
            d0 = direction[k, 0]
            d1 = direction[k, 1]
            d2 = direction[k, 2]
            if kind == 0:  # elastic
                cos_chi = (
                    (v[i, 0] / speed[pos]) * d0
                    + (v[i, 1] / speed[pos]) * d1
                ) + (v[i, 2] / speed[pos]) * d2
                e_new = e_ev[pos] * (
                    1.0 - 2.0 * mass_ratio * (1.0 - cos_chi)
                )
                if e_new < 0.0:
                    e_new = 0.0
            elif kind == 1:  # excitation
                e_new = e_ev[pos] - threshold_ev
            else:  # ionization
                e_new = scatter_energy[k]
            speed_new = np.sqrt(2.0 * e_new * charge_ev / electron_mass)
            v[i, 0] = speed_new * d0
            v[i, 1] = speed_new * d1
            v[i, 2] = speed_new * d2

    @njit(cache=True, nogil=True)
    def _mcc_scatter_ions_kernel(
        v, cand, selected, vi, vg, g_mag, direction, backscat
    ):
        """選択済みイオン衝突の速度更新をin-placeで行う。"""
        n = selected.shape[0]
        for k in range(n):
            pos = selected[k]
            i = cand[pos]
            if backscat:
                v[i, 0] = vg[pos, 0]
                v[i, 1] = vg[pos, 1]
                v[i, 2] = vg[pos, 2]
            else:
                half_g = 0.5 * g_mag[pos]
                v[i, 0] = (
                    0.5 * (vi[pos, 0] + vg[pos, 0])
                    + half_g * direction[k, 0]
                )
                v[i, 1] = (
                    0.5 * (vi[pos, 1] + vg[pos, 1])
                    + half_g * direction[k, 1]
                )
                v[i, 2] = (
                    0.5 * (vi[pos, 2] + vg[pos, 2])
                    + half_g * direction[k, 2]
                )

    @njit(cache=True, nogil=True)
    def _mcc_iso_dir_kernel(random_cos, random_phi, out):
        """NumPy版と同じ演算順で3D等方方向を構築する。"""
        n = random_cos.shape[0]
        for i in range(n):
            cos_t = 1.0 - 2.0 * random_cos[i]
            sin2 = 1.0 - cos_t * cos_t
            if sin2 < 0.0:
                sin2 = 0.0
            sin_t = np.sqrt(sin2)
            phi = random_phi[i] * (2.0 * np.pi)
            out[i, 0] = sin_t * np.cos(phi)
            out[i, 1] = sin_t * np.sin(phi)
            out[i, 2] = cos_t

    @njit(cache=True, nogil=True)
    def _mcc_candidates_kernel(random_u, probability):
        """候補マスクを作らず、採択インデックスを連続配列へ詰める。"""
        count = 0
        for i in range(random_u.shape[0]):
            if random_u[i] < probability:
                count += 1
        out = np.empty(count, dtype=np.int64)
        pos = 0
        for i in range(random_u.shape[0]):
            if random_u[i] < probability:
                out[pos] = i
                pos += 1
        return out

    @njit(cache=True, nogil=True)
    def _mcc_candidates_cellwise_kernel(random_u, p_coll_elem, elem):
        """要素別候補確率 (prompts/83②、非一様ガス場) で候補を選ぶ。

        p_coll_elem は呼び出し側で1回だけ計算済み (numpyのexpをここで
        再評価するとnumpy/numba等価性が崩れうるため、gather+比較のみ行う)。
        """
        n = random_u.shape[0]
        count = 0
        for i in range(n):
            if random_u[i] < p_coll_elem[elem[i]]:
                count += 1
        out = np.empty(count, dtype=np.int64)
        pos = 0
        for i in range(n):
            if random_u[i] < p_coll_elem[elem[i]]:
                out[pos] = i
                pos += 1
        return out

    @njit(cache=True, nogil=True)
    def _mcc_max_speed_squared_kernel(v):
        """3速度成分の二乗和の最大値を一時配列なしで求める。"""
        maximum = 0.0
        for i in range(v.shape[0]):
            speed2 = (
                v[i, 0] * v[i, 0] + v[i, 1] * v[i, 1]
            ) + v[i, 2] * v[i, 2]
            # np.maxと同じく、入力にNaNがあればNaNを返す。
            if np.isnan(speed2):
                return speed2
            if speed2 > maximum:
                maximum = speed2
        return maximum



def mcc_choose_process(
    e_ev: np.ndarray,
    speed: np.ndarray,
    numax: float,
    n_ref: float,
    rel: np.ndarray | None,
    e_table: np.ndarray,
    s_table: np.ndarray,
    lengths: np.ndarray,
    random_u: np.ndarray,
) -> np.ndarray:
    """MCC候補の実プロセス番号を返す (-1=null)。

    乱数は呼び出し側のnumpy Generatorで従来と同じ順に生成して渡す。ここでは
    候補×プロセスのnu/cumsum行列を作らず、候補ごとの小さな逐次ループで選ぶ。
    """
    rel_arr = np.empty(0, dtype=np.float64) if rel is None else np.ascontiguousarray(rel)
    return _mcc_choose_process_kernel(
        np.ascontiguousarray(e_ev),
        np.ascontiguousarray(speed),
        float(numax),
        float(n_ref),
        rel_arr,
        rel is not None,
        np.ascontiguousarray(e_table),
        np.ascontiguousarray(s_table),
        np.ascontiguousarray(lengths),
        np.ascontiguousarray(random_u),
    )


def mcc_select_velocity(
    v: np.ndarray,
    cand: np.ndarray,
    m: float,
    charge_ev: float,
    numax: float,
    n_ref: float,
    rel_elem: np.ndarray | None,
    elem: np.ndarray | None,
    e_table: np.ndarray,
    s_table: np.ndarray,
    lengths: np.ndarray,
    random_u: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """候補粒子の速度からプロセス・エネルギー・速さを一括算出する。"""
    n = len(cand)
    proc = np.empty(n, dtype=np.int64)
    energy = np.empty(n, dtype=np.float64)
    speed = np.empty(n, dtype=np.float64)
    use_rel = rel_elem is not None and elem is not None
    rel_arr = np.empty(0, dtype=np.float64) if rel_elem is None else rel_elem
    elem_arr = np.empty(0, dtype=np.int64) if elem is None else elem
    kernel = (
        _mcc_select_velocity_parallel_kernel
        if n >= _MCC_PARALLEL_MIN_CANDIDATES and numba.get_num_threads() > 1
        else _mcc_select_velocity_kernel
    )
    kernel(
        np.ascontiguousarray(v),
        np.ascontiguousarray(cand),
        0.5 * float(m),
        float(charge_ev),
        float(numax),
        float(n_ref),
        np.ascontiguousarray(rel_arr),
        np.ascontiguousarray(elem_arr),
        use_rel,
        np.ascontiguousarray(e_table),
        np.ascontiguousarray(s_table),
        np.ascontiguousarray(lengths),
        np.ascontiguousarray(random_u),
        proc,
        energy,
        speed,
    )
    return proc, energy, speed


def mcc_candidates_cellwise(
    random_u: np.ndarray, p_coll_elem: np.ndarray, elem: np.ndarray
) -> np.ndarray:
    """非一様ガス場でのnull-collision候補インデックスを返す (prompts/83②)。

    p_coll_elem は要素ごとの候補確率 (呼び出し側でnumpyにより1回だけ計算済み)。
    ここでは候補マスクを作らず、gather + 比較だけを行う。
    """
    return _mcc_candidates_cellwise_kernel(
        np.ascontiguousarray(random_u),
        np.ascontiguousarray(p_coll_elem),
        np.ascontiguousarray(elem),
    )


def mcc_scatter_electrons(
    v: np.ndarray,
    cand: np.ndarray,
    selected: np.ndarray,
    e_ev: np.ndarray,
    speed: np.ndarray,
    direction: np.ndarray,
    kind: int,
    threshold_ev: float,
    mass_ratio: float,
    scatter_energy: np.ndarray | None,
    charge_ev: float,
    electron_mass: float,
) -> None:
    """選択・乱数生成後の電子散乱計算をJITでin-place更新する。"""
    scatter_arr = (
        np.empty(0, dtype=np.float64)
        if scatter_energy is None
        else np.ascontiguousarray(scatter_energy)
    )
    _mcc_scatter_electrons_kernel(
        v,
        np.ascontiguousarray(cand),
        np.ascontiguousarray(selected),
        np.ascontiguousarray(e_ev),
        np.ascontiguousarray(speed),
        np.ascontiguousarray(direction),
        int(kind),
        float(threshold_ev),
        float(mass_ratio),
        scatter_arr,
        float(charge_ev),
        float(electron_mass),
    )


def mcc_scatter_ions(
    v: np.ndarray,
    cand: np.ndarray,
    selected: np.ndarray,
    vi: np.ndarray,
    vg: np.ndarray,
    g_mag: np.ndarray,
    direction: np.ndarray | None,
    backscat: bool,
) -> None:
    """選択・乱数生成後のイオン散乱計算をJITでin-place更新する。"""
    direction_arr = (
        np.empty((0, 3), dtype=np.float64)
        if direction is None
        else np.ascontiguousarray(direction)
    )
    _mcc_scatter_ions_kernel(
        v,
        np.ascontiguousarray(cand),
        np.ascontiguousarray(selected),
        np.ascontiguousarray(vi),
        np.ascontiguousarray(vg),
        np.ascontiguousarray(g_mag),
        direction_arr,
        bool(backscat),
    )


def mcc_iso_dir(random_cos: np.ndarray, random_phi: np.ndarray) -> np.ndarray:
    """一様乱数2列から3D等方単位方向を構築する。"""
    out = np.empty((len(random_cos), 3), dtype=np.float64)
    _mcc_iso_dir_kernel(
        np.ascontiguousarray(random_cos),
        np.ascontiguousarray(random_phi),
        out,
    )
    return out


def mcc_group_process_positions(
    proc_idx: np.ndarray,
    energy: np.ndarray,
    thresholds: np.ndarray,
    use_threshold: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """実衝突候補の位置をプロセス別に安定順序でまとめる。"""
    return _mcc_group_process_positions_kernel(
        np.ascontiguousarray(proc_idx),
        np.ascontiguousarray(energy),
        np.ascontiguousarray(thresholds),
        np.ascontiguousarray(use_threshold),
    )


def mcc_candidates(random_u: np.ndarray, probability: float) -> np.ndarray:
    """null-collision候補インデックスを一時bool配列なしで返す。"""
    return _mcc_candidates_kernel(
        np.ascontiguousarray(random_u),
        float(probability),
    )


def mcc_max_speed_squared(v: np.ndarray) -> float:
    """粒子群の max(vx²+vy²+vz²) を一時配列なしで返す。"""
    return float(_mcc_max_speed_squared_kernel(np.ascontiguousarray(v)))

