mod capture;
mod doc;
mod dock;
mod pad;
mod reminders;

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use doc::DocState;
use reminders::{Reminder, Reminders};

/// Global shortcuts: (accelerator, how it's written in messages, action).
const HOTKEYS: [(&str, &str, fn(&AppHandle)); 2] = [
    ("ctrl+alt+n", "Ctrl+Alt+N", pad::toggle),
    ("alt+shift+space", "Alt+Shift+Space", capture::toggle),
];

#[derive(Serialize)]
struct Loaded {
    path: String,
    text: String,
    first_run: bool,
    /// The pad this text belongs to.
    pad: String,
}

fn loaded(doc: &DocState, text: String) -> Loaded {
    Loaded { path: doc.path().display().to_string(), text, first_run: doc.first_run, pad: doc.active() }
}

#[tauri::command]
fn load_doc(doc: State<DocState>) -> Result<Loaded, String> {
    let text = doc.load().map_err(|e| e.to_string())?;
    Ok(loaded(&doc, text))
}

#[tauri::command]
fn archive_lines(doc: State<DocState>, date: String, pad: String, lines: Vec<String>) -> Result<String, String> {
    doc.archive(&date, &pad, &lines).map_err(|e| e.to_string())
}

// ---------- pads ----------

#[tauri::command]
fn list_pads(app: AppHandle, doc: State<DocState>) -> Vec<doc::PadInfo> {
    doc.list(&app)
}

#[tauri::command]
fn switch_pad(app: AppHandle, doc: State<DocState>, name: String) -> Result<Loaded, String> {
    let text = doc.switch(&app, &name).map_err(|e| e.to_string())?;
    Ok(loaded(&doc, text))
}

/// Creates an empty pad and opens it.
#[tauri::command]
fn create_pad(app: AppHandle, doc: State<DocState>, name: String) -> Result<Loaded, String> {
    let name = doc.create(&app, &name).map_err(|e| e.to_string())?;
    let text = doc.switch(&app, &name).map_err(|e| e.to_string())?;
    Ok(loaded(&doc, text))
}

#[tauri::command]
fn rename_pad(app: AppHandle, doc: State<DocState>, old: String, name: String) -> Result<String, String> {
    doc.rename(&app, &old, &name).map_err(|e| e.to_string())
}

