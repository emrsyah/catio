// @catio/core — pure parser shared by desktop, mobile (v1) and the reminder scheduler.
// Input: plain text lines. Output: tokens. No DOM, no I/O, no dependencies.

export type LineKind = "todo" | "done" | "snooze" | "divider" | "text" | "blank";

export interface TimeToken {
  /** 0-23 when written as HH:MM; 1-12 when written as "jam N" (resolved later). */
  hour: number;
  minute: number;
  /** true for "jam N" without minutes or AM/PM context: 3 could mean 03:00 or 15:00. */
  ambiguous: boolean;
  /** "2 jam lagi" / "30 menit lagi": minutes from now. hour/minute are unused then. */
  relMinutes?: number;
  /** character offsets inside the line */
  from: number;
  to: number;
}

/**
 * A day written in the line. Relative forms ("besok", "senin", "3 hari lagi") drift as days
 * pass, so the editor rewrites them to an absolute "23 nov" once you leave the line.
 */
export interface DateToken {
  kind: "offset" | "weekday" | "abs";
  /** offset: days from today */
  days?: number;
  /** weekday: 0 = Sunday … 6 = Saturday, next occurrence after today */
  weekday?: number;
  /** abs: day of month, month 0-11 (absent for "tgl 25"), optional year */
  day?: number;
  month?: number;
  year?: number;
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
  date: DateToken | null;
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
const REL_TIME = /(?<![\p{L}\d])(?:(\d{1,3})\s*(jam|menit|mnt)|(setengah)\s+jam)\s+lagi(?![\p{L}])/iu;

const MONTHS: Record<string, number> = {
  jan: 0, januari: 0, january: 0,
  feb: 1, februari: 1, february: 1,
  mar: 2, maret: 2, march: 2,
  apr: 3, april: 3,
  mei: 4, may: 4,
  jun: 5, juni: 5, june: 5,
  jul: 6, juli: 6, july: 6,
  agu: 7, agt: 7, agustus: 7, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  okt: 9, oktober: 9, oct: 9, october: 9,
  nov: 10, november: 10,
  des: 11, desember: 11, dec: 11, december: 11,
};
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "mei", "jun", "jul", "agu", "sep", "okt", "nov", "des"];
const DAY_SHORT = ["min", "sen", "sel", "rab", "kam", "jum", "sab"];
const WEEKDAYS: Record<string, number> = { senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, "jum'at": 5, sabtu: 6, minggu: 0 };
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

type DateRule = { re: RegExp; make: (m: RegExpExecArray) => Omit<DateToken, "from" | "to"> | null };
const DATE_RULES: DateRule[] = [
  {
    // 25 nov, 25 november 2026
    re: new RegExp(`(?<![\\d\\p{L}])(\\d{1,2})\\s+(${MONTH_ALT})\\.?(?:\\s+(\\d{4}))?(?![\\p{L}\\d])`, "iu"),
    make: (m) => ({ kind: "abs", day: +m[1], month: MONTHS[m[2].toLowerCase()], year: m[3] ? +m[3] : undefined }),
  },
  {
    // 25/11/2026, 25/11/26. A bare "25/11" needs "tgl" in front (below): "1/2 kg",
    // "skor 8/10" and "24/7" are not dates.
    re: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/,
    make: (m) =>
      +m[2] >= 1 && +m[2] <= 12
        ? { kind: "abs", day: +m[1], month: +m[2] - 1, year: m[3].length === 2 ? 2000 + +m[3] : +m[3] }
        : null,
  },
  {
    // tgl 25/11, tanggal 25/11
    re: /(?<![\p{L}])(?:tgl|tanggal)\.?\s+(\d{1,2})\/(\d{1,2})(?![\d/])/iu,
    make: (m) => (+m[2] >= 1 && +m[2] <= 12 ? { kind: "abs", day: +m[1], month: +m[2] - 1 } : null),
  },
  {
    // tgl 25, tanggal 25
    re: /(?<![\p{L}])(?:tgl|tanggal)\.?\s+(\d{1,2})(?![\d/])/iu,
    make: (m) => ({ kind: "abs", day: +m[1] }),
  },
  {
    re: /(?<![\p{L}])(hari ini|hr ini|besok|bsk|lusa)(?![\p{L}])/iu,
    make: (m) => ({ kind: "offset", days: { besok: 1, bsk: 1, lusa: 2 }[m[1].toLowerCase()] ?? 0 }),
  },
  {
    re: /(?<![\p{L}\d])(\d{1,2})\s+hari\s+lagi(?![\p{L}])/iu,
    make: (m) => ({ kind: "offset", days: +m[1] }),
  },
  {
    re: /(?<![\p{L}])minggu\s+depan(?![\p{L}])/iu,
    make: () => ({ kind: "offset", days: 7 }),
  },
  {
    // senin … sabtu, "hari minggu" (bare "minggu" also means "week"), optional "depan"
    re: /(?<![\p{L}])(?:hari\s+)?(senin|selasa|rabu|kamis|jum'?at|sabtu|(?<=hari\s+)minggu)(?:\s+depan)?(?![\p{L}'])/iu,
    make: (m) => ({ kind: "weekday", weekday: WEEKDAYS[m[1].toLowerCase()] }),
  },
];

