//! Settings web UI — serves a local HTML page for configuring dovai.
//!
//! Spawned by `dovai settings`, binds to `127.0.0.1:<random-port>`, prints
//! the URL, and serves a single-page settings app. Reads/writes
//! `~/.dovai/settings.json` (global env + model) and the workspace
//! `.dovai/.env` (filing clerk + agent identity) when present.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

// ---- Live model switch channel ------------------------------------------
// When the user changes the model via the web UI, the new model name is
// placed here. The REPL checks and drains it before each turn.

static PENDING_MODEL: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// Check if the settings UI requested a model switch. Returns and clears
/// the pending model, if any.
pub fn take_pending_model_switch() -> Option<String> {
    PENDING_MODEL
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

fn set_pending_model_switch(model: &str) {
    let lock = PENDING_MODEL.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock.lock() {
        *guard = Some(model.to_string());
    }
}

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

// ---- Embedded static assets ---------------------------------------------

const INDEX_HTML: &str = include_str!("../assets/index.html");
const APP_CSS: &str = include_str!("../assets/app.css");
const APP_JS: &str = include_str!("../assets/app.js");
const LOGO_PNG: &[u8] = include_bytes!("../assets/logo.png");
const LOGO_FULL_PNG: &[u8] = include_bytes!("../assets/logo-full.png");

// ---- App state ----------------------------------------------------------

#[derive(Clone)]
struct AppState {
    config_home: PathBuf,
    workspace: Option<WorkspaceCtx>,
}

#[derive(Clone)]
struct WorkspaceCtx {
    dir: PathBuf,      // path to workspace root
    env_path: PathBuf, // .dovai/.env
    label: String,     // display name (basename of workspace)
}

// ---- Public entry -------------------------------------------------------

/// Start the settings web UI and block until the user quits.
pub fn run_settings_ui() -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("failed to start tokio runtime: {e}"))?;
    rt.block_on(async { serve().await })
}

async fn serve() -> Result<(), String> {
    let config_home = resolve_config_home();
    let workspace = detect_workspace();

    if let Err(e) = fs::create_dir_all(&config_home) {
        return Err(format!(
            "cannot create config home {}: {e}",
            config_home.display()
        ));
    }

    let state = Arc::new(AppState {
        config_home,
        workspace,
    });

    let app = Router::new()
        .route("/", get(index_html))
        .route("/app.css", get(css))
        .route("/app.js", get(js))
        .route("/logo.png", get(logo))
        .route("/logo-full.png", get(logo_full))
        .route("/api/config", get(get_config).post(post_config))
        .route("/api/config/ready", get(get_config_ready))
        .route("/api/usage", get(get_usage))
        .route("/api/models", post(fetch_models_for_connection))
        // ---- Services API ----
        .route(
            "/api/services",
            get(api_get_services).post(api_restart_service),
        )
        // ---- Tasks API ----
        .route("/api/tasks", get(api_list_tasks).post(api_create_task))
        .route(
            "/api/tasks/{id}",
            get(api_get_task)
                .put(api_update_task)
                .delete(api_delete_task),
        )
        .route("/api/tasks/{id}/subtasks", get(api_get_subtasks))
        // ---- Processes API ----
        .route(
            "/api/processes",
            get(api_list_processes).post(api_create_process),
        )
        .route(
            "/api/processes/{id}",
            get(api_get_process)
                .put(api_update_process)
                .delete(api_delete_process),
        )
        .route("/api/processes/{id}/steps", post(api_create_step))
        .route("/api/processes/{id}/steps/reorder", post(api_reorder_steps))
        .route("/api/processes/{id}/activate", post(api_activate_process))
        .route(
            "/api/processes/{id}/feedback",
            get(api_get_feedback).post(api_add_feedback),
        )
        // ---- Process step / feedback by ID ----
        .route(
            "/api/process-steps/{id}",
            put(api_update_step).delete(api_delete_step),
        )
        .route("/api/process-feedback/{id}", delete(api_delete_feedback))
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind 127.0.0.1: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;
    let url = format!("http://{addr}");

    println!();
    println!("  \x1b[1;36mdovai settings\x1b[0m");
    println!("  open \x1b[1;34m{url}\x1b[0m");
    println!("  \x1b[90m(Ctrl+C to quit)\x1b[0m");
    println!();

    // Best-effort browser open — non-blocking, ignores failure.
    let _ = open_url(&url);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| format!("server error: {e}"))?;
    Ok(())
}

/// Spawn the settings server in a background thread. Returns the URL.
/// Subsequent calls return the same URL without starting a second server.
pub fn spawn_settings_server() -> Result<String, String> {
    use std::sync::OnceLock;
    static URL: OnceLock<String> = OnceLock::new();
    if let Some(url) = URL.get() {
        // Already running — just re-open the browser.
        let _ = open_url(url);
        return Ok(url.clone());
    }

    let config_home = resolve_config_home();
    let workspace = detect_workspace();
    fs::create_dir_all(&config_home)
        .map_err(|e| format!("cannot create config home {}: {e}", config_home.display()))?;

    let state = Arc::new(AppState {
        config_home,
        workspace,
    });

    // Bind synchronously so we can return the URL immediately.
    let std_listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind 127.0.0.1: {e}"))?;
    let addr = std_listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;
    std_listener.set_nonblocking(true).ok();
    let url = format!("http://{addr}");
    let _ = URL.set(url.clone());

    let url_for_thread = url.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime for settings server");
        rt.block_on(async move {
            let listener = TcpListener::from_std(std_listener).expect("tokio TcpListener from std");
            let app = Router::new()
                .route("/", get(index_html))
                .route("/app.css", get(css))
                .route("/app.js", get(js))
                .route("/logo.png", get(logo))
                .route("/logo-full.png", get(logo_full))
                .route("/api/config", get(get_config).post(post_config))
                .route("/api/config/ready", get(get_config_ready))
                .route("/api/usage", get(get_usage))
                .route("/api/models", post(fetch_models_for_connection))
                // ---- Services API ----
                .route(
                    "/api/services",
                    get(api_get_services).post(api_restart_service),
                )
                // ---- Tasks API ----
                .route("/api/tasks", get(api_list_tasks).post(api_create_task))
                .route(
                    "/api/tasks/{id}",
                    get(api_get_task)
                        .put(api_update_task)
                        .delete(api_delete_task),
                )
                .route("/api/tasks/{id}/subtasks", get(api_get_subtasks))
                // ---- Processes API ----
                .route(
                    "/api/processes",
                    get(api_list_processes).post(api_create_process),
                )
                .route(
                    "/api/processes/{id}",
                    get(api_get_process)
                        .put(api_update_process)
                        .delete(api_delete_process),
                )
                .route("/api/processes/{id}/steps", post(api_create_step))
                .route("/api/processes/{id}/steps/reorder", post(api_reorder_steps))
                .route("/api/processes/{id}/activate", post(api_activate_process))
                .route(
                    "/api/processes/{id}/feedback",
                    get(api_get_feedback).post(api_add_feedback),
                )
                // ---- Process step / feedback by ID ----
                .route(
                    "/api/process-steps/{id}",
                    put(api_update_step).delete(api_delete_step),
                )
                .route("/api/process-feedback/{id}", delete(api_delete_feedback))
                .with_state(state);
            let _ = axum::serve(listener, app).await;
        });
    });

    // Best-effort browser open.
    let _ = open_url(&url_for_thread);
    Ok(url)
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    println!("\n  \x1b[90mshutting down…\x1b[0m");
}

fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).status()?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(url).status()?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", "start", url]).status()?;
    }
    Ok(())
}

// ---- Static routes ------------------------------------------------------

async fn index_html() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        INDEX_HTML,
    )
}

async fn css() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], APP_CSS)
}

async fn js() -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        APP_JS,
    )
}

async fn logo() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/png")], LOGO_PNG)
}

async fn logo_full() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/png")], LOGO_FULL_PNG)
}

// ---- Config API ---------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
struct ConfigPayload {
    // Provider credentials (api keys, keyed by provider name)
    #[serde(default)]
    providers: BTreeMap<String, ProviderCredentials>,
    // New format
    #[serde(default)]
    connections: Vec<AiConnection>,
    #[serde(default)]
    routing: TaskRouting,
    // Legacy — still populated for backward compat
    #[serde(default)]
    default_model: String,
    #[serde(default)]
    keys: Keys,
    #[serde(default)]
    clerk: ClerkConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<WorkspacePayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_profile: Option<String>,
    /// Available models grouped by provider — used by legacy model dropdown and new per-connection model fetch.
    #[serde(default, skip_deserializing)]
    available_models: Vec<ModelGroup>,
}

#[derive(Serialize, Clone)]
struct ModelGroup {
    provider: String,
    provider_type: String, // routing key: "anthropic", "xai", "openai", "local"
    available: bool,
    models: Vec<ModelOption>,
}

