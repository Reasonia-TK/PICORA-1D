import { describe, expect, it, vi } from "vitest";
import { installCircuitRotationShortcut } from "../src/circuitshortcuts";

function keydown(properties: Partial<KeyboardEvent> = {}) {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key: "r", code: "KeyR", ctrlKey: true, metaKey: false, altKey: false,
    shiftKey: false, repeat: false, isComposing: false, ...properties,
  });
}

describe("回路回転ショートカット", () => {
  it("Ctrl+Rの再読み込みをキャンセルして一度だけ回転する", () => {
    const target = new EventTarget(), rotate = vi.fn();
    installCircuitRotationShortcut(target, rotate);
    const event = keydown();
    expect(target.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(rotate).toHaveBeenCalledOnce();
  });
  it("大文字と物理キーの指定でも回転する", () => {
    const target = new EventTarget(), rotate = vi.fn();
    installCircuitRotationShortcut(target, rotate);
    target.dispatchEvent(keydown({ key: "R" }));
    target.dispatchEvent(keydown({ key: "別の配列の文字" }));
    expect(rotate).toHaveBeenCalledTimes(2);
  });
  it("通常入力やAltとの複合キーを横取りしない", () => {
    const target = new EventTarget(), rotate = vi.fn();
    installCircuitRotationShortcut(target, rotate);
    for (const properties of [{ ctrlKey: false }, { altKey: true }, { key: "z", code: "KeyZ" }]) {
      const event = keydown(properties);
      expect(target.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(rotate).not.toHaveBeenCalled();
  });
  it("ハードリロード、長押し、IME変換中は読み込みを防ぎ回転しない", () => {
    const target = new EventTarget(), rotate = vi.fn();
    installCircuitRotationShortcut(target, rotate);
    for (const properties of [{ shiftKey: true }, { repeat: true }, { isComposing: true }]) {
      expect(target.dispatchEvent(keydown(properties))).toBe(false);
    }
    expect(rotate).not.toHaveBeenCalled();
  });
  it("他のキーリスナーには再読み込みを抑止したイベントを渡す", () => {
    const target = new EventTarget(), rotate = vi.fn(), observe = vi.fn((event: Event) => expect(event.defaultPrevented).toBe(true));
    installCircuitRotationShortcut(target, rotate);
    target.addEventListener("keydown", observe);
    target.dispatchEvent(keydown());
    expect(observe).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledOnce();
  });
  it("解除後はキーを横取りせず、再登録時に重複しない", () => {
    const target = new EventTarget(), rotate = vi.fn();
    const remove = installCircuitRotationShortcut(target, rotate);
    remove();
    expect(target.dispatchEvent(keydown())).toBe(true);
    installCircuitRotationShortcut(target, rotate);
    target.dispatchEvent(keydown());
    expect(rotate).toHaveBeenCalledOnce();
  });
});
