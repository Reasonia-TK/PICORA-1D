"""RF components and periodic waveform interpolation, retained from ES-Sim."""
import math
import numpy as np
from .schema import VoltageRF

def _eval_waveform(phase, v, freq_hz: float, t):
    """CSV インポート波形 V_wf(t) の評価 (prompts/73)。単体テストから直接呼べるよう
    モジュール関数として切り出す (PicSimulation の初期化なしで検証できる)。

    phase は [0, 1) に正規化済みの位相 (昇順)、v は対応する電圧。実際の周期は
    freq_hz で決まり、時刻 t の位相は frac(t·freq_hz) (0〜1 を繰り返す)。
    末尾サンプルと先頭サンプルの間 (位相 phase[-1] 〜 1) が非連続にならないよう、
    phase 配列の末尾に仮想的に (phase[0]+1, v[0]) を足してから線形補間する
    (= 1周期ループの折返しを連続にするため)。
    """
    phase = np.asarray(phase, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    frac = np.mod(np.asarray(t, dtype=np.float64) * freq_hz, 1.0)
    phase_ext = np.concatenate([phase, [phase[0] + 1.0]])
    v_ext = np.concatenate([v, [v[0]]])
    return np.interp(frac, phase_ext, v_ext)


def _eval_rf(components: "list[VoltageRF]", t: float) -> float:
    """RF 成分リストの和 V_rf(t) = Σ_k amplitude_k·sin(2π·freq_hz_k·t + phase_deg_k) を返す
    (prompts/93)。_dirichlet_values (2D、上記) の rf_amp * np.sin(rf_omega*t + rf_phase) と
    完全に同じ式・位相規約 (度→ラジアン変換は math.radians) をスカラー版として切り出し、
    1D (pic1d.py) の電極電圧評価と共有する。components が空なら 0.0 (寄与なし)。
    """
    v = 0.0
    for c in components:
        v += c.amplitude * math.sin(2.0 * math.pi * c.freq_hz * t + math.radians(c.phase_deg))
    return v
