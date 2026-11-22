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
  inlineTokens,
  linkHref,
  listToTodos,
  insertCaptured,
  moveToFocus,
  setDate,
  taskKey,
  updateAges,
  dayNumber,
  ageLabel,
  buildIndex,
  search,
  topTags,
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

test("inline tokens: tags, people, links, numbers", () => {
  const kinds = (s: string) => inlineTokens(s).map((t) => `${t.kind}:${t.value}`);
  assert.deepEqual(kinds("[ ] review PR #kerja @dina"), ["tag:kerja", "person:dina"]);
  assert.deepEqual(kinds("mail dina@mail.com"), [], "email is not a person");
  assert.deepEqual(kinds("lihat https://x.com/a#bagian ya"), ["url:https://x.com/a#bagian"], "# inside a URL");
  assert.deepEqual(kinds("buka www.catio.app."), ["url:www.catio.app"], "trailing dot stays text");
  assert.deepEqual(kinds("C# dan a#b"), [], "not tags");
  assert.deepEqual(kinds("&#39; html"), []);
  assert.deepEqual(kinds("rek Dina BCA 123 456 7890"), ["number:1234567890"]);
  assert.deepEqual(kinds("PIC: mas Arif (0812-3456-7890)"), ["number:081234567890"]);
  assert.deepEqual(kinds("budget 40jt, 15:00, 49rb/bln, 1.000.000"), [], "short numbers aren't copy targets");
  assert.equal(linkHref("www.catio.app"), "https://www.catio.app");
  assert.equal(linkHref("javascript:alert(1)"), null);
});

test("pasted lists become to-dos only when they are lists", () => {
  assert.deepEqual(listToTodos("- cek harga vendor kaos\n- konfirmasi venue\n• bikin form RSVP"), [
    "[ ] cek harga vendor kaos",
    "[ ] konfirmasi venue",
    "[ ] bikin form RSVP",
  ]);
  assert.deepEqual(listToTodos("1. satu\n2) dua"), ["[ ] satu", "[ ] dua"]);
  assert.equal(listToTodos("- satu"), null, "one bullet is just a line");
  assert.equal(listToTodos("halo\n- satu\n- dua"), null, "prose mixed in: leave it");
  assert.equal(listToTodos("-5 derajat\n-3 derajat"), null, "negative numbers aren't bullets");
});

test("capture and review edits", () => {
  const doc = ["[ ] a", "---", "[ ] b", ""];
  assert.deepEqual(insertCaptured(doc, "[ ] baru"), { lines: ["[ ] a", "---", "[ ] baru", "[ ] b", ""], index: 2 });
  assert.deepEqual(insertCaptured(["catatan", "", ""], "x"), { lines: ["catatan", "x"], index: 1 });
  assert.deepEqual(moveToFocus(["[ ] a", "---", "[ ] b"], 2), { lines: ["[ ] a", "[ ] b", "---"], index: 1 });
  assert.deepEqual(moveToFocus(["x", "[ ] b"], 1), { lines: ["[ ] b", "x"], index: 0 });
  const sun = new Date(2026, 10, 22, 10, 0);
  const next = new Date(2026, 10, 29);
  assert.equal(setDate("[ ] bayar 20 nov jam 3", next, sun), "[ ] bayar 29 nov jam 3");
  assert.equal(setDate("[ ] bayar", next, sun), "[ ] bayar 29 nov");
});

test("task age is kept by key and survives date rewrites", () => {
  const d1 = new Date(2026, 10, 20, 10, 0);
  const d4 = new Date(2026, 10, 23, 10, 0);
  assert.equal(taskKey("[ ] Bayar listrik besok 15:00"), "bayar listrik");
  assert.equal(taskKey("[ ] bayar listrik 23 nov 15:00"), "bayar listrik");
  assert.equal(taskKey("[x] done"), null);
  assert.equal(taskKey("[ ] "), null);
  const b1 = updateAges({}, ["bayar listrik"], d1);
  const b2 = updateAges(b1, ["bayar listrik"], d4);
  assert.equal(b2, b1, "unchanged book is the same object");
  assert.equal(dayNumber(d4) - b2["bayar listrik"], 3);
  const b3 = updateAges(b2, ["baru"], d4);
  assert.deepEqual(Object.keys(b3), ["baru"], "gone tasks are forgotten");
  assert.equal(dayNumber(new Date(2026, 10, 23, 2, 0)), dayNumber(new Date(2026, 10, 22, 12, 0)), "before 04:00 is yesterday");
  assert.equal(ageLabel(1), null);
  assert.equal(ageLabel(5), "5 hari");
  assert.equal(ageLabel(21), "3 mgg");
});

test("search ranks open to-dos and filters", () => {
  const index = buildIndex([
    { source: "catio", text: "[x] transfer DP venue\n[ ] konfirmasi venue sama Dina #kerja\n---\nlist venue buat gathering" },
    { source: "ide", text: "[ ] call venue besok 15:00 @dina" },
    { source: "arsip", text: "## 2026-11-20\n[x] venue lama", archive: true },
  ]);
  const hits = search(index, "venue");
  assert.equal(hits.length, 5);
  assert.equal(hits[0].item.kind, "todo");
  assert.equal(hits[hits.length - 1].item.archive, true, "archive ranks last");
  assert.deepEqual(search(index, "VENUE dina").map((h) => h.item.source), ["catio", "ide"], "all words, any case");
  assert.deepEqual(search(index, "", { kind: "dated" }).map((h) => h.item.line), [0]);
  assert.deepEqual(search(index, "", { kind: "tag", tag: "#kerja" }).length, 1);
  assert.deepEqual(topTags(index), ["#kerja", "@dina"]);
  assert.deepEqual(search(index, "venue sama")[0].ranges, [[15, 20], [21, 25]]);
});

function pick(t: { hour: number; minute: number; ambiguous: boolean } | null) {
  return t && { hour: t.hour, minute: t.minute, ambiguous: t.ambiguous };
}