/** The earliest date written in the body, if any. */
export function findDate(text: string, start = 0): DateToken | null {
  const body = text.slice(start);
  let best: DateToken | null = null;
  for (const rule of DATE_RULES) {
    const m = rule.re.exec(body);
    if (!m) continue;
    const t = rule.make(m);
    if (!t) continue;
    const from = start + m.index;
    if (!best || from < best.from) best = { ...t, from, to: from + m[0].length };
  }
  return best;
}

export function parseLine(text: string): ParsedLine {
  if (text.trim() === "") {
    return { kind: "blank", indent: 0, markerFrom: -1, bodyFrom: 0, time: null, date: null };
  }
  if (DIVIDER.test(text)) {
    return { kind: "divider", indent: 0, markerFrom: -1, bodyFrom: 0, time: null, date: null };
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
  // Dates only count on task lines: in a note, "kalau besok hujan" is just a sentence.
  const date = markerFrom >= 0 ? findDate(text, bodyFrom) : null;
  let time = findTime(text, bodyFrom);
  // A token can't be both (e.g. digits inside "25 nov 2026").
  if (time && date && time.from < date.to && date.from < time.to) time = null;
  return { kind, indent, markerFrom, bodyFrom, time, date };
}

export function findTime(text: string, start = 0): TimeToken | null {
  const body = text.slice(start);
  const rel = REL_TIME.exec(body);
  if (rel) {
    const minutes = rel[3] ? 30 : /^j/i.test(rel[2]) ? +rel[1] * 60 : +rel[1];
    if (minutes > 0) {
      return {
        hour: 0,
        minute: 0,
        ambiguous: false,
        relMinutes: minutes,
        from: start + rel.index,
        to: start + rel.index + rel[0].length,
      };
    }
  }
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

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const DAY_MS = 86_400_000;

/** The calendar day a date token points at (local midnight), or null when invalid. */
export function resolveDate(t: DateToken, now: Date): Date | null {
  const today = startOfDay(now);
  if (t.kind === "offset") return new Date(today.getFullYear(), today.getMonth(), today.getDate() + (t.days ?? 0));
  if (t.kind === "weekday") {
    const diff = ((t.weekday ?? 0) - today.getDay() + 7) % 7 || 7;
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() + diff);
  }
  const day = t.day ?? 1;
  const make = (y: number, m: number) => {
    const d = new Date(y, m, day);
    return d.getDate() === day ? d : null; // 31/2 is not a day
  };
  if (t.month === undefined) {
    // "tgl 25": this month, or next month once it has passed.
    const d = make(today.getFullYear(), today.getMonth());
    if (d && d >= today) return d;
    return make(today.getFullYear(), today.getMonth() + 1);
  }
  if (t.year !== undefined) return make(t.year, t.month);
  // No year: this year, unless it passed more than a month ago (then it's next year's).
  const d = make(today.getFullYear(), t.month);
  if (d && d.getTime() < today.getTime() - 31 * DAY_MS) return make(today.getFullYear() + 1, t.month);
  return d;
}

/** Hour for an ambiguous "jam N" on a future day: office-hours bias, 7-11 morning, 12-6 afternoon. */
const biasHour = (h: number) => (h >= 7 && h <= 11 ? h : h === 12 ? 12 : (h % 12) + 12);

/** The moment a line's date and/or time point at, or null when there is none or it has passed. */
export function resolveWhen(p: Pick<ParsedLine, "date" | "time">, now: Date): Date | null {
  if (p.time?.relMinutes) {
    const d = new Date(now.getTime() + p.time.relMinutes * 60_000);
    d.setSeconds(0, 0);
    return d;
  }
  if (!p.date) return p.time ? resolveTime(p.time, now) : null;
  const day = resolveDate(p.date, now);
  if (!day) return null;
  if (p.time && day.getTime() === startOfDay(now).getTime()) return resolveTime(p.time, now);
  const d = new Date(day);
  // A day without a time reminds you at 09:00 that morning.
  if (!p.time) d.setHours(9, 0, 0, 0);
  else d.setHours(p.time.ambiguous ? biasHour(p.time.hour) : p.time.hour, p.time.minute, 0, 0);
  return d.getTime() > now.getTime() ? d : null;
}

/** Open to-dos with a future date or time. Done and snoozed lines never fire. */
export function collectReminders(lines: readonly string[], now: Date, parsed?: readonly ParsedLine[]): Reminder[] {
  const out: Reminder[] = [];
  lines.forEach((text, i) => {
    const p = parsed?.[i] ?? parseLine(text);
    if (p.kind !== "todo" || (!p.time && !p.date)) return;
    const d = resolveWhen(p, now);
    if (!d) return;
    out.push({ line: i, label: stripWhen(text, p) || text.trim(), at: d.getTime() });
  });
  return out;
}

/** The line's words without its marker, date and time. */
export function stripWhen(text: string, p: ParsedLine): string {
  const cuts = [p.date, p.time].filter((t): t is DateToken | TimeToken => !!t).sort((a, b) => b.from - a.from);
  let body = text;
  for (const c of cuts) body = body.slice(0, c.from) + body.slice(c.to);
  return body.slice(p.bodyFrom).replace(/\s+/g, " ").trim();
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** "23 nov", plus the year when it isn't this year. */
export function formatDay(d: Date, now: Date): string {
  const s = `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

/**
 * Right-gutter label: "15:00", "besok 15:00", "kam jam 3", "25 nov". `overdue` when an open
 * to-do's day has passed. Null when the line has no date or time.
 */
export function describeWhen(text: string, p: ParsedLine, now: Date): { label: string; overdue: boolean } | null {
  if (!p.date && !p.time) return null;
  if (p.time?.relMinutes) {
    const at = resolveWhen(p, now)!;
    const t = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
    return { label: startOfDay(at).getTime() === startOfDay(now).getTime() ? t : `besok ${t}`, overdue: false };
  }
  const time = p.time ? text.slice(p.time.from, p.time.to) : "";
  if (!p.date) return { label: time, overdue: false };
  const day = resolveDate(p.date, now);
  if (!day) return { label: text.slice(p.date.from, p.date.to), overdue: false };
  const diff = Math.round((day.getTime() - startOfDay(now).getTime()) / DAY_MS);
  const dayLabel =
    diff === 0 ? "hari ini" : diff === 1 ? "besok" : diff === -1 ? "kemarin" : diff > 1 && diff < 7 ? DAY_SHORT[day.getDay()] : formatDay(day, now);
  const label = time ? (diff === 0 ? time : `${dayLabel} ${time}`) : dayLabel;
  return { label, overdue: diff < 0 };
}

// ---------- inline tokens: #tag, @orang, links, long numbers ----------

export type InlineKind = "url" | "tag" | "person" | "number";
export interface InlineToken {
  kind: InlineKind;
  from: number;
  to: number;
  /** tag/person without the sigil, the url, or the number's digits */
  value: string;
}

// Links first: a "#" or "@" inside a URL is part of the URL. Trailing punctuation stays text.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]*[^\s<>"'`.,;:!?)\]]/giu;
// "#kerja" but not "a#b", "C#", "&#39;" or an anchor inside a URL (URLs are claimed first).
const TAG_RE = /(?<![\p{L}\d_&#/])#([\p{L}][\p{L}\d_-]*)/gu;
// "@dina" but not "dina@mail.com": a letter or digit right before "@" means an email.
const PERSON_RE = /(?<![\p{L}\d_.@/])@([\p{L}][\p{L}\d_]*(?:[.-][\p{L}\d_]+)*)/gu;
// Account and phone numbers: digits with spaces, dots or dashes, 8+ digits in total.
const NUMBER_RE = /(?<![\p{L}\d:/.,-])\+?\d(?:[ .-]?\d){7,}(?![\p{L}\d:/])/gu;

/** Links, tags, people and long numbers in `text`, sorted, never overlapping. */
export function inlineTokens(text: string, start = 0): InlineToken[] {
  const out: InlineToken[] = [];
  const free = (from: number, to: number) => out.every((t) => to <= t.from || from >= t.to);
  const scan = (re: RegExp, kind: InlineKind, value: (m: RegExpExecArray) => string) => {
    re.lastIndex = start;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const from = m.index;
      const to = from + m[0].length;
      if (free(from, to)) out.push({ kind, from, to, value: value(m) });
    }
  };
  // Cheap guards: most lines have none of these characters.
  if (text.includes("http") || text.includes("www.")) scan(URL_RE, "url", (m) => m[0]);
  if (text.includes("#")) scan(TAG_RE, "tag", (m) => m[1].toLowerCase());
  if (text.includes("@")) scan(PERSON_RE, "person", (m) => m[1].toLowerCase());
  if (/\d{2}/.test(text)) scan(NUMBER_RE, "number", (m) => m[0].replace(/[^\d+]/g, ""));
  return out.sort((a, b) => a.from - b.from);
}

/** An address the opener may launch: http(s) only, "www." gets https. */
export function linkHref(url: string): string | null {
  const href = /^www\./i.test(url) ? `https://${url}` : url;
  return /^https?:\/\/[^\s]+$/i.test(href) ? href : null;
}

// ---------- pasting a list ----------

const BULLET = /^(\s*)(?:[-*•·–]|\d{1,2}[.)])\s+(?=\S)/;

