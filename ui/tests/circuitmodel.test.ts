import { describe, expect, it } from "vitest";
import {
  circuitDraftError, coaxTemPreview, connectCircuit, createCircuitComponent, defaultExternalCircuit, defaultSourceWaveform,
  duplicateCircuitComponent, endpointKey, normalizeCircuitDocument, normalizeExternalCircuit, parseCircuitNumber,
  removeCircuitComponent, resolveCircuitNodes, validateExternalCircuit, type CircuitDocument, type CircuitEndpoint, type CircuitKind,
} from "../src/circuitmodel";

const endpoint = (id: string, port: string): CircuitEndpoint => ({ component_id: id, port });
function component(document: CircuitDocument, kind: Exclude<CircuitKind, "PIC">) {
  const c = createCircuitComponent(document, kind);
  return { document: { ...document, components: [...document.components, c] }, component: c };
}
function groundedSourceCircuit() {
  const s = defaultExternalCircuit(); s.enabled = true;
  let doc = s.document;
  const v = component(doc, "V"); doc = v.document;
  const g = component(doc, "GND"); doc = g.document;
  const wires = [[endpoint("pic", "left"), endpoint(v.component.id, "p")], [endpoint("pic", "right"), endpoint(g.component.id, "g")], [endpoint(v.component.id, "n"), endpoint(g.component.id, "g")]];
  for (const [a, b] of wires) doc = connectCircuit(doc, a, b);
  return { ...s, document: doc };
}

describe("外部回路グラフの編集", () => {
  it("初期状態は PIC のみで外部連成 OFF、回路を自動選択しない", () => {
    const s = defaultExternalCircuit(); expect(s.enabled).toBe(false); expect(s.area_m2).toBe(1); expect(s.document.components.map(c => c.kind)).toEqual(["PIC"]); expect(s.document.wires).toEqual([]);
    expect(validateExternalCircuit(s)).toEqual([]); expect(normalizeExternalCircuit(s)).toEqual(s);
  });
  it("接続先と重複配線を検査し、グラフの原本を変更しない", () => {
    const d = defaultExternalCircuit().document, g = component(d, "GND");
    const next = connectCircuit(g.document, endpoint("pic", "right"), endpoint(g.component.id, "g"));
    expect(d.wires).toHaveLength(0); expect(next.wires).toHaveLength(1);
    expect(() => connectCircuit(next, endpoint(g.component.id, "g"), endpoint("pic", "right"))).toThrow("接続済み");
    expect(() => connectCircuit(next, endpoint("pic", "left"), endpoint("pic", "left"))).toThrow("同じ端子");
    expect(() => connectCircuit(next, endpoint("pic", "left"), endpoint("missing", "g"))).toThrow("ありません");
  });
  it("C / L の初期状態は未指定を保持し、明示 0 と区別する", () => {
    const d = defaultExternalCircuit().document, c = createCircuitComponent(d, "C"), l = createCircuitComponent(d, "L");
    expect(c.parameters.initial_voltage_v).toBeNull(); expect(l.parameters.initial_current_a).toBeNull();
    c.parameters.initial_voltage_v = 0;
    expect(normalizeCircuitDocument({ ...d, components: [...d.components, c, l] }).components[1].parameters.initial_voltage_v).toBe(0);
    expect(circuitDraftError({ key: "initial_voltage_v", label: "初期電圧", optional: true }, "")).toBeNull();
  });
  it("コピーは値を独立させ、配線を複製せず、PIC を削除しない", () => {
    const a = component(defaultExternalCircuit().document, "D"), b = duplicateCircuitComponent(a.document, a.component.id);
    expect(b.document.components).toHaveLength(3); expect(b.component?.id).not.toBe(a.component.id); expect(b.document.wires).toHaveLength(0);
    (b.component!.parameters.model_parameters as Record<string, unknown>).IS = 1e-9;
    expect((a.component.parameters.model_parameters as Record<string, unknown>).IS).toBe(1e-14);
    expect(removeCircuitComponent(a.document, "pic")).toBe(a.document);
    expect(duplicateCircuitComponent(a.document, "pic").component).toBeNull();
  });
  it("素子削除では接続配線とノード名も除去する", () => {
    const s = groundedSourceCircuit(), voltage = s.document.components.find(c => c.kind === "V")!;
    s.document.node_labels = [{ component_id: voltage.id, port: "p", name: "Driven" }];
    const d = removeCircuitComponent(s.document, voltage.id);
    expect(d.components.some(c => c.id === voltage.id)).toBe(false); expect(d.wires).toHaveLength(1); expect(d.node_labels).toEqual([]);
  });
  it("全 GND と同軸の両シールドを同電位として扱う", () => {
    let doc = defaultExternalCircuit().document;
    const a = component(doc, "GND"); doc = a.document;
    const b = component(doc, "GND"); doc = b.document;
    const cx = component(doc, "COAX"); doc = cx.document;
    doc = connectCircuit(doc, endpoint(cx.component.id, "n1"), endpoint(a.component.id, "g"));
    const nodes = resolveCircuitNodes(doc);
    expect(nodes.get(endpointKey(endpoint(a.component.id, "g")))).toBe("GND"); expect(nodes.get(endpointKey(endpoint(b.component.id, "g")))).toBe("GND");
    expect(nodes.get(endpointKey(endpoint(cx.component.id, "n2")))).toBe("GND");
    expect(nodes.get("pic:left")).not.toBe(nodes.get("pic:right"));
  });
});

