/** Circuit graphs use explicit terminals: crossings are never implicit connections. */
export type CircuitJson = null | boolean | number | string | CircuitJson[] | { [key: string]: CircuitJson };
export type CircuitKind = "R" | "C" | "L" | "D" | "COAX" | "COAX_GND" | "S" | "V" | "GND" | "PIC";
export interface CircuitEndpoint { component_id: string; port: string }
export interface CircuitComponent {
  id: string; kind: CircuitKind; label: string; ports: string[];
  parameters: Record<string, CircuitJson>; position: { x: number; y: number }; rotation: number;
}
export interface CircuitWire { id: string; source: CircuitEndpoint; target: CircuitEndpoint }
export interface CircuitNodeLabel extends CircuitEndpoint { name: string }
export interface CircuitDocument { schema_version: 1; name: string; components: CircuitComponent[]; wires: CircuitWire[]; node_labels?: CircuitNodeLabel[] }
export interface ExternalCircuitSettings {
  enabled: boolean; area_m2: number; temperature_k: number; document: CircuitDocument; max_iterations: number;
}
export interface CircuitField {
  key: string; label: string; unit?: string; min?: number; max?: number;
  exclusiveMin?: boolean; exclusiveMax?: boolean; integer?: boolean; optional?: boolean; hint?: string;
}
export const circuitKinds: CircuitKind[] = ["R", "C", "L", "D", "COAX", "COAX_GND", "S", "V", "GND", "PIC"];
export const circuitLabels: Record<CircuitKind, string> = {
  R: "抵抗", C: "キャパシタンス", L: "インダクタンス", D: "ダイオード（詳細版）", COAX: "同軸ケーブル（4 端子）",
  COAX_GND: "同軸ケーブル（接地シールド）", S: "スイッチ", V: "電圧源", GND: "接地（GND）", PIC: "1D PIC プラズマ",
};
export const circuitPorts: Record<CircuitKind, string[]> = {
  R: ["p", "n"], C: ["p", "n"], L: ["p", "n"], D: ["p", "n"], S: ["p", "n"], V: ["p", "n"],
  COAX: ["p1", "n1", "p2", "n2"], COAX_GND: ["p1", "p2"], GND: ["g"], PIC: ["left", "right"],
};
export const diodeDefaults: Record<string, CircuitJson> = {
  IS: 1e-14, N: 1, RS: 0.1, CJO: 1e-12, VJ: 1, M: 0.5, TT: 0, EG: 1.11, XTI: 3, FC: 0.5, TNOM: 27, IBV: 1e-3,
};
export const diodeFields: CircuitField[] = [
  { key: "IS", label: "飽和電流 IS", unit: "A", min: 0, exclusiveMin: true },
  { key: "N", label: "理想係数 N", min: 0, exclusiveMin: true },
  { key: "RS", label: "直列抵抗 RS", unit: "Ω", min: 0 },
  { key: "BV", label: "逆ブレーク電圧 BV", unit: "V", min: 0, exclusiveMin: true, optional: true, hint: "空欄: 逆降伏なし" },
  { key: "IBV", label: "ブレーク時電流 IBV", unit: "A", min: 0, exclusiveMin: true },
  { key: "CJO", label: "ゼロバイアス接合容量 CJO", unit: "F", min: 0 },
  { key: "VJ", label: "接合電位 VJ", unit: "V", min: 0, exclusiveMin: true },
  { key: "M", label: "接合傾斜係数 M", min: 0 },
  { key: "TT", label: "走行時間 TT", unit: "s", min: 0 },
  { key: "EG", label: "エネルギーギャップ EG", unit: "eV", min: 0, exclusiveMin: true },
  { key: "XTI", label: "飽和電流の温度指数 XTI" },
  { key: "FC", label: "接合容量の順方向係数 FC", min: 0, max: 1, exclusiveMax: true },
  { key: "TNOM", label: "モデル基準温度 TNOM", unit: "°C", min: -273.15, exclusiveMin: true },
];
export const coaxDefaults: Record<string, CircuitJson> = {
  inner_diameter_m: 1e-3, shield_inner_diameter_m: 3.35e-3, length_m: 1,
  relative_permittivity: 2.1, relative_permeability: 1, loss_tangent: 2e-4,
  inner_resistivity_ohm_m: 1.724e-8, shield_resistivity_ohm_m: 1.724e-8,
  shield_thickness_m: 0.15e-3, reference_frequency_hz: 40e6, segments: 32,
};
export const coaxFields: CircuitField[] = [
  { key: "inner_diameter_m", label: "内部導体の直径", unit: "m", min: 0, exclusiveMin: true },
  { key: "shield_inner_diameter_m", label: "シールドの内径", unit: "m", min: 0, exclusiveMin: true },
  { key: "length_m", label: "ケーブルの長さ", unit: "m", min: 0, exclusiveMin: true },
  { key: "relative_permittivity", label: "比誘電率 εr", min: 0, exclusiveMin: true },
  { key: "relative_permeability", label: "比透磁率 μr", min: 0, exclusiveMin: true },
  { key: "loss_tangent", label: "誘電正接 tan δ", min: 0, max: 1, exclusiveMax: true },
  { key: "inner_resistivity_ohm_m", label: "内部導体の抵抗率", unit: "Ω·m", min: 0 },
  { key: "shield_resistivity_ohm_m", label: "シールドの抵抗率", unit: "Ω·m", min: 0 },
  { key: "shield_thickness_m", label: "シールドの厚さ", unit: "m", min: 0, exclusiveMin: true },
  { key: "reference_frequency_hz", label: "損失の基準周波数", unit: "Hz", min: 0, exclusiveMin: true },
  { key: "segments", label: "線路の分割数", min: 1, max: 256, integer: true },
];
export const switchFields: CircuitField[] = [
  { key: "on_resistance_ohm", label: "ON 抵抗", unit: "Ω", min: 0, exclusiveMin: true },
  { key: "off_resistance_ohm", label: "OFF 抵抗", unit: "Ω", min: 0, exclusiveMin: true },
  { key: "on_time_s", label: "ON 開始時刻", unit: "s", min: 0 },
  { key: "off_time_s", label: "OFF 切替時刻", unit: "s", min: 0, optional: true, hint: "空欄: 時刻による OFF なし" },
  { key: "period_s", label: "繰り返し周期", unit: "s", min: 0, exclusiveMin: true, optional: true, hint: "空欄: 単発切替" },
  { key: "duty", label: "繰り返しの ON 比率", min: 0, max: 1 },
];
export function defaultCircuitDocument(): CircuitDocument {
  return { schema_version: 1, name: "外部回路", components: [{ id: "pic", kind: "PIC", label: "1D PIC", ports: ["left", "right"], parameters: {}, position: { x: 600, y: 320 }, rotation: 0 }], wires: [], node_labels: [] };
}
export function defaultExternalCircuit(): ExternalCircuitSettings {
  return { enabled: false, area_m2: 1, temperature_k: 300, document: defaultCircuitDocument(), max_iterations: 50 };
}
export function defaultCircuitParameters(kind: CircuitKind): Record<string, CircuitJson> {
  switch (kind) {
    case "R": return { value: 50 };
    case "C": return { value: 1e-9, initial_voltage_v: null };
    case "L": return { value: 1e-6, initial_current_a: null };
    case "D": return { area: 1, temperature_k: null, model_parameters: { ...diodeDefaults } };
    case "COAX": case "COAX_GND": return { ...coaxDefaults };
    case "V": return { dc_v: 0, waveform: { kind: "dc" } };
    case "S": return { on_resistance_ohm: 0.01, off_resistance_ohm: 1e12, initial_state: false, on_time_s: 0, off_time_s: null, period_s: null, duty: 0.5 };
    default: return {};
  }
}
export function defaultSourceWaveform(kind: string): Record<string, CircuitJson> {
  switch (kind) {
    case "sin": return { kind, offset_v: 0, amplitude_v: 100, frequency_hz: 13.56e6, phase_deg: 0, delay_s: 0 };
    case "pulse": return { kind, initial_v: 0, pulsed_v: 100, delay_s: 0, rise_s: 1e-9, fall_s: 1e-9, width_s: 1e-6, period_s: 2e-6 };
    case "pwl": return { kind, points: [[0, 0], [1e-6, 100]] };
    default: return { kind: "dc" };
  }
}
export const endpointKey = (e: CircuitEndpoint): string => `${e.component_id}:${e.port}`;
export function circuitId(document: CircuitDocument, prefix: string): string {
  const ids = new Set([...document.components.map(c => c.id), ...document.wires.map(w => w.id)]);
  let i = 1; while (ids.has(`${prefix.toLowerCase()}${i}`)) i += 1; return `${prefix.toLowerCase()}${i}`;
}
export function createCircuitComponent(document: CircuitDocument, kind: Exclude<CircuitKind, "PIC">, position?: { x: number; y: number }): CircuitComponent {
  const id = circuitId(document, kind === "COAX_GND" ? "cxg" : kind === "COAX" ? "cx" : kind);
  const i = document.components.length - 1;
  return { id, kind, label: id.toUpperCase(), ports: [...circuitPorts[kind]], parameters: defaultCircuitParameters(kind), position: position ?? { x: 180 + i % 5 * 180, y: 120 + Math.floor(i / 5) * 140 }, rotation: 0 };
}
export function hasEndpoint(document: CircuitDocument, e: CircuitEndpoint): boolean {
  return document.components.some(c => c.id === e.component_id && c.ports.includes(e.port));
}
export function connectCircuit(document: CircuitDocument, source: CircuitEndpoint, target: CircuitEndpoint): CircuitDocument {
  if (!hasEndpoint(document, source) || !hasEndpoint(document, target)) throw new Error("接続する端子がありません。");
  const a = endpointKey(source), b = endpointKey(target);
  if (a === b) throw new Error("同じ端子には配線できません。");
  if (document.wires.some(w => { const x = endpointKey(w.source), y = endpointKey(w.target); return a === x && b === y || a === y && b === x; })) throw new Error("この端子間は接続済みです。");
  return { ...document, wires: [...document.wires, { id: circuitId(document, "wire"), source: { ...source }, target: { ...target } }] };
}
export function removeCircuitComponent(document: CircuitDocument, id: string): CircuitDocument {
  if (document.components.find(c => c.id === id)?.kind === "PIC") return document;
  return { ...document, components: document.components.filter(c => c.id !== id), wires: document.wires.filter(w => w.source.component_id !== id && w.target.component_id !== id), node_labels: document.node_labels?.filter(l => l.component_id !== id) };
}
export function duplicateCircuitComponent(document: CircuitDocument, id: string): { document: CircuitDocument; component: CircuitComponent | null } {
  const original = document.components.find(c => c.id === id);
  if (!original || original.kind === "PIC") return { document, component: null };
  const component = { ...structuredClone(original), id: circuitId(document, original.kind.toLowerCase()), position: { x: original.position.x + 40, y: original.position.y + 80 } };
  component.label = component.id.toUpperCase();
  return { document: { ...document, components: [...document.components, component] }, component };
}
function record(v: unknown): Record<string, unknown> | null { return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
export function circuitObject(v: CircuitJson | undefined): Record<string, CircuitJson> { return record(v) as Record<string, CircuitJson> ?? {}; }
function jsonFinite(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(jsonFinite);
  const o = record(v); return o !== null && Object.values(o).every(jsonFinite);
}
function readEndpoint(raw: unknown): CircuitEndpoint {
  const o = record(raw);
  if (!o || typeof o.component_id !== "string" || typeof o.port !== "string") throw new Error("配線の端子形式が不正です。");
  return { component_id: o.component_id, port: o.port };
}
/** Structural validation deliberately permits partially wired documents to be saved. */
export function normalizeCircuitDocument(raw: unknown): CircuitDocument {
  const o = record(raw);
  if (!o || o.schema_version !== 1 || !Array.isArray(o.components) || !Array.isArray(o.wires)) throw new Error("回路は schema_version: 1 と components / wires の配列が必要です。");
  if (o.components.length > 128 || o.wires.length > 512) throw new Error("回路は素子 128 個、配線 512 本までです。");
  const ids = new Set<string>();
  const checkId = (id: unknown) => { if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error("素子・配線 ID は重複しない英数字・_・- が必要です。"); ids.add(id); return id; };
  const components = o.components.map(rawComponent => {
    const c = record(rawComponent), p = record(c?.position);
    if (!c || !circuitKinds.includes(c.kind as CircuitKind) || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("回路素子の種別・位置が不正です。");
    const kind = c.kind as CircuitKind, expected = circuitPorts[kind];
    const ports = c.ports;
    if (!Array.isArray(ports) || ports.length !== expected.length || !expected.every(port => ports.includes(port))) throw new Error(`${kind}: 端子が ${expected.join(" / ")} と一致しません。`);
    if (!record(c.parameters) || !jsonFinite(c.parameters) || !Number.isFinite(c.rotation ?? 0)) throw new Error(`${kind}: パラメータまたは回転角が不正です。`);
    const id = checkId(c.id), rotation = Number(c.rotation ?? 0), label = String(c.label ?? c.id);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || ![0, 90, 180, 270].includes(rotation) || label.length > 100) throw new Error("素子 ID は英字で始まる英数字・_、回転は 0/90/180/270°、名前は 100 文字以内です。");
    return { id, kind, label, ports: [...expected], parameters: structuredClone(c.parameters as Record<string, CircuitJson>), position: { x: p.x as number, y: p.y as number }, rotation };
  });
  if (components.filter(c => c.kind === "PIC").length !== 1 || components.find(c => c.kind === "PIC")?.id !== "pic") throw new Error("回路には固定 PIC 素子 (id=pic) が 1 個必要です。");
  if (typeof o.name === "string" && (!o.name.trim() || o.name.length > 200)) throw new Error("回路名は 1〜200 文字が必要です。");
  const document: CircuitDocument = { schema_version: 1, name: String(o.name ?? "外部回路"), components, wires: o.wires.map(w => { const r = record(w); if (!r) throw new Error("配線形式が不正です。"); return { id: checkId(r.id), source: readEndpoint(r.source), target: readEndpoint(r.target) }; }), node_labels: [] };
  for (const w of document.wires) if (!hasEndpoint(document, w.source) || !hasEndpoint(document, w.target) || endpointKey(w.source) === endpointKey(w.target)) throw new Error(`${w.id}: 配線の接続先が不正です。`);
  const pairs = new Set<string>();
  for (const w of document.wires) { const pair = [endpointKey(w.source), endpointKey(w.target)].sort().join("|"); if (pairs.has(pair)) throw new Error(`${w.id}: 同じ端子間の配線が重複しています。`); pairs.add(pair); }
  if (o.node_labels !== undefined && !Array.isArray(o.node_labels)) throw new Error("node_labels は配列が必要です。");
  document.node_labels = (o.node_labels as unknown[] | undefined ?? []).map(rawLabel => { const endpoint = readEndpoint(rawLabel), l = record(rawLabel); if (!hasEndpoint(document, endpoint) || typeof l?.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(l.name.trim())) throw new Error("ノード名は英字で始まる英数字・_ が必要です。"); return { ...endpoint, name: l.name.trim() }; });
  return document;
}
export function normalizeExternalCircuit(raw: unknown): ExternalCircuitSettings {
  const defaults = defaultExternalCircuit(), o = record(raw);
  if (!o) throw new Error("外部回路設定はオブジェクトが必要です。");
  const normalized = { ...defaults, ...o, document: normalizeCircuitDocument(o.document ?? defaults.document) } as ExternalCircuitSettings;
  if (typeof normalized.enabled !== "boolean" || ![normalized.area_m2, normalized.temperature_k, normalized.max_iterations].every(v => typeof v === "number" && Number.isFinite(v))) throw new Error("外部回路の有効設定・面積・温度・反復数が不正です。");
  return normalized;
}
/** Resolve equipotential nodes, including all ground symbols and a coax shield. */
export function resolveCircuitNodes(document: CircuitDocument): Map<string, string> {
  const parent = new Map<string, string>();
  for (const c of document.components) for (const p of c.ports) parent.set(endpointKey({ component_id: c.id, port: p }), endpointKey({ component_id: c.id, port: p }));
  const find = (key: string): string => { const p = parent.get(key); if (p === undefined) return key; if (p === key) return key; const root = find(p); parent.set(key, root); return root; };
  const union = (a: string, b: string) => { if (parent.has(a) && parent.has(b)) parent.set(find(b), find(a)); };
  for (const w of document.wires) union(endpointKey(w.source), endpointKey(w.target));
  const grounds = document.components.filter(c => c.kind === "GND").map(c => `${c.id}:g`);
  for (const c of document.components) if (c.kind === "COAX") union(`${c.id}:n1`, `${c.id}:n2`);
  for (const g of grounds.slice(1)) union(grounds[0], g);
  const groundRoot = grounds.length ? find(grounds[0]) : null, names = new Map<string, string>();
  if (groundRoot) names.set(groundRoot, "GND");
  for (const l of document.node_labels ?? []) { const root = find(endpointKey(l)); if (!names.has(root)) names.set(root, l.name); }
  let i = 0; const nodes = new Map<string, string>();
  for (const key of parent.keys()) { const root = find(key); if (!names.has(root)) names.set(root, `N${++i}`); nodes.set(key, names.get(root)!); }
  return nodes;
}
export function fieldError(field: CircuitField, value: number | null | undefined): string | null {
  if ((value === null || value === undefined) && field.optional) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field.label}に有限の数値を入力してください。`;
  if (field.integer && !Number.isInteger(value)) return `${field.label}は整数が必要です。`;
  if (field.min !== undefined && (field.exclusiveMin ? value <= field.min : value < field.min)) return `${field.label}は ${field.min} ${field.exclusiveMin ? "より大きい値" : "以上"}が必要です。`;
  if (field.max !== undefined && (field.exclusiveMax ? value >= field.max : value > field.max)) return `${field.label}は ${field.max} ${field.exclusiveMax ? "未満" : "以下"}が必要です。`;
  return null;
}
export function parseCircuitNumber(text: string, optional = false): number | null | undefined {
  if (!text.trim()) return optional ? null : undefined;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) return undefined;
  const value = Number(text); return Number.isFinite(value) ? value : undefined;
}
export function circuitDraftError(field: CircuitField, text: string): string | null {
  const value = parseCircuitNumber(text, field.optional);
  return value === undefined ? `${field.label}に完全な数値を入力してください。` : fieldError(field, value);
}
export function validateExternalCircuit(raw: ExternalCircuitSettings | null | undefined): string[] {
  if (!raw || raw.enabled === false) return [];
  let s: ExternalCircuitSettings;
  try { s = normalizeExternalCircuit(raw); } catch (e) { return [e instanceof Error ? e.message : String(e)]; }
  const errors: string[] = [], doc = s.document;
  const requireField = (field: CircuitField, value: unknown, prefix = "") => { const message = fieldError(field, value as number | null); if (message) errors.push(prefix + message); };
  requireField({ key: "area", label: "電極面積", min: 0, exclusiveMin: true }, s.area_m2);
  requireField({ key: "temp", label: "回路温度", min: 0, exclusiveMin: true }, s.temperature_k);
  requireField({ key: "iterations", label: "最大反復数", min: 10, max: 200, integer: true }, s.max_iterations);
  if (!doc.components.some(c => c.kind === "GND")) errors.push("接地（GND）素子を配置してください。");
  const nodes = resolveCircuitNodes({ ...doc, node_labels: [] }), connected = new Set(doc.wires.flatMap(w => [endpointKey(w.source), endpointKey(w.target)]));
  const labelsByNode = new Map<string, string>(), nodesByLabel = new Map<string, string>();
  for (const l of doc.node_labels ?? []) {
    const n = nodes.get(endpointKey(l))!;
    if (n === "GND") errors.push("接地ノードの名前は GND に固定されています。");
    if (labelsByNode.has(n) && labelsByNode.get(n) !== l.name) errors.push("同じノードには同じ名前を付けてください。");
    if (nodesByLabel.has(l.name.toLowerCase()) && nodesByLabel.get(l.name.toLowerCase()) !== n) errors.push("異なるノードに同じ名前を付けることはできません。");
    labelsByNode.set(n, l.name); nodesByLabel.set(l.name.toLowerCase(), n);
  }
  const pic = doc.components.find(c => c.kind === "PIC")!;
  for (const p of pic.ports) if (!connected.has(`${pic.id}:${p}`)) errors.push(`PIC の${p === "left" ? "左" : "右"}電極を外部回路に接続してください。`);
  if (nodes.get(`${pic.id}:left`) === nodes.get(`${pic.id}:right`)) errors.push("PIC の両電極を同じノードに短絡できません。");
  let totalSegments = 0;
  for (const c of doc.components) {
    const p = c.parameters, prefix = `${c.label || c.id}: `;
    if (c.kind !== "PIC") for (const port of c.ports) if (!connected.has(`${c.id}:${port}`)) errors.push(`${prefix}${port} 端子が未接続です。`);
    if (["R", "C", "L"].includes(c.kind)) requireField({ key: "value", label: circuitLabels[c.kind], min: 0, exclusiveMin: true }, p.value, prefix);
    if (c.kind === "C") requireField({ key: "initial_voltage_v", label: "初期電圧", optional: true }, p.initial_voltage_v, prefix);
    if (c.kind === "L") requireField({ key: "initial_current_a", label: "初期電流", optional: true }, p.initial_current_a, prefix);
    if (c.kind === "D") {
      requireField({ key: "area", label: "面積倍率", min: 0, exclusiveMin: true }, p.area ?? 1, prefix);
      requireField({ key: "temperature_k", label: "素子温度", min: 0, exclusiveMin: true, optional: true }, p.temperature_k, prefix);
      const model = { ...diodeDefaults, ...circuitObject(p.model_parameters) };
      for (const field of diodeFields) requireField(field, model[field.key], prefix);
    }
    if (c.kind === "COAX" || c.kind === "COAX_GND") {
      const values = { ...coaxDefaults, ...p }; for (const field of coaxFields) requireField(field, values[field.key], prefix);
      if (Number(values.shield_inner_diameter_m) <= Number(values.inner_diameter_m)) errors.push(`${prefix}シールド内径は内部導体直径より大きくしてください。`);
      totalSegments += Number(values.segments);
    }
    if (c.kind === "S") {
      for (const field of switchFields) requireField(field, p[field.key], prefix);
      if (typeof p.initial_state !== "boolean") errors.push(`${prefix}初期状態は真偽値が必要です。`);
      if (Number(p.off_resistance_ohm) < Number(p.on_resistance_ohm)) errors.push(`${prefix}OFF 抵抗は ON 抵抗以上にしてください。`);
      if (p.off_time_s !== null && p.off_time_s !== undefined && Number(p.off_time_s) <= Number(p.on_time_s)) errors.push(`${prefix}OFF 時刻は ON 開始時刻より後にしてください。`);
    }
    if (c.kind === "V") {
      requireField({ key: "dc_v", label: "DC 電圧" }, p.dc_v ?? 0, prefix);
      const w = circuitObject(p.waveform), kind = w.kind ?? "dc";
      if (!["dc", "sin", "pulse", "pwl"].includes(String(kind))) errors.push(`${prefix}電圧源の波形種別が不正です。`);
      if (kind === "sin") for (const [key, label, positive] of [["offset_v", "波形オフセット", false], ["amplitude_v", "振幅", false], ["frequency_hz", "周波数", true], ["phase_deg", "位相", false], ["delay_s", "開始遅延", false]] as const) requireField({ key, label, ...(positive ? { min: 0, exclusiveMin: true } : key === "delay_s" ? { min: 0 } : {}) }, w[key], prefix);
      if (kind === "pulse") {
        for (const key of ["initial_v", "pulsed_v", "delay_s", "rise_s", "fall_s", "width_s", "period_s"]) requireField({ key, label: key, ...(key.endsWith("_s") ? { min: 0, exclusiveMin: key === "period_s" } : {}) }, w[key], prefix);
        if (Number(w.rise_s) + Number(w.width_s) + Number(w.fall_s) > Number(w.period_s)) errors.push(`${prefix}パルスの立上り + 幅 + 立下りは周期以下にしてください。`);
      }
      if (kind === "pwl") {
        const points = w.points;
        if (!Array.isArray(points) || points.length < 2 || points.some((row, i) => !Array.isArray(row) || row.length !== 2 || row.some(v => typeof v !== "number" || !Number.isFinite(v)) || Number(row[0]) < 0 || i > 0 && Number(row[0]) <= Number((points[i - 1] as CircuitJson[])[0]))) errors.push(`${prefix}PWL は 0 以上の増加する時刻と電圧の組が 2 点以上必要です。`);
      }
    }
  }
  if (totalSegments > 512) errors.push("同軸ケーブルの分割数の合計は 512 以下にしてください。");
  // Find disconnected islands through elements; grounded coax has an internal return.
  const reach = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { if (!reach.has(a)) reach.set(a, new Set()); if (!reach.has(b)) reach.set(b, new Set()); reach.get(a)!.add(b); reach.get(b)!.add(a); };
  for (const c of doc.components) { const ns = c.ports.map(port => nodes.get(`${c.id}:${port}`)!); for (const n of ns.slice(1)) link(ns[0], n); if (c.kind === "COAX_GND") link(ns[0], "GND"); }
  const seen = new Set<string>(), pending = ["GND"];
  while (pending.length) { const n = pending.pop()!; if (seen.has(n)) continue; seen.add(n); pending.push(...reach.get(n) ?? []); }
  if (doc.components.some(c => c.kind !== "GND" && c.ports.some(p => !seen.has(nodes.get(`${c.id}:${p}`)!)))) errors.push("接地から切り離された回路があります。素子と PIC を接地に戻る経路で接続してください。");
  return [...new Set(errors)];
}
export function componentSummary(c: CircuitComponent): string {
  const engineering = (n: unknown, unit: string) => typeof n === "number" ? `${Math.abs(n) >= 1e4 || n !== 0 && Math.abs(n) < 1e-2 ? n.toExponential(2) : Number(n.toPrecision(4))} ${unit}` : "";
  switch (c.kind) {
    case "R": return engineering(c.parameters.value, "Ω"); case "C": return engineering(c.parameters.value, "F"); case "L": return engineering(c.parameters.value, "H");
    case "COAX": case "COAX_GND": return engineering(c.parameters.length_m, "m");
    case "V": return `${engineering(c.parameters.dc_v, "V")} / ${String(circuitObject(c.parameters.waveform).kind ?? "dc").toUpperCase()}`;
    case "D": return "詳細モデル"; case "S": return "時刻切替"; case "PIC": return "左電極 ⟷ 右電極"; default: return "";
  }
}
export function coaxTemPreview(parameters: Record<string, CircuitJson>): { impedance_ohm: number; delay_s: number; capacitance_f_m: number; inductance_h_m: number } | null {
  const p = { ...coaxDefaults, ...parameters }, ratio = Number(p.shield_inner_diameter_m) / Number(p.inner_diameter_m);
  if (!(ratio > 1 && Number(p.relative_permittivity) > 0 && Number(p.relative_permeability) > 0 && Number(p.length_m) > 0)) return null;
  const l = 1.25663706212e-6 * Number(p.relative_permeability) * Math.log(ratio) / (2 * Math.PI);
  const c = 2 * Math.PI * 8.8541878128e-12 * Number(p.relative_permittivity) / Math.log(ratio);
  return { impedance_ohm: Math.sqrt(l / c), delay_s: Number(p.length_m) * Math.sqrt(l * c), capacitance_f_m: c, inductance_h_m: l };
}
