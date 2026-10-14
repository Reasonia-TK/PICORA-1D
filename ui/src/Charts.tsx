import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { palette } from "./theme";
import { saveText } from "./api";
import { csvText, electrodeVoltage, externalSourceVoltage, frequencies, interpolate, numberText, type Frame, type Result, type SavedRun, type Settings, type Started } from "./model";
import { filterQuantities, liveQuantities, resultQuantities, type PlotQuantity } from "./plotcatalog";
import "./quantity.css";

export interface Series { label: string; values: (number | null)[]; color?: number; points?: boolean; dash?: number[] }
export interface Marker { x: number; color?: number }
interface ChartProps { title: string; x: number[]; series: Series[]; xLabel: string; yLabel?: string; theme: string; log?: boolean; height?: number; markers?: Marker[]; tools?: ReactNode; note?: ReactNode; file?: string }
export function Chart({ title, x, series, xLabel, yLabel = "", theme, log = false, height = 210, markers = [], tools, note, file }: ChartProps) {
  const box = useRef<HTMLDivElement>(null), plot = useRef<uPlot | null>(null), markerRef = useRef(markers);
  const [exportError, setExportError] = useState("");
  markerRef.current = markers;
  const signature = JSON.stringify(series.map(s => ({ label: s.label, color: s.color, points: s.points, dash: s.dash })));
  const data = (): uPlot.AlignedData => [x, ...series.map(s => x.map((_, i) => { const v = s.values[i]; return v === null || v === undefined || !Number.isFinite(v) || (log && v <= 0) ? null : v; }))];
  useEffect(() => {
    if (!box.current) return;
    const colors = palette();
    const instance = new uPlot({
      width: Math.max(240, box.current.clientWidth), height, title: undefined,
      scales: { x: { time: false }, y: { distr: log ? 3 : 1 } },
      cursor: { drag: { x: true, y: false, setScale: true } },
      axes: [{ stroke: colors.text, grid: { stroke: colors.border }, label: xLabel, labelSize: 22, size: 44, font: "11px Segoe UI", values: (_u, ticks) => ticks.map(v => numberText(v, 2)) }, { stroke: colors.text, grid: { stroke: colors.border }, label: yLabel, labelSize: yLabel ? 20 : 0, size: 68, font: "11px Segoe UI", values: (_u, ticks) => ticks.map(v => numberText(v, 2)) }],
      series: [{ label: xLabel }, ...series.map((s, i) => ({ label: s.label, stroke: colors.colors[s.color ?? i % 6], width: s.points ? 0 : 1.7, dash: s.dash, points: { show: s.points ?? false, size: s.points ? 2 : 4 }, spanGaps: false }))],
      hooks: { draw: [u => {
        const ctx = u.ctx; ctx.save();
        for (const marker of markerRef.current) { const px = u.valToPos(marker.x, "x", true); if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue; ctx.beginPath(); ctx.setLineDash([5, 5]); ctx.strokeStyle = colors.colors[marker.color ?? 3]; ctx.lineWidth = 1; ctx.moveTo(px, u.bbox.top); ctx.lineTo(px, u.bbox.top + u.bbox.height); ctx.stroke(); }
        ctx.restore();
      }] },
    }, data(), box.current);
    plot.current = instance;
    const resize = new ResizeObserver(() => { if (box.current?.clientWidth) instance.setSize({ width: Math.max(240, box.current.clientWidth), height }); }); resize.observe(box.current);
    return () => { resize.disconnect(); instance.destroy(); plot.current = null; };
    // データは setData で差し替え、軸・系列・テーマが変わったときだけ再構築する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, xLabel, yLabel, log, height, theme]);
  useEffect(() => { plot.current?.setData(data()); }, [x, series, markers, log]);
  const exportCsv = async () => { try { await saveText(`${file ?? "picora1d-chart"}.csv`, csvText([xLabel, ...series.map(s => s.label)], [x, ...series.map(s => s.values)]), "csv"); setExportError(""); } catch (e) { setExportError(String(e)); } };
  return <section className="chart-card"><div className="chart-heading"><h3>{title}</h3><div className="chart-tools">{tools}<button className="tiny" type="button" onClick={() => void exportCsv()} disabled={!x.length} title="表示中のデータを CSV に保存">CSV</button></div></div><div className="plot" ref={box} role="img" aria-label={`${title}のグラフ`} />{!x.length && <p className="chart-empty">データがありません</p>}{note && <p className="hint chart-note">{note}</p>}{exportError && <p className="error" role="alert">{exportError}</p>}</section>;
}
export function VoltagePreview({ settings, theme }: { settings: Settings; theme: string }) {
  const freq = Math.min(...frequencies(settings));
  const period = Number.isFinite(freq) ? 1 / freq : 1e-7;
  const externalEnd = settings.external_circuit?.enabled ? settings.external_circuit.document.components.filter(c => c.kind === "V").map(c => {
    const w = c.parameters.waveform;
    if (w === null || typeof w !== "object" || Array.isArray(w)) return 0;
    if (w.kind === "pwl" && Array.isArray(w.points)) return Math.max(0, ...w.points.map(p => Array.isArray(p) ? Number(p[0]) : 0));
    return Number(w.delay_s ?? 0) + 2 * period;
  }) : [];
  const end = Math.max(2 * period, ...externalEnd.filter(Number.isFinite));
  const time = Array.from({ length: 201 }, (_, i) => end * i / 200);
  if (settings.external_circuit?.enabled) { const sources = settings.external_circuit.document.components.filter(c => c.kind === "V"); return <Chart title="外部回路の電圧源" x={time.map(v => v * 1e6)} series={sources.map((c, i) => ({ label: c.label, values: time.map(t => externalSourceVoltage(c.parameters, t)), color: i % 6 }))} xLabel="t [µs]" yLabel="V [V]" theme={theme} height={180} note="回路図の電圧源の波形です。PIC電極電圧は回路との連成計算で決まります。" file="external-source-voltage" />; }
  return <Chart title="電源の電圧波形" x={time.map(v => v * 1e6)} series={[{ label: "左電極", values: time.map(t => electrodeVoltage(settings.left, t)), color: 0 }, { label: "右電極", values: time.map(t => electrodeVoltage(settings.right, t)), color: 1 }]} xLabel="t [µs]" yLabel="V [V]" theme={theme} height={180} note="直流 + RF 成分 + CSV 波形の合成電源電圧。阻止コンデンサがある場合、電極電位は計算で決まります。" file="electrode-voltage" />;
}
const statusText: Record<string, string> = { warming: "履歴を集計中", noisy: "揺らぎが大きい", fail: "未収束", pass: "合格", resolving: "遅い変化の分解能を確認中" };
export function LiveCharts({ frame, started, theme }: { frame: Frame | null; started: Started | null; theme: string }) {
  const [view, setView] = useState<"overview" | "quantities">("quantities");
  const [frames, setFrames] = useState<Frame[]>([]);
  useEffect(() => { setFrames([]); }, [started]);
  useEffect(() => { if (frame) setFrames(previous => previous.at(-1)?.step === frame.step ? previous : [...previous.slice(-1999), frame]); }, [frame]);
  const quantities = useMemo(() => frame && started ? liveQuantities(frame, started, frames) : [], [frame, started, frames]);
  if (!frame || !started) return <div className="empty-state"><div className="empty-symbol">↔</div><h2>計算の様子をここに表示します</h2><p>設定を確認して「実行」を押してください。電位・電場・密度・温度・粒子速度などを物理量一覧から選んで表示できます。</p></div>;
  const x = started.x.map(v => v * 1e3);
  const phase = frame.sample ? frame.sample.x.map((v, i) => [v * 1e3, frame.sample!.vx[i]]).sort((a, b) => a[0] - b[0]) : [];
  return <><div className="metric-strip"><Metric label="時刻" value={`${numberText(frame.t * 1e9)} ns`} /><Metric label="電子 / イオン粒子" value={`${frame.counts.n_e?.toLocaleString("ja-JP") ?? "—"} / ${frame.counts.n_i?.toLocaleString("ja-JP") ?? "—"}`} /><Metric label="計算時間" value={`${numberText(frame.elapsed_s)} s`} />{frame.convergence && <Metric label="収束状態" value={statusText[frame.convergence.status] ?? frame.convergence.status} />}</div><div className="tabs" role="tablist" aria-label="ライブ表示"><button role="tab" type="button" aria-selected={view === "quantities"} onClick={() => setView("quantities")}>物理量一覧</button><button role="tab" type="button" aria-selected={view === "overview"} onClick={() => setView("overview")}>概要</button></div>{view === "quantities" ? <QuantityExplorer items={quantities} theme={theme} live /> : <div className="chart-grid"><Chart title="ライブ電位" x={x} series={[{ label: "φ", values: frame.phi }]} xLabel="x [mm]" yLabel="φ [V]" theme={theme} file="live-potential" /><Chart title="ライブ密度" x={x} series={[{ label: "n_e", values: frame.n_e, color: 1 }, { label: "n_i", values: frame.n_i, color: 0 }]} xLabel="x [mm]" yLabel="n [m⁻³]" theme={theme} file="live-density" /><Chart title="電子の位相空間" x={phase.map(p => p[0])} series={[{ label: "電子", values: phase.map(p => p[1]), color: 1, points: true }]} xLabel="x [mm]" yLabel="v_x [m/s]" theme={theme} file="phase-space" />{frame.circuit?.map(c => <section className="chart-card" key={c.label}><h3>{c.label === "left" ? "左" : "右"}電極 / 阻止コンデンサ</h3><div className="metrics"><Metric label="電極電位" value={`${numberText(c.v_e)} V`} /><Metric label="自己バイアス" value={`${numberText(c.v_dc)} V`} /><Metric label="基本波振幅" value={`${numberText(c.v1)} V`} /></div></section>)}</div>}</>;
}
export function Metric({ label, value }: { label: string; value: ReactNode }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
type ResultTab = "quantities" | "profiles" | "phase" | "distributions" | "sheath" | "history";
export function ResultsCharts({ run, runs, theme, continuable = false }: { run: SavedRun; runs: SavedRun[]; theme: string; continuable?: boolean }) {
  const r = run.result, p = r.profiles;
  const [tab, setTab] = useState<ResultTab>("quantities");
  const quantities = useMemo(() => resultQuantities(r, run.settings), [r, run.settings]);
  const [field, setField] = useState<keyof Pick<NonNullable<Result["profiles"]>, "phi" | "e" | "n_e" | "n_i" | "t_e" | "ionization">>("phi");
  const [compare, setCompare] = useState("");
  const [densityLog, setDensityLog] = useState(false), [spectrumLog, setSpectrumLog] = useState(true), [distributionLog, setDistributionLog] = useState(false);
  const [bin, setBin] = useState(0), [playing, setPlaying] = useState(false), [eepf, setEepf] = useState(false);
  const [showSheath, setShowSheath] = useState(true);
  const cycle = r.cycle;
  useEffect(() => { setBin(0); setPlaying(false); }, [run.id]);
  useEffect(() => { if (!playing || !cycle) return; const timer = setInterval(() => setBin(v => (v + 1) % cycle.bins), 100); return () => clearInterval(timer); }, [playing, cycle]);
  const cmp = runs.find(v => v.id === compare && v.id !== run.id)?.result.profiles;
  const labels = { phi: "φ [V]", e: "E [V/m]", n_e: "n_e [m⁻³]", n_i: "n_i [m⁻³]", t_e: "T_e [eV]", ionization: "電離生成率 [m⁻³s⁻¹]" };
  const sheath = showSheath && r.sheath ? [r.sheath.left_s === null ? null : { x: r.sheath.left_s * 1e3, color: 3 }, r.sheath.right_s === null ? null : { x: (run.settings.gap_m - r.sheath.right_s) * 1e3, color: 4 }].filter(v => v !== null) : [];
  const center = (key: "n_e" | "t_e") => p ? interpolate(p.x, p[key], run.settings.gap_m / 2) : null;
  return <>
    <div className="metric-strip"><Metric label="中心電子密度" value={`${numberText(center("n_e"))} m⁻³`} /><Metric label="中心電子温度" value={`${numberText(center("t_e"))} eV`} /><Metric label="左右シース厚" value={`${numberText(r.sheath?.left_s == null ? null : r.sheath.left_s * 1e3)} / ${numberText(r.sheath?.right_s == null ? null : r.sheath.right_s * 1e3)} mm`} /><Metric label="計算時間" value={`${numberText(r.elapsed_s)} s`} /></div>
    <div className="tabs" role="tablist" aria-label="結果の種類">{([["quantities", "物理量一覧"], ["profiles", "平均場"], ["phase", "RF 位相分解"], ["distributions", "EEDF / IEDF"], ["sheath", "シース / FFT"], ["history", "履歴 / 収束"]] as const).map(([key, label]) => <button role="tab" type="button" aria-selected={tab === key} key={key} onClick={() => { setTab(key); setPlaying(false); }}>{label}</button>)}</div>
    {tab === "quantities" && <QuantityExplorer items={quantities} theme={theme} />}
    {tab === "profiles" && !p && <p className="warning missing-profile">{run.stopped ? `平均区間に入る前に停止したため、平均場データはありません。${continuable ? "「続き」で計算を延長できます。" : "平均区間またはステップ数を調整して再実行してください。"}` : "時間平均データはありません。平均区間またはステップ数を確認してください。"}</p>}
    {tab === "profiles" && <div className="chart-grid">
      <Chart title="時間平均プロファイル" x={p?.x.map(v => v * 1e3) ?? []} series={p ? [{ label: labels[field], values: p[field], color: field === "n_e" ? 1 : 0 }, ...(cmp ? [{ label: "比較結果", values: p.x.map(x => x < cmp.x[0] || x > cmp.x.at(-1)! ? null : interpolate(cmp.x, cmp[field], x)), color: 2, dash: [5, 4] }] : [])] : []} xLabel="x [mm]" yLabel={labels[field]} theme={theme} log={densityLog && ["n_e", "n_i", "ionization"].includes(field)} height={280} markers={sheath} tools={<><select aria-label="プロファイルの量" value={field} onChange={e => setField(e.target.value as typeof field)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="比較する実行" value={compare} onChange={e => setCompare(e.target.value)}><option value="">比較なし</option>{runs.filter(v => v.id !== run.id && v.result.profiles).map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></>} note={`${p?.avg_steps ?? 0} ステップで平均。破線の縦線は Brinkmann のシース端。`} file={`profile-${field}`} />
      <Chart title="電子・イオン密度" x={p?.x.map(v => v * 1e3) ?? []} series={p ? [{ label: "n_e", values: p.n_e, color: 1 }, { label: "n_i", values: p.n_i, color: 0 }] : []} xLabel="x [mm]" yLabel="n [m⁻³]" theme={theme} log={densityLog} height={280} markers={sheath} tools={<><Toggle label="対数" value={densityLog} set={setDensityLog} /><Toggle label="シース端" value={showSheath} set={setShowSheath} /></>} file="average-density" />
      <Chart title="電子温度" x={p?.x.map(v => v * 1e3) ?? []} series={p ? [{ label: "T_e", values: p.t_e, color: 2 }] : []} xLabel="x [mm]" yLabel="T_e [eV]" theme={theme} file="electron-temperature" />
      <Chart title="平均電場" x={p?.x.map(v => v * 1e3) ?? []} series={p ? [{ label: "E", values: p.e, color: 0 }] : []} xLabel="x [mm]" yLabel="E [V/m]" theme={theme} file="electric-field" />
      <Chart title="電離生成率" x={p?.x.map(v => v * 1e3) ?? []} series={p ? [{ label: "電離", values: p.ionization, color: 4 }] : []} xLabel="x [mm]" yLabel="S_i [m⁻³s⁻¹]" theme={theme} file="ionization" />
      <VoltagePreview settings={run.settings} theme={theme} />
    </div>}
    {tab === "phase" && (cycle ? <><div className="playback"><button type="button" onClick={() => setPlaying(v => !v)}>{playing ? "一時停止" : "再生"}</button><input aria-label="RF 位相" type="range" min={0} max={cycle.bins - 1} value={Math.min(bin, cycle.bins - 1)} onChange={e => setBin(Number(e.target.value))} /><span>{numberText(360 * bin / cycle.bins, 1)}°</span><span className="hint">{numberText(cycle.freq_hz / 1e6)} MHz</span></div><div className="chart-grid">{(["phi", "n_e", "n_i"] as const).map(key => <Chart key={key} title={`位相分解 / ${labels[key]}`} x={(p?.x ?? Array.from({ length: run.settings.n_cells + 1 }, (_, i) => run.settings.gap_m * i / run.settings.n_cells)).map(v => v * 1e3)} series={[{ label: key, values: cycle[key][bin] ?? [], color: key === "n_e" ? 1 : 0 }]} xLabel="x [mm]" yLabel={labels[key]} theme={theme} height={240} markers={cycle.sheath && showSheath ? [cycle.sheath.s_left[bin] == null ? null : { x: cycle.sheath.s_left[bin]! * 1e3, color: 3 }, cycle.sheath.s_right[bin] == null ? null : { x: (run.settings.gap_m - cycle.sheath.s_right[bin]!) * 1e3, color: 4 }].filter(v => v !== null) : []} file={`phase-${bin}-${key}`} />)}{cycle.sheath && <Chart title="位相ごとのシース厚" x={Array.from({ length: cycle.bins }, (_, i) => i * 360 / cycle.bins)} series={[{ label: "左", values: cycle.sheath.s_left.map(v => v === null ? null : v * 1e3), color: 3 }, { label: "右", values: cycle.sheath.s_right.map(v => v === null ? null : v * 1e3), color: 4 }]} xLabel="RF 位相 [°]" yLabel="s [mm]" theme={theme} markers={[{ x: bin * 360 / cycle.bins }]} file="phase-sheath" />}</div></> : <Empty text="RF 位相分解データがありません。RF または CSV 波形と、位相ビン数を設定してください。" />)}
    {tab === "distributions" && <><div className="filter-row"><Toggle label="対数軸" value={distributionLog} set={setDistributionLog} /><Toggle label="EEPF 表示 (f / √E)" value={eepf} set={setEepf} /></div><div className="chart-grid">{r.eedf?.map((d, i) => <Chart key={i} title={`${eepf ? "EEPF" : "EEDF"} / ${d.label || `領域 ${i + 1}`}`} x={d.e_centers} series={[{ label: eepf ? "EEPF" : "EEDF", values: d.f.map((v, j) => eepf ? d.e_centers[j] > 0 ? v / Math.sqrt(d.e_centers[j]) : null : v), color: 1 }]} xLabel="電子エネルギー [eV]" yLabel={eepf ? "f / √E [eV⁻³ᐟ²]" : "f [eV⁻¹]"} theme={theme} log={distributionLog} note={`平均 ${numberText(d.mean_energy_ev)} eV / T_eff ${numberText(d.t_eff_ev)} eV / ${d.n_samples.toLocaleString()} 試料 / 範囲外 ${numberText((d.overflow_frac ?? 0) * 100)}%`} file={`eedf-${i + 1}`} />)}{r.wall_iedf && (["left", "right"] as const).map((side, i) => { const d = r.wall_iedf![side]; return <Chart key={side} title={`壁 IEDF / ${side === "left" ? "左" : "右"}電極`} x={d.e_centers} series={[{ label: "IEDF", values: d.f, color: i }]} xLabel="入射イオンエネルギー [eV]" yLabel="f [eV⁻¹]" theme={theme} log={distributionLog} note={`平均 ${numberText(d.mean_energy_ev)} eV / ${d.n_samples.toLocaleString()} 試料`} file={`wall-iedf-${side}`} />; })}</div>{!r.eedf?.length && !r.wall_iedf && <Empty text="エネルギー分布がありません。EEDF 集計領域または壁 IEDF ビン数を設定してください。" />}</>}
    {tab === "sheath" && <div className="chart-grid">{r.sheath_ts && <Chart title="シース厚の時間変化" x={r.sheath_ts.t.map(v => v * 1e6)} series={[{ label: "左", values: r.sheath_ts.s_left.map(v => v === null ? null : v * 1e3), color: 3 }, { label: "右", values: r.sheath_ts.s_right.map(v => v === null ? null : v * 1e3), color: 4 }]} xLabel="t [µs]" yLabel="s [mm]" theme={theme} height={280} file="sheath-time" />}{r.sheath_fft && <Chart title="シース振動スペクトル" x={r.sheath_fft.freq_hz.slice(1).map(v => v / 1e6)} series={[{ label: "左", values: r.sheath_fft.amp_left.slice(1).map(v => v * 1e3), color: 3 }, { label: "右", values: r.sheath_fft.amp_right.slice(1).map(v => v * 1e3), color: 4 }]} xLabel="f [MHz]" yLabel="振幅 [mm]" theme={theme} log={spectrumLog} height={280} tools={<Toggle label="対数" value={spectrumLog} set={setSpectrumLog} />} markers={r.sheath_fft.f0_hz ? Array.from({ length: 10 }, (_, i) => ({ x: r.sheath_fft!.f0_hz! * (i + 1) / 1e6, color: 5 })) : []} note={`分解能 ${numberText(r.sheath_fft.df_hz / 1e6)} MHz / ${r.sheath_fft.n_samples} 試料。DC 成分は除外。`} file="sheath-fft" />}{r.sheath_fft && <section className="chart-card"><h3>スペクトルの主なピーク</h3><table><thead><tr><th>電極</th><th>周波数 [MHz]</th><th>振幅 [mm]</th><th>f / f₀</th></tr></thead><tbody>{(["left", "right"] as const).flatMap(side => peaks(r.sheath_fft!.freq_hz, r.sheath_fft![side === "left" ? "amp_left" : "amp_right"]).map((v, i) => <tr key={`${side}-${i}`}><td>{side === "left" ? "左" : "右"}</td><td>{numberText(v.f / 1e6)}</td><td>{numberText(v.a * 1e3)}</td><td>{numberText(r.sheath_fft!.f0_hz ? v.f / r.sheath_fft!.f0_hz : null)}</td></tr>))}</tbody></table></section>}{!r.sheath_ts && !r.sheath_fft && <Empty text="シース振動データがありません。平均区間を十分に取り、シースを形成する条件で実行してください。" />}</div>}
    {tab === "history" && <div className="chart-grid">
      <Chart title="マクロ粒子数の履歴" x={r.history.step ?? []} series={[{ label: "電子", values: r.history.n_e ?? [], color: 1 }, { label: "イオン", values: r.history.n_i ?? [], color: 0 }]} xLabel="ステップ" yLabel="粒子数" theme={theme} file="macro-history" />
      <Chart title="電子・イオンの総重み" x={r.history.step ?? []} series={[{ label: "電子", values: r.history.w_e ?? [], color: 1 }, { label: "イオン", values: r.history.w_i ?? [], color: 0 }]} xLabel="ステップ" yLabel="m⁻²" theme={theme} file="weight-history" />
      <Chart title="衝突・電離・二次電子放出" x={r.history.step ?? []} series={[{ label: "電子衝突", values: r.history.coll_e ?? [], color: 1 }, { label: "電離", values: r.history.ion_events ?? [], color: 4 }, { label: "SEE", values: r.history.see_events ?? [], color: 2 }]} xLabel="ステップ" theme={theme} file="collision-history" />
      {r.convergence && <><Chart title="収束判定 / 変化 D" x={r.convergence.period} series={Object.entries(r.convergence.d).map(([key, values], i) => ({ label: key, values, color: i % 6 })).concat([{ label: "閾値", values: r.convergence.period.map(() => r.convergence!.tol), color: 3 }])} xLabel="判定周期" yLabel="相対変化" theme={theme} log={true} file="convergence-change" note={`${r.convergence.converged ? "収束" : "未収束"}${r.convergence.converged_step !== null ? ` / ステップ ${r.convergence.converged_step}` : ""} / ${statusText[r.convergence.status.at(-1) ?? ""] ?? "判定中"}`} /><Chart title="収束判定 / 残りの変化 R" x={r.convergence.period} series={Object.entries(r.convergence.r).map(([key, values], i) => ({ label: key, values, color: i % 6 })).concat([{ label: "閾値", values: r.convergence.period.map(() => r.convergence!.tol), color: 3 }])} xLabel="判定周期" yLabel="相対変化" theme={theme} log={true} file="convergence-remaining" />{r.convergence.res && <Chart title="収束判定 / 遅い変化の分解能" x={r.convergence.period} series={Object.entries(r.convergence.res).map(([key, values], i) => ({ label: key, values, color: i % 6 }))} xLabel="判定周期" yLabel="相対変化" theme={theme} log={true} file="convergence-resolution" />}</>}
      {r.circuit?.electrodes.map((e, i) => <Chart key={e.label} title={`自己バイアス / ${e.label === "left" ? "左" : "右"}電極`} x={e.t.map(v => v * 1e6)} series={[{ label: "V_dc", values: e.v_dc, color: i }, { label: "|V₁|", values: e.v1, color: 2 }]} xLabel="t [µs]" yLabel="V [V]" theme={theme} file={`self-bias-${e.label}`} note={`面積あたりの容量 ${numberText(e.capacitance)} ${r.circuit!.units.capacitance}`} />)}
      {r.circuit?.electrodes.map((e, i) => <Chart key={`current-${e.label}`} title={`電極の伝導電流 / ${e.label === "left" ? "左" : "右"}`} x={e.t.map(v => v * 1e6)} series={[{ label: "I_dc", values: e.i_dc, color: i }]} xLabel="t [µs]" yLabel={r.circuit!.units.current} theme={theme} file={`electrode-current-${e.label}`} />)}
      {r.fn && <section className="chart-card"><h3>FN 電界放出</h3><div className="metrics">{(["left", "right"] as const).map(side => r.fn![side] && <Metric key={side} label={`${side === "left" ? "左" : "右"}の平均電流密度`} value={`${numberText(r.fn![side]!.j_avg)} A/m²`} />)}</div></section>}
      {r.walls && <section className="chart-card"><h3>壁への吸収 (累積実粒子重み)</h3><table><thead><tr><th>電極</th><th>電子 [m⁻²]</th><th>イオン [m⁻²]</th></tr></thead><tbody>{(["left", "right"] as const).map(side => <tr key={side}><th>{side === "left" ? "左" : "右"}</th><td>{numberText(r.walls![side].electron)}</td><td>{numberText(r.walls![side].ion)}</td></tr>)}</tbody></table></section>}
      <section className="chart-card"><h3>計算時間の内訳</h3><table><tbody>{Object.entries(r.timing ?? {}).map(([key, v]) => <tr key={key}><th>{key}</th><td>{numberText(v)} s</td></tr>)}</tbody></table></section>
    </div>}
  </>;
}
export function Toggle({ label, value, set }: { label: string; value: boolean; set: (v: boolean) => void }) { return <label className="toggle"><input type="checkbox" checked={value} onChange={e => set(e.target.checked)} />{label}</label>; }
export function QuantityExplorer({ items, theme, live = false }: { items: PlotQuantity[]; theme: string; live?: boolean }) {
  const [search, setSearch] = useState(""), [category, setCategory] = useState("all"), [availableOnly, setAvailableOnly] = useState(false);
  const [selected, setSelected] = useState(""), [pinned, setPinned] = useState<string[]>([]);
  const [phase, setPhase] = useState(0), [log, setLog] = useState(false), [playing, setPlaying] = useState(false);
  const categories = [...new Set(items.map(item => item.category))];
  const filtered = filterQuantities(items, search, category, availableOnly);
  const active = filtered.find(item => item.id === selected) ?? filtered.find(item => !item.unavailable) ?? filtered[0];
  const plot = active?.plot(phase), phaseCount = plot?.phases ?? 0;
  const others = pinned.filter(id => id !== active?.id).map(id => items.find(item => item.id === id)).filter((item): item is PlotQuantity => Boolean(item));
  useEffect(() => { setPhase(0); setPlaying(false); setLog(false); }, [active?.id]);
  useEffect(() => { if (!playing || phaseCount < 2) return; const timer = setInterval(() => setPhase(previous => (previous + 1) % phaseCount), 120); return () => clearInterval(timer); }, [playing, phaseCount]);
  const chart = (quantity: PlotQuantity, main: boolean) => {
    const data = main ? plot! : quantity.plot();
    return <div className="quantity-chart" key={quantity.id}>{quantity.unavailable ? <section className="chart-card quantity-unavailable"><h3>{quantity.label} [{quantity.unit}]</h3><p className="warning">{quantity.unavailable}</p><p className="hint">{quantity.note}</p></section> : <Chart title={quantity.label} x={data.x} series={data.series} xLabel={data.xLabel} yLabel={`[${quantity.unit}]`} theme={theme} log={main && log} height={main ? 310 : 235} note={[quantity.note, data.note].filter(Boolean).join(" ")} file={`quantity-${quantity.id.replaceAll(".", "-")}`} tools={main ? <><Toggle label="対数" value={log} set={setLog} /><button type="button" className="tiny" onClick={() => setPinned(previous => previous.includes(quantity.id) ? previous.filter(id => id !== quantity.id) : [...previous.slice(-2), quantity.id])}>{pinned.includes(quantity.id) ? "固定解除" : "表示を固定"}</button></> : <button type="button" className="tiny" aria-label={`${quantity.label}の固定を解除`} onClick={() => setPinned(previous => previous.filter(id => id !== quantity.id))}>固定解除</button>} />}{main && log && <p className="hint quantity-log-note">対数軸では 0 以下の値を表示しません。符号を持つ電場・電流・速度は通常軸で確認できます。</p>}</div>;
  };
  return <section className="quantity-explorer" aria-label={live ? "ライブ物理量一覧" : "結果の物理量一覧"}>
    <div className="quantity-intro"><div><h3>物理量を選んでプロット</h3><p className="hint">場・粒子・履歴・分布・回路・衝突過程・物理条件を一覧で確認できます。表示の固定で最大 4 量を同時に表示します。</p></div><span className="quantity-count">取得済み {items.filter(item => !item.unavailable).length} / {items.length} 量</span></div>
    <div className="quantity-filters"><label className="quantity-search"><span>量を検索</span><input type="search" value={search} placeholder="電場、温度、電流、energy …" onChange={event => setSearch(event.target.value)} /></label><label className="quantity-category"><span>種類</span><select value={category} onChange={event => setCategory(event.target.value)}><option value="all">すべての種類</option>{categories.map(name => <option value={name} key={name}>{name}</option>)}</select></label><Toggle label="取得済みのみ" value={availableOnly} set={setAvailableOnly} /></div>
    <div className="quantity-workspace"><div className="quantity-list" role="listbox" aria-label="表示する物理量">{filtered.length ? filtered.map(item => <button type="button" role="option" aria-selected={item.id === active?.id} key={item.id} onClick={() => setSelected(item.id)}><span className="quantity-item-label">{item.label}<small>{item.category}</small></span><span className="quantity-item-unit">{item.unit}{item.unavailable && <small>未取得</small>}</span></button>) : <p className="hint quantity-no-match">条件に合う量がありません。</p>}</div><div className="quantity-display">{active ? <>{phaseCount > 0 && <div className="playback quantity-playback"><button type="button" onClick={() => setPlaying(previous => !previous)}>{playing ? "一時停止" : "再生"}</button><input aria-label="物理量一覧の RF 位相" type="range" min={0} max={phaseCount - 1} value={Math.min(phase, phaseCount - 1)} onChange={event => setPhase(Number(event.target.value))} /><span>{numberText(360 * phase / phaseCount, 1)}°</span></div>}{chart(active, true)}{others.map(item => chart(item, false))}</> : <div className="empty-state compact"><p>検索条件を変更してください。</p></div>}</div></div>
  </section>;
}
function Empty({ text }: { text: string }) { return <div className="empty-state compact"><p>{text}</p></div>; }
function peaks(freq: number[], amp: number[]) { return freq.slice(1).map((f, i) => ({ f, a: amp[i + 1] ?? 0, i: i + 1 })).filter(v => v.a > 0 && v.a >= (amp[v.i - 1] ?? 0) && v.a >= (amp[v.i + 1] ?? 0)).sort((a, b) => b.a - a.a).slice(0, 5); }
