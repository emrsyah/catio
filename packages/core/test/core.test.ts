import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectReminders,
  commitWhen,
  describeWhen,
  resolveDate,
  resolveWhen,
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

test("dates: relative, weekday, absolute", () => {
  const sun = new Date(2026, 10, 22, 10, 0); // Sunday 22 Nov 2026, 10:00
  const day = (line: string) => {
    const d = parseLine(line).date;
    const r = d && resolveDate(d, sun);
    return r && `${r.getDate()}/${r.getMonth() + 1}/${r.getFullYear()}`;
  };
  assert.equal(day("[ ] bayar besok"), "23/11/2026");
  assert.equal(day("[ ] bayar bsk"), "23/11/2026");
  assert.equal(day("[ ] bayar lusa"), "24/11/2026");
  assert.equal(day("[ ] call senin"), "23/11/2026");
  assert.equal(day("[ ] call jumat"), "27/11/2026");
  assert.equal(day("[ ] call hari minggu"), "29/11/2026");
  assert.equal(parseLine("[ ] review 2 minggu").date, null, "bare minggu means week");
  assert.equal(day("[ ] review minggu depan"), "29/11/2026");
  assert.equal(day("[ ] kirim 3 hari lagi"), "25/11/2026");
  assert.equal(day("[ ] invoice 25 nov"), "25/11/2026");
  assert.equal(day("[ ] invoice 5 januari"), "5/1/2027", "January already passed → next year");
  assert.equal(day("[ ] invoice 20 nov"), "20/11/2026", "recent past stays (overdue)");
  assert.equal(day("[ ] invoice tgl 25/12"), "25/12/2026");
  assert.equal(day("[ ] invoice 25/12/2026"), "25/12/2026");
  assert.equal(parseLine("[ ] beli 1/2 kg").date, null, "fractions aren't dates");
  assert.equal(parseLine("[ ] skor 8/10").date, null);
  assert.equal(parseLine("[ ] support 24/7").date, null);
  assert.equal(parseLine("kalau besok hujan batal").date, null, "notes keep their words");
  assert.equal(day("[ ] invoice tgl 5"), "5/12/2026", "day passed this month → next month");
  assert.equal(parseLine("[ ] seninnya").date, null);
  assert.equal(parseLine("[ ] versi 1/2/3/4").date, null);
});

test("resolveWhen combines day and time", () => {
  const sun = new Date(2026, 10, 22, 10, 0);
  const at = (line: string) => {
    const d = resolveWhen(parseLine(line), sun);
    return d && `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  assert.equal(at("[ ] call besok 15:00"), "23 15:00");
  assert.equal(at("[ ] call besok jam 3"), "23 15:00");
  assert.equal(at("[ ] call besok jam 9"), "23 9:00");
  assert.equal(at("[ ] call besok"), "23 9:00", "day only → 09:00");
  assert.equal(at("[ ] call 2 jam lagi"), "22 12:00");
  assert.equal(at("[ ] call 30 menit lagi"), "22 10:30");
  assert.equal(at("[ ] call setengah jam lagi"), "22 10:30");
  assert.equal(at("[ ] call hari ini"), null, "09:00 already passed at 10:00");
  // The day itself: a day-only reminder still fires at 09:00 if that's ahead.
  const early = new Date(2026, 10, 23, 8, 0);
  const d = resolveWhen(parseLine("[ ] bayar 23 nov"), early);
  assert.equal(d && `${d.getDate()} ${d.getHours()}`, "23 9");
  assert.equal(resolveWhen(parseLine("[ ] bayar 23 nov"), new Date(2026, 10, 23, 10, 0)), null);
  assert.equal(at("[ ] call 20 nov 15:00"), null, "passed");
  const r = collectReminders(["[ ] bayar listrik besok jam 3"], sun);
  assert.equal(r[0].label, "bayar listrik");
});

test("describeWhen and commitWhen", () => {
  const sun = new Date(2026, 10, 22, 10, 0);
  const desc = (line: string) => describeWhen(line, parseLine(line), sun);
  assert.deepEqual(desc("[ ] a 15:00"), { label: "15:00", overdue: false });
  assert.deepEqual(desc("[ ] a besok 15:00"), { label: "besok 15:00", overdue: false });
  assert.deepEqual(desc("[ ] a 25 nov"), { label: "rab", overdue: false });
  assert.deepEqual(desc("[ ] a 10 des"), { label: "10 des", overdue: false });
  assert.deepEqual(desc("[ ] a 20 nov"), { label: "20 nov", overdue: true });
  assert.equal(commitWhen("[ ] bayar besok jam 3", sun), "[ ] bayar 23 nov jam 3");
  assert.equal(commitWhen("[ ] call 2 jam lagi", sun), "[ ] call 12:00");
  assert.equal(commitWhen("[ ] call 25 nov", sun), null, "already absolute");
  assert.equal(commitWhen("[ ] invoice tgl 25", sun), "[ ] invoice 25 nov", "tgl N locks too");
  assert.equal(commitWhen("besok libur", sun), null, "notes are left alone");
});

function pick(t: { hour: number; minute: number; ambiguous: boolean } | null) {
  return t && { hour: t.hour, minute: t.minute, ambiguous: t.ambiguous };
}
