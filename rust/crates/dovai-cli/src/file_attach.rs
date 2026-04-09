//! Detect file paths in user input and inline their content.
//!
//! When a user pastes or types a file path (e.g. `/Users/me/doc.pdf`), we
//! detect it, extract the text content, and rewrite the message so the AI
//! receives both the user's text and the file content — no manual tool call
//! needed.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Known binary/document extensions that need extraction (not plain `read_file`).
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", "docx", "doc", "xlsx", "xls", "xlsm", "xlsb", "ods", "odt", "rtf", "ppt", "pptx", "odp",
    "png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "webp",
];

/// Plain-text extensions we can read directly.
const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml",
    "html", "htm", "xml", "svg", "log", "rs", "js", "ts", "py", "go", "java", "c", "cpp", "h",
    "css", "scss", "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "sql", "rb", "php", "swift",
    "kt", "lua", "r", "m", "mm", "env",
];

/// A file that was detected in user input and successfully read.
pub struct AttachedFile {
    pub path: String,
    pub format: String,
    pub content: String,
    pub warning: Option<String>,
}

/// Scan user input for file paths, extract their content, and return an
/// augmented message. If no files are found, returns `None` (use original input).
pub fn process_input_files(input: &str) -> (Option<String>, Vec<AttachedFile>) {
    let paths = detect_file_paths(input);
    if paths.is_empty() {
        return (None, vec![]);
    }

    let mut attached = Vec::new();
    let mut augmented = String::new();

    // Build the user's original text with file paths replaced by markers
    let mut remaining = input.to_string();
    for path in &paths {
        let path_str = path.to_string_lossy();
        if let Some(file) = extract_file_content(path) {
            // Replace the path in the user's text with a short reference
            remaining = remaining.replace(path_str.as_ref(), &format!("[attached: {}]", file.path));
            attached.push(file);
        }
    }

    if attached.is_empty() {
        return (None, vec![]);
    }

    // Build augmented message: user text first, then file contents
    augmented.push_str(&remaining);
    augmented.push_str("\n\n");
    for file in &attached {
        let _ = write!(
            augmented,
            "---\n**Attached file: {}** ({})\n",
            file.path, file.format,
        );
        if let Some(warning) = &file.warning {
            let _ = writeln!(augmented, "*Note: {warning}*");
        }
        augmented.push_str("```\n");
        // Truncate very large files to avoid blowing context
        let content = if file.content.len() > 100_000 {
            format!(
                "{}\n\n... [truncated — file is {} bytes, showing first 100,000]",
                &file.content[..100_000],
                file.content.len()
            )
        } else {
            file.content.clone()
        };
        augmented.push_str(&content);
        if !content.ends_with('\n') {
            augmented.push('\n');
        }
        augmented.push_str("```\n\n");
    }

    (Some(augmented), attached)
}

/// Detect file paths in user input.
///
/// Handles:
/// - Absolute paths: `/Users/foo/bar.pdf`
/// - Paths with spaces wrapped in quotes: `"/path/to/my file.pdf"` or `'/path/to/my file.pdf'`
/// - `~/` home-relative paths: `~/Documents/report.pdf`
/// - Bare paths pasted by drag-and-drop (macOS Terminal pastes the full path)
fn detect_file_paths(input: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // Strategy 1: Quoted paths (handles spaces)
    for cap in extract_quoted_paths(input) {
        let expanded = expand_tilde(&cap);
        let p = PathBuf::from(&expanded);
        if p.is_absolute() && p.exists() && p.is_file() && !paths.contains(&p) {
            paths.push(p);
        }
    }

    // Strategy 2: Unquoted tokens that look like absolute file paths
    for token in input.split_whitespace() {
        // Strip surrounding quotes if present
        let clean = token.trim_matches(|c| c == '\'' || c == '"');
        let expanded = expand_tilde(clean);
        let p = PathBuf::from(&expanded);
        if p.is_absolute() && p.exists() && p.is_file() && !paths.contains(&p) {
            paths.push(p);
        }
    }

    paths
}

/// Extract paths from within quotes (single or double).
fn extract_quoted_paths(input: &str) -> Vec<String> {
    let mut results = Vec::new();
    for quote_char in ['"', '\''] {
        let mut chars = input.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == quote_char {
                let mut path = String::new();
                for inner in chars.by_ref() {
                    if inner == quote_char {
                        break;
                    }
                    path.push(inner);
                }
                if !path.is_empty() && (path.starts_with('/') || path.starts_with('~')) {
                    results.push(path);
                }
            }
        }
    }
    results
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return format!("{}/{rest}", home.to_string_lossy());
        }
    }
    path.to_string()
}

