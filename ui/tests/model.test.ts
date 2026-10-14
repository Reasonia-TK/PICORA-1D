import { describe, expect, it } from "vitest";
import { csvText, cycleFrequency, defaultSettings, electrodeVoltage, interpolate, loadProject, normalizeSettings, numericPath, parseWaveformCsv, rangeValues, saveProject, setNumericPath, sweepValues, validateSettings, type Result, type SavedRun } from "../src/model";

describe("既存 ES-Sim プロジェクトと結果の移行", () => {
  it("geometry を持つ旧形式から 1D 設定だけを読み込む", () => {
    const loaded = loadProject({ geometry: { domain: { polygon: [[0, 0], [1, 0], [0, 1]] } }, pic1d: { gap_m: 0.02, init_density_m3: 1e14, left: { v_dc: -40 }, convergence: { stop: true } } });
    expect(loaded.settings.left.v_dc).toBe(-40); expect(loaded.settings.right.waveforms).toEqual([]); expect(loaded.settings.convergence.hold).toBe(3); expect(loaded.settings.convergence.stop).toBe(true); expect(loaded.runs).toEqual([]);
  });
  it("旧形式の省略された FN / MCC / EEDF の既定値を補完する", () => {
    const s = normalizeSettings({ gap_m: 0.02, init_density_m3: 1e14, left: { fn: { phi_ev: 4, beta: 10 } }, mcc: { gas: { name: "He", pressure_pa: 15 } }, eedf_regions: [{ x1: 0.005, x2: 0.015 }] });
    expect(s.left.fn?.init_energy_ev).toBe(0.1); expect(s.mcc?.gas.temperature_k).toBe(300); expect(s.mcc?.ionization_split).toBe("half"); expect(s.eedf_regions[0].bins).toBe(100);
  });
  it("結果付き保存で全結果を損失なく往復する", () => {
    const s = defaultSettings(); const result: Result = { settings: s, profiles: null, cycle: null, history: { step: [0, 100], n_e: [5000, 4500] }, elapsed_s: 1.2, timing: { push: 0.3 }, eedf: [], sheath_fft: null, wall_iedf: null };
    const run: SavedRun = { id: "old", label: "RF, case 1", created: "2026-10-09T00:00:00Z", settings: s, result };
    const loaded = loadProject(JSON.parse(saveProject(s, [run]))); expect(loaded.runs).toHaveLength(1); expect(loaded.runs[0].result).toEqual(result); expect(loaded.runs[0].id).not.toBe("old"); expect(loaded.settings).toEqual(s);
  });
  it("ES-Sim の results.pic1d 形式を読み込む", () => {
    const s = defaultSettings(); const r = { settings: s, history: { step: [20] }, profiles: null, cycle: null, eedf: [], elapsed_s: 0.1, timing: {} };
    expect(loadProject({ pic1d: s, results: { pic1d: r } }).runs[0].result).toEqual(r);
  });
  it("破損した入力を適用前に拒否する", () => {
    expect(() => loadProject({ fluid1d: {} })).toThrow("1D PIC");
    expect(() => normalizeSettings({ ...defaultSettings(), mcc: "invalid" })).toThrow("MCC");
    expect(() => normalizeSettings({ ...defaultSettings(), left: { voltage_rf: [null] } })).toThrow("RF");
    expect(() => normalizeSettings({ ...defaultSettings(), n_cells: 2 })).toThrow("セル数");
    expect(() => normalizeSettings({ ...defaultSettings(), eedf_regions: [{ x1: 0.01, x2: 0.001 }] })).toThrow("EEDF");
  });
});
describe("CSV / 複合 RF 電圧", () => {
  it("ヘッダ・BOM・異なる区切りを許容し、終端を除いて正規化する", () => {
    const w = parseWaveformCsv("\uFEFFt,V\n0,0\n1e-6\t100\n2e-6 0\n3e-6,-100\n4e-6,0\n");
    expect(w.freq_hz).toBeCloseTo(250000); expect(w.phase).toEqual([0, 0.25, 0.5, 0.75]); expect(w.v).toEqual([0, 100, 0, -100]);
  });
  it("重複時刻をまとめ、十分な異なる時刻が無いと拒否する", () => {
    expect(() => parseWaveformCsv("0,1\n0,2\n1,3")).toThrow("3 行以上");
    expect(parseWaveformCsv("0,0\n1,2\n1,4\n2,0").v).toEqual([0, 4]);
  });
  it("DC と複数 RF と CSV を足し、周期境界を補間する", () => {
    const s = defaultSettings(); s.left.v_dc = 10; s.left.voltage_rf = [{ amplitude: 100, freq_hz: 1, phase_deg: 0 }, { amplitude: 5, freq_hz: 2, phase_deg: 90 }]; s.left.waveforms = [{ freq_hz: 1, phase: [0, 0.5], v: [0, 20] }];
    expect(electrodeVoltage(s.left, 0)).toBeCloseTo(15); expect(electrodeVoltage(s.left, 0.25)).toBeCloseTo(115); expect(electrodeVoltage(s.left, 1)).toBeCloseTo(15);
  });
  it("RF 位相診断は CSV より RF 周波数を優先する", () => {
    const s = defaultSettings(); s.left.voltage_rf = { amplitude: 100, freq_hz: 13.56e6 }; s.left.waveforms = [{ freq_hz: 1e6, phase: [0, 0.5], v: [0, 1] }]; expect(cycleFrequency(s)).toBe(13.56e6); s.left.voltage_rf = null; expect(cycleFrequency(s)).toBe(1e6); s.left.waveforms = []; expect(cycleFrequency(s)).toBeNull();
  });
});
describe("1D 掃引と CSV 書出し", () => {
  it("深いパスを設定の写しだけに反映し、元は変更しない", () => {
    const s = defaultSettings(); s.left.voltage_rf = [{ amplitude: 100, freq_hz: 13.56e6 }];
    const next = setNumericPath(s, "pic1d.left.voltage_rf.0.amplitude", 250); expect(numericPath(next, "left.voltage_rf.0.amplitude")).toBe(250); expect(numericPath(s, "left.voltage_rf.0.amplitude")).toBe(100); expect(() => setNumericPath(s, "left.fn.beta", 5)).toThrow();
  });
  it("リスト / 線形 / 対数範囲を計算し、不正な範囲を拒否する", () => {
    expect(sweepValues("0, 10 20\n30")).toEqual([0, 10, 20, 30]); expect(rangeValues(0, 100, 3, false)).toEqual([0, 50, 100]); expect(rangeValues(1, 100, 3, true)[1]).toBeCloseTo(10); expect(() => rangeValues(0, 10, 3, true)).toThrow(); expect(() => sweepValues("1,invalid")).toThrow();
  });
  it("整数パラメータの掃引値を事前に検証する", () => { expect(validateSettings(setNumericPath(defaultSettings(), "n_cells", 4))).not.toEqual([]); expect(validateSettings(setNumericPath(defaultSettings(), "n_macro", 2.5))).not.toEqual([]); });
  it("異なる格子の平均場を線形補間する", () => { expect(interpolate([0, 0.5, 1], [0, 10, 20], 0.25)).toBe(5); expect(interpolate([0, 1], [null, 20], 0.5)).toBeNaN(); });
  it("カンマ / 引用符 / null / 非有限数を壊さず CSV にする", () => { expect(csvText(["x,mm", "value"], [[1, 2, 3], ['a"b', null, Infinity]])).toBe('"x,mm",value\n1,"a""b"\n2,\n3,\n'); });
});
