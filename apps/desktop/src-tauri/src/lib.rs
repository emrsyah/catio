mod doc;
mod pad;
mod reminders;

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use doc::DocState;
use reminders::{Reminder, Reminders};

const HOTKEY: &str = "ctrl+alt+n";

#[derive(Serialize)]
struct Loaded {
    path: String,
    text: String,
}

#[tauri::command]
fn load_doc(doc: State<DocState>) -> Result<Loaded, String> {
    let text = doc.load().map_err(|e| e.to_string())?;
    Ok(Loaded { path: doc.path.display().to_string(), text })
}

#[tauri::command]
fn save_doc(doc: State<DocState>, text: String) -> Result<(), String> {
    doc.save(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_conflict_copy(doc: State<DocState>, text: String) -> Result<String, String> {
    doc.save_conflict_copy(&text).map(|p| p.display().to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_reminders(app: AppHandle, reminders: Vec<Reminder>) {
    reminders::schedule(&app, reminders);
}

#[tauri::command]
fn hide_pad(app: AppHandle) {
    pad::hide(&app);
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch just shows the existing pad.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| pad::show(app)))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Position and size only. Visibility is ours: the pad boots hidden.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Reminders::default())
        .setup(|app| {
            let handle = app.handle().clone();

            let doc = DocState::init(&handle)?;
            app.manage(doc);
            if let Err(e) = app.state::<DocState>().watch(handle.clone()) {
                eprintln!("watcher off: {e}");
            }

            if let Some(w) = app.get_webview_window(pad::LABEL) {
                // Keep the pad out of Zoom/Meet screen shares by default.
                // Off in dev so screenshots of the pad aren't black.
                let _ = w.set_content_protected(!cfg!(debug_assertions));
            }

            register_hotkey(&handle);
            build_tray(&handle)?;

            #[cfg(not(debug_assertions))]
            {
                let autostart = handle.autolaunch();
                if !autostart.is_enabled().unwrap_or(true) {
                    let _ = autostart.enable();
                }
            }

            let started_hidden = std::env::args().any(|a| a == "--hidden");
            if !started_hidden {
                pad::show(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Alt+F4 or the close button hides; quitting lives in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                pad::hide(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![load_doc, save_doc, save_conflict_copy, set_reminders, hide_pad])
        .run(tauri::generate_context!())
        .expect("error while running Catio");
}

fn register_hotkey(app: &AppHandle) {
    let result = app.global_shortcut().on_shortcut(HOTKEY, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            pad::toggle(app);
        }
    });
    if let Err(e) = result {
        eprintln!("hotkey {HOTKEY} unavailable: {e}");
        let _ = app
            .notification()
            .builder()
            .title("Ctrl+Alt+N udah dipakai aplikasi lain")
            .body("Buka pad dari ikon Catio di tray. Ganti hotkey nyusul di v0.1.")
            .show();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Buka pad  (Ctrl+Alt+N)", true, None::<&str>)?;
    let protect = CheckMenuItem::with_id(app, "protect", "Sembunyiin dari share screen", true, !cfg!(debug_assertions), None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Jalan waktu Windows nyala", true, autostart_on, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Buka folder catio.md", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &sep, &protect, &autostart, &folder, &sep2, &quit])?;

    let protect_item = protect.clone();
    let autostart_item = autostart.clone();
    let mut tray = TrayIconBuilder::with_id("catio")
        .tooltip("Catio")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => pad::show(app),
            "protect" => {
                let on = protect_item.is_checked().unwrap_or(true);
                if let Some(w) = app.get_webview_window(pad::LABEL) {
                    let _ = w.set_content_protected(on);
                }
            }
            "autostart" => {
                let on = autostart_item.is_checked().unwrap_or(false);
                let al = app.autolaunch();
                let _ = if on { al.enable() } else { al.disable() };
            }
            "folder" => {
                let path = app.state::<DocState>().path.clone();
                let _ = app.opener().reveal_item_in_dir(path);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                pad::toggle(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
