use std::fs;
use std::path::Path;
use std::process::Command;

use crate::error::{AgentError, Result};

/// Names of the background service scripts (live in the main agent's dir).
pub const SERVICE_NAMES: &[&str] = &["telegram-bot", "email-poller", "cron-scheduler"];

/// Worker daemons (live in their own worker directory).
/// Tuple of (worker-name, daemon-script-name).
pub const WORKER_DAEMONS: &[(&str, &str)] = &[("filing-clerk", "filing-clerk.js")];

/// Status of a single service.
#[derive(Debug)]
pub struct ServiceStatus {
    pub name: String,
    pub running: bool,
    pub pid: Option<u32>,
}

/// Start all background services for a workspace.
///
/// Services are spawned as detached Node.js processes. Their PIDs are
/// written to `data/<service>.pid` and stdout/stderr goes to
/// `data/<service>.log`.
///
/// Services are started with a 1-second stagger to avoid concurrent
/// `SQLite` database opens.
pub fn start_services(agent_dir: &Path, data_dir: &Path) -> Result<()> {
    fs::create_dir_all(data_dir)?;

    for service in SERVICE_NAMES {
        let script = agent_dir.join(format!("{service}.js"));
        if !script.exists() {
            continue;
        }

        let log_path = data_dir.join(format!("{service}.log"));
        let pid_path = data_dir.join(format!("{service}.pid"));

        // Skip if already running
        let (running, _) = check_pid(&pid_path);
        if running {
            continue;
        }

        let log_file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;

        let log_err = log_file
            .try_clone()
            .map_err(|e| AgentError::Service(format!("Failed to clone log fd: {e}")))?;

        let child = Command::new("node")
            .arg(&script)
            .current_dir(agent_dir)
            .stdin(std::process::Stdio::null())
            .stdout(log_file)
            .stderr(log_err)
            .spawn()
            .map_err(|e| AgentError::Service(format!("Failed to spawn {service}: {e}")))?;

        let pid = child.id();
        fs::write(&pid_path, pid.to_string())?;

        // Stagger starts so SQLite isn't opened concurrently
        std::thread::sleep(std::time::Duration::from_secs(1));
    }

    Ok(())
}

/// Start all worker daemons for a workspace.
/// Workers live in their own `.dovai/<worker-name>/` directories.
pub fn start_workers(dovai_dir: &Path) -> Result<()> {
    let data_dir = dovai_dir.join("data");
    fs::create_dir_all(&data_dir)?;

    for (worker_name, script_name) in WORKER_DAEMONS {
        let worker_dir = dovai_dir.join(worker_name);
        let script = worker_dir.join(script_name);
        if !script.exists() {
            continue;
        }

        let pid_path = data_dir.join(format!("{worker_name}.pid"));
        let (running, _) = check_pid(&pid_path);
        if running {
            continue;
        }

        let log_path = data_dir.join(format!("{worker_name}.log"));
        let log_file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        let log_err = log_file
            .try_clone()
            .map_err(|e| AgentError::Service(format!("Failed to clone log fd: {e}")))?;

        let child = Command::new("node")
            .arg(&script)
            .current_dir(&worker_dir)
            .stdin(std::process::Stdio::null())
            .stdout(log_file)
            .stderr(log_err)
            .spawn()
            .map_err(|e| {
                AgentError::Service(format!("Failed to spawn worker {worker_name}: {e}"))
            })?;

        fs::write(&pid_path, child.id().to_string())?;
    }
    Ok(())
}

