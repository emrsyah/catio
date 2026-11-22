import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import { Annotation } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { collectReminders, lastDayStart, wakeSnoozed } from "@catio/core";
import { commitActiveLine, createEditor, loadDoc, replaceDoc } from "./editor";
import { setupPadMenu } from "./pads";

type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

interface Loaded {
  path: string;
  text: string;
  first_run: boolean;
  pad: string;
}

interface PadInfo {
  name: string;
  text: string;
}

const SAVE_DEBOUNCE_MS = 300;
const UNDO_WINDOW_MS = 8000;
const WAKE_KEY = "catio.lastWake";
const external = Annotation.define<boolean>();
const statusEl = document.getElementById("status")!;

let view: EditorView;
/** The pad on screen, and every pad's text as last read (the active one is stale: use the editor). */
let pad = "catio";
let padList: PadInfo[] = [];
let padMenu: ReturnType<typeof setupPadMenu>;
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

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let statusAnim: Animation | undefined;

/** Status text fades out instead of vanishing mid-read. */
function clearStatus() {
  if (!statusEl.childNodes.length) return;
  statusAnim?.cancel();
  statusAnim = statusEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE_OUT });
  statusAnim.onfinish = () => statusEl.replaceChildren();
}

function setStatus(text: string, tone: "quiet" | "accent" = "quiet", holdMs = 0, action?: StatusAction) {
  statusAnim?.cancel();
  const same = statusEl.textContent === text && !action;
  statusEl.replaceChildren(text);
  // A new message rises in a hair; repeating the same one stays still.
  if (!same) {
    const lift = reducedMotion.matches ? "0px" : "2px";
    statusAnim = statusEl.animate(
      [
        { opacity: 0, transform: `translateY(${lift})` },
        { opacity: 1, transform: "none" },
      ],
      { duration: 180, easing: EASE_OUT },
    );
  }
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
  if (holdMs) statusTimer = window.setTimeout(clearStatus, holdMs);
}

/** "C:\Users\x\Documents\Catio\catio.md" → "Documents\Catio\catio.md" */
function shortPath(path: string) {
  return path.split(/[\\/]/).slice(-3).join("\\");
}

// ---------- saving ----------

const saveDot = document.getElementById("save-dot")!;
const SAVE_LABELS = { saved: "Tersimpan", pending: "Belum tersimpan", error: "Gagal simpan" } as const;
function setSaveState(state: keyof typeof SAVE_LABELS) {
  saveDot.dataset.state = state;
  saveDot.title = SAVE_LABELS[state];
  saveDot.setAttribute("aria-label", SAVE_LABELS[state]);
}

async function save() {
  window.clearTimeout(saveTimer);
  const forPad = pad; // a save still in flight after a switch must land in the right file
  const text = view.state.doc.toString();
  try {
    await invoke("save_doc", { pad: forPad, text });
    if (pad !== forPad) return;
    // Something typed while saving keeps the dot grey until the next save.
    dirty = view.state.doc.toString() !== text;
    if (!dirty) setSaveState("saved");
    if (statusEl.dataset.tone === "accent" && statusEl.textContent?.startsWith("belum tersimpan")) clearStatus();
  } catch (err) {
    console.error(err);
    setSaveState("error");
    setStatus("belum tersimpan · tekan Ctrl+S buat coba lagi", "accent");
  }
  scheduleReminders();
}

/** Every pad's current text: the editor for the one on screen, the last read for the rest. */
function allTexts(): PadInfo[] {
  const text = view.state.doc.toString();
  if (!padList.some((p) => p.name === pad)) return [{ name: pad, text }, ...padList];
  return padList.map((p) => (p.name === pad ? { name: pad, text } : p));
}

/** Open to-dos with words in them (snoozed and empty ones don't count). */
function countOpen(text: string) {
  return text.split("\n").filter((l) => /^\s*\[ \]\s*\S/.test(l)).length;
}

/** Reminders from every pad, not only the one on screen. */
function scheduleReminders() {
  const now = new Date();
  const reminders = allTexts().flatMap((p) =>
    collectReminders(p.text.split(/\r?\n/), now).map((r) => ({
      ...r,
      pad: p.name,
      clock: new Date(r.at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false }).replace(".", ":"),
    })),
  );
  invoke("set_reminders", { reminders }).catch(console.error);
  updateDockBadge();
}