/**
 * A pasted list (2+ bullet lines, e.g. from WhatsApp) as to-dos, or null when it isn't one.
 * Never applied silently: the pad offers it after pasting the text as it was.
 */
export function listToTodos(text: string): string[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const filled = lines.filter((l) => l.trim() !== "");
  if (filled.length < 2) return null;
  let bullets = 0;
  for (const l of filled) {
    if (BULLET.test(l)) bullets++;
    else if (!MARKER.test(l)) return null;
  }
  if (bullets < 2) return null;
  return lines.map((l) => {
    const m = BULLET.exec(l);
    return m ? `${m[1]}[ ] ${l.slice(m[0].length)}` : l;
  });
}

// ---------- line edits used by capture and review ----------

/** Where a captured line lands: right under "---" (top of the rest), or at the end. */
export function insertCaptured(lines: readonly string[], line: string): { lines: string[]; index: number } {
  const out = [...lines];
  const divider = out.findIndex((l) => DIVIDER.test(l));
  if (divider >= 0) {
    out.splice(divider + 1, 0, line);
    return { lines: out, index: divider + 1 };
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  out.push(line);
  return { lines: out, index: out.length - 1 };
}

/**
 * Text sent to a pad from outside the editor (quick capture, an agent): one entry per
 * non-blank line, "[]" fixed, and drifting words ("jumat", "2 jam lagi") locked to a date,
 * since nobody "leaves" these lines for the editor to do it.
 */
export function prepareCapture(raw: string, now: Date): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .map((l) => {
      const marked = normalizeMarker(l) ?? l;
      return commitWhen(marked, now) ?? marked;
    });
}

