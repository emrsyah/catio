//! The pad window: created once, hidden, never destroyed. Showing it is just show() + focus.

use std::sync::atomic::{AtomicIsize, Ordering};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

pub const LABEL: &str = "pad";

/// The window that had focus before the hotkey, so hiding gives focus back to it.
static PREVIOUS: AtomicIsize = AtomicIsize::new(0);

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

pub fn toggle(app: &AppHandle) {
    let Some(w) = window(app) else { return };
    let visible = w.is_visible().unwrap_or(false);
    let focused = w.is_focused().unwrap_or(false);
    if visible && focused {
        hide(app);
    } else {
        show(app);
    }
}

pub fn show(app: &AppHandle) {
    let Some(w) = window(app) else { return };
    if !w.is_visible().unwrap_or(false) {
        remember_foreground();
        clamp_to_monitors(&w);
        let _ = w.show();
    }
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = app.emit("pad-shown", ());
}

pub fn hide(app: &AppHandle) {
    let Some(w) = window(app) else { return };
    // The app rarely exits cleanly (it dies at Windows shutdown), so persist position on every hide.
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
    let _ = w.hide();
    restore_foreground();
    hint_once(app);
}

/// The pad has no taskbar button, so the first hide says where it went. Once per install.
fn hint_once(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let Ok(dir) = app.path().app_data_dir() else { return };
    let marker = dir.join("hide-hint-shown");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&marker, b"");
    let _ = app
        .notification()
        .builder()
        .title("Pad masih jalan di tray")
        .body("Ctrl+Alt+N buat munculin lagi. Icon-nya ada di tray dekat jam.")
        .show();
}

/// An external monitor may have been unplugged since last time: never show off-screen.
fn clamp_to_monitors(w: &WebviewWindow) {
    let (Ok(pos), Ok(size), Ok(monitors)) = (w.outer_position(), w.outer_size(), w.available_monitors()) else {
        return;
    };
    let cx = pos.x + size.width as i32 / 2;
    let cy = pos.y + size.height as i32 / 2;
    let on_screen = monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
    });
    if !on_screen {
        if let Ok(Some(primary)) = w.primary_monitor() {
            let p = primary.position();
            let s = primary.size();
            let x = p.x + (s.width as i32 - size.width as i32) / 2;
            let y = p.y + (s.height as i32 - size.height as i32) / 3;
            let _ = w.set_position(PhysicalPosition::new(x, y));
        } else {
            let _ = w.center();
        }
    }
}

#[cfg(windows)]
fn remember_foreground() {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    PREVIOUS.store(hwnd as isize, Ordering::Relaxed);
}

#[cfg(windows)]
fn restore_foreground() {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    let prev = PREVIOUS.swap(0, Ordering::Relaxed);
    if prev != 0 {
        let hwnd = prev as HWND;
        // Windows may refuse; it then falls back to its own z-order, which is fine.
        unsafe {
            if IsWindow(hwnd) != 0 {
                SetForegroundWindow(hwnd);
            }
        }
    }
}

#[cfg(not(windows))]
fn remember_foreground() {}
#[cfg(not(windows))]
fn restore_foreground() {}
