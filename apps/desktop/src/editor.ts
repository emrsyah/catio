// CodeMirror 6 setup. The document is plain text; everything here is view-only decoration,
// so copy/paste and the file on disk stay exactly what the user typed.

import { EditorSelection, EditorState, Extension, Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { parseLine, toggleLine } from "@catio/core";

export interface EditorHooks {
  onSave: () => void;
  onHide: () => void;
}

// ---------- focus zone: lines above the first "---" ----------

interface Zone {
  divider: number; // 1-based line number, -1 when absent
  now: number; // 1-based line number of the first open to-do in focus, -1 when none
}

function computeZone(state: EditorState): Zone {
  const doc = state.doc;
  let now = -1;
  // The focus zone is short by design, so this loop stops early on real documents.
  for (let n = 1; n <= doc.lines; n++) {
    const p = parseLine(doc.line(n).text);
    if (p.kind === "divider") return { divider: n, now };
    if (now === -1 && p.kind === "todo") now = n;
  }
  return { divider: -1, now: -1 };
}

// ---------- widgets ----------

class BoxWidget extends WidgetType {
  constructor(readonly state: "todo" | "done" | "snooze") {
    super();
  }
  eq(other: BoxWidget) {
    return other.state === this.state;
  }
  toDOM() {
    // The outer span is the full 24px slot (box + gap). The caret is measured from the
    // widget's edge, so the gap must be inside the widget, not a margin, or the caret
    // ends up glued to the box on an empty to-do.
    const el = document.createElement("span");
    el.className = `cm-box cm-box-${this.state}`;
    el.setAttribute("aria-hidden", "true");
    const box = document.createElement("span");
    box.className = "cm-check";
    if (this.state === "done") {
      box.innerHTML =
        '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M3.5 7.2l2.3 2.3 4.7-4.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    } else if (this.state === "snooze") {
      box.innerHTML =
        '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M6 4.5L8.5 7 6 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    el.appendChild(box);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class LabelWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: LabelWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-tag";
    el.textContent = this.text;
    return el;
  }
}

const boxes = {
  todo: Decoration.replace({ widget: new BoxWidget("todo") }),
  done: Decoration.replace({ widget: new BoxWidget("done") }),
  snooze: Decoration.replace({ widget: new BoxWidget("snooze") }),
};
const besok = Decoration.widget({ widget: new LabelWidget("besok"), side: 1 });
const timeMark = Decoration.mark({ class: "cm-time" });
const line = (cls: string) => Decoration.line({ class: cls });

function buildDecorations(view: EditorView): DecorationSet {
  const zone = computeZone(view.state);
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const ln = view.state.doc.lineAt(pos);
      const p = parseLine(ln.text);
      const classes: string[] = [];
      if (zone.divider !== -1 && ln.number < zone.divider) classes.push("cm-focusline");
      if (ln.number === zone.now) classes.push("cm-now");
      if (p.kind === "divider") classes.push("cm-divider");
      if (p.kind === "done") classes.push("cm-done");
      if (p.kind === "snooze") classes.push("cm-snooze");
      if (p.markerFrom >= 0) classes.push("cm-task");
      if (p.kind === "text") classes.push("cm-text");
      if (classes.length) out.push(line(classes.join(" ")).range(ln.from));

      if (p.markerFrom >= 0 && (p.kind === "todo" || p.kind === "done" || p.kind === "snooze")) {
        out.push(boxes[p.kind].range(ln.from + p.markerFrom, ln.from + p.bodyFrom));
      }
      if (p.time && p.kind !== "done") {
        out.push(timeMark.range(ln.from + p.time.from, ln.from + p.time.to));
      }
      if (p.kind === "snooze") out.push(besok.range(ln.to));
      pos = ln.to + 1;
    }
  }
  return Decoration.set(out, true);
}

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      // Arrow keys and Backspace treat "[ ] " as one unit: Backspace after the box removes the marker.
      EditorView.atomicRanges.of((view) => {
        const set = view.plugin(plugin)?.decorations ?? Decoration.none;
        return set.update({ filter: (_f, _t, d) => d.spec.widget instanceof BoxWidget });
      }),
    eventHandlers: {
      mousedown(e, view) {
        if (e.button !== 0) return false;
        const target = e.target as HTMLElement;
        const box = target.closest<HTMLElement>(".cm-box");
        const lineEl = target.closest<HTMLElement>(".cm-line");
        // The left gutter is the drag handle for every line; the box is one too.
        const inGutter = !!lineEl && e.clientX < lineEl.getBoundingClientRect().left + GUTTER - 4;
        if (!box && !inGutter) return false;
        const lineNo = view.state.doc.lineAt(view.posAtDOM(box ?? lineEl!)).number;
        const ln = view.state.doc.line(lineNo);
        if (!box && ln.text.trim() === "") return false;
        e.preventDefault();
        startLineDrag(view, lineNo, e, () => {
          if (box) toggleAt(view, [lineNo]);
          else {
            view.dispatch({ selection: { anchor: ln.from + parseLine(ln.text).bodyFrom } });
            view.focus();
          }
        });
        return true;
      },
    },
  },
);

