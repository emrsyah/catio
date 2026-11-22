import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { editPad, listPads, padNameOf, resolvePad } from "../src/pads.ts";

test("pad files: names, order, lookup, atomic edit", async () => {
  assert.equal(padNameOf("kerjaan.md"), "kerjaan");
  for (const f of ["arsip.md", "catio.conflict-1.md", ".x.md", "catio.md.tmp", "notes.txt"]) assert.equal(padNameOf(f), null, f);

  const dir = mkdtempSync(join(tmpdir(), "catio-mcp-"));
  try {
    for (const f of ["zeta.md", "catio.md", "Alpha.md", "arsip.md"]) writeFileSync(join(dir, f), "");
    assert.deepEqual(listPads(dir), ["catio", "Alpha", "zeta"]);
    assert.deepEqual(listPads(dir, ["zeta", "gone"]), ["zeta", "catio", "Alpha"]);
    assert.equal(resolvePad(["catio", "Alpha"], "alpha.md"), "Alpha");
    assert.throws(() => resolvePad(["catio"], "nope"), /Pads: catio/);

    writeFileSync(join(dir, "catio.md"), "[ ] a\r\n---\r\nb");
    await editPad(dir, "catio", (l) => [...l, "c"]);
    assert.equal(readFileSync(join(dir, "catio.md"), "utf8"), "[ ] a\n---\nb\nc");
    await assert.rejects(editPad(dir, "catio", () => { throw new Error("cancel"); }), /cancel/);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "no tmp left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server end to end over stdio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catio-mcp-"));
  writeFileSync(join(dir, "catio.md"), "[ ] fokus satu\n---\ncatatan #kerja");
  writeFileSync(join(dir, "ide.md"), "[ ] bikin logo");
  writeFileSync(join(dir, "arsip.md"), "[x] logo lama");
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "../src/index.ts")],
      env: { ...(process.env as Record<string, string>), CATIO_DIR: dir },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["add", "list_pads", "open_todos", "read_pad", "search", "set_done"]);

    assert.match((await call("list_pads")).text, /catio \(default\): 1 open to-do, 1 in focus/);

    await call("add", { text: "review PR #42\ncatatan tambahan", pad: "catio" });
    await call("add", { text: "urgent", focus: true });
    await call("add", { text: "ide liar", pad: "IDE", note: true });
    assert.equal(readFileSync(join(dir, "catio.md"), "utf8"), "[ ] fokus satu\n[ ] urgent\n---\n[ ] review PR #42\n[ ] catatan tambahan\ncatatan #kerja");
    assert.equal(readFileSync(join(dir, "ide.md"), "utf8"), "[ ] bikin logo\nide liar");

    const todos = (await call("open_todos", { pad: "catio" })).text.split("\n");
    assert.equal(todos[0], "catio:1  [ ] fokus satu  (fokus)");
    assert.equal(todos.length, 4);

    assert.equal((await call("set_done", { pad: "catio", line: 4, text: "[ ] review PR #42" })).text, "catio:4  [x] review PR #42");
    const moved = await call("set_done", { pad: "catio", line: 1, text: "[ ] urgent" });
    assert.equal(moved.text, "catio:2  [x] urgent", "found by text after lines shifted");
    assert.equal((await call("set_done", { pad: "catio", line: 3, text: "gone" })).isError, true);
    assert.equal((await call("set_done", { pad: "catio", line: 6 })).isError, true, "a note can't be ticked");

    const hits = (await call("search", { query: "logo" })).text.split("\n");
    assert.deepEqual(hits, ["ide:1  [ ] bikin logo", "arsip:1  [x] logo lama"]);
    assert.match((await call("search", { query: "", tag: "#kerja" })).text, /catio:6/);
    assert.match((await call("read_pad", { pad: "nope" })).text, /No pad named "nope"/);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
