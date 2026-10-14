import { describe, expect, it } from "vitest";
import { defaultExternalCircuit } from "../src/circuitmodel";
import { cycleFrequency, defaultSettings, externalSourceVoltage, loadProject, normalizeSettings, saveProject, validateSettings, type ExternalCircuitResult, type Result } from "../src/model";
import { resultQuantities } from "../src/plotcatalog";

describe("外部回路とPIC設定の統合", () => {
  it("編集中の未配線回路を保存して再度編集できる", () => {
    const s = defaultSettings(); s.external_circuit = { ...defaultExternalCircuit(), enabled: true };
    const loaded = loadProject(JSON.parse(saveProject(s))).settings;
    expect(loaded.external_circuit).toEqual(s.external_circuit);
    expect(validateSettings(loaded).length).toBeGreaterThan(0);
    expect(() => normalizeSettings({ ...s, external_circuit: "invalid" })).toThrow();
  });
  it("従来の電極波形を使わず回路電源と周期スイッチからRF周期を選ぶ", () => {
    const s = defaultSettings(); s.left.voltage_rf = { amplitude: 1, freq_hz: 1 };
    s.external_circuit = defaultExternalCircuit(); s.external_circuit.enabled = true;
    s.external_circuit.document.components.push({ id: "v1", kind: "V", label: "V1", ports: ["p", "n"], position: { x: 0, y: 0 }, rotation: 0, parameters: { dc_v: 0, waveform: { kind: "sin", amplitude_v: 20, frequency_hz: 1e6 } } });
    expect(cycleFrequency(s)).toBe(1e6);
    s.external_circuit.enabled = false; expect(cycleFrequency(s)).toBe(1);
  });
  it("外部回路と従来の阻止Cの併用を実行時に拒否する", () => {
    const s = defaultSettings(); s.external_circuit = { ...defaultExternalCircuit(), enabled: true };
    s.left.blocking_capacitor = { capacitance: 1e-5, initial_bias_v: 0 };
    expect(validateSettings(s).join(" ")).toContain("同時に使用できません");
  });
  it("電源の遅延・立上り・PWLを物理時刻で表示する", () => {
    expect(externalSourceVoltage({ dc_v: 3, waveform: { kind: "sin", offset_v: 2, amplitude_v: 5, frequency_hz: 1, delay_s: 1 } }, 1.25)).toBeCloseTo(7);
    const pulse = { waveform: { kind: "pulse", initial_v: 0, pulsed_v: 10, delay_s: 1, rise_s: 2, width_s: 3, fall_s: 2, period_s: 10 } };
    expect(externalSourceVoltage(pulse, 0)).toBe(0); expect(externalSourceVoltage(pulse, 2)).toBe(5); expect(externalSourceVoltage(pulse, 4)).toBe(10); expect(externalSourceVoltage(pulse, 7)).toBe(5);
    expect(externalSourceVoltage({ waveform: { kind: "pwl", points: [[0, 0], [1, 10], [3, -10]] } }, 2)).toBe(0);
  });
  it("ノード・素子・PIC端子を単位と定義付きで全件プロットし保存で保つ", () => {
    const circuit: ExternalCircuitResult = { enabled: true, history: { t: [0, 1e-9], "branch/r1/current_a": [0, 2], "node/out/voltage_v": [0, 20], "pic/left/total_current_a": [0, 2] }, catalog: [
      { key: "branch/r1/current_a", label: "R1 電流", unit: "A", note: "p→n正" }, { key: "node/out/voltage_v", label: "出力電圧", unit: "V" }, { key: "pic/left/total_current_a", label: "左PIC電流", unit: "A" }
    ], latest: {} };
    const s = defaultSettings(), result = { settings: s, external_circuit: circuit, history: {}, profiles: null, cycle: null, eedf: [], elapsed_s: 0, timing: {} } satisfies Result;
    const items = resultQuantities(result).filter(q => q.id.startsWith("external_circuit."));
    expect(items).toHaveLength(3); expect(items[0].plot().x).toEqual([0, 0.001]); expect(items[0].plot().series[0].values).toEqual([0, 2]); expect(items.every(q => !q.unavailable)).toBe(true);
    const loaded = loadProject(JSON.parse(saveProject(s, [{ id: "1", label: "連成", created: "2026-10-10", settings: s, result }])));
    expect(loaded.runs[0].result.external_circuit).toEqual(circuit);
  });
});
