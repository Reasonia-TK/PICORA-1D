import { electrodeVoltage, numberText, type ExternalCircuitResult, type Frame, type LatestDiagnostics, type NumericValues, type ParticleSample, type PhysicalParameter, type QuantitySpec, type Result, type Settings, type Started } from "./model";

export interface QuantitySeries { label: string; values: NumericValues; color?: number; points?: boolean }
export interface QuantityPlot { x: number[]; series: QuantitySeries[]; xLabel: string; note?: string; phases?: number }
export interface PlotQuantity { id: string; label: string; category: string; unit: string; note?: string; unavailable?: string; plot: (phase?: number) => QuantityPlot }

const fields: QuantitySpec[] = [
  { scope: "profiles", key: "phi", label: "電位 φ", unit: "V" },
  { scope: "profiles", key: "e", label: "電場 Eₓ", unit: "V/m" },
  { scope: "profiles", key: "n_e", label: "電子密度 nₑ", unit: "m⁻³" },
  { scope: "profiles", key: "n_i", label: "イオン密度 nᵢ", unit: "m⁻³" },
  { scope: "profiles", key: "t_e", label: "電子の有効温度 Tₑ", unit: "eV" },
  { scope: "profiles", key: "ionization", label: "電離生成率", unit: "m⁻³s⁻¹" },
];
const histories: QuantitySpec[] = [
  { scope: "history", key: "n_e", label: "電子のマクロ粒子数", unit: "個" },
  { scope: "history", key: "n_i", label: "イオンのマクロ粒子数", unit: "個" },
  { scope: "history", key: "w_e", label: "電子の総実粒子重み", unit: "m⁻²" },
  { scope: "history", key: "w_i", label: "イオンの総実粒子重み", unit: "m⁻²" },
  ...(["left", "right"] as const).flatMap(side => (["e", "i"] as const).map(species => ({ scope: "history" as const, key: `wall_${side}_${species}`, label: `${side === "left" ? "左" : "右"}壁の${species === "e" ? "電子" : "イオン"}吸収（累積）`, unit: "m⁻²" }))),
  { scope: "history", key: "coll_e", label: "電子の衝突イベント（累積）", unit: "回", note: "マクロ粒子の衝突回数です。実粒子の総衝突数ではありません。" },
  { scope: "history", key: "coll_i", label: "イオンの衝突イベント（累積）", unit: "回", note: "マクロ粒子の衝突回数です。実粒子の総衝突数ではありません。" },
  { scope: "history", key: "ion_events", label: "電離イベント（累積）", unit: "回" },
  { scope: "history", key: "see_events", label: "二次電子放出の総重み（累積）", unit: "m⁻²" },
  { scope: "history", key: "fn_left", label: "左壁の FN 放出重み／ステップ", unit: "m⁻²" },
  { scope: "history", key: "fn_right", label: "右壁の FN 放出重み／ステップ", unit: "m⁻²" },
];
const particleSpecs: QuantitySpec[] = [
  { scope: "particles", key: "x", label: "粒子位置", unit: "m" },
  { scope: "particles", key: "vx", label: "粒子速度 vₓ", unit: "m/s" },
  { scope: "particles", key: "vy", label: "粒子速度 vᵧ", unit: "m/s" },
  { scope: "particles", key: "vz", label: "粒子速度 v_z", unit: "m/s" },
  { scope: "particles", key: "energy", label: "粒子運動エネルギー", unit: "eV" },
  { scope: "particles", key: "w", label: "粒子の実粒子重み", unit: "m⁻²" },
  { scope: "particles", key: "ex", label: "粒子に働く電場 Eₓ", unit: "V/m" },
  { scope: "particles", key: "ax", label: "粒子加速度 aₓ", unit: "m/s²" },
];
export function numericValues(value: unknown): NumericValues {
  return Array.isArray(value) && value.every(v => v === null || typeof v === "number") ? value as NumericValues : [];
}
function mergedSpecs(fallback: QuantitySpec[], catalog: QuantitySpec[] | undefined, scope: QuantitySpec["scope"]) {
  const map = new Map(fallback.filter(v => v.scope === scope).map(v => [v.key, v]));
  for (const spec of catalog ?? []) if (spec.scope === scope) map.set(spec.key, spec);
  return [...map.values()];
}
function scalarPlot(value: number | null | undefined, label: string, note?: string): QuantityPlot {
  return { x: value == null ? [] : [0], series: [{ label, values: value == null ? [] : [value], points: true }], xLabel: "集計値", note };
}
function hasNumbers(values: NumericValues) { return values.some(v => v !== null && Number.isFinite(v)); }
function momentNote(latest: LatestDiagnostics | null | undefined) {
  return ([["field_t", "場"], ["t", "粒子位置"], ["velocity_t", "速度"]] as const).flatMap(([key, label]) => typeof latest?.[key] === "number" ? [`${label}の時刻 ${numberText((latest[key] as number) * 1e9)} ns`] : []).join(" / ");
}
function historyMissingReason(key: string, settings: Settings) {
  if (/^(adaptive_numax|candidate_probability)_[ei]$/.test(key) && !settings.mcc) return "MCC が無効のため、衝突候補の上界・確率は使用していません。";
  const circuit = key.match(/^(q_node_start|q_node_end|q_induced|electrode_charge|capacitor_charge|blocking_capacitance|capacitor_bias)_(left|right)$/);
  if (circuit && !settings[circuit[2] as "left" | "right"].blocking_capacitor) return "この電極の阻止コンデンサが無効のため、この回路量は使用していません。";
  return "この量の履歴は未取得です。新しく計算すると取得できます。";
}
function addArray(out: PlotQuantity[], id: string, label: string, category: string, unit: string, x: number[], values: NumericValues, xLabel: string, missing: string, note?: string, points = false) {
  out.push({ id, label, category, unit, note, unavailable: !x.length || !hasNumbers(values) ? missing : undefined, plot: () => ({ x, series: [{ label, values, points }], xLabel }) });
}
function addScalar(out: PlotQuantity[], id: string, label: string, category: string, unit: string, value: number | null | undefined, missing: string, note?: string) {
  out.push({ id, label, category, unit, note, unavailable: value == null || !Number.isFinite(value) ? missing : undefined, plot: () => scalarPlot(value, label) });
}
function addExternalCircuit(out: PlotQuantity[], circuit: ExternalCircuitResult | null | undefined) {
  if (!circuit?.enabled) {
    out.push({ id: "external_circuit.disabled", label: "外部回路の電圧・電流・電力", category: "外部回路", unit: "—", unavailable: "外部回路連成が無効、または外部回路の結果を含まない保存データです。", plot: () => scalarPlot(null, "外部回路") });
    return;
  }
  const x = numericValues(circuit.history?.t).map(t => (t ?? 0) * 1e6);
  for (const spec of circuit.catalog ?? []) {
    const values = numericValues(circuit.history?.[spec.key]);
    const category = spec.key.startsWith("pic/") ? "外部回路・PIC端子" : spec.key.startsWith("node/") ? "外部回路・ノード" : "外部回路・素子";
    addArray(out, `external_circuit.${spec.key}`, spec.label, category, spec.unit, x, values, "t [µs]", "この回路量の履歴をまだ取得していません。", spec.note);
  }
}
function addExternalLive(out: PlotQuantity[], frame: Frame, frames: Frame[]) {
  const circuit = frame.external_circuit;
  if (!circuit?.enabled) { addExternalCircuit(out, circuit); return; }
  const byTime = new Map<number, ExternalCircuitResult>();
  for (const f of frames.length ? frames : [frame]) {
    const c = f.external_circuit, times = numericValues(c?.history?.t), t = times.at(-1);
    if (c?.enabled && typeof t === "number") byTime.set(t, c);
  }
  const samples = [...byTime.entries()].sort(([a], [b]) => a - b);
  const history: Record<string, NumericValues> = { t: samples.map(([t]) => t) };
  for (const spec of circuit.catalog) history[spec.key] = samples.map(([, c]) => c.latest?.[spec.key] ?? numericValues(c.history?.[spec.key]).at(-1) ?? null);
  addExternalCircuit(out, { ...circuit, history });
}
function addParticles(out: PlotQuantity[], latest: LatestDiagnostics | null | undefined, catalog?: QuantitySpec[], fallback?: { electron?: ParticleSample; ion?: ParticleSample }) {
  const specs = mergedSpecs(particleSpecs, catalog, "particles");
  for (const species of ["electron", "ion"] as const) {
    const sample = latest?.particles?.[species] ?? fallback?.[species];
    for (const spec of specs) {
      const values = numericValues(sample?.[spec.key as keyof ParticleSample]);
      const indices = Array.from({ length: sample?.x.length ?? 0 }, (_, i) => i);
      if (spec.key !== "x") indices.sort((a, b) => sample!.x[a] - sample!.x[b]);
      const label = `${species === "electron" ? "電子" : "イオン"} / ${spec.label}`;
      const x = indices.map(i => spec.key === "x" ? i + 1 : sample!.x[i] * 1e3);
      addArray(out, `particles.${species}.${spec.key}`, label, "粒子の状態", spec.unit, x, indices.map(i => values[i] ?? null), spec.key === "x" ? "抽出粒子番号" : "x [mm]", !sample?.x.length ? "この粒子種の試料がありません。粒子が全て吸収された場合も表示できません。" : "この保存結果には、この粒子量が記録されていません。新しく計算すると取得できます。", `${spec.note ?? ""} 各粒子種から最大 2,000 個を均等に間引いた試料です。全粒子の追跡履歴ではありません。`.trim(), true);
    }
  }
}
const noAverage = "平均区間のデータがありません。平均区間に入る前の停止、または旧形式の保存結果ではこの量が未取得です。";

