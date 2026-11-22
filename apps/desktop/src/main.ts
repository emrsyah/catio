import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import { Annotation } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { collectReminders, lastDayStart, wakeSnoozed } from "@catio/core";
import { createEditor, replaceDoc } from "./editor";

type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

interface Loaded {
  path: string;
  text: string;
  first_run: boolean;
}

const SAVE_DEBOUNCE_MS = 300;
const UNDO_WINDOW_MS = 8000;
const WAKE_KEY = "catio.lastWake";
const external = Annotation.define<boolean>();
const statusEl = document.getElementById("status")!;

let view: EditorView;
let saveTimer: number | undefined;
let dirty = false;
let statusTimer: number | undefined;
/** An actionable status ("batal") disappears as soon as you keep typing. */
let statusClearsOnEdit = false;

// ---------- status strip ----------

interface StatusAction {
  label: string;
  run: () => void;
}

function setStatus(text: string, tone: "quiet" | "accent" = "quiet", holdMs = 0, action?: StatusAction) {
  statusEl.replaceChildren(text);
  statusEl.dataset.tone = tone;
  statusClearsOnEdit = false;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "status-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.run();
      view.focus();
    });
    statusEl.append(" · ", btn);
  }
  window.clearTimeout(statusTimer);
  if (holdMs) statusTimer = window.setTimeout(() => statusEl.replaceChildren(), holdMs);
}

/** "C:\Users\x\Documents\Catio\catio.md" → "Documents\Catio\catio.md" */
function shortPath(path: string) {
  return path.split(/[\\/]/).slice(-3).join("\\");
}

// ---------- saving ----------

async function save() {
  window.clearTimeout(saveTimer);
  const text = view.state.doc.toString();
  try {
    await invoke("save_doc", { text });
    dirty = false;
    if (!statusClearsOnEdit && !statusEl.querySelector(".status-action")) setStatus("tersimpan", "quiet", 1500);
  } catch (err) {
    console.error(err);
    setStatus("belum tersimpan · tekan Ctrl+S buat coba lagi", "accent");
  }
  scheduleReminders(text);
}

function scheduleReminders(text: string) {
  const reminders = collectReminders(text.split(/\r?\n/), new Date()).map((r) => ({
    ...r,
    clock: new Date(r.at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false }).replace(".", ":"),
  }));
  invoke("set_reminders", { reminders }).catch(console.error);
}

