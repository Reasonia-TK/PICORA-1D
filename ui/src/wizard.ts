import { defaultSettings, validateSettings, type Settings } from "./model";

export type EditingMode = "direct" | "wizard";
export type SettingsSection = "grid" | "electrodes" | "mcc" | "time" | "diagnostics";
export const wizardSteps = [
  { id: "grid", title: "格子・初期状態", description: "電極間の距離、空間格子、初期粒子数と温度を設定します。" },
  { id: "electrodes", title: "電極・外部回路", description: "左右の電極電圧と電子放出を設定します。外部回路を使う場合は、回路図を配線して検証してください。" },
  { id: "mcc", title: "背景ガス・衝突", description: "MCC の使用を選び、背景ガスと LXCat の衝突断面積を設定します。" },
  { id: "time", title: "計算時間・CPU", description: "時間刻み、計算ステップ数、平均区間、収束判定と CPU 並列計算を設定します。" },
  { id: "diagnostics", title: "診断・分布", description: "EEDF の集計領域と壁 IEDF を設定します。高度な設定は JSON から編集できます。" },
  { id: "review", title: "確認・実行", description: "設定を確認して実行します。修正する場合は「戻る」または前の手順を選んでください。" },
] as const;
export function readEditingMode(): EditingMode {
  try { return localStorage.getItem("picora1d.editingMode") === "wizard" ? "wizard" : "direct"; } catch { return "direct"; }
}
const stepKeys: Record<SettingsSection, (keyof Settings)[]> = {
  grid: ["gap_m", "n_cells", "init_density_m3", "n_macro", "init_te_ev", "init_ti_ev", "ion_mass_amu", "seed"],
  electrodes: ["left", "right", "external_circuit"],
  mcc: ["mcc"],
  time: ["dt", "n_steps", "frame_every", "avg_steps", "phase_bins", "see_energy_ev", "convergence", "parallel", "cpu_threads"],
  diagnostics: ["wall_iedf_bins", "eedf_regions"],
};
export function validateWizardStep(settings: Settings, step: number): string[] {
  const id = wizardSteps[step]?.id;
  if (!id || id === "review") return validateSettings(settings);
  // 他の手順で修正する項目が、現在の手順を妨げないよう既存の検証を使う。
  const candidate = defaultSettings(); candidate.eedf_regions = [];
  Object.assign(candidate, Object.fromEntries(stepKeys[id].map(key => [key, settings[key]])));
  if (id === "diagnostics") candidate.gap_m = settings.gap_m;
  return validateSettings(candidate);
}
