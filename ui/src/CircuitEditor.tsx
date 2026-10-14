import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  circuitDraftError, circuitKinds, circuitLabels, circuitObject, coaxFields, coaxTemPreview, componentSummary, connectCircuit,
  createCircuitComponent, defaultCircuitParameters, defaultExternalCircuit, defaultSourceWaveform, diodeDefaults, diodeFields, duplicateCircuitComponent,
  endpointKey, fieldError, normalizeCircuitDocument, parseCircuitNumber, removeCircuitComponent, resolveCircuitNodes, switchFields,
  validateExternalCircuit, type CircuitComponent, type CircuitDocument, type CircuitEndpoint, type CircuitField, type CircuitJson,
  type CircuitKind, type ExternalCircuitSettings,
} from "./circuitmodel";
import "./circuit.css";
import { installCircuitRotationShortcut } from "./circuitshortcuts";

export interface CircuitEditorProps {
  value: ExternalCircuitSettings | undefined | null;
  onChange: (value: ExternalCircuitSettings) => void;
  disabled?: boolean;
  active?: boolean;
  onValidityChange?: (valid: boolean) => void;
  onCheck?: () => Promise<string>;
}
type Point = { x: number; y: number };
type Drafts = Record<string, { text: string; field: CircuitField }>;
type View = { x: number; y: number; width: number; height: number };
const initialView: View = { x: 0, y: 0, width: 1200, height: 640 };
const snap = (n: number) => Math.round(n / 20) * 20;
const numberString = (v: number | null | undefined) => v === null || v === undefined ? "" : String(Number(v.toPrecision(12)));

function localPort(c: CircuitComponent, port: string): Point {
  if (c.kind === "GND") return { x: 0, y: -30 };
  if (c.kind === "PIC") return { x: port === "left" ? -90 : 90, y: 0 };
  if (c.kind === "COAX") return { x: port.endsWith("1") ? -70 : 70, y: port.startsWith("p") ? -20 : 24 };
  if (c.kind === "COAX_GND") return { x: port === "p1" ? -70 : 70, y: -10 };
  return { x: port === "p" ? -54 : 54, y: 0 };
}
function terminalPoint(c: CircuitComponent, port: string): Point {
  const p = localPort(c, port), theta = c.rotation * Math.PI / 180;
  return { x: c.position.x + p.x * Math.cos(theta) - p.y * Math.sin(theta), y: c.position.y + p.x * Math.sin(theta) + p.y * Math.cos(theta) };
}
function wirePath(a: Point, b: Point): string {
  if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const middle = snap((a.x + b.x) / 2); return `M ${a.x} ${a.y} H ${middle} V ${b.y} H ${b.x}`;
}
function ComponentSymbol({ kind }: { kind: CircuitKind }) {
  switch (kind) {
    case "R": return <><path d="M-54 0H-32M32 0H54" /><rect x="-32" y="-11" width="64" height="22" rx="2" /></>;
    case "C": return <path d="M-54 0H-8M8 0H54M-8-22V22M8-22V22" />;
    case "L": return <path d="M-54 0H-32C-32-24-16-24-16 0C-16-24 0-24 0 0C0-24 16-24 16 0C16-24 32-24 32 0H54" />;
    case "D": return <><path d="M-54 0H-20M20 0H54M20-20V20" /><path d="M-20-20L20 0L-20 20Z" /></>;
    case "V": return <><path d="M-54 0H-25M25 0H54" /><circle r="25" /><path d="M-16 0H-6M-11-5V5M8 0H18" /></>;
    case "S": return <><path d="M-54 0H-24M24 0H54M-24 0L17-21" /><circle cx="-24" r="3" /><circle cx="24" r="3" /></>;
    case "GND": return <path d="M0-30V-4M-22-4H22M-15 4H15M-8 12H8" />;
    case "COAX": return <><rect x="-46" y="-35" width="92" height="78" rx="5" /><path d="M-70-20H70M-70 24H-46M46 24H70M-46 24H46M-40-30V35M40-30V35" /></>;
    case "COAX_GND": return <><rect x="-46" y="-35" width="92" height="74" rx="5" /><path d="M-70-10H70M-40-28V18M40-28V18M-40 18H40M0 18V25M-12 25H12M-8 30H8M-4 35H4" /></>;
    case "PIC": return <><rect className="circuit-pic-fill" x="-68" y="-39" width="136" height="78" rx="6" /><path d="M-90 0H-55M55 0H90M-55-28V28M55-28V28" /><path className="circuit-plasma" d="M-32-12L-20 12L-8-12L4 12L16-12L28 12" /></>;
  }
}