function onChange(u: ViewUpdate) {
  if (!u.docChanged) return;
  if (u.transactions.some((t) => t.annotation(external))) return;
  if (statusClearsOnEdit) {
    statusClearsOnEdit = false;
    statusEl.replaceChildren();
  }
  dirty = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function onExternalChange(text: string) {
  if (text === view.state.doc.toString()) return;
  if (dirty) {
    // Both sides changed in the same instant. Keep what is on screen and park the other
    // version next to the file so nothing disappears silently. Line-level merge comes in v1.
    try {
      const path = await invoke<string>("save_conflict_copy", { text });
      setStatus(`ada versi lain · disimpan di ${path.split(/[\\/]/).pop()}`, "accent");
    } catch (err) {
      console.error(err);
    }
    await save();
    return;
  }
  replaceDoc(view, text, { annotations: external.of(true) });
  scheduleReminders(text);
}

// ---------- Bersihin ----------

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function onCleaned(lines: string[], revert: () => boolean) {
  try {
    const block = await invoke<string>("archive_lines", { date: today(), lines });
    setStatus(`${lines.length} yang selesai pindah ke arsip.md`, "quiet", UNDO_WINDOW_MS, {
      label: "batal",
      run: () => {
        if (!revert()) return;
        invoke("unarchive", { block }).catch(console.error);
        setStatus("dibalikin", "quiet", 1500);
      },
    });
    statusClearsOnEdit = true;
  } catch (err) {
    // Archive failed: put the lines back so nothing is lost.
    console.error(err);
    revert();
    setStatus("arsip.md nggak bisa ditulis · yang selesai tetap di pad", "accent", 4000);
  }
}

// ---------- snooze day boundary (04:00) ----------

/** Snoozed lines come back as open to-dos once per day, at the first check after 04:00. */
function wakeIfNewDay() {
  const boundary = lastDayStart(new Date()).getTime();
  let last = 0;
  try {
    last = Number(localStorage.getItem(WAKE_KEY)) || 0;
  } catch {
    /* treat as never */
  }
  if (last >= boundary) return;
  const text = view.state.doc.toString();
  const next = wakeSnoozed(text.split("\n")).join("\n");
  if (next !== text) replaceDoc(view, next, { userEvent: "input.wake" });
  try {
    localStorage.setItem(WAKE_KEY, String(Date.now()));
  } catch {
    /* wakes again next check, harmless */
  }
}

// ---------- folder ----------

async function chooseFolder() {
  if (dirty) await save();
  try {
    const res = await invoke<Loaded | null>("choose_folder", { current: view.state.doc.toString() });
    if (!res) return;
    replaceDoc(view, res.text, { annotations: external.of(true) });
    scheduleReminders(res.text);
    setStatus(`sekarang di ${shortPath(res.path)}`, "quiet", 4000);
  } catch (err) {
    console.error(err);
    setStatus("folder itu nggak bisa dipakai · coba folder lain", "accent", 4000);
  }
}

// ---------- window ----------

function hidePad() {
  if (dirty) void save();
  invoke("hide_pad").catch(console.error);
}

/** Window chrome: hover controls, double-click strip (handled by Tauri), F11, resize edges. */
function setupWindowChrome() {
  const win = getCurrentWindow();
  const syncMax = async () => document.body.classList.toggle("is-max", await win.isMaximized());
  document.getElementById("btn-max")!.addEventListener("click", () => void win.toggleMaximize());
  // No taskbar button, so "minimize" and "close" both tuck the pad into the tray:
  // a real minimize would strand it, and quitting would stop reminders. Quit lives in the tray menu.
  document.getElementById("btn-min")!.addEventListener("click", hidePad);
  document.getElementById("btn-hide")!.addEventListener("click", hidePad);
  window.addEventListener("keydown", (e) => {
    if (e.key === "F11") {
      e.preventDefault();
      void win.toggleMaximize();
    }
  });
  document.querySelectorAll<HTMLElement>(".rz").forEach((el) =>
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void win.startResizeDragging(el.dataset.dir as ResizeDirection);
    }),
  );
  void win.onResized(() => void syncMax());
  void syncMax();
}

// ---------- boot ----------

async function boot() {
  setupWindowChrome();
  const { text, path, first_run } = await invoke<Loaded>("load_doc");
  view = createEditor(
    document.getElementById("editor")!,
    text,
    {
      onSave: () => void save(),
      onHide: hidePad,
      onCleaned: (lines, revert) => void onCleaned(lines, revert),
      onNothingToClean: () => setStatus("belum ada yang selesai", "quiet", 1500),
    },
    onChange,
  );
  view.focus();
  wakeIfNewDay();
  scheduleReminders(view.state.doc.toString());
  if (first_run) {
    setStatus(`disimpan di ${shortPath(path)}`, "quiet", 0, { label: "ganti", run: () => void chooseFolder() });
    statusClearsOnEdit = true; // stays until you start writing
  }

  await listen<string>("doc-changed", (e) => void onExternalChange(e.payload));
  await listen("choose-folder", () => void chooseFolder());
  await listen("pad-shown", () => {
    view.focus();
    wakeIfNewDay();
    scheduleReminders(view.state.doc.toString());
  });
  // The pad never quits, so "jam 9" written last night must still get scheduled today.
  window.setInterval(() => {
    wakeIfNewDay();
    scheduleReminders(view.state.doc.toString());
  }, 5 * 60_000);
  await listen<number>("focus-line", (e) => {
    const n = Math.min(Math.max(1, e.payload + 1), view.state.doc.lines);
    const ln = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: ln.to }, scrollIntoView: true });
    view.focus();
  });

  // Never lose the last keystrokes when the window is hidden or the app quits.
  window.addEventListener("blur", () => dirty && void save());
  window.addEventListener("beforeunload", () => dirty && void save());
}

boot().catch((err) => {
  console.error(err);
  setStatus("gagal buka catio.md", "accent");
});