#[derive(Serialize, Clone)]
struct ModelOption {
    id: String,
    label: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Keys {
    anthropic: String,
    xai: String,
    openai: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct ClerkConfig {
    url: String,
    model: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct WorkspacePayload {
    #[serde(default)]
    label: String,
    #[serde(default)]
    agent_display_name: String,
    #[serde(default)]
    agent_email: String,
    #[serde(default)]
    owner_name: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct AiConnection {
    id: String,
    label: String,
    provider: String, // "anthropic", "xai", "openai", "local"
    #[serde(default, skip_serializing)]
    api_key: String, // legacy — new format uses providers section
    #[serde(default, skip_serializing_if = "String::is_empty")]
    endpoint: String, // for "local" provider
    model: String,
}

/// Per-provider credentials. Cloud providers store an API key;
/// local providers store an endpoint URL.
#[derive(Serialize, Deserialize, Default, Clone)]
struct ProviderCredentials {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    api_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    endpoint: String,
}

/// A routing slot: agent name + model selection.
/// Deserializes from either a plain string (legacy: model only) or an object
/// with `name` and `model` fields.
#[derive(Serialize, Default, Clone)]
struct RoutingSlot {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    model: String, // "provider:model" e.g. "xai:grok-3"
}

impl<'de> Deserialize<'de> for RoutingSlot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct SlotVisitor;
        impl<'de> serde::de::Visitor<'de> for SlotVisitor {
            type Value = RoutingSlot;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a routing slot object or model string")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(RoutingSlot {
                    name: String::new(),
                    model: v.to_string(),
                })
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let mut name = String::new();
                let mut model = String::new();
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "name" => name = map.next_value()?,
                        "model" => model = map.next_value()?,
                        _ => {
                            let _: serde::de::IgnoredAny = map.next_value()?;
                        }
                    }
                }
                Ok(RoutingSlot { name, model })
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(RoutingSlot::default())
            }
        }
        deserializer.deserialize_any(SlotVisitor)
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct TaskRouting {
    #[serde(default)]
    pm: RoutingSlot,
    #[serde(default)]
    simple: RoutingSlot,
    #[serde(default)]
    complex: RoutingSlot,
    #[serde(default)]
    clerk: RoutingSlot,
}

// ---- Services API -------------------------------------------------------

/// List all background services and their status.
async fn api_get_services(State(s): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let services = resolve_service_statuses(s.workspace.as_ref());
    Json(serde_json::json!({ "services": services }))
}

/// Restart a specific service or all dead services.
async fn api_restart_service(
    State(s): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let target = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("__all__");

    let Some(ws) = &s.workspace else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "No workspace detected"
        }));
    };

    let dovai_dir = ws.dir.join(".dovai");
    let data_dir = dovai_dir.join("data");

    let Some(agent_dir) = detect_agent_dir(&ws.dir) else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "No agent configured in this workspace"
        }));
    };

    let mut restarted = Vec::new();
    let mut errors = Vec::new();

    let statuses = dovai_agent::check_services(&data_dir);

    for svc in &statuses {
        if target != "__all__" && svc.name != target {
            continue;
        }
        // Restart if explicitly requested by name, or if dead when restarting all
        if target != "__all__" || !svc.running {
            let result = if dovai_agent::is_worker(&svc.name) {
                dovai_agent::start_worker(&svc.name, &dovai_dir)
            } else {
                // Kill first if running (force-restart case)
                if svc.running {
                    if let Some(pid) = svc.pid {
                        let _ = std::process::Command::new("kill")
                            .arg(pid.to_string())
                            .status();
                        // Remove stale PID file so start_service doesn't skip
                        let _ = fs::remove_file(data_dir.join(format!("{}.pid", svc.name)));
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
                dovai_agent::start_service(&svc.name, &agent_dir, &data_dir)
            };
            match result {
                Ok(()) => restarted.push(svc.name.clone()),
                Err(e) => errors.push(format!("{}: {e}", svc.name)),
            }
        }
    }

    // Re-check status after restart
    std::thread::sleep(std::time::Duration::from_secs(1));
    let updated = resolve_service_statuses(s.workspace.as_ref());

    Json(serde_json::json!({
        "ok": errors.is_empty(),
        "restarted": restarted,
        "errors": errors,
        "services": updated,
    }))
}

/// Build a JSON-serialisable list of service statuses, including heartbeat info.
fn resolve_service_statuses(workspace: Option<&WorkspaceCtx>) -> Vec<serde_json::Value> {
    let Some(ws) = workspace else {
        return vec![];
    };

    let dovai_dir = ws.dir.join(".dovai");
    let data_dir = dovai_dir.join("data");

    if !data_dir.exists() {
        return vec![];
    }

    let statuses = dovai_agent::check_services(&data_dir);

    statuses
        .iter()
        .map(|s| {
            // Try to read heartbeat file (.heartbeat — telegram-bot, email-poller)
            let heartbeat_path = data_dir.join(format!("{}.heartbeat", s.name));
            let heartbeat_json = fs::read_to_string(&heartbeat_path)
                .ok()
                .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok());

            // Try status file (.status — filing-clerk, workers)
            let status_path = data_dir.join(format!("{}.status", s.name));
            let status_json = fs::read_to_string(&status_path)
                .ok()
                .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok());

            // Extract the most recent activity timestamp from whichever file exists.
            // .heartbeat uses "timestamp", .status uses "last_heartbeat"
            let last_active = heartbeat_json
                .as_ref()
                .and_then(|h| h.get("timestamp").and_then(|v| v.as_str()))
                .or_else(|| {
                    status_json
                        .as_ref()
                        .and_then(|si| si.get("last_heartbeat").and_then(|v| v.as_str()))
                })
                .unwrap_or("")
                .to_string();

            // State from .status file, or infer from PID check
            let state = status_json
                .as_ref()
                .and_then(|si| si.get("state").and_then(|v| v.as_str()))
                .unwrap_or(if s.running { "running" } else { "stopped" })
                .to_string();

            serde_json::json!({
                "name": s.name,
                "running": s.running,
                "pid": s.pid,
                "state": state,
                "last_active": last_active,
            })
        })
        .collect()
}

/// Find the agent subdirectory inside .dovai/ by loading agent.json.
fn detect_agent_dir(workspace_dir: &Path) -> Option<PathBuf> {
    let config = dovai_agent::AgentConfig::load(&workspace_dir.to_string_lossy()).ok()?;
    let dir = workspace_dir.join(".dovai").join(&config.name);
    if dir.exists() {
        Some(dir)
    } else {
        None
    }
}

/// Returns whether at least one provider has been configured with an API key.
/// Used by the first-run flow to detect when the user has finished setup.
async fn get_config_ready(State(s): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let settings = read_settings_json(&s.config_home);
    let has_key = has_any_provider_key(&settings);
    let model = settings
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Json(serde_json::json!({ "ready": has_key, "model": model }))
}

/// Check if any provider has a non-empty API key in settings.json.
fn has_any_provider_key(settings: &serde_json::Value) -> bool {
    // Check modern providers block
    if let Some(providers) = settings.get("providers").and_then(|v| v.as_object()) {
        for (_, cred) in providers {
            if let Some(key) = cred.get("api_key").and_then(|v| v.as_str()) {
                if !key.is_empty() {
                    return true;
                }
            }
            // Local provider — check endpoint instead of key
            if let Some(ep) = cred.get("endpoint").and_then(|v| v.as_str()) {
                if !ep.is_empty() {
                    return true;
                }
            }
        }
    }
    // Check legacy env block
    if let Some(env_obj) = settings.get("env").and_then(|v| v.as_object()) {
        for key in ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"] {
            if let Some(val) = env_obj.get(key).and_then(|v| v.as_str()) {
                if !val.is_empty() {
                    return true;
                }
            }
        }
    }
    false
}

#[allow(clippy::too_many_lines)]
async fn get_config(State(s): State<Arc<AppState>>) -> Json<ConfigPayload> {
    let settings = read_settings_json(&s.config_home);

    let (connections, routing) = if settings
        .get("connections")
        .and_then(|v| v.as_array())
        .is_some()
    {
        // New format — parse directly
        let connections: Vec<AiConnection> =
            serde_json::from_value(settings.get("connections").cloned().unwrap_or_default())
                .unwrap_or_default();
        let routing: TaskRouting =
            serde_json::from_value(settings.get("routing").cloned().unwrap_or_default())
                .unwrap_or_default();
        (connections, routing)
    } else {
        // Legacy format — synthesize
        migrate_legacy_to_connections(&settings, s.workspace.as_ref())
    };

    // Build providers map — try settings.providers, then connections (old format), then env block
    let providers: BTreeMap<String, ProviderCredentials> = settings
        .get("providers")
        .and_then(|p| serde_json::from_value(p.clone()).ok())
        .unwrap_or_else(|| {
            let mut p = BTreeMap::new();
            // Extract from connections (old format had api_key on connections)
            for conn in &connections {
                if conn.provider == "local" && !conn.endpoint.is_empty() {
                    p.entry("local".to_string()).or_insert(ProviderCredentials {
                        api_key: String::new(),
                        endpoint: conn.endpoint.clone(),
                    });
                } else if !conn.api_key.is_empty() {
                    p.entry(conn.provider.clone())
                        .or_insert(ProviderCredentials {
                            api_key: conn.api_key.clone(),
                            endpoint: String::new(),
                        });
                }
            }
            // Fallback: extract from legacy env block
            if p.is_empty() {
                let eb = settings_env_block(&settings);
                for (provider, env_key) in [
                    ("anthropic", "ANTHROPIC_API_KEY"),
                    ("xai", "XAI_API_KEY"),
                    ("openai", "OPENAI_API_KEY"),
                ] {
                    if let Some(k) = eb.get(env_key).filter(|s| !s.is_empty()) {
                        p.insert(
                            provider.to_string(),
                            ProviderCredentials {
                                api_key: k.clone(),
                                endpoint: String::new(),
                            },
                        );
                    }
                }
            }
            p
        });

    let default_model = settings
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Derive legacy Keys from providers
    let keys = Keys {
        anthropic: providers
            .get("anthropic")
            .map(|p| p.api_key.clone())
            .unwrap_or_default(),
        xai: providers
            .get("xai")
            .map(|p| p.api_key.clone())
            .unwrap_or_default(),
        openai: providers
            .get("openai")
            .map(|p| p.api_key.clone())
            .unwrap_or_default(),
    };

    let (clerk, workspace) = if let Some(ws) = &s.workspace {
        let env = read_dotenv(&ws.env_path);
        let clerk = ClerkConfig {
            url: env.get("LM_STUDIO_URL").cloned().unwrap_or_default(),
            model: env.get("LM_STUDIO_MODEL").cloned().unwrap_or_default(),
        };
        let wspayload = WorkspacePayload {
            label: ws.label.clone(),
            agent_display_name: env.get("AGENT_DISPLAY_NAME").cloned().unwrap_or_default(),
            agent_email: env.get("AGENT_EMAIL").cloned().unwrap_or_default(),
            owner_name: env.get("OWNER_NAME").cloned().unwrap_or_default(),
        };
        (clerk, Some(wspayload))
    } else {
        (ClerkConfig::default(), None)
    };

    let owner_profile = s.workspace.as_ref().and_then(|ws| {
        let profile_path = ws.dir.join(".dovai").join("owner").join("profile.md");
        fs::read_to_string(&profile_path).ok()
    });

    let available_models = build_available_models(&providers).await;

    // Migrate routing from old conn_X IDs to provider:model format
    let routing = TaskRouting {
        pm: migrate_routing_slot(&routing.pm, &connections),
        simple: migrate_routing_slot(&routing.simple, &connections),
        complex: migrate_routing_slot(&routing.complex, &connections),
        clerk: migrate_routing_slot(&routing.clerk, &connections),
    };

    Json(ConfigPayload {
        providers,
        connections,
        routing,
        default_model,
        keys,
        clerk,
        workspace,
        owner_profile,
        available_models,
    })
}

