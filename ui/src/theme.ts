import { useEffect, useLayoutEffect, useState } from "react";
export type ThemeMode = "system" | "light" | "dark";
export function readTheme(): ThemeMode {
  try { const v = localStorage.getItem("picora1d.theme"); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readTheme);
  const [darkSystem, setDarkSystem] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const resolved = mode === "system" ? (darkSystem ? "dark" : "light") : mode;
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setDarkSystem(m.matches);
    m.addEventListener("change", listener); return () => m.removeEventListener("change", listener);
  }, []);
  // グラフの passive effect が系列色を読む前に CSS トークンを切り替える。
  useLayoutEffect(() => { document.documentElement.dataset.theme = resolved; }, [resolved]);
  const change = (v: ThemeMode) => { setMode(v); try { localStorage.setItem("picora1d.theme", v); } catch { /* メモリ上で続ける */ } };
  return { mode, resolved, setMode: change };
}
export function palette() {
  const css = getComputedStyle(document.documentElement);
  return { text: css.getPropertyValue("--text-muted").trim(), border: css.getPropertyValue("--border").trim(), colors: Array.from({ length: 6 }, (_, i) => css.getPropertyValue(`--series-${i + 1}`).trim()) };
}
