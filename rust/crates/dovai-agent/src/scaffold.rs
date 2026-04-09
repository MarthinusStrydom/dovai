use std::fs;
use std::path::Path;

use crate::config::AgentConfig;
use crate::error::Result;
use crate::templates;
use crate::workers::{self, filing_clerk};

/// Create the full workspace directory structure and write all files.
///
/// Everything dovai creates lives inside `.dovai/` — the user's workspace
/// root is left untouched except for `.dovai/` itself and `.gitignore`.
pub fn create_workspace(config: &AgentConfig, instructions: &str) -> Result<()> {
    let ws = Path::new(&config.workspace);
    let dovai_dir = ws.join(".dovai");
    let agent_dir = dovai_dir.join(&config.name);

    // Create directory structure — all inside .dovai/
    let clerk = filing_clerk::spec();
    let dirs = [
        dovai_dir.clone(),
        dovai_dir.join("vault"),
        dovai_dir.join("vault/concepts"),
        dovai_dir.join("vault/summaries"),
        dovai_dir.join("vault/reports"),
        dovai_dir.join("vault/sources"),
        dovai_dir.join("vault/entities"),
        dovai_dir.join("vault/logs"),
        dovai_dir.join("drafts"),
        agent_dir.clone(),
        clerk.worker_dir(&dovai_dir),
        clerk.queue_dir(&dovai_dir),
        dovai_dir.join("logs"),
        dovai_dir.join("context"),
        dovai_dir.join("data"),
        dovai_dir.join("processes"),
        dovai_dir.join("owner"),
        dovai_dir.join("clients"),
        dovai_dir.join("suppliers"),
        dovai_dir.join("staff"),
    ];

    for dir in &dirs {
        fs::create_dir_all(dir)?;
    }

    // Write Vault seed files
    write_file(
        &dovai_dir.join("vault/_index.md"),
        "# Vault Index\n\n_This index is maintained automatically. Do not edit manually._\n\n## Summaries\n\n_(none yet)_\n\n## Concepts\n\n_(none yet)_\n\n## Reports\n\n_(none yet)_\n",
    )?;
    write_file(
        &dovai_dir.join("vault/_manifest.json"),
        "{\"files\":{},\"last_scan\":null}\n",
    )?;

    // Write owner profile seed
    write_file(
        &dovai_dir.join("owner/profile.md"),
        &format!(
            "# Owner Profile\n\nName: {}\n\nAdd any information here that your agent should know about you:\nemail, phone, address, profession, family, preferences, etc.\n",
            config.owner_name
        ),
    )?;

    // Write agent config
    config.save()?;

    // Write .env inside .dovai/
    write_file(&dovai_dir.join(".env"), &templates::env_file(config))?;

    // Write .gitignore at workspace root (only if it doesn't exist)
    let gitignore_path = ws.join(".gitignore");
    if !gitignore_path.exists() {
        write_file(&gitignore_path, templates::gitignore())?;
    }

    // Write agent service scripts
    write_file(&agent_dir.join("config.js"), templates::config_js())?;
    write_file(
        &agent_dir.join("package.json"),
        &templates::package_json(config),
    )?;
    write_file(&agent_dir.join("task-db.js"), templates::task_db())?;
    write_file(
        &agent_dir.join("telegram-bot.js"),
        &templates::telegram_bot(config),
    )?;
    write_file(&agent_dir.join("send-email.js"), templates::send_email())?;
    write_file(
        &agent_dir.join("email-poller.js"),
        &templates::email_poller(config),
    )?;
    write_file(
        &agent_dir.join("cron-scheduler.js"),
        &templates::cron_scheduler(config),
    )?;

    // Write AGENTS.md inside .dovai/
    write_file(
        &dovai_dir.join("AGENTS.md"),
        &templates::agents_md(config, instructions),
    )?;

    // Write MEMORY.md inside .dovai/
    write_file(&dovai_dir.join("MEMORY.md"), templates::memory_md())?;

    // Write Filing Clerk identity + daemon
    let clerk_dir = clerk.worker_dir(&dovai_dir);
    write_file(&clerk_dir.join("AGENTS.md"), filing_clerk::agents_md())?;
    write_file(
        &clerk_dir.join("filing-clerk.js"),
        filing_clerk::daemon_js(),
    )?;
    write_file(
        &clerk_dir.join("extractor.js"),
        filing_clerk::extractor_js(),
    )?;
    write_file(&clerk_dir.join("llm.js"), filing_clerk::llm_js())?;
    write_file(
        &clerk_dir.join("package.json"),
        filing_clerk::package_json(),
    )?;

    // Seed the Clerk with an initial compile job
    let _ = workers::enqueue_job(
        &dovai_dir,
        &clerk,
        "initial_compile",
        serde_json::json!({
            "note": "Day 1: scan the entire workspace and build the vault from scratch.",
        }),
    );

    // Write initial log files
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    write_file(
        &dovai_dir.join("logs/activity.md"),
        &templates::activity_log(&today),
    )?;
    write_file(
        &dovai_dir.join("logs/decisions.md"),
        &templates::decisions_log(&today),
    )?;
    write_file(
        &dovai_dir.join("logs/learnings.md"),
        templates::learnings_log(),
    )?;
    write_file(&dovai_dir.join("logs/errors.md"), templates::errors_log())?;

    Ok(())
}

