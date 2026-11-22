// Pads on disk, read and written the way the app does it (apps/desktop/src-tauri/src/doc.rs):
// one .md file per pad, arsip.md for archived lines, atomic tmp + rename saves. The app
// watches the folder, so a pad changed here shows up on screen, in reminders and in the badge.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PAD = "catio";
export const ARCHIVE = "arsip.md";
const APP_ID = "app.catio.desktop";

export interface Config {
  folder?: string | null;
  /** the pad open last time in the app */
  pad?: string | null;
  /** menu order */
  order?: string[];
}

function configDir(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_ID);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", APP_ID);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP_ID);
}

export function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8")) as Config;
  } catch {
    return {};
  }
}

/** The Documents folder as the OS knows it (it may be redirected, e.g. into OneDrive). */
function documentsDir(): string {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders", "/v", "Personal"],
        { encoding: "utf8", windowsHide: true },
      );
      const m = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
      if (m) return m[1].trim().replace(/%([^%]+)%/g, (all, v: string) => process.env[v] ?? all);
    } else if (process.platform !== "darwin") {
      const dirs = readFileSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "user-dirs.dirs"), "utf8");
      const m = /^XDG_DOCUMENTS_DIR="?([^"\n]+)"?/m.exec(dirs);
      if (m) return m[1].replace("$HOME", homedir());
    }
  } catch {
    // fall through to ~/Documents
  }
  return join(homedir(), "Documents");
}

/** The app's folder: CATIO_DIR, else the one picked in the tray, else Documents/Catio. */
export function catioDir(cfg: Config = readConfig()): string {
  return process.env.CATIO_DIR || cfg.folder || join(documentsDir(), "Catio");
}

/** A pad name from a file name, or null for files that aren't pads (archive, conflict copies, tmp). */
export function padNameOf(file: string): string | null {
  const stem = file.replace(/\.md$/i, "");
  if (stem === file || !stem || file.toLowerCase() === ARCHIVE || stem.includes(".conflict-") || stem.startsWith(".")) return null;
  return stem;
}

/** Menu order first, then catio, then the rest alphabetically: the order the app shows. */
export function listPads(dir: string, order: readonly string[] = []): string[] {
  let found: string[];
  try {
    found = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => padNameOf(e.name)).filter((n): n is string => !!n);
  } catch {
    return [];
  }
  const out = order.filter((n) => found.includes(n));
  found.sort((a, b) => Number(a !== DEFAULT_PAD) - Number(b !== DEFAULT_PAD) || a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const n of found) if (!out.includes(n)) out.push(n);
  return out;
}

/** The pad's real name for what the agent typed (any case), or an error naming the pads that exist. */
export function resolvePad(pads: readonly string[], name: string): string {
  const want = name.trim().replace(/\.md$/i, "").toLowerCase();
  const hit = pads.find((p) => p.toLowerCase() === want);
  if (!hit) throw new Error(`No pad named "${name}". Pads: ${pads.join(", ") || "(none)"}`);
  return hit;
}

export const padPath = (dir: string, name: string) => join(dir, `${name}.md`);

/** Notepad and OneDrive may write CRLF; Catio works in LF. A missing file reads as empty. */
export async function readText(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).replace(/\r\n?/g, "\n");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** tmp + fsync + rename, like the app: a crash leaves the old file or the new one, never half. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const f = await open(tmp, "w");
  try {
    await f.writeFile(text, "utf8");
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(tmp, path);
}

/** Read, edit by lines, save. `edit` throws to cancel; an unchanged result writes nothing. */
export async function editPad(dir: string, name: string, edit: (lines: string[]) => string[]): Promise<string[]> {
  const path = padPath(dir, name);
  const before = await readText(path);
  const lines = edit(before.split("\n"));
  const after = lines.join("\n");
  if (after !== before) await writeAtomic(path, after);
  return lines;
}
