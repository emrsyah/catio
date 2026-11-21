//! catio.md on disk: atomic save, external-change watcher, conflict copies.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

const STARTER: &str = "[ ] coba centang baris ini pakai Ctrl+Enter
[ ] baris di atas garis --- itu fokus hari ini
---
catatan bebas di bawah garis.
tulis jam di to-do, misal [ ] call dokter 15:00, nanti diingetin.
Ctrl+Alt+N buat munculin atau sembunyiin pad.
";

pub struct DocState {
    pub path: PathBuf,
    /// Last content we wrote or loaded. The watcher ignores events that match it,
    /// which is how our own saves don't bounce back as "external" changes.
    last: Mutex<String>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl DocState {
    pub fn init(app: &AppHandle) -> io::Result<Self> {
        let dir = app
            .path()
            .document_dir()
            .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e.to_string()))?
            .join("Catio");
        fs::create_dir_all(&dir)?;
        let path = dir.join("catio.md");
        if !path.exists() {
            write_atomic(&path, STARTER)?;
        }
        let text = read_normalized(&path)?;
        Ok(Self { path, last: Mutex::new(text), watcher: Mutex::new(None) })
    }

    pub fn load(&self) -> io::Result<String> {
        let text = read_normalized(&self.path)?;
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
        write_atomic(&self.path, text)?;
        *last = text.to_string();
        Ok(())
    }

    pub fn save_conflict_copy(&self, text: &str) -> io::Result<PathBuf> {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let copy = self.path.with_file_name(format!("catio.conflict-{secs}.md"));
        write_atomic(&copy, text)?;
        Ok(copy)
    }

    /// Watch the folder (not the file): atomic renames replace the file's identity.
    pub fn watch(&self, app: AppHandle) -> notify::Result<()> {
        let target = self.path.clone();
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
            {
                let mut last = state.last.lock().unwrap();
                if *last == text {
                    return;
                }
                *last = text.clone();
            }
            let _ = app.emit("doc-changed", text);
        })?;
        let dir = self.path.parent().unwrap_or(Path::new("."));
        watcher.watch(dir, RecursiveMode::NonRecursive)?;
        *self.watcher.lock().unwrap() = Some(watcher);
        Ok(())
    }
}

/// tmp file + fsync + rename: a crash or forced reboot leaves either the old or the new file, never half.
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let tmp = path.with_extension("md.tmp");
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
