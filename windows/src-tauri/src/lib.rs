// vufh for Windows — app wiring and the commands the island calls.

mod chat;
mod claude;
mod desktop;
mod files;
mod flow;
mod github;
mod i18n;
mod identity;
mod integrations;
mod island;
mod local_chat;
mod log;
mod net;
mod notes;
mod openai_compat;
mod orchestrator;
mod platform;
#[cfg(target_os = "linux")]
mod portal;
mod secrets;
mod settings;
mod shortcuts;
mod sounds;
mod speech;
mod spotify;
mod tray;
mod voice;
#[cfg(windows)]
mod webview_drop;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use chat::{Chat, ChatContext, ChatReply, ModelInfo};
use files::DroppedFile;
use island::{PollGate, ScreenInfo};
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let settings = shared.settings.lock().unwrap().clone();
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, shortcuts_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let shortcuts_changed = current.shortcuts != settings.shortcuts;
        // Where Mochi sits on the desktop is desktop.rs's to say, not a webview's.
        let mut settings = settings.clone();
        settings.desktop_mochi = current.desktop_mochi.clone();
        *current = settings;
        (screen_changed, autostart_changed, shortcuts_changed)
    };
    let settings = shared.settings.lock().unwrap().clone();
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[vufh] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    integrations::settings_saved(&app, &settings.active_integrations);
    spotify::sync(&app, &settings.active_integrations);
    if shortcuts_changed {
        shortcuts::apply(&app, &settings.shortcuts);
    }
    if i18n::set_picked(&settings.language) {
        language_changed(&app);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// The island reports the system's languages at launch, for "System" in
/// Settings → Language (WebView2 and WebKitGTK know them best).
#[tauri::command]
fn set_system_languages(app: AppHandle, languages: Vec<String>) {
    if i18n::set_system(languages) {
        language_changed(&app);
    }
}

/// What Rust labels itself follows the new language: the tray menu and the
/// settings window's title. The webviews switch on their own.
fn language_changed(app: &AppHandle) {
    tray::retitle(app);
    if let Some(window) = app.get_webview_window(HUB_LABEL) {
        let _ = window.set_title("vufh");
    }
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
    platform::set_pointer_watch(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

/// The panel is laid out in CSS px against the window's own scale. If the webview
/// reports a different devicePixelRatio (it ends up bigger than the window and gets
/// cut), correct its zoom so one CSS px is one logical px again.
#[tauri::command]
fn fit_zoom(app: AppHandle, dpr: f64) -> bool {
    let Some(win) = island::window(&app) else { return false };
    let scale = win.scale_factor().unwrap_or(1.0);
    static ZOOM: std::sync::Mutex<f64> = std::sync::Mutex::new(1.0);
    let mut zoom = ZOOM.lock().unwrap();
    if let Some(new_zoom) = island::calculate_zoom_correction(*zoom, scale, dpr) {
        *zoom = new_zoom;
        log::line(format!("webview dpr {dpr} != window scale {scale} — setting zoom {new_zoom:.3}"));
        let _ = win.set_zoom(new_zoom);
        true
    } else {
        false
    }
}


/// The displays the island can be pinned to, for Settings.
#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<island::MonitorChoice> {
    island::monitor_choices(&app)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Approvals ─────────────────────────────────────────────────────────────────

/// Allow or Deny on the island's card. Every request comes from the
/// orchestrator backend, which owns the approval and waits for the answer.
#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    if orchestrator::owns(&request_id) {
        orchestrator::answer(&app, &request_id, &decision);
    }
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn with the provider picked in the chat view. API keys and any
/// file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let settings = shared.settings.lock().unwrap().clone();
    chat::send(&app, &chat, &settings, query, context).await
}

/// The models a provider offers, for the picker in the chat view. Only asked
/// once the user picked that provider, and only with its key or address.
#[tauri::command]
async fn chat_models(shared: State<'_, Shared>, provider: String) -> Result<Vec<ModelInfo>, String> {
    let settings = shared.settings.lock().unwrap().clone();
    chat::models(&settings, &provider).await
}

/// Settings → Local models → Connect: does the server answer, and with which models?
#[tauri::command]
async fn local_connect(provider: String, url: String) -> Result<local_chat::Connected, String> {
    local_chat::connect(&provider, &url).await
}

/// Stores the custom server's key for the address typed next to it; it is only
/// ever sent to that address.
#[tauri::command]
fn local_set_key(url: String, key: String) -> Result<(), String> {
    local_chat::set_custom_key(&url, &key)
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // Bound to its server's address: only local_set_key may store it.
    if key == local_chat::CUSTOM_KEY {
        return Err("use local_set_key".into());
    }
    let before = (key == "github-token").then(|| secrets::get(&key));
    secrets::set(&key, &value)?;
    if key == claude::KEY {
        voice::sync(&app);
    }
    if let Some(before) = before {
        if secrets::get(&key) != before {
            integrations::github_token_changed(&app);
        }
    }
    Ok(())
}

#[tauri::command]
fn secret_clear(app: AppHandle, key: String) -> Result<(), String> {
    let had = key == "github-token" && secrets::present(&key);
    secrets::clear(&key)?;
    if key == claude::KEY {
        voice::sync(&app);
    }
    if had {
        integrations::github_token_changed(&app);
    }
    Ok(())
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// The GitHub card was opened: refetch its `section` ("pulse" or "activity")
/// if it is stale. The pollers still decline while the pill is off or paused.
#[tauri::command]
fn github_refresh(section: String) {
    integrations::github_refresh_if_stale(&section);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// How each global shortcut went: registered, taken by another app, and so on.
#[tauri::command]
fn shortcuts_status(app: AppHandle) -> shortcuts::Report {
    shortcuts::status(&app)
}

/// Settings is recording a new combination: let go of ours meanwhile, so the
/// keys reach the recorder instead of running an action. `false` takes them back.
#[tauri::command]
fn shortcuts_suspend(app: AppHandle, shared: State<Shared>, suspended: bool) {
    if suspended {
        shortcuts::suspend(&app);
    } else {
        let stored = shared.settings.lock().unwrap().shortcuts.clone();
        shortcuts::apply(&app, &stored);
    }
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    page_url(app, "settings.html")
}

fn page_url(app: &AppHandle, page: &str) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path(&format!("/{page}"));
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App(page.into())
}

/// The vufh window (Flow dictation, the Notetaker and every setting of the
/// island), labelled "settings" since it grew out of the settings window.
pub const HUB_LABEL: &str = "settings";

/// The vufh window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, HUB_LABEL, url)
        .additional_browser_args(BROWSER_ARGS)
        .title("vufh")
        .inner_size(1100.0, 720.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        // Borderless: the page draws its own title bar (views/titlebar.ts).
        .decorations(false)
        .shadow(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            let this = win.clone();
            win.on_window_event(move |event| match event {
                // Closing it must only hide it, or it could never be reopened.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = this.hide();
                    set_hub_shown(&this, false);
                }
                // Minimised (a 0×0 resize on Windows) or back from it.
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true) => {
                    let on = this.is_visible().unwrap_or(false) && !this.is_minimized().unwrap_or(false);
                    set_hub_shown(&this, on);
                }
                _ => {}
            });
        }
        Err(err) => log::line(format!("vufh window failed: {err}")),
    }
}

