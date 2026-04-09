use std::fs;
use std::path::Path;

use crate::config::AgentConfig;
use crate::error::{AgentError, Result};
use crate::init::derive_name;
use crate::services;

/// Rename an agent throughout the workspace.
///
/// This is the nuclear option — it touches agent.json, .env, AGENTS.md,
/// and renames the agent folder. Services must be stopped before calling
/// this and restarted afterwards.
///
/// Returns the new slug name (e.g. "jenny-jones").
pub fn rename_agent(workspace: &str, new_display_name: &str) -> Result<String> {
    let ws = Path::new(workspace);
    let dovai_dir = ws.join(".dovai");
    let data_dir = dovai_dir.join("data");

    // Load current config
    let mut config = AgentConfig::load(workspace)?;
    let old_display_name = config.display_name.clone();
    let old_name = config.name.clone();
    let new_name = derive_name(new_display_name);

    if old_name == new_name {
        return Err(AgentError::Config(format!(
            "New name '{}' produces the same slug '{}' — nothing to rename.",
            new_display_name, new_name
        )));
    }

    let old_dir = dovai_dir.join(&old_name);
    let new_dir = dovai_dir.join(&new_name);

    if new_dir.exists() {
        return Err(AgentError::Config(format!(
            "Target directory '{}' already exists.",
            new_dir.display()
        )));
    }

    // 1. Stop running services
    let _ = services::stop_services(&data_dir);

    // 2. Rename the agent folder
    if old_dir.exists() {
        fs::rename(&old_dir, &new_dir).map_err(|e| {
            AgentError::Scaffold(format!(
                "Failed to rename {} → {}: {e}",
                old_dir.display(),
                new_dir.display()
            ))
        })?;
    }

    // 3. Update agent.json
    config.name = new_name.clone();
    config.display_name = new_display_name.to_string();
    config.save()?;

    // 4. Update .env — replace AGENT_NAME and AGENT_DISPLAY_NAME
    let env_path = dovai_dir.join(".env");
    if env_path.exists() {
        let content = fs::read_to_string(&env_path)
            .map_err(|e| AgentError::Config(format!("Cannot read {}: {e}", env_path.display())))?;
        let updated = content
            .lines()
            .map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with("AGENT_NAME=") {
                    format!("AGENT_NAME={new_name}")
                } else if trimmed.starts_with("AGENT_DISPLAY_NAME=") {
                    format!("AGENT_DISPLAY_NAME={new_display_name}")
                } else if trimmed.starts_with(&format!("# {} —", old_display_name)) {
                    format!("# {} — Agent Credentials", new_display_name)
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&env_path, updated)?;
    }

    // 5. Update AGENTS.md — replace all occurrences of old display name
    let agents_path = dovai_dir.join("AGENTS.md");
    if agents_path.exists() {
        let content = fs::read_to_string(&agents_path).map_err(|e| {
            AgentError::Config(format!("Cannot read {}: {e}", agents_path.display()))
        })?;
        let updated = content.replace(&old_display_name, new_display_name);
        fs::write(&agents_path, updated)?;
    }

    Ok(new_name)
}