async fn build_available_models(
    providers: &BTreeMap<String, ProviderCredentials>,
) -> Vec<ModelGroup> {
    let anthropic_key = providers
        .get("anthropic")
        .map_or("", |p| p.api_key.as_str());
    let xai_key = providers.get("xai").map_or("", |p| p.api_key.as_str());
    let openai_key = providers.get("openai").map_or("", |p| p.api_key.as_str());
    let local_endpoint = providers.get("local").map_or("", |p| p.endpoint.as_str());

    let has_anthropic = !anthropic_key.is_empty();
    let has_xai = !xai_key.is_empty();
    let has_openai = !openai_key.is_empty();
    let has_local = !local_endpoint.is_empty();

    // Fetch real model lists concurrently for providers that have keys.
    let (anthropic_models, xai_models, openai_models) = tokio::join!(
        fetch_models_or_fallback("Anthropic", has_anthropic, anthropic_key),
        fetch_models_or_fallback("xAI", has_xai, xai_key),
        fetch_models_or_fallback("OpenAI", has_openai, openai_key),
    );

    let mut groups = vec![
        ModelGroup {
            provider: "Anthropic".to_string(),
            provider_type: "anthropic".to_string(),
            available: has_anthropic,
            models: anthropic_models,
        },
        ModelGroup {
            provider: "xAI".to_string(),
            provider_type: "xai".to_string(),
            available: has_xai,
            models: xai_models,
        },
        ModelGroup {
            provider: "OpenAI".to_string(),
            provider_type: "openai".to_string(),
            available: has_openai,
            models: openai_models,
        },
    ];

    if has_local {
        let local_models = fetch_local_models_list(local_endpoint).await;
        groups.push(ModelGroup {
            provider: "Local".to_string(),
            provider_type: "local".to_string(),
            available: true,
            models: local_models,
        });
    }

    groups
}