/** グラフは選択した量だけ生成する。catalog はソルバーのラベル・単位・定義を優先する。 */
export function resultQuantities(result: Result, settings: Settings = result.settings): PlotQuantity[] {
  const out: PlotQuantity[] = [], catalog = result.diagnostics?.catalog;
  const specs = mergedSpecs(fields, catalog, "profiles");
  const grid = result.profiles?.x ?? result.diagnostics?.latest?.x ?? Array.from({ length: settings.n_cells + 1 }, (_, i) => settings.gap_m * i / settings.n_cells);
  for (const spec of specs) {
    const undefinedDebye = spec.key === "lambda_debye" ? "電子密度または熱温度が 0 のため、Debye 長が全節点で未定義です。" : null;
    addArray(out, `profiles.${spec.key}`, spec.label, "時間平均の場・流体量", spec.unit, (result.profiles?.x ?? []).map(v => v * 1e3), numericValues(result.profiles?.[spec.key]), "x [mm]", result.profiles && numericValues(result.profiles[spec.key]).length ? undefinedDebye ?? "この量に有限の試料がありません。" : noAverage, spec.note);
    const latestValues = numericValues(result.diagnostics?.latest?.[spec.key]);
    const latestMissing = spec.key === "ionization" ? "瞬時の電離生成率は集計していません。時間平均または RF 位相分解で確認できます。" : latestValues.length && undefinedDebye ? undefinedDebye : "最後の状態が記録されていません。新しく計算すると取得できます。";
    const timeNote = momentNote(result.diagnostics?.latest);
    addArray(out, `latest.${spec.key}`, spec.label, "最後の場・流体量", spec.unit, (result.diagnostics?.latest?.x ?? []).map(v => v * 1e3), latestValues, "x [mm]", latestMissing, [spec.note, spec.key === "e_rms" ? "最後の場では瞬時電場の絶対値です。RMS は時間平均で確認できます。" : "", timeNote].filter(Boolean).join(" "));
  }
  const historySpecs = mergedSpecs(histories, catalog, "history").filter(v => !["step", "t", "field_t"].includes(v.key));
  for (const key of Object.keys(result.history)) if (!["step", "t"].includes(key) && !historySpecs.some(spec => spec.key === key)) historySpecs.push({ scope: "history", key, label: key, unit: "単位未記録", note: "この保存結果の量カタログには単位が記録されていません。値は保存結果のまま表示します。" });
  for (const spec of historySpecs) {
    const diagnostic = result.diagnostics?.history;
    const values = diagnostic?.[spec.key] ?? result.history[spec.key] ?? [];
    const rawT = diagnostic?.[spec.key] ? diagnostic.t : result.history.t;
    const x = rawT?.length === values.length ? rawT.map(v => v == null ? NaN : v * 1e6) : result.history.step ?? [];
    addArray(out, `history.${spec.key}`, spec.label, "時間履歴", spec.unit, x, values, rawT?.length === values.length ? "t [µs]" : "ステップ", historyMissingReason(spec.key, settings), spec.note);
  }
  addParticles(out, result.diagnostics?.latest, catalog);
  const cycleSpecs = mergedSpecs(specs.map(v => ({ ...v, scope: "cycle" as const })).filter(v => ["phi", "e", "rho", "n_e", "n_i", "ionization"].includes(v.key)), catalog, "cycle");
  for (const spec of cycleSpecs) {
    const data = result.cycle?.[spec.key];
    const matrix = Array.isArray(data) && data.every(Array.isArray) ? data as NumericValues[] : [];
    out.push({ id: `cycle.${spec.key}`, label: spec.label, category: "RF 位相分解", unit: spec.unit, note: spec.note, unavailable: !matrix.length ? "RF / CSV 波形と位相ビンを設定し、平均区間まで計算してください。旧保存結果には追加量がない場合があります。" : undefined, plot: (phase = 0) => {
      const bin = Math.min(phase, matrix.length - 1), missing = result.cycle?.samples?.[bin] === 0;
      return { x: missing ? [] : grid.map(v => v * 1e3), series: [{ label: spec.label, values: missing ? [] : matrix[bin] ?? [] }], xLabel: "x [mm]", phases: result.cycle?.bins, note: missing ? "この位相ビンの試料はまだ取得していません。平均区間を延ばすと取得できます。" : result.cycle?.samples ? `${result.cycle.samples[bin]} ステップの試料で平均。` : undefined };
    } });
  }
  for (const side of ["left", "right"] as const) {
    const sideLabel = side === "left" ? "左" : "右", skey = side === "left" ? "s_left" : "s_right";
    addArray(out, `sheath.time.${side}`, `${sideLabel}シース厚`, "シース・FFT", "m", result.sheath_ts?.t.map(v => v * 1e6) ?? [], result.sheath_ts?.[skey] ?? [], "t [µs]", "平均区間でシース端を検出できた試料がありません。", "Brinkmann のシース端。根が存在しない時点は欠測として表示します。");
    addArray(out, `sheath.phase.${side}`, `${sideLabel}シース厚 / RF 位相`, "シース・FFT", "m", Array.from({ length: result.cycle?.bins ?? 0 }, (_, i) => i * 360 / result.cycle!.bins), result.cycle?.sheath?.[skey] ?? [], "RF 位相 [°]", "位相分解のシース端が未取得です。");
    addArray(out, `sheath.fft.${side}`, `${sideLabel}シース厚 / スペクトル`, "シース・FFT", "m", result.sheath_fft?.freq_hz.map(v => v / 1e6) ?? [], result.sheath_fft?.[side === "left" ? "amp_left" : "amp_right"] ?? [], "f [MHz]", "FFT に必要なシース試料が不足しています。", "周波数 0 の DC 成分も含めた全スペクトルです。");
    addScalar(out, `sheath.average.${side}`, `${sideLabel}の平均シース厚`, "シース・FFT", "m", result.sheath?.[side === "left" ? "left_s" : "right_s"], "平均密度からシース端の根を検出できませんでした。");
  }
  addDistributions(out, result);
  for (const electrode of result.circuit?.electrodes ?? []) {
    const side = electrode.label === "left" ? "左" : "右";
    for (const [key, label, unit] of [["v_dc", "自己バイアス", "V"], ["v1", "電極電圧の基本波振幅", "V"], ["i_dc", "周期平均の伝導電流密度", result.circuit!.units.current]] as const) addArray(out, `circuit.${electrode.label}.${key}`, `${side} / ${label}`, "電極・回路", unit, electrode.t.map(v => v * 1e6), electrode[key], "t [µs]", "完了した RF 周期がありません。周期平均の履歴を作るには計算を延長してください。");
    addArray(out, `circuit.${electrode.label}.last_period`, `${side} / 最終周期の電極電圧`, "電極・回路", "V", electrode.last_period?.t.map(v => v * 1e6) ?? [], electrode.last_period?.v ?? [], "t [µs]", "完了した RF 周期がありません。");
    for (const [key, label, unit] of [["v_e", "最終電極電圧", "V"], ["q_node", "電極の最終面電荷", result.circuit!.units.charge], ["capacitance", "阻止コンデンサ容量", result.circuit!.units.capacitance], ["c_self", "電極の自己容量", result.circuit!.units.capacitance], ["initial_bias_v", "初期バイアス", "V"], ["rf_division", "真空での RF 分圧", "1"]] as const) addScalar(out, `circuit.${electrode.label}.${key}`, `${side} / ${label}`, "電極・回路", unit, electrode[key], "この回路量が記録されていません。");
  }
  for (const [i, row] of (result.circuit?.c_matrix ?? []).entries()) for (const [j, value] of row.entries()) addScalar(out, `circuit.matrix.${i}.${j}`, `電極容量 C${i + 1},${j + 1}`, "電極・回路", result.circuit!.units.capacitance, value, "電極容量行列がありません。");
  if (!result.circuit) out.push({ id: "circuit.disabled", label: "阻止コンデンサの電圧・電流・電荷", category: "電極・回路", unit: "—", unavailable: "阻止コンデンサを有効にしていません。電源・電極電圧は時間履歴で確認できます。", plot: () => scalarPlot(null, "回路") });
  for (const side of ["left", "right"] as const) {
    const label = side === "left" ? "左" : "右";
    addScalar(out, `fn.${side}.j_avg`, `${label} / FN 平均電流密度`, "電極・回路", "A/m²", result.fn?.[side]?.j_avg, "この電極の FN 放出は有効になっていません。", "平均プロファイルと同じ平均区間で集計します。");
    addScalar(out, `fn.${side}.total_w`, `${label} / FN 累積放出重み`, "電極・回路", "m⁻²", result.fn?.[side]?.total_w, "この電極の FN 放出は有効になっていません。");
  }
  for (const [measure, label] of [["d", "変化 D"], ["r", "残りの変化 R"], ["noise", "揺らぎ"], ["res", "遅い変化の分解能"]] as const) {
    const metrics = result.convergence?.[measure];
    for (const [key, values] of Object.entries(metrics ?? {})) out.push({ id: `convergence.${measure}.${key}`, label: `${label} / ${key}`, category: "収束の診断", unit: "1", unavailable: !hasNumbers(values) ? "収束判定の履歴が不足しています。計算を延長してください。" : undefined, plot: () => ({ x: result.convergence!.period, series: [{ label: key, values }, { label: "閾値", values: result.convergence!.period.map(() => result.convergence!.tol), color: 3 }], xLabel: "判定周期" }) });
  }
  if (!result.convergence) out.push({ id: "convergence.disabled", label: "収束 D / R / 揺らぎ / 分解能", category: "収束の診断", unit: "1", unavailable: "収束判定が有効になっていません。", plot: () => scalarPlot(null, "収束") });
  addCrossSections(out, result);
  addConstants(out, settings, result.diagnostics?.history.t?.filter((v): v is number => v !== null) ?? result.history.t ?? [], result.diagnostics?.parameters);
  addExternalCircuit(out, result.external_circuit);
  return out;
}

