// Coucou as the control surface of the orchestrator backend (orchestrator/ at
// the repository root): tasks run there and in the agent's own Linux VM, never
// here. See orchestrator/README.md.
//
// Off until the user turns it on from the Tasks page. Once on, one background
// task keeps an event stream open to the backend and turns each event into
// the hook payload the island already understands — an `agent_<id>` pill, its
// steps, the approval card, the final line — so the island needs no new view.
// Heartbeats and tool output stay out of the island: a hidden island still
// costs nothing. The Tasks page gets every event as `orchestrator-event`.
//
// When nothing answers, Coucou starts the backend itself (node, from the
// orchestrator folder: the one picked on the Tasks page, else the repository a
// dev build sits in) and leaves it running when it quits.
//
// The access token is the backend's own: it writes it to the Credential
// Manager on its first start, under Coucou's service name, and only Rust reads
// it. The backend's address must be this machine, so the token cannot be sent
// anywhere else.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::i18n::{t, tf};
use crate::island::WINDOW_LABEL;
use crate::{integrations, log, net, platform, secrets};

/// Credential Manager entry the backend writes (orchestrator/server/src/tokens.ts).
pub const TOKEN_KEY: &str = "orchestrator-token";
pub const DEFAULT_URL: &str = "http://127.0.0.1:47620";
/// Approval request ids handed to the island: `orch:<agent>:<approval>`.
const REQUEST_PREFIX: &str = "orch:";
/// A file request waits up to 30 s for the worker on the backend's side.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(40);
/// The backend pings every 15 s; this long without a byte means the stream is dead.
const STREAM_IDLE: Duration = Duration::from_secs(45);
const MAX_EVENT: usize = 1 << 20;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub enabled: bool,
    pub url: String,
    /// Start the backend when nothing answers at `url`.
    pub start_backend: bool,
    /// The orchestrator folder to start it from; empty: the repository this build came from.
    pub backend_dir: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { enabled: false, url: DEFAULT_URL.into(), start_backend: true, backend_dir: String::new() }
    }
}

/// How the connection is, for the Tasks page. Never the token.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "off", "connecting", "connected", "noToken" or "unreachable".
    pub state: &'static str,
    pub error: Option<String>,
}

pub struct Orchestrator {
    prefs: Mutex<Prefs>,
    status: Mutex<Status>,
    wake: Notify,
    /// When Coucou last started the backend.
    started: Mutex<Option<Instant>>,
}

fn state(app: &AppHandle) -> tauri::State<'_, Orchestrator> {
    app.state::<Orchestrator>()
}

fn prefs_path() -> PathBuf {
    platform::config_dir().join("orchestrator.json")
}

fn load_prefs() -> Prefs {
    std::fs::read(prefs_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_prefs(prefs: &Prefs) -> Result<(), String> {
    let path = prefs_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// The backend's address, refused unless it is this machine.
pub fn base_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| t("The backend must run on this computer, e.g. http://127.0.0.1:47620"))?;
    if url.scheme() != "http" || !net::is_loopback_url(&url) {
        return Err(t("The backend must run on this computer, e.g. http://127.0.0.1:47620"));
    }
    Ok(url)
}

fn set_status(app: &AppHandle, state_name: &'static str, error: Option<String>) {
    let next = Status { state: state_name, error };
    let orchestrator = state(app);
    let changed = {
        let mut status = orchestrator.status.lock().unwrap();
        let changed = status.state != next.state || status.error != next.error;
        *status = next.clone();
        changed
    };
    if changed {
        let _ = app.emit("orchestrator-status", next);
    }
}

// ── Requests ──────────────────────────────────────────────────────────────────

/// The backend's error message: `message` when it gives one, else `error`.
fn detail(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("message").or_else(|| v.get("error")).and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(body).chars().take(200).collect())
}

fn token() -> Result<String, String> {
    secrets::get_internal(TOKEN_KEY).ok_or_else(|| t("Start the orchestrator backend once: it creates the key Coucou needs."))
}

async fn request(app: &AppHandle, method: Method, path: &str, body: Option<Value>) -> Result<Vec<u8>, String> {
    send(app, method, path, &[], |req| match body {
        Some(body) => req.json(&body),
        None => req,
    })
    .await
}

