//! Pads on disk. Each pad is one plain .md file in the Catio folder ("catio" is catio.md,
//! "kerjaan" is kerjaan.md), so every pad still opens in Notepad and syncs as a file.
//! Atomic save, a folder watcher, conflict copies, a movable folder (config.json),
//! arsip.md for "Bersihin", and a .terhapus folder so a deleted pad can come back.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// The first pad. Its file name predates multi-pad and stays catio.md.
pub const DEFAULT_PAD: &str = "catio";
const ARCHIVE: &str = "arsip.md";
const TRASH: &str = ".terhapus";

const STARTER: &str = "[ ] coba centang baris ini pakai Ctrl+Enter
[ ] baris di atas garis --- itu fokus hari ini
---
catatan bebas di bawah garis.
tulis jam di to-do, misal [ ] call dokter 15:00, nanti diingetin.
Ctrl+Alt+N buat munculin atau sembunyiin pad.
";

#[derive(Default, Serialize, Deserialize)]
struct Config {
    folder: Option<PathBuf>,
    /// The pad open last time.
    #[serde(default)]
    pad: Option<String>,
    /// Menu order (creation order). Files found on disk but missing here go at the end.
    #[serde(default)]
    order: Vec<String>,
}

#[derive(Serialize)]
pub struct PadInfo {
    pub name: String,
    pub text: String,
}

