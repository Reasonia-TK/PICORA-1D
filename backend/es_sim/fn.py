"""1D-compatible Murphy-Good / Forbes field emission current density."""
import numpy as np

# FN 定数 (Forbes & Deane 2007 の標準値)
FN_A = 1.541434e-6   # [A eV V^-2]
FN_B = 6.830890e9    # [eV^-3/2 V m^-1]
FN_C = 1.439964e-9   # e/(4πε0) [V m] — Schottky 障壁低下比 f = c F / φ²


def fn_current_density(f_surf: np.ndarray, phi_ev: float, beta: float = 1.0) -> np.ndarray:
    """表面幾何電界 F [V/m] (≤0 は放出なし) から FN 電流密度 J [A/m²] を返す。

    ベクトル化されており、F ≤ 0 の要素は J = 0。f = cβF/φ² は 1 でクリップする
    (f ≥ 1 は障壁が完全に消えた極限。v(1) = 0 で指数項が 1 になる)。
    """
    f_local = beta * np.asarray(f_surf, dtype=np.float64)
    j = np.zeros_like(f_local)
    pos = f_local > 0.0
    if not np.any(pos):
        return j
    fp = f_local[pos]
    f = np.minimum(FN_C * fp / (phi_ev * phi_ev), 1.0)
    lnf = np.log(f)  # fp > 0 なので f > 0
    v = 1.0 - f + (f / 6.0) * lnf
    t = 1.0 + f / 9.0 - (f / 18.0) * lnf
    j[pos] = (
        FN_A * fp * fp / (phi_ev * t * t)
        * np.exp(-FN_B * phi_ev**1.5 * v / fp)
    )
    return j