function NumericInput({ id, field, value, drafts, setDrafts, onChange }: {
  id: string; field: CircuitField; value: number | null | undefined; drafts: Drafts; setDrafts: (drafts: Drafts | ((current: Drafts) => Drafts)) => void;
  onChange: (value: number | null) => void;
}) {
  const text = drafts[id]?.text ?? numberString(value), parsed = parseCircuitNumber(text, field.optional);
  const error = circuitDraftError(field, text), inputId = useId();
  return <label className="circuit-number" htmlFor={inputId}><span>{field.label}{field.unit && <small>{field.unit}</small>}</span><input id={inputId} type="text" inputMode="decimal" aria-label={field.label} aria-invalid={Boolean(error)} aria-describedby={error || field.hint ? `${inputId}-hint` : undefined}
    value={text} placeholder={field.optional ? "未指定" : undefined} onChange={event => {
      const next = event.target.value; setDrafts(current => ({ ...current, [id]: { text: next, field } }));
      const n = parseCircuitNumber(next, field.optional); if (n !== undefined && !fieldError(field, n)) onChange(n);
    }} />{(error || field.hint) && <small id={`${inputId}-hint`} className={error ? "circuit-field-error" : "circuit-muted"}>{error ?? field.hint}</small>}</label>;
}

export function CircuitEditor({ value, onChange, disabled = false, active = true, onValidityChange, onCheck }: CircuitEditorProps) {
  const fallback = useRef(defaultExternalCircuit()), s = value ?? fallback.current, doc = s.document;
  const current = useRef(s); current.current = s;
  const expected = useRef(s), svg = useRef<SVGSVGElement>(null), gridId = useId().replaceAll(":", "");
  const [selected, setSelected] = useState<string>("pic"), [selectedWire, setSelectedWire] = useState<string | null>(null);
  const [pending, setPending] = useState<CircuitEndpoint | null>(null), [pointer, setPointer] = useState<Point | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({}), [notice, setNotice] = useState("");
  const [view, setView] = useState(initialView), [past, setPast] = useState<CircuitDocument[]>([]), [future, setFuture] = useState<CircuitDocument[]>([]);
  const [drag, setDrag] = useState<{ id: string; origin: Point; start: Point; position: Point } | null>(null);
  const dragRef = useRef<typeof drag>(null); dragRef.current = drag;
  const pan = useRef<{ start: Point; view: View } | null>(null);
  const [sourceTerminal, setSourceTerminal] = useState(""), [targetTerminal, setTargetTerminal] = useState("");
  const [checkBusy, setCheckBusy] = useState(false), [checkMessage, setCheckMessage] = useState("");
  const checkRevision = useRef(0);
  const rotateAction = useRef<() => void>(() => {});
  const [importOpen, setImportOpen] = useState(false), [importText, setImportText] = useState("");
  const [pwlDraft, setPwlDraft] = useState<Record<string, string>>({}), [pwlInvalid, setPwlInvalid] = useState<Record<string, string>>({});
  useEffect(() => {
    if (s === expected.current) return;
    const previous = expected.current;
    if (s.document !== previous.document) { setDrafts({}); setPwlDraft({}); setPwlInvalid({}); setPast([]); setFuture([]); setPending(null); }
    else {
      // SettingsPanel also edits these global values. Preserve unrelated unfinished
      // component fields when a valid area/temperature is edited there.
      setDrafts(d => {
        const next = { ...d };
        if (s.area_m2 !== previous.area_m2) delete next["global.area"];
        if (s.temperature_k !== previous.temperature_k) delete next["global.temperature"];
        if (s.max_iterations !== previous.max_iterations) delete next["global.iterations"];
        return next;
      });
    }
    setCheckMessage(""); checkRevision.current += 1; expected.current = s;
  }, [s]);
  const draftErrors = useMemo(() => [...Object.values(drafts).flatMap(d => { const message = circuitDraftError(d.field, d.text); return message ? [message] : []; }), ...Object.values(pwlInvalid), ...(doc.node_labels ?? []).filter(l => !/^[A-Za-z][A-Za-z0-9_]*$/.test(l.name)).map(l => `${l.name}: ノード名は英字で始まる英数字・_ が必要です。`)], [drafts, pwlInvalid, doc.node_labels]);
  const validDraft = draftErrors.length === 0;
  useEffect(() => { onValidityChange?.(validDraft); }, [validDraft, onValidityChange]);
  const documentErrors = useMemo(() => validateExternalCircuit({ ...s, enabled: true }), [s]);
  const nodes = useMemo(() => resolveCircuitNodes(doc), [doc]);
  const component = doc.components.find(c => c.id === selected) ?? null;
  const drawComponents = doc.components.map(c => drag?.id === c.id ? { ...c, position: drag.position } : c);
  const byId = new Map(drawComponents.map(c => [c.id, c]));
  const endpoints = doc.components.flatMap(c => c.ports.map(port => ({ component_id: c.id, port })));
  const endpointLabel = (e: CircuitEndpoint) => `${doc.components.find(c => c.id === e.component_id)?.label ?? e.component_id} / ${e.port === "left" ? "左電極" : e.port === "right" ? "右電極" : e.port} (${nodes.get(endpointKey(e))})`;
  const update = (next: ExternalCircuitSettings) => { expected.current = next; current.current = next; checkRevision.current += 1; onChange(next); setCheckMessage(""); };
  const applyDocument = (next: CircuitDocument, keepDraft = true) => {
    const before = current.current, previousDocument = before.document;
    if (disabled || next === previousDocument) return;
    // React may execute a functional state update after update() has changed the
    // ref. Capture the immutable document before scheduling the history update.
    setPast(p => [...p.slice(-49), previousDocument]); setFuture([]); update({ ...before, document: next });
    if (!keepDraft) { setDrafts({}); setPwlDraft({}); setPwlInvalid({}); }
  };
  const updateComponent = (next: CircuitComponent) => { const before = current.current.document; applyDocument({ ...before, components: before.components.map(c => c.id === next.id ? next : c) }); };
  function rotateSelection() {
    if (disabled || selectedWire) return;
    const c = current.current.document.components.find(c => c.id === selected);
    if (!c) return;
    updateComponent({ ...c, rotation: (c.rotation + 90) % 360 });
    setNotice(`${c.label}を時計回りに90°回転しました。`);
  }
  rotateAction.current = () => { if (active) rotateSelection(); };
  useEffect(() => installCircuitRotationShortcut(window, () => rotateAction.current()), []);
  const patchParameter = (key: string, next: CircuitJson) => { if (!component) return; updateComponent({ ...component, parameters: { ...component.parameters, [key]: next } }); };
  const numeric = (id: string, field: CircuitField, val: number | null | undefined, change: (v: number | null) => void) => <NumericInput key={id} id={id} field={field} value={val} drafts={drafts} setDrafts={setDrafts} onChange={change} />;
  function undo() {
    if (disabled || !past.length) return;
    const before = current.current, previousDocument = before.document, previous = past.at(-1)!;
    setFuture(f => [previousDocument, ...f].slice(0, 50)); setPast(past.slice(0, -1)); update({ ...before, document: previous }); setDrafts({}); setPwlDraft({}); setPwlInvalid({}); setPending(null);
  }
  function redo() {
    if (disabled || !future.length) return;
    const before = current.current, previousDocument = before.document, next = future[0];
    setPast(p => [...p, previousDocument].slice(-50)); update({ ...before, document: next }); setFuture(future.slice(1)); setDrafts({}); setPwlDraft({}); setPwlInvalid({}); setPending(null);
  }
  function deleteSelection() {
    if (disabled) return;
    if (selectedWire) { applyDocument({ ...doc, wires: doc.wires.filter(w => w.id !== selectedWire) }); setSelectedWire(null); }
    else if (component && component.kind !== "PIC") { applyDocument(removeCircuitComponent(doc, component.id)); setSelected("pic"); setDrafts(d => Object.fromEntries(Object.entries(d).filter(([key]) => !key.startsWith(`${component.id}.`)))); setPwlInvalid(d => { const next = { ...d }; delete next[component.id]; return next; }); setPwlDraft(d => { const next = { ...d }; delete next[component.id]; return next; }); }
  }
  function addComponent(kind: Exclude<CircuitKind, "PIC">) {
    const c = createCircuitComponent(doc, kind); applyDocument({ ...doc, components: [...doc.components, c] }); setSelected(c.id); setSelectedWire(null); setNotice(`${circuitLabels[kind]}を追加しました。端子を 2 回クリックして配線できます。`);
  }
  function connect(a: CircuitEndpoint, b: CircuitEndpoint) {
    try { applyDocument(connectCircuit(current.current.document, a, b)); setPending(null); setNotice(`${endpointLabel(a)} と ${endpointLabel(b)} を接続しました。`); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  }
  function chooseTerminal(e: CircuitEndpoint) {
    if (disabled) return;
    setSelectedWire(null);
    if (pending && endpointKey(pending) === endpointKey(e)) { setPending(null); setNotice("配線をキャンセルしました。"); }
    else if (pending) connect(pending, e);
    else { setPending(e); setNotice(`${endpointLabel(e)} から配線中。接続先の端子をクリックしてください。`); }
  }
  function pointFromEvent(event: { clientX: number; clientY: number }): Point {
    const element = svg.current, matrix = element?.getScreenCTM();
    if (!element || !matrix) return { x: 0, y: 0 };
    const p = element.createSVGPoint(); p.x = event.clientX; p.y = event.clientY; const q = p.matrixTransform(matrix.inverse()); return { x: q.x, y: q.y };
  }
  function beginDrag(event: ReactPointerEvent<SVGGElement>, c: CircuitComponent) {
    if (event.button !== 0 || disabled) return;
    event.stopPropagation(); event.preventDefault(); setSelected(c.id); setSelectedWire(null);
    const next = { id: c.id, origin: c.position, start: pointFromEvent(event), position: c.position }; dragRef.current = next; setDrag(next); svg.current?.setPointerCapture(event.pointerId);
  }
  function movePointer(event: ReactPointerEvent<SVGSVGElement>) {
    const p = pointFromEvent(event); setPointer(p);
    if (dragRef.current) { const d = dragRef.current, next = { ...d, position: { x: snap(d.origin.x + p.x - d.start.x), y: snap(d.origin.y + p.y - d.start.y) } }; dragRef.current = next; setDrag(next); }
    if (pan.current) { const rect = svg.current?.getBoundingClientRect(); if (rect) setView({ ...pan.current.view, x: pan.current.view.x - (event.clientX - pan.current.start.x) * pan.current.view.width / rect.width, y: pan.current.view.y - (event.clientY - pan.current.start.y) * pan.current.view.height / rect.height }); }
  }
  function finishPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragRef.current) {
      const d = dragRef.current;
      if (d.origin.x !== d.position.x || d.origin.y !== d.position.y) { applyDocument({ ...doc, components: doc.components.map(c => c.id === d.id ? { ...c, position: d.position } : c) }); setDrafts(fields => { const next = { ...fields }; delete next[`${d.id}.x`]; delete next[`${d.id}.y`]; return next; }); }
      dragRef.current = null; setDrag(null);
    }
    pan.current = null; if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
  }
  function fit() {
    const xs = doc.components.map(c => c.position.x), ys = doc.components.map(c => c.position.y);
    const width = Math.max(500, Math.max(...xs) - Math.min(...xs) + 300), height = Math.max(320, Math.max(...ys) - Math.min(...ys) + 220);
    setView({ x: Math.min(...xs) - 150, y: Math.min(...ys) - 110, width, height });
  }
  function zoom(scale: number) { setView(v => { const width = Math.max(300, Math.min(8000, v.width * scale)), height = width * v.height / v.width; return { x: v.x + (v.width - width) / 2, y: v.y + (v.height - height) / 2, width, height }; }); }
  function componentFields() {
    if (!component) return null;
    const c = component, p = { ...defaultCircuitParameters(c.kind), ...c.parameters };
    const fields = (list: CircuitField[], values = p, nested?: string) => <div className="circuit-fields">{list.map(field => numeric(`${c.id}.${nested ? nested + "." : ""}${field.key}`, field, values[field.key] as number | null | undefined, n => {
      if (nested) { const next = { ...circuitObject(p[nested]) }; if (n === null) delete next[field.key]; else next[field.key] = n; patchParameter(nested, next); }
      else patchParameter(field.key, n);
    }))}</div>;
    if (c.kind === "PIC") return <div className="circuit-pic-note"><p>左端子は x = 0、右端子は x = ギャップの電極です。両方を外部回路に接続してください。</p><p>電極面積は PIC の面積あたり電荷・電流を回路の C・A に変換します。プラズマの粒子・SEE・FN 条件は左側の計算設定で編集できます。</p></div>;
    if (c.kind === "GND") return <p className="circuit-muted">回路の基準電位です。複数の GND 記号は同じノードに接続されます。</p>;
    if (c.kind === "R") return fields([{ key: "value", label: "抵抗", unit: "Ω", min: 0, exclusiveMin: true }]);
    if (c.kind === "C") return fields([{ key: "value", label: "容量", unit: "F", min: 0, exclusiveMin: true }, { key: "initial_voltage_v", label: "初期電圧 (p − n)", unit: "V", optional: true, hint: "空欄: DC 初期解。数値指定で初期電圧を固定" }]);
    if (c.kind === "L") return fields([{ key: "value", label: "インダクタンス", unit: "H", min: 0, exclusiveMin: true }, { key: "initial_current_a", label: "初期電流 (p → n)", unit: "A", optional: true, hint: "空欄: DC 初期解。数値指定で初期電流を固定" }]);
    if (c.kind === "D") return <>
      <p className="circuit-muted">p = アノード、n = カソード。直列抵抗、逆降伏、接合容量、走行時間、温度依存を設定できます。</p>
      {fields([{ key: "area", label: "面積倍率", min: 0, exclusiveMin: true }, { key: "temperature_k", label: "素子温度", unit: "K", min: 0, exclusiveMin: true, optional: true, hint: "空欄: 回路温度を使用" }])}
      <h4>電流・逆降伏</h4>{fields(diodeFields.slice(0, 5), { ...diodeDefaults, ...circuitObject(p.model_parameters) }, "model_parameters")}
      <details open className="circuit-details"><summary>接合容量・走行時間・温度依存</summary>{fields(diodeFields.slice(5), { ...diodeDefaults, ...circuitObject(p.model_parameters) }, "model_parameters")}</details>
    </>;
    if (c.kind === "COAX" || c.kind === "COAX_GND") {
      const derived = coaxTemPreview(p);
      return <><p className="circuit-muted">{c.kind === "COAX" ? "p1 / p2 は内部導体、n1 / n2 は共通シールドです。" : "p1 / p2 は内部導体。シールドは内部で GND に接続されます。"} 分布 RLC 線路を指定の分割数で計算します。</p>
        <h4>寸法・誘電体</h4>{fields(coaxFields.slice(0, 6))}<h4>導体・分割数</h4>{fields(coaxFields.slice(6))}
        {derived && <div className="circuit-derived"><h4>TEM 線路の目安</h4><dl>{[["特性インピーダンス", derived.impedance_ohm, "Ω"], ["伝搬遅延", derived.delay_s * 1e9, "ns"], ["分布容量", derived.capacitance_f_m * 1e12, "pF/m"], ["外部インダクタンス", derived.inductance_h_m * 1e9, "nH/m"]].map(([name, v, unit]) => <div key={String(name)}><dt>{name}</dt><dd>{Number(v).toPrecision(5)} {unit}</dd></div>)}</dl></div>}
        <p className="circuit-muted">導体抵抗率 0 は理想導体、誘電正接 0 は誘電体損失なし。損失は基準周波数で近似するため、分割数と時間刻み幅を変えて結果を確認してください。</p>
      </>;
    }
    if (c.kind === "S") return <>
      <label className="circuit-checkbox"><input type="checkbox" checked={p.initial_state === true} onChange={e => patchParameter("initial_state", e.target.checked)} />ON 開始時刻より前は ON</label>
      {fields(switchFields)}<p className="circuit-muted">単発: ON 開始から OFF 切替まで ON。周期指定: ON 開始後、周期の先頭から ON 比率の区間だけ導通します。OFF 状態も有限抵抗です。</p>
    </>;
    if (c.kind === "V") {
      const w = circuitObject(p.waveform), kind = String(w.kind ?? "dc");
      const waveFields = (list: CircuitField[]) => fields(list, w, "waveform");
      return <><label className="circuit-text">電源波形<select aria-label="電圧源の波形" value={kind} onChange={event => {
        patchParameter("waveform", defaultSourceWaveform(event.target.value)); setDrafts(d => Object.fromEntries(Object.entries(d).filter(([key]) => !key.startsWith(`${c.id}.waveform.`) && key !== `${c.id}.dc_v`))); setPwlInvalid(d => { const n = { ...d }; delete n[c.id]; return n; }); setPwlDraft(d => { const n = { ...d }; delete n[c.id]; return n; });
      }}><option value="dc">DC のみ</option><option value="sin">正弦波</option><option value="pulse">パルス</option><option value="pwl">区分線形 (PWL)</option></select></label>
        {kind === "dc" && fields([{ key: "dc_v", label: "DC 電圧 (p − n)", unit: "V" }])}
        {kind === "sin" && waveFields([{ key: "offset_v", label: "波形オフセット", unit: "V" }, { key: "amplitude_v", label: "振幅", unit: "V" }, { key: "frequency_hz", label: "周波数", unit: "Hz", min: 0, exclusiveMin: true }, { key: "phase_deg", label: "位相", unit: "°" }, { key: "delay_s", label: "開始遅延", unit: "s", min: 0 }])}
        {kind === "pulse" && waveFields([{ key: "initial_v", label: "初期レベル", unit: "V" }, { key: "pulsed_v", label: "パルスレベル", unit: "V" }, { key: "delay_s", label: "開始遅延", unit: "s", min: 0 }, { key: "rise_s", label: "立上り時間", unit: "s", min: 0 }, { key: "fall_s", label: "立下り時間", unit: "s", min: 0 }, { key: "width_s", label: "パルス幅", unit: "s", min: 0 }, { key: "period_s", label: "パルス周期", unit: "s", min: 0, exclusiveMin: true }])}
        {kind === "pwl" && <label className="circuit-text">時刻 [s], 電圧 [V]（1 行に 1 点）<textarea aria-label="PWL の時刻と電圧" rows={7} spellCheck={false} value={pwlDraft[c.id] ?? (Array.isArray(w.points) ? w.points.map(row => Array.isArray(row) ? row.join(", ") : "").join("\n") : "")} onChange={event => {
          const text = event.target.value; setPwlDraft(d => ({ ...d, [c.id]: text }));
          const rows = text.trim().split(/\r?\n/).filter(l => l.trim()).map(l => l.trim().split(/[,\s]+/).map(v => parseCircuitNumber(v)));
          const invalid = rows.length < 2 || rows.some((row, i) => row.length !== 2 || row.some(v => typeof v !== "number") || Number(row[0]) < 0 || i > 0 && Number(row[0]) <= Number(rows[i - 1][0]));
          setPwlInvalid(d => { const n = { ...d }; if (invalid) n[c.id] = `${c.label}: PWL は増加する時刻と電圧が 2 点以上必要です。`; else delete n[c.id]; return n; });
          if (!invalid) patchParameter("waveform", { ...w, points: rows as CircuitJson[] });
        }} />{pwlInvalid[c.id] && <small className="circuit-field-error">{pwlInvalid[c.id]}</small>}<small className="circuit-muted">時刻は 0 以上で厳密に増加。範囲外は端点の電圧を保持します。</small></label>}
        <p className="circuit-muted">DC は「DC のみ」で使用。正弦波はオフセット + 振幅、パルス・PWL は指定したレベルを使用します。正の電圧は p 端子が n 端子より高電位です。</p>
      </>;
    }
    return null;
  }

  return <section className="circuit-editor" aria-label="外部回路エディター" onKeyDown={event => {
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) return;
    if (event.key === "Escape") { setPending(null); setNotice("配線をキャンセルしました。"); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelection(); }
  }}>
    <div className="circuit-header"><div><h2>外部回路</h2><p>PIC の電極と回路を同じ時間刻みで連成</p></div><label className="circuit-checkbox"><input type="checkbox" disabled={disabled} checked={s.enabled} onChange={e => update({ ...s, enabled: e.target.checked })} />外部回路を使用</label></div>
    <fieldset disabled={disabled} className="circuit-global"><label className="circuit-text">回路名<input aria-label="回路名" value={doc.name} onChange={e => applyDocument({ ...doc, name: e.target.value })} /></label>
      {numeric("global.area", { key: "area_m2", label: "電極面積", unit: "m²", min: 0, exclusiveMin: true }, s.area_m2, n => update({ ...s, area_m2: n! }))}
      {numeric("global.temperature", { key: "temperature_k", label: "回路温度", unit: "K", min: 0, exclusiveMin: true }, s.temperature_k, n => update({ ...s, temperature_k: n! }))}
      {numeric("global.iterations", { key: "max_iterations", label: "最大反復数", min: 10, max: 200, integer: true }, s.max_iterations, n => update({ ...s, max_iterations: n! }))}
    </fieldset>
    <div className="circuit-palette" aria-label="回路素子の追加">{circuitKinds.filter(kind => kind !== "PIC").map(kind => <button type="button" key={kind} disabled={disabled || doc.components.length >= 128} onClick={() => addComponent(kind as Exclude<CircuitKind, "PIC">)} title={circuitLabels[kind]}><span>{kind === "COAX_GND" ? "同軸/GND" : kind === "COAX" ? "同軸" : kind}</span>{circuitLabels[kind]}</button>)}</div>
    <div className="circuit-toolbar"><div className="circuit-tool-group"><button type="button" disabled={disabled || !past.length} onClick={undo} title="Ctrl + Z">元に戻す</button><button type="button" disabled={disabled || !future.length} onClick={redo} title="Ctrl + Y">やり直す</button></div>
      <div className="circuit-tool-group"><button type="button" disabled={disabled || !component} onClick={rotateSelection} aria-keyshortcuts="Control+R" title="選択した素子を時計回りに90°回転（Ctrl + R）">90° 回転 <kbd>Ctrl+R</kbd></button><button type="button" disabled={disabled || !component || component.kind === "PIC"} onClick={() => { if (!component) return; const d = duplicateCircuitComponent(doc, component.id); applyDocument(d.document); if (d.component) setSelected(d.component.id); }}>コピー</button><button type="button" disabled={disabled || !selectedWire && (!component || component.kind === "PIC")} onClick={deleteSelection}>選択を削除</button></div>
      <div className="circuit-tool-group circuit-view-tools"><button type="button" aria-label="回路を拡大" onClick={() => zoom(0.8)}>＋</button><button type="button" aria-label="回路を縮小" onClick={() => zoom(1.25)}>−</button><button type="button" onClick={fit}>全体表示</button></div>
      {onCheck && <button type="button" disabled={disabled || !validDraft || checkBusy} onClick={async () => { const revision = checkRevision.current; setCheckBusy(true); setCheckMessage(""); try { const message = await onCheck(); if (revision === checkRevision.current) setCheckMessage(message); } catch (e) { if (revision === checkRevision.current) setCheckMessage(e instanceof Error ? e.message : String(e)); } finally { setCheckBusy(false); } }}>{checkBusy ? "検証中…" : "回路を検証"}</button>}
    </div>
    <div className="circuit-workspace"><div className="circuit-canvas-pane"><svg ref={svg} className="circuit-canvas" viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} role="group" aria-label="回路図。素子をドラッグして移動、端子を 2 回選択して配線" onPointerMove={movePointer} onPointerUp={finishPointer} onPointerCancel={() => { dragRef.current = null; setDrag(null); pan.current = null; }} onPointerDown={event => {
        if (event.button === 1 || event.shiftKey) { event.preventDefault(); pan.current = { start: { x: event.clientX, y: event.clientY }, view }; svg.current?.setPointerCapture(event.pointerId); }
        else if (event.target === event.currentTarget || (event.target as Element).classList.contains("circuit-grid")) { setSelectedWire(null); setSelected(""); }
      }}>
        <defs><pattern id={gridId} width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.8" className="circuit-grid-dot" /></pattern></defs>
        <rect className="circuit-grid" x={view.x} y={view.y} width={view.width} height={view.height} fill={`url(#${gridId})`} />
        {doc.wires.map(w => {
          const a = byId.get(w.source.component_id), b = byId.get(w.target.component_id); if (!a || !b) return null;
          const d = wirePath(terminalPoint(a, w.source.port), terminalPoint(b, w.target.port));
          return <g key={w.id} className={selectedWire === w.id ? "circuit-wire selected" : "circuit-wire"} role="button" tabIndex={0} aria-label={`配線 ${endpointLabel(w.source)} → ${endpointLabel(w.target)}`} aria-pressed={selectedWire === w.id} onClick={event => { event.stopPropagation(); setSelectedWire(w.id); setSelected(""); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedWire(w.id); setSelected(""); } }}><path d={d} className="circuit-wire-hit" /><path d={d} className="circuit-wire-line" /></g>;
        })}
        {pending && pointer && byId.get(pending.component_id) && <path className="circuit-pending-wire" d={wirePath(terminalPoint(byId.get(pending.component_id)!, pending.port), pointer)} />}
        {drawComponents.map(c => <g key={c.id}>
          <g role="button" tabIndex={0} aria-label={`${c.label} ${circuitLabels[c.kind]}`} aria-pressed={selected === c.id} className={selected === c.id ? "circuit-component selected" : "circuit-component"} transform={`translate(${c.position.x} ${c.position.y})`} onPointerDown={e => beginDrag(e, c)} onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(c.id); setSelectedWire(null); }
            if (!disabled && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); updateComponent({ ...c, position: { x: c.position.x + (event.key === "ArrowLeft" ? -20 : event.key === "ArrowRight" ? 20 : 0), y: c.position.y + (event.key === "ArrowUp" ? -20 : event.key === "ArrowDown" ? 20 : 0) } }); setDrafts(fields => { const next = { ...fields }; delete next[`${c.id}.x`]; delete next[`${c.id}.y`]; return next; }); }
          }}>
            <rect className="circuit-selection-box" x={c.kind === "PIC" ? -82 : c.kind.startsWith("COAX") ? -61 : -43} y="-48" width={c.kind === "PIC" ? 164 : c.kind.startsWith("COAX") ? 122 : 86} height="98" rx="7" />
            <g transform={`rotate(${c.rotation})`} className="circuit-symbol"><ComponentSymbol kind={c.kind} /></g>
            <text className="circuit-component-label" textAnchor="middle" y={c.kind === "GND" ? 40 : -56}>{c.label}</text>
            <text className="circuit-value-label" textAnchor="middle" y={c.kind === "GND" ? 57 : 65}>{componentSummary(c)}</text>
          </g>
          {c.ports.map(port => {
            const p = terminalPoint(c, port), e = { component_id: c.id, port }, active = pending && endpointKey(pending) === endpointKey(e);
            return <g key={port} role="button" tabIndex={disabled ? -1 : 0} aria-label={`端子 ${endpointLabel(e)}`} aria-pressed={Boolean(active)} className={active ? "circuit-terminal active" : "circuit-terminal"} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); chooseTerminal(e); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); chooseTerminal(e); } }}><circle cx={p.x} cy={p.y} r="12" className="circuit-terminal-hit" /><circle cx={p.x} cy={p.y} r="4.5" className="circuit-terminal-dot" /><text x={p.x} y={p.y + (c.kind === "COAX" && port.startsWith("n") ? 20 : -13)} textAnchor="middle">{port === "left" ? "左" : port === "right" ? "右" : port}</text><title>{endpointLabel(e)}</title></g>;
          })}
        </g>)}
      </svg><div className="circuit-canvas-hint"><span>{pending ? "配線中: 接続先の端子を選択 / Esc で中止" : "端子 → 端子で配線 · ドラッグで移動 · Ctrl+R で90°回転 · Shift + ドラッグで画面移動"}</span>{pending && <button type="button" onClick={() => setPending(null)}>配線を中止</button>}</div>
      <div className="circuit-live-message" role="status">{notice || "PIC の左・右電極を電源と接地につなぎ、計算条件を作成してください。"}</div>
      <details className="circuit-connections"><summary>接続一覧 / 端子を指定して配線（{doc.wires.length} 本）</summary><fieldset disabled={disabled}><div className="circuit-connection-form"><label>接続元<select aria-label="配線の接続元" value={sourceTerminal} onChange={e => setSourceTerminal(e.target.value)}><option value="">端子を選択</option>{endpoints.map(e => <option key={endpointKey(e)} value={endpointKey(e)}>{endpointLabel(e)}</option>)}</select></label><span>→</span><label>接続先<select aria-label="配線の接続先" value={targetTerminal} onChange={e => setTargetTerminal(e.target.value)}><option value="">端子を選択</option>{endpoints.map(e => <option key={endpointKey(e)} value={endpointKey(e)}>{endpointLabel(e)}</option>)}</select></label><button type="button" disabled={!sourceTerminal || !targetTerminal} onClick={() => { const a = endpoints.find(e => endpointKey(e) === sourceTerminal), b = endpoints.find(e => endpointKey(e) === targetTerminal); if (a && b) connect(a, b); }}>配線を追加</button></div>
        <ul>{doc.wires.map(w => <li key={w.id}><button type="button" className="circuit-wire-select" onClick={() => { setSelectedWire(w.id); setSelected(""); }}>{endpointLabel(w.source)} → {endpointLabel(w.target)}</button><button type="button" className="tiny" aria-label={`配線 ${w.id} を削除`} onClick={() => applyDocument({ ...doc, wires: doc.wires.filter(a => a.id !== w.id) })}>削除</button></li>)}</ul><p className="circuit-muted">線の交差だけでは接続されません。分岐は同じ端子に複数の配線を接続してください。</p></fieldset></details>
      </div>
      <aside className="circuit-inspector" aria-label="回路素子の編集"><label className="circuit-text">編集する素子<select aria-label="編集する回路素子" value={component?.id ?? ""} onChange={e => { setSelected(e.target.value); setSelectedWire(null); }}><option value="">選択してください</option>{doc.components.map(c => <option key={c.id} value={c.id}>{c.label} · {circuitLabels[c.kind]}</option>)}</select></label>
        {component ? <fieldset disabled={disabled}><div className="circuit-inspector-title"><h3>{circuitLabels[component.kind]}</h3><code>{component.id}</code></div><label className="circuit-text">素子名<input aria-label="回路素子の名前" value={component.label} onChange={e => updateComponent({ ...component, label: e.target.value })} /></label>
          <div className="circuit-terminal-list">{component.ports.map(port => <button type="button" key={port} aria-label={`${component.label} の ${port} 端子から配線`} onClick={() => chooseTerminal({ component_id: component.id, port })}>{port === "left" ? "左電極" : port === "right" ? "右電極" : port}<small>{nodes.get(`${component.id}:${port}`)}</small></button>)}</div>
          {componentFields()}<details className="circuit-details"><summary>ノード名・位置</summary>{component.ports.map(port => <label className="circuit-text" key={port}>{port} 端子のノード名<input aria-label={`${component.label} ${port} のノード名`} disabled={nodes.get(`${component.id}:${port}`) === "GND"} placeholder={nodes.get(`${component.id}:${port}`)} value={doc.node_labels?.find(l => l.component_id === component.id && l.port === port)?.name ?? ""} onChange={e => {
            const labels = doc.node_labels?.filter(l => l.component_id !== component.id || l.port !== port) ?? []; if (e.target.value.trim()) labels.push({ component_id: component.id, port, name: e.target.value.trim() }); applyDocument({ ...doc, node_labels: labels });
          }} /><small className="circuit-muted">英字で始まる英数字・_。同じ名前を付けても配線による接続は必要です。</small></label>)}<div className="circuit-fields">{numeric(`${component.id}.x`, { key: "x", label: "位置 X" }, component.position.x, n => updateComponent({ ...component, position: { ...component.position, x: n! } }))}{numeric(`${component.id}.y`, { key: "y", label: "位置 Y" }, component.position.y, n => updateComponent({ ...component, position: { ...component.position, y: n! } }))}</div></details>
        </fieldset> : <p className="circuit-muted">回路図か一覧から素子を選ぶと、パラメータを編集できます。配線を選んで Delete キーで削除できます。</p>}
      </aside>
    </div>
    {!validDraft && <div className="circuit-feedback error" role="alert">数値の入力が未完了です。計算・保存の前に入力を修正してください。<ul>{[...new Set(draftErrors)].map(message => <li key={message}>{message}</li>)}</ul></div>}
    {checkMessage && <div className="circuit-feedback" role="status">{checkMessage}</div>}
    <details className="circuit-validation" open={s.enabled && documentErrors.length > 0}><summary>{documentErrors.length ? `回路の確認事項（${documentErrors.length} 件）` : "回路の基本チェック: 接続と入力値を確認済み"}</summary>{documentErrors.length ? <ul>{documentErrors.map(message => <li key={message}>{message}</li>)}</ul> : <p className="circuit-muted">計算前に「回路を検証」で回路方程式の構成を確認できます。</p>}</details>
    <details className="circuit-import"><summary>回路 JSON の読み込み</summary><p className="circuit-muted">CircuitDocument または external_circuit.document を貼り付けます。PIC を 1 個含む回路が必要です。回路はプロジェクト保存に含まれます。</p><button type="button" disabled={disabled} onClick={() => { setImportText(JSON.stringify(doc, null, 2)); setImportOpen(true); }}>回路 JSON を編集</button>{importOpen && <><textarea aria-label="回路 JSON" value={importText} onChange={e => setImportText(e.target.value)} spellCheck={false} rows={12} /><div className="circuit-tool-group"><button type="button" disabled={disabled} onClick={() => { try { const raw = JSON.parse(importText), next = normalizeCircuitDocument(raw.external_circuit?.document ?? raw.document ?? raw); applyDocument(next, false); setSelected(next.components.find(c => c.kind === "PIC")!.id); setImportOpen(false); setNotice("回路 JSON を読み込みました。"); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); } }}>回路 JSON を適用</button><button type="button" onClick={() => setImportOpen(false)}>閉じる</button></div></>}</details>
  </section>;
}