/// Whether the vufh window is on screen (shown and not minimised). Its page
/// animates its canvases only then (hub/hero.ts): WebKitGTK can keep
/// `document.visibilityState` at "visible" for a hidden window, and its
/// animation loop then kept a core busy with the window closed (#792).
static HUB_SHOWN: AtomicBool = AtomicBool::new(false);

fn set_hub_shown(win: &tauri::WebviewWindow, shown: bool) {
    if HUB_SHOWN.swap(shown, Ordering::Relaxed) != shown {
        let _ = win.emit_to(HUB_LABEL, "hub-visible", shown);
    }
}

/// The page asks once at load, in case it missed the event.
#[tauri::command]
fn hub_shown() -> bool {
    HUB_SHOWN.load(Ordering::Relaxed)
}

pub fn show_settings_window(app: &AppHandle) {
    show_hub(app, Some("general"));
}

/// Shows the vufh window, on `page` when given ("dictation", "notes",
/// "settings", "general", "shortcuts"…).
pub fn show_hub(app: &AppHandle, page: Option<&str>) {
    let Some(win) = app.get_webview_window(HUB_LABEL) else {
        log::line("vufh window missing");
        return;
    };
    if let Some(page) = page {
        let _ = win.emit("hub-page", page.to_string());
    }
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    set_hub_shown(&win, true);
}

// ── vufh HQ ─────────────────────────────────────────────────────────────────

/// vufh HQ: the agents and their teams, out of the notch, with room to talk to them.
pub const HQ_LABEL: &str = "hq";