/// `path` on the backend with `query` (encoded here), the body set by `with`.
async fn send(
    app: &AppHandle,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    with: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> Result<Vec<u8>, String> {
    let url = state(app).prefs.lock().unwrap().url.clone();
    let base = base_url(&url)?;
    let client = net::client(&base, REQUEST_TIMEOUT)?;
    let mut target = Url::parse(&net::join(&base, path)).map_err(|e| e.to_string())?;
    if !query.is_empty() {
        target.query_pairs_mut().extend_pairs(query);
    }
    let req = with(client.request(method, target).bearer_auth(token()?));
    let response = req
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;
    let status = response.status();
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    if !status.is_success() {
        return Err(format!("{} ({})", detail(&bytes), status.as_u16()));
    }
    Ok(bytes)
}

async fn api(app: &AppHandle, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let bytes = request(app, method, path, body).await?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// A path segment from the webview: letters, digits, `-` and `_` only.
fn segment(raw: &str) -> Result<&str, String> {
    if !raw.is_empty() && raw.len() <= 64 && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        Ok(raw)
    } else {
        Err("invalid id".into())
    }
}

// ── Events → island ───────────────────────────────────────────────────────────

/// What the island is told about one backend event: `("hook", payload)` for
/// the hook handler, or a card to take down. Pure, so it is tested below.
pub fn translate(event: &Value) -> Vec<(&'static str, Value)> {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    let agent = event.get("agentId").and_then(Value::as_str).unwrap_or("");
    let p = event.get("payload").cloned().unwrap_or_else(|| json!({}));
    if kind == "goal.updated" || kind == "memory.updated" || kind == "team.updated" {
        return vec![(
            "orchestrator-refresh",
            json!({
                "agentId": agent,
                "kind": if kind == "goal.updated" { "goals" } else if kind == "memory.updated" { "memory" } else { "teams" },
            }),
        )];
    }
    let Some(task) = event.get("taskId").and_then(Value::as_str) else {
        return Vec::new(); // Other agent-level events belong to the Tasks page.
    };
    let text = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let hook = |name: &str, extra: Value| {
        let mut payload = json!({
            "hook_event_name": name,
            "coucou_agent": agent,
            "session_id": format!("{REQUEST_PREFIX}{task}"),
        });
        if let (Some(map), Value::Object(more)) = (payload.as_object_mut(), extra) {
            map.extend(more);
        }
        ("hook", payload)
    };
    match kind {
        "task.started" => vec![hook("UserPromptSubmit", json!({ "prompt": text("prompt") }))],
        "tool.started" => vec![hook(
            "PreToolUse",
            json!({ "tool_name": island_tool(&text("op")), "tool_input": { "query": text("target") } }),
        )],
        "tool.completed" if p.get("ok") == Some(&Value::Bool(false)) => {
            vec![hook("PostToolUseFailure", json!({ "tool_name": island_tool(&text("op")) }))]
        }
        "approval.requested" => vec![hook(
            "PermissionRequest",
            json!({
                "request_id": format!("{REQUEST_PREFIX}{agent}:{}", text("approvalId")),
                "tool_name": approval_tool(&text("op")),
                "tool_input": { "command": text("target") },
            }),
        )],
        "approval.resolved" => vec![(
            "orchestrator-approval-resolved",
            json!({ "requestId": format!("{REQUEST_PREFIX}{agent}:{}", text("approvalId")) }),
        )],
        // Questions belong in the persistent agent chat. They deliberately do
        // not become AskUserQuestion: that would open Claude Code's modal card.
        "task.question" => vec![(
            "orchestrator-task-state",
            json!({ "agentId": agent, "taskId": task, "state": "question" }),
        )],
        "task.answered" | "task.resumed" => vec![(
            "orchestrator-task-state",
            json!({ "agentId": agent, "taskId": task, "state": "working" }),
        )],
        "task.paused" => vec![(
            "orchestrator-task-state",
            json!({ "agentId": agent, "taskId": task, "state": "idle" }),
        )],
        "task.waiting_for_agents" => vec![(
            "orchestrator-task-state",
            json!({
                "agentId": agent,
                "taskId": task,
                "state": "waiting_for_agents",
                "childTaskIds": p.get("childTaskIds"),
            }),
        )],
        "agent.delegated" => vec![(
            "orchestrator-delegated",
            json!({
                "agentId": agent,
                "taskId": task,
                "toAgentId": p.get("toAgentId"),
                "childTaskId": p.get("childTaskId"),
                "message": p.get("message"),
            }),
        )],
        "agent.reported" => vec![(
            "orchestrator-reported",
            json!({
                "agentId": agent,
                "taskId": task,
                "fromAgentId": p.get("fromAgentId"),
                "childTaskId": p.get("childTaskId"),
                "status": p.get("status"),
                "summary": p.get("summary"),
            }),
        )],
        "goal.checkin" => vec![(
            "orchestrator-goal-checkin",
            json!({
                "agentId": agent,
                "taskId": task,
                "goalId": p.get("goalId"),
                "title": p.get("title"),
                "summary": p.get("summary"),
                "achieved": p.get("achieved"),
            }),
        )],
        "task.completed" => vec![hook("Stop", json!({ "last_assistant_message": text("summary") }))],
        "task.failed" => vec![hook("StopFailure", json!({ "message": text("message") }))],
        "task.cancelled" => vec![hook("SessionEnd", json!({}))],
        _ => Vec::new(),
    }
}

/// The island's own tool names, so its steps read "Runs · …", "Fetches · …".
fn island_tool(op: &str) -> &'static str {
    match op {
        "browser.navigate" | "browser.extract_text" => "WebFetch",
        "browser.screenshot" => "Screenshot",
        "fs.write_artifact" => "Write",
        "fs.read" => "Read",
        "fs.list" => "LS",
        "terminal.run" => "Bash",
        _ => "Tool",
    }
}

fn approval_tool(op: &str) -> String {
    match op {
        "team.propose" => t("Create team"),
        "team.retire" => t("Retire agent"),
        _ => op.to_string(),
    }
}

fn deliver(app: &AppHandle, event: &Value) {
    for (channel, payload) in translate(event) {
        let _ = app.emit_to(WINDOW_LABEL, channel, payload);
    }
    // Every window that listens (the Tasks page) sees the raw event.
    let _ = app.emit("orchestrator-event", event);
}

/// On (re)connection: the island learns what is running right now, without
/// replaying history at it (the Tasks page shows that).
async fn restore(app: &AppHandle, tasks: &[Value]) {
    for task in tasks {
        let Some(id) = task.get("id").and_then(Value::as_str) else { continue };
        let agent = task.get("agentId").cloned().unwrap_or(Value::Null);
        let started = json!({
            "type": "task.started", "taskId": id, "agentId": agent,
            "payload": { "prompt": task.get("prompt").cloned().unwrap_or(Value::Null) },
        });
        deliver_island_only(app, &started);
        let Ok(detail) = api(app, Method::GET, &format!("/api/tasks/{}", segment(id).unwrap_or("-")), None).await else { continue };
        if let Some(step) = detail.get("steps").and_then(Value::as_array).and_then(|s| s.last()) {
            if step.get("status").and_then(Value::as_str) == Some("running") {
                let event = json!({
                    "type": "tool.started", "taskId": id, "agentId": agent,
                    "payload": { "op": step.get("op"), "target": step.get("note") },
                });
                deliver_island_only(app, &event);
            }
        }
        for approval in detail.get("approvals").and_then(Value::as_array).into_iter().flatten() {
            let event = json!({
                "type": "approval.requested", "taskId": id, "agentId": agent,
                "payload": { "approvalId": approval.get("id"), "op": approval.get("op"), "target": approval.get("target") },
            });
            deliver_island_only(app, &event);
        }
        if task.get("status").and_then(Value::as_str) == Some("waiting_for_answer") {
            if let Some(question) = task.get("question") {
                let event = json!({
                    "type": "task.question", "taskId": id, "agentId": agent,
                    "payload": {
                        "questionId": question.get("id"),
                        "question": question.get("text"),
                        "options": question.get("options"),
                    },
                });
                deliver(app, &event);
            }
        } else if task.get("status").and_then(Value::as_str) == Some("waiting_for_agents") {
            let children: Vec<&Value> = detail
                .get("children")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|child| child.get("id"))
                .collect();
            let event = json!({
                "type": "task.waiting_for_agents", "taskId": id, "agentId": agent,
                "payload": { "childTaskIds": children },
            });
            deliver(app, &event);
        } else if task.get("status").and_then(Value::as_str) == Some("paused") {
            let event = json!({
                "type": "task.paused", "taskId": id, "agentId": agent, "payload": {},
            });
            deliver(app, &event);
        }
    }
}