/// Returns where the file went (inside .terhapus), for "batal".
#[tauri::command]
fn delete_pad(doc: State<DocState>, name: String) -> Result<String, String> {
    doc.delete(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_pad(app: AppHandle, doc: State<DocState>, trashed: String, name: String) -> Result<String, String> {
    doc.restore(&app, &trashed, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn unarchive(doc: State<DocState>, block: String) -> Result<(), String> {
    doc.unarchive(&block).map_err(|e| e.to_string())
}

/// Folder picker parented to the pad (so it isn't hidden behind an always-on-top window).
/// Returns the new location and its text, or None when cancelled.
#[tauri::command]
async fn choose_folder(app: AppHandle, current: String) -> Result<Option<Loaded>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title("Simpan catio.md di folder…");
    if let Some(w) = app.get_webview_window(pad::LABEL) {
        dialog = dialog.set_parent(&w);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    let Some(dir) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let doc = app.state::<DocState>();
    let text = doc.switch_folder(&app, &dir, &current).map_err(|e| e.to_string())?;
    Ok(Some(Loaded { first_run: false, ..loaded(&doc, text) }))
}

#[tauri::command]
fn save_doc(doc: State<DocState>, pad: String, text: String) -> Result<(), String> {
    doc.save(&pad, &text).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_pad(doc: State<DocState>, name: String) -> Result<String, String> {
    doc.read(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_archive(doc: State<DocState>) -> String {
    doc.read_archive()
}

/// arsip.md in the default editor (search results from the archive open there).
#[tauri::command]
fn open_archive(app: AppHandle, doc: State<DocState>) -> Result<(), String> {
    app.opener().open_path(doc.archive_path().display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// Ctrl+click on a link. http(s) only: nothing else in a note may launch a program.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || url.chars().any(char::is_whitespace) {
        return Err("bukan link http(s)".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// The pad a captured line goes to (shown in the capture window).
#[tauri::command]
fn capture_target(doc: State<DocState>) -> String {
    doc.active()
}

/// The webview owns the "fade when idle" choice (localStorage); the tray checkbox mirrors it.
struct IdleMenu(CheckMenuItem<tauri::Wry>);

#[tauri::command]
fn sync_idle_menu(app: AppHandle, on: bool) {
    if let Some(item) = app.try_state::<IdleMenu>() {
        let _ = item.0.set_checked(on);
    }
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

/// Keeps the tray checkbox in sync when dock mode is toggled from the pad.
struct DockMenu(CheckMenuItem<tauri::Wry>);

#[tauri::command]
fn set_dock(app: AppHandle, on: bool) {
    dock::set_docked(&app, on);
    if let Some(item) = app.try_state::<DockMenu>() {
        let _ = item.0.set_checked(on);
    }
}

#[tauri::command]
fn dock_expand(app: AppHandle, focus: bool) {
    dock::expand(&app, focus);
}

#[tauri::command]
fn dock_collapse(app: AppHandle) {
    dock::collapse(&app);
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch just shows the existing pad.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| pad::show(app)))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Position and size only. Visibility is ours: the pad boots hidden.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                // The capture field always opens centered.
                .with_denylist(&[capture::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
                dock::fix_startup_size(&w);
            }

            register_hotkeys(&handle);
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
            // Alt+F4 or the close button hides that window; quitting lives in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == capture::LABEL {
                    capture::hide(window.app_handle());
                } else {
                    pad::hide(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_doc,
            save_doc,
            save_conflict_copy,
            set_reminders,
            hide_pad,
            archive_lines,
            unarchive,
            choose_folder,
            set_dock,
            dock_expand,
            dock_collapse,
            list_pads,
            switch_pad,
            create_pad,
            rename_pad,
            delete_pad,
            restore_pad,
            read_pad,
            read_archive,
            open_archive,
            open_url,
            capture_target,
            sync_idle_menu,
            capture::capture_submit,
            capture::capture_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Catio");
}

fn register_hotkeys(app: &AppHandle) {
    for (key, name, action) in HOTKEYS {
        let result = app.global_shortcut().on_shortcut(key, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                action(app);
            }
        });
        if let Err(e) = result {
            eprintln!("hotkey {key} unavailable: {e}");
            let _ = app
                .notification()
                .builder()
                .title(format!("{name} udah dipakai aplikasi lain"))
                .body("Pakai menu Catio di tray buat sementara. Ganti hotkey nyusul di v0.1.")
                .show();
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Buka pad  (Ctrl+Alt+N)", true, None::<&str>)?;
    let capture_item = MenuItem::with_id(app, "capture", "Tangkap cepat  (Alt+Shift+Space)", true, None::<&str>)?;
    let dock_item = CheckMenuItem::with_id(app, "dock", "Mode dock (pojok kanan bawah)", true, false, None::<&str>)?;
    app.manage(DockMenu(dock_item.clone()));
    let idle = CheckMenuItem::with_id(app, "idle", "Tipis pas nggak dipakai", true, true, None::<&str>)?;
    app.manage(IdleMenu(idle.clone()));
    let protect = CheckMenuItem::with_id(app, "protect", "Sembunyiin dari share screen", true, !cfg!(debug_assertions), None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", if cfg!(windows) { "Jalan waktu Windows nyala" } else { "Jalan waktu komputer nyala" }, true, autostart_on, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Buka folder Catio", true, None::<&str>)?;
    let move_folder = MenuItem::with_id(app, "move-folder", "Pindahin folder Catio…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show, &capture_item, &dock_item, &sep, &idle, &protect, &autostart, &folder, &move_folder, &sep2, &quit],
    )?;

    let protect_item = protect.clone();
    let idle_item = idle.clone();
    let autostart_item = autostart.clone();
    let mut tray = TrayIconBuilder::with_id("catio")
        .tooltip("Catio")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => pad::show(app),
            "capture" => capture::show(app),
            "idle" => {
                let _ = app.emit("idle-fade", idle_item.is_checked().unwrap_or(true));
            }
            "dock" => {
                // The webview persists the choice and calls set_dock, so both paths stay in sync.
                let on = !dock::is_docked();
                let _ = app.emit("dock-request", on);
            }
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
                let path = app.state::<DocState>().path();
                let _ = app.opener().reveal_item_in_dir(path);
            }
            "move-folder" => {
                // The webview owns the current text, so it runs the picker and the switch.
                pad::show(app);
                let _ = app.emit("choose-folder", ());
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
