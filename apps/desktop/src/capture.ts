// Quick capture (Alt+Shift+Space): one field over whatever you're doing. While you type it
// shows how the pad will read the line ("To-do · Jum 27 Nov · ingatkan 09:00 · @dina").
// Enter sends it to the pad and gives focus back; Esc closes. Loads only @catio/core.

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./tokens.css";
import "./capture.css";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatDay, inlineTokens, normalizeMarker, parseLine, resolveWhen } from "@catio/core";

const form = document.getElementById("capture") as HTMLFormElement;
const field = document.getElementById("field") as HTMLTextAreaElement;
const read = document.getElementById("read")!;
const target = document.getElementById("target")!;

function chip(text: string, cls = "") {
  const s = document.createElement("span");
  s.className = `capture-chip ${cls}`;
  s.textContent = text;
  return s;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** How the pad will understand the line under the caret. */
function preview() {
  const text = field.value;
  const start = text.lastIndexOf("\n", field.selectionStart - 1) + 1;
  const end = text.indexOf("\n", field.selectionStart);
  const raw = text.slice(start, end === -1 ? undefined : end);
  if (!raw.trim()) {
    read.replaceChildren(chip("[] di depan = to-do · jam & tanggal jadi pengingat", "is-hint"));
    return;
  }
  const line = normalizeMarker(raw) ?? raw;
  const p = parseLine(line);
  const now = new Date();
  const parts = [chip(p.markerFrom >= 0 ? "To-do" : "Catatan")];
  const at = p.kind === "todo" ? resolveWhen(p, now) : null;
  if (at) {
    const day = at.toLocaleDateString("id-ID", { weekday: "short" }).replace(".", "");
    parts.push(chip(`${day} ${formatDay(at, now)} · ingatkan ${pad2(at.getHours())}:${pad2(at.getMinutes())}`, "is-when"));
  } else if (p.date || p.time) {
    parts.push(chip("jamnya udah lewat", "is-muted"));
  }
  for (const t of inlineTokens(line, p.bodyFrom)) {
    if (t.kind === "tag" || t.kind === "person") parts.push(chip((t.kind === "tag" ? "#" : "@") + t.value));
  }
  read.replaceChildren(chip("Kebaca sebagai", "is-label"), ...parts);
}

/** One to three rows, then it scrolls. */
function fit() {
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 3 * 24 + 4)}px`;
}

function submit() {
  const text = field.value.trim();
  if (!text) return void invoke("capture_close");
  void invoke("capture_submit", { text });
  field.value = "";
  fit();
  preview();
}

field.addEventListener("input", () => {
  fit();
  preview();
});
field.addEventListener("keyup", preview);
field.addEventListener("click", preview);
field.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    void invoke("capture_close");
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});

function setTarget(pad: string) {
  const today = new Date().toLocaleDateString("id-ID", { weekday: "short", day: "numeric", month: "short" }).replace(/\./g, "");
  target.textContent = `Masuk ke pad ${pad} · ${today}`;
}

// Focus the field whenever the window comes up (first show, and every hotkey after).
window.addEventListener("focus", () => field.focus());
void listen<string>("capture-open", (e) => {
  setTarget(e.payload);
  field.focus();
});
invoke<string>("capture_target").then(setTarget, console.error);
preview();
field.focus();
