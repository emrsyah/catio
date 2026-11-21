//! Reminder timers live in Rust so they fire while the pad is hidden.
//! The webview parses the file with @catio/core and hands over absolute times.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Deserialize)]
pub struct Reminder {
    /// Line index for "Buka" on the notification (v0.1: jump the caret there).
    #[allow(dead_code)]
    pub line: usize,
    pub label: String,
    /// epoch milliseconds
    pub at: i64,
    /// "15:00", formatted in local time by the webview
    pub clock: String,
}

#[derive(Default)]
pub struct Reminders {
    generation: AtomicU64,
    fired: Mutex<HashSet<(String, i64)>>,
    pending: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Replace every pending timer. Cheap: a pad holds a handful of timed to-dos.
pub fn schedule(app: &AppHandle, list: Vec<Reminder>) {
    let state = app.state::<Reminders>();
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let now = now_ms();
    let mut pending = state.pending.lock().unwrap();
    for old in pending.drain(..) {
        old.abort();
    }
    for r in list.into_iter().filter(|r| r.at > now) {
        let app = app.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let wait = (r.at - now_ms()).max(0) as u64;
            tokio::time::sleep(Duration::from_millis(wait)).await;
            let state = app.state::<Reminders>();
            if state.generation.load(Ordering::SeqCst) != gen {
                return; // the file changed since; a newer schedule owns this reminder
            }
            if !state.fired.lock().unwrap().insert((r.label.clone(), r.at)) {
                return;
            }
            let _ = app
                .notification()
                .builder()
                .title(format!("{} · {}", r.label, r.clock))
                .body("dari pad")
                .show();
        });
        pending.push(handle);
    }
}
