import { numberText, rfComponents, type Settings } from "./model";
import { wizardSteps } from "./wizard";

export function WizardNavigation({ step, select }: { step: number; select: (step: number) => void }) {
  return <nav className="wizard-navigation" aria-label="設定の手順"><ol>{wizardSteps.map((item, i) => <li key={item.id}><button type="button" aria-current={step === i ? "step" : undefined} disabled={i > step} onClick={() => select(i)}><span className="wizard-number">{i + 1}</span>{item.title}</button></li>)}</ol></nav>;
}

export function WizardSummary({ settings: s }: { settings: Settings }) {
  const electrode = (side: "left" | "right") => s.external_circuit?.enabled ? "外部回路で駆動" : `DC ${numberText(s[side].v_dc)} V / RF ${rfComponents(s[side].voltage_rf).length} 成分 / CSV ${s[side].waveforms.length} 波形`;
  const rows = [
    ["格子", `${numberText(s.gap_m * 1e3)} mm / ${s.n_cells} セル`],
    ["初期プラズマ", `${numberText(s.init_density_m3)} m⁻³ / ${s.n_macro.toLocaleString()} 粒子・種`],
    ["初期温度", `電子 ${numberText(s.init_te_ev)} eV / イオン ${numberText(s.init_ti_ev)} eV`],
    ["イオン質量 / シード", `${numberText(s.ion_mass_amu)} amu / ${s.seed}`],
    ["左電極", electrode("left")], ["右電極", electrode("right")],
    ["電子放出", `SEE 左 ${numberText(s.left.see_gamma)} / 右 ${numberText(s.right.see_gamma)}、FN 左 ${s.left.fn ? "有効" : "無効"} / 右 ${s.right.fn ? "有効" : "無効"}`],
    ["外部回路", s.external_circuit?.enabled ? `有効 / 面積 ${numberText(s.external_circuit.area_m2)} m²` : "無効"],
    ["背景ガス / MCC", s.mcc ? `${s.mcc.gas.name} / ${numberText(s.mcc.gas.pressure_pa)} Pa / ${numberText(s.mcc.gas.temperature_k)} K` : "衝突なし"],
    ["衝突過程", s.mcc ? `電子 ${s.mcc.electron_processes.length} / イオン ${s.mcc.ion_processes.length}` : "—"],
    ["時間積分", `${s.n_steps.toLocaleString()} ステップ / dt ${s.dt === null ? "自動" : `${numberText(s.dt * 1e9)} ns`}`],
    ["平均 / 位相分解", `${s.avg_steps === null ? "最後の 25%" : `${s.avg_steps} ステップ`} / ${s.phase_bins} ビン`],
    ["CPU", s.parallel ? `並列 / ${s.cpu_threads ?? "自動"} スレッド` : "逐次"],
    ["収束判定", s.convergence.enabled ? `有効${s.convergence.stop ? " / 自動停止" : ""}` : "無効"],
    ["エネルギー分布", `EEDF ${s.eedf_regions.length} 領域 / 壁 IEDF ${s.wall_iedf_bins} ビン`],
  ];
  return <section className="wizard-summary"><h2>現在の設定</h2><p className="hint">直接編集とウィザードで同じ設定を使います。変更は自動で保持されます。</p><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{s.mcc && (!s.mcc.electron_processes.length || !s.mcc.ion_processes.length) && <p className="warning">MCC の衝突断面積が未設定の種があります。意図した衝突モデルになっているか確認してください。</p>}</section>;
}