/// Fetch models from a local OpenAI-compatible endpoint.
async fn fetch_local_models_list(endpoint: &str) -> Vec<ModelOption> {
    if endpoint.is_empty() {
        return vec![];
    }
    let url = format!("{}/v1/models", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::new();
    match tokio::time::timeout(std::time::Duration::from_secs(3), client.get(&url).send()).await {
        Ok(Ok(resp)) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|body| {
                body.get("data").and_then(|d| d.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            Some(ModelOption {
                                id: id.to_string(),
                                label: id.to_string(),
                            })
                        })
                        .collect()
                })
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// Migrate a routing slot from old `conn_X` format to provider:model,
/// carrying the connection label as the slot name.
fn migrate_routing_slot(slot: &RoutingSlot, connections: &[AiConnection]) -> RoutingSlot {
    if slot.model.is_empty() || slot.model.contains(':') {
        return slot.clone();
    }
    // Old format: connection ID in model field — convert to provider:model
    if let Some(conn) = connections.iter().find(|c| c.id == slot.model) {
        let model = if conn.model.is_empty() {
            String::new()
        } else {
            format!("{}:{}", conn.provider, conn.model)
        };
        let name = if slot.name.is_empty() {
            conn.label.clone()
        } else {
            slot.name.clone()
        };
        return RoutingSlot { name, model };
    }
    slot.clone()
}

/// Auto-derive connections from routing slots so downstream consumers
/// (PM coordinator, `delegate_task`) continue to work.
fn derive_connections_from_routing(
    routing: &TaskRouting,
    providers: &BTreeMap<String, ProviderCredentials>,
) -> Vec<AiConnection> {
    let mut connections = Vec::new();
    let slots = [
        ("pm", &routing.pm),
        ("simple", &routing.simple),
        ("complex", &routing.complex),
        ("clerk", &routing.clerk),
    ];
    for (key, slot) in slots {
        if slot.model.is_empty() {
            continue;
        }
        if let Some((provider, model)) = slot.model.split_once(':') {
            let endpoint = if provider == "local" {
                providers
                    .get("local")
                    .map(|p| p.endpoint.clone())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            connections.push(AiConnection {
                id: format!("route_{key}"),
                label: slot.name.clone(),
                provider: provider.to_string(),
                api_key: String::new(),
                endpoint,
                model: model.to_string(),
            });
        }
    }
    connections
}

/// Fetch real models from the provider API if a key exists, otherwise return
/// a small hardcoded fallback list (shown greyed-out for providers without keys).
async fn fetch_models_or_fallback(
    provider: &str,
    has_key: bool,
    api_key: &str,
) -> Vec<ModelOption> {
    if !has_key {
        return fallback_models(provider);
    }
    match fetch_models_from_api(provider, api_key).await {
        Ok(models) if !models.is_empty() => models,
        _ => fallback_models(provider),
    }
}

/// Hit the provider's list-models endpoint and return filtered results.
async fn fetch_models_from_api(provider: &str, api_key: &str) -> Result<Vec<ModelOption>, ()> {
    let client = reqwest::Client::new();

    let (url, is_anthropic) = match provider {
        "Anthropic" => (
            "https://api.anthropic.com/v1/models?limit=100".to_string(),
            true,
        ),
        "xAI" => ("https://api.x.ai/v1/models".to_string(), false),
        "OpenAI" => ("https://api.openai.com/v1/models".to_string(), false),
        _ => return Err(()),
    };

    let req = if is_anthropic {
        client
            .get(&url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
    } else {
        client.get(&url).bearer_auth(api_key)
    };

    let resp = tokio::time::timeout(std::time::Duration::from_secs(5), req.send())
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;

    if !resp.status().is_success() {
        return Err(());
    }

    let body: serde_json::Value = resp.json().await.map_err(|_| ())?;
    let data = body.get("data").and_then(|d| d.as_array()).ok_or(())?;

    let mut models: Vec<ModelOption> = data
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?;
            if !is_chat_model(provider, id) {
                return None;
            }
            // Anthropic provides display_name; others just use the id.
            let label = m
                .get("display_name")
                .and_then(|d| d.as_str())
                .unwrap_or(id)
                .to_string();
            Some(ModelOption {
                id: id.to_string(),
                label,
            })
        })
        .collect();

    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

/// Filter out embedding, image, audio, and other non-chat models.
fn is_chat_model(provider: &str, id: &str) -> bool {
    let m = id.to_ascii_lowercase();
    match provider {
        "Anthropic" => m.starts_with("claude"),
        "xAI" => m.starts_with("grok") && !m.contains("embedding"),
        "OpenAI" => {
            (m.starts_with("gpt-4")
                || m.starts_with("gpt-3.5")
                || m.starts_with("o1")
                || m.starts_with("o3")
                || m.starts_with("o4")
                || m.starts_with("chatgpt"))
                && !m.contains("audio")
                && !m.contains("realtime")
                && !m.contains("search")
        }
        _ => true,
    }
}

/// Minimal hardcoded list shown greyed-out when the provider has no key.
fn fallback_models(provider: &str) -> Vec<ModelOption> {
    let pairs: &[(&str, &str)] = match provider {
        "Anthropic" => &[
            ("claude-opus-4-6", "Claude Opus 4.6"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
            ("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
        ],
        "xAI" => &[("grok-3", "Grok 3"), ("grok-3-mini", "Grok 3 Mini")],
        "OpenAI" => &[
            ("gpt-4o", "GPT-4o"),
            ("gpt-4o-mini", "GPT-4o Mini"),
            ("o3", "o3"),
        ],
        _ => &[],
    };
    pairs
        .iter()
        .map(|(id, label)| ModelOption {
            id: id.to_string(),
            label: label.to_string(),
        })
        .collect()
}

#[allow(clippy::too_many_lines)]
async fn post_config(
    State(s): State<Arc<AppState>>,
    Json(body): Json<ConfigPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut settings = read_settings_json(&s.config_home);
    {
        let obj = ensure_object(&mut settings);

        // Write providers, routing, and auto-derived connections
        obj.insert(
            "providers".to_string(),
            serde_json::to_value(&body.providers).unwrap_or_default(),
        );
        obj.insert(
            "routing".to_string(),
            serde_json::to_value(&body.routing).unwrap_or_default(),
        );
        // Auto-derive connections from routing slots for backward compat
        let derived_connections = derive_connections_from_routing(&body.routing, &body.providers);
        obj.insert(
            "connections".to_string(),
            serde_json::to_value(&derived_connections).unwrap_or_default(),
        );

        // Derive legacy model from direct tasks (simple) routing value —
        // this is the default model used when no agent name is mentioned.
        let default_model = body.routing.simple.model.split_once(':').map_or_else(
            || body.routing.simple.model.clone(),
            |(_, model)| model.to_string(),
        );
        obj.insert(
            "model".to_string(),
            serde_json::Value::String(default_model.clone()),
        );

        // Derive legacy env block from providers
        let derived_env = derive_env_from_providers(&body.providers);
        let env_entry = obj
            .entry("env".to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if !env_entry.is_object() {
            *env_entry = serde_json::Value::Object(serde_json::Map::new());
        }
        let serde_json::Value::Object(env_obj) = env_entry else {
            unreachable!()
        };
        // Clear old keys, write derived ones
        for key in &["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"] {
            env_obj.remove(*key);
        }
        for (k, v) in &derived_env {
            env_obj.insert(k.clone(), serde_json::Value::String(v.clone()));
        }
        // Setting ANTHROPIC_API_KEY invalidates any lingering bearer token
        if derived_env.contains_key("ANTHROPIC_API_KEY") {
            env_obj.remove("ANTHROPIC_AUTH_TOKEN");
        }

        // Signal model switch with direct tasks model (the default)
        if !default_model.is_empty() {
            set_pending_model_switch(&default_model);
        }
    }
    write_settings_json(&s.config_home, &settings)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Workspace: update .dovai/.env
    if let Some(ws) = &s.workspace {
        let mut env = read_dotenv(&ws.env_path);

        // Derive clerk settings from routing value (provider:model)
        if let Some((clerk_provider, clerk_model)) = body.routing.clerk.model.split_once(':') {
            if clerk_provider == "local" {
                let endpoint = body
                    .providers
                    .get("local")
                    .map_or("http://127.0.0.1:1234", |p| p.endpoint.as_str());
                let ep = if endpoint.is_empty() {
                    "http://127.0.0.1:1234"
                } else {
                    endpoint
                };
                update_env_pair(&mut env, "LM_STUDIO_URL", ep);
                update_env_pair(&mut env, "LM_STUDIO_MODEL", clerk_model);
            } else {
                // Cloud model as clerk — clear local settings
                env.remove("LM_STUDIO_URL");
                env.remove("LM_STUDIO_MODEL");
            }
        } else {
            env.remove("LM_STUDIO_URL");
            env.remove("LM_STUDIO_MODEL");
        }

        if let Some(wsid) = &body.workspace {
            update_env_pair(&mut env, "AGENT_DISPLAY_NAME", &wsid.agent_display_name);
            update_env_pair(&mut env, "AGENT_EMAIL", &wsid.agent_email);
            update_env_pair(&mut env, "OWNER_NAME", &wsid.owner_name);
        }
        write_dotenv(&ws.env_path, &env).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

        // Write owner profile if provided
        if let Some(profile_text) = &body.owner_profile {
            let owner_dir = ws.dir.join(".dovai").join("owner");
            let _ = fs::create_dir_all(&owner_dir);
            let profile_path = owner_dir.join("profile.md");
            fs::write(&profile_path, profile_text).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("write owner profile: {e}"),
                )
            })?;
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

fn migrate_legacy_to_connections(
    settings: &serde_json::Value,
    workspace: Option<&WorkspaceCtx>,
) -> (Vec<AiConnection>, TaskRouting) {
    let env_block = settings_env_block(settings);
    let model = settings.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let mut connections = Vec::new();
    let mut id_counter = 1u32;
    let mut complex_id = String::new();

    // Create connections for each provider that has a key
    let providers: &[(&str, &str, &str)] = &[
        ("anthropic", "ANTHROPIC_API_KEY", "Anthropic"),
        ("xai", "XAI_API_KEY", "xAI"),
        ("openai", "OPENAI_API_KEY", "OpenAI"),
    ];

    for &(provider, env_key, label) in providers {
        if let Some(key) = env_block.get(env_key).filter(|k| !k.is_empty()) {
            let id = format!("conn_{id_counter}");
            id_counter += 1;
            // Check if the current model belongs to this provider
            let is_active = match provider {
                "anthropic" => {
                    model.contains("claude")
                        || model.contains("opus")
                        || model.contains("sonnet")
                        || model.contains("haiku")
                }
                "xai" => model.contains("grok"),
                "openai" => {
                    model.contains("gpt")
                        || model.starts_with("o1")
                        || model.starts_with("o3")
                        || model.starts_with("o4")
                }
                _ => false,
            };
            let conn_model = if is_active {
                model.to_string()
            } else {
                String::new()
            };
            if is_active && complex_id.is_empty() {
                complex_id.clone_from(&id);
            }
            connections.push(AiConnection {
                id,
                label: label.to_string(),
                provider: provider.to_string(),
                api_key: key.clone(),
                endpoint: String::new(),
                model: conn_model,
            });
        }
    }

    // Clerk from workspace .env
    let mut clerk_id = String::new();
    if let Some(ws) = workspace {
        let env = read_dotenv(&ws.env_path);
        let clerk_url = env.get("LM_STUDIO_URL").cloned().unwrap_or_default();
        let clerk_model = env.get("LM_STUDIO_MODEL").cloned().unwrap_or_default();
        if !clerk_model.is_empty() || !clerk_url.is_empty() {
            let id = format!("conn_{id_counter}");
            clerk_id.clone_from(&id);
            connections.push(AiConnection {
                id,
                label: "Local (Filing Clerk)".to_string(),
                provider: "local".to_string(),
                api_key: String::new(),
                endpoint: if clerk_url.is_empty() {
                    "http://127.0.0.1:1234".to_string()
                } else {
                    clerk_url
                },
                model: clerk_model,
            });
        }
    }

    // If no complex_id found but we have connections, use the first one
    if complex_id.is_empty() && !connections.is_empty() {
        complex_id.clone_from(&connections[0].id);
    }

    let routing = TaskRouting {
        pm: RoutingSlot::default(),
        simple: RoutingSlot {
            name: String::new(),
            model: complex_id.clone(),
        },
        complex: RoutingSlot {
            name: String::new(),
            model: complex_id,
        },
        clerk: RoutingSlot {
            name: String::new(),
            model: clerk_id,
        },
    };
    (connections, routing)
}

fn derive_env_from_providers(
    providers: &BTreeMap<String, ProviderCredentials>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let mapping = [
        ("anthropic", "ANTHROPIC_API_KEY"),
        ("xai", "XAI_API_KEY"),
        ("openai", "OPENAI_API_KEY"),
    ];
    for (provider, env_key) in mapping {
        if let Some(cred) = providers.get(provider) {
            if !cred.api_key.is_empty() {
                env.insert(env_key.to_string(), cred.api_key.clone());
            }
        }
    }
    env
}

#[derive(Deserialize)]
struct FetchModelsRequest {
    provider: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    endpoint: String,
}

#[derive(Serialize)]
struct FetchModelsResponse {
    ok: bool,
    models: Vec<ModelOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn fetch_models_for_connection(
    Json(req): Json<FetchModelsRequest>,
) -> Json<FetchModelsResponse> {
    let provider_label = match req.provider.as_str() {
        "anthropic" => "Anthropic",
        "xai" => "xAI",
        "openai" => "OpenAI",
        "local" => {
            // For local providers, try to fetch from the endpoint
            let endpoint = if req.endpoint.is_empty() {
                "http://127.0.0.1:1234".to_string()
            } else {
                req.endpoint.trim_end_matches('/').to_string()
            };
            let url = format!("{endpoint}/v1/models");
            let client = reqwest::Client::new();
            match tokio::time::timeout(std::time::Duration::from_secs(3), client.get(&url).send())
                .await
            {
                Ok(Ok(resp)) if resp.status().is_success() => {
                    if let Ok(body) = resp.json::<serde_json::Value>().await {
                        let models = body
                            .get("data")
                            .and_then(|d| d.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|m| {
                                        let id = m.get("id")?.as_str()?;
                                        Some(ModelOption {
                                            id: id.to_string(),
                                            label: id.to_string(),
                                        })
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        return Json(FetchModelsResponse {
                            ok: true,
                            models,
                            error: None,
                        });
                    }
                    return Json(FetchModelsResponse {
                        ok: false,
                        models: vec![],
                        error: Some("Failed to parse response".to_string()),
                    });
                }
                Ok(Ok(resp)) => {
                    return Json(FetchModelsResponse {
                        ok: false,
                        models: vec![],
                        error: Some(format!("Server returned HTTP {}", resp.status())),
                    });
                }
                Ok(Err(e)) => {
                    return Json(FetchModelsResponse {
                        ok: false,
                        models: vec![],
                        error: Some(format!("Connection failed: {e}")),
                    });
                }
                Err(_) => {
                    return Json(FetchModelsResponse {
                        ok: false,
                        models: vec![],
                        error: Some("Connection timed out".to_string()),
                    });
                }
            }
        }
        _ => {
            return Json(FetchModelsResponse {
                ok: false,
                models: vec![],
                error: Some(format!("Unknown provider: {}", req.provider)),
            });
        }
    };

    let has_key = !req.api_key.is_empty();
    if !has_key {
        return Json(FetchModelsResponse {
            ok: true,
            models: fallback_models(provider_label),
            error: None,
        });
    }

    match fetch_models_from_api(provider_label, &req.api_key).await {
        Ok(models) => Json(FetchModelsResponse {
            ok: true,
            models,
            error: None,
        }),
        Err(()) => Json(FetchModelsResponse {
            ok: false,
            models: fallback_models(provider_label),
            error: Some("Failed to fetch models — showing defaults".to_string()),
        }),
    }
}

fn update_env_pair(env: &mut BTreeMap<String, String>, key: &str, value: &str) {
    if value.is_empty() {
        env.remove(key);
    } else {
        env.insert(key.to_string(), value.to_string());
    }
}

// ---- Usage API ----------------------------------------------------------

/// Per-provider token bucket.
#[derive(Serialize, Default, Clone)]
struct ProviderUsage {
    provider: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    total_tokens: u64,
    estimated_cost_usd: f64,
}

/// Token totals for a time period.
#[derive(Serialize, Default, Clone)]
struct PeriodUsage {
    label: String,
    total_tokens: u64,
    estimated_cost_usd: f64,
    sessions: u64,
}

#[derive(Serialize, Default)]
struct UsagePayload {
    /// Totals across all time.
    total_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    estimated_cost_usd: f64,
    pricing_model: String,
    sessions_scanned: u64,
    /// Per-provider breakdown.
    providers: Vec<ProviderUsage>,
    /// Per-period breakdown: today, 7 days, 30 days, all time.
    periods: Vec<PeriodUsage>,
}

async fn get_usage(State(s): State<Arc<AppState>>) -> Json<UsagePayload> {
    let Some(ws) = &s.workspace else {
        return Json(UsagePayload {
            pricing_model: "n/a".into(),
            ..Default::default()
        });
    };
    let sessions_dir = ws.dir.join(".dovai").join("sessions");
    let settings = read_settings_json(&s.config_home);
    let default_model = settings
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Json(scan_sessions(&sessions_dir, &default_model))
}

/// Intermediate per-session accumulator.
struct SessionTokens {
    model: String,
    created_at_ms: u64,
    input: u64,
    output: u64,
    cache_w: u64,
    cache_r: u64,
}

#[allow(clippy::too_many_lines, clippy::similar_names)]
fn scan_sessions(sessions_dir: &Path, default_model: &str) -> UsagePayload {
    let mut all_sessions: Vec<SessionTokens> = Vec::new();
    let Ok(entries) = fs::read_dir(sessions_dir) else {
        return UsagePayload {
            pricing_model: default_model.to_string(),
            ..Default::default()
        };
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };

        let mut model: Option<String> = None;
        let mut created_at_ms: u64 = 0;
        let mut input: u64 = 0;
        let mut output: u64 = 0;
        let mut cache_w: u64 = 0;
        let mut cache_r: u64 = 0;

        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            // Extract session meta (first line).
            if val.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
                created_at_ms = val
                    .get("created_at_ms")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                model = val
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string);
            }
            // Accumulate usage from message records.
            let usage = val
                .get("message")
                .and_then(|m| m.get("usage"))
                .or_else(|| val.get("usage"));
            let Some(usage) = usage else { continue };
            input += usage_field(usage, "input_tokens");
            output += usage_field(usage, "output_tokens");
            cache_w += usage_field(usage, "cache_creation_input_tokens");
            cache_r += usage_field(usage, "cache_read_input_tokens");
        }

        // Fallback: if no created_at_ms in meta, parse from filename.
        if created_at_ms == 0 {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                // session-1775310617945-0
                if let Some(ts) = stem.strip_prefix("session-") {
                    if let Some(ms_str) = ts.split('-').next() {
                        created_at_ms = ms_str.parse().unwrap_or(0);
                    }
                }
            }
        }

        let total = input + output + cache_w + cache_r;
        if total > 0 {
            all_sessions.push(SessionTokens {
                model: model.unwrap_or_else(|| default_model.to_string()),
                created_at_ms,
                input,
                output,
                cache_w,
                cache_r,
            });
        }
    }

    let sessions_scanned = all_sessions.len() as u64;

    // ---- Aggregate totals ----
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    let mut total_cw: u64 = 0;
    let mut total_cr: u64 = 0;

    for s in &all_sessions {
        total_in += s.input;
        total_out += s.output;
        total_cw += s.cache_w;
        total_cr += s.cache_r;
    }
    let total_tokens = total_in + total_out + total_cw + total_cr;

    // ---- Per-provider breakdown ----
    let mut provider_map: BTreeMap<String, (u64, u64, u64, u64)> = BTreeMap::new();
    for s in &all_sessions {
        let e = provider_map.entry(s.model.clone()).or_default();
        e.0 += s.input;
        e.1 += s.output;
        e.2 += s.cache_w;
        e.3 += s.cache_r;
    }
    let providers: Vec<ProviderUsage> = provider_map
        .into_iter()
        .map(|(model, (inp, outp, cw, cr))| {
            let total = inp + outp + cw + cr;
            let cost = estimate_cost_raw(inp, outp, cw, cr, &model);
            ProviderUsage {
                provider: provider_label(&model),
                model,
                input_tokens: inp,
                output_tokens: outp,
                cache_creation_tokens: cw,
                cache_read_tokens: cr,
                total_tokens: total,
                estimated_cost_usd: cost,
            }
        })
        .collect();

    // ---- Per-period breakdown ----
    #[allow(clippy::cast_possible_truncation)]
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let hour_ms: u64 = 3_600_000;
    let day_ms: u64 = 86_400_000;
    let cutoffs: &[(&str, u64)] = &[
        ("Last hour", now_ms.saturating_sub(hour_ms)),
        ("Today", now_ms.saturating_sub(day_ms)),
        ("7 days", now_ms.saturating_sub(7 * day_ms)),
        ("30 days", now_ms.saturating_sub(30 * day_ms)),
        ("All time", 0),
    ];
    let periods: Vec<PeriodUsage> = cutoffs
        .iter()
        .map(|&(label, cutoff)| {
            let mut tokens: u64 = 0;
            let mut cost: f64 = 0.0;
            let mut sessions: u64 = 0;
            for s in &all_sessions {
                if s.created_at_ms >= cutoff {
                    let t = s.input + s.output + s.cache_w + s.cache_r;
                    tokens += t;
                    cost += estimate_cost_raw(s.input, s.output, s.cache_w, s.cache_r, &s.model);
                    sessions += 1;
                }
            }
            PeriodUsage {
                label: label.to_string(),
                total_tokens: tokens,
                estimated_cost_usd: cost,
                sessions,
            }
        })
        .collect();

    let estimated_cost_usd = providers.iter().map(|p| p.estimated_cost_usd).sum();

    UsagePayload {
        total_tokens,
        input_tokens: total_in,
        output_tokens: total_out,
        cache_creation_tokens: total_cw,
        cache_read_tokens: total_cr,
        estimated_cost_usd,
        pricing_model: default_model.to_string(),
        sessions_scanned,
        providers,
        periods,
    }
}

fn usage_field(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0)
}

#[allow(clippy::cast_precision_loss, clippy::similar_names)]
fn estimate_cost_raw(input: u64, output: u64, cache_w: u64, cache_r: u64, model: &str) -> f64 {
    let (in_rate, out_rate, cw_rate, cr_rate) = pricing_for(model);
    (input as f64 / 1_000_000.0) * in_rate
        + (output as f64 / 1_000_000.0) * out_rate
        + (cache_w as f64 / 1_000_000.0) * cw_rate
        + (cache_r as f64 / 1_000_000.0) * cr_rate
}

fn provider_label(model: &str) -> String {
    let m = model.to_ascii_lowercase();
    if m.contains("claude") || m.contains("haiku") || m.contains("opus") || m.contains("sonnet") {
        "Anthropic".to_string()
    } else if m.contains("grok") {
        "xAI".to_string()
    } else if m.contains("gpt") || m.contains("o1") || m.contains("o3") || m.contains("o4") {
        "OpenAI".to_string()
    } else {
        "Other".to_string()
    }
}

fn pricing_for(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_ascii_lowercase();
    if m.contains("haiku") {
        (1.0, 5.0, 1.25, 0.1)
    } else if m.contains("opus") {
        (15.0, 75.0, 18.75, 1.5)
    } else if m.contains("sonnet") {
        (3.0, 15.0, 3.75, 0.30)
    } else if m.contains("gpt-4o-mini") {
        (0.15, 0.60, 0.15, 0.075)
    } else if m.contains("gpt-4o") {
        (2.50, 10.0, 2.50, 1.25)
    } else if m.contains("grok") {
        (5.0, 15.0, 5.0, 2.5)
    } else {
        (3.0, 15.0, 3.75, 0.30) // unknown model — estimate using cheapest tier
    }
}

// ---- Settings JSON I/O --------------------------------------------------

fn resolve_config_home() -> PathBuf {
    if let Ok(p) = env::var("DOVAI_CONFIG_HOME") {
        return PathBuf::from(p);
    }
    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(".dovai");
    }
    PathBuf::from(".dovai")
}

fn settings_path(config_home: &Path) -> PathBuf {
    config_home.join("settings.json")
}

fn read_settings_json(config_home: &Path) -> serde_json::Value {
    let path = settings_path(config_home);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()))
}

