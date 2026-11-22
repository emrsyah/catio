//! Dock mode: the pad shrinks to a small icon in the bottom-right corner of the screen.
//! Hover opens a preview you can click into and edit; moving the pointer away shrinks it again.
//! Same window as the pad, only resized and moved, so the editor state is never lost.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::pad;

const ICON: f64 = 48.0; // logical px
const OPEN_W: f64 = 380.0;
const OPEN_H: f64 = 440.0;
const MARGIN: f64 = 12.0;

static DOCKED: AtomicBool = AtomicBool::new(false);
static EXPANDED: AtomicBool = AtomicBool::new(false);
/// Pad geometry before docking, restored when leaving dock mode.
static SAVED: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>> = Mutex::new(None);

#[derive(Clone, Serialize)]
struct DockState {
    docked: bool,
    expanded: bool,
}

pub fn is_docked() -> bool {
    DOCKED.load(Ordering::Relaxed)
}

pub fn is_expanded() -> bool {
    EXPANDED.load(Ordering::Relaxed)
}

fn emit(app: &AppHandle) {
    let _ = app.emit("dock-state", DockState { docked: is_docked(), expanded: is_expanded() });
}

/// Place the window so its bottom-right corner sits MARGIN inside the work area (above the taskbar).
fn place(w: &WebviewWindow, width: f64, height: f64) {
    let Ok(Some(monitor)) = w.current_monitor().or_else(|_| w.primary_monitor()) else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (pw, ph) = ((width * scale) as u32, (height * scale) as u32);
    let m = (MARGIN * scale) as i32;
    let x = area.position.x + area.size.width as i32 - pw as i32 - m;
    let y = area.position.y + area.size.height as i32 - ph as i32 - m;
    let _ = w.set_size(PhysicalSize::new(pw, ph));
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

pub fn set_docked(app: &AppHandle, on: bool) {
    let Some(w) = app.get_webview_window(pad::LABEL) else { return };
    if on == is_docked() {
        return;
    }
    if on {
        // Don't remember a dock-sized window (e.g. the app restarted while docked).
        let scale = w.scale_factor().unwrap_or(1.0);
        if !is_full_screen(&w) {
            if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
                if s.width as f64 > (ICON + 40.0) * scale {
                    *SAVED.lock().unwrap() = Some((p, s));
                }
            }
        }
        let _ = w.unmaximize();
        let _ = w.set_resizable(false);
        DOCKED.store(true, Ordering::Relaxed);
        EXPANDED.store(false, Ordering::Relaxed);
        place(&w, ICON, ICON);
        let _ = w.show();
        pad::restore_focus();
    } else {
        DOCKED.store(false, Ordering::Relaxed);
        EXPANDED.store(false, Ordering::Relaxed);
        let _ = w.set_resizable(true);
        if let Some((p, s)) = SAVED.lock().unwrap().take() {
            let _ = w.set_size(s);
            let _ = w.set_position(p);
        } else {
            let _ = w.set_size(tauri::LogicalSize::new(380.0, 320.0));
            let _ = w.center();
        }
        pad::show(app);
    }
    emit(app);
}

/// Hover opens without taking the keyboard from the app you're in; a click (or the hotkey) does.
pub fn expand(app: &AppHandle, focus: bool) {
    let Some(w) = app.get_webview_window(pad::LABEL) else { return };
    if !is_docked() {
        return;
    }
    if !is_expanded() {
        EXPANDED.store(true, Ordering::Relaxed);
        place(&w, OPEN_W, OPEN_H);
        emit(app);
    }
    if focus && !w.is_focused().unwrap_or(false) {
        pad::remember_focus();
        let _ = w.set_focus();
        let _ = app.emit("pad-shown", ());
    }
}

pub fn collapse(app: &AppHandle) {
    let Some(w) = app.get_webview_window(pad::LABEL) else { return };
    if !is_docked() || !is_expanded() {
        return;
    }
    let had_focus = w.is_focused().unwrap_or(false);
    EXPANDED.store(false, Ordering::Relaxed);
    place(&w, ICON, ICON);
    emit(app);
    if had_focus {
        pad::restore_focus();
    }
}

pub fn toggle(app: &AppHandle) {
    if is_expanded() {
        collapse(app);
    } else {
        expand(app, true);
    }
}

fn is_full_screen(w: &WebviewWindow) -> bool {
    w.is_maximized().unwrap_or(false)
}