// ---------- pads ----------

async function refreshPads() {
  try {
    padList = await invoke<PadInfo[]>("list_pads");
  } catch (err) {
    console.error(err);
  }
  padMenu.refresh();
  scheduleReminders();
}

/** Shows a pad's text with its own undo history, then catches up everything that depends on it. */
function showPad(res: Loaded) {
  pad = res.pad;
  dirty = false;
  setSaveState("saved");
  loadDoc(view, res.text);
  view.contentDOM.setAttribute("aria-label", `Pad ${pad}`);
  wakeIfNewDay();
  padMenu.refresh();
  view.focus();
}

/** Finish what's on screen (lock relative dates, save) before leaving it. */
async function flushCurrent() {
  commitActiveLine(view);
  if (dirty) await save();
}

async function switchTo(name: string) {
  if (name === pad) return view.focus();
  await flushCurrent();
  try {
    showPad(await invoke<Loaded>("switch_pad", { name }));
  } catch (err) {
    console.error(err);
    setStatus("pad itu nggak bisa dibuka", "accent", 3000);
  }
  await refreshPads();
}

async function createPad(name: string) {
  await flushCurrent();
  try {
    const res = await invoke<Loaded>("create_pad", { name });
    showPad(res);
    setStatus(`pad ${res.pad} siap`, "quiet", 1500);
  } catch (err) {
    console.error(err);
    setStatus("pad baru nggak bisa dibikin", "accent", 3000);
  }
  await refreshPads();
}

async function renamePad(old: string, name: string) {
  try {
    if (old === pad) await flushCurrent();
    const next = await invoke<string>("rename_pad", { old, name });
    if (old === pad) {
      pad = next;
      view.contentDOM.setAttribute("aria-label", `Pad ${pad}`);
    }
  } catch (err) {
    console.error(err);
    setStatus("nama itu nggak bisa dipakai", "accent", 3000);
  }
  await refreshPads();
}

/** Delete = move to .terhapus, with "batal" in the strip for a few seconds. No dialog. */
async function deletePad(name: string) {
  const list = allTexts();
  if (list.length <= 1) return setStatus("minimal harus ada satu pad", "quiet", 2000);
  const wasActive = name === pad;
  if (wasActive) {
    window.clearTimeout(saveTimer);
    await save(); // keep the last keystrokes in the file that goes to .terhapus
  }
  let trashed: string;
  try {
    trashed = await invoke<string>("delete_pad", { name });
  } catch (err) {
    console.error(err);
    return setStatus("pad itu nggak bisa dihapus", "accent", 3000);
  }
  if (wasActive) {
    const i = list.findIndex((p) => p.name === name);
    const next = list[i + 1]?.name ?? list[i - 1]?.name;
    if (next) {
      try {
        showPad(await invoke<Loaded>("switch_pad", { name: next }));
      } catch (err) {
        console.error(err);
      }
    }
  }
  await refreshPads();
  setStatus(`pad ${name} dihapus`, "quiet", UNDO_WINDOW_MS, {
    label: "batal",
    run: async () => {
      try {
        const back = await invoke<string>("restore_pad", { trashed, name });
        await refreshPads();
        await switchTo(back);
        setStatus("dibalikin", "quiet", 1500);
      } catch (err) {
        console.error(err);
        setStatus("nggak bisa dibalikin · cek folder .terhapus", "accent", 4000);
      }
    },
  });
}

/** Ctrl+N new pad, Ctrl+Tab / Ctrl+Shift+Tab next/previous, Ctrl+1…9 jump. Instant, no animation. */
function setupPadKeys() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const names = allTexts().map((p) => p.name);
      if (e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        padMenu.open({ newPad: true });
      } else if (e.key === "Tab" && names.length > 1) {
        e.preventDefault();
        const i = names.indexOf(pad);
        void switchTo(names[(i + (e.shiftKey ? -1 : 1) + names.length) % names.length]);
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const target = names[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          void switchTo(target);
        }
      }
    },
    true,
  );
}