/// Try to extract text content from a file path.
fn extract_file_content(path: &Path) -> Option<AttachedFile> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    let path_str = path.to_string_lossy().to_string();
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&path_str);

    // Plain text files — read directly
    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        let content = std::fs::read_to_string(path).ok()?;
        return Some(AttachedFile {
            path: filename.to_string(),
            format: ext.clone(),
            content,
            warning: None,
        });
    }

    // Document files — use extraction tools
    if DOCUMENT_EXTENSIONS.contains(&ext.as_str()) {
        return extract_document(path, filename, &ext);
    }

    // Unknown extension — try reading as text
    if let Ok(content) = std::fs::read_to_string(path) {
        return Some(AttachedFile {
            path: filename.to_string(),
            format: ext,
            content,
            warning: None,
        });
    }

    None
}

fn extract_document(path: &Path, filename: &str, ext: &str) -> Option<AttachedFile> {
    match ext {
        "pdf" => extract_pdf(path, filename),
        "docx" => extract_docx(path, filename),
        "doc" | "odt" | "rtf" | "ppt" | "pptx" | "odp" => extract_office(path, filename, ext),
        "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => extract_spreadsheet(path, filename, ext),
        "png" | "jpg" | "jpeg" | "tif" | "tiff" | "bmp" | "gif" | "webp" => {
            extract_image_ocr(path, filename)
        }
        _ => None,
    }
}

fn extract_pdf(path: &Path, filename: &str) -> Option<AttachedFile> {
    let path_str = path.to_string_lossy();

    // Try pdftotext first
    if let Ok(output) = Command::new("pdftotext")
        .args(["-layout", "-enc", "UTF-8", &path_str, "-"])
        .stdin(Stdio::null())
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if text.trim().len() > 20 {
                return Some(AttachedFile {
                    path: filename.to_string(),
                    format: "pdf".into(),
                    content: text,
                    warning: None,
                });
            }
        }
    }

    // OCR fallback
    extract_pdf_ocr(path, filename)
}

fn extract_pdf_ocr(path: &Path, filename: &str) -> Option<AttachedFile> {
    let path_str = path.to_string_lossy();
    let tmpdir = std::env::temp_dir().join(format!("dovai_attach_{}", std::process::id()));
    std::fs::create_dir_all(&tmpdir).ok()?;
    let prefix = tmpdir.join("page");
    let prefix_str = prefix.to_string_lossy();

    // PDF → PNG
    let convert = Command::new("pdftoppm")
        .args(["-png", "-r", "200", &path_str, &prefix_str])
        .stdin(Stdio::null())
        .output();
    if convert.is_err() || !convert.as_ref().unwrap().status.success() {
        let _ = std::fs::remove_dir_all(&tmpdir);
        return None;
    }

    // OCR each page
    let mut pages = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&tmpdir)
        .ok()?
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("png"))
        .collect();
    entries.sort();

    for png in &entries {
        let png_str = png.to_string_lossy();
        if let Ok(out) = Command::new("tesseract")
            .args([&*png_str, "stdout", "-l", "eng"])
            .stdin(Stdio::null())
            .output()
        {
            if out.status.success() {
                pages.push(String::from_utf8_lossy(&out.stdout).to_string());
            }
        }
    }

    let _ = std::fs::remove_dir_all(&tmpdir);

    let content = pages.join("\n\n--- PAGE BREAK ---\n\n");
    if content.trim().is_empty() {
        return None;
    }

    Some(AttachedFile {
        path: filename.to_string(),
        format: "pdf".into(),
        content,
        warning: Some("extracted via OCR — may contain errors".into()),
    })
}

fn extract_docx(path: &Path, filename: &str) -> Option<AttachedFile> {
    let path_str = path.to_string_lossy();
    let output = Command::new("pandoc")
        .args(["--wrap=none", "-f", "docx", "-t", "markdown", &path_str])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let content = String::from_utf8_lossy(&output.stdout).to_string();
    if content.trim().is_empty() {
        return None;
    }
    Some(AttachedFile {
        path: filename.to_string(),
        format: "docx".into(),
        content,
        warning: None,
    })
}

