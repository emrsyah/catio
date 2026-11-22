#!/usr/bin/env node
// Catio MCP server (stdio). Gives coding agents the pads as tools: list, read, open to-dos,
// add (like quick capture), tick, search. Parsing and edits come from @catio/core, so a line
// added here is formatted exactly as if it was typed in the pad.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildIndex,
  describeWhen,
  findLine,
  insertAllCaptured,
  insertCaptured,
  moveToFocus,
  normalizeMarker,
  parseDoc,
  parseLine,
  prepareCapture,
  search,
  setDone,
  type SearchFilter,
  type SearchSource,
} from "@catio/core";
import { join } from "node:path";
import { ARCHIVE, DEFAULT_PAD, catioDir, editPad, listPads, padPath, readConfig, readText, resolvePad } from "./pads.ts";

/** Folder and pads, re-read per call: the app may have added, renamed or moved them. */
function workspace() {
  const cfg = readConfig();
  const dir = catioDir(cfg);
  const pads = listPads(dir, cfg.order);
  const fallback = pads.find((p) => p === cfg.pad) ?? pads[0] ?? DEFAULT_PAD;
  const pick = (name?: string) => (name ? resolvePad(pads, name) : fallback);
  return { dir, pads, fallback, pick };
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** "catio:3  [ ] call dina  (besok 15:00, fokus)": 1-based, the way an agent cites it back. */
function describe(pad: string, index: number, line: string, now: Date, focus = false): string {
  const when = describeWhen(line, parseLine(line), now);
  const notes = [when && (when.overdue ? `lewat: ${when.label}` : when.label), focus && "fokus"].filter(Boolean);
  return `${pad}:${index + 1}  ${line.trim()}${notes.length ? `  (${notes.join(", ")})` : ""}`;
}

const server = new McpServer({ name: "catio", version: "0.1.0" });

const FORMAT = [
  "Catio pads are plain .md files. Line format: '[ ] ' open to-do, '[x] ' done, '[>] ' snoozed until tomorrow,",
  "anything else is a note. Lines above the first '---' are the focus zone (what to do now).",
  "Dates and times are written in Indonesian inside the line: '15:00', 'jam 3', 'besok', 'jumat', '25 nov', '2 jam lagi'.",
  "To-dos with a time become Windows notifications.",
].join(" ");

server.registerTool(
  "list_pads",
  {
    title: "List pads",
    description: `List Catio pads with their open to-do counts. ${FORMAT}`,
    inputSchema: {},
  },
  async () => {
    const { dir, pads, fallback } = workspace();
    if (!pads.length) return text(`No pads in ${dir}. Is Catio installed, or is CATIO_DIR set?`);
    const rows = await Promise.all(
      pads.map(async (p) => {
        const doc = parseDoc((await readText(padPath(dir, p))).split("\n"));
        const open = doc.lines.filter((l) => l.kind === "todo").length;
        const focus = doc.dividerIndex > 0 ? doc.lines.slice(0, doc.dividerIndex).filter((l) => l.kind === "todo").length : 0;
        return `${p}${p === fallback ? " (default)" : ""}: ${open} open to-do${open === 1 ? "" : "s"}, ${focus} in focus`;
      }),
    );
    return text(`Folder: ${dir}\n${rows.join("\n")}`);
  },
);

server.registerTool(
  "read_pad",
  {
    title: "Read a pad",
    description: "Read one pad's full text with 1-based line numbers (use them with set_done).",
    inputSchema: { pad: z.string().optional().describe("Pad name; defaults to the pad last open in the app") },
  },
  async ({ pad }) => {
    const w = workspace();
    const name = w.pick(pad);
    const lines = (await readText(padPath(w.dir, name))).split("\n");
    const width = String(lines.length).length;
    return text(`${name} (${padPath(w.dir, name)})\n${lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join("\n")}`);
  },
);

server.registerTool(
  "open_todos",
  {
    title: "Open to-dos",
    description: "Open to-dos across pads (or one pad), focus zone first, with their date/time.",
    inputSchema: {
      pad: z.string().optional().describe("Only this pad"),
      tag: z.string().optional().describe("Only lines with this #tag or @person"),
      dated: z.boolean().optional().describe("Only to-dos that have a date or time"),
    },
  },
  async ({ pad, tag, dated }) => {
    const w = workspace();
    const now = new Date();
    const want = tag?.trim().toLowerCase();
    const out: string[] = [];
    for (const name of pad ? [w.pick(pad)] : w.pads) {
      const lines = (await readText(padPath(w.dir, name))).split("\n");
      const doc = parseDoc(lines);
      const rows: [boolean, string][] = [];
      doc.lines.forEach((p, i) => {
        if (p.kind !== "todo" || (dated && !p.date && !p.time) || (want && !lines[i].toLowerCase().includes(want))) return;
        const focus = i < doc.dividerIndex;
        rows.push([focus, describe(name, i, lines[i], now, focus)]);
      });
      rows.sort((a, b) => Number(b[0]) - Number(a[0]));
      out.push(...rows.map((r) => r[1]));
    }
    return text(out.length ? out.join("\n") : "No open to-dos match.");
  },
);

server.registerTool(
  "add",
  {
    title: "Add to a pad",
    description:
      "Add one or more lines to a pad, like Catio's quick capture: they go right under '---' (or into the focus zone). " +
      "Each line becomes an open to-do unless note is true. Relative dates ('besok', 'jumat', '2 jam lagi') are locked " +
      `to a fixed date so the file stays correct tomorrow. ${FORMAT}`,
    inputSchema: {
      text: z.string().min(1).describe("One line per item, e.g. 'review PR #42 besok 10:00'"),
      pad: z.string().optional().describe("Pad name; defaults to the pad last open in the app"),
      focus: z.boolean().optional().describe("Put the lines in the focus zone (above '---') instead of under it"),
      note: z.boolean().optional().describe("Add as plain notes, not to-dos"),
    },
  },
  async ({ text: raw, pad, focus, note }) => {
    const w = workspace();
    const name = w.pick(pad);
    const marked = note
      ? raw
      : raw
          .split(/\r?\n/)
          .map((l) => (l.trim() && parseLine(normalizeMarker(l) ?? l).kind === "text" ? `[ ] ${l.trim()}` : l))
          .join("\n");
    const lines = prepareCapture(marked, new Date());
    if (!lines.length) throw new Error("Nothing to add: the text is blank.");
    await editPad(w.dir, name, (cur) => {
      if (!focus) return insertAllCaptured(cur, lines);
      let doc = cur;
      for (const l of lines) {
        const placed = insertCaptured(doc, l);
        doc = moveToFocus(placed.lines, placed.index).lines;
      }
      return doc;
    });
    return text(`Added to ${name}${focus ? " (focus)" : ""}:\n${lines.join("\n")}`);
  },
);

server.registerTool(
  "set_done",
  {
    title: "Tick or untick a to-do",
    description:
      "Mark a to-do done ([x]) or open again ([ ]). Give the 1-based line from read_pad/open_todos/search, plus the line's " +
      "current text so the right line is found even if lines above moved.",
    inputSchema: {
      pad: z.string().describe("Pad name"),
      line: z.number().int().min(1).describe("1-based line number"),
      text: z.string().optional().describe("The line's current text, exactly as read"),
      done: z.boolean().optional().describe("false to reopen; default true"),
    },
  },
  async ({ pad, line, text: expected, done = true }) => {
    const w = workspace();
    const name = w.pick(pad);
    let result = "";
    await editPad(w.dir, name, (lines) => {
      const i = expected === undefined ? line - 1 : findLine(lines, line - 1, expected);
      if (i < 0 || i >= lines.length) throw new Error(`Line ${line} of ${name} changed or is gone. Read the pad again.`);
      const next = setDone(lines[i], done);
      if (next === null) throw new Error(`${name}:${i + 1} is not a to-do: ${lines[i]}`);
      result = next === lines[i] ? `Already ${done ? "done" : "open"}: ${name}:${i + 1}  ${next}` : `${name}:${i + 1}  ${next}`;
      lines[i] = next;
      return lines;
    });
    return text(result);
  },
);

server.registerTool(
  "search",
  {
    title: "Search pads",
    description: "Search every pad and the archive (arsip.md), like Ctrl+K in Catio. All words must match, any order.",
    inputSchema: {
      query: z.string().describe("Words to find; empty lists everything that passes the filter"),
      filter: z.enum(["all", "open", "dated"]).optional().describe("open = open to-dos only, dated = to-dos with a date/time"),
      tag: z.string().optional().describe("Only lines with this #tag or @person (include the # or @)"),
      archive: z.boolean().optional().describe("Include arsip.md; default true"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
    },
  },
  async ({ query, filter = "all", tag, archive = true, limit = 20 }) => {
    const w = workspace();
    const sources: SearchSource[] = await Promise.all(w.pads.map(async (p) => ({ source: p, text: await readText(padPath(w.dir, p)) })));
    if (archive) sources.push({ source: "arsip", text: await readText(join(w.dir, ARCHIVE)), archive: true });
    const f: SearchFilter = tag ? { kind: "tag", tag: tag.trim() } : { kind: filter };
    const now = new Date();
    const hits = search(buildIndex(sources), query, f, limit);
    return text(hits.length ? hits.map((h) => describe(h.item.source, h.item.line, h.item.text, now)).join("\n") : "No matches.");
  },
);

await server.connect(new StdioServerTransport());