function onChange(u: ViewUpdate) {
  if (!u.docChanged) return;
  if (u.transactions.some((t) => t.annotation(external))) return;
  if (statusClearsOnEdit) {
    statusClearsOnEdit = false;
    window.clearTimeout(statusTimer);
    clearStatus();
  }
  dirty = true;
  if (saveDot.dataset.state !== "error") setSaveState("pending");
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
  scheduleReminders(); // also refreshes the dock badge (edited in Notepad while collapsed)
  padMenu.refresh();
}

// ---------- Bersihin ----------

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function onCleaned(lines: string[], revert: () => boolean) {
  try {
    const block = await invoke<string>("archive_lines", { date: today(), pad, lines });
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
  // Per pad: a pad you open for the first time today still wakes its own snoozes.
  const key = pad === "catio" ? WAKE_KEY : `${WAKE_KEY}.${pad}`;
  let last = 0;
  try {
    last = Number(localStorage.getItem(key)) || 0;
  } catch {
    /* treat as never */
  }
  if (last >= boundary) return;
  const text = view.state.doc.toString();
  const next = wakeSnoozed(text.split("\n")).join("\n");
  if (next !== text) replaceDoc(view, next, { userEvent: "input.wake" });
  try {
    localStorage.setItem(key, String(Date.now()));
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
    await refreshPads();
    setStatus(`sekarang di ${shortPath(res.path)}`, "quiet", 4000);
  } catch (err) {
    console.error(err);
    setStatus("folder itu nggak bisa dipakai · coba folder lain", "accent", 4000);
  }
}

// ---------- dock mode ----------

const DOCK_KEY = "catio.dock";
const COLLAPSE_DELAY_MS = 350;
const DOCK_CLOSE_MS = 260; // matches --dock-close: the card shrinks to the icon, then the window does
let docked = false;
let expanded = false; // window state, from Rust
let collapseTimer: number | undefined;
const body = document.body;

/** Runs cb after the window has actually grown and painted one frame at the new size,
 *  so the card starts opening from the icon's spot instead of mid-resize. */
function whenWindowOpen(cb: () => void) {
  const ready = () => requestAnimationFrame(() => requestAnimationFrame(cb));
  if (window.innerWidth > 100) return ready();
  window.addEventListener("resize", function onResize() {
    if (window.innerWidth <= 100) return;
    window.removeEventListener("resize", onResize);
    ready();
  });
}

/** Animated close: card shrinks into the icon, then the (now invisible) window shrinks. */
function closeDock() {
  window.clearTimeout(collapseTimer);
  if (dirty) void save();
  body.classList.remove("is-open");
  // Shrink the window only once the card has fully landed on the icon; cutting the last
  // frames is what makes a close feel like it snaps. Timer is the fallback.
  const shell = document.getElementById("shell")!;
  const finish = () => {
    shell.removeEventListener("transitionend", onEnd);
    window.clearTimeout(collapseTimer);
    if (!body.classList.contains("is-open")) invoke("dock_collapse").catch(console.error);
  };
  const onEnd = (e: TransitionEvent) => e.target === shell && e.propertyName === "clip-path" && finish();
  shell.addEventListener("transitionend", onEnd);
  collapseTimer = window.setTimeout(finish, DOCK_CLOSE_MS + 80);
}

function setDock(on: boolean) {
  try {
    localStorage.setItem(DOCK_KEY, on ? "1" : "0");
  } catch {
    /* mode still applies this session */
  }
  invoke("set_dock", { on }).catch(console.error);
}

/** Every open to-do across all pads (snoozed and empty ones don't count),
 *  shown as a badge on the collapsed icon. */
function updateDockBadge() {
  const badge = document.getElementById("dock-badge")!;
  const open = allTexts().reduce((n, p) => n + countOpen(p.text), 0);
  badge.hidden = open === 0;
  badge.textContent = open > 99 ? "99+" : String(open);
  const label = `${open} to-do belum beres`;
  document.getElementById("dock-icon")!.setAttribute("aria-label", `Buka pad, ${label}`);
  badge.title = label;
}

async function setupDock() {
  const root = document.documentElement;
  await listen<{ docked: boolean; expanded: boolean }>("dock-state", (e) => {
    docked = e.payload.docked;
    expanded = e.payload.expanded;
    body.classList.toggle("is-docked", docked);
    if (docked && expanded) {
      whenWindowOpen(() => expanded && body.classList.add("is-open"));
    } else if (body.classList.contains("is-open")) {
      // Closed without our animation (hotkey, tray): jump to the icon, no half-drawn frames.
      body.classList.add("dock-snap");
      body.classList.remove("is-open");
      requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("dock-snap")));
    }
    if (docked && !expanded) updateDockBadge();
  });
  await listen<boolean>("dock-request", (e) => setDock(e.payload));
  document.getElementById("btn-dock")!.addEventListener("click", () => setDock(!docked));
  document.getElementById("dock-icon")!.addEventListener("click", () => {
    invoke("dock_expand", { focus: true }).catch(console.error);
  });
  // Hover opens a preview without stealing the keyboard; click inside to edit.
  root.addEventListener("mouseenter", () => {
    window.clearTimeout(collapseTimer);
    if (!docked) return;
    // Came back while the card was closing: it reverses from wherever it is (a transition).
    if (expanded) body.classList.add("is-open");
    else invoke("dock_expand", { focus: false }).catch(console.error);
  });
  // Leaving shrinks it back, after a short grace so a wobble past the edge doesn't snap it shut.
  root.addEventListener("mouseleave", () => {
    if (!docked || !expanded || body.classList.contains("is-dragging")) return;
    window.clearTimeout(collapseTimer);
    collapseTimer = window.setTimeout(closeDock, COLLAPSE_DELAY_MS);
  });
  // Always sync with Rust on boot (also after a reload), so window and classes agree.
  let stored = false;
  try {
    stored = localStorage.getItem(DOCK_KEY) === "1";
  } catch {
    /* default: floating pad */
  }
  setDock(stored);
}

