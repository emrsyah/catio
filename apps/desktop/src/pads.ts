// Pad switcher: the pad's name at the left of the strip opens a small menu listing every pad
// (with its open to-do count), plus "+ Pad baru". Rename and delete sit on each row on hover.
// Keyboard: ↑/↓ move, Enter opens, F2 renames, Delete removes, Esc closes.

export interface PadEntry {
  name: string;
  open: number;
}

export interface PadMenuHooks {
  list(): PadEntry[];
  current(): string;
  select(name: string): void;
  create(name: string): void;
  rename(old: string, name: string): void;
  remove(name: string): void;
  /** Menu closed: give the keyboard back to the editor. */
  closed(): void;
}

const ICON_RENAME =
  '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M8.5 3.5l2 2M3 11l.5-2.5L9.2 2.8a1 1 0 011.4 0l.6.6a1 1 0 010 1.4L5.5 10.5 3 11z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ICON_DELETE =
  '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 4h9M5.5 4V2.8h3V4M4 4l.6 7.2h4.8L10 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function setupPadMenu(hooks: PadMenuHooks) {
  const btn = document.getElementById("pad-btn") as HTMLButtonElement;
  const nameEl = document.getElementById("pad-name")!;
  const menu = document.getElementById("pad-menu")!;
  /** null, "new", or the name of the pad being renamed */
  let editing: string | null = null;

  const isOpen = () => menu.hasAttribute("data-open");

  function rows() {
    return [...menu.querySelectorAll<HTMLElement>(".pad-row:not(.is-editing)")];
  }

  function editRow(initial: string, placeholder: string, onDone: (value: string | null) => void) {
    const row = document.createElement("div");
    row.className = "pad-row is-editing";
    const input = document.createElement("input");
    input.className = "pad-input";
    input.value = initial;
    input.placeholder = placeholder;
    input.maxLength = 40;
    input.setAttribute("aria-label", placeholder);
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      onDone(commit && v ? v : null);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    // Clicking away keeps what you typed; an untouched field just cancels.
    input.addEventListener("blur", () => finish(input.value.trim() !== initial.trim()));
    row.appendChild(input);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return row;
  }

  function render() {
    const list = hooks.list();
    const current = hooks.current();
    const only = list.length <= 1;
    const wrap = document.createElement("div");
    wrap.className = "pad-list";
    for (const p of list) {
      if (editing === p.name) {
        wrap.appendChild(
          editRow(p.name, "nama pad", (v) => {
            editing = null;
            if (v && v !== p.name) hooks.rename(p.name, v);
            render();
            focusRow(v ?? p.name);
          }),
        );
        continue;
      }
      const row = document.createElement("div");
      row.className = "pad-row";
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(p.name === current));
      row.tabIndex = -1;
      row.dataset.name = p.name;
      row.title = p.name;
      const name = document.createElement("span");
      name.className = "pad-row-name";
      name.textContent = p.name;
      const count = document.createElement("span");
      count.className = "pad-row-count";
      count.textContent = p.open ? String(p.open) : "";
      if (p.open) count.setAttribute("aria-label", `${p.open} to-do belum beres`);
      const actions = document.createElement("span");
      actions.className = "pad-row-actions";
      actions.innerHTML =
        `<button type="button" data-act="rename" aria-label="Ganti nama ${escapeAttr(p.name)}" title="Ganti nama (F2)">${ICON_RENAME}</button>` +
        `<button type="button" data-act="delete" aria-label="Hapus ${escapeAttr(p.name)}" title="${only ? "Minimal harus ada satu pad" : "Hapus (Delete)"}"${only ? " disabled" : ""}>${ICON_DELETE}</button>`;
      row.append(name, count, actions);
      wrap.appendChild(row);
    }
    if (editing === "new") {
      wrap.appendChild(
        editRow("", "nama pad baru", (v) => {
          editing = null;
          if (v) {
            close();
            hooks.create(v);
          } else render();
        }),
      );
    }
    const sep = document.createElement("div");
    sep.className = "pad-sep";
    sep.setAttribute("role", "separator");
    const add = document.createElement("div");
    add.className = "pad-row pad-new";
    add.setAttribute("role", "menuitem");
    add.tabIndex = -1;
    add.dataset.act = "new";
    add.innerHTML = '<span class="pad-row-name">＋ Pad baru</span><kbd>Ctrl+N</kbd>';
    menu.replaceChildren(wrap, sep, add);
  }

  function focusRow(name?: string) {
    const all = rows();
    const target = all.find((r) => r.dataset.name === (name ?? hooks.current())) ?? all[0];
    target?.focus();
  }

  function open(opts: { newPad?: boolean } = {}) {
    editing = opts.newPad ? "new" : null;
    render();
    menu.setAttribute("data-open", "");
    btn.setAttribute("aria-expanded", "true");
    if (!opts.newPad) focusRow();
  }

  function close(returnFocus = true) {
    if (!isOpen()) return;
    editing = null;
    menu.removeAttribute("data-open");
    btn.setAttribute("aria-expanded", "false");
    if (returnFocus) hooks.closed();
  }

  btn.addEventListener("click", () => (isOpen() ? close() : open()));

  menu.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const act = target.closest<HTMLElement>("[data-act]");
    const row = target.closest<HTMLElement>(".pad-row");
    if (act?.dataset.act === "new") {
      editing = "new";
      render();
      return;
    }
    if (act?.dataset.act === "rename" && row?.dataset.name) {
      editing = row.dataset.name;
      render();
      return;
    }
    if (act?.dataset.act === "delete" && row?.dataset.name) {
      close();
      hooks.remove(row.dataset.name);
      return;
    }
    if (row?.dataset.name && !row.classList.contains("is-editing")) {
      close();
      hooks.select(row.dataset.name);
    }
  });

  menu.addEventListener("keydown", (e) => {
    const all = [...rows(), ...menu.querySelectorAll<HTMLElement>(".pad-new")].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    const i = all.indexOf(document.activeElement as HTMLElement);
    const row = document.activeElement as HTMLElement | null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length];
      next?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row?.click();
    } else if (e.key === "F2" && row?.dataset.name) {
      e.preventDefault();
      editing = row.dataset.name;
      render();
    } else if (e.key === "Delete" && row?.dataset.name && hooks.list().length > 1) {
      e.preventDefault();
      close();
      hooks.remove(row.dataset.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault(); // stay inside the menu
    }
  });

  // Click anywhere else closes it.
  document.addEventListener("mousedown", (e) => {
    if (!isOpen()) return;
    const t = e.target as Node;
    if (!menu.contains(t) && !btn.contains(t)) close(false);
  });
  window.addEventListener("blur", () => close(false));

  return {
    open,
    close,
    isOpen,
    /** Re-render after pads or counts change (keeps an open rename field untouched). */
    refresh() {
      nameEl.textContent = hooks.current();
      btn.title = `Pad: ${hooks.current()} (klik buat ganti)`;
      if (isOpen() && editing === null) {
        const focused = (document.activeElement as HTMLElement | null)?.dataset.name;
        render();
        if (focused) focusRow(focused);
      }
    },
  };
}

function escapeAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
