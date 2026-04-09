//! Preflight checks — verify system tools required for document processing.
//!
//! On `dovai init` we check for tools the Filing Clerk will need:
//! pandoc, poppler-utils, tesseract, libreoffice. Missing tools block
//! init or get installed via the platform package manager.

use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
    Other,
}

#[must_use]
pub fn detect_platform() -> Platform {
    match std::env::consts::OS {
        "macos" => Platform::MacOs,
        "linux" => Platform::Linux,
        _ => Platform::Other,
    }
}

#[derive(Debug, Clone)]
pub struct ToolStatus {
    pub name: &'static str,
    pub purpose: &'static str,
    pub brew_package: &'static str,
    pub apt_package: &'static str,
    pub present: bool,
    pub path: Option<PathBuf>,
}

/// Document extraction tools the Filing Clerk needs.
#[must_use]
pub fn required_tools() -> Vec<ToolStatus> {
    let checks = [
        ("pandoc", "DOCX, RTF, ODT conversion", "pandoc", "pandoc"),
        (
            "pdftotext",
            "PDF text extraction",
            "poppler",
            "poppler-utils",
        ),
        (
            "pdftoppm",
            "PDF to image (OCR prep)",
            "poppler",
            "poppler-utils",
        ),
        ("pdfinfo", "PDF metadata", "poppler", "poppler-utils"),
        (
            "tesseract",
            "OCR for images and scanned PDFs",
            "tesseract",
            "tesseract-ocr",
        ),
    ];
    checks
        .iter()
        .map(|(name, purpose, brew, apt)| {
            let path = which(name);
            ToolStatus {
                name,
                purpose,
                brew_package: brew,
                apt_package: apt,
                present: path.is_some(),
                path,
            }
        })
        .collect()
}

/// Optional tools — only needed for legacy Office formats (.doc, .ppt, .xls).
#[must_use]
pub fn optional_tools() -> Vec<ToolStatus> {
    let path = which("soffice").or_else(|| which("libreoffice"));
    vec![ToolStatus {
        name: "libreoffice",
        purpose: "Legacy .doc, .ppt, .xls files",
        brew_package: "--cask libreoffice",
        apt_package: "libreoffice",
        present: path.is_some(),
        path,
    }]
}

#[derive(Debug, Clone)]
pub struct PreflightReport {
    pub platform: Platform,
    pub required: Vec<ToolStatus>,
    pub optional: Vec<ToolStatus>,
}

impl PreflightReport {
    #[must_use]
    pub fn all_required_present(&self) -> bool {
        self.required.iter().all(|t| t.present)
    }

    #[must_use]
    pub fn missing_required(&self) -> Vec<&ToolStatus> {
        self.required.iter().filter(|t| !t.present).collect()
    }

    #[must_use]
    pub fn missing_packages(&self) -> Vec<&'static str> {
        let mut packages = std::collections::BTreeSet::new();
        for tool in self.missing_required() {
            match self.platform {
                Platform::MacOs => packages.insert(tool.brew_package),
                _ => packages.insert(tool.apt_package),
            };
        }
        packages.into_iter().collect()
    }

    /// Shell command that would install all missing packages.
    #[must_use]
    pub fn install_command(&self) -> Option<String> {
        let packages = self.missing_packages();
        if packages.is_empty() {
            return None;
        }
        let joined = packages.join(" ");
        match self.platform {
            Platform::MacOs => Some(format!("brew install {joined}")),
            Platform::Linux => Some(format!("sudo apt-get install -y {joined}")),
            Platform::Other => None,
        }
    }
}

#[must_use]
pub fn run_preflight() -> PreflightReport {
    PreflightReport {
        platform: detect_platform(),
        required: required_tools(),
        optional: optional_tools(),
    }
}

/// Attempt to install missing packages using the platform package manager.
/// Returns (success, output) — output contains stdout+stderr for user feedback.
pub fn attempt_install(report: &PreflightReport) -> (bool, String) {
    let Some(cmd) = report.install_command() else {
        return (true, String::new());
    };
    let output = Command::new("sh").arg("-c").arg(&cmd).output();
    match output {
        Ok(o) => {
            let mut combined = String::new();
            combined.push_str(&String::from_utf8_lossy(&o.stdout));
            combined.push_str(&String::from_utf8_lossy(&o.stderr));
            (o.status.success(), combined)
        }
        Err(e) => (false, e.to_string()),
    }
}

fn which(bin: &str) -> Option<PathBuf> {
    let out = Command::new("which").arg(bin).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8(out.stdout).ok()?;
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}