fn write_settings_json(config_home: &Path, value: &serde_json::Value) -> Result<(), String> {
    let path = settings_path(config_home);
    let serialized =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize settings: {e}"))?;
    fs::write(&path, serialized).map_err(|e| format!("write {}: {e}", path.display()))
}

fn settings_env_block(settings: &serde_json::Value) -> BTreeMap<String, String> {
    let Some(env) = settings.get("env").and_then(|v| v.as_object()) else {
        return BTreeMap::new();
    };
    env.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
}

fn ensure_object(value: &mut serde_json::Value) -> &mut serde_json::Map<String, serde_json::Value> {
    if !value.is_object() {
        *value = serde_json::Value::Object(serde_json::Map::new());
    }
    match value {
        serde_json::Value::Object(m) => m,
        _ => unreachable!(),
    }
}

// ---- .env I/O (simple KEY=VALUE, preserves comments + order) -----------

fn read_dotenv(path: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(content) = fs::read_to_string(path) else {
        return out;
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let key = trimmed[..eq].trim().to_string();
            let raw_val = trimmed[eq + 1..].trim();
            // Strip surrounding double quotes and unescape
            let val = if raw_val.starts_with('"') && raw_val.ends_with('"') && raw_val.len() >= 2 {
                raw_val[1..raw_val.len() - 1]
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\")
            } else {
                raw_val.to_string()
            };
            out.insert(key, val);
        }
    }
    out
}

