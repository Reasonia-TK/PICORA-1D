"""1D-only project schema. Legacy ES-Sim geometry and other solvers are ignored."""
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .external_circuit_schema import ExternalCircuitSettings

class Model(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)



def ui(unit: str | None = None, *, geom: bool = False, advanced: bool = False) -> dict:
    """UI v2 の設定フォームへの追記 (JSON Schema の x-unit / x-geom / x-advanced、prompts/130)。

    unit は保存値の単位 (SI、"1" は無次元)。geom=True の長さ・座標はプロジェクトの長さの表示単位
    (mm / µm) で入出力する。advanced=True は「詳細設定」を開いたときだけ出す項目。
    """
    extra: dict = {}
    if unit is not None:
        extra["x-unit"] = unit
    if geom:
        extra["x-geom"] = True
    if advanced:
        extra["x-advanced"] = True
    return extra


GEOM = ui("m", geom=True)

class VoltageRF(Model):
    """RF 電圧成分 (フェーズ3)。V(t) = voltage + Σ_k amplitude_k * sin(2π f_k t + phase_k)。

    voltage_rf フィールドには単一成分 (VoltageRF) と成分リスト (list[VoltageRF]、
    デュアル周波数など) のどちらも指定できる (prompts/49)。
    静電ソルブ (/solve) は従来通り直流分 voltage のみを使い、PIC のみが V(t) を使う。
    """

    amplitude: float = Field(..., json_schema_extra=ui("V"))
    freq_hz: float = Field(..., gt=0, json_schema_extra=ui("Hz"))
    phase_deg: float = Field(0.0, json_schema_extra=ui("deg"))


def rf_components(rf: "VoltageRF | list[VoltageRF] | None") -> "list[VoltageRF]":
    """voltage_rf フィールド (単一 / リスト / None) を成分リストへ正規化する。"""
    if rf is None:
        return []
    if isinstance(rf, VoltageRF):
        return [rf]
    return list(rf)


class VoltageWaveform(Model):
    """CSV からインポートした任意周期波形 (prompts/73)。

    CSV の時間列は波形の「形状」を定義するためだけに使い、実際の周期は
    freq_hz (ユーザー指定) で決まる。取り込み時にフロント側で時間 t を
    [t_min, t_max] → [0, 1) へ線形写像した正規化位相として保存するため、
    ここでは phase を昇順・[0,1) の範囲としてのみ検証する。
    評価は V_wf(t) = interp(frac(t·freq_hz), phase, v) (pic.py 参照)。
    voltage_rf と同じく静電ソルブでは無視され、PIC のみが使う。
    """

    freq_hz: float = Field(..., gt=0, json_schema_extra=ui("Hz"))
    phase: list[float] = Field(..., json_schema_extra=ui("1"))  # 正規化位相 [0, 1) (昇順)
    v: list[float] = Field(..., json_schema_extra=ui("V"))       # 対応する電圧 [V]

    @model_validator(mode="after")
    def _check_phase(self) -> "VoltageWaveform":
        if len(self.phase) != len(self.v):
            raise ValueError("VoltageWaveform: phase と v は同じ長さが必要です")
        if len(self.phase) < 2:
            raise ValueError("VoltageWaveform: phase/v は2点以上必要です")
        if any(p < 0.0 or p >= 1.0 for p in self.phase):
            raise ValueError("VoltageWaveform: phase は [0, 1) の範囲である必要があります")
        if any(a >= b for a, b in zip(self.phase, self.phase[1:])):
            raise ValueError("VoltageWaveform: phase は狭義昇順である必要があります")
        return self


class BlockingCapacitor1d(Model):
    """1D の電極の阻止コンデンサ (BlockingCapacitor と同じ、容量は面積あたり)。流体 1D・PIC 1D が使う。"""

    capacitance: float = Field(..., gt=0, description="面積あたりの容量", json_schema_extra=ui("F/m^2"))
    initial_bias_v: float = Field(
        0.0, description="コンデンサの初期電圧 (電極の電位 − 電源の電圧)", json_schema_extra=ui("V")
    )