/** Several captured lines under "---", in the order given. */
export function insertAllCaptured(lines: readonly string[], captured: readonly string[]): string[] {
  let out = [...lines];
  for (const l of [...captured].reverse()) out = insertCaptured(out, l).lines;
  return out;
}

/** The line still holding `text`: at its old index, else the nearest copy (lines above may have moved). */
export function findLine(lines: readonly string[], index: number, text: string): number {
  if (lines[index] === text) return index;
  let best = -1;
  lines.forEach((l, i) => {
    if (l === text && (best === -1 || Math.abs(i - index) < Math.abs(best - index))) best = i;
  });
  return best;
}

/** Marks a to-do done ([x]) or open ([ ]); snoozed counts as open. Null for lines that aren't to-dos. */
export function setDone(text: string, done: boolean): string | null {
  const p = parseLine(text);
  if (p.kind !== "todo" && p.kind !== "done" && p.kind !== "snooze") return null;
  return `${text.slice(0, p.indent)}[${done ? "x" : " "}] ${text.slice(p.bodyFrom)}`;
}

/** Moves a line to the end of the focus zone (just above "---"), or to the top without one. */
export function moveToFocus(lines: readonly string[], index: number): { lines: string[]; index: number } {
  const out = [...lines];
  const [line] = out.splice(index, 1);
  const divider = out.findIndex((l) => DIVIDER.test(l));
  const at = divider >= 0 ? divider : 0;
  out.splice(at, 0, line);
  return { lines: out, index: at };
}

