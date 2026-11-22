import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./tokens.css";
import "./styles.css";

import { Annotation } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  collectReminders,
  commitWhen,
  dayNumber,
  insertCaptured,
  lastDayStart,
  moveToFocus,
  normalizeMarker,
  resolveDate,
  setDate,
  toggleLine,
  wakeSnoozed,
  type IndexedLine,
} from "@catio/core";
import {
  commitActiveLine,
  createEditor,
  goToLine,
  loadDoc,
  redraw,
  renameDocState,
  replaceDoc,
  setFocusMode,
} from "./editor";
import { setupPadMenu } from "./pads";
import { setupReview, type ReviewChoice, type StuckTask } from "./review";
import { setupSearch } from "./search";
import { setupSidebar } from "./sidebar";
import { ageDays, forgetPad, padData, renameAges, trackAges, type PadInfo } from "./store";

type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

interface Loaded {
  path: string;
  text: string;
  first_run: boolean;
  pad: string;
}

const SAVE_DEBOUNCE_MS = 300;
const UNDO_WINDOW_MS = 8000;
const STUCK_DAYS = 7;
const SOON_MIN = 15; // the dock badge counts down for reminders this close
const WAKE_KEY = "catio.lastWake";
const REVIEW_KEY = "catio.reviewOffered";
const IDLE_KEY = "catio.idleFade";
const external = Annotation.define<boolean>();
const statusEl = document.getElementById("status")!;
const body = document.body;

let view: EditorView;
/** The pad on screen, and every pad's text as last read (the active one is stale: use the editor). */
let pad = "catio";
let padList: PadInfo[] = [];
let padMenu: ReturnType<typeof setupPadMenu>;
let palette: ReturnType<typeof setupSearch>;
let review: ReturnType<typeof setupReview>;
let sidebar: ReturnType<typeof setupSidebar>;
let saveTimer: number | undefined;
let dirty = false;
let statusTimer: number | undefined;
/** An actionable status ("batal") disappears as soon as you keep typing. */
let statusClearsOnEdit = false;
/** A one-key offer (paste a list → "jadiin to-do?"): Tab accepts it right after. */
let tabOffer: (() => void) | null = null;
/** The other version of the file while you choose between it and yours; autosave waits. */
let conflictText: string | null = null;
/** Earliest upcoming reminder (epoch ms), for the dock countdown. */
let nextReminder: { at: number; label: string } | null = null;

const persist = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* works for this session only */
    }
  },
};

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
  tabOffer = null;
  if (!statusEl.childNodes.length) return;
  statusAnim?.cancel();
  statusAnim = statusEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE_OUT });
  statusAnim.onfinish = () => statusEl.replaceChildren();
}

