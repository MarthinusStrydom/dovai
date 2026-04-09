//! Provider credential management for Dovai.
//!
//! Handles inline API-key prompting, persistence to
//! `~/.dovai/settings.json`, and `/keys` status display.

use std::env;
use std::io::{self, Write};

use api::{detect_provider_kind, InputMessage, MessageRequest, ProviderClient, ProviderKind};

use crate::render;

/// A provider option shown to the user during setup.
struct ProviderOption {
    label: &'static str,
    description: &'static str,
    env_key: &'static str,
    provider_kind: ProviderKind,
    needs_key: bool,
}

const PROVIDERS: &[ProviderOption] = &[
    ProviderOption {
        label: "Anthropic",
        description: "Claude models by Anthropic",
        env_key: "ANTHROPIC_API_KEY",
        provider_kind: ProviderKind::Anthropic,
        needs_key: true,
    },
    ProviderOption {
        label: "xAI",
        description: "Grok models by xAI",
        env_key: "XAI_API_KEY",
        provider_kind: ProviderKind::Xai,
        needs_key: true,
    },
    ProviderOption {
        label: "OpenAI",
        description: "GPT and o-series models",
        env_key: "OPENAI_API_KEY",
        provider_kind: ProviderKind::OpenAi,
        needs_key: true,
    },
    ProviderOption {
        label: "LMStudio",
        description: "Run local models on your machine",
        env_key: "LMSTUDIO_API_KEY",
        provider_kind: ProviderKind::OpenAi,
        needs_key: false,
    },
];

/// Look up the setup-wizard provider entry for a given `ProviderKind`.
fn provider_option_for(kind: ProviderKind) -> Option<&'static ProviderOption> {
    PROVIDERS.iter().find(|p| p.provider_kind == kind)
}

/// Save an API key to both process env AND settings.json (merging with any
/// existing env block). Also clears `ANTHROPIC_AUTH_TOKEN` when saving
/// `ANTHROPIC_API_KEY` — a stale bearer token would be preferred by the
/// Anthropic client and cause 401 auth errors.
fn persist_api_key(env_key: &str, value: &str) -> Result<(), Box<dyn std::error::Error>> {
    env::set_var(env_key, value);

    // Read existing settings.json to preserve other saved env vars
    let config_home = std::path::PathBuf::from(
        env::var("DOVAI_CONFIG_HOME")
            .or_else(|_| env::var("HOME").map(|h| format!("{h}/.dovai")))
            .unwrap_or_else(|_| ".dovai".to_string()),
    );
    let settings_path = config_home.join("settings.json");
    let mut existing_env = serde_json::Map::new();
    if let Ok(content) = std::fs::read_to_string(&settings_path) {
        if let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(env_obj) = root.get("env").and_then(|v| v.as_object()) {
                existing_env.clone_from(env_obj);
            }
        }
    }
    existing_env.insert(
        env_key.to_string(),
        serde_json::Value::String(value.to_string()),
    );

    // When setting an Anthropic API key, clear any stale auth token that would
    // be sent as a Bearer and override the api-key header.
    if env_key == "ANTHROPIC_API_KEY" {
        existing_env.remove("ANTHROPIC_AUTH_TOKEN");
        env::remove_var("ANTHROPIC_AUTH_TOKEN");
    }

    save_setting_to_file("env", serde_json::Value::Object(existing_env))?;
    Ok(())
}

/// Save a key/value pair into ~/.dovai/settings.json, merging with existing content.
fn save_setting_to_file(
    key: &str,
    value: serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let config_home = std::path::PathBuf::from(
        env::var("DOVAI_CONFIG_HOME")
            .or_else(|_| env::var("HOME").map(|h| format!("{h}/.dovai")))
            .unwrap_or_else(|_| ".dovai".to_string()),
    );
    std::fs::create_dir_all(&config_home)?;
    let settings_path = config_home.join("settings.json");
    let mut root: serde_json::Map<String, serde_json::Value> =
        if let Ok(content) = std::fs::read_to_string(&settings_path) {
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            serde_json::Map::new()
        };
    root.insert(key.to_string(), value);
    let json = serde_json::to_string_pretty(&root)?;
    std::fs::write(&settings_path, json)?;
    Ok(())
}

/// Returns `true` if credentials are available for the given provider.
fn has_credentials_for(kind: ProviderKind) -> bool {
    match kind {
        ProviderKind::Anthropic => {
            env::var_os("ANTHROPIC_API_KEY").is_some()
                || env::var_os("ANTHROPIC_AUTH_TOKEN").is_some()
        }
        ProviderKind::Xai => env::var_os("XAI_API_KEY").is_some(),
        ProviderKind::OpenAi => env::var_os("OPENAI_API_KEY").is_some(),
    }
}

