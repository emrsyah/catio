import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import { Annotation } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { collectReminders } from "@catio/core";
import { createEditor, replaceDoc } from "./editor";

const SAVE_DEBOUNCE_MS = 300;
const external = Annotation.define<boolean>();
const statusEl = document.getElementById("status")!;

let view: EditorView;
let saveTimer: number | undefined;
let dirty = false;
let statusTimer: number | undefined;

function setStatus(text: string, tone: "quiet" | "accent" = "quiet", holdMs = 0) {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
  window.clearTimeout(statusTimer);
  if (holdMs) statusTimer = window.setTimeout(() => (statusEl.textContent = ""), holdMs);
}

async function save() {
  window.clearTimeout(saveTimer);
  const text = view.state.doc.toString();
  try {
    await invoke("save_doc", { text });
    dirty = false;
    setStatus("tersimpan", "quiet", 1500);
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

async function boot() {
  const { text } = await invoke<{ path: string; text: string }>("load_doc");
  view = createEditor(
    document.getElementById("editor")!,
    text,
    {
      onSave: () => void save(),
      onHide: () => {
        if (dirty) void save();
        invoke("hide_pad").catch(console.error);
      },
    },
    onChange,
  );
  view.focus();
  scheduleReminders(text);

  await listen<string>("doc-changed", (e) => void onExternalChange(e.payload));
  await listen("pad-shown", () => {
    view.focus();
    scheduleReminders(view.state.doc.toString());
  });
  // The pad never quits, so "jam 9" written last night must still get scheduled today.
  window.setInterval(() => scheduleReminders(view.state.doc.toString()), 5 * 60_000);
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