pub struct DocState {
    dir: Mutex<PathBuf>,
    active: Mutex<String>,
    /// true when this launch created catio.md: the pad shows where it lives.
    pub first_run: bool,
    /// Last content we wrote or loaded for the active pad. The watcher ignores events that
    /// match it, which is how our own saves don't bounce back as "external" changes.
    last: Mutex<String>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl DocState {
    pub fn init(app: &AppHandle) -> io::Result<Self> {
        let cfg = read_config(app);
        let dir = match cfg.folder {
            Some(dir) => dir,
            None => default_dir(app)?,
        };
        fs::create_dir_all(&dir)?;
        let default = pad_path(&dir, DEFAULT_PAD);
        let first_run = !default.exists() && list_names(&dir).is_empty();
        if first_run {
            write_atomic(&default, STARTER)?;
        }
        // Reopen the last pad if its file is still there, else the first one.
        let active = cfg
            .pad
            .filter(|p| pad_path(&dir, p).exists())
            .or_else(|| ordered_names(&dir, &cfg.order).into_iter().next())
            .unwrap_or_else(|| DEFAULT_PAD.to_string());
        let path = pad_path(&dir, &active);
        if !path.exists() {
            write_atomic(&path, "")?;
        }
        let text = read_normalized(&path)?;
        Ok(Self {
            dir: Mutex::new(dir),
            active: Mutex::new(active),
            first_run,
            last: Mutex::new(text),
            watcher: Mutex::new(None),
        })
    }

    pub fn dir(&self) -> PathBuf {
        self.dir.lock().unwrap().clone()
    }

    pub fn active(&self) -> String {
        self.active.lock().unwrap().clone()
    }

    pub fn path(&self) -> PathBuf {
        pad_path(&self.dir(), &self.active())
    }

    pub fn load(&self) -> io::Result<String> {
        let text = read_normalized(&self.path())?;
        *self.last.lock().unwrap() = text.clone();
        Ok(text)
    }

    /// Saves to the named pad. Naming it (instead of "the active one") means a save that
    /// was in flight while you switched pads still lands in the right file.
    pub fn save(&self, pad: &str, text: &str) -> io::Result<()> {
        if pad != self.active() {
            return write_atomic(&pad_path(&self.dir(), pad), text);
        }
        let mut last = self.last.lock().unwrap();
        if *last == text {
            return Ok(());
        }
        // Only remember it once it is really on disk; a failed write must stay retryable.
        // Holding the lock across the write makes the watcher wait, so it sees this as ours.
        write_atomic(&self.path(), text)?;
        *last = text.to_string();
        Ok(())
    }

    pub fn save_conflict_copy(&self, text: &str) -> io::Result<PathBuf> {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let stem = file_stem(&self.active());
        let copy = self.dir().join(format!("{stem}.conflict-{secs}.md"));
        write_atomic(&copy, text)?;
        Ok(copy)
    }

    /// Every pad in menu order, with its text.
    pub fn list(&self, app: &AppHandle) -> Vec<PadInfo> {
        let dir = self.dir();
        ordered_names(&dir, &read_config(app).order)
            .into_iter()
            .map(|name| {
                let text = read_normalized(&pad_path(&dir, &name)).unwrap_or_default();
                PadInfo { name, text }
            })
            .collect()
    }

    pub fn switch(&self, app: &AppHandle, name: &str) -> io::Result<String> {
        let path = pad_path(&self.dir(), name);
        if !path.exists() {
            return Err(io::Error::new(io::ErrorKind::NotFound, format!("pad {name} nggak ada")));
        }
        let text = read_normalized(&path)?;
        *self.active.lock().unwrap() = name.to_string();
        *self.last.lock().unwrap() = text.clone();
        update_config(app, |c| c.pad = Some(name.to_string()))?;
        Ok(text)
    }

    /// New empty pad. A taken name gets " 2", " 3"… Returns the final name.
    pub fn create(&self, app: &AppHandle, wanted: &str) -> io::Result<String> {
        let dir = self.dir();
        let base = clean_name(wanted).unwrap_or_else(|| "pad".to_string());
        let name = unique_name(&dir, &base);
        write_atomic(&pad_path(&dir, &name), "")?;
        let all = ordered_names(&dir, &read_config(app).order);
        update_config(app, |c| c.order = all.clone())?;
        Ok(name)
    }

    pub fn rename(&self, app: &AppHandle, old: &str, wanted: &str) -> io::Result<String> {
        let dir = self.dir();
        let Some(base) = clean_name(wanted) else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "nama kosong"));
        };
        if base == old {
            return Ok(base);
        }
        // Only a case change ("Ide" → "ide") may reuse the same file name on Windows.
        let name = if base.eq_ignore_ascii_case(old) { base } else { unique_name(&dir, &base) };
        fs::rename(pad_path(&dir, old), pad_path(&dir, &name))?;
        {
            let mut active = self.active.lock().unwrap();
            if *active == old {
                *active = name.clone();
            }
        }
        let active = self.active();
        update_config(app, |c| {
            for n in c.order.iter_mut() {
                if n == old {
                    *n = name.clone();
                }
            }
            c.pad = Some(active.clone());
        })?;
        Ok(name)
    }

    /// Moves the pad's file into .terhapus (never a hard delete). Returns where it went, so
    /// "batal" can put it back. The last remaining pad can't be deleted.
    pub fn delete(&self, name: &str) -> io::Result<String> {
        let dir = self.dir();
        if list_names(&dir).len() <= 1 {
            return Err(io::Error::new(io::ErrorKind::Other, "minimal harus ada satu pad"));
        }
        let trash = dir.join(TRASH);
        fs::create_dir_all(&trash)?;
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let to = trash.join(format!("{}.{secs}.md", file_stem(name)));
        fs::rename(pad_path(&dir, name), &to)?;
        Ok(to.display().to_string())
    }

    /// Undo for delete: the file comes back under its old name (or a free variant).
    pub fn restore(&self, app: &AppHandle, trashed: &str, name: &str) -> io::Result<String> {
        let dir = self.dir();
        let name = unique_name(&dir, name);
        fs::rename(trashed, pad_path(&dir, &name))?;
        let all = ordered_names(&dir, &read_config(app).order);
        update_config(app, |c| c.order = all.clone())?;
        Ok(name)
    }

    /// Move to another folder (e.g. OneDrive). Pads already there win and are kept; pads
    /// that aren't get copied over. The old files are left untouched.
    pub fn switch_folder(&self, app: &AppHandle, dir: &Path, current: &str) -> io::Result<String> {
        let old = self.dir();
        let active = self.active();
        fs::create_dir_all(dir)?;
        for name in list_names(&old) {
            let target = pad_path(dir, &name);
            if target.exists() {
                continue;
            }
            let text = if name == active { current.to_string() } else { read_normalized(&pad_path(&old, &name))? };
            write_atomic(&target, &text)?;
        }
        let text = read_normalized(&pad_path(dir, &active))?;
        *self.dir.lock().unwrap() = dir.to_path_buf();
        *self.last.lock().unwrap() = text.clone();
        update_config(app, |c| c.folder = Some(dir.to_path_buf()))?;
        if let Err(e) = self.watch(app.clone()) {
            eprintln!("watcher off: {e}");
        }
        Ok(text)
    }

    /// Append finished lines to arsip.md under today's date (and the pad's name, when it
    /// isn't the first pad). Returns exactly what was appended, so "batal" can take it back.
    pub fn archive(&self, date: &str, pad: &str, lines: &[String]) -> io::Result<String> {
        let path = self.dir().join(ARCHIVE);
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let header = if pad == DEFAULT_PAD { format!("## {date}") } else { format!("## {date} · {pad}") };
        let last_header = existing.lines().rev().find(|l| l.starts_with("## "));
        let mut block = String::new();
        if !existing.is_empty() && !existing.ends_with('\n') {
            block.push('\n');
        }
        if last_header != Some(header.as_str()) {
            if !existing.trim().is_empty() {
                block.push('\n');
            }
            block.push_str(&header);
            block.push('\n');
        }
        for l in lines {
            block.push_str(l);
            block.push('\n');
        }
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        f.write_all(block.as_bytes())?;
        f.sync_all()?;
        Ok(block)
    }

    pub fn unarchive(&self, block: &str) -> io::Result<()> {
        let path = self.dir().join(ARCHIVE);
        let existing = fs::read_to_string(&path)?;
        if let Some(rest) = existing.strip_suffix(block) {
            write_atomic(&path, rest)?;
        }
        Ok(())
    }

    /// Watch the folder (not one file): atomic renames replace a file's identity, and pads
    /// can be added or edited from outside. The active pad's changes go out as "doc-changed";
    /// any other pad file changing sends "pads-changed" so badges and reminders refresh.
    pub fn watch(&self, app: AppHandle) -> notify::Result<()> {
        let dir = self.dir();
        let watched = dir.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)) {
                return;
            }
            let pads: Vec<String> = event.paths.iter().filter_map(|p| pad_name_of(p)).collect();
            if pads.is_empty() {
                return;
            }
            let state = app.state::<DocState>();
            if state.dir() != watched {
                return; // folder switched since this watcher started
            }
            let active = state.active();
            if !pads.iter().any(|p| p.eq_ignore_ascii_case(&active)) {
                let _ = app.emit("pads-changed", ());
                return;
            }
            // Notepad truncates then writes; wait for the burst to settle before reading.
            thread::sleep(Duration::from_millis(100));
            let Some(text) = read_with_retry(&state.path()) else { return };
            {
                let mut last = state.last.lock().unwrap();
                if *last == text {
                    return;
                }
                *last = text.clone();
            }
            let _ = app.emit("doc-changed", text);
        })?;
        watcher.watch(&dir, RecursiveMode::NonRecursive)?;
        *self.watcher.lock().unwrap() = Some(watcher);
        Ok(())
    }
}

