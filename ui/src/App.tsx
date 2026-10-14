import { useEffect, useRef, useState } from "react";
import { backendPort, DEFAULT_PORT, getJson, isTauri, openProjectText, PicClient, saveText, type Health, type RunCommand } from "./api";
import { Chart, LiveCharts, ResultsCharts, Toggle } from "./Charts";
import { csvText, defaultSettings, interpolate, loadProject, normalizeSettings, numberText, numericPath, rangeValues, saveProject, setNumericPath, sweepValues, validateSettings, type Frame, type Result, type SavedRun, type Settings, type Started } from "./model";
import { NumberField, SettingsPanel } from "./Settings";
import { useTheme, type ThemeMode } from "./theme";
import { CircuitEditor } from "./CircuitEditor";
import { defaultExternalCircuit } from "./circuitmodel";
import { readEditingMode, validateWizardStep, wizardSteps, type EditingMode } from "./wizard";
import { WizardNavigation, WizardSummary } from "./SetupWizard";

function initialSettings(): Settings {
  try { const saved = localStorage.getItem("picora1d.settings"); if (saved) return normalizeSettings(JSON.parse(saved)); } catch { /* 古い形式や破損した設定は初期設定で復旧 */ }
  return defaultSettings();
}
interface SweepCase { value: number; state: "waiting" | "running" | "done" | "stopped" | "error"; runId?: string; error?: string }
export function App() {
  const theme = useTheme();
  const [editingMode, setEditingMode] = useState<EditingMode>(readEditingMode), [wizardStep, setWizardStep] = useState(0), [wizardFinished, setWizardFinished] = useState(false);
  const wizard = editingMode === "wizard" && !wizardFinished;
  const wizardHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!wizard) return;
    document.querySelector(".settings-pane")?.scrollTo(0, 0);
    document.querySelector(".results-pane")?.scrollTo(0, 0);
    wizardHeading.current?.focus({ preventScroll: true });
  }, [wizard, wizardStep]);
  const [settings, setSettings] = useState<Settings>(initialSettings), [port, setPort] = useState<number | null>(null);
  const [connected, setConnected] = useState(false), [health, setHealth] = useState<Health | null>(null), [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [running, setRunning] = useState(false), [stopping, setStopping] = useState(false), [canContinue, setCanContinue] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null), [started, setStarted] = useState<Started | null>(null), [warnings, setWarnings] = useState<string[]>([]);
  const [runs, setRuns] = useState<SavedRun[]>([]), [selected, setSelected] = useState("live"), [retainedRunId, setRetainedRunId] = useState("");
  const [extraSteps, setExtraSteps] = useState(1000), [name, setName] = useState("無題"), [dirty, setDirty] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"results" | "sweep" | "circuit">("results");
  const [circuitDraftValid, setCircuitDraftValid] = useState(true);
  const [sweepPath, setSweepPath] = useState("left.v_dc"), [sweepText, setSweepText] = useState("0, 50, 100");
  const [sweepRange, setSweepRange] = useState(false), [sweepLog, setSweepLog] = useState(false), [sweepStart, setSweepStart] = useState(0), [sweepEnd, setSweepEnd] = useState(100), [sweepCount, setSweepCount] = useState(3);
  const [cases, setCases] = useState<SweepCase[]>([]), [sweepCaseIndex, setSweepCaseIndex] = useState<number | null>(null), [lastSweepPath, setLastSweepPath] = useState("");
  const client = useRef<PicClient | null>(null), stopped = useRef(false), runningRef = useRef(false), retainedSettings = useRef<Settings | null>(null), instance = useRef<string | undefined>(undefined), file = useRef<HTMLInputElement>(null), revision = useRef(0);
  useEffect(() => { let alive = true; backendPort().then(p => { if (alive) setPort(p); }).catch(e => { if (alive) setConnectionError(`バックエンドのポートを取得できません: ${String(e)}`); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (port === null) return;
    let alive = true;
    const check = async () => {
      try {
        const h = await getJson<Health>(port, "/health"); if (!alive) return;
        if (h.status !== "ok") throw new Error("/health の応答が不正です。");
        if (instance.current && h.instance && instance.current !== h.instance) { client.current?.close(); client.current = null; setCanContinue(false); retainedSettings.current = null; setNotice("バックエンドが再起動しました。保持中の粒子状態は失われました。保存済み結果は引き続き表示できます。"); }
        instance.current = h.instance; setConnected(true); setHealth(h); setConnectionError("");
      } catch (e) { if (alive) { setConnected(false); setConnectionError(`計算サーバーに接続できません (${port}): ${e instanceof Error ? e.message : String(e)}`); } }
    };
    void check(); const timer = setInterval(() => void check(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [port]);
  useEffect(() => { try { localStorage.setItem("picora1d.settings", JSON.stringify(settings)); } catch { /* 保存制限がある場合でもアプリは動作 */ } }, [settings]);
  useEffect(() => { try { localStorage.setItem("picora1d.editingMode", editingMode); } catch { /* 保存できない場合も切替可能 */ } }, [editingMode]);
  useEffect(() => () => { client.current?.close(); }, []);
  const markDirty = () => { revision.current++; setDirty(true); };
  const change = (s: Settings) => { setSettings(s); markDirty(); };
  const selectedRun = runs.find(r => r.id === selected);
  const validation = validateSettings(settings);
  const switchEditingMode = (mode: EditingMode) => { setEditingMode(mode); setWizardFinished(false); setWizardStep(0); setError(""); };
  const editCircuit = () => { if (wizard) setWizardStep(1); setWorkspaceTab("circuit"); };
  const reportInvalidInput = (all = false) => {
    const form = document.getElementById("settings-form");
    const invalid = Array.from(form?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea") ?? []).find(input => (all || !input.closest("[hidden]")) && !input.validity.valid);
    if (!invalid) return false;
    const section = invalid.closest<HTMLDetailsElement>("[data-section]");
    if (section) { section.open = true; if (wizard) setWizardStep(Math.max(0, wizardSteps.findIndex(step => step.id === section.dataset.section))); }
    setError("入力途中・不正な値があります。表示された項目を確認してください。");
    requestAnimationFrame(() => invalid.reportValidity()); return true;
  };
  const selectWizardStep = (next: number) => {
    if (next > wizardStep) {
      if (reportInvalidInput()) return;
      if (wizardStep === 1 && !circuitDraftValid) { editCircuit(); setError("回路の入力途中・不正な数値を確認してください。"); return; }
      const errors = validateWizardStep(settings, wizardStep); if (errors.length) { setError(errors.join("\n")); return; }
      if (next === wizardSteps.length - 1 && reportInvalidInput(true)) return;
    }
    setWizardStep(next); setError("");
  };
  const getClient = () => { if (port === null) throw new Error("バックエンドのポートを確認中です。"); if (!client.current || client.current.port !== port) { client.current?.close(); client.current = new PicClient(port, () => { setCanContinue(false); retainedSettings.current = null; }); } return client.current; };
  const validateForm = () => {
    if (!circuitDraftValid) { editCircuit(); setError("回路の入力途中・不正な数値を確認してください。"); return false; }
    if (reportInvalidInput(true)) return false;
    const form = document.getElementById("settings-form") as HTMLFormElement | null;
    if (form && !form.reportValidity()) return false;
    const errors = validateSettings(settings); if (errors.length) { setError(errors.join("\n")); return false; } return true;
  };
  const execute = async (s: Settings, label: string, command: RunCommand, sweepValue?: number): Promise<SavedRun> => {
    setSelected("live"); setStarted(null); setFrame(null); setWarnings([]);
    const api = getClient();
    const result = await api.run(command, event => {
      if (event.type === "started") { setStarted(event); setWarnings(event.warnings ?? []); if (stopped.current) api.stop(); }
      if (event.type === "frame") setFrame(event);
    });
    const actual = normalizeSettings(result.settings ?? s);
    const record: SavedRun = { id: crypto.randomUUID(), label, created: new Date().toISOString(), settings: actual, result, stopped: stopped.current, ...(sweepValue === undefined ? {} : { sweepValue }) };
    setRuns(previous => [...previous, record]); setSelected(record.id); markDirty();
    retainedSettings.current = structuredClone(actual); setRetainedRunId(record.id); setCanContinue(true); return record;
  };
  const begin = () => { stopped.current = false; runningRef.current = true; setRunning(true); setStopping(false); setError(""); setNotice(""); setCanContinue(false); };
  const end = () => { runningRef.current = false; setRunning(false); setStopping(false); setSweepCaseIndex(null); };
  const run = async (continuation = false) => {
    if (runningRef.current || !connected || (!continuation && !validateForm())) return;
    if (continuation && (!retainedSettings.current || !Number.isInteger(extraSteps) || extraSteps <= 0)) { setError("追加ステップ数は正の整数が必要です。"); return; }
    const s = structuredClone(continuation ? retainedSettings.current! : settings);
    begin(); setWorkspaceTab("results"); if (wizard) setWizardFinished(true);
    try { await execute(s, `${continuation ? "続き" : "実行"} #${runs.length + 1}`, continuation ? { cmd: "continue", extra_steps: extraSteps, frame_every: s.frame_every, avg_steps: s.avg_steps, phase_bins: s.phase_bins } : { cmd: "start", project: { pic1d: s } }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setCanContinue(false); retainedSettings.current = null; }
    finally { end(); }
  };
  const stop = () => { stopped.current = true; setStopping(true); client.current?.stop(); };
  const runSweep = async () => {
    if (runningRef.current || !connected || !validateForm()) return;
    let values: number[], base: Settings;
    try { values = sweepRange ? rangeValues(sweepStart, sweepEnd, sweepCount, sweepLog) : sweepValues(sweepText); base = structuredClone(settings); numericPath(base, sweepPath); for (const v of values) { const errors = validateSettings(setNumericPath(base, sweepPath, v)); if (errors.length) throw new Error(`値 ${v}: ${errors.join(" ")}`); } }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    begin(); setWorkspaceTab("sweep"); setLastSweepPath(sweepPath); setCases(values.map(value => ({ value, state: "waiting" }))); const path = sweepPath;
    try {
      for (let i = 0; i < values.length; i++) {
        if (stopped.current) break;
        const value = values[i], s = setNumericPath(base!, path, value); setSweepCaseIndex(i);
        setCases(previous => previous.map((c, j) => i === j ? { ...c, state: "running" } : c));
        try {
          const record = await execute(s, `${path} = ${numberText(value)}`, { cmd: "start", project: { pic1d: s } }, value);
          setCases(previous => previous.map((c, j) => i === j ? { ...c, state: stopped.current ? "stopped" : "done", runId: record.id } : c));
        } catch (e) { const message = e instanceof Error ? e.message : String(e); setCases(previous => previous.map((c, j) => i === j ? { ...c, state: "error", error: message } : c)); setError(message); setCanContinue(false); retainedSettings.current = null; break; }
      }
      if (stopped.current) setNotice("掃引を停止しました。未実行のケースは待機のまま残ります。");
    } finally { end(); }
  };
  const loadText = (text: string, filename: string) => {
    try { const loaded = loadProject(JSON.parse(text)); setSettings(loaded.settings); setWizardStep(0); setWizardFinished(false); setRuns(previous => [...previous, ...loaded.runs]); setSelected(loaded.runs.at(-1)?.id ?? "live"); setName(filename.replace(/\.json$/i, "")); revision.current++; setDirty(false); setCanContinue(false); retainedSettings.current = null; setError(""); setNotice(`「${filename}」を読み込みました。${loaded.runs.length ? ` 結果 ${loaded.runs.length} 件を追加しました。` : ""}`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const open = async () => { if (!isTauri()) { file.current?.click(); return; } try { const loaded = await openProjectText(); if (loaded) loadText(loaded.text, loaded.name); } catch (e) { setError(String(e)); } };
  const save = async (includeResults: boolean) => { if (!circuitDraftValid) { editCircuit(); setError("回路の入力途中・不正な数値を確認してから保存してください。"); return; } const savedRevision = revision.current; try { const saved = await saveText(`${name === "無題" ? "picora1d-project" : name}${includeResults ? "-results" : ""}.json`, saveProject(settings, includeResults ? runs : [])); if (saved && savedRevision === revision.current) setDirty(false); } catch (e) { setError(String(e)); } };
  const checkCircuit = async () => {
    if (!connected || port === null) throw new Error("計算サーバーに接続してから検証してください。");
    const result = await getJson<{ valid: boolean; nodes: unknown[]; electrode_voltage_v: number[] }>(port, "/circuit/validate", { gap_m: settings.gap_m, external_circuit: { ...settings.external_circuit ?? defaultExternalCircuit(), enabled: true } });
    return `回路の接続と初期状態を確認しました（${result.nodes.length} ノード）。初期電極電圧: 左 ${numberText(result.electrode_voltage_v[0])} V / 右 ${numberText(result.electrode_voltage_v[1])} V。`;
  };
  const exportProfile = async () => { if (!selectedRun?.result.profiles) return; const p = selectedRun.result.profiles; try { await saveText("picora1d-profiles.csv", csvText(["x_m", "phi_V", "E_V_m", "ne_m-3", "ni_m-3", "Te_eV", "ionization_m-3_s-1"], [p.x, p.phi, p.e, p.n_e, p.n_i, p.t_e, p.ionization]), "csv"); } catch (e) { setError(String(e)); } };
  const execution = selectedRun?.result.execution ?? frame?.execution ?? started?.execution;
  const cpuLabel = execution ? execution.enabled ? `CPU 並列 / ${execution.threads} スレッド` : "CPU 逐次" : settings.parallel ? `CPU 並列 / ${settings.cpu_threads ?? "自動"}` : "CPU 逐次";
  const fallbackReason = execution?.fallback_reason || (settings.parallel && health?.execution?.available === false ? "この環境ではNumbaを利用できないため、NumPyの逐次計算を使用します。" : "");
  const progress = started && frame ? Math.max(0, Math.min(1, (frame.step - started.step_offset) / started.n_steps)) : 0;
  const suggestedPaths = ["gap_m", "init_density_m3", "n_macro", "left.v_dc", "right.v_dc", ...(settings.mcc ? ["mcc.gas.pressure_pa", "mcc.gas.temperature_k"] : []), ...(["left", "right"] as const).flatMap(side => { const e = settings[side]; const rf = e.voltage_rf; return [...(rf ? Array.isArray(rf) ? rf.flatMap((_, i) => [`${side}.voltage_rf.${i}.amplitude`, `${side}.voltage_rf.${i}.freq_hz`]) : [`${side}.voltage_rf.amplitude`, `${side}.voltage_rf.freq_hz`] : []), ...(e.fn ? [`${side}.fn.beta`, `${side}.fn.phi_ev`] : []), ...(e.blocking_capacitor ? [`${side}.blocking_capacitor.capacitance`, `${side}.blocking_capacitor.initial_bias_v`] : [])]; })];
  return <div className="app">
    <header className="app-header"><div className="brand"><div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /><span /></div><div><h1>PICORA<span>-1D</span></h1><p>静電 PIC / MCC ・ 1d3v</p></div></div><div className="header-actions"><span className="document-name">{name}{dirty ? " · 未保存" : ""}</span><button type="button" disabled={running} onClick={() => void open()}>開く</button><button type="button" onClick={() => void save(false)}>設定を保存</button><button type="button" disabled={!runs.length} onClick={() => void save(true)}>結果付き保存</button><select aria-label="設定モード" value={editingMode} disabled={running} onChange={e => switchEditingMode(e.target.value as EditingMode)}><option value="direct">直接編集</option><option value="wizard">ウィザード</option></select>{editingMode === "wizard" && wizardFinished && <button type="button" disabled={running} onClick={() => switchEditingMode("wizard")}>ウィザードで再設定</button>}<select aria-label="カラーテーマ" value={theme.mode} onChange={e => theme.setMode(e.target.value as ThemeMode)}><option value="system">OS の配色</option><option value="light">ライト</option><option value="dark">ダーク</option></select></div></header>
    <input ref={file} type="file" accept=".json" hidden onChange={async e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadText(await f.text(), f.name); }} />
    <div className={`workbench${wizard ? " wizard-workbench" : ""}`}><aside className="settings-pane"><div className="pane-title"><div><h2>{wizard ? "設定ウィザード" : "計算条件"}</h2><span>一様格子の平行平板モデル</span></div><button type="button" className="tiny" disabled={running} onClick={() => { change(defaultSettings()); setWizardStep(0); setName("無題"); setNotice("軽量な初期設定に戻しました。"); }}>初期設定</button></div>{wizard && <><WizardNavigation step={wizardStep} select={selectWizardStep} /><div className="wizard-step-heading"><p className="hint">手順 {wizardStep + 1} / {wizardSteps.length}</p><h2 ref={wizardHeading} tabIndex={-1}>{wizardSteps[wizardStep].title}</h2><p>{wizardSteps[wizardStep].description}</p></div></>}<SettingsPanel settings={settings} change={change} port={port ?? DEFAULT_PORT} connected={connected} theme={theme.resolved} report={setError} disabled={running} maxThreads={health?.execution?.max_threads} onEditCircuit={editCircuit} section={wizard ? wizardSteps[wizardStep].id : undefined} />{wizard && <>{wizardStep === wizardSteps.length - 1 && <div className="wizard-final-note"><p>右の一覧で条件を確認してください。「設定を確定して実行」で計算を開始し、結果画面を表示します。</p>{validation.length > 0 && <p className="error" role="alert">{validation.join(" ")}</p>}</div>}<div className="wizard-footer"><button type="button" disabled={wizardStep === 0} onClick={() => selectWizardStep(wizardStep - 1)}>戻る</button>{wizardStep < wizardSteps.length - 1 ? <button type="button" className="primary" onClick={() => selectWizardStep(wizardStep + 1)}>次へ →</button> : <button type="button" className="primary" disabled={!connected || Boolean(validation.length) || !circuitDraftValid} onClick={() => void run()}>設定を確定して実行</button>}<button type="button" onClick={() => switchEditingMode("direct")}>直接編集へ</button></div></>}</aside>
    <main className="results-pane"><section className="run-toolbar" hidden={wizard}><div className="run-main"><button type="button" className="primary run-button" disabled={running || !connected || Boolean(validation.length) || !circuitDraftValid} onClick={() => void run()}>▶ 実行</button><button type="button" disabled={!running || stopping} onClick={stop}>■ {stopping ? "停止中…" : "停止"}</button><span className="status-tag" data-running={running}>{running ? sweepCaseIndex === null ? "計算中" : `掃引 ${sweepCaseIndex + 1} / ${cases.length}` : "待機"}</span><div className="continue-controls"><label>追加ステップ<input aria-label="追加ステップ数" type="number" min={1} step={1} value={extraSteps} disabled={running} onChange={e => setExtraSteps(Number(e.target.value))} /></label><button type="button" disabled={running || !connected || !canContinue || !Number.isInteger(extraSteps) || extraSteps < 1} onClick={() => void run(true)} title="最後の計算で保持した粒子状態と設定から実行を続ける">続き</button></div></div><div className="run-progress"><progress max={1} value={progress} aria-label="計算進捗" /><span aria-live="polite">{started ? `${(frame?.step ?? started.step_offset).toLocaleString()} / ${(started.step_offset + started.n_steps).toLocaleString()} ステップ · dt = ${numberText(started.dt * 1e9)} ns` : "設定を確認して実行してください"}</span></div></section>
    {!connected && <div className="banner warning">{connectionError || "計算サーバーに接続中…"}<span>ブラウザで開発する場合: バックエンドをポート {port ?? DEFAULT_PORT} で起動してください。</span></div>}
    {error && <div className="banner error" role="alert"><span>{error}</span><button type="button" className="tiny" onClick={() => setError("")} aria-label="エラーを閉じる">×</button></div>}{notice && <div className="banner info"><span>{notice}</span><button type="button" className="tiny" onClick={() => setNotice("")} aria-label="通知を閉じる">×</button></div>}{validation.length > 0 && <div className="banner error" role="alert">{validation.join(" ")}</div>}
    {fallbackReason && <div className="banner warning">{fallbackReason}</div>}
    {warnings.length > 0 && <details className="warnings"><summary>計算条件の警告 ({warnings.length})</summary><ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
    <div className="workspace-heading" hidden={wizard}><div className="tabs main-tabs" role="tablist" aria-label="作業ビュー"><button type="button" role="tab" aria-selected={workspaceTab === "results"} onClick={() => setWorkspaceTab("results")}>シミュレーション</button><button type="button" role="tab" aria-selected={workspaceTab === "sweep"} onClick={() => setWorkspaceTab("sweep")}>パラメータ掃引</button><button type="button" role="tab" aria-selected={workspaceTab === "circuit"} onClick={() => setWorkspaceTab("circuit")}>外部回路</button></div><div className="result-picker"><select aria-label="表示する実行" value={selected} onChange={e => setSelected(e.target.value)}><option value="live">ライブ表示</option>{runs.map(r => <option key={r.id} value={r.id}>{r.label}{r.stopped ? " (停止)" : ""}</option>)}</select><button type="button" className="tiny" disabled={!selectedRun?.result.profiles} onClick={() => void exportProfile()}>平均場 CSV</button>{selectedRun && <button type="button" className="tiny" disabled={running} onClick={() => { change(structuredClone(selectedRun.settings)); setNotice(`${selectedRun.label} の計算条件を取り込みました。`); }}>条件を取り込む</button>}</div></div>
    <div className="results-content"><div hidden={wizard ? wizardStep !== 1 : workspaceTab !== "circuit"}><CircuitEditor active={wizard ? wizardStep === 1 : workspaceTab === "circuit"} value={settings.external_circuit ?? defaultExternalCircuit()} onChange={external_circuit => change({ ...settings, external_circuit })} disabled={running} onValidityChange={setCircuitDraftValid} onCheck={checkCircuit} /></div>{wizard && <WizardSummary settings={settings} />}<div hidden={wizard || workspaceTab === "circuit"}>{workspaceTab === "results" ? selectedRun ? <><div className="run-caption"><strong>{selectedRun.label}</strong><span>{new Date(selectedRun.created).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}{selectedRun.stopped ? " / 停止結果" : ""}</span><button type="button" className="tiny" onClick={() => { setRuns(previous => previous.filter(r => r.id !== selectedRun.id)); setSelected("live"); markDirty(); }}>この結果を削除</button></div><ResultsCharts key={selectedRun.id} run={selectedRun} runs={runs} theme={theme.resolved} continuable={canContinue && retainedRunId === selectedRun.id} /></> : <LiveCharts frame={frame} started={started} theme={theme.resolved} /> : <><section className="sweep-settings"><h2>1 つのパラメータを順に掃引</h2><p className="hint">現在の設定の数値を変更し、各ケースを順番に実行します。ケースごとに結果を保存し、平均場を比較できます。</p><fieldset disabled={running}><label className="text-field">対象パス<input aria-label="掃引対象パス" list="sweep-paths" value={sweepPath} onChange={e => setSweepPath(e.target.value)} /><datalist id="sweep-paths">{suggestedPaths.map(path => <option value={path} key={path} />)}</datalist></label><p className="hint">例: left.v_dc、mcc.gas.pressure_pa。値は JSON と同じ SI 単位です。</p><Toggle label="開始値〜終了値で指定" value={sweepRange} set={setSweepRange} />{sweepRange ? <><div className="field-grid three"><NumberField label="開始値" value={sweepStart} change={v => setSweepStart(v!)} /><NumberField label="終了値" value={sweepEnd} change={v => setSweepEnd(v!)} /><NumberField label="ケース数" value={sweepCount} min={2} max={100} integer change={v => setSweepCount(v!)} /></div><Toggle label="対数で等間隔" value={sweepLog} set={setSweepLog} /></> : <label className="text-field">値のリスト<input aria-label="掃引値のリスト" value={sweepText} onChange={e => setSweepText(e.target.value)} placeholder="0, 50, 100" /></label>}<button type="button" className="primary" disabled={!connected || running || Boolean(validation.length) || !circuitDraftValid} onClick={() => void runSweep()}>掃引を実行</button></fieldset></section>{cases.length > 0 && <><section className="chart-card"><h3>ケース一覧 / {lastSweepPath}</h3><table><thead><tr><th>#</th><th>値 (SI)</th><th>状態</th><th>中心 n_e [m⁻³]</th><th>収束</th><th>結果</th></tr></thead><tbody>{cases.map((c, i) => { const record = runs.find(r => r.id === c.runId), p = record?.result.profiles; return <tr key={i}><td>{i + 1}</td><td>{numberText(c.value)}</td><td title={c.error}>{({ waiting: "待機", running: "計算中", done: "完了", stopped: "停止", error: "失敗" })[c.state]}</td><td>{numberText(p && record ? interpolate(p.x, p.n_e, record.settings.gap_m / 2) : null)}</td><td>{record ? record.result.convergence?.converged ? "収束" : "未収束" : "—"}</td><td><button type="button" className="tiny" disabled={!record} onClick={() => { if (record) { setSelected(record.id); setWorkspaceTab("results"); } }}>表示</button></td></tr>; })}</tbody></table></section><SweepChart cases={cases} runs={runs} path={lastSweepPath} theme={theme.resolved} /></>}{running && sweepCaseIndex !== null && <LiveCharts frame={frame} started={started} theme={theme.resolved} />}</> }</div></div>
    </main></div><footer className="statusbar"><span><i className={connected ? "connected-dot" : "disconnected-dot"} />{connected ? `backend ${health?.version ?? ""} · ${port}` : "backend 未接続"}</span><span>{cpuLabel} · {settings.n_cells + 1} 節点 · {settings.n_macro.toLocaleString()} 粒子 / 種</span><span>ES-Sim から抽出した 1D PIC / MCC</span></footer>
  </div>;
}
function SweepChart({ cases, runs, path, theme }: { cases: SweepCase[]; runs: SavedRun[]; path: string; theme: string }) {
  const completed = cases.map(c => ({ c, run: runs.find(r => r.id === c.runId) })).filter((v): v is { c: SweepCase; run: SavedRun } => Boolean(v.run?.result.profiles)).sort((a, b) => a.c.value - b.c.value);
  return <Chart title="掃引 / 中心電子密度" x={completed.map(v => v.c.value)} series={[{ label: "中心 n_e", values: completed.map(({ run }) => interpolate(run.result.profiles!.x, run.result.profiles!.n_e, run.settings.gap_m / 2)), points: true, color: 1 }]} xLabel={`${path} [SI]`} yLabel="n_e [m⁻³]" theme={theme} file="sweep-central-density" />;
}