/// Created hidden at launch like the vufh window, for the same reason (see
/// create_settings_window).
fn create_hq_window(app: &AppHandle) {
    let builder = WebviewWindowBuilder::new(app, HQ_LABEL, page_url(app, "hq.html"));
    // On Windows WebView2 takes files dropped on the composer itself, as on
    // the island (webview_drop.rs).
    #[cfg(windows)]
    let builder = builder.disable_drag_drop_handler();
    match builder
        .additional_browser_args(BROWSER_ARGS)
        .title("vufh HQ")
        .inner_size(1100.0, 760.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .decorations(false)
        .shadow(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            let this = win.clone();
            win.on_window_event(move |event| match event {
                // Closing it must only hide it, or it could never be reopened.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = this.hide();
                    set_hq_shown(&this, false);
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true) => {
                    let on = this.is_visible().unwrap_or(false) && !this.is_minimized().unwrap_or(false);
                    set_hq_shown(&this, on);
                }
                // Where Tauri takes the drop (Linux), those paths may be attached (files.rs).
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                }
                _ => {}
            });
            #[cfg(windows)]
            webview_drop::install(app, HQ_LABEL);
        }
        Err(err) => log::line(format!("vufh HQ window failed: {err}")),
    }
}

/// Whether vufh HQ is on screen, so its minis animate only then (like HUB_SHOWN).
static HQ_SHOWN: AtomicBool = AtomicBool::new(false);

fn set_hq_shown(win: &tauri::WebviewWindow, shown: bool) {
    if HQ_SHOWN.swap(shown, Ordering::Relaxed) != shown {
        let _ = win.emit_to(HQ_LABEL, "hq-visible", shown);
    }
}

/// The page asks once at load, in case it missed the event.
#[tauri::command]
fn hq_shown() -> bool {
    HQ_SHOWN.load(Ordering::Relaxed)
}

/// Shows vufh HQ, on `agent_id`'s thread when given.
pub fn show_hq_window(app: &AppHandle, agent_id: Option<&str>) {
    let Some(win) = app.get_webview_window(HQ_LABEL) else {
        log::line("vufh HQ window missing");
        return;
    };
    let _ = win.emit_to(HQ_LABEL, "hq-open", serde_json::json!({ "agentId": agent_id }));
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    set_hq_shown(&win, true);
}

#[tauri::command]
fn show_hq(app: AppHandle, agent_id: Option<String>) {
    show_hq_window(&app, agent_id.as_deref());
}

/// The argument the login item starts vufh with.
const AUTOSTART_ARG: &str = "--autostart";

/// vufh started with the computer, not opened by the user: the window stays hidden.
pub fn launched_at_login() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

/// Whether vufh HQ opens after the greeting: the user opened vufh (it did
/// not start with the computer) and left "Open vufh HQ when you open vufh" on.
#[tauri::command]
fn open_hq_at_launch(app: AppHandle) -> bool {
    !launched_at_login() && flow::get(&app).map(|f| f.store.lock().unwrap().prefs.open_at_launch).unwrap_or(true)
}