function addDistributions(out: PlotQuantity[], result: Result) {
  const distributions = [...(result.eedf ?? []).map((distribution, i) => ({ id: `eedf.${i}`, name: `EEDF / ${distribution.label || `領域 ${i + 1}`}`, distribution, electron: true })), ...(["left", "right"] as const).flatMap(side => result.wall_iedf?.[side] ? [{ id: `iedf.${side}`, name: `IEDF / ${side === "left" ? "左" : "右"}壁`, distribution: result.wall_iedf[side], electron: false }] : [])];
  for (const { id, name, distribution: d, electron } of distributions) {
    addArray(out, `${id}.f`, name, "エネルギー分布", "eV⁻¹", d.total_weight > 0 ? d.e_centers : [], d.f, "エネルギー [eV]", "平均区間に粒子の試料がありません。", `記録試料数 ${d.n_samples.toLocaleString()} / 範囲外の重み ${(100 * (d.overflow_frac ?? 0)).toPrecision(3)}%`);
    if (electron) addArray(out, `${id}.eepf`, name.replace("EEDF", "EEPF"), "エネルギー分布", "eV⁻³ᐟ²", d.total_weight > 0 ? d.e_centers : [], d.f.map((v, i) => d.e_centers[i] > 0 ? v / Math.sqrt(d.e_centers[i]) : null), "エネルギー [eV]", "電子の試料がありません。", "EEDF を √E で割った EEPF です。");
    for (const [key, label, unit] of [["mean_energy_ev", "平均エネルギー", "eV"], ["t_eff_ev", "有効温度", "eV"], ["total_weight", "集計した実粒子重み", "m⁻²"], ["overflow_frac", "範囲外の重みの割合", "1"]] as const) if (key !== "t_eff_ev" || electron) addScalar(out, `${id}.${key}`, `${name} / ${label}`, "エネルギー分布", unit, d.total_weight > 0 || key === "total_weight" ? d[key] : null, "この分布の集計量が記録されていないか、粒子の試料がありません。");
  }
  if (!result.eedf?.length) out.push({ id: "eedf.disabled", label: "EEDF / EEPF", category: "エネルギー分布", unit: "eV⁻¹ / eV⁻³ᐟ²", unavailable: "EEDF 集計領域を設定していません。領域を追加し、平均区間まで計算してください。", plot: () => scalarPlot(null, "EEDF") });
  if (!result.wall_iedf) out.push({ id: "iedf.disabled", label: "壁 IEDF", category: "エネルギー分布", unit: "eV⁻¹", unavailable: "壁 IEDF が無効、または旧形式の結果です。壁 IEDF ビン数を設定して計算してください。", plot: () => scalarPlot(null, "IEDF") });
}
function addCrossSections(out: PlotQuantity[], result: Result) {
  for (const [i, process] of (result.diagnostics?.cross_sections ?? []).entries()) {
    const label = `${process.species === "electron" ? "電子" : "イオン"} / ${process.label || process.kind}`;
    const com = process.species === "ion" && process.energy_frame === "com";
    for (const [key, name, unit] of [["sigma_m2", "衝突断面積", "m²"], ["speed_m_s", com ? "相対速度 g" : "衝突エネルギーに対応する速度", "m/s"], ["nu_s", com ? "衝突周波数 n_g σ g" : "衝突周波数 n_g σ v", "s⁻¹"]] as const) addArray(out, `mcc.${i}.${key}`, `${label} / ${name}`, "MCC・背景ガス", unit, process.energy_ev, process[key], com ? "重心系の衝突エネルギー [eV]" : "実験室系の衝突エネルギー [eV]", "衝突過程のテーブルがありません。", `しきい値 ${process.threshold_ev} eV。${process.kind} 過程。${process.note ?? ""}`);
    addScalar(out, `mcc.${i}.threshold_ev`, `${label} / しきいエネルギー`, "MCC・背景ガス", "eV", process.threshold_ev, "しきい値がありません。");
  }
  if (!result.diagnostics?.cross_sections?.length) out.push({ id: "mcc.disabled", label: "衝突断面積・衝突周波数", category: "MCC・背景ガス", unit: "m² / s⁻¹", unavailable: "MCC が無効、または断面積診断がない旧形式の結果です。MCC を有効にし、LXCat 断面積を読み込んで計算してください。", plot: () => scalarPlot(null, "MCC") });
}
function addConstants(out: PlotQuantity[], settings: Settings, times: number[], parameters?: PhysicalParameter[]) {
  const endpoints = times.length ? [times[0] * 1e6, times.at(-1)! * 1e6] : [0];
  const constant = (id: string, label: string, unit: string, value: number, category = "物理条件・定数", note?: string) => out.push({ id: `constant.${id}`, label, category, unit, note: `${note ?? ""} 計算中は一定の物理量です。`.trim(), plot: () => ({ x: endpoints, series: [{ label, values: endpoints.map(() => value), points: endpoints.length === 1 }], xLabel: "t [µs]" }) });
  for (const parameter of parameters ?? []) constant(parameter.key, parameter.label, parameter.unit, parameter.value, "物理条件・定数", parameter.note);
  if (!parameters?.length) for (const [key, label, unit] of [["gap_m", "電極間隔", "m"], ["init_density_m3", "初期プラズマ密度", "m⁻³"], ["init_te_ev", "初期電子温度", "eV"], ["init_ti_ev", "初期イオン温度", "eV"], ["ion_mass_amu", "イオン質量", "amu"], ["see_energy_ev", "二次電子の放出エネルギー", "eV"]] as const) constant(key, label, unit, settings[key], "物理条件・定数");
  if (settings.mcc && !parameters?.length) {
    constant("gas.pressure_pa", "背景ガス圧力", "Pa", settings.mcc.gas.pressure_pa, "MCC・背景ガス");
    constant("gas.temperature_k", "背景ガス温度", "K", settings.mcc.gas.temperature_k, "MCC・背景ガス");
  }
  for (const side of ["left", "right"] as const) {
    const electrode = settings[side], name = side === "left" ? "左" : "右";
    if (!parameters?.length) constant(`${side}.v_dc`, `${name} / 電源の DC 電圧`, "V", electrode.v_dc, "物理条件・定数");
    if (!parameters?.length) constant(`${side}.see_gamma`, `${name} / 二次電子放出係数`, "1", electrode.see_gamma, "物理条件・定数");
    const rf = !electrode.voltage_rf ? [] : Array.isArray(electrode.voltage_rf) ? electrode.voltage_rf : [electrode.voltage_rf];
    if (!parameters?.length) for (const [i, component] of rf.entries()) for (const [key, label, unit] of [["amplitude", "振幅", "V"], ["freq_hz", "周波数", "Hz"], ["phase_deg", "初期位相", "°"]] as const) constant(`${side}.rf.${i}.${key}`, `${name} / RF ${i + 1} ${label}`, unit, component[key] ?? 0, "物理条件・定数");
    for (const [i, waveform] of electrode.waveforms.entries()) {
      if (!parameters?.length) constant(`${side}.waveform.${i}.freq_hz`, `${name} / CSV 波形 ${i + 1} 周波数`, "Hz", waveform.freq_hz, "物理条件・定数");
      addArray(out, `source.${side}.waveform.${i}`, `${name} / CSV 波形 ${i + 1}`, "電極・回路", "V", waveform.phase.map(v => v * 360), waveform.v, "位相 [°]", "CSV 波形がありません。");
    }
    if (electrode.fn && !parameters?.length) for (const [key, label, unit] of [["phi_ev", "仕事関数", "eV"], ["beta", "電界増倍係数", "1"], ["init_energy_ev", "FN 電子の放出エネルギー", "eV"]] as const) constant(`${side}.fn.${key}`, `${name} / ${label}`, unit, electrode.fn[key], "物理条件・定数");
  }
  const voltageTime = times.length > 1 ? Array.from({ length: Math.min(500, times.length) }, (_, i) => times[0] + (times.at(-1)! - times[0]) * i / (Math.min(500, times.length) - 1)) : [0];
  if (!settings.external_circuit?.enabled) for (const side of ["left", "right"] as const) addArray(out, `source.${side}`, `${side === "left" ? "左" : "右"} / 合成電源電圧`, "電極・回路", "V", voltageTime.map(v => v * 1e6), voltageTime.map(t => electrodeVoltage(settings[side], t)), "t [µs]", "電源波形がありません。", "DC・RF・CSV を合成した電源の電圧です。阻止コンデンサがある場合は電極電位と異なります。");
}

