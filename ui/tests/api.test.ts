import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PicClient, saveText } from "../src/api";
import { defaultSettings, type Result } from "../src/model";
const native = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: native.write }));

class MockSocket {
  static OPEN = 1; static last: MockSocket;
  readyState = 0; url: string; sent: unknown[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(url: string) { this.url = url; MockSocket.last = this; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const result: Result = { settings: defaultSettings(), history: {}, profiles: null, cycle: null, elapsed_s: 0.01, timing: {}, eedf: [] };
describe("旧 1D PIC WebSocket 契約", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", MockSocket)); afterEach(() => vi.unstubAllGlobals());
  it("start / frame / done を処理し、同じ接続で続き・停止を送る", async () => {
    const api = new PicClient(8321), events: unknown[] = [];
    const run = api.run({ cmd: "start", project: { pic1d: defaultSettings() } }, e => events.push(e)); await Promise.resolve(); await Promise.resolve();
    const socket = MockSocket.last; expect(socket.url).toBe("ws://127.0.0.1:8321/ws/pic1d"); expect(socket.sent[0]).toMatchObject({ cmd: "start", project: { pic1d: { gap_m: 0.02 } } });
    socket.receive({ type: "started", dt: 1e-10, x: [0, 0.02], n_steps: 1000, step_offset: 0, warnings: ["warning"] }); socket.receive({ type: "frame", step: 1000 }); socket.receive({ type: "done", result }); expect(await run).toEqual(result); expect(events).toHaveLength(3);
    const next = api.run({ cmd: "continue", extra_steps: 500, frame_every: 20, avg_steps: null, phase_bins: 40 }, () => {}); await Promise.resolve(); api.stop();
    expect(MockSocket.last).toBe(socket); expect(socket.sent.slice(1)).toEqual([{ cmd: "continue", extra_steps: 500, frame_every: 20, avg_steps: null, phase_bins: 40 }, { cmd: "stop" }]); socket.receive({ type: "done", result }); await next; api.close();
  });
  it("サーバーの所有者エラーを呼び出し元へ返す", async () => {
    const api = new PicClient(8321); const run = api.run({ cmd: "start", project: { pic1d: defaultSettings() } }, () => {}); const rejection = expect(run).rejects.toThrow("別の接続"); await Promise.resolve(); await Promise.resolve(); MockSocket.last.receive({ type: "error", detail: "別の接続で開始された実行状態は継続できません" }); await rejection; api.close();
  });
  it("接続切断時に実行を拒否し、続き状態の解除を通知する", async () => {
    const disconnect = vi.fn(), api = new PicClient(8321, disconnect); const run = api.run({ cmd: "start", project: { pic1d: defaultSettings() } }, () => {}); const rejection = expect(run).rejects.toThrow("接続が切れた"); await Promise.resolve(); await Promise.resolve(); MockSocket.last.close(); await rejection; expect(disconnect).toHaveBeenCalledOnce();
  });
});
describe("ネイティブ保存", () => {
  beforeEach(() => { vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); native.save.mockReset(); native.write.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());
  it("キャンセルを false として返し、ファイルを書かない", async () => { native.save.mockResolvedValue(null); expect(await saveText("project.json", "{}" )).toBe(false); expect(native.write).not.toHaveBeenCalled(); });
  it("選択した場所へ書き、true を返す", async () => { native.save.mockResolvedValue("C:/project.json"); native.write.mockResolvedValue(undefined); expect(await saveText("project.json", "{\n}" )).toBe(true); expect(native.write).toHaveBeenCalledWith("C:/project.json", "{\n}"); });
});