#[tauri::command]
fn open_settings_window(app: AppHandle, page: Option<String>) {
    show_hub(&app, Some(page.as_deref().unwrap_or("general")));
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    i18n::set_picked(&loaded.language);
    let gate = Arc::new(PollGate::new());

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `vufh --shortcut <action>`: what a desktop's own keyboard
            // settings run where we can't listen for keys ourselves (Wayland).
            match shortcuts::from_args(&argv) {
                Some(action) => shortcuts::dispatch(app, action),
                // Opening vufh again (its shortcut, the Start menu) shows vufh HQ.
                None => show_hq_window(app, None),
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])));
    // Where no global shortcut can work, the plugin isn't even started.
    if platform::global_shortcuts_blocked().is_none() {
        builder = builder.plugin(shortcuts::plugin());
    }

    builder
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Chat::default())
        .manage(shortcuts::Registry::default())
        .manage(orchestrator::new())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_system_languages,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            fit_zoom,
            hub_shown,
            hq_shown,
            show_hq,
            open_hq_at_launch,
            list_monitors,
            open_url,
            quit_app,
            approval_decision,
            log_line,
            chat_send,
            chat_models,
            local_connect,
            local_set_key,
            chat_reset,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            github_refresh,
            open_n8n,
            open_settings_window,
            set_paused,
            shortcuts_status,
            shortcuts_suspend,
            orchestrator::orchestrator_status,
            orchestrator::orchestrator_set_prefs,
            orchestrator::orchestrator_tasks,
            orchestrator::orchestrator_list_tasks,
            orchestrator::orchestrator_task,
            orchestrator::orchestrator_submit,
            orchestrator::orchestrator_attach,
            orchestrator::orchestrator_models,
            orchestrator::orchestrator_cancel,
            orchestrator::orchestrator_answer,
            orchestrator::orchestrator_pause_task,
            orchestrator::orchestrator_resume_task,
            orchestrator::orchestrator_agents,
            orchestrator::orchestrator_pause_agent,
            orchestrator::orchestrator_resume_agent,
            orchestrator::orchestrator_set_limits,
            orchestrator::orchestrator_set_rules,
            orchestrator::orchestrator_github,
            orchestrator::orchestrator_github_connect,
            orchestrator::orchestrator_github_disconnect,
            orchestrator::orchestrator_update_agent,
            orchestrator::orchestrator_create_agent,
            orchestrator::orchestrator_retire_agent,
            orchestrator::orchestrator_create_team,
            orchestrator::orchestrator_update_team,
            orchestrator::orchestrator_delete_team,
            orchestrator::orchestrator_decide,
            orchestrator::orchestrator_files,
            orchestrator::orchestrator_save_file,
            orchestrator::orchestrator_chat_history,
            orchestrator::orchestrator_goals,
            orchestrator::orchestrator_create_goal,
            orchestrator::orchestrator_update_goal,
            orchestrator::orchestrator_delete_goal,
            orchestrator::orchestrator_run_goal,
            orchestrator::orchestrator_memory,
            orchestrator::orchestrator_add_memory,
            orchestrator::orchestrator_delete_memory,
            desktop::desktop_mochi_info,
            desktop::desktop_mochi_pick_up,
            desktop::desktop_mochi_carry,
            desktop::desktop_mochi_carry_end,
            desktop::desktop_mochi_drag_begin,
            desktop::desktop_mochi_drag_move,
            desktop::desktop_mochi_drag_end,
            desktop::desktop_mochi_fly_out,
            desktop::desktop_mochi_fly_home,
            desktop::desktop_mochi_set_asleep,
            sounds::custom_sounds,
            sounds::custom_sound,
            sounds::reveal_sounds_folder,
            sounds::reload_sounds,
            spotify::spotify_refresh,
            spotify::spotify_control,
            spotify::spotify_open,
            spotify::spotify_installed,
            flow::flow_status,
            flow::flow_set_prefs,
            flow::flow_history,
            flow::flow_delete,
            flow::flow_clear,
            flow::flow_stats,
            flow::flow_words,
            flow::flow_set_words,
            flow::flow_snippets,
            flow::flow_set_snippets,
            flow::flow_styles,
            flow::flow_set_styles,
            flow::flow_running_apps,
            flow::flow_copy,
            flow::flow_paste_again,
            flow::flow_models_download,
            flow::flow_models_remove,
            flow::pill_state,
            flow::pill_hot,
            flow::pill_hover,
            flow::pill_action,
            flow::hq_dictation_start,
            flow::hq_dictation_stop,
            flow::hq_dictation_cancel,
            notes::notes_state,
            notes::notes_start,
            notes::notes_stop,
            notes::notes_rename,
            notes::notes_rename_speaker,
            notes::notes_toggle_todo,
            notes::notes_delete,
            notes::notes_summarize,
            notes::notes_retry,
            notes::notes_markdown,
            notes::notes_export,
            voice::voice_done,
            voice::voice_say_native,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            create_hq_window(&handle);
            // Same rule for Mochi's desktop window and the dictation pill.
            desktop::setup(&handle);
            flow::setup(&handle);
            notes::setup(&handle);

            if let Some(win) = island::window(&handle) {
                // Where Tauri takes the drop itself (Linux), its paths are the
                // ones ingest_file may copy (files.rs).
                win.on_window_event(|event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                    }
                });
                platform::make_non_activating(&win);
                #[cfg(windows)]
                webview_drop::install(&handle, island::WINDOW_LABEL);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- vufh {} started ---", env!("CARGO_PKG_VERSION")));
            integrations::start(handle.clone());
            orchestrator::setup(&handle);
            spotify::sync(&handle, &loaded.active_integrations);
            shortcuts::apply(&handle, &loaded.shortcuts);
            if loaded.autostart {
                // Login items written before 0.5 start vufh without --autostart:
                // writing it again adds it, so the window stays hidden at login.
                let _ = handle.autolaunch().enable();
            }
            // vufh HQ opens once the island's greeting is over (src/main.ts).
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building vufh")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                notes::shutdown(app);
            }
        });
}