/// Start a single named worker if it's not already running.
/// Workers live in `.dovai/<worker>/<worker>.js`.
pub fn start_worker(name: &str, dovai_dir: &Path) -> Result<()> {
    // Find the worker in the registry
    let script_name = WORKER_DAEMONS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, s)| *s);
    let Some(script_name) = script_name else {
        return Ok(());
    };

    let worker_dir = dovai_dir.join(name);
    let script = worker_dir.join(script_name);
    if !script.exists() {
        return Ok(());
    }

    let data_dir = dovai_dir.join("data");
    fs::create_dir_all(&data_dir)?;
    let pid_path = data_dir.join(format!("{name}.pid"));
    let (running, _) = check_pid(&pid_path);
    if running {
        return Ok(());
    }

    let log_path = data_dir.join(format!("{name}.log"));
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| AgentError::Service(format!("Failed to clone log fd: {e}")))?;

    let child = Command::new("node")
        .arg(&script)
        .current_dir(&worker_dir)
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err)
        .spawn()
        .map_err(|e| AgentError::Service(format!("Failed to spawn worker {name}: {e}")))?;

    fs::write(&pid_path, child.id().to_string())?;
    Ok(())
}

/// True if the given name is a registered worker (not an agent service).
#[must_use]
pub fn is_worker(name: &str) -> bool {
    WORKER_DAEMONS.iter().any(|(n, _)| *n == name)
}

/// Start a single named service if it's not already running.
pub fn start_service(name: &str, agent_dir: &Path, data_dir: &Path) -> Result<()> {
    let script = agent_dir.join(format!("{name}.js"));
    if !script.exists() {
        return Ok(());
    }

    // Skip if already running
    let pid_path = data_dir.join(format!("{name}.pid"));
    let (running, _) = check_pid(&pid_path);
    if running {
        return Ok(());
    }

    fs::create_dir_all(data_dir)?;
    let log_path = data_dir.join(format!("{name}.log"));

    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| AgentError::Service(format!("Failed to clone log fd: {e}")))?;

    let child = Command::new("node")
        .arg(&script)
        .current_dir(agent_dir)
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err)
        .spawn()
        .map_err(|e| AgentError::Service(format!("Failed to spawn {name}: {e}")))?;

    fs::write(&pid_path, child.id().to_string())?;
    Ok(())
}

/// Stop all background services by killing their PIDs.
pub fn stop_services(data_dir: &Path) -> Result<()> {
    let worker_names: Vec<&str> = WORKER_DAEMONS.iter().map(|(n, _)| *n).collect();
    let all_names = SERVICE_NAMES.iter().chain(worker_names.iter());
    for name in all_names {
        let pid_path = data_dir.join(format!("{name}.pid"));
        if let Ok(contents) = fs::read_to_string(&pid_path) {
            if let Ok(pid) = contents.trim().parse::<i32>() {
                // Send SIGTERM
                #[cfg(unix)]
                {
                    let _ = Command::new("kill").arg(pid.to_string()).status();
                }
                let _ = fs::remove_file(&pid_path);
            }
        }
    }
    Ok(())
}

/// Check which services (and workers) are running.
#[must_use]
pub fn check_services(data_dir: &Path) -> Vec<ServiceStatus> {
    let worker_names: Vec<&str> = WORKER_DAEMONS.iter().map(|(n, _)| *n).collect();
    SERVICE_NAMES
        .iter()
        .chain(worker_names.iter())
        .map(|name| {
            let pid_path = data_dir.join(format!("{name}.pid"));
            let (running, pid) = check_pid(&pid_path);
            ServiceStatus {
                name: (*name).to_string(),
                running,
                pid,
            }
        })
        .collect()
}

/// Check if a process is alive by reading its PID file and sending signal 0.
fn check_pid(pid_path: &Path) -> (bool, Option<u32>) {
    let Ok(contents) = fs::read_to_string(pid_path) else {
        return (false, None);
    };

    let Ok(pid) = contents.trim().parse::<u32>() else {
        return (false, None);
    };

    // Use kill -0 to check if process exists
    #[cfg(unix)]
    {
        let status = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        match status {
            Ok(s) if s.success() => (true, Some(pid)),
            _ => (false, Some(pid)),
        }
    }

    #[cfg(not(unix))]
    {
        (false, Some(pid))
    }
}