// ---------- window ----------

function hidePad() {
  if (docked && expanded) return closeDock(); // Esc / × in dock mode: same animated close
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
  const { text, path, first_run, pad: openPad } = await invoke<Loaded>("load_doc");
  pad = openPad;
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
  view.contentDOM.setAttribute("aria-label", `Pad ${pad}`);
  view.focus();
  padMenu = setupPadMenu({
    list: () => allTexts().map((p) => ({ name: p.name, open: countOpen(p.text) })),
    current: () => pad,
    select: (name) => void switchTo(name),
    create: (name) => void createPad(name),
    rename: (old, name) => void renamePad(old, name),
    remove: (name) => void deletePad(name),
    closed: () => view.focus(),
  });
  setupPadKeys();
  wakeIfNewDay();
  await refreshPads();
  await setupDock();
  if (first_run) {
    setStatus(`disimpan di ${shortPath(path)}`, "quiet", 0, { label: "ganti", run: () => void chooseFolder() });
    statusClearsOnEdit = true; // stays until you start writing
  }

  await listen<{ pad: string; text: string }>("doc-changed", (e) => {
    if (e.payload.pad === pad) void onExternalChange(e.payload.text);
    else void refreshPads(); // stale event from the pad you just left
  });
  // Another pad's file changed (Notepad, phone sync, a pad added in Explorer).
  await listen("pads-changed", () => void refreshPads());
  await listen("choose-folder", () => void chooseFolder());
  await listen("pad-shown", () => {
    view.focus();
    wakeIfNewDay();
    scheduleReminders();
  });
  // The pad never quits, so "jam 9" written last night must still get scheduled today.
  window.setInterval(() => {
    wakeIfNewDay();
    scheduleReminders();
  }, 5 * 60_000);
  await listen<{ pad: string; line: number }>("focus-line", async (e) => {
    if (e.payload.pad && e.payload.pad !== pad) await switchTo(e.payload.pad);
    const n = Math.min(Math.max(1, e.payload.line + 1), view.state.doc.lines);
    const ln = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: ln.to }, scrollIntoView: true });
    view.focus();
  });

  // Never lose the last keystrokes when the window is hidden or the app quits.
  window.addEventListener("blur", () => {
    commitActiveLine(view); // "besok" on the line you're still on becomes a real date
    if (dirty) void save();
  });
  window.addEventListener("beforeunload", () => dirty && void save());
}

boot().catch((err) => {
  console.error(err);
  setStatus("gagal buka catio.md", "accent");
});