class XsProcess(Model):
    """LXCat 由来の衝突断面積プロセス (パース済み、プロジェクト JSON に埋め込む)。"""

    kind: Literal["elastic", "excitation", "ionization", "isotropic", "backscat"]
    label: str = ""                # PROCESS 行等から
    threshold_ev: float = Field(0.0, json_schema_extra=ui("eV"))  # excitation/ionization のみ >0
    mass_ratio: float = Field(0.0, json_schema_extra=ui("1"))     # elastic のみ (m/M)。無ければ 0
    energy_ev: list[float] = Field(..., json_schema_extra=ui("eV"))   # 断面積テーブルのエネルギー [eV] (昇順)
    sigma_m2: list[float] = Field(..., json_schema_extra=ui("m^2"))   # 断面積 [m^2] (energy_ev と同長)

    @model_validator(mode="after")
    def _check_table(self) -> "XsProcess":
        if len(self.energy_ev) != len(self.sigma_m2):
            raise ValueError("energy_ev と sigma_m2 は同じ長さが必要です")
        if len(self.energy_ev) == 0:
            raise ValueError("断面積テーブルが空です")
        return self


class MccGas(Model):
    """背景中性ガスの状態。数密度は n_g = p/(kB·T) で決まる。"""

    name: str = "Ar"
    pressure_pa: float = Field(..., gt=0, description="ガス圧 [Pa]", json_schema_extra=ui("Pa"))
    temperature_k: float = Field(300.0, gt=0, description="ガス温度 [K]", json_schema_extra=ui("K"))


class MccSettings(Model):
    """MCC 設定。null なら MCC 無効 (従来の無衝突動作)。"""

    gas: MccGas
    electron_processes: list[XsProcess] = []  # elastic/excitation/ionization
    ion_processes: list[XsProcess] = []       # isotropic/backscat
    seed: int = Field(0, json_schema_extra=ui(advanced=True))
    # 電離の余剰エネルギー分配: "half" = 散乱電子と生成電子で等分 (Turner ベンチマーク互換)、
    # "random" = 一様乱数比で分配 (従来動作)
    ionization_split: Literal["half", "random"] = "half"
    # イオン断面積テーブルの参照エネルギー系: "lab" = 実験室系イオンエネルギー (従来動作)、
    # "com" = 重心系エネルギー E = ½μg² (μ = m_i·m_g/(m_i+m_g)、Turner の He+/He データ用)
    ion_energy_frame: Literal["com", "lab"] = "lab"
    # true なら直前に実行した DSMC の定常ガス場 (n·T·u) を背景として使う (prompts/54)。
    # サーバーが保持する DSMC 結果とメッシュが一致している必要がある
    use_dsmc_gas: bool = False


class ConvergenceSettings(Model):
    """時間発展の収束の判定 (prompts/137、convergence.py)。

    周期平均 (RF の最低周波数の周期の整数倍、RF が無ければ steps ステップ) の φ・n_e (粗いブロックの体積平均、
    L2) と電子・イオンの総数・阻止コンデンサの自己バイアスを比べる。雑音を差し引いた変化 D と、変化の減り方から
    見積もった残りの変化 R がどの量でも閾値以下の周期が hold 回続いたら収束とする。PIC の量は長い履歴の後半の
    回帰で傾きを検定し、見逃しうる遅い傾き (分解能) も閾値以下になるまで合格にしない (CV-d)。
    """

    enabled: bool = Field(True, description="周期平均の量が落ち着いたか (収束) を判定する")
    tol: float | None = Field(
        None, gt=0, lt=1, description="閾値 (相対)。空なら自動 (流体 0.001・PIC 0.01)", json_schema_extra=ui("1")
    )
    rf_periods: int = Field(1, ge=1, le=10000, description="判定の周期 (RF の最低周波数の周期の何個分)")
    steps: int | None = Field(
        None, ge=1, description="RF も CSV 波形も無いときの判定の周期 [ステップ]。空なら frame_every の 10 倍"
    )
    hold: int = Field(3, ge=1, le=1000, description="何回続けて満たしたら収束とするか")
    stop: bool = Field(
        False, description="収束したら、そこから平均区間 (avg_steps、空なら判定の周期 10 個分) を取って止める"
    )
    max_window: int = Field(
        20, ge=1, le=200, description="比べる窓の最大 [判定の周期] (雑音が大きいときに広げる上限)",
        json_schema_extra=ui(advanced=True),
    )