describe("回路保存と実行前チェック", () => {
  it("未配線の作成途中の回路は構造を保ったまま保存・読み込みできる", () => {
    const s = defaultExternalCircuit(); s.enabled = true;
    expect(normalizeExternalCircuit(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(validateExternalCircuit(s).join("\n")).toContain("左電極");
    expect(validateExternalCircuit(s).join("\n")).toContain("接地");
  });
  it("存在しない端子、重複 ID、壊れたパラメータを読み込み前に拒否する", () => {
    const s = groundedSourceCircuit(), doc = structuredClone(s.document);
    doc.wires[0].target.port = "bad"; expect(() => normalizeCircuitDocument(doc)).toThrow("接続先");
    const duplicate = structuredClone(s.document); duplicate.components[1].id = "pic"; expect(() => normalizeCircuitDocument(duplicate)).toThrow("ID");
    const nan = structuredClone(s.document); nan.components[1].parameters.dc_v = NaN; expect(() => normalizeCircuitDocument(nan)).toThrow("パラメータ");
    const badName = structuredClone(s.document); badName.node_labels = [{ component_id: "pic", port: "left", name: "1_invalid" }]; expect(() => normalizeCircuitDocument(badName)).toThrow("ノード名");
  });
  it("電源と接地が両電極に接続された回路を認め、短絡を拒否する", () => {
    const s = groundedSourceCircuit(); expect(validateExternalCircuit(s)).toEqual([]);
    s.document = connectCircuit(s.document, endpoint("pic", "left"), endpoint("pic", "right")); expect(validateExternalCircuit(s).join("\n")).toContain("短絡");
  });
  it("接地から切り離された閉じた回路も拒否する", () => {
    const s = groundedSourceCircuit();
    const a = component(s.document, "R"), b = component(a.document, "R");
    let doc = connectCircuit(b.document, endpoint(a.component.id, "p"), endpoint(b.component.id, "p"));
    doc = connectCircuit(doc, endpoint(a.component.id, "n"), endpoint(b.component.id, "n"));
    expect(validateExternalCircuit({ ...s, document: doc }).join("\n")).toContain("切り離された");
  });
  it("ダイオードの M ≥ 1 を認め、FC・同軸寸法・反復数の制約を検査する", () => {
    const s = groundedSourceCircuit(), d = component(s.document, "D"); s.document = d.document;
    d.component.parameters.model_parameters = { IS: 1e-14, N: 1, M: 2, FC: 0.5 };
    let errors = validateExternalCircuit(s).join("\n"); expect(errors).not.toContain("接合傾斜");
    (d.component.parameters.model_parameters as Record<string, number>).FC = 1; errors = validateExternalCircuit(s).join("\n"); expect(errors).toContain("順方向係数");
    const cx = component(s.document, "COAX"); cx.component.parameters.inner_diameter_m = 0.1;
    expect(validateExternalCircuit({ ...s, document: cx.document, max_iterations: 2 }).join("\n")).toContain("シールド内径");
    expect(validateExternalCircuit({ ...s, max_iterations: 500 }).join("\n")).toContain("200");
  });
  it("PWL の不正時刻とパルス周期に入り切らない立上り・幅・立下りを拒否する", () => {
    const s = groundedSourceCircuit(), v = s.document.components.find(c => c.kind === "V")!;
    v.parameters.waveform = { kind: "pwl", points: [[0, 0], [0, 10]] }; expect(validateExternalCircuit(s).join("\n")).toContain("PWL");
    v.parameters.waveform = { ...defaultSourceWaveform("pulse"), period_s: 1e-9 }; expect(validateExternalCircuit(s).join("\n")).toContain("パルス");
  });
});

describe("科学表記と同軸の物理量", () => {
  it("指数を入力途中のまま 1 などに誤変換しない", () => {
    expect(parseCircuitNumber("1e-9")).toBe(1e-9); expect(parseCircuitNumber("-.5E+2")).toBe(-50);
    for (const v of ["", "-", "1e", "1e-", "NaN", "Infinity", "1e999"]) expect(parseCircuitNumber(v)).toBeUndefined();
    expect(parseCircuitNumber("", true)).toBeNull(); expect(circuitDraftError({ key: "BV", label: "BV", optional: true }, "1e-")).not.toBeNull();
    expect(circuitDraftError({ key: "BV", label: "BV", optional: true }, "")).toBeNull();
  });
  it("TEM で Z0² = L′ / C′ と τ = ℓ√(L′C′) を満たす", () => {
    const values = coaxTemPreview({ length_m: 2 }); expect(values).not.toBeNull();
    expect(values!.impedance_ohm ** 2).toBeCloseTo(values!.inductance_h_m / values!.capacitance_f_m, 9);
    expect(values!.delay_s).toBeCloseTo(2 * Math.sqrt(values!.inductance_h_m * values!.capacitance_f_m), 15);
    expect(values!.impedance_ohm).toBeGreaterThan(45); expect(values!.impedance_ohm).toBeLessThan(55);
    expect(coaxTemPreview({ inner_diameter_m: 0.01, shield_inner_diameter_m: 0.001 })).toBeNull();
  });
});
