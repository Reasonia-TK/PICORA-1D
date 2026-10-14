import { describe, expect, it } from "vitest";
import { defaultMcc, defaultSettings } from "../src/model";
import { defaultExternalCircuit } from "../src/circuitmodel";
import { validateWizardStep, wizardSteps } from "../src/wizard";

describe("設定ウィザードの段階別検証", () => {
  it("初期設定は全手順を通過する", () => {
    for (let step = 0; step < wizardSteps.length; step++) expect(validateWizardStep(defaultSettings(), step)).toEqual([]);
  });
  it("後で設定する項目のエラーはその手順と最終確認で検出する", () => {
    const s = defaultSettings(); s.n_steps = 0; s.mcc = defaultMcc(); s.mcc.gas.pressure_pa = -1;
    expect(validateWizardStep(s, 0)).toEqual([]);
    expect(validateWizardStep(s, 1)).toEqual([]);
    expect(validateWizardStep(s, 2).join(" ")).toContain("MCC");
    expect(validateWizardStep(s, 3).join(" ")).toContain("ステップ数");
    expect(validateWizardStep(s, 5)).toHaveLength(2);
  });
  it("ギャップを短くしても格子設定は通過し、領域範囲は診断の手順で確認する", () => {
    const s = defaultSettings(); s.gap_m = 0.001;
    s.eedf_regions = [{ label: "中央", x1: 0.002, x2: 0.003, bins: 100, e_max_ev: null }];
    expect(validateWizardStep(s, 0)).toEqual([]);
    expect(validateWizardStep(s, 4).join(" ")).toContain("EEDF 集計区間");
    expect(validateWizardStep(s, 5).join(" ")).toContain("EEDF 集計区間");
  });
  it("外部回路の配線エラーを電極の手順で検出する", () => {
    const s = defaultSettings(); s.external_circuit = { ...defaultExternalCircuit(), enabled: true };
    expect(validateWizardStep(s, 0)).toEqual([]);
    expect(validateWizardStep(s, 1).length).toBeGreaterThan(0);
  });
  it("段階別の検証は元の設定を変更しない", () => {
    const s = defaultSettings(), before = structuredClone(s);
    for (let step = 0; step < wizardSteps.length; step++) validateWizardStep(s, step);
    expect(s).toEqual(before);
  });
});
