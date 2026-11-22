import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectReminders,
  focusDone,
  lastDayStart,
  toggleSnooze,
  wakeSnoozed,
  normalizeMarker,
  parseDoc,
  parseLine,
  resolveTime,
  toggleLine,
} from "../src/index.ts";

test("markers", () => {
  assert.equal(parseLine("[ ] beli kabel").kind, "todo");
  assert.equal(parseLine("[x] transfer DP").kind, "done");
  assert.equal(parseLine("[>] cek ongkir").kind, "snooze");
  assert.equal(parseLine("pricing 49rb").kind, "text");
  assert.equal(parseLine("---").kind, "divider");
  assert.equal(parseLine("   ").kind, "blank");
  assert.equal(parseLine("\t[ ] nested").indent, 1);
  assert.equal(parseLine("[ ]").kind, "todo");
  assert.equal(parseLine("[ ]tanpa spasi").kind, "text");
});

test("focus zone and now line", () => {
  const doc = parseDoc(["[x] done", "[ ] kelarin proposal", "[ ] call 15:00", "---", "[ ] later"]);
  assert.equal(doc.dividerIndex, 3);
  assert.equal(doc.nowIndex, 1);
  assert.equal(parseDoc(["[ ] a", "[ ] b"]).nowIndex, -1, "no divider means no focus");
});

test("time tokens", () => {
  assert.deepEqual(
    pick(parseLine("[ ] call dokter 15:00").time),
    { hour: 15, minute: 0, ambiguous: false },
  );
  assert.equal(parseLine("[ ] meeting jam 3").time?.ambiguous, true);
  assert.equal(parseLine("rek BCA 123 456 7890").time, null);
  assert.equal(parseLine("versi 1:30:00").time, null);
  assert.equal(parseLine("budget 40jt").time, null);
});

test("normalize [] and toggle", () => {
  assert.equal(normalizeMarker("[]beli"), "[ ] beli");
  assert.equal(normalizeMarker("  [] beli"), "  [ ] beli");
  assert.equal(normalizeMarker("[ ] beli"), null);
  assert.equal(toggleLine("beli"), "[ ] beli");
  assert.equal(toggleLine("[ ] beli"), "[x] beli");
  assert.equal(toggleLine("[x] beli"), "[ ] beli");
  assert.equal(toggleLine("[>] beli"), "[ ] beli");
  assert.equal(toggleLine("---"), "---");
});

test("resolveTime picks the next sensible moment", () => {
  const ten = new Date(2026, 10, 21, 10, 0);
  const t = (line: string) => parseLine(line).time!;
  assert.equal(resolveTime(t("jam 3"), ten)?.getHours(), 15);
  assert.equal(resolveTime(t("jam 11"), ten)?.getHours(), 11);
  assert.equal(resolveTime(t("09:00"), ten), null);
  assert.equal(resolveTime(t("23:30"), ten)?.getHours(), 23);
});

test("reminders only for open to-dos", () => {
  const now = new Date(2026, 10, 21, 10, 0);
  const r = collectReminders(["[ ] call dokter 15:00", "[x] done 16:00", "[>] snooze 17:00", "note 18:00"], now);
  assert.equal(r.length, 1);
  assert.equal(r[0].label, "call dokter");
  assert.equal(new Date(r[0].at).getHours(), 15);
});

test("snooze, wake at 04:00, focus done", () => {
  assert.equal(toggleSnooze("[ ] cek ongkir"), "[>] cek ongkir");
  assert.equal(toggleSnooze("[>] cek ongkir"), "[ ] cek ongkir");
  assert.equal(toggleSnooze("[x] done"), "[x] done");
  assert.deepEqual(wakeSnoozed(["[>] a", "[x] b", "c"]), ["[ ] a", "[x] b", "c"]);
  assert.equal(lastDayStart(new Date(2026, 10, 22, 3, 0)).getDate(), 21);
  assert.equal(lastDayStart(new Date(2026, 10, 22, 9, 0)).getDate(), 22);
  assert.equal(focusDone(parseDoc(["[x] a", "[>] b", "---", "[ ] c"])), true);
  assert.equal(focusDone(parseDoc(["[x] a", "[ ] b", "---"])), false);
  assert.equal(focusDone(parseDoc(["catatan", "---"])), false);
});

function pick(t: { hour: number; minute: number; ambiguous: boolean } | null) {
  return t && { hour: t.hour, minute: t.minute, ambiguous: t.ambiguous };
}