/// The agents, for the island's pills and the Tasks page: on every connection
/// and whenever one changes (status, name, colour).
async fn push_agents(app: &AppHandle) {
    match api(app, Method::GET, "/api/agents", None).await {
        Ok(body) => {
            let _ = app.emit(
                "orchestrator-agents",
                json!({
                    "agents": body.get("agents"),
                    "teams": body.get("teams"),
                    "computers": body.get("computers"),
                }),
            );
        }
        Err(e) => log::line(format!("orchestrator: agents not read: {e}")),
    }
}

/// Agent-level events change the agents' pills, not a task's.
pub fn is_agent_event(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str).is_some_and(|k| {
        (k.starts_with("agent.") && k != "agent.heartbeat")
            || matches!(k, "team.updated" | "goal.updated" | "goal.checkin" | "memory.updated")
    })
}

fn deliver_island_only(app: &AppHandle, event: &Value) {
    for (channel, payload) in translate(event) {
        let _ = app.emit_to(WINDOW_LABEL, channel, payload);
    }
}

// ── The stream ────────────────────────────────────────────────────────────────

pub fn setup(app: &AppHandle) {
    app.manage(Orchestrator {
        prefs: Mutex::new(load_prefs()),
        status: Mutex::new(Status { state: "off", error: None }),
        wake: Notify::new(),
        started: Mutex::new(None),
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run(app).await });
}