/// Install Node.js dependencies for the agent scripts.
pub fn install_deps(agent_dir: &Path) -> Result<()> {
    let status = std::process::Command::new("npm")
        .arg("install")
        .current_dir(agent_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .status()?;

    if !status.success() {
        return Err(crate::error::AgentError::Scaffold(
            "npm install failed".into(),
        ));
    }
    Ok(())
}

/// Seed the task database with initial recurring tasks.
pub fn seed_tasks(agent_dir: &Path) -> Result<()> {
    let seed_script = r"
        const { addTask } = require('./task-db');
        const tasks = [
          { title: 'Check email', description: 'Check IMAP inbox for new emails and process them', status: 'recurring', priority: 'normal', recurrence: 'every 10 min', created_by: 'system' },
          { title: 'Check calendar', description: 'Review calendar for upcoming events and reminders', status: 'recurring', priority: 'normal', recurrence: 'every wake', created_by: 'system' },
          { title: 'Check tasks', description: 'Review pending and overdue tasks, process by priority', status: 'recurring', priority: 'normal', recurrence: 'every wake', created_by: 'system' },
          { title: 'Check Filing Clerk status', description: 'Read .dovai/data/filing-clerk.status to see vault compile progress. Report to owner if asked.', status: 'recurring', priority: 'normal', recurrence: 'every wake', created_by: 'system' },
          { title: 'Read vault summaries', description: 'Day 1: As the Filing Clerk produces summaries in .dovai/vault/summaries/, read them to build your understanding of the business. Do NOT compile the vault yourself — that is the Clerks job.', status: 'pending', priority: 'urgent', created_by: 'system' },
          { title: 'Create entity files', description: 'Day 1: Create .dovai/clients/, .dovai/suppliers/, .dovai/staff/ files for every person and company the Clerk identifies in vault/entities/. Flag conflicts or duplicates.', status: 'pending', priority: 'urgent', created_by: 'system' },
          { title: 'Create context files', description: 'Day 1: Create .dovai/context/ files with domain knowledge — industry terms, business rules, key relationships, regulatory requirements.', status: 'pending', priority: 'normal', created_by: 'system' },
          { title: 'Propose initial goals', description: 'Day 1: Based on the vault compile, propose initial goals with KPIs. Insert into goals table with status=proposed for owner review.', status: 'pending', priority: 'normal', created_by: 'system' },
          { title: 'Send introduction message', description: 'Day 1: Send owner a Telegram message — introduce yourself, summarise what the Clerk has compiled so far, list what needs clarification.', status: 'pending', priority: 'normal', created_by: 'system' },
        ];
        for (const t of tasks) addTask(t);
        console.log('Tasks seeded');
    ";

    let escaped = seed_script.replace('"', "\\\"").replace('\n', " ");
    let status = std::process::Command::new("node")
        .args(["-e", &escaped])
        .current_dir(agent_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .status()?;

    if !status.success() {
        return Err(crate::error::AgentError::Scaffold(
            "Task seeding failed".into(),
        ));
    }
    Ok(())
}

fn write_file(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}
