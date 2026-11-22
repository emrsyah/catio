// Every pad's text, parsed once per version. Reminders, the badge, ages, search and review all
// read from here instead of splitting and parsing the same text again on every save.

import { dayNumber, inlineTokens, parseLine, taskKey, updateAges, type AgeBook, type ParsedLine } from "@catio/core";

export interface PadInfo {
  name: string;
  text: string;
}

export interface PadData {
  text: string;
  lines: string[];
  parsed: ParsedLine[];
  /** open to-dos with words in them (snoozed and empty ones don't count) */
  open: number;
  /** taskKey per line (null for anything that isn't an open or snoozed to-do) */
  keys: (string | null)[];
  /** every #tag / @orang occurrence, lowercased with its sigil */
  tags: string[];
  /** open to-dos with a date or time */
  dated: number;
}

const memo = new Map<string, PadData>();

export function padData(name: string, text: string): PadData {
  const hit = memo.get(name);
  if (hit && hit.text === text) return hit;
  const lines = text.split("\n");
  const parsed = lines.map(parseLine);
  let open = 0;
  let dated = 0;
  const tags: string[] = [];
  const keys = lines.map((l, i) => {
    const p = parsed[i];
    if (p.kind === "todo" && l.slice(p.bodyFrom).trim()) {
      open++;
      if (p.date || p.time) dated++;
    }
    if (l.includes("#") || l.includes("@")) {
      for (const t of inlineTokens(l, p.bodyFrom)) {
        if (t.kind === "tag" || t.kind === "person") tags.push((t.kind === "tag" ? "#" : "@") + t.value);
      }
    }
    return taskKey(l, p);
  });
  const data = { text, lines, parsed, open, keys, tags, dated };
  memo.set(name, data);
  return data;
}

export function forgetPad(name: string) {
  memo.delete(name);
  books.delete(name);
  try {
    localStorage.removeItem(AGE_PREFIX + name);
  } catch {
    /* nothing stored */
  }
}

// ---------- ages: when each open to-do was first seen (outside the file) ----------

const AGE_PREFIX = "catio.ages.";
const books = new Map<string, AgeBook>();

function book(name: string): AgeBook {
  let b = books.get(name);
  if (b) return b;
  try {
    b = JSON.parse(localStorage.getItem(AGE_PREFIX + name) ?? "{}") as AgeBook;
  } catch {
    b = {};
  }
  books.set(name, b);
  return b;
}

/** Records new to-dos and forgets finished ones. True when anything changed. */
export function trackAges(name: string, text: string, now = new Date()): boolean {
  const old = book(name);
  const keys = padData(name, text).keys.filter((k): k is string => k !== null);
  const next = updateAges(old, keys, now);
  if (next === old) return false;
  books.set(name, next);
  try {
    localStorage.setItem(AGE_PREFIX + name, JSON.stringify(next));
  } catch {
    /* ages restart next launch: harmless */
  }
  return true;
}

export function ageDays(name: string, key: string, now = new Date()): number | null {
  const day = book(name)[key];
  return day === undefined ? null : dayNumber(now) - day;
}

/** A renamed pad keeps its ages. */
export function renameAges(old: string, next: string) {
  const b = book(old);
  forgetPad(old);
  books.set(next, b);
  try {
    localStorage.setItem(AGE_PREFIX + next, JSON.stringify(b));
  } catch {
    /* ignore */
  }
}
