// One overlay for Ctrl+K search and the weekly review: a dialog over the pad with a dim
// backdrop. Opens and closes instantly (keyboard actions never animate). While open, the pad
// behind it is inert, Esc or a click outside closes it, and focus goes back where it was.

export interface Overlay {
  panel: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createOverlay(label: string, className: string, onClose?: () => void): Overlay {
  const root = document.createElement("div");
  root.className = `overlay ${className}`;
  root.hidden = true;
  const backdrop = document.createElement("div");
  backdrop.className = "overlay-backdrop";
  const panel = document.createElement("div");
  panel.className = "overlay-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", label);
  root.append(backdrop, panel);
  document.body.appendChild(root);

  const shell = document.getElementById("shell")!;
  let returnTo: HTMLElement | null = null;

  const isOpen = () => !root.hidden;
  function open() {
    if (isOpen()) return;
    returnTo = document.activeElement as HTMLElement | null;
    root.hidden = false;
    shell.inert = true;
  }
  function close() {
    if (!isOpen()) return;
    root.hidden = true;
    shell.inert = false;
    onClose?.();
    returnTo?.focus();
  }

  backdrop.addEventListener("mousedown", (e) => {
    e.preventDefault();
    close();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  return { panel, open, close, isOpen };
}

/** Small DOM helper shared by the overlays: element, class, text (always textContent). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

/** "↑↓ pilih · ↵ buka": key hints in the overlay footer. */
export function hints(pairs: [string, string][]): HTMLElement {
  const foot = h("div", "overlay-hints");
  for (const [key, what] of pairs) {
    const item = h("span");
    item.append(h("kbd", "", key), ` ${what}`);
    foot.appendChild(item);
  }
  return foot;
}