/// Ensure credentials exist for the given model's provider.
///
/// If credentials are missing, prompts the user to paste an API key inline
/// and saves it to `~/.dovai/settings.json` and the current env. Returns
/// `Ok(())` once credentials are available, or an error if the user cancels
/// or the provider isn't recognised.
///
/// Safe to call even when creds already exist — it'll do nothing in that case.
pub fn ensure_provider_credentials(model: &str) -> Result<(), Box<dyn std::error::Error>> {
    let resolved = api::resolve_model_alias(model);
    let kind = detect_provider_kind(&resolved);

    if has_credentials_for(kind) {
        return Ok(());
    }

    let provider = provider_option_for(kind)
        .ok_or_else(|| format!("No setup wizard entry for provider {kind:?}"))?;

    let m = render::LEFT_MARGIN;
    let mut stdout = io::stdout();

    writeln!(stdout)?;
    writeln!(
        stdout,
        "{m} \x1b[1m{}\x1b[0m needs an API key to use models like \x1b[1m{model}\x1b[0m.",
        provider.label
    )?;
    writeln!(
        stdout,
        "{m} \x1b[2m(Paste your key below — it won't be shown on screen. Press Enter alone to cancel.)\x1b[0m"
    )?;
    writeln!(stdout)?;

    let api_key = prompt_secret(&format!("{m} {} API key: ", provider.label))?;

    if api_key.trim().is_empty() {
        return Err("No key entered. Leaving the current provider unchanged. \
             Run /keys or /setup to add a key later."
            .into());
    }

    persist_api_key(provider.env_key, api_key.trim())?;

    writeln!(stdout)?;
    writeln!(
        stdout,
        "{m} \x1b[1;32m\u{2714}\x1b[0m Saved {} API key to ~/.dovai/settings.json",
        provider.label
    )?;
    writeln!(stdout)?;

    Ok(())
}

/// List all providers with their credential status. Used by /keys slash command.
pub fn print_provider_status() -> Result<(), Box<dyn std::error::Error>> {
    let m = render::LEFT_MARGIN;
    let mut stdout = io::stdout();

    writeln!(stdout)?;
    writeln!(stdout, "{m} \x1b[1mAI Providers\x1b[0m")?;
    writeln!(stdout)?;
    for p in PROVIDERS {
        let configured = has_credentials_for(p.provider_kind);
        let status = if configured {
            "\x1b[1;32m\u{2714} configured\x1b[0m"
        } else if p.needs_key {
            "\x1b[2m(no key)\x1b[0m"
        } else {
            "\x1b[1;32m\u{2714} ready (local)\x1b[0m"
        };
        writeln!(
            stdout,
            "{m}   \x1b[1m{:10}\x1b[0m  {}  \x1b[2m\u{2014} {}\x1b[0m",
            p.label, status, p.description
        )?;
    }
    writeln!(stdout)?;
    writeln!(
        stdout,
        "{m} \x1b[2mAdd/change a key: /keys <provider>  (e.g. /keys anthropic)\x1b[0m"
    )?;
    writeln!(
        stdout,
        "{m} \x1b[2mSwitch models:    /model <name>     (e.g. /model sonnet)\x1b[0m"
    )?;
    writeln!(stdout)?;
    Ok(())
}

/// Prompt for + save a key for the named provider (used by /keys <provider>).
pub fn set_provider_key(provider_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let needle = provider_name.trim().to_ascii_lowercase();
    let provider = PROVIDERS
        .iter()
        .find(|p| p.label.eq_ignore_ascii_case(&needle))
        .ok_or_else(|| {
            let names: Vec<&str> = PROVIDERS.iter().map(|p| p.label).collect();
            format!(
                "Unknown provider '{provider_name}'. Known: {}",
                names.join(", ")
            )
        })?;

    if !provider.needs_key {
        let m = render::LEFT_MARGIN;
        println!(
            "{m} \x1b[2m{} is a local provider \u{2014} no API key required.\x1b[0m",
            provider.label
        );
        return Ok(());
    }

    let m = render::LEFT_MARGIN;
    let mut stdout = io::stdout();
    writeln!(stdout)?;
    writeln!(
        stdout,
        "{m} Setting API key for \x1b[1m{}\x1b[0m.",
        provider.label
    )?;
    writeln!(
        stdout,
        "{m} \x1b[2m(Paste your key below \u{2014} it won't be shown on screen. Press Enter alone to cancel.)\x1b[0m"
    )?;
    writeln!(stdout)?;

    let api_key = prompt_secret(&format!("{m} {} API key: ", provider.label))?;
    if api_key.trim().is_empty() {
        return Err("No key entered.".into());
    }

    persist_api_key(provider.env_key, api_key.trim())?;

    writeln!(stdout)?;
    writeln!(
        stdout,
        "{m} \x1b[1;32m\u{2714}\x1b[0m Saved {} API key to ~/.dovai/settings.json",
        provider.label
    )?;
    writeln!(stdout)?;
    Ok(())
}

/// Prompt for a secret value (API key). Disables terminal echo while reading.
fn prompt_secret(prompt: &str) -> Result<String, Box<dyn std::error::Error>> {
    print!("{prompt}");
    io::stdout().flush()?;

    let echo_was_disabled = disable_echo();

    let mut input = String::new();
    let result = io::stdin().read_line(&mut input);

    if echo_was_disabled {
        enable_echo();
    }
    println!(); // newline after hidden input

    result?;
    Ok(input.trim().to_string())
}

/// Disable terminal echo using `stty`. Returns true if echo was successfully disabled.
fn disable_echo() -> bool {
    std::process::Command::new("stty")
        .arg("-echo")
        .stdin(std::process::Stdio::inherit())
        .status()
        .is_ok_and(|s| s.success())
}

/// Re-enable terminal echo using `stty`.
fn enable_echo() {
    let _ = std::process::Command::new("stty")
        .arg("echo")
        .stdin(std::process::Stdio::inherit())
        .status();
}

/// Send a minimal API request to verify the connection works.
#[allow(dead_code)]
fn validate_connection(model: &str) -> Result<(), Box<dyn std::error::Error>> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        let client = ProviderClient::from_model(model)?;
        let request = MessageRequest {
            model: model.to_string(),
            max_tokens: 1,
            messages: vec![InputMessage::user_text("hi")],
            system: None,
            tools: None,
            tool_choice: None,
            stream: false,
        };
        client.send_message(&request).await?;
        Ok(())
    })
}