export function liveQuantities(frame: Frame, started: Started, frames: Frame[] = []): PlotQuantity[] {
  const out: PlotQuantity[] = [], catalog = frame.diagnostic_catalog ?? frame.diagnostics?.catalog ?? started.diagnostic_catalog;
  const latest = frame.diagnostics ?? { x: started.x, phi: frame.phi, n_e: frame.n_e, n_i: frame.n_i };
  for (const spec of mergedSpecs(fields, catalog, "profiles")) addArray(out, `latest.${spec.key}`, spec.label, "現在の場・流体量", spec.unit, latest.x.map(v => v * 1e3), numericValues(latest[spec.key]), "x [mm]", spec.key === "ionization" ? "瞬時の電離生成率は集計していません。結果の時間平均または RF 位相分解で確認できます。" : spec.key === "lambda_debye" && numericValues(latest[spec.key]).length ? "電子密度または熱温度が 0 のため、Debye 長が全節点で未定義です。" : "このライブ診断量はまだ受信していません。", [spec.note, momentNote(latest)].filter(Boolean).join(" "));
  addParticles(out, latest, catalog, { electron: frame.sample, ion: frame.ion_sample });
  const samples = frames.length ? frames : [frame];
  for (const spec of mergedSpecs(histories, catalog, "history").filter(v => !["step", "t", "field_t"].includes(v.key))) {
    const diagnostic = samples.some(f => Object.hasOwn(f.diagnostic_counts ?? {}, spec.key));
    const unique = new Map<number, Frame>();
    if (diagnostic) for (const sample of samples) if (Object.hasOwn(sample.diagnostic_counts ?? {}, spec.key)) unique.set(sample.diagnostic_counts?.step ?? sample.step, sample);
    const historyFrames = diagnostic ? [...unique.values()] : samples;
    const values = historyFrames.map(f => diagnostic ? f.diagnostic_counts?.[spec.key] ?? null : f.counts[spec.key] ?? null);
    const x = historyFrames.map(f => (diagnostic ? f.diagnostic_counts?.t ?? f.t : f.t) * 1e6);
    addArray(out, `history.${spec.key}`, spec.label, "ライブの時間履歴", spec.unit, x, values, "t [µs]", "この量のライブ履歴はまだ受信していません。計算結果では全履歴を確認できます。", `${spec.note ?? ""} 画面が受信した直近 2,000 フレームの履歴です。`.trim(), historyFrames.length === 1);
  }
  addExternalLive(out, frame, frames);
  return out;
}

export function filterQuantities(items: PlotQuantity[], search: string, category = "all", availableOnly = false) {
  const query = search.trim().toLocaleLowerCase();
  return items.filter(item => (category === "all" || item.category === category) && (!availableOnly || !item.unavailable) && (!query || `${item.label} ${item.id} ${item.unit} ${item.note ?? ""}`.toLocaleLowerCase().includes(query)));
}