fn extract_office(path: &Path, filename: &str, ext: &str) -> Option<AttachedFile> {
    let path_str = path.to_string_lossy();

    // Try pandoc
    if let Ok(output) = Command::new("pandoc")
        .args(["--wrap=none", "-t", "markdown", &path_str])
        .stdin(Stdio::null())
        .output()
    {
        if output.status.success() {
            let content = String::from_utf8_lossy(&output.stdout).to_string();
            if !content.trim().is_empty() {
                return Some(AttachedFile {
                    path: filename.to_string(),
                    format: ext.to_string(),
                    content,
                    warning: None,
                });
            }
        }
    }

    // Try libreoffice
    let tmpdir = std::env::temp_dir().join(format!("dovai_office_{}", std::process::id()));
    std::fs::create_dir_all(&tmpdir).ok()?;
    let tmpdir_str = tmpdir.to_string_lossy();

    let soffice = if Command::new("soffice").arg("--version").output().is_ok() {
        "soffice"
    } else if Command::new("libreoffice")
        .arg("--version")
        .output()
        .is_ok()
    {
        "libreoffice"
    } else {
        let _ = std::fs::remove_dir_all(&tmpdir);
        return None;
    };

    let output = Command::new(soffice)
        .args([
            "--headless",
            "--convert-to",
            "txt",
            "--outdir",
            &tmpdir_str,
            &path_str,
        ])
        .stdin(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmpdir);
        return None;
    }

    let txt = std::fs::read_dir(&tmpdir)
        .ok()?
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("txt"))?;
    let content = std::fs::read_to_string(&txt).ok()?;
    let _ = std::fs::remove_dir_all(&tmpdir);

    Some(AttachedFile {
        path: filename.to_string(),
        format: ext.to_string(),
        content,
        warning: Some("converted via libreoffice — formatting may be lost".into()),
    })
}

fn extract_spreadsheet(path: &Path, filename: &str, ext: &str) -> Option<AttachedFile> {
    // Use ssconvert (gnumeric) or libreoffice to convert to CSV
    let path_str = path.to_string_lossy();
    let tmpdir = std::env::temp_dir().join(format!("dovai_sheet_{}", std::process::id()));
    std::fs::create_dir_all(&tmpdir).ok()?;

    // Try ssconvert → CSV
    let csv_path = tmpdir.join("output.csv");
    let csv_str = csv_path.to_string_lossy();
    if let Ok(out) = Command::new("ssconvert")
        .args([&*path_str, &*csv_str])
        .stdin(Stdio::null())
        .output()
    {
        if out.status.success() {
            if let Ok(content) = std::fs::read_to_string(&csv_path) {
                let _ = std::fs::remove_dir_all(&tmpdir);
                return Some(AttachedFile {
                    path: filename.to_string(),
                    format: ext.to_string(),
                    content,
                    warning: None,
                });
            }
        }
    }

    // Try libreoffice → CSV
    let tmpdir_str = tmpdir.to_string_lossy();
    let soffice = if Command::new("soffice").arg("--version").output().is_ok() {
        "soffice"
    } else if Command::new("libreoffice")
        .arg("--version")
        .output()
        .is_ok()
    {
        "libreoffice"
    } else {
        let _ = std::fs::remove_dir_all(&tmpdir);
        return None;
    };

    let output = Command::new(soffice)
        .args([
            "--headless",
            "--convert-to",
            "csv",
            "--outdir",
            &tmpdir_str,
            &path_str,
        ])
        .stdin(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmpdir);
        return None;
    }

    let csv = std::fs::read_dir(&tmpdir)
        .ok()?
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("csv"))?;
    let content = std::fs::read_to_string(&csv).ok()?;
    let _ = std::fs::remove_dir_all(&tmpdir);

    Some(AttachedFile {
        path: filename.to_string(),
        format: ext.to_string(),
        content,
        warning: None,
    })
}

fn extract_image_ocr(path: &Path, filename: &str) -> Option<AttachedFile> {
    let path_str = path.to_string_lossy();
    let output = Command::new("tesseract")
        .args([&*path_str, "stdout", "-l", "eng"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let content = String::from_utf8_lossy(&output.stdout).to_string();
    if content.trim().is_empty() {
        return None;
    }
    Some(AttachedFile {
        path: filename.to_string(),
        format: "image".into(),
        content,
        warning: Some("extracted via OCR — may contain errors".into()),
    })
}