class Fn1dEmission(Model):
    """1D 電極の FN (Fowler–Nordheim) 電界放出 (prompts/95)。

    2D の FnEmission (fn.py の Murphy-Good式 + Forbes近似 fn_current_density を
    そのまま流用) と同じ物理・パラメータだが、1D は電極がちょうど1点 (左端 x=0
    または右端 x=gap) なので放出面/位置サンプリングという概念がなく、
    edges/regions/n (放出マクロ粒子総数)/seed (位置乱数シード) は不要 —
    毎ステップの放出数は決定論的な端数キャリーのみで決まる (乱数不使用)。
    """

    phi_ev: float = Field(4.5, gt=0, description="仕事関数 φ [eV]", json_schema_extra=ui("eV"))
    beta: float = Field(1.0, gt=0, description="電界増倍係数 β", json_schema_extra=ui("1"))
    init_energy_ev: float = Field(0.1, ge=0, description="放出電子の初期エネルギー [eV]", json_schema_extra=ui("eV"))
    # マクロ重み [m^-2] (= 実電子数/マクロ粒子。1D のマクロ重みの単位そのものなので
    # 2D のような面積換算は不要)。None なら初期プラズマの w0 を使う
    macro_weight: float | None = Field(None, gt=0, json_schema_extra=ui("m^-2"))


class Pic1dElectrode(Model):
    """1D の左右電極。電圧は v_dc + Σ RF sin + Σ waveforms(t) の合成 (prompts/93)。
    2D の Region/BoundaryCondition の voltage_rf と同じ規約 (単一/リスト/None、
    pic.py の _dirichlet_values と同じ式) をそのまま流用する。CSV 波形
    (VoltageWaveform) とは併記可能 (両方指定すれば両方の寄与が加算される。
    pic1d.py の _electrode_voltage / pic.py の _eval_waveform 参照)。
    """

    v_dc: float = Field(0.0, json_schema_extra=ui("V"))
    # RF 重畳 (prompts/93)。2D の BoundaryCondition.voltage_rf と同じ規約:
    # 単一 VoltageRF / リスト (デュアル周波数など) / None。
    # V_rf(t) = Σ amplitude·sin(2π·freq_hz·t + phase_deg·π/180)
    voltage_rf: VoltageRF | list[VoltageRF] | None = None
    waveforms: list[VoltageWaveform] = []
    see_gamma: float = Field(0.0, ge=0.0, le=1.0, description="イオン入射あたりのSEE収率 γ", json_schema_extra=ui("1"))
    # FN 電界放出 (prompts/95)。None なら放出なし (従来動作と完全ビット不変)
    fn: Fn1dEmission | None = None
    # 電源との間の阻止コンデンサ (自己バイアス、prompts/134)。流体 1D・PIC 1D。
    # None なら電源に直結
    blocking_capacitor: BlockingCapacitor1d | None = None


class Eedf1dRegion(Model):
    """1D の EEDF/EEPF 集計区間 [x1, x2] (2D の EedfRegion の 1D 版、prompts/85 と同じ規約)。"""

    x1: float = Field(..., json_schema_extra=GEOM)
    x2: float = Field(..., json_schema_extra=GEOM)
    label: str = ""
    bins: int = Field(100, ge=10, le=1000)
    # None = 平均区間の最初の集計ステップで自動決定 (2D の EedfRegion.e_max_ev と同じ規約)
    e_max_ev: float | None = Field(None, gt=0, json_schema_extra=ui("eV"))