/** Sets the line's day to `day` ("29 nov"), replacing a date already written. */
export function setDate(text: string, day: Date, now: Date): string {
  const p = parseLine(text);
  const label = formatDay(day, now);
  if (p.date) return text.slice(0, p.date.from) + label + text.slice(p.date.to);
  return `${text.trimEnd()} ${label}`;
}

// ---------- task age (kept outside the file) ----------

/** Days counted from the 04:00 boundary, so a to-do written at 01:00 belongs to "yesterday". */
export function dayNumber(now: Date): number {
  const d = lastDayStart(now);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/**
 * Identity of an open or snoozed to-do across edits that don't change its words: the body
 * without marker, date and time, lowercased. "besok" → "23 nov" keeps the same key.
 */
export function taskKey(text: string, p: ParsedLine = parseLine(text)): string | null {
  if (p.kind !== "todo" && p.kind !== "snooze") return null;
  const key = stripWhen(text, p).toLowerCase();
  return key || null;
}

/** first-seen day per task key */
export type AgeBook = Record<string, number>;

/**
 * Records the day each open to-do was first seen and forgets the ones that are gone.
 * Returns the same object when nothing changed (cheap equality for callers).
 */
export function updateAges(book: AgeBook, keys: Iterable<string>, now: Date): AgeBook {
  const today = dayNumber(now);
  const next: AgeBook = {};
  let changed = false;
  let count = 0;
  for (const k of keys) {
    if (k in next) continue;
    next[k] = book[k] ?? today;
    if (!(k in book)) changed = true;
    count++;
  }
  if (!changed && count === Object.keys(book).length) return book;
  return next;
}

/** "2 hari", "3 mgg": shown from two days on; younger to-dos stay quiet. */
export function ageLabel(days: number): string | null {
  if (days < 2) return null;
  if (days < 14) return `${days} hari`;
  return `${Math.floor(days / 7)} mgg`;
}

// ---------- search ----------

export interface SearchSource {
  /** pad name, or "arsip" */
  source: string;
  text: string;
  archive?: boolean;
}

export interface IndexedLine {
  source: string;
  archive: boolean;
  line: number;
  text: string;
  lower: string;
  kind: LineKind;
  dated: boolean;
  tags: string[];
}

export type SearchFilter = { kind: "all" } | { kind: "open" } | { kind: "dated" } | { kind: "tag"; tag: string };

export interface SearchHit {
  item: IndexedLine;
  /** match ranges inside item.text */
  ranges: [number, number][];
  score: number;
}

/** Parses every line once; search then only scans lowercase strings. */
export function buildIndex(sources: readonly SearchSource[]): IndexedLine[] {
  const out: IndexedLine[] = [];
  for (const s of sources) {
    const lines = s.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (text.trim() === "" || text.startsWith("## ") || DIVIDER.test(text)) continue;
      const p = parseLine(text);
      const tags = text.includes("#") || text.includes("@")
        ? inlineTokens(text, p.bodyFrom).filter((t) => t.kind === "tag" || t.kind === "person").map((t) => (t.kind === "tag" ? "#" : "@") + t.value)
        : [];
      out.push({
        source: s.source,
        archive: !!s.archive,
        line: i,
        text,
        lower: text.toLowerCase(),
        kind: p.kind,
        dated: !!(p.date || p.time),
        tags,
      });
    }
  }
  return out;
}

