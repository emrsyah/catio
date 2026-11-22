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
    /// Line index: "Buka" on the notification puts the caret there.
    pub line: usize,
    pub label: String,
    /// epoch milliseconds
    pub at: i64,
    /// "15:00", formatted in local time by the webview
    pub clock: String,
    /// Which pad the line is in; "Buka" switches to it first.
    #[serde(default)]
    pub pad: String,
}

#[derive(Clone, serde::Serialize)]
struct FocusLine {
    pad: String,
    line: usize,
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
            if !state.fired.lock().unwrap().insert((format!("{}/{}", r.pad, r.label), r.at)) {
                return;
            }
            show(&app, &r);
        });
        pending.push(handle);
    }
}

/// "Tunda 5 mnt": a one-off timer outside the schedule, so a file save doesn't cancel it.
fn snooze(app: &AppHandle, r: Reminder) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5 * 60)).await;
        show(&app, &r);
    });
}

/// Windows toast with "Tunda 5 mnt" and "Buka". Clicking the body also opens the pad
/// with the caret on that line. Stays on screen until acted on (reminder scenario).
#[cfg(windows)]
fn show(app: &AppHandle, r: &Reminder) {
    use tauri::Emitter;
    use tauri_winrt_notification::{Scenario, Sound, Toast};
    // Dev builds aren't registered with Windows, so borrow PowerShell's id like the plugin does.
    let app_id = if cfg!(debug_assertions) {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let handle = app.clone();
    let reminder = r.clone();
    let result = Toast::new(&app_id)
        .title(&format!("{} · {}", r.label, r.clock))
        .text1(&if r.pad.is_empty() { "dari pad".to_string() } else { format!("dari pad {}", r.pad) })
        .sound(Some(Sound::Reminder))
        .scenario(Scenario::Reminder)
        .add_button("Tunda 5 mnt", "snooze")
        .add_button("Buka", "open")
        .on_activated(move |action| {
            if action.as_deref() == Some("snooze") {
                snooze(&handle, reminder.clone());
            } else {
                crate::pad::show(&handle);
                let _ = handle.emit("focus-line", FocusLine { pad: reminder.pad.clone(), line: reminder.line });
            }
            Ok(())
        })
        .show();
    if let Err(e) = result {
        eprintln!("toast failed, falling back: {e}");
        fallback(app, r);
    }
}

#[cfg(not(windows))]
fn show(app: &AppHandle, r: &Reminder) {
    fallback(app, r);
}

fn fallback(app: &AppHandle, r: &Reminder) {
    let _ = app
        .notification()
        .builder()
        .title(format!("{} · {}", r.label, r.clock))
        .body("dari pad")
        .show();
}