class Pic1dSettings(Model):
    """1D PIC/MCC (1d3v)。null なら無効。2D の pic とは独立に実行できる (pic1d.py 参照)。

    一様格子 (n_cells 個のセル、n_nodes = n_cells+1 節点) + 三重対角 Poisson。
    メッシュ生成が無いため geometry/mesh の設定とは無関係に動作する。
    """

    gap_m: float = Field(..., gt=0, description="電極間ギャップ [m]", json_schema_extra=GEOM)
    n_cells: int = Field(128, ge=8, le=100000)
    left: Pic1dElectrode = Pic1dElectrode()
    right: Pic1dElectrode = Pic1dElectrode()
    init_density_m3: float = Field(
        ..., gt=0, description="初期プラズマ密度 (一様、準中性) [m^-3]", json_schema_extra=ui("m^-3")
    )
    init_te_ev: float = Field(2.0, gt=0, json_schema_extra=ui("eV"))
    init_ti_ev: float = Field(0.03, gt=0, json_schema_extra=ui("eV"))
    ion_mass_amu: float = Field(39.948, gt=0, description="イオン質量 [amu] (He: 4.0026)", json_schema_extra=ui("amu"))
    n_macro: int = Field(20000, gt=0, description="種ごとの初期マクロ粒子数")
    parallel: bool = Field(True, description="単一条件の粒子計算に複数CPUスレッドを使う")
    cpu_threads: int | None = Field(
        None, ge=1, le=256, description="CPUスレッド数。空なら自動（上限4）。利用可能な上限で制限する"
    )
    dt: float | None = Field(None, gt=0, description="秒。None なら 0.1/ωpe (初期密度から)", json_schema_extra=ui("s"))
    n_steps: int = Field(2000, gt=0)
    frame_every: int = Field(20, gt=0)
    # 完了時に返す時間平均プロファイルの平均ステップ数。None なら最後の25% (2D と同じ規約)
    avg_steps: int | None = Field(None, gt=0)
    # RF 1周期の位相分解ビン数。0=無効、RF (voltage_rf/waveforms) が無ければ無効
    # (基本周波数の決定優先順位は pic1d.py の Pic1dSimulation._cycle_freq 算出コメント参照)
    phase_bins: int = Field(40, ge=0)
    mcc: MccSettings | None = None  # 既存 MccSettings をそのまま流用 (null なら MCC 無効)
    see_energy_ev: float = Field(2.0, ge=0, description="SEE 電子の初期エネルギー [eV]", json_schema_extra=ui("eV"))
    eedf_regions: list[Eedf1dRegion] = []  # 最大4個 (validator)
    # 壁 IEDF (入射イオンエネルギー分布、prompts/116) のビン数。0=無効。平均区間中に
    # 壁 (左右) で吸収されたイオンの全運動エネルギーを重み付きヒストグラム化する
    # (粒子ベースの厳密な値。e_max は EEDF (eedf_regions) と同じ流儀で自動決定する)
    wall_iedf_bins: int = Field(100, ge=0, le=1000)
    seed: int = Field(0, json_schema_extra=ui(advanced=True))  # 初期装荷の乱数種 (MCC は mcc.seed を使う)
    # 収束の判定 (prompts/137)
    convergence: ConvergenceSettings = ConvergenceSettings()
    external_circuit: ExternalCircuitSettings | None = None

    @model_validator(mode="after")
    def _check_external_circuit(self) -> "Pic1dSettings":
        if self.external_circuit is not None and self.external_circuit.enabled:
            if self.left.blocking_capacitor is not None or self.right.blocking_capacitor is not None:
                raise ValueError(
                    "外部回路連成と電極の阻止コンデンサ設定は同時に使えません。"
                    "コンデンサは外部回路の C 素子として接続してください"
                )
        return self

    @model_validator(mode="after")
    def _check_no_dsmc(self) -> "Pic1dSettings":
        if self.mcc is not None and self.mcc.use_dsmc_gas:
            raise ValueError(
                "1D PIC (pic1d) は DSMC 連成 (mcc.use_dsmc_gas) に未対応です "
                "(1D は専用の一様格子ソルバーで、2D メッシュ/DSMC ガス場を参照できません)"
            )
        return self

    @model_validator(mode="after")
    def _check_eedf_regions(self) -> "Pic1dSettings":
        if len(self.eedf_regions) > 4:
            raise ValueError("eedf_regions は最大 4 個までです")
        return self


class LxcatParseRequest(Model):
    """POST /lxcat/parse のリクエスト。"""

    text: str
    species: Literal["electron", "ion"]


class LxcatParseResult(Model):
    processes: list[XsProcess]
    warnings: list[str]


class Project(Model):
    version: int = 1
    unit: Literal["m", "mm"] = "m"
    pic1d: Pic1dSettings

    @model_validator(mode="before")
    @classmethod
    def accept_settings(cls, value):
        if isinstance(value, dict) and "pic1d" not in value and "gap_m" in value:
            return {"pic1d": value}
        return value