/** Every #tag and @orang in the index, most used first. */
export function topTags(index: readonly IndexedLine[], limit = 6): string[] {
  const n = new Map<string, number>();
  for (const it of index) for (const t of it.tags) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([t]) => t);
}

/**
 * All query words must appear in the line (any order). Open to-dos rank first, then notes,
 * then finished and archived lines; word-start matches and the whole phrase rank higher.
 */
export function search(index: readonly IndexedLine[], query: string, filter: SearchFilter = { kind: "all" }, limit = 40): SearchHit[] {
  const q = query.trim().toLowerCase();
  const words = q ? [...new Set(q.split(/\s+/))] : [];
  const hits: SearchHit[] = [];
  for (const item of index) {
    if (filter.kind === "open" && item.kind !== "todo") continue;
    if (filter.kind === "dated" && !(item.dated && item.kind === "todo")) continue;
    if (filter.kind === "tag" && !item.tags.includes(filter.tag)) continue;
    let score = item.archive ? -4 : item.kind === "todo" ? 6 : item.kind === "text" ? 3 : item.kind === "snooze" ? 2 : 0;
    const ranges: [number, number][] = [];
    let ok = true;
    for (const w of words) {
      let at = item.lower.indexOf(w);
      if (at < 0) {
        ok = false;
        break;
      }
      while (at >= 0) {
        ranges.push([at, at + w.length]);
        if (at === 0 || !/[\p{L}\d]/u.test(item.lower[at - 1])) score += 2;
        at = item.lower.indexOf(w, at + w.length);
      }
    }
    if (!ok) continue;
    if (words.length > 1 && item.lower.includes(q)) score += 3;
    ranges.sort((a, b) => a[0] - b[0]);
    hits.push({ item, ranges: mergeRanges(ranges), score });
  }
  // Stable: equal scores keep pad order and line order.
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function mergeRanges(r: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

/**
 * Rewrites drifting words to absolute ones, so the file still means the same thing tomorrow:
 * "besok" → "23 nov", "senin" → "24 nov", "2 jam lagi" → "17:45". To-do lines only.
 * Returns the new text, or null when nothing changes.
 */
export function commitWhen(text: string, now: Date): string | null {
  const p = parseLine(text);
  if (p.kind !== "todo") return null;
  const edits: { from: number; to: number; insert: string }[] = [];
  // "tgl 25" drifts too (it rolls to next month once passed), so it gets locked as well.
  if (p.date && (p.date.kind !== "abs" || p.date.month === undefined)) {
    const d = resolveDate(p.date, now);
    if (d) edits.push({ from: p.date.from, to: p.date.to, insert: formatDay(d, now) });
  }
  if (p.time?.relMinutes) {
    const at = resolveWhen(p, now)!;
    const t = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
    const sameDay = startOfDay(at).getTime() === startOfDay(now).getTime();
    edits.push({ from: p.time.from, to: p.time.to, insert: sameDay || p.date ? t : `${formatDay(at, now)} ${t}` });
  }
  if (!edits.length) return null;
  edits.sort((a, b) => b.from - a.from);
  let out = text;
  for (const e of edits) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}
