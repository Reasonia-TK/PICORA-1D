import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeSettings, validateSettings, type Frame, type QuantitySpec, type Result, type Started } from "../src/model";
import { filterQuantities, liveQuantities, resultQuantities } from "../src/plotcatalog";

const settings = defaultSettings();
function legacyResult(): Result {
  return { settings, profiles: { x: [0, 0.02], phi: [0, -10], e: [500, 500], n_e: [1e14, 1e14], n_i: [1e14, 1e14], t_e: [2, 2], ionization: [0, 0], avg_steps: 2 }, history: { step: [1, 2], t: [1e-9, 2e-9], n_e: [100, 99], n_i: [100, 100], wall_left_e: [0, 1e10] }, cycle: null, eedf: [], elapsed_s: 0.1, timing: {} };
}
function diagnosticResult(): Result {
  const result = legacyResult();
  const catalog: QuantitySpec[] = [
    { scope: "profiles", key: "rho", label: "電荷密度", unit: "C/m³", note: "電子とイオンの電荷から計算" },
    { scope: "profiles", key: "lambda_debye", label: "デバイ長", unit: "m" },
    { scope: "history", key: "wall_current_left", label: "左壁の電流密度", unit: "A/m²" },
    { scope: "particles", key: "ax", label: "加速度", unit: "m/s²" },
    { scope: "cycle", key: "rho", label: "位相の電荷密度", unit: "C/m³" },
  ];
  result.profiles!.rho = [-1, 2]; result.profiles!.lambda_debye = [null, null];
  result.diagnostics = { catalog, history: { step: [1, 2], t: [1e-9, 2e-9], wall_current_left: [-0.3, 0.5] }, latest: { x: [0, 0.02], phi: [0, -10], rho: [-2, 3], particles: { electron: { x: [0.015, 0.005], vx: [30, 10], vy: [-20, -10], vz: [5, 10], w: [3, 1], energy: [4, 2], ex: [20, 10], ax: [200, 100] }, ion: { x: [0.01], vx: [1], vy: [2], vz: [3], w: [4], energy: [5], ex: [6], ax: [7] } } }, cross_sections: [{ species: "electron", label: "elastic", kind: "elastic", threshold_ev: 0, energy_ev: [1, 2], sigma_m2: [1e-20, 2e-20], speed_m_s: [10, 20], nu_s: [100, 200] }], parameters: [{ key: "QE", label: "電気素量", value: 1.602176634e-19, unit: "C" }] };
  result.cycle = { bins: 2, freq_hz: 1e6, phi: [[0, 0], [0, -10]], n_e: [[1, 2], [3, 4]], n_i: [[1, 2], [3, 4]], rho: [[0, 0], [2, 3]], samples: [0, 2] };
  result.circuit = { units: { current: "A/m²", capacitance: "F/m²", charge: "C/m²" }, c_matrix: [[2]], electrodes: [{ label: "left", t: [1e-6], v_dc: [-10], v1: [20], i_dc: [0.4], q_node: 1, c_self: 2, capacitance: 3, initial_bias_v: -5, rf_division: 0.6, v_e: -8, last_period: { t: [0, 1e-6], v: [0, -8] } }] };
  result.convergence = { tol: 0.01, period: [1, 2], step: [1, 2], t: [1e-9, 2e-9], status: ["warming", "fail"], d: { phi: [null, 0.2] }, r: { phi: [null, 0.1] }, noise: { phi: [null, 0.01] }, res: { phi: [null, 0.003] }, converged: false, converged_step: null, now_passing: false, stopped: false };
  return result;
}

