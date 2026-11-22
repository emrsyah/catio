//! catio.md on disk: atomic save, external-change watcher, conflict copies,
//! a movable folder (config.json) and arsip.md for "Bersihin".

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "catio.md";
const ARCHIVE: &str = "arsip.md";

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
}

pub struct DocState {
    path: Mutex<PathBuf>,
    /// true when this launch created catio.md: the pad shows where it lives.
    pub first_run: bool,
    /// Last content we wrote or loaded. The watcher ignores events that match it,
    /// which is how our own saves don't bounce back as "external" changes.
    last: Mutex<String>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl DocState {
    pub fn init(app: &AppHandle) -> io::Result<Self> {
        let dir = match read_config(app).folder {
            Some(dir) => dir,
            None => default_dir(app)?,
        };
        fs::create_dir_all(&dir)?;
        let path = dir.join(FILE);
        let first_run = !path.exists();
        if first_run {
            write_atomic(&path, STARTER)?;
        }
        let text = read_normalized(&path)?;
        Ok(Self { path: Mutex::new(path), first_run, last: Mutex::new(text), watcher: Mutex::new(None) })
    }

    pub fn path(&self) -> PathBuf {
        self.path.lock().unwrap().clone()
    }

    pub fn load(&self) -> io::Result<String> {
        let text = read_normalized(&self.path())?;
        *self.last.lock().unwrap() = text.clone();
        Ok(text)
    }

    pub fn save(&self, text: &str) -> io::Result<()> {
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
        let copy = self.path().with_file_name(format!("catio.conflict-{secs}.md"));
        write_atomic(&copy, text)?;
        Ok(copy)
    }

    /// Move to another folder (e.g. OneDrive). An existing catio.md there wins and is loaded;
    /// otherwise the current text is written there. The old file is left untouched.
    pub fn switch_folder(&self, app: &AppHandle, dir: &Path, current: &str) -> io::Result<String> {
        let target = dir.join(FILE);
        let text = if target.exists() {
            read_normalized(&target)?
        } else {
            write_atomic(&target, current)?;
            current.to_string()
        };
        *self.path.lock().unwrap() = target;
        *self.last.lock().unwrap() = text.clone();
        write_config(app, &Config { folder: Some(dir.to_path_buf()) })?;
        if let Err(e) = self.watch(app.clone()) {
            eprintln!("watcher off: {e}");
        }
        Ok(text)
    }

    /// Append finished lines to arsip.md under today's date. Returns exactly what was
    /// appended, so "batal" can take it back off the end.
    pub fn archive(&self, date: &str, lines: &[String]) -> io::Result<String> {
        let path = self.path().with_file_name(ARCHIVE);
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let header = format!("## {date}");
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
        let path = self.path().with_file_name(ARCHIVE);
        let existing = fs::read_to_string(&path)?;
        if let Some(rest) = existing.strip_suffix(block) {
            write_atomic(&path, rest)?;
        }
        Ok(())
    }

    /// Watch the folder (not the file): atomic renames replace the file's identity.
    pub fn watch(&self, app: AppHandle) -> notify::Result<()> {
        let target = self.path();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                return;
            }
            if !event.paths.iter().any(|p| same_file(p, &target)) {
                return;
            }
            // Notepad truncates then writes; wait for the burst to settle before reading.
            thread::sleep(Duration::from_millis(100));
            let Some(text) = read_with_retry(&target) else { return };
            let state = app.state::<DocState>();
            if state.path() != target {
                return; // folder switched since this watcher started
            }
            {
                let mut last = state.last.lock().unwrap();
                if *last == text {
                    return;
                }
                *last = text.clone();
            }
            let _ = app.emit("doc-changed", text);
        })?;
        let dir = self.path().parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
        watcher.watch(&dir, RecursiveMode::NonRecursive)?;
        *self.watcher.lock().unwrap() = Some(watcher);
        Ok(())
    }
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

fn write_config(app: &AppHandle, cfg: &Config) -> io::Result<()> {
    let Some(path) = config_path(app) else { return Ok(()) };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(io::Error::other)?;
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

fn same_file(a: &Path, b: &Path) -> bool {
    a.file_name().map(|n| n.eq_ignore_ascii_case(b.file_name().unwrap_or_default())).unwrap_or(false)
}
