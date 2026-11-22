// @catio/core — pure parser shared by desktop, mobile (v1) and the reminder scheduler.
// Input: plain text lines. Output: tokens. No DOM, no I/O, no dependencies.

export type LineKind = "todo" | "done" | "snooze" | "divider" | "text" | "blank";

export interface TimeToken {
  /** 0-23 when written as HH:MM; 1-12 when written as "jam N" (resolved later). */
  hour: number;
  minute: number;
  /** true for "jam N" without minutes or AM/PM context: 3 could mean 03:00 or 15:00. */
  ambiguous: boolean;
  /** character offsets inside the line */
  from: number;
  to: number;
}

export interface ParsedLine {
  kind: LineKind;
  indent: number;
  /** offset where the marker "[ ]" starts, -1 when there is none */
  markerFrom: number;
  /** offset right after the marker and its trailing space */
  bodyFrom: number;
  time: TimeToken | null;
}

export interface ParsedDoc {
  lines: ParsedLine[];
  /** index of the first "---" line, -1 when absent (then nothing is focus) */
  dividerIndex: number;
  /** first open to-do above the divider: gets the orange "now" bar */
  nowIndex: number;
}

const MARKER = /^(\s*)\[( |x|X|>)\](?: |$)/;
const DIVIDER = /^\s*---\s*$/;
const CLOCK = /(?<![\d:])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d:])/;
const JAM = /\bjam\s+(\d{1,2})(?:[:.]([0-5]\d))?\b/i;

export function parseLine(text: string): ParsedLine {
  if (text.trim() === "") {
    return { kind: "blank", indent: 0, markerFrom: -1, bodyFrom: 0, time: null };
  }
  if (DIVIDER.test(text)) {
    return { kind: "divider", indent: 0, markerFrom: -1, bodyFrom: 0, time: null };
  }
  const indent = text.length - text.trimStart().length;
  const m = MARKER.exec(text);
  let kind: LineKind = "text";
  let markerFrom = -1;
  let bodyFrom = indent;
  if (m) {
    const c = m[2];
    kind = c === " " ? "todo" : c === ">" ? "snooze" : "done";
    markerFrom = m[1].length;
    bodyFrom = m[0].length;
  }
  return { kind, indent, markerFrom, bodyFrom, time: findTime(text, bodyFrom) };
}

export function findTime(text: string, start = 0): TimeToken | null {
  const body = text.slice(start);
  const jam = JAM.exec(body);
  if (jam) {
    const h = Number(jam[1]);
    if (h <= 23) {
      const minute = jam[2] ? Number(jam[2]) : 0;
      return {
        hour: h,
        minute,
        ambiguous: h >= 1 && h <= 12,
        from: start + jam.index,
        to: start + jam.index + jam[0].length,
      };
    }
  }
  const clock = CLOCK.exec(body);
  if (clock) {
    return {
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      ambiguous: false,
      from: start + clock.index,
      to: start + clock.index + clock[0].length,
    };
  }
  return null;
}

export function parseDoc(lines: readonly string[]): ParsedDoc {
  const parsed = lines.map(parseLine);
  const dividerIndex = parsed.findIndex((l) => l.kind === "divider");
  let nowIndex = -1;
  if (dividerIndex > 0) {
    nowIndex = parsed.slice(0, dividerIndex).findIndex((l) => l.kind === "todo");
  }
  return { lines: parsed, dividerIndex, nowIndex };
}

/** "[]" typed at the start of a line becomes "[ ] ". Returns null when nothing changes. */
export function normalizeMarker(text: string): string | null {
  const m = /^(\s*)\[\](\s?)/.exec(text);
  if (!m) return null;
  return `${m[1]}[ ] ${text.slice(m[0].length)}`;
}

/** Ctrl+Enter: text → [ ], [ ] → [x], [x] → [ ], [>] → [ ]. */
export function toggleLine(text: string): string {
  const p = parseLine(text);
  if (p.kind === "blank" || p.kind === "divider") return text;
  const head = text.slice(0, p.indent);
  const body = text.slice(p.bodyFrom);
  if (p.kind === "text") return `${head}[ ] ${body}`;
  if (p.kind === "todo") return `${head}[x] ${body}`;
  return `${head}[ ] ${body}`;
}

/** "nanti": [ ] → [>] (until tomorrow), [>] → [ ]. Other lines unchanged. */
export function toggleSnooze(text: string): string {
  const p = parseLine(text);
  const head = text.slice(0, p.indent);
  const body = text.slice(p.bodyFrom);
  if (p.kind === "todo") return `${head}[>] ${body}`;
  if (p.kind === "snooze") return `${head}[ ] ${body}`;
  return text;
}

/** The 04:00 reset: every snoozed line comes back as an open to-do. */
export function wakeSnoozed(lines: readonly string[]): string[] {
  return lines.map((l) => (parseLine(l).kind === "snooze" ? toggleSnooze(l) : l));
}

/** Most recent 04:00 at or before `now`: the day boundary for snoozes. */
export function lastDayStart(now: Date): Date {
  const d = new Date(now);
  d.setHours(4, 0, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

/** Focus zone summary used for the "fokus beres" state. */
export function focusDone(doc: ParsedDoc): boolean {
  if (doc.dividerIndex <= 0) return false;
  const focus = doc.lines.slice(0, doc.dividerIndex);
  const tasks = focus.filter((l) => l.kind === "todo" || l.kind === "done" || l.kind === "snooze");
  return tasks.length > 0 && !tasks.some((l) => l.kind === "todo");
}

export interface Reminder {
  line: number;
  label: string;
  /** epoch milliseconds */
  at: number;
}

/**
 * Next moment a time token points at, relative to `now`.
 * "jam 3" at 10:00 means 15:00; at 16:00 it means 03:00 tomorrow... which nobody wants,
 * so ambiguous tokens that already passed in both readings return null.
 */
export function resolveTime(t: TimeToken, now: Date): Date | null {
  const at = (h: number) => {
    const d = new Date(now);
    d.setHours(h, t.minute, 0, 0);
    return d;
  };
  if (!t.ambiguous) {
    const d = at(t.hour);
    return d.getTime() > now.getTime() ? d : null;
  }
  const morning = at(t.hour % 12);
  const afternoon = at((t.hour % 12) + 12);
  // Office hours bias: "jam 3" is 15:00, "jam 9" is 09:00 if it is still ahead.
  if (t.hour >= 7 && morning.getTime() > now.getTime()) return morning;
  if (afternoon.getTime() > now.getTime()) return afternoon;
  return null;
}

/** Open to-dos with a time later today. Done and snoozed lines never fire. */
export function collectReminders(lines: readonly string[], now: Date): Reminder[] {
  const out: Reminder[] = [];
  lines.forEach((text, i) => {
    const p = parseLine(text);
    if (p.kind !== "todo" || !p.time) return;
    const d = resolveTime(p.time, now);
    if (!d) return;
    const label = (text.slice(p.bodyFrom, p.time.from) + text.slice(p.time.to))
      .replace(/\s+/g, " ")
      .trim();
    out.push({ line: i, label: label || text.trim(), at: d.getTime() });
  });
  return out;
}