describe("物理量一覧の網羅性と単位", () => {
  it("ソルバーが追加した量を catalogue に沿って平均・最終・履歴・粒子・位相で表示する", () => {
    const result = diagnosticResult(), items = resultQuantities(result);
    expect(new Set(items.map(item => item.id)).size).toBe(items.length);
    for (const spec of result.diagnostics!.catalog) {
      const prefixes = spec.scope === "profiles" ? ["profiles", "latest"] : spec.scope === "particles" ? ["particles.electron", "particles.ion"] : [spec.scope];
      for (const prefix of prefixes) expect(items.find(item => item.id === `${prefix}.${spec.key}`)?.unit).toBe(spec.unit);
    }
    const history = items.find(item => item.id === "history.wall_current_left")!;
    expect(history.plot().x).toEqual([0.001, 0.002]); expect(history.plot().series[0].values).toEqual([-0.3, 0.5]);
    expect(items.find(item => item.id === "profiles.rho")?.note).toContain("電荷");
    expect(items.find(item => item.id === "profiles.lambda_debye")?.unavailable).toBeTruthy();
  });
  it("空間順に並べても全速度成分・重み・エネルギー・加速度の対応を維持する", () => {
    const items = resultQuantities(diagnosticResult());
    const particle = (key: string) => items.find(item => item.id === `particles.electron.${key}`)!.plot();
    expect(particle("vx").x).toEqual([5, 15]); expect(particle("vx").series[0].values).toEqual([10, 30]);
    expect(particle("vy").series[0].values).toEqual([-10, -20]); expect(particle("vz").series[0].values).toEqual([10, 5]);
    expect(particle("energy").series[0].values).toEqual([2, 4]); expect(particle("w").series[0].values).toEqual([1, 3]); expect(particle("ax").series[0].values).toEqual([100, 200]);
    expect(particle("x").x).toEqual([1, 2]); expect(particle("x").series[0].values).toEqual([0.015, 0.005]);
  });
  it("未観測の RF ビンを零場として誤表示せず、観測済みビンを表示する", () => {
    const item = resultQuantities(diagnosticResult()).find(item => item.id === "cycle.rho")!;
    expect(item.plot(0).x).toEqual([]); expect(item.plot(0).note).toContain("まだ取得していません");
    expect(item.plot(1).series[0].values).toEqual([2, 3]); expect(item.plot(1).phases).toBe(2);
  });
  it("回路の全物理出力と衝突テーブルをプロット可能にする", () => {
    const items = resultQuantities(diagnosticResult());
    for (const key of ["v_dc", "v1", "i_dc", "last_period", "q_node", "c_self", "capacitance", "initial_bias_v", "rf_division", "v_e"]) expect(items.find(item => item.id === `circuit.left.${key}`)?.unavailable).toBeUndefined();
    expect(items.find(item => item.id === "circuit.matrix.0.0")?.plot().series[0].values).toEqual([2]);
    for (const key of ["sigma_m2", "speed_m_s", "nu_s"]) expect(items.find(item => item.id === `mcc.0.${key}`)?.plot().x).toEqual([1, 2]);
    for (const key of ["d", "r", "noise", "res"]) expect(items.find(item => item.id === `convergence.${key}.phi`)?.plot().series).toHaveLength(2);
  });
  it("全ステップ履歴の全物理列に単位を持つプロットがあり、軸だけを列選択から除く", () => {
    const result = legacyResult(), keys = ["n_e", "n_i", "w_e", "w_i", "wall_left_e", "wall_left_i", "wall_right_e", "wall_right_i", "ion_events", "see_events", "coll_e", "coll_i", "fn_left", "fn_right"];
    for (const key of keys) result.history[key] ??= [0, 1];
    const items = resultQuantities(result);
    for (const key of keys) { const item = items.find(item => item.id === `history.${key}`)!; expect(item).toBeDefined(); expect(item.unit).not.toBe("単位未記録"); expect(item.plot().series[0].values).toEqual(result.history[key]); }
    expect(items.some(item => item.id === "history.step" || item.id === "history.t")).toBe(false);
  });
  it("重心系のイオン衝突では換算質量による相対速度・エネルギー系を明示する", () => {
    const result = diagnosticResult(); result.diagnostics!.cross_sections[0] = { ...result.diagnostics!.cross_sections[0], species: "ion", energy_frame: "com", note: "換算質量 μ から相対速度 g を算出。" };
    const items = resultQuantities(result), speed = items.find(item => item.id === "mcc.0.speed_m_s")!;
    expect(speed.label).toContain("相対速度"); expect(speed.plot().xLabel).toContain("重心系"); expect(speed.note).toContain("換算質量");
  });
  it("実際に使用した物理定数を SI 単位の水平線で表示する", () => {
    const item = resultQuantities(diagnosticResult()).find(item => item.id === "constant.QE")!;
    expect(item.category).toBe("物理条件・定数"); expect(item.unit).toBe("C"); expect(item.plot().x).toEqual([0.001, 0.002]); expect(item.plot().series[0].values).toEqual([1.602176634e-19, 1.602176634e-19]);
  });
});
describe("古い保存結果・途中停止・無効なモデル", () => {
  it("旧結果の既存場と壁吸収履歴を維持し、新しい量と未有効モデルに理由を表示する", () => {
    const items = resultQuantities(legacyResult());
    expect(items.find(item => item.id === "profiles.phi")?.unavailable).toBeUndefined();
    expect(items.find(item => item.id === "history.wall_left_e")?.plot().series[0].values).toEqual([0, 1e10]);
    for (const id of ["latest.phi", "particles.ion.vy", "mcc.disabled", "eedf.disabled", "circuit.disabled", "convergence.disabled"]) expect(items.find(item => item.id === id)?.unavailable).toBeTruthy();
  });
  it("平均前の停止でも最終場と粒子を表示できる", () => {
    const result = diagnosticResult(); result.profiles = null;
    const items = resultQuantities(result);
    expect(items.find(item => item.id === "profiles.rho")?.unavailable).toBeTruthy();
    expect(items.find(item => item.id === "latest.rho")?.plot().series[0].values).toEqual([-2, 3]);
    expect(items.find(item => item.id === "particles.ion.energy")?.unavailable).toBeUndefined();
  });
  it("試料ゼロの EEDF は確率分布や平均エネルギーを取得済みと扱わない", () => {
    const result = legacyResult(); result.eedf = [{ e_centers: [1, 2], f: [0, 0], total_weight: 0, n_samples: 10, mean_energy_ev: 0, t_eff_ev: 0 }];
    const items = resultQuantities(result);
    expect(items.find(item => item.id === "eedf.0.f")?.unavailable).toBeTruthy(); expect(items.find(item => item.id === "eedf.0.mean_energy_ev")?.unavailable).toBeTruthy(); expect(items.find(item => item.id === "eedf.0.total_weight")?.unavailable).toBeUndefined();
  });
  it("カテゴリ・日本語／識別子検索・取得済みフィルターを併用できる", () => {
    const items = resultQuantities(diagnosticResult());
    expect(filterQuantities(items, "電荷密度", "時間平均の場・流体量", true).map(item => item.id)).toEqual(["profiles.rho"]);
    expect(filterQuantities(items, "lambda_debye", "all", true)).toEqual([]); expect(filterQuantities(items, "lambda_debye")).toHaveLength(2);
  });
});
describe("ライブ量と CPU 並列設定", () => {
  it("ライブ診断の単位と scalar 履歴を受信フレームから表示する", () => {
    const result = diagnosticResult();
    const frame: Frame = { type: "frame", step: 2, t: 2e-9, phi: [0, -10], n_e: [1e14, 1e14], n_i: [1e14, 1e14], counts: { n_e: 99, n_i: 100 }, diagnostic_counts: { wall_current_left: 0.5 }, elapsed_s: 0.1, diagnostics: { ...result.diagnostics!.latest!, catalog: result.diagnostics!.catalog } };
    const started: Started = { type: "started", n_steps: 2, step_offset: 0, dt: 1e-9, x: [0, 0.02], warnings: [] };
    const items = liveQuantities(frame, started, [{ ...frame, step: 1, t: 1e-9, diagnostic_counts: { wall_current_left: -0.3 } }, frame]);
    expect(items.find(item => item.id === "history.wall_current_left")?.plot().series[0].values).toEqual([-0.3, 0.5]); expect(items.find(item => item.id === "latest.rho")?.unit).toBe("C/m³");
  });
  it("診断サンプルの間引きで重複した履歴を現在時刻に付け替えず、実際のサンプル時刻を使う", () => {
    const frame: Frame = { type: "frame", step: 20, t: 20e-9, phi: [0, 0], n_e: [1, 1], n_i: [1, 1], elapsed_s: 0.1, counts: {}, diagnostic_counts: { step: 10, t: 10e-9, wall_current_left: 0.5 }, diagnostic_catalog: [{ scope: "history", key: "wall_current_left", label: "電流密度", unit: "A/m²" }] };
    const started: Started = { type: "started", n_steps: 100, step_offset: 0, dt: 1e-9, x: [0, 0.02], warnings: [] };
    const item = liveQuantities(frame, started, [{ ...frame, step: 10, t: 10e-9 }, frame]).find(item => item.id === "history.wall_current_left")!;
    expect(item.plot().x).toEqual([0.01]); expect(item.plot().series[0].values).toEqual([0.5]);
  });
  it("並列をデフォルトとし、旧設定を補完し、不正なスレッド数を拒否する", () => {
    expect(settings.parallel).toBe(true); expect(settings.cpu_threads).toBeNull();
    expect(normalizeSettings({ gap_m: 0.02, init_density_m3: 1e14 }).parallel).toBe(true);
    expect(validateSettings({ ...settings, cpu_threads: 0 })).not.toEqual([]); expect(validateSettings({ ...settings, cpu_threads: 1.5 })).not.toEqual([]);
  });
});
