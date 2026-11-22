//! Quick capture: a one-line field over whatever you're doing (Alt+Shift+Space). Enter sends
//! the line to the pad webview, which inserts it under "---" and saves; the field hides and
//! focus goes back to the app you were in. Created on first use, then hidden and reused.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::pad;

pub const LABEL: &str = "capture";
const WIDTH: f64 = 520.0;
const HEIGHT: f64 = 148.0;

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("capture.html".into()))
        .title("Catio · tangkap cepat")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()
        .map_err(|e| eprintln!("capture window: {e}"))
        .ok()?;
    // Same as the pad: stays out of screen shares in release.
    let _ = w.set_content_protected(!cfg!(debug_assertions));
    Some(w)
}

pub fn toggle(app: &AppHandle) {
    let visible = app
        .get_webview_window(LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        hide(app);
    } else {
        show(app);
    }
}

pub fn show(app: &AppHandle) {
    let Some(w) = window(app) else { return };
    pad::remember_focus();
    let _ = w.center();
    let _ = w.show();
    let _ = w.set_focus();
    let target = app.state::<crate::doc::DocState>().active();
    let _ = w.emit("capture-open", target);
}

pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
    pad::restore_focus();
}

#[tauri::command]
pub fn capture_submit(app: AppHandle, text: String) {
    let _ = app.emit_to(pad::LABEL, "capture-line", text);
    hide(&app);
}

#[tauri::command]
pub fn capture_close(app: AppHandle) {
    hide(&app);
}
