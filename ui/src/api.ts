import type { Process, Result, RunEvent, Settings } from "./model";
export const DEFAULT_PORT = 8321;
export const isTauri = () => "__TAURI_INTERNALS__" in window;
export async function backendPort(): Promise<number> {
  if (isTauri()) { const { invoke } = await import("@tauri-apps/api/core"); return invoke<number>("backend_port"); }
  return DEFAULT_PORT;
}
export interface Health { status: string; version?: string; instance?: string; numba?: boolean; execution?: { available: boolean; backend: string; max_threads: number; auto_threads: number } }
export async function getJson<T>(port: number, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...(body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
  if (!res.ok) { const error = await res.json().catch(() => null); throw new Error(typeof error?.detail === "string" ? error.detail : JSON.stringify(error?.detail ?? `HTTP ${res.status}`)); }
  return res.json() as Promise<T>;
}
export const parseLxcat = (port: number, text: string, species: "electron" | "ion") => getJson<{ processes: Process[]; warnings: string[] }>(port, "/lxcat/parse", { text, species });
export type RunCommand = { cmd: "start"; project: { pic1d: Settings } } | { cmd: "continue"; extra_steps: number; frame_every: number; avg_steps: number | null; phase_bins: number };
export class PicClient {
  private socket: WebSocket | null = null;
  private pending: { resolve: (r: Result) => void; reject: (e: Error) => void; onEvent: (e: RunEvent) => void } | null = null;
  private opening: Promise<void> | null = null;
  constructor(readonly port: number, readonly onDisconnect?: () => void) {}
  private connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${this.port}/ws/pic1d`); this.socket = socket;
      const timer = setTimeout(() => { socket.close(); reject(new Error("計算サーバーへの接続がタイムアウトしました。")); }, 8000);
      socket.onopen = () => { clearTimeout(timer); this.opening = null; resolve(); };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data) as RunEvent;
          this.pending?.onEvent(message);
          if (message.type === "done") { this.pending?.resolve(message.result); this.pending = null; }
          if (message.type === "error") { this.pending?.reject(new Error(message.detail)); this.pending = null; }
        } catch { this.pending?.reject(new Error("サーバーの応答を読み取れませんでした。")); this.pending = null; }
      };
      socket.onerror = () => { clearTimeout(timer); this.opening = null; reject(new Error("計算サーバーに接続できません。")); };
      socket.onclose = () => { clearTimeout(timer); if (this.socket === socket) this.socket = null; this.opening = null; reject(new Error("計算サーバーとの接続が切れました。")); this.pending?.reject(new Error("接続が切れたため計算を中断しました。")); this.pending = null; this.onDisconnect?.(); };
    }); return this.opening;
  }
  async run(command: RunCommand, onEvent: (e: RunEvent) => void): Promise<Result> {
    if (this.pending) throw new Error("既に計算を実行中です。");
    await this.connect();
    return new Promise<Result>((resolve, reject) => { this.pending = { resolve, reject, onEvent }; this.socket!.send(JSON.stringify(command)); });
  }
  stop() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ cmd: "stop" })); }
  close() { this.socket?.close(); }
}
export async function saveText(name: string, text: string, extension = "json"): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog"); const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: name, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] }); if (!path) return false; await writeTextFile(path, text);
  } else {
    const url = URL.createObjectURL(new Blob([text], { type: extension === "csv" ? "text/csv;charset=utf-8" : "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}
export async function openProjectText(): Promise<{ name: string; text: string } | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog"); const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters: [{ name: "プロジェクト / 結果 JSON", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return null;
    return { name: path.split(/[\\/]/).at(-1) ?? "project.json", text: await readTextFile(path) };
  }
  return null;
}