/// Quote a dotenv value if it contains characters that need quoting.
fn dotenv_format_value(key: &str, value: &str) -> String {
    if value.contains(' ')
        || value.contains('#')
        || value.contains('=')
        || value.contains('"')
        || value.contains('\'')
    {
        // Escape internal double quotes and wrap in double quotes
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        format!("{key}=\"{escaped}\"")
    } else {
        format!("{key}={value}")
    }
}

fn write_dotenv(path: &Path, env: &BTreeMap<String, String>) -> Result<(), String> {
    // Strategy: preserve existing comments & ordering, update matching keys,
    // append any new keys at end.
    let existing = fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in existing.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            lines.push(line.to_string());
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let key = trimmed[..eq].trim();
            if let Some(new_val) = env.get(key) {
                lines.push(dotenv_format_value(key, new_val));
                seen.insert(key.to_string());
            } else {
                // Key was removed — drop line.
            }
        } else {
            lines.push(line.to_string());
        }
    }
    // Append brand-new keys
    for (k, v) in env {
        if !seen.contains(k) {
            lines.push(dotenv_format_value(k, v));
        }
    }
    let content = lines.join("\n") + "\n";
    fs::write(path, content).map_err(|e| format!("write {}: {e}", path.display()))
}

// ---- Tasks & Processes API -----------------------------------------------

fn resolve_db_path(state: &AppState) -> Result<PathBuf, (StatusCode, String)> {
    let ws = state
        .workspace
        .as_ref()
        .ok_or((StatusCode::BAD_REQUEST, "No workspace detected".into()))?;
    let db_path = ws.dir.join(".dovai").join("data").join("tasks.db");
    if !db_path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            "tasks.db not found — run the agent once to initialise".into(),
        ));
    }
    Ok(db_path)
}

fn open_db(state: &AppState) -> Result<rusqlite::Connection, (StatusCode, String)> {
    let db_path = resolve_db_path(state)?;
    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("open db: {e}")))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("pragma: {e}")))?;
    Ok(conn)
}

/// Read all rows from a query into a `Vec<serde_json::Value>`.
fn query_rows(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<serde_json::Value>, (StatusCode, String)> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("prepare: {e}")))?;
    let col_names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(std::string::ToString::to_string)
        .collect();
    let rows = stmt
        .query_map(params, |row| {
            let mut map = serde_json::Map::new();
            for (i, name) in col_names.iter().enumerate() {
                let val: rusqlite::types::Value = row.get(i)?;
                map.insert(name.clone(), sqlite_value_to_json(val));
            }
            Ok(serde_json::Value::Object(map))
        })
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("query: {e}")))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("row: {e}")))?);
    }
    Ok(out)
}

fn sqlite_value_to_json(v: rusqlite::types::Value) -> serde_json::Value {
    match v {
        rusqlite::types::Value::Null => serde_json::Value::Null,
        rusqlite::types::Value::Integer(i) => serde_json::json!(i),
        rusqlite::types::Value::Real(f) => serde_json::json!(f),
        rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
        rusqlite::types::Value::Blob(b) => {
            serde_json::Value::String(format!("<blob {} bytes>", b.len()))
        }
    }
}

// ---- Task filter ----

#[derive(Deserialize, Default)]
struct TaskFilter {
    status: Option<String>,
    #[serde(rename = "type")]
    task_type: Option<String>,
    priority: Option<String>,
    assigned_to: Option<String>,
    parent_id: Option<String>, // "null" for root tasks, or a number
    process_id: Option<i64>,
    exclude_done: Option<bool>,
}

// ---- Tasks handlers ----

async fn api_list_tasks(
    State(s): State<Arc<AppState>>,
    Query(f): Query<TaskFilter>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let mut where_clauses = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(ref st) = f.status {
        where_clauses.push("status = ?");
        param_values.push(Box::new(st.clone()));
    }
    if let Some(ref t) = f.task_type {
        where_clauses.push("type = ?");
        param_values.push(Box::new(t.clone()));
    }
    if let Some(ref p) = f.priority {
        where_clauses.push("priority = ?");
        param_values.push(Box::new(p.clone()));
    }
    if let Some(ref a) = f.assigned_to {
        where_clauses.push("assigned_to = ?");
        param_values.push(Box::new(a.clone()));
    }
    if let Some(ref pid) = f.parent_id {
        if pid == "null" {
            where_clauses.push("parent_id IS NULL");
        } else if let Ok(n) = pid.parse::<i64>() {
            where_clauses.push("parent_id = ?");
            param_values.push(Box::new(n));
        }
    }
    if let Some(pid) = f.process_id {
        where_clauses.push("process_id = ?");
        param_values.push(Box::new(pid));
    }
    if f.exclude_done.unwrap_or(false) {
        where_clauses.push("status NOT IN ('done','skipped','failed')");
    }
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT * FROM tasks {where_sql} ORDER BY \
         CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 END, \
         due_at ASC NULLS LAST, id ASC"
    );
    let params: Vec<&dyn rusqlite::types::ToSql> = param_values
        .iter()
        .map(std::convert::AsRef::as_ref)
        .collect();
    let rows = query_rows(&conn, &sql, &params)?;
    Ok(Json(serde_json::json!({ "tasks": rows })))
}

#[derive(Deserialize)]
struct CreateTaskBody {
    title: String,
    description: Option<String>,
    #[serde(rename = "type", default = "default_task_type")]
    task_type: String,
    #[serde(default = "default_pending")]
    status: String,
    #[serde(default = "default_normal")]
    priority: String,
    due_at: Option<String>,
    deadline: Option<String>,
    #[serde(default = "default_agent")]
    assigned_to: String,
    notify: Option<serde_json::Value>,
    detail_path: Option<String>,
    parent_id: Option<i64>,
    process_id: Option<i64>,
    process_step: Option<i64>,
    goal_id: Option<i64>,
    plan_id: Option<i64>,
}

fn default_task_type() -> String {
    "task".into()
}
fn default_pending() -> String {
    "pending".into()
}
fn default_normal() -> String {
    "normal".into()
}
fn default_agent() -> String {
    "agent".into()
}

async fn api_create_task(
    State(s): State<Arc<AppState>>,
    Json(body): Json<CreateTaskBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let notify_str = body.notify.as_ref().map(std::string::ToString::to_string);
    conn.execute(
        "INSERT INTO tasks (title, description, type, status, priority, due_at, deadline, assigned_to, notify, detail_path, parent_id, process_id, process_step, goal_id, plan_id) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        rusqlite::params![
            body.title,
            body.description,
            body.task_type,
            body.status,
            body.priority,
            body.due_at,
            body.deadline,
            body.assigned_to,
            notify_str,
            body.detail_path,
            body.parent_id,
            body.process_id,
            body.process_step,
            body.goal_id,
            body.plan_id,
        ],
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("insert: {e}")))?;
    let id = conn.last_insert_rowid();
    let rows = query_rows(&conn, "SELECT * FROM tasks WHERE id = ?", &[&id])?;
    Ok(Json(serde_json::json!({ "task": rows.into_iter().next() })))
}

async fn api_get_task(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let rows = query_rows(&conn, "SELECT * FROM tasks WHERE id = ?", &[&id])?;
    match rows.into_iter().next() {
        Some(task) => Ok(Json(serde_json::json!({ "task": task }))),
        None => Err((StatusCode::NOT_FOUND, format!("task {id} not found"))),
    }
}

