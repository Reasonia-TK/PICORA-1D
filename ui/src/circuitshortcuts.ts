/** Reserve Ctrl+R for circuit rotation, including when an input has focus. */
export function installCircuitRotationShortcut(target: EventTarget, rotate: () => void): () => void {
  const onKeyDown = (event: Event) => {
    const key = event as KeyboardEvent;
    if (!(key.ctrlKey || key.metaKey) || key.altKey || !(key.key?.toLowerCase() === "r" || key.code === "KeyR")) return;
    // Also suppress the hard-reload variant and repeated keydown events.
    key.preventDefault();
    if (!key.shiftKey && !key.repeat && !key.isComposing) rotate();
  };
  const options = { capture: true };
  target.addEventListener("keydown", onKeyDown, options);
  return () => target.removeEventListener("keydown", onKeyDown, options);
}