// ---------- drag & drop lines ----------

const GUTTER = 44; // keep in sync with --gutter in styles.css
const DRAG_THRESHOLD = 4;

/** Highlights the line being dragged. A state field so re-renders keep the highlight. */
const setDragSource = StateEffect.define<number | null>();
const dragSource = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setDragSource)) continue;
      value =
        e.value === null
          ? Decoration.none
          : Decoration.set([Decoration.line({ class: "cm-drag-source" }).range(tr.state.doc.line(e.value).from)]);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** A small copy of the line that follows the pointer, so it's clear what is being moved. */
function makeGhost(view: EditorView, lineNo: number): HTMLElement {
  const text = view.state.doc.line(lineNo).text;
  const p = parseLine(text);
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  if (p.markerFrom >= 0) {
    const box = document.createElement("span");
    box.className = `drag-ghost-box${p.kind === "done" ? " is-done" : ""}`;
    ghost.appendChild(box);
  }
  ghost.append(text.slice(p.bodyFrom).trim() || " ");
  document.body.appendChild(ghost);
  return ghost;
}

/**
 * Press on a checkbox or the left gutter, then drag: the line moves where the orange
 * drop line is. A press without movement is a plain click (toggle / place caret).
 * Dropping above "---" puts the line into focus. No animation: this is a frequent action.
 */
function startLineDrag(view: EditorView, source: number, down: MouseEvent, onClick: () => void) {
  const indicator = document.getElementById("drop-line") as HTMLElement | null;
  let ghost: HTMLElement | null = null;
  let dragging = false;
  let insertBefore = source;

  const targetAt = (clientY: number) => {
    const doc = view.state.doc;
    const y = Math.max(view.documentTop, Math.min(clientY, view.documentTop + view.contentHeight - 1));
    const block = view.lineBlockAtHeight(y - view.documentTop);
    const n = doc.lineAt(block.from).number;
    const before = clientY < view.documentTop + block.top + block.height / 2;
    return { n: before ? n : n + 1, edge: view.documentTop + (before ? block.top : block.bottom) };
  };

  const move = (e: MouseEvent) => {
    if (!dragging) {
      if (Math.abs(e.clientY - down.clientY) + Math.abs(e.clientX - down.clientX) < DRAG_THRESHOLD) return;
      dragging = true;
      document.body.classList.add("is-dragging");
      view.dispatch({ effects: setDragSource.of(source) });
      ghost = makeGhost(view, source);
    }
    if (ghost) {
      ghost.style.left = `${e.clientX + 14}px`;
      ghost.style.top = `${e.clientY - 14}px`;
    }
    // Nudge the scroller when dragging near its edges.
    const r = view.scrollDOM.getBoundingClientRect();
    if (e.clientY < r.top + 16) view.scrollDOM.scrollTop -= 8;
    else if (e.clientY > r.bottom - 16) view.scrollDOM.scrollTop += 8;

    const t = targetAt(e.clientY);
    insertBefore = t.n;
    if (indicator) {
      const c = view.contentDOM.getBoundingClientRect();
      indicator.hidden = false;
      indicator.style.top = `${Math.round(t.edge) - 1}px`;
      indicator.style.left = `${c.left + GUTTER - 24}px`;
      indicator.style.width = `${Math.max(0, c.width - GUTTER + 24 - 16)}px`;
    }
  };

  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.classList.remove("is-dragging");
    if (indicator) indicator.hidden = true;
    ghost?.remove();
    if (!dragging) return onClick();
    view.dispatch({ effects: setDragSource.of(null) });
    moveLine(view, source, insertBefore);
  };

  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function moveLine(view: EditorView, source: number, insertBefore: number) {
  if (insertBefore === source || insertBefore === source + 1) return;
  const lines = view.state.doc.toString().split("\n");
  const [text] = lines.splice(source - 1, 1);
  const index = insertBefore > source ? insertBefore - 2 : insertBefore - 1;
  lines.splice(index, 0, text);
  replaceDoc(view, lines.join("\n"), { userEvent: "move.drag" });
  const ln = view.state.doc.line(index + 1);
  view.dispatch({ selection: { anchor: ln.to } });
  view.focus();
}

// ---------- commands ----------

function toggleAt(view: EditorView, lineNumbers: number[]) {
  const changes = lineNumbers.map((n) => {
    const ln = view.state.doc.line(n);
    return { from: ln.from, to: ln.to, insert: toggleLine(ln.text) };
  });
  view.dispatch({ changes, userEvent: "input.toggle" });
}

function selectedLines(state: EditorState): number[] {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return [...set];
}

/** Ctrl+Enter: text → [ ], [ ] → [x], [x]/[>] → [ ]. */
const toggleCommand = (view: EditorView) => {
  toggleAt(view, selectedLines(view.state));
  return true;
};