/// "catio" lives in catio.md; every other pad is "<name>.md".
fn pad_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{}.md", file_stem(name)))
}

fn file_stem(name: &str) -> String {
    name.to_string()
}

/// A pad name from a path, or None for files that aren't pads (archive, conflict copies, tmp).
fn pad_name_of(path: &Path) -> Option<String> {
    let file = path.file_name()?.to_str()?;
    let stem = file.strip_suffix(".md").or_else(|| file.strip_suffix(".MD"))?;
    if stem.is_empty() || file.eq_ignore_ascii_case(ARCHIVE) || stem.contains(".conflict-") || stem.starts_with('.') {
        return None;
    }
    Some(stem.to_string())
}

fn list_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| pad_name_of(&e.path()))
        .collect()
}

/// Config order first, then catio, then anything else found on disk alphabetically.
fn ordered_names(dir: &Path, order: &[String]) -> Vec<String> {
    let mut found = list_names(dir);
    let mut out: Vec<String> = order.iter().filter(|n| found.contains(n)).cloned().collect();
    found.sort_by_key(|n| (n != DEFAULT_PAD, n.to_lowercase()));
    for n in found {
        if !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// Trimmed, without characters Windows forbids in file names. None when nothing is left.
fn clean_name(raw: &str) -> Option<String> {
    let s: String = raw
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let s = s.trim().trim_matches('.').trim().to_string();
    let s: String = s.chars().take(40).collect();
    if s.is_empty() || s.eq_ignore_ascii_case("arsip") {
        None
    } else {
        Some(s)
    }
}

fn unique_name(dir: &Path, base: &str) -> String {
    let taken = |n: &str| list_names(dir).iter().any(|e| e.eq_ignore_ascii_case(n));
    if !taken(base) {
        return base.to_string();
    }
    (2..).map(|i| format!("{base} {i}")).find(|n| !taken(n)).unwrap()
}

fn default_dir(app: &AppHandle) -> io::Result<PathBuf> {
    app.path()
        .document_dir()
        .map(|d| d.join("Catio"))
        .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e.to_string()))
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn read_config(app: &AppHandle) -> Config {
    config_path(app)
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn update_config(app: &AppHandle, f: impl FnOnce(&mut Config)) -> io::Result<()> {
    let mut cfg = read_config(app);
    f(&mut cfg);
    let Some(path) = config_path(app) else { return Ok(()) };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(&cfg).map_err(io::Error::other)?;
    write_atomic(&path, &json)
}

/// tmp file + fsync + rename: a crash or forced reboot leaves either the old or the new file, never half.
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    {
        let mut f = File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// Notepad and OneDrive may write CRLF; the editor works in LF.
fn read_normalized(path: &Path) -> io::Result<String> {
    let raw = fs::read(path)?;
    let text = String::from_utf8_lossy(&raw);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    Ok(text.replace("\r\n", "\n"))
}

/// Sync clients briefly lock the file while writing; give them a moment.
fn read_with_retry(path: &Path) -> Option<String> {
    for attempt in 0..4 {
        match read_normalized(path) {
            Ok(t) => return Some(t),
            Err(_) => thread::sleep(Duration::from_millis(40 * (attempt + 1))),
        }
    }
    None
}