function setStatus(text: string, tone: "quiet" | "accent" = "quiet", holdMs = 0, actions: StatusAction | StatusAction[] = []) {
  statusAnim?.cancel();
  const list = Array.isArray(actions) ? actions : [actions];
  const same = statusEl.textContent === text && !list.length;
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
  tabOffer = null;
  for (const action of list) {
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

async function save(force = false) {
  window.clearTimeout(saveTimer);
  if (conflictText !== null && !force) return; // waiting for "pakai versi file / punya ini"
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

/**
 * Reminders, ages, the dock badge and the sidebar, from every pad. Each pad's text is parsed
 * once per version (store.ts), so this is cheap to call after every save.
 */
function scheduleReminders() {
  const now = new Date();
  const clock = (at: number) =>
    new Date(at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false }).replace(".", ":");
  const reminders = allTexts().flatMap((p) => {
    const d = padData(p.name, p.text);
    if (trackAges(p.name, p.text, now) && p.name === pad) redraw(view);
    return collectReminders(d.lines, now, d.parsed).map((r) => ({ ...r, pad: p.name, clock: clock(r.at) }));
  });
  nextReminder = reminders.reduce<{ at: number; label: string } | null>(
    (best, r) => (!best || r.at < best.at ? { at: r.at, label: r.label } : best),
    null,
  );
  invoke("set_reminders", { reminders }).catch(console.error);
  updateDockBadge();
  sidebar?.render();
}

// ---------- editing any pad ----------

/** Reads a pad's text: the editor for the one on screen, the file for the rest. */
async function readPad(name: string): Promise<string> {
  return name === pad ? view.state.doc.toString() : invoke<string>("read_pad", { name });
}

/**
 * Edits a pad by lines. On screen: one minimal editor change (Ctrl+Z undoes it). Elsewhere:
 * re-read the file, apply, save. `edit` returns null to cancel (e.g. the line changed meanwhile).
 */
async function transformPad(name: string, edit: (lines: string[]) => string[] | null, userEvent = "input.edit"): Promise<string | null> {
  const text = await readPad(name);
  const next = edit(text.split("\n"));
  if (!next) return null;
  const out = next.join("\n");
  if (name === pad) {
    replaceDoc(view, out, { userEvent });
    await save();
    return out;
  }
  await invoke("save_doc", { pad: name, text: out });
  padList = padList.map((p) => (p.name === name ? { name, text: out } : p));
  scheduleReminders();
  padMenu.refresh();
  return out;
}

/** The line still holding `text`: at its old index, else the nearest copy (lines above may have moved). */
function findLine(lines: string[], index: number, text: string): number {
  if (lines[index] === text) return index;
  let best = -1;
  lines.forEach((l, i) => {
    if (l === text && (best === -1 || Math.abs(i - index) < Math.abs(best - index))) best = i;
  });
  return best;
}

async function goTo(name: string, line: number) {
  if (name !== pad) await switchTo(name);
  goToLine(view, line);
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

/** Shows a pad (its own undo history and caret if it was open before), then catches up. */
function showPad(res: Loaded, leaving?: string) {
  pad = res.pad;
  dirty = false;
  conflictText = null;
  setSaveState("saved");
  loadDoc(view, res.text, leaving, res.pad);
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
  const leaving = pad;
  try {
    showPad(await invoke<Loaded>("switch_pad", { name }), leaving);
  } catch (err) {
    console.error(err);
    setStatus("pad itu nggak bisa dibuka", "accent", 3000);
  }
  await refreshPads();
}

async function createPad(name: string) {
  await flushCurrent();
  const leaving = pad;
  try {
    const res = await invoke<Loaded>("create_pad", { name });
    showPad(res, leaving);
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
    renameDocState(old, next);
    renameAges(old, next);
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
  renameDocState(name, null);
  forgetPad(name);
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

// ---------- keyboard: pads, search, focus mode, offers ----------

/**
 * Window-level shortcuts, instant and without animation:
 * Ctrl+K search · Ctrl+N new pad · Ctrl+Tab / Ctrl+Shift+Tab next/previous · Ctrl+1…9 jump ·
 * Ctrl+. focus mode · Tab right after a paste offer accepts it.
 */
function setupKeys() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (palette.isOpen() || review.isOpen()) return; // overlays own the keyboard
      if (e.key === "Tab" && tabOffer && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const run = tabOffer;
        tabOffer = null;
        run();
        return;
      }
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      const names = allTexts().map((p) => p.name);
      if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        openSearch();
      } else if (key === "." && !e.shiftKey) {
        e.preventDefault();
        toggleFocusMode();
      } else if (key === "n" && !e.shiftKey) {
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

// ---------- outside changes and conflicts ----------

async function onExternalChange(text: string) {
  if (text === view.state.doc.toString()) return;
  if (dirty || conflictText !== null) {
    // Both sides changed. Nothing is overwritten until you choose; the other version is also
    // parked next to the file, so even closing the app loses nothing.
    conflictText = text;
    let copy = "";
    try {
      copy = (await invoke<string>("save_conflict_copy", { text })).split(/[\\/]/).pop() ?? "";
    } catch (err) {
      console.error(err);
    }
    setStatus("file ini juga diubah dari luar", "accent", 0, [
      { label: "pakai versi file", run: () => resolveConflict(true) },
      { label: "pakai punya ini", run: () => resolveConflict(false) },
    ]);
    statusEl.title = copy ? `Versi lain juga disimpan di ${copy}` : "";
    return;
  }
  replaceDoc(view, text, { annotations: external.of(true) });
  scheduleReminders(); // also refreshes the dock badge (edited in Notepad while collapsed)
  padMenu.refresh();
}

function resolveConflict(useFile: boolean) {
  const theirs = conflictText;
  conflictText = null;
  statusEl.title = "";
  if (useFile && theirs !== null) {
    replaceDoc(view, theirs, { userEvent: "input.conflict" }); // undoable, and saved like any edit
  }
  void save(true);
  setStatus(useFile ? "pakai versi file" : "pakai punya ini", "quiet", 1500);
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
  if ((Number(persist.get(key)) || 0) >= boundary) return;
  const text = view.state.doc.toString();
  const next = wakeSnoozed(text.split("\n")).join("\n");
  if (next !== text) replaceDoc(view, next, { userEvent: "input.wake" });
  persist.set(key, String(Date.now()));
}

// ---------- quick capture ----------

/** Lines typed in the capture window land under "---" in the pad on screen, saved at once. */
async function onCaptured(raw: string) {
  const now = new Date();
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .map((l) => {
      const marked = normalizeMarker(l) ?? l;
      return commitWhen(marked, now) ?? marked; // "jumat" must not drift: nobody "leaves" this line
    });
  if (!lines.length) return;
  const out = await transformPad(
    pad,
    (cur) => {
      let doc = cur;
      for (const l of [...lines].reverse()) doc = insertCaptured(doc, l).lines;
      return doc;
    },
    "input.capture",
  );
  if (out !== null) setStatus(lines.length === 1 ? `masuk ke pad ${pad}` : `${lines.length} baris masuk ke pad ${pad}`, "quiet", 2500);
}

// ---------- weekly review ----------

/** Open to-dos waiting 7+ days that aren't scheduled for a day still ahead. */
function stuckTasks(now = new Date()): StuckTask[] {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const out: StuckTask[] = [];
  for (const p of allTexts()) {
    const d = padData(p.name, p.text);
    d.parsed.forEach((line, i) => {
      const key = d.keys[i];
      if (line.kind !== "todo" || !key) return;
      if (line.date && (resolveDate(line.date, now)?.getTime() ?? 0) >= startToday) return;
      const days = ageDays(p.name, key, now);
      if (days !== null && days >= STUCK_DAYS) out.push({ pad: p.name, line: i, text: d.lines[i], days });
    });
  }
  return out.sort((a, b) => b.days - a.days);
}

async function reviewAct(t: StuckTask, choice: ReviewChoice): Promise<boolean> {
  const now = new Date();
  const out = await transformPad(
    t.pad,
    (lines) => {
      const i = findLine(lines, t.line, t.text);
      if (i < 0) return null;
      if (choice === "drop") lines.splice(i, 1);
      else if (choice === "later") lines[i] = setDate(lines[i], new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7), now);
      else return moveToFocus(lines, i).lines;
      return lines;
    },
    `input.review.${choice}`,
  );
  return out !== null;
}

function openReview() {
  const list = stuckTasks();
  if (!list.length) return setStatus("nggak ada yang nyangkut", "quiet", 2000);
  review.open(list);
}

/** Once a day, if something has waited a week: an offer in the strip, never a popup. */
function offerReview() {
  const day = String(dayNumber(new Date()));
  if (persist.get(REVIEW_KEY) === day || statusEl.childNodes.length) return;
  const n = stuckTasks().length;
  if (!n) return;
  persist.set(REVIEW_KEY, day);
  setStatus(`${n} to-do nyangkut lebih dari seminggu`, "quiet", 0, { label: "review", run: openReview });
  statusClearsOnEdit = true;
}

// ---------- search ----------

function openSearch(filter?: Parameters<typeof palette.open>[0]) {
  commitActiveLine(view);
  padMenu.close(false);
  palette.open(filter);
}

async function searchToggle(item: IndexedLine): Promise<string | null> {
  return transformPad(
    item.source,
    (lines) => {
      const i = findLine(lines, item.line, item.text);
      if (i < 0) return null;
      lines[i] = toggleLine(lines[i]);
      return lines;
    },
    "input.toggle",
  );
}

// ---------- focus mode (Ctrl+.) ----------

const focusTimer = document.getElementById("focus-timer")!;
let focusStart = 0;
let focusTick: number | undefined;

function toggleFocusMode(on = !body.classList.contains("is-focus")) {
  body.classList.toggle("is-focus", on);
  setFocusMode(view, on);
  window.clearInterval(focusTick);
  focusTimer.hidden = !on;
  if (!on) return view.focus();
  focusStart = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - focusStart) / 1000);
    focusTimer.textContent = `fokus ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  focusTick = window.setInterval(tick, 1000); // only while focus mode is on
  view.focus();
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
let badgeTimer: number | undefined;

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
  persist.set(DOCK_KEY, on ? "1" : "0");
  invoke("set_dock", { on }).catch(console.error);
}

/**
 * The collapsed icon's badge: every open to-do across all pads, or, when a reminder is under
 * 15 minutes away, the minutes left ("12m"). It re-checks once a minute only while one is near.
 */
function updateDockBadge() {
  window.clearTimeout(badgeTimer);
  const badge = document.getElementById("dock-badge")!;
  const icon = document.getElementById("dock-icon")!;
  const open = allTexts().reduce((n, p) => n + padData(p.name, p.text).open, 0);
  const mins = nextReminder ? Math.ceil((nextReminder.at - Date.now()) / 60_000) : Infinity;
  const soon = mins >= 0 && mins <= SOON_MIN;
  badge.classList.toggle("is-soon", soon);
  if (soon) {
    badge.hidden = false;
    badge.textContent = `${mins}m`;
    const label = `${nextReminder!.label} · ${mins} menit lagi`;
    badge.title = label;
    icon.setAttribute("aria-label", `Buka pad, ${label}`);
  } else {
    badge.hidden = open === 0;
    badge.textContent = open > 99 ? "99+" : String(open);
    const label = `${open} to-do belum beres`;
    badge.title = label;
    icon.setAttribute("aria-label", `Buka pad, ${label}`);
  }
  // Near (or about to be): tick at the next minute. Otherwise the 5-minute check is enough.
  if (mins <= SOON_MIN + 5) badgeTimer = window.setTimeout(updateDockBadge, 60_000 - (Date.now() % 60_000) + 50);
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
    updateIdle();
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
    if (!docked || !expanded || body.classList.contains("is-dragging") || palette.isOpen() || review.isOpen()) return;
    window.clearTimeout(collapseTimer);
    collapseTimer = window.setTimeout(closeDock, COLLAPSE_DELAY_MS);
  });
  // Always sync with Rust on boot (also after a reload), so window and classes agree.
  setDock(persist.get(DOCK_KEY) === "1");
}

// ---------- idle translucency ----------

/** Unfocused, pointer elsewhere, not docked: the pad thins out so it doesn't cover your work. */
let idleFade = persist.get(IDLE_KEY) !== "0";
let pointerInside = false;
function updateIdle() {
  body.classList.toggle("is-idle", idleFade && !docked && !pointerInside && !document.hasFocus());
}

function setupIdle() {
  const root = document.documentElement;
  root.addEventListener("mouseenter", () => {
    pointerInside = true;
    updateIdle();
  });
  root.addEventListener("mouseleave", () => {
    pointerInside = false;
    updateIdle();
  });
  window.addEventListener("focus", updateIdle);
  window.addEventListener("blur", updateIdle);
}

// ---------- window ----------

function hidePad() {
  if (body.classList.contains("is-focus")) return toggleFocusMode(false); // Esc leaves focus mode first
  if (docked && expanded) return closeDock(); // Esc / × in dock mode: same animated close
  if (dirty) void save();
  invoke("hide_pad").catch(console.error);
}

/** Window chrome: hover controls, double-click strip (handled by Tauri), F11, resize edges. */
function setupWindowChrome() {
  const win = getCurrentWindow();
  const syncMax = async () => {
    const max = await win.isMaximized();
    body.classList.toggle("is-max", max);
    sidebar.setVisible(max);
  };
  document.getElementById("btn-max")!.addEventListener("click", () => void win.toggleMaximize());
  document.getElementById("btn-search")!.addEventListener("click", () => openSearch());
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
      ageOf: (key) => ageDays(pad, key),
      onCopied: () => setStatus("tersalin", "quiet", 1200),
      openUrl: (url) => void invoke("open_url", { url }).catch(console.error),
      onPastedList: (n, apply) => {
        const run = () => setStatus(apply() ? `${n} baris jadi to-do` : "udah berubah, nggak jadi", "quiet", 1500);
        setStatus(`jadiin ${n} to-do?`, "quiet", UNDO_WINDOW_MS, { label: "jadiin (Tab)", run });
        statusClearsOnEdit = true;
        tabOffer = run;
      },
    },
    onChange,
  );
  view.contentDOM.setAttribute("aria-label", `Pad ${pad}`);
  view.focus();
  padMenu = setupPadMenu({
    list: () => allTexts().map((p) => ({ name: p.name, open: padData(p.name, p.text).open })),
    current: () => pad,
    select: (name) => void switchTo(name),
    create: (name) => void createPad(name),
    rename: (old, name) => void renamePad(old, name),
    remove: (name) => void deletePad(name),
    closed: () => view.focus(),
  });
  palette = setupSearch({
    pads: () => allTexts().map((p) => ({ source: p.name, text: p.text })),
    archive: () => invoke<string>("read_archive"),
    open: (item) => {
      if (item.archive) return void invoke("open_archive").catch(console.error);
      void goTo(item.source, item.line);
    },
    toggle: searchToggle,
  });
  review = setupReview({ act: reviewAct });
  sidebar = setupSidebar({
    model: () => {
      let open = 0;
      let dated = 0;
      const tagCount = new Map<string, number>();
      const pads = allTexts().map((p) => {
        const d = padData(p.name, p.text);
        open += d.open;
        dated += d.dated;
        for (const t of d.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
        return { name: p.name, open: d.open, current: p.name === pad };
      });
      const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
      return { pads, open, dated, stuck: stuckTasks().length, tags };
    },
    select: (name) => void switchTo(name),
    search: (filter) => openSearch(filter),
    review: openReview,
  });
  setupWindowChrome();
  setupKeys();
  setupIdle();
  invoke("sync_idle_menu", { on: idleFade }).catch(console.error);
  wakeIfNewDay();
  await refreshPads();
  await setupDock();
  if (first_run) {
    setStatus(`disimpan di ${shortPath(path)}`, "quiet", 0, { label: "ganti", run: () => void chooseFolder() });
    statusClearsOnEdit = true; // stays until you start writing
  } else {
    offerReview();
  }

  await listen<{ pad: string; text: string }>("doc-changed", (e) => {
    if (e.payload.pad === pad) void onExternalChange(e.payload.text);
    else void refreshPads(); // stale event from the pad you just left
  });
  // Another pad's file changed (Notepad, phone sync, a pad added in Explorer).
  await listen("pads-changed", () => void refreshPads());
  await listen("choose-folder", () => void chooseFolder());
  await listen<string>("capture-line", (e) => void onCaptured(e.payload));
  await listen<boolean>("idle-fade", (e) => {
    idleFade = e.payload;
    persist.set(IDLE_KEY, idleFade ? "1" : "0");
    updateIdle();
  });
  await listen("pad-shown", () => {
    view.focus();
    wakeIfNewDay();
    scheduleReminders();
    offerReview();
  });
  // The pad never quits, so "jam 9" written last night must still get scheduled today.
  window.setInterval(() => {
    wakeIfNewDay();
    scheduleReminders();
  }, 5 * 60_000);
  await listen<{ pad: string; line: number }>("focus-line", (e) => void goTo(e.payload.pad || pad, e.payload.line));

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
