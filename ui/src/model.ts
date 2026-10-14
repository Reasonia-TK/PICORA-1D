import { normalizeExternalCircuit, validateExternalCircuit, type ExternalCircuitSettings } from "./circuitmodel";

export interface RF { amplitude: number; freq_hz: number; phase_deg?: number }
export interface Waveform { freq_hz: number; phase: number[]; v: number[] }
export interface Electrode {
  v_dc: number; see_gamma: number; voltage_rf?: RF | RF[] | null; waveforms: Waveform[];
  fn?: { phi_ev: number; beta: number; init_energy_ev: number; macro_weight: number | null } | null;
  blocking_capacitor?: { capacitance: number; initial_bias_v: number } | null;
}
export interface Process { kind: string; label: string; threshold_ev: number; energy_ev: number[]; sigma_m2: number[]; mass_ratio?: number }
export interface MCC { gas: { name: string; pressure_pa: number; temperature_k: number }; electron_processes: Process[]; ion_processes: Process[]; ionization_split: "half" | "random"; ion_energy_frame: "lab" | "com"; seed: number; use_dsmc_gas?: boolean }
export interface Convergence { enabled: boolean; tol: number | null; rf_periods: number; steps: number | null; hold: number; stop: boolean; max_window: number }
export interface EedfRegion { x1: number; x2: number; label: string; bins: number; e_max_ev: number | null }
export interface Settings {
  external_circuit?: ExternalCircuitSettings | null;
  gap_m: number; n_cells: number; left: Electrode; right: Electrode; init_density_m3: number; init_te_ev: number; init_ti_ev: number; ion_mass_amu: number; n_macro: number; dt: number | null; n_steps: number; frame_every: number; avg_steps: number | null; phase_bins: number; mcc: MCC | null; see_energy_ev: number; eedf_regions: EedfRegion[]; wall_iedf_bins: number; seed: number; convergence: Convergence; parallel: boolean; cpu_threads: number | null;
  [key: string]: unknown;
}
export type NumericValues = (number | null)[];
export interface QuantitySpec { scope: "profiles" | "history" | "particles" | "cycle"; key: string; label: string; unit: string; note?: string }
export interface ParticleSample { x: number[]; vx: number[]; vy?: number[]; vz?: number[]; w?: number[]; energy?: number[]; ex?: number[]; ax?: number[]; total_count?: number }
export interface LatestDiagnostics { x: number[]; particles?: { electron?: ParticleSample; ion?: ParticleSample }; catalog?: QuantitySpec[]; [key: string]: unknown }
export interface CrossSection { species: string; label: string; kind: string; threshold_ev: number; energy_ev: number[]; sigma_m2: number[]; speed_m_s: number[]; nu_s: number[]; energy_frame?: "lab" | "com"; reference_mass_kg?: number; note?: string }
export interface PhysicalParameter { key: string; label: string; value: number; unit: string; note?: string }
export interface Diagnostics { catalog: QuantitySpec[]; history: Record<string, NumericValues>; latest: LatestDiagnostics | null; cross_sections: CrossSection[]; sampling?: Record<string, unknown>; constants?: Record<string, number>; parameters?: PhysicalParameter[] }
export interface Execution { requested_parallel: boolean; enabled: boolean; threads: number; max_threads: number; backend: string; fallback_reason?: string | null }
export interface Profile { x: number[]; phi: number[]; e: number[]; n_e: number[]; n_i: number[]; t_e: number[]; ionization: number[]; avg_steps: number; [key: string]: NumericValues | number }
export interface Distribution { label?: string; e_centers: number[]; f: number[]; mean_energy_ev: number; t_eff_ev?: number; overflow_frac?: number; n_samples: number; total_weight: number }
export interface CircuitElectrode { label: string; t: number[]; v_dc: number[]; v1: number[]; i_dc: number[]; last_period?: { t: number[]; v: number[] } | null; v_e?: number | null; q_node?: number | null; capacitance?: number; rf_division?: number; initial_bias_v?: number; c_self?: number }
export interface ExternalCircuitSignal { key: string; label: string; unit: string; note?: string }
export interface ExternalCircuitResult { enabled: boolean; method?: string; area_m2?: number; history: Record<string, NumericValues>; catalog: ExternalCircuitSignal[]; latest: Record<string, number | null>; metadata?: Record<string, unknown>; nodes?: { id: string; label: string; endpoints?: unknown[] }[] }
export interface ConvResult { tol: number; period: number[]; step: number[]; t: number[]; status: string[]; d: Record<string, (number | null)[]>; r: Record<string, (number | null)[]>; noise?: Record<string, (number | null)[]>; res?: Record<string, (number | null)[]>; converged: boolean; converged_step: number | null; now_passing: boolean; stopped: boolean }
export interface Result {
  external_circuit?: ExternalCircuitResult | null;
  settings: Settings; profiles: Profile | null; history: Record<string, number[]>; elapsed_s: number; timing: Record<string, number>; eedf: Distribution[]; diagnostics?: Diagnostics; execution?: Execution;
  sheath?: { left_s: number | null; right_s: number | null } | null;
  cycle: { bins: number; freq_hz: number; phi: number[][]; n_e: number[][]; n_i: number[][]; e?: number[][]; rho?: number[][]; ionization?: number[][]; samples?: number[]; sheath?: { s_left: (number | null)[]; s_right: (number | null)[] }; [key: string]: unknown } | null;
  sheath_ts?: { t: number[]; s_left: (number | null)[]; s_right: (number | null)[] } | null;
  sheath_fft?: { freq_hz: number[]; amp_left: number[]; amp_right: number[]; f0_hz: number | null; df_hz: number; n_samples: number } | null;
  wall_iedf?: { left: Distribution; right: Distribution } | null;
  circuit?: { electrodes: CircuitElectrode[]; units: { current: string; capacitance: string; charge: string }; c_matrix?: number[][]; period_s?: number | null } | null;
  convergence?: ConvResult | null;
  walls?: { left: { electron: number; ion: number }; right: { electron: number; ion: number } };
  fn?: { left: { j_avg: number; total_w: number } | null; right: { j_avg: number; total_w: number } | null } | null;
}
export interface Frame { external_circuit?: ExternalCircuitResult | null; type: "frame"; step: number; t: number; phi: number[]; n_e: number[]; n_i: number[]; counts: Record<string, number>; diagnostic_counts?: Record<string, number | null>; elapsed_s: number; sample?: ParticleSample; ion_sample?: ParticleSample; diagnostics?: LatestDiagnostics; diagnostic_catalog?: QuantitySpec[]; execution?: Execution; circuit?: { label: string; v_e: number; v_dc?: number; v1?: number }[] | null; convergence?: { status: string; checks: number; tol: number; worst: number | null; res?: number | null; converged: boolean } | null }
export interface Started { type: "started"; n_steps: number; step_offset: number; dt: number; x: number[]; warnings: string[]; diagnostic_catalog?: QuantitySpec[]; execution?: Execution }
export type RunEvent = Started | Frame | { type: "done"; result: Result } | { type: "error"; detail: string };
export interface SavedRun { id: string; label: string; created: string; settings: Settings; result: Result; stopped?: boolean; sweepValue?: number }
export interface LoadedProject { settings: Settings; runs: SavedRun[] }
export const defaultElectrode = (): Electrode => ({ v_dc: 0, see_gamma: 0, voltage_rf: null, waveforms: [], fn: null, blocking_capacitor: null });
export const defaultConvergence = (): Convergence => ({ enabled: true, tol: null, rf_periods: 1, steps: null, hold: 3, stop: false, max_window: 20 });
export const defaultMcc = (): MCC => ({ gas: { name: "Ar", pressure_pa: 10, temperature_k: 300 }, electron_processes: [], ion_processes: [], ionization_split: "half", ion_energy_frame: "lab", seed: 0, use_dsmc_gas: false });
export const defaultSettings = (): Settings => ({ gap_m: 0.02, n_cells: 128, left: defaultElectrode(), right: defaultElectrode(), init_density_m3: 1e14, init_te_ev: 2, init_ti_ev: 0.03, ion_mass_amu: 39.948, n_macro: 5000, dt: null, n_steps: 1000, frame_every: 20, avg_steps: null, phase_bins: 40, mcc: null, see_energy_ev: 2, eedf_regions: [], wall_iedf_bins: 100, seed: 0, convergence: defaultConvergence(), parallel: true, cpu_threads: null });