/** Enter continues a to-do list; Enter on an empty to-do ends the list. Keeps indentation. */
const smartEnter = (view: EditorView) => {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const ln = state.doc.lineAt(range.head);
    const p = parseLine(ln.text);
    const indent = ln.text.slice(0, p.indent);
    const isTask = p.markerFrom >= 0;
    if (isTask && ln.text.slice(p.bodyFrom).trim() === "" && range.empty) {
      return {
        changes: { from: ln.from, to: ln.to, insert: indent },
        range: EditorSelection.cursor(ln.from + indent.length),
      };
    }
    const insert = "\n" + indent + (isTask ? "[ ] " : "");
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
  return true;
};

/**
 * Typing shortcuts at the start of a line:
 * - "[]" becomes "[ ] " the moment "]" is typed.
 * - "[]" typed on an empty to-do (Enter already added "[ ] ") is absorbed, not doubled.
 * - "---" typed on an empty to-do becomes the focus divider, not "[ ] ---".
 */
const lineStartInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to) return false;
  const ln = view.state.doc.lineAt(from);
  const before = ln.text.slice(0, from - ln.from);
  const after = ln.text.slice(from - ln.from);
  if (after.trim() !== "") return false;

  if (text === "]") {
    if (/^\s*\[ \] \[$/.test(before)) {
      // "[ ] [" + "]" → keep the single marker that is already there
      view.dispatch({ changes: { from: from - 1, to: from }, userEvent: "input.type" });
      return true;
    }
    if (/^\s*\[$/.test(before)) {
      view.dispatch({ changes: { from, to, insert: " ] " }, selection: { anchor: from + 3 }, userEvent: "input.type" });
      return true;
    }
  }
  if (text === "-" && /^\s*\[ \] --$/.test(before)) {
    view.dispatch({
      changes: { from: ln.from, to: ln.to, insert: "---" },
      selection: { anchor: ln.from + 3 },
      userEvent: "input.type",
    });
    return true;
  }
  return false;
});

// ---------- zoom (Notepad parity: Ctrl+=, Ctrl+-, Ctrl+0, Ctrl+wheel) ----------

const ZOOM_KEY = "catio.zoom";
const BASE = 14;
let fontSize = readZoom();

function readZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return v >= 10 && v <= 32 ? v : BASE;
  } catch {
    return BASE;
  }
}

export function applyZoom(size = fontSize) {
  fontSize = Math.min(32, Math.max(10, size));
  document.documentElement.style.setProperty("--fs", `${fontSize}px`);
  try {
    localStorage.setItem(ZOOM_KEY, String(fontSize));
  } catch {
    /* zoom still works for this session */
  }
  return true;
}

const zoomHandlers = EditorView.domEventHandlers({
  wheel(e) {
    if (!e.ctrlKey) return false;
    e.preventDefault();
    applyZoom(fontSize + (e.deltaY < 0 ? 1 : -1));
    return true;
  },
});

// ---------- assembly ----------

export function createEditor(parent: HTMLElement, doc: string, hooks: EditorHooks, onChange: (u: ViewUpdate) => void) {
  applyZoom();
  const catioKeymap = keymap.of([
    { key: "Enter", run: smartEnter },
    { key: "Mod-Enter", run: toggleCommand },
    { key: "Tab", run: indentMore, shift: indentLess },
    { key: "Mod-s", run: () => (hooks.onSave(), true), preventDefault: true },
    { key: "Mod-=", run: () => applyZoom(fontSize + 1) },
    { key: "Mod-+", run: () => applyZoom(fontSize + 1) },
    { key: "Mod--", run: () => applyZoom(fontSize - 1) },
    { key: "Mod-0", run: () => applyZoom(BASE) },
  ]);
  // Layered Esc: the search panel handles its own Esc first; then clear selection; then hide.
  const escKeymap = keymap.of([
    {
      key: "Escape",
      run: (view) => {
        const sel = view.state.selection;
        if (sel.ranges.some((r) => !r.empty) || sel.ranges.length > 1) {
          view.dispatch({ selection: EditorSelection.cursor(sel.main.head) });
          return true;
        }
        hooks.onHide();
        return true;
      },
    },
  ]);

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    search({ top: true }),
    placeholder("tulis apa aja. [] buat to-do, --- buat batas fokus"),
    lineStartInput,
    decorations,
    dragSource,
    zoomHandlers,
    catioKeymap,
    keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
    escKeymap,
    EditorView.updateListener.of(onChange),
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", "aria-label": "catio.md" }),
  ];

  return new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
}

/** Replace the document with minimal changes so the cursor stays where it was. */
export function replaceDoc(view: EditorView, next: string, annotation: object) {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  let start = 0;
  const max = Math.min(cur.length, next.length);
  while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
    endCur--;
    endNext--;
  }
  view.dispatch({
    changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
    userEvent: "external",
    ...annotation,
  });
}