#[derive(Deserialize)]
struct UpdateTaskBody {
    title: Option<String>,
    description: Option<String>,
    #[serde(rename = "type")]
    task_type: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    due_at: Option<serde_json::Value>,
    deadline: Option<serde_json::Value>,
    assigned_to: Option<String>,
    notify: Option<serde_json::Value>,
    detail_path: Option<serde_json::Value>,
    parent_id: Option<serde_json::Value>,
    process_id: Option<serde_json::Value>,
    process_step: Option<serde_json::Value>,
    output_notes: Option<String>,
    goal_id: Option<serde_json::Value>,
    plan_id: Option<serde_json::Value>,
}

async fn api_update_task(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Json(body): Json<UpdateTaskBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    macro_rules! maybe_set {
        ($field:ident, $col:expr) => {
            if let Some(ref v) = body.$field {
                sets.push(format!("{} = ?", $col));
                params.push(Box::new(v.clone()));
            }
        };
    }
    macro_rules! maybe_set_json {
        ($field:ident, $col:expr) => {
            if let Some(ref v) = body.$field {
                sets.push(format!("{} = ?", $col));
                match v {
                    serde_json::Value::Null => params.push(Box::new(rusqlite::types::Null)),
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            params.push(Box::new(i));
                        } else {
                            params.push(Box::new(v.to_string()));
                        }
                    }
                    serde_json::Value::String(s) => params.push(Box::new(s.clone())),
                    _ => params.push(Box::new(v.to_string())),
                }
            }
        };
    }

    maybe_set!(title, "title");
    maybe_set!(description, "description");
    maybe_set!(task_type, "type");
    maybe_set!(priority, "priority");
    maybe_set!(assigned_to, "assigned_to");
    maybe_set!(output_notes, "output_notes");
    maybe_set_json!(due_at, "due_at");
    maybe_set_json!(deadline, "deadline");
    maybe_set_json!(detail_path, "detail_path");
    maybe_set_json!(parent_id, "parent_id");
    maybe_set_json!(process_id, "process_id");
    maybe_set_json!(process_step, "process_step");
    maybe_set_json!(goal_id, "goal_id");
    maybe_set_json!(plan_id, "plan_id");

    if let Some(ref v) = body.notify {
        sets.push("notify = ?".into());
        match v {
            serde_json::Value::Null => params.push(Box::new(rusqlite::types::Null)),
            _ => params.push(Box::new(v.to_string())),
        }
    }

    // Handle status separately for completed_at auto-set
    if let Some(ref st) = body.status {
        sets.push("status = ?".into());
        params.push(Box::new(st.clone()));
        if st == "done" || st == "skipped" || st == "failed" {
            sets.push("completed_at = datetime('now')".into());
        }
        if st == "claimed" {
            sets.push("claimed_at = datetime('now')".into());
        }
    }

    if sets.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no fields to update".into()));
    }
    sets.push("updated_at = datetime('now')".into());

    let sql = format!("UPDATE tasks SET {} WHERE id = ?", sets.join(", "));
    params.push(Box::new(id));
    let p: Vec<&dyn rusqlite::types::ToSql> =
        params.iter().map(std::convert::AsRef::as_ref).collect();
    conn.execute(&sql, p.as_slice())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("update: {e}")))?;

    let rows = query_rows(&conn, "SELECT * FROM tasks WHERE id = ?", &[&id])?;
    Ok(Json(serde_json::json!({ "task": rows.into_iter().next() })))
}

async fn api_delete_task(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    // Delete subtasks first
    conn.execute("DELETE FROM tasks WHERE parent_id = ?", [id])
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("delete sub: {e}"),
            )
        })?;
    conn.execute("DELETE FROM tasks WHERE id = ?", [id])
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("delete: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn api_get_subtasks(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let rows = query_rows(
        &conn,
        "SELECT * FROM tasks WHERE parent_id = ? ORDER BY \
         CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 END, \
         due_at ASC NULLS LAST, id ASC",
        &[&id],
    )?;
    Ok(Json(serde_json::json!({ "subtasks": rows })))
}

// ---- Processes handlers ----

async fn api_list_processes(
    State(s): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let rows = query_rows(&conn, "SELECT * FROM processes ORDER BY name ASC", &[])?;
    Ok(Json(serde_json::json!({ "processes": rows })))
}

#[derive(Deserialize)]
struct CreateProcessBody {
    name: String,
    description: Option<String>,
    #[serde(default = "default_manual")]
    trigger_type: String,
    category: Option<String>,
}

fn default_manual() -> String {
    "manual".into()
}

async fn api_create_process(
    State(s): State<Arc<AppState>>,
    Json(body): Json<CreateProcessBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    conn.execute(
        "INSERT INTO processes (name, description, trigger_type, category) VALUES (?1,?2,?3,?4)",
        rusqlite::params![
            body.name,
            body.description,
            body.trigger_type,
            body.category
        ],
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("insert: {e}")))?;
    let id = conn.last_insert_rowid();
    let rows = query_rows(&conn, "SELECT * FROM processes WHERE id = ?", &[&id])?;
    Ok(Json(
        serde_json::json!({ "process": rows.into_iter().next() }),
    ))
}

async fn api_get_process(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let proc_rows = query_rows(&conn, "SELECT * FROM processes WHERE id = ?", &[&id])?;
    let process = proc_rows
        .into_iter()
        .next()
        .ok_or((StatusCode::NOT_FOUND, format!("process {id} not found")))?;
    let steps = query_rows(
        &conn,
        "SELECT * FROM process_steps WHERE process_id = ? ORDER BY sort_order ASC, id ASC",
        &[&id],
    )?;
    let feedback = query_rows(
        &conn,
        "SELECT * FROM process_feedback WHERE process_id = ? ORDER BY step_id ASC, created_at ASC",
        &[&id],
    )?;
    Ok(Json(serde_json::json!({
        "process": process,
        "steps": steps,
        "feedback": feedback,
    })))
}

#[derive(Deserialize)]
struct UpdateProcessBody {
    name: Option<String>,
    description: Option<String>,
    trigger_type: Option<String>,
    category: Option<String>,
    active: Option<bool>,
}

async fn api_update_process(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Json(body): Json<UpdateProcessBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref v) = body.name {
        sets.push("name = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = body.description {
        sets.push("description = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = body.trigger_type {
        sets.push("trigger_type = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = body.category {
        sets.push("category = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = body.active {
        sets.push("active = ?");
        params.push(Box::new(i64::from(v)));
    }

    if sets.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no fields to update".into()));
    }
    let sql = format!(
        "UPDATE processes SET {}, updated_at = datetime('now') WHERE id = ?",
        sets.join(", ")
    );
    params.push(Box::new(id));
    let p: Vec<&dyn rusqlite::types::ToSql> =
        params.iter().map(std::convert::AsRef::as_ref).collect();
    conn.execute(&sql, p.as_slice())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("update: {e}")))?;

    let rows = query_rows(&conn, "SELECT * FROM processes WHERE id = ?", &[&id])?;
    Ok(Json(
        serde_json::json!({ "process": rows.into_iter().next() }),
    ))
}

async fn api_delete_process(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    conn.execute("DELETE FROM processes WHERE id = ?", [id])
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("delete: {e}")))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---- Process steps handlers ----

#[derive(Deserialize)]
struct CreateStepBody {
    title: String,
    description: Option<String>,
    sort_order: Option<i64>,
    offset_days: Option<i64>,
    #[serde(default = "default_agent")]
    assigned_to: String,
    #[serde(default)]
    needs_approval: bool,
    deliverables: Option<serde_json::Value>,
    notify: Option<serde_json::Value>,
}

async fn api_create_step(
    State(s): State<Arc<AppState>>,
    AxumPath(process_id): AxumPath<i64>,
    Json(body): Json<CreateStepBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let sort_order = if let Some(o) = body.sort_order {
        o
    } else {
        let max: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM process_steps WHERE process_id = ?",
                [process_id],
                |row| row.get(0),
            )
            .unwrap_or(-1);
        max + 1
    };
    let deliverables_str = body
        .deliverables
        .as_ref()
        .map(std::string::ToString::to_string);
    let notify_str = body.notify.as_ref().map(std::string::ToString::to_string);
    conn.execute(
        "INSERT INTO process_steps (process_id, sort_order, title, description, offset_days, assigned_to, needs_approval, deliverables, notify) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            process_id,
            sort_order,
            body.title,
            body.description,
            body.offset_days,
            body.assigned_to,
            i64::from(body.needs_approval),
            deliverables_str,
            notify_str,
        ],
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("insert step: {e}")))?;
    let id = conn.last_insert_rowid();
    let rows = query_rows(&conn, "SELECT * FROM process_steps WHERE id = ?", &[&id])?;
    Ok(Json(serde_json::json!({ "step": rows.into_iter().next() })))
}

#[derive(Deserialize)]
struct UpdateStepBody {
    title: Option<String>,
    description: Option<String>,
    sort_order: Option<i64>,
    offset_days: Option<serde_json::Value>,
    assigned_to: Option<String>,
    needs_approval: Option<bool>,
    deliverables: Option<serde_json::Value>,
    notify: Option<serde_json::Value>,
}