async fn run(app: AppHandle) {
    // Where the island's stream stands; 0 until the first connection of this run.
    let mut last_seq: u64 = 0;
    let mut backoff = Duration::from_secs(2);
    loop {
        let prefs = state(&app).prefs.lock().unwrap().clone();
        if !prefs.enabled || integrations::PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
            set_status(&app, "off", None);
            last_seq = 0;
            sleep_or_wake(&app, Duration::from_secs(5)).await;
            continue;
        }
        // Before the key check: the backend's first start is what creates the key.
        ensure_backend(&app, &prefs).await;
        if secrets::get_internal(TOKEN_KEY).is_none() {
            set_status(&app, "noToken", None);
            sleep_or_wake(&app, Duration::from_secs(10)).await;
            continue;
        }
        set_status(&app, "connecting", None);
        match stream(&app, &prefs, &mut last_seq).await {
            Ok(()) => backoff = Duration::from_secs(2),
            Err(e) => {
                log::line(format!("orchestrator: {e}"));
                set_status(&app, "unreachable", Some(e));
                sleep_or_wake(&app, backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

// ── Starting the backend ──────────────────────────────────────────────────────

/// A folder holding the backend: its package.json and server/src/main.ts.
fn is_backend_dir(dir: &Path) -> bool {
    dir.join("package.json").is_file() && dir.join("server").join("src").join("main.ts").is_file()
}

/// Where Coucou starts the backend from: the folder the user picked, else the
/// `orchestrator` folder of the repository this build sits in (a dev build).
/// None for an installed build with no folder picked.
fn backend_dir(prefs: &Prefs) -> Option<PathBuf> {
    let picked = prefs.backend_dir.trim();
    if !picked.is_empty() {
        let dir = PathBuf::from(picked);
        return is_backend_dir(&dir).then_some(dir);
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().map(|dir| dir.join("orchestrator")).find(|dir| is_backend_dir(dir))
}

/// Starts the backend when nothing answers at its address, at most once a
/// minute. It keeps running when Coucou quits, so goals and tasks go on.
async fn ensure_backend(app: &AppHandle, prefs: &Prefs) {
    if !prefs.start_backend {
        return;
    }
    let Ok(base) = base_url(&prefs.url) else { return };
    let (Some(host), Some(port)) = (base.host_str().map(str::to_string), base.port_or_known_default()) else { return };
    let address = format!("{host}:{port}");
    let answers = tokio::time::timeout(Duration::from_secs(1), tokio::net::TcpStream::connect(address)).await;
    if matches!(answers, Ok(Ok(_))) {
        return;
    }
    let Some(dir) = backend_dir(prefs) else { return };
    {
        let orchestrator = state(app);
        let mut started = orchestrator.started.lock().unwrap();
        if started.is_some_and(|at| at.elapsed() < Duration::from_secs(60)) {
            return;
        }
        *started = Some(Instant::now());
    }
    match spawn_backend(&dir) {
        Ok(()) => log::line(format!("orchestrator: started the backend in {}", dir.display())),
        Err(e) => log::line(format!("orchestrator: could not start the backend: {e}")),
    }
}

/// `npm start` without npm: node runs the backend with the folder's .env, its
/// output in Coucou's local folder.
fn spawn_backend(dir: &Path) -> Result<(), String> {
    let node = platform::find_on_path("node").ok_or("node is not on PATH")?;
    let logs = platform::local_dir();
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let out = std::fs::File::create(logs.join("orchestrator-backend.log")).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    cmd.args(["--env-file-if-exists=.env", "server/src/main.ts"])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    platform::no_console(&mut cmd).spawn().map(|_| ()).map_err(|e| e.to_string())
}

async fn sleep_or_wake(app: &AppHandle, d: Duration) {
    let orchestrator = state(app);
    tokio::select! {
        _ = tokio::time::sleep(d) => {}
        _ = orchestrator.wake.notified() => {}
    }
}

/// One connection: catch up, then follow the stream until it drops or the
/// preferences change (Ok) or the backend cannot be reached (Err).
async fn stream(app: &AppHandle, prefs: &Prefs, last_seq: &mut u64) -> Result<(), String> {
    if *last_seq == 0 {
        let snapshot = api(app, Method::GET, "/api/tasks?active=1", None).await?;
        *last_seq = snapshot.get("lastSeq").and_then(Value::as_u64).unwrap_or(0);
        restore(app, snapshot.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])).await;
    }
    let base = base_url(&prefs.url)?;
    // No overall timeout: the stream is meant to stay open. Idle is checked below.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(net::join(&base, "/api/events"))
        .bearer_auth(token()?)
        .header("Last-Event-ID", last_seq.to_string())
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    set_status(app, "connected", None);
    push_agents(app).await;

    let orchestrator = state(app);
    let mut buffer = String::new();
    loop {
        let chunk = tokio::select! {
            c = tokio::time::timeout(STREAM_IDLE, response.chunk()) => c,
            _ = orchestrator.wake.notified() => return Ok(()), // Preferences changed: start over.
        };
        let bytes = match chunk {
            Err(_) => return Err(t("The backend stopped answering.")),
            Ok(Err(e)) => return Err(tf("Network error: {error}", &[("error", &e.to_string())])),
            Ok(Ok(None)) => return Err(t("The backend stopped answering.")),
            Ok(Ok(Some(bytes))) => bytes,
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        if buffer.len() > MAX_EVENT {
            return Err(t("The server's answer is too large."));
        }
        while let Some(end) = buffer.find("\n\n") {
            let block: String = buffer.drain(..end + 2).collect();
            let Some(data) = block.lines().find_map(|l| l.strip_prefix("data: ")) else { continue };
            let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(seq) = event.get("seq").and_then(Value::as_u64) {
                if seq <= *last_seq {
                    continue;
                }
                *last_seq = seq;
            }
            deliver(app, &event);
            if is_agent_event(&event) {
                push_agents(app).await;
            }
        }
    }
}

// ── The island's approval card ────────────────────────────────────────────────

/// Approval requests that came from the backend rather than a hook relay.
pub fn owns(request_id: &str) -> bool {
    request_id.starts_with(REQUEST_PREFIX)
}

/// A click on the card: Allow or Deny goes to the backend, which owns the approval.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let Some((agent, approval)) = request_id.strip_prefix(REQUEST_PREFIX).and_then(|r| r.split_once(':')) else { return };
    let (Ok(agent), Ok(approval)) = (segment(agent), segment(approval)) else { return };
    let decision = if decision == "allow" { "approve" } else { "reject" };
    let (app, agent, approval) = (app.clone(), agent.to_string(), approval.to_string());
    tauri::async_runtime::spawn(async move {
        let body = json!({ "approvalId": approval, "decision": decision });
        if let Err(e) = api(&app, Method::POST, &format!("/api/agents/{agent}/approval"), Some(body)).await {
            log::line(format!("orchestrator: approval not sent: {e}"));
        }
    });
}

// ── Commands for the Tasks page ───────────────────────────────────────────────

#[tauri::command]
pub fn orchestrator_status(app: AppHandle) -> Value {
    let o = state(&app);
    let prefs = o.prefs.lock().unwrap().clone();
    let status = o.status.lock().unwrap().clone();
    let backend_dir = backend_dir(&prefs).map(|dir| dir.display().to_string());
    json!({
        "prefs": prefs,
        "status": status,
        "hasToken": secrets::get_internal(TOKEN_KEY).is_some(),
        "backendDir": backend_dir,
    })
}

/// `start_backend` and `backend_dir` left out keep what they were.
#[tauri::command]
pub fn orchestrator_set_prefs(
    app: AppHandle,
    enabled: bool,
    url: String,
    start_backend: Option<bool>,
    backend_dir: Option<String>,
) -> Result<(), String> {
    let url = if url.trim().is_empty() { DEFAULT_URL.to_string() } else { base_url(&url)?.as_str().trim_end_matches('/').to_string() };
    let before = state(&app).prefs.lock().unwrap().clone();
    let backend_dir = backend_dir.map(|dir| dir.trim().to_string()).unwrap_or(before.backend_dir);
    if !backend_dir.is_empty() && !is_backend_dir(Path::new(&backend_dir)) {
        return Err(t("That folder has no orchestrator backend."));
    }
    let prefs = Prefs { enabled, url, start_backend: start_backend.unwrap_or(before.start_backend), backend_dir };
    save_prefs(&prefs)?;
    *state(&app).prefs.lock().unwrap() = prefs;
    state(&app).wake.notify_waiters();
    Ok(())
}

#[tauri::command]
pub async fn orchestrator_tasks(app: AppHandle) -> Result<Value, String> {
    let tasks = api(&app, Method::GET, "/api/tasks?limit=50", None).await?;
    let agents = api(&app, Method::GET, "/api/agents", None).await?;
    Ok(json!({
        "tasks": tasks.get("tasks"),
        "agents": agents.get("agents"),
        "teams": agents.get("teams"),
        "computers": agents.get("computers"),
        "approvals": agents.get("approvals"),
    }))
}

#[tauri::command]
pub async fn orchestrator_task(app: AppHandle, task_id: String) -> Result<Value, String> {
    api(&app, Method::GET, &format!("/api/tasks/{}", segment(&task_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_submit(
    app: AppHandle,
    prompt: String,
    idempotency_key: String,
    model_profile_id: Option<String>,
    agent_id: Option<String>,
    context: Option<String>,
    source: Option<String>,
    attachments: Option<Vec<String>>,
    links: Option<Vec<String>>,
) -> Result<Value, String> {
    let mut body = json!({ "prompt": prompt, "idempotencyKey": segment(&idempotency_key)? });
    // Ids from orchestrator_attach, and GitHub links: the backend checks both.
    if let Some(ids) = attachments.filter(|ids| !ids.is_empty()) {
        body["attachments"] = json!(ids.iter().map(|id| segment(id)).collect::<Result<Vec<_>, _>>()?);
    }
    if let Some(links) = links.filter(|links| !links.is_empty()) {
        body["links"] = json!(links);
    }
    if let Some(profile) = model_profile_id {
        body["modelProfileId"] = json!(segment(&profile)?);
    }
    // No agent: the backend sends the task to a free one.
    if let Some(agent) = agent_id {
        body["agentId"] = json!(segment(&agent)?);
    }
    // The chat it comes from: background for the model (the backend caps it).
    if let Some(context) = context.filter(|c| !c.trim().is_empty()) {
        body["context"] = json!(context);
    }
    if let Some(source) = source {
        if source != "user" && source != "chat" {
            return Err("invalid source".into());
        }
        body["source"] = json!(source);
    }
    api(&app, Method::POST, "/api/tasks", Some(body)).await
}

/// The largest file a message can carry: the backend's own limit.
const MAX_ATTACHMENT: u64 = 20 * 1024 * 1024;

/// Hands the backend a file the user dropped on (or picked in) Coucou HQ's
/// composer; it keeps it for the next message, whose task copies it to the
/// agent's computer. Only a path a real drop or pick just delivered is read
/// (files.rs), so the page cannot send a file of its own choosing.
#[tauri::command]
pub async fn orchestrator_attach(app: AppHandle, path: String) -> Result<Value, String> {
    if !crate::files::take_dropped(&path) {
        return Err(t("Only files dropped on or chosen in Coucou HQ can be attached."));
    }
    let source = Path::new(&path);
    let meta = std::fs::metadata(source)
        .map_err(|e| tf("Cannot read {path}: {error}", &[("path", &path), ("error", &e.to_string())]))?;
    let name = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    if meta.is_dir() {
        return Err(t("Folders can't be attached yet."));
    }
    if meta.len() > MAX_ATTACHMENT {
        return Err(tf("{name} is larger than 20 MB.", &[("name", &name)]));
    }
    let bytes = std::fs::read(source)
        .map_err(|e| tf("Cannot read {path}: {error}", &[("path", &path), ("error", &e.to_string())]))?;
    let answer = send(&app, Method::POST, "/api/attachments", &[("name", &name)], |req| {
        req.header(reqwest::header::CONTENT_TYPE, "application/octet-stream").body(bytes)
    })
    .await?;
    serde_json::from_slice(&answer).map_err(|e| e.to_string())
}

/// The models the backend can run tasks on (Claude, Cursor…), and its default.
#[tauri::command]
pub async fn orchestrator_models(app: AppHandle) -> Result<Value, String> {
    api(&app, Method::GET, "/api/models", None).await
}

/// The agents and the approvals waiting on them, read now.
#[tauri::command]
pub async fn orchestrator_agents(app: AppHandle) -> Result<Value, String> {
    api(&app, Method::GET, "/api/agents", None).await
}

fn selected_fields(raw: &Value, fields: &[&str]) -> Value {
    let mut body = serde_json::Map::new();
    for key in fields {
        if let Some(value) = raw.get(key) {
            body.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(body)
}

/// Changes an agent's contract fields. The backend validates values, and null
/// puts the corresponding default back.
#[tauri::command]
pub async fn orchestrator_update_agent(app: AppHandle, agent_id: String, identity: Value) -> Result<Value, String> {
    let body = selected_fields(
        &identity,
        &["name", "color", "role", "outfit", "teamId", "order", "computerId", "persona"],
    );
    api(&app, Method::PATCH, &format!("/api/agents/{}", segment(&agent_id)?), Some(body)).await
}

#[tauri::command]
pub async fn orchestrator_create_agent(app: AppHandle, identity: Value) -> Result<Value, String> {
    let body = selected_fields(
        &identity,
        &["name", "role", "color", "outfit", "teamId", "computerId", "persona"],
    );
    api(&app, Method::POST, "/api/agents", Some(body)).await
}

#[tauri::command]
pub async fn orchestrator_retire_agent(app: AppHandle, agent_id: String) -> Result<Value, String> {
    api(&app, Method::DELETE, &format!("/api/agents/{}", segment(&agent_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_create_team(app: AppHandle, name: String) -> Result<Value, String> {
    api(&app, Method::POST, "/api/teams", Some(json!({ "name": name }))).await
}

#[tauri::command]
pub async fn orchestrator_update_team(app: AppHandle, team_id: String, changes: Value) -> Result<Value, String> {
    let body = selected_fields(&changes, &["name", "order"]);
    api(&app, Method::PATCH, &format!("/api/teams/{}", segment(&team_id)?), Some(body)).await
}

#[tauri::command]
pub async fn orchestrator_delete_team(app: AppHandle, team_id: String) -> Result<Value, String> {
    api(&app, Method::DELETE, &format!("/api/teams/{}", segment(&team_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_cancel(app: AppHandle, task_id: String) -> Result<Value, String> {
    api(&app, Method::POST, &format!("/api/tasks/{}/cancel", segment(&task_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_answer(app: AppHandle, task_id: String, question_id: String, answer: String) -> Result<Value, String> {
    let body = json!({ "questionId": segment(&question_id)?, "answer": answer });
    api(&app, Method::POST, &format!("/api/tasks/{}/answer", segment(&task_id)?), Some(body)).await
}

#[tauri::command]
pub async fn orchestrator_pause_task(app: AppHandle, task_id: String) -> Result<Value, String> {
    api(&app, Method::POST, &format!("/api/tasks/{}/pause", segment(&task_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_resume_task(app: AppHandle, task_id: String) -> Result<Value, String> {
    api(&app, Method::POST, &format!("/api/tasks/{}/resume", segment(&task_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_pause_agent(app: AppHandle, agent_id: String) -> Result<Value, String> {
    api(&app, Method::POST, &format!("/api/agents/{}/pause", segment(&agent_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_resume_agent(app: AppHandle, agent_id: String) -> Result<Value, String> {
    api(&app, Method::POST, &format!("/api/agents/{}/resume", segment(&agent_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_set_limits(
    app: AppHandle,
    agent_id: String,
    tasks_per_day: u32,
    steps_per_day: u32,
) -> Result<Value, String> {
    let body = json!({ "tasksPerDay": tasks_per_day, "stepsPerDay": steps_per_day });
    api(&app, Method::PUT, &format!("/api/agents/{}/limits", segment(&agent_id)?), Some(body)).await
}

#[tauri::command]
pub async fn orchestrator_chat_history(app: AppHandle, agent_id: String) -> Result<Value, String> {
    let path = format!("/api/tasks?agentId={}&source=chat,delegated&limit=50", segment(&agent_id)?);
    api(&app, Method::GET, &path, None).await
}

/// Where a task can come from, as the backend names it.
const SOURCES: [&str; 4] = ["chat", "delegated", "goal", "user"];

/// The `/api/tasks` query for a filtered list. Pure, so it is tested below.
fn tasks_query(
    agent_id: Option<&str>,
    source: Option<&str>,
    parent_task_id: Option<&str>,
    limit: Option<u32>,
) -> Result<String, String> {
    let mut query = Vec::new();
    if let Some(agent) = agent_id {
        query.push(format!("agentId={}", segment(agent)?));
    }
    if let Some(source) = source {
        if source.is_empty() || !source.split(',').all(|s| SOURCES.contains(&s)) {
            return Err("invalid source".into());
        }
        query.push(format!("source={source}"));
    }
    if let Some(parent) = parent_task_id {
        query.push(format!("parentTaskId={}", segment(parent)?));
    }
    query.push(format!("limit={}", limit.unwrap_or(50).clamp(1, 200)));
    Ok(format!("/api/tasks?{}", query.join("&")))
}

/// Tasks filtered by agent, source and parent (Coucou HQ's threads).
#[tauri::command]
pub async fn orchestrator_list_tasks(
    app: AppHandle,
    agent_id: Option<String>,
    source: Option<String>,
    parent_task_id: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let path = tasks_query(agent_id.as_deref(), source.as_deref(), parent_task_id.as_deref(), limit)?;
    api(&app, Method::GET, &path, None).await
}

fn schedule(raw: &Value) -> Result<Value, String> {
    let kind = raw.get("kind").and_then(Value::as_str).ok_or("invalid schedule")?;
    match kind {
        "manual" => Ok(json!({ "kind": "manual" })),
        "every" => raw
            .get("hours")
            .and_then(Value::as_u64)
            .map(|hours| json!({ "kind": "every", "hours": hours }))
            .ok_or_else(|| "invalid schedule".into()),
        "daily" | "weekdays" => raw
            .get("time")
            .and_then(Value::as_str)
            .map(|time| json!({ "kind": kind, "time": time }))
            .ok_or_else(|| "invalid schedule".into()),
        _ => Err("invalid schedule".into()),
    }
}

#[tauri::command]
pub async fn orchestrator_goals(app: AppHandle, agent_id: String) -> Result<Value, String> {
    api(&app, Method::GET, &format!("/api/goals?agentId={}", segment(&agent_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_create_goal(
    app: AppHandle,
    agent_id: String,
    title: String,
    instructions: String,
    schedule: Value,
    model_profile_id: Option<String>,
) -> Result<Value, String> {
    let mut body = json!({
        "agentId": segment(&agent_id)?,
        "title": title,
        "instructions": instructions,
        "schedule": self::schedule(&schedule)?,
    });
    if let Some(profile) = model_profile_id {
        body["modelProfileId"] = json!(segment(&profile)?);
    }
    api(&app, Method::POST, "/api/goals", Some(body)).await
}

#[tauri::command]
pub async fn orchestrator_update_goal(app: AppHandle, goal_id: String, changes: Value) -> Result<Value, String> {
    let mut body = serde_json::Map::new();
    for key in ["title", "instructions", "modelProfileId", "status"] {
        if let Some(value) = changes.get(key) {
            body.insert(key.to_string(), value.clone());
        }
    }
    if let Some(value) = changes.get("schedule") {
        body.insert("schedule".into(), schedule(value)?);
    }
    api(
        &app,
        Method::PATCH,
        &format!("/api/goals/{}", segment(&goal_id)?),
        Some(Value::Object(body)),
    )
    .await
}

#[tauri::command]
pub async fn orchestrator_delete_goal(app: AppHandle, goal_id: String) -> Result<Value, String> {
    api(&app, Method::DELETE, &format!("/api/goals/{}", segment(&goal_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_run_goal(app: AppHandle, goal_id: String, idempotency_key: String) -> Result<Value, String> {
    let body = json!({ "idempotencyKey": segment(&idempotency_key)? });
    api(&app, Method::POST, &format!("/api/goals/{}/run", segment(&goal_id)?), Some(body)).await
}

#[tauri::command]
pub async fn orchestrator_memory(app: AppHandle, agent_id: String) -> Result<Value, String> {
    api(&app, Method::GET, &format!("/api/agents/{}/memory", segment(&agent_id)?), None).await
}

#[tauri::command]
pub async fn orchestrator_add_memory(app: AppHandle, agent_id: String, text: String) -> Result<Value, String> {
    api(
        &app,
        Method::POST,
        &format!("/api/agents/{}/memory", segment(&agent_id)?),
        Some(json!({ "text": text })),
    )
    .await
}

#[tauri::command]
pub async fn orchestrator_delete_memory(app: AppHandle, agent_id: String, note_id: String) -> Result<Value, String> {
    api(
        &app,
        Method::DELETE,
        &format!("/api/agents/{}/memory/{}", segment(&agent_id)?, segment(&note_id)?),
        None,
    )
    .await
}

#[tauri::command]
pub async fn orchestrator_decide(app: AppHandle, agent_id: String, approval_id: String, approve: bool) -> Result<Value, String> {
    let body = json!({ "approvalId": segment(&approval_id)?, "decision": if approve { "approve" } else { "reject" } });
    api(&app, Method::POST, &format!("/api/agents/{}/approval", segment(&agent_id)?), Some(body)).await
}

#[tauri::command]
pub async fn orchestrator_files(app: AppHandle, agent_id: String, task_id: String) -> Result<Value, String> {
    let path = format!("/api/agents/{}/files?taskId={}", segment(&agent_id)?, segment(&task_id)?);
    api(&app, Method::GET, &path, None).await
}

/// Saves one of a task's files to Downloads\Coucou\<task> and returns where it went.
#[tauri::command]
pub async fn orchestrator_save_file(app: AppHandle, agent_id: String, task_id: String, path: String) -> Result<String, String> {
    let valid = !path.is_empty()
        && path.len() <= 200
        && path.split('/').all(|s| !s.is_empty() && !s.starts_with('.') && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)));
    if !valid {
        return Err("invalid path".into());
    }
    let route = format!("/api/agents/{}/files/{}/{}", segment(&agent_id)?, segment(&task_id)?, path);
    let bytes = request(&app, Method::GET, &route, None).await?;
    let dir = platform::home_dir().join("Downloads").join("Coucou").join(&task_id[..8.min(task_id.len())]);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = path.rsplit('/').next().unwrap_or("file");
    let target = dir.join(name);
    std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, payload: Value) -> Value {
        json!({ "v": 1, "seq": 7, "type": kind, "taskId": "t-1", "agentId": "agent-01", "payload": payload })
    }

    #[test]
    fn older_prefs_start_the_backend_and_a_picked_folder_must_hold_it() {
        let prefs: Prefs = serde_json::from_str(r#"{"enabled":true,"url":"http://127.0.0.1:47620"}"#).unwrap();
        assert!(prefs.start_backend);
        assert_eq!(prefs.backend_dir, "");

        let dir = std::env::temp_dir().join(format!("coucou-orch-dir-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("server").join("src")).unwrap();
        let picked = Prefs { backend_dir: dir.display().to_string(), ..Prefs::default() };
        assert_eq!(backend_dir(&picked), None);
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("server").join("src").join("main.ts"), "").unwrap();
        assert_eq!(backend_dir(&picked), Some(dir.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_task_list_query_only_carries_checked_filters() {
        assert_eq!(tasks_query(None, None, None, None).unwrap(), "/api/tasks?limit=50");
        assert_eq!(
            tasks_query(Some("agent-01"), Some("chat,delegated"), Some("t_1"), Some(200)).unwrap(),
            "/api/tasks?agentId=agent-01&source=chat,delegated&parentTaskId=t_1&limit=200"
        );
        assert_eq!(tasks_query(None, Some("goal"), None, Some(5000)).unwrap(), "/api/tasks?source=goal&limit=200");
        assert_eq!(tasks_query(None, None, None, Some(0)).unwrap(), "/api/tasks?limit=1");
        assert!(tasks_query(Some("a&b=c"), None, None, None).is_err());
        assert!(tasks_query(None, Some("chat,evil"), None, None).is_err());
        assert!(tasks_query(None, Some(""), None, None).is_err());
        assert!(tasks_query(None, Some("chat,"), None, None).is_err());
        assert!(tasks_query(None, None, Some("../x"), None).is_err());
    }

    #[test]
    fn a_running_task_becomes_the_hook_events_the_island_already_handles() {
        let started = translate(&event("task.started", json!({ "prompt": "Summarise the docs" })));
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].0, "hook");
        assert_eq!(started[0].1["hook_event_name"], "UserPromptSubmit");
        assert_eq!(started[0].1["coucou_agent"], "agent-01");
        assert_eq!(started[0].1["session_id"], "orch:t-1");
        assert_eq!(started[0].1["prompt"], "Summarise the docs");

        let step = translate(&event("tool.started", json!({ "jobId": "j", "op": "browser.navigate", "target": "Open the docs" })));
        assert_eq!(step[0].1["hook_event_name"], "PreToolUse");
        assert_eq!(step[0].1["tool_name"], "WebFetch");
        assert_eq!(step[0].1["tool_input"]["query"], "Open the docs");

        let done = translate(&event("task.completed", json!({ "summary": "Saved report.md", "artifacts": [] })));
        assert_eq!(done[0].1["hook_event_name"], "Stop");
        assert_eq!(done[0].1["last_assistant_message"], "Saved report.md");
    }

    #[test]
    fn an_approval_carries_an_id_only_the_backend_answers() {
        let asked = translate(&event(
            "approval.requested",
            json!({ "approvalId": "a-9", "op": "browser.navigate", "target": "https://docs.python.org", "reason": "first visit" }),
        ));
        assert_eq!(asked[0].1["hook_event_name"], "PermissionRequest");
        let id = asked[0].1["request_id"].as_str().unwrap();
        assert_eq!(id, "orch:agent-01:a-9");
        assert!(owns(id));
        assert!(!owns("7f3c-from-the-pipe"));
        assert_eq!(asked[0].1["tool_input"]["command"], "https://docs.python.org");

        let resolved = translate(&event("approval.resolved", json!({ "approvalId": "a-9", "decision": "approve" })));
        assert_eq!(resolved[0].0, "orchestrator-approval-resolved");
        assert_eq!(resolved[0].1["requestId"], "orch:agent-01:a-9");
    }

    #[test]
    fn each_agent_gets_its_own_pill_and_its_own_approvals() {
        let of = |agent: &str, kind: &str, payload: Value| {
            translate(&json!({ "v": 1, "seq": 1, "type": kind, "taskId": format!("t-{agent}"), "agentId": agent, "payload": payload }))
        };
        let one = of("agent-01", "task.started", json!({ "prompt": "a", "modelProfileId": "claude-cli" }));
        let two = of("agent-02", "task.started", json!({ "prompt": "b", "modelProfileId": "claude-cli" }));
        assert_eq!(one[0].1["coucou_agent"], "agent-01");
        assert_eq!(two[0].1["coucou_agent"], "agent-02");
        assert_ne!(one[0].1["session_id"], two[0].1["session_id"]);
        let asked = of("agent-02", "approval.requested", json!({ "approvalId": "a-1", "op": "fs.write_artifact", "target": "x", "reason": "overwrite" }));
        assert_eq!(asked[0].1["request_id"], "orch:agent-02:a-1");
    }

    #[test]
    fn agent_events_refresh_the_pills_but_heartbeats_do_not() {
        let of = |kind: &str| json!({ "type": kind, "taskId": null, "agentId": "agent-01", "payload": {} });
        assert!(is_agent_event(&of("agent.status_changed")));
        assert!(is_agent_event(&of("agent.updated")));
        assert!(is_agent_event(&of("agent.delegated")));
        assert!(is_agent_event(&of("agent.reported")));
        assert!(is_agent_event(&of("team.updated")));
        assert!(is_agent_event(&of("goal.updated")));
        assert!(is_agent_event(&of("goal.checkin")));
        assert!(is_agent_event(&of("memory.updated")));
        assert!(!is_agent_event(&of("agent.heartbeat")));
        assert!(!is_agent_event(&of("task.started")));
    }

    #[test]
    fn a_question_stays_in_the_agent_chat_instead_of_opening_a_hook_card() {
        let asked = translate(&event(
            "task.question",
            json!({ "questionId": "q-1", "question": "Which format?", "options": ["PDF", "Markdown"] }),
        ));
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].0, "orchestrator-task-state");
        assert_eq!(asked[0].1["state"], "question");
        assert!(asked.iter().all(|(_, payload)| payload["hook_event_name"] != "PermissionRequest"));

        let answered = translate(&event("task.answered", json!({ "questionId": "q-1" })));
        assert_eq!(answered[0].1["state"], "working");
        let paused = translate(&event("task.paused", json!({})));
        assert_eq!(paused[0].1["state"], "idle");
    }

    #[test]
    fn goal_and_memory_events_tell_the_views_what_to_refresh() {
        let goal = json!({
            "type": "goal.updated", "taskId": null, "agentId": "agent-01",
            "payload": { "goalId": "g-1" },
        });
        let memory = json!({
            "type": "memory.updated", "taskId": null, "agentId": "agent-01",
            "payload": {},
        });
        assert_eq!(translate(&goal)[0].1["kind"], "goals");
        assert_eq!(translate(&memory)[0].1["kind"], "memory");
        let team = json!({
            "type": "team.updated", "taskId": null, "agentId": null,
            "payload": {},
        });
        assert_eq!(translate(&team)[0].1["kind"], "teams");
        let checkin = translate(&event(
            "goal.checkin",
            json!({ "goalId": "g-1", "title": "Track docs", "summary": "No changes", "achieved": false }),
        ));
        assert_eq!(checkin[0].0, "orchestrator-goal-checkin");
        assert_eq!(checkin[0].1["title"], "Track docs");
    }

    #[test]
    fn schedules_forward_only_the_contract_fields() {
        assert_eq!(
            schedule(&json!({ "kind": "every", "hours": 12, "extra": "no" })).unwrap(),
            json!({ "kind": "every", "hours": 12 }),
        );
        assert_eq!(
            schedule(&json!({ "kind": "weekdays", "time": "09:30", "other": true })).unwrap(),
            json!({ "kind": "weekdays", "time": "09:30" }),
        );
        assert!(schedule(&json!({ "kind": "monthly" })).is_err());
    }

    #[test]
    fn delegation_events_and_waiting_reach_the_island() {
        let delegated = translate(&event(
            "agent.delegated",
            json!({ "toAgentId": "ada", "childTaskId": "t-child", "message": "Review this" }),
        ));
        assert_eq!(delegated[0].0, "orchestrator-delegated");
        assert_eq!(delegated[0].1["toAgentId"], "ada");
        assert_eq!(delegated[0].1["childTaskId"], "t-child");

        let reported = translate(&event(
            "agent.reported",
            json!({ "fromAgentId": "ada", "childTaskId": "t-child", "status": "succeeded", "summary": "Done" }),
        ));
        assert_eq!(reported[0].0, "orchestrator-reported");
        assert_eq!(reported[0].1["summary"], "Done");

        let waiting = translate(&event("task.waiting_for_agents", json!({ "childTaskIds": ["t-child"] })));
        assert_eq!(waiting[0].0, "orchestrator-task-state");
        assert_eq!(waiting[0].1["state"], "waiting_for_agents");
        assert_eq!(waiting[0].1["childTaskIds"], json!(["t-child"]));
    }

    #[test]
    fn team_approvals_have_readable_tool_names() {
        assert_eq!(approval_tool("team.propose"), t("Create team"));
        assert_eq!(approval_tool("team.retire"), t("Retire agent"));
        assert_eq!(approval_tool("terminal.run"), "terminal.run");
    }

    #[test]
    fn agent_changes_forward_only_contract_fields() {
        let body = selected_fields(
            &json!({
                "name": "Ada", "role": "Backend lead", "outfit": "beanie",
                "teamId": "builders", "order": 2, "computerId": "agent-02",
                "persona": "Careful reviewer", "color": "#38BDF8", "kind": "chief",
                "status": "busy", "unknown": true,
            }),
            &["name", "color", "role", "outfit", "teamId", "order", "computerId", "persona"],
        );
        assert_eq!(body.as_object().unwrap().len(), 8);
        assert!(body.get("kind").is_none());
        assert!(body.get("status").is_none());
        assert!(body.get("unknown").is_none());
    }

    #[test]
    fn noise_and_agent_events_stay_out_of_the_island() {
        for kind in ["tool.output", "browser.navigation", "artifact.created", "agent.heartbeat"] {
            assert!(translate(&event(kind, json!({}))).is_empty(), "{kind}");
        }
        let status = json!({ "type": "agent.status_changed", "taskId": null, "agentId": "agent-01", "payload": { "status": "ready" } });
        assert!(translate(&status).is_empty());
        let ok = translate(&event("tool.completed", json!({ "ok": true })));
        assert!(ok.is_empty());
        let failed = translate(&event("tool.completed", json!({ "ok": false, "op": "terminal.run" })));
        assert_eq!(failed[0].1["hook_event_name"], "PostToolUseFailure");
    }

    #[test]
    fn the_token_only_ever_goes_to_this_machine() {
        assert!(base_url("http://127.0.0.1:47620").is_ok());
        assert!(base_url("http://localhost:47620").is_ok());
        assert!(base_url("http://192.168.1.20:47620").is_err());
        assert!(base_url("https://example.com").is_err());
        assert!(base_url("not a url").is_err());
    }

    #[test]
    fn ids_from_the_webview_cannot_reach_another_route() {
        assert!(segment("2f1c9e2a-3b4c-4d5e-8f90-1234567890ab").is_ok());
        assert!(segment("../agents").is_err());
        assert!(segment("a/b").is_err());
        assert!(segment("").is_err());
    }
}