function object(v: unknown): Record<string, unknown> | null { return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
export function normalizeSettings(input: unknown): Settings {
  const s = object(input);
  if (!s || !Object.hasOwn(s, "gap_m") || !Object.hasOwn(s, "init_density_m3")) throw new Error("1D PIC の設定 (gap_m / init_density_m3) が見つかりません。");
  const defaults = defaultSettings();
  const electrode = (raw: unknown) => {
    const e = object(raw);
    return { ...defaultElectrode(), ...e,
      ...(object(e?.fn) ? { fn: { phi_ev: 4.5, beta: 1, init_energy_ev: 0.1, macro_weight: null, ...object(e?.fn) } } : {}),
      ...(object(e?.blocking_capacitor) ? { blocking_capacitor: { initial_bias_v: 0, ...object(e?.blocking_capacitor) } } : {}),
    };
  };
  const normalized = { ...defaults, ...s, left: electrode(s.left), right: electrode(s.right), convergence: { ...defaultConvergence(), ...object(s.convergence) },
    ...(object(s.mcc) ? { mcc: { ...defaultMcc(), ...object(s.mcc), gas: { ...defaultMcc().gas, ...object(object(s.mcc)?.gas) } } } : {}),
    ...(Array.isArray(s.eedf_regions) ? { eedf_regions: s.eedf_regions.map(r => object(r) ? { label: "", bins: 100, e_max_ev: null, ...object(r) } : r) } : {}),
  } as Settings;
  if (s.external_circuit !== undefined && s.external_circuit !== null) normalized.external_circuit = normalizeExternalCircuit(s.external_circuit);
  const errors = validateSettings(normalized, true); if (errors.length) throw new Error(errors.join("\n"));
  return normalized;
}
export function validateSettings(s: Settings, allowIncompleteCircuit = false): string[] {
  const errors: string[] = [];
  if (!allowIncompleteCircuit && s.external_circuit) errors.push(...validateExternalCircuit(s.external_circuit));
  if (!allowIncompleteCircuit && s.external_circuit?.enabled && (s.left?.blocking_capacitor || s.right?.blocking_capacitor)) errors.push("外部回路連成と従来の阻止コンデンサは同時に使用できません。回路図にキャパシタを配置してください。");
  if (typeof s.parallel !== "boolean" || (s.cpu_threads !== null && (!Number.isInteger(s.cpu_threads) || s.cpu_threads < 1))) errors.push("CPU 並列計算の設定は真偽値、スレッド数は正の整数または null が必要です。");
  for (const [key, label] of [["gap_m", "ギャップ"], ["init_density_m3", "初期密度"], ["init_te_ev", "電子温度"], ["init_ti_ev", "イオン温度"], ["ion_mass_amu", "イオン質量"]] as const) if (!Number.isFinite(s[key]) || s[key] <= 0) errors.push(`${label}は正の数が必要です。`);
  for (const [key, label, min, max] of [["n_cells", "セル数", 8, 100000], ["n_macro", "マクロ粒子数", 1, Infinity], ["n_steps", "ステップ数", 1, Infinity], ["frame_every", "フレーム間隔", 1, Infinity], ["phase_bins", "位相ビン数", 0, Infinity], ["wall_iedf_bins", "壁 IEDF ビン数", 0, 1000]] as const) if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) errors.push(`${label}は ${min} 以上${Number.isFinite(max) ? ` ${max} 以下` : ""}の整数が必要です。`);
  for (const key of ["dt", "avg_steps"] as const) if (s[key] !== null && (!Number.isFinite(s[key]) || s[key] <= 0 || (key === "avg_steps" && !Number.isInteger(s[key])))) errors.push(`${key} は正の値または null が必要です。`);
  for (const side of ["left", "right"] as const) {
    const e = s[side]; if (!object(e)) { errors.push(`${side} の電極設定が不正です。`); continue; }
    if (!Number.isFinite(e.v_dc) || !Number.isFinite(e.see_gamma) || e.see_gamma < 0 || e.see_gamma > 1) errors.push(`${side}: DC 電圧または SEE 収率が不正です。`);
    for (const rf of rfComponents(e.voltage_rf)) if (!object(rf) || !Number.isFinite(rf.amplitude) || !Number.isFinite(rf.freq_hz) || rf.freq_hz <= 0 || !Number.isFinite(rf.phase_deg ?? 0)) errors.push(`${side}: RF は有限の振幅・正の周波数が必要です。`);
    if (!Array.isArray(e.waveforms)) { errors.push(`${side}: waveforms は配列が必要です。`); continue; }
    for (const w of e.waveforms) if (!object(w) || !Number.isFinite(w.freq_hz) || w.freq_hz <= 0 || !Array.isArray(w.phase) || !Array.isArray(w.v) || w.phase.length < 2 || w.phase.length !== w.v.length || w.phase.some((v, i) => !Number.isFinite(v) || v < 0 || v >= 1 || (i > 0 && v <= w.phase[i - 1])) || w.v.some(v => !Number.isFinite(v))) errors.push(`${side}: CSV 波形の位相・電圧データが不正です。`);
    if (e.fn && (!object(e.fn) || !Number.isFinite(e.fn.phi_ev) || e.fn.phi_ev <= 0 || !Number.isFinite(e.fn.beta) || e.fn.beta <= 0 || !Number.isFinite(e.fn.init_energy_ev) || e.fn.init_energy_ev < 0 || (e.fn.macro_weight !== null && (!Number.isFinite(e.fn.macro_weight) || e.fn.macro_weight <= 0)))) errors.push(`${side}: FN の仕事関数・増倍係数・重みが不正です。`);
    if (e.blocking_capacitor && (!object(e.blocking_capacitor) || !Number.isFinite(e.blocking_capacitor.capacitance) || e.blocking_capacitor.capacitance <= 0 || !Number.isFinite(e.blocking_capacitor.initial_bias_v))) errors.push(`${side}: 阻止コンデンサの容量・初期電圧が不正です。`);
  }
  if (!Array.isArray(s.eedf_regions) || s.eedf_regions.length > 4) errors.push("EEDF 集計領域は 4 個までです。");
  else for (const r of s.eedf_regions) {
    if (!object(r) || !Number.isFinite(r.x1) || !Number.isFinite(r.x2) || r.x1 < 0 || r.x2 > s.gap_m || r.x1 >= r.x2) errors.push("EEDF 集計区間は 0 ≤ x1 < x2 ≤ ギャップが必要です。");
    else if (!Number.isInteger(r.bins) || r.bins < 10 || r.bins > 1000 || (r.e_max_ev !== null && (!Number.isFinite(r.e_max_ev) || r.e_max_ev <= 0))) errors.push("EEDF ビン数 (10〜1000) または最大エネルギーが不正です。");
  }
  if (!Number.isInteger(s.seed) || !Number.isFinite(s.see_energy_ev) || s.see_energy_ev < 0) errors.push("乱数シードまたは SEE 放出エネルギーが不正です。");
  const c = s.convergence;
  if (!object(c) || typeof c.enabled !== "boolean" || typeof c.stop !== "boolean" || (c.tol !== null && (!Number.isFinite(c.tol) || c.tol <= 0 || c.tol >= 1)) || !Number.isInteger(c.rf_periods) || c.rf_periods < 1 || c.rf_periods > 10000 || !Number.isInteger(c.hold) || c.hold < 1 || c.hold > 1000 || !Number.isInteger(c.max_window) || c.max_window < 1 || c.max_window > 200 || (c.steps !== null && (!Number.isInteger(c.steps) || c.steps < 1))) errors.push("収束判定の閾値・周期・連続回数が不正です。");
  if (s.mcc !== null) {
    const m = s.mcc;
    if (!object(m) || !object(m.gas) || typeof m.gas.name !== "string" || !Number.isFinite(m.gas.pressure_pa) || m.gas.pressure_pa <= 0 || !Number.isFinite(m.gas.temperature_k) || m.gas.temperature_k <= 0 || !Number.isInteger(m.seed) || !["half", "random"].includes(m.ionization_split) || !["lab", "com"].includes(m.ion_energy_frame)) errors.push("MCC の背景ガス・エネルギー分配設定が不正です。");
    else {
      if (m.use_dsmc_gas) errors.push("1D PIC は DSMC 連成を利用できません。");
      for (const processes of [m.electron_processes, m.ion_processes]) {
        if (!Array.isArray(processes)) { errors.push("MCC の衝突過程は配列が必要です。"); continue; }
        for (const p of processes) if (!object(p) || typeof p.label !== "string" || !["elastic", "excitation", "ionization", "isotropic", "backscat"].includes(p.kind) || !Array.isArray(p.energy_ev) || !Array.isArray(p.sigma_m2) || !p.energy_ev.length || p.energy_ev.length !== p.sigma_m2.length || p.energy_ev.some(v => !Number.isFinite(v)) || p.sigma_m2.some(v => !Number.isFinite(v) || v < 0)) errors.push("MCC の断面積テーブルが不正です。");
      }
    }
  }
  return errors;
}
export function loadProject(raw: unknown): LoadedProject {
  const o = object(raw); if (!o) throw new Error("JSON はオブジェクトが必要です。");
  const p = object(o.project) ?? o;
  const settings = normalizeSettings(p.pic1d ?? o.settings ?? p);
  const runs: SavedRun[] = [];
  if (Array.isArray(o.runs)) for (const r of o.runs) {
    const run = object(r); if (!run || !isResult(run.result)) throw new Error("保存された実行結果の形式が不正です。");
    runs.push({ ...run, id: crypto.randomUUID(), label: String(run.label ?? "読込結果"), created: String(run.created ?? new Date().toISOString()), settings: normalizeSettings(run.settings ?? (run.result as Result).settings ?? settings), result: run.result } as SavedRun);
  }
  const result = object(o.results)?.pic1d ?? o.result ?? (isResult(o) ? o : null);
  if (result !== null) { if (!isResult(result)) throw new Error("1D PIC の結果データが不正です。"); runs.push({ id: crypto.randomUUID(), label: "読込結果", created: new Date().toISOString(), settings: normalizeSettings(result.settings ?? settings), result }); }
  return { settings, runs };
}
export function isResult(value: unknown): value is Result {
  const o = object(value); return Boolean(o && object(o.history) && typeof o.elapsed_s === "number" && (o.profiles === null || (object(o.profiles) && Array.isArray((o.profiles as Profile).x))));
}
export function saveProject(settings: Settings, runs: SavedRun[] = []) { return JSON.stringify({ format: "picora1d", version: 1, project: { pic1d: settings }, ...(runs.length ? { runs } : {}) }, null, 2); }
export function rfComponents(rf: RF | RF[] | null | undefined): RF[] { return !rf ? [] : Array.isArray(rf) ? rf : [rf]; }
export function parseWaveformCsv(text: string): Waveform {
  const points = new Map<number, number>();
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const cells = line.trim().split(/[,\t\s]+/); if (cells.length < 2) continue;
    const t = Number(cells[0]), v = Number(cells[1]); if (Number.isFinite(t) && Number.isFinite(v)) points.set(t, v);
  }
  const rows = [...points].sort((a, b) => a[0] - b[0]);
  if (rows.length < 3) throw new Error("CSV には時刻 [s]・電圧 [V] の異なる時刻の行が 3 行以上必要です。");
  const start = rows[0][0], span = rows.at(-1)![0] - start;
  return { freq_hz: 1 / span, phase: rows.slice(0, -1).map(r => (r[0] - start) / span), v: rows.slice(0, -1).map(r => r[1]) };
}
export function waveformVoltage(w: Waveform, t: number): number {
  if (w.phase.length < 2) return 0;
  const phase = ((t * w.freq_hz) % 1 + 1) % 1;
  const xp = [...w.phase, w.phase[0] + 1], yp = [...w.v, w.v[0]];
  return interpolate(xp, yp, phase < xp[0] ? phase + 1 : phase);
}
export function electrodeVoltage(e: Electrode, t: number): number { return e.v_dc + rfComponents(e.voltage_rf).reduce((v, r) => v + r.amplitude * Math.sin(2 * Math.PI * r.freq_hz * t + (r.phase_deg ?? 0) * Math.PI / 180), 0) + e.waveforms.reduce((v, w) => v + waveformVoltage(w, t), 0); }
export function externalSourceVoltage(parameters: Record<string, unknown>, t: number): number {
  const w = object(parameters.waveform), dc = Number(parameters.dc_v ?? 0);
  if (!w || w.kind === "dc") return dc;
  const num = (key: string, fallback: number) => Number(w[key] ?? fallback);
  if (w.kind === "sin") return num("offset_v", dc) + num("amplitude_v", 100) * Math.sin(2 * Math.PI * num("frequency_hz", 13.56e6) * Math.max(0, t - num("delay_s", 0)) + num("phase_deg", 0) * Math.PI / 180);
  if (w.kind === "pulse") {
    const low = num("initial_v", 0), high = num("pulsed_v", 100), delay = num("delay_s", 0), period = num("period_s", 2e-6);
    if (t < delay || period <= 0) return low;
    const phase = (t - delay) % period, rise = num("rise_s", 1e-9), width = num("width_s", 1e-6), fall = num("fall_s", 1e-9);
    if (phase < rise) return low + (high - low) * phase / rise;
    if (phase < rise + width) return high;
    if (phase < rise + width + fall) return high + (low - high) * (phase - rise - width) / fall;
    return low;
  }
  if (w.kind === "pwl" && Array.isArray(w.points)) { const points = w.points as [number, number][]; return interpolate(points.map(p => p[0]), points.map(p => p[1]), t); }
  return NaN;
}
export function externalFrequencies(s: Settings): number[] {
  if (!s.external_circuit?.enabled) return [];
  return s.external_circuit.document.components.flatMap(c => {
    if (c.kind === "S") return Number(c.parameters.period_s) > 0 ? [1 / Number(c.parameters.period_s)] : [];
    if (c.kind !== "V") return [];
    const w = object(c.parameters.waveform);
    return w?.kind === "sin" ? [Number(w.frequency_hz)] : w?.kind === "pulse" && Number(w.period_s) > 0 ? [1 / Number(w.period_s)] : [];
  }).filter(f => Number.isFinite(f) && f > 0);
}
export function frequencies(s: Settings): number[] { return s.external_circuit?.enabled ? externalFrequencies(s) : [s.left, s.right].flatMap(e => [...rfComponents(e.voltage_rf).map(r => r.freq_hz), ...e.waveforms.map(w => w.freq_hz)]).filter(f => f > 0); }
/** コアと同じ優先順位: RF があれば RF の最低周波数、無ければ CSV の最低周波数。 */
export function cycleFrequency(s: Settings): number | null {
  if (s.external_circuit?.enabled) { const f = externalFrequencies(s); return f.length ? Math.min(...f) : null; }
  const rf = [s.left, s.right].flatMap(e => rfComponents(e.voltage_rf).map(r => r.freq_hz)).filter(f => f > 0);
  const candidates = rf.length ? rf : [s.left, s.right].flatMap(e => e.waveforms.map(w => w.freq_hz)).filter(f => f > 0);
  return candidates.length ? Math.min(...candidates) : null;
}
export function interpolate(x: number[], y: (number | null)[], at: number): number {
  if (!x.length || !y.length) return NaN;
  if (at <= x[0]) return y[0] ?? NaN; if (at >= x.at(-1)!) return y.at(-1) ?? NaN;
  let lo = 0, hi = x.length - 1; while (hi - lo > 1) { const m = (hi + lo) >> 1; if (x[m] <= at) lo = m; else hi = m; }
  return y[lo] === null || y[hi] === null ? NaN : y[lo]! + (at - x[lo]) / (x[hi] - x[lo]) * (y[hi]! - y[lo]!);
}
export function numericPath(s: Settings, path: string): number {
  const parts = path.replace(/^pic1d\./, "").split("."); let v: unknown = s;
  for (const p of parts) { if (v === null || typeof v !== "object") throw new Error("掃引対象がありません。"); v = (v as Record<string, unknown>)[p]; }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("掃引対象は設定中の数値項目が必要です。"); return v;
}
export function setNumericPath(s: Settings, path: string, value: number): Settings {
  numericPath(s, path); const next = structuredClone(s), parts = path.replace(/^pic1d\./, "").split("."); let v = next as unknown as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) v = v[p] as Record<string, unknown>; v[parts.at(-1)!] = value; return next;
}
export function sweepValues(text: string): number[] {
  const pieces = text.trim().split(/[,\s]+/).filter(Boolean); const values = pieces.map(Number);
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error("掃引値をカンマまたは空白で区切って入力してください。");
  if (values.length > 100) throw new Error("1 回の掃引は 100 ケースまでです。"); return values;
}
export function rangeValues(start: number, end: number, count: number, log: boolean): number[] {
  if (![start, end, count].every(Number.isFinite) || !Number.isInteger(count) || count < 2 || count > 100 || (log && (start <= 0 || end <= 0))) throw new Error("範囲の値とケース数 (2〜100)、対数の正値を確認してください。");
  return Array.from({ length: count }, (_, i) => log ? Math.exp(Math.log(start) + (Math.log(end) - Math.log(start)) * i / (count - 1)) : start + (end - start) * i / (count - 1));
}
export function csvText(header: string[], columns: (number | string | null | undefined)[][]): string {
  const quote = (v: number | string | null | undefined) => { if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return ""; const s = String(v); return /[,"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  const n = Math.max(0, ...columns.map(c => c.length)); return [header.map(quote).join(","), ...Array.from({ length: n }, (_, i) => columns.map(c => quote(c[i])).join(","))].join("\n") + "\n";
}
export function numberText(v: number | null | undefined, digits = 3) { return v === null || v === undefined || !Number.isFinite(v) ? "—" : Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 0.001) ? v.toExponential(digits) : Number(v.toPrecision(digits + 1)).toLocaleString("ja-JP"); }