async fn api_update_step(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Json(body): Json<UpdateStepBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref v) = body.title {
        sets.push("title = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = body.description {
        sets.push("description = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = body.sort_order {
        sets.push("sort_order = ?");
        params.push(Box::new(v));
    }
    if let Some(ref v) = body.offset_days {
        sets.push("offset_days = ?");
        if let serde_json::Value::Number(n) = v {
            params.push(Box::new(n.as_i64().unwrap_or(0)));
        } else {
            params.push(Box::new(rusqlite::types::Null));
        }
    }
    if let Some(ref v) = body.assigned_to {
        sets.push("assigned_to = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = body.needs_approval {
        sets.push("needs_approval = ?");
        params.push(Box::new(i64::from(v)));
    }
    if let Some(ref v) = body.deliverables {
        sets.push("deliverables = ?");
        match v {
            serde_json::Value::Null => params.push(Box::new(rusqlite::types::Null)),
            _ => params.push(Box::new(v.to_string())),
        }
    }
    if let Some(ref v) = body.notify {
        sets.push("notify = ?");
        match v {
            serde_json::Value::Null => params.push(Box::new(rusqlite::types::Null)),
            _ => params.push(Box::new(v.to_string())),
        }
    }

    if sets.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no fields to update".into()));
    }
    let sql = format!(
        "UPDATE process_steps SET {}, updated_at = datetime('now') WHERE id = ?",
        sets.join(", ")
    );
    params.push(Box::new(id));
    let p: Vec<&dyn rusqlite::types::ToSql> =
        params.iter().map(std::convert::AsRef::as_ref).collect();
    conn.execute(&sql, p.as_slice()).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("update step: {e}"),
        )
    })?;

    let rows = query_rows(&conn, "SELECT * FROM process_steps WHERE id = ?", &[&id])?;
    Ok(Json(serde_json::json!({ "step": rows.into_iter().next() })))
}

async fn api_delete_step(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    conn.execute("DELETE FROM process_steps WHERE id = ?", [id])
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("delete step: {e}"),
            )
        })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ReorderStepsBody {
    step_ids: Vec<i64>,
}

#[allow(clippy::cast_possible_wrap)]
async fn api_reorder_steps(
    State(s): State<Arc<AppState>>,
    AxumPath(process_id): AxumPath<i64>,
    Json(body): Json<ReorderStepsBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    for (i, step_id) in body.step_ids.iter().enumerate() {
        conn.execute(
            "UPDATE process_steps SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND process_id = ?",
            rusqlite::params![i as i64, step_id, process_id],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("reorder: {e}")))?;
    }
    let steps = query_rows(
        &conn,
        "SELECT * FROM process_steps WHERE process_id = ? ORDER BY sort_order ASC, id ASC",
        &[&process_id],
    )?;
    Ok(Json(serde_json::json!({ "steps": steps })))
}

// ---- Activate process ----

#[derive(Deserialize)]
struct ActivateProcessBody {
    reference_date: String,
    parent_title: Option<String>,
}

async fn api_activate_process(
    State(s): State<Arc<AppState>>,
    AxumPath(process_id): AxumPath<i64>,
    Json(body): Json<ActivateProcessBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;

    // Get process
    let proc_rows = query_rows(
        &conn,
        "SELECT * FROM processes WHERE id = ?",
        &[&process_id],
    )?;
    let process = proc_rows.into_iter().next().ok_or((
        StatusCode::NOT_FOUND,
        format!("process {process_id} not found"),
    ))?;
    let proc_name = process["name"].as_str().unwrap_or("Process");

    // Get steps
    let steps = query_rows(
        &conn,
        "SELECT * FROM process_steps WHERE process_id = ? ORDER BY sort_order ASC, id ASC",
        &[&process_id],
    )?;
    if steps.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "process has no steps".into()));
    }

    // Parse reference date
    let ref_date = chrono_parse_date(&body.reference_date).ok_or((
        StatusCode::BAD_REQUEST,
        format!("invalid date: {}", body.reference_date),
    ))?;

    // Create parent task
    let parent_title = body
        .parent_title
        .unwrap_or_else(|| format!("{} ({})", proc_name, body.reference_date));
    let slug = proc_name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric(), "-")
        .trim_matches('-')
        .to_string();
    let detail_path = format!(".dovai/processes/{slug}.md");

    let proc_desc = process["description"]
        .as_str()
        .map(std::string::ToString::to_string);
    conn.execute(
        "INSERT INTO tasks (title, description, type, status, priority, assigned_to, process_id, detail_path) \
         VALUES (?1,?2,'sop_step','in_progress','normal','agent',?3,?4)",
        rusqlite::params![parent_title, proc_desc, process_id, detail_path],
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("insert parent: {e}")))?;
    let parent_id = conn.last_insert_rowid();

    // Create child tasks from steps
    let mut created = Vec::new();
    for step in &steps {
        let offset = step["offset_days"].as_i64();
        let due_at = offset.map(|off| {
            let d = add_days_to_packed(ref_date, off);
            format!(
                "{:04}-{:02}-{:02} 07:00:00",
                d / 10000,
                (d / 100) % 100,
                d % 100
            )
        });
        let step_title = step["title"].as_str().unwrap_or("Step").to_string();
        let step_desc = step["description"]
            .as_str()
            .map(std::string::ToString::to_string);
        let assigned = step["assigned_to"].as_str().unwrap_or("agent").to_string();
        let sort_order = step["sort_order"].as_i64().unwrap_or(0);
        let step_notify = step.get("notify").and_then(|v| {
            if v.is_null() {
                None
            } else {
                Some(v.to_string())
            }
        });

        conn.execute(
            "INSERT INTO tasks (title, description, type, status, priority, due_at, assigned_to, notify, parent_id, process_id, process_step, detail_path) \
             VALUES (?1,?2,'sop_step','pending','normal',?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![
                step_title, step_desc, due_at, assigned, step_notify,
                parent_id, process_id, sort_order, detail_path,
            ],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("insert step task: {e}")))?;
        let task_id = conn.last_insert_rowid();
        created.push(
            serde_json::json!({ "task_id": task_id, "step_title": step_title, "due_at": due_at }),
        );
    }

    Ok(Json(serde_json::json!({
        "parent_id": parent_id,
        "tasks_created": created.len(),
        "tasks": created,
    })))
}

/// Simple date math: parse YYYY-MM-DD into a packed int, add days, format back.
fn chrono_parse_date(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let d: i64 = parts[2].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(y * 10000 + m * 100 + d)
}

fn add_days_to_packed(packed: i64, days: i64) -> i64 {
    // Convert to Julian Day Number, add days, convert back
    let y = packed / 10000;
    let m = (packed / 100) % 100;
    let d = packed % 100;
    let jdn = date_to_jdn(y, m, d) + days;
    let (y2, m2, d2) = jdn_to_date(jdn);
    y2 * 10000 + m2 * 100 + d2
}

fn date_to_jdn(y: i64, m: i64, d: i64) -> i64 {
    let a = (14 - m) / 12;
    let y2 = y + 4800 - a;
    let m2 = m + 12 * a - 3;
    d + (153 * m2 + 2) / 5 + 365 * y2 + y2 / 4 - y2 / 100 + y2 / 400 - 32045
}

#[allow(clippy::many_single_char_names)]
fn jdn_to_date(jdn: i64) -> (i64, i64, i64) {
    let a = jdn + 32044;
    let b = (4 * a + 3) / 146_097;
    let c = a - (146_097 * b) / 4;
    let d = (4 * c + 3) / 1461;
    let e = c - (1461 * d) / 4;
    let m = (5 * e + 2) / 153;
    let day = e - (153 * m + 2) / 5 + 1;
    let month = m + 3 - 12 * (m / 10);
    let year = 100 * b + d - 4800 + m / 10;
    (year, month, day)
}

// ---- Process feedback handlers ----

async fn api_get_feedback(
    State(s): State<Arc<AppState>>,
    AxumPath(process_id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    let rows = query_rows(
        &conn,
        "SELECT * FROM process_feedback WHERE process_id = ? ORDER BY step_id ASC, created_at ASC",
        &[&process_id],
    )?;
    Ok(Json(serde_json::json!({ "feedback": rows })))
}

#[derive(Deserialize)]
struct AddFeedbackBody {
    step_id: Option<i64>,
    feedback_text: String,
}

async fn api_add_feedback(
    State(s): State<Arc<AppState>>,
    AxumPath(process_id): AxumPath<i64>,
    Json(body): Json<AddFeedbackBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    conn.execute(
        "INSERT INTO process_feedback (process_id, step_id, feedback_text) VALUES (?1,?2,?3)",
        rusqlite::params![process_id, body.step_id, body.feedback_text],
    )
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("insert feedback: {e}"),
        )
    })?;
    let id = conn.last_insert_rowid();
    let rows = query_rows(&conn, "SELECT * FROM process_feedback WHERE id = ?", &[&id])?;
    Ok(Json(
        serde_json::json!({ "feedback": rows.into_iter().next() }),
    ))
}

async fn api_delete_feedback(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = open_db(&s)?;
    conn.execute("DELETE FROM process_feedback WHERE id = ?", [id])
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("delete feedback: {e}"),
            )
        })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---- Workspace detection -----------------------------------------------

fn detect_workspace() -> Option<WorkspaceCtx> {
    let mut dir = env::current_dir().ok()?;
    loop {
        let dovai = dir.join(".dovai");
        if dovai.is_dir() {
            // Make sure this isn't the config home itself
            if dovai != resolve_config_home() {
                let env_path = dovai.join(".env");
                let label = dir.file_name().map_or_else(
                    || dir.to_string_lossy().into_owned(),
                    |n| n.to_string_lossy().into_owned(),
                );
                return Some(WorkspaceCtx {
                    dir: dir.clone(),
                    env_path,
                    label,
                });
            }
        }
        if !dir.pop() {
            return None;
        }
    }
}
