use std::collections::HashMap;

use regex::Regex;

/// Parse YAML frontmatter delimited by `---` lines.
/// Returns (frontmatter key-value pairs, body after frontmatter).
#[must_use]
pub fn parse_frontmatter(content: &str) -> (HashMap<String, String>, &str) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (HashMap::new(), content);
    }

    // Find the closing ---
    let after_first = &trimmed[3..];
    let after_first = after_first.strip_prefix('\n').unwrap_or(after_first);
    let Some(end_pos) = after_first.find("\n---") else {
        return (HashMap::new(), content);
    };

    let yaml_block = &after_first[..end_pos];
    let body_start = end_pos + 4; // skip "\n---"
    let body = after_first[body_start..]
        .strip_prefix('\n')
        .unwrap_or(&after_first[body_start..]);

    let mut map = HashMap::new();
    for line in yaml_block.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_string();
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if !key.is_empty() {
                map.insert(key, value);
            }
        }
    }

    (map, body)
}

/// Parse `**Key**: Value` or `**Key:** Value` patterns from markdown.
#[must_use]
pub fn parse_bold_key_values(content: &str) -> Vec<(String, String)> {
    let re = Regex::new(r"\*\*([^*]+?)\*\*:?\s*(.*)").expect("valid regex");
    let mut results = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if let Some(caps) = re.captures(line) {
            let key = caps[1].trim_end_matches(':').trim().to_string();
            let value = caps[2].trim().to_string();
            if !key.is_empty() {
                results.push((key, value));
            }
        }
    }

    results
}

/// Parse indented list items under a parent key (e.g. contact details).
/// Looks for `- Key: Value` or `- Value` patterns.
#[must_use]
pub fn parse_list_items(content: &str, after_key: &str) -> Vec<(String, String)> {
    let mut results = Vec::new();
    let mut in_section = false;

    for line in content.lines() {
        let trimmed = line.trim();

        // Check if we've hit the target section
        if trimmed.contains(&format!("**{after_key}**"))
            || trimmed.starts_with(&format!("**{after_key}:"))
        {
            in_section = true;
            continue;
        }

        if in_section {
            // Stop at next bold key or heading
            if (trimmed.starts_with("**") && trimmed.contains("**:")) || trimmed.starts_with('#') {
                break;
            }

            if let Some(item) = trimmed.strip_prefix("- ") {
                if let Some((key, value)) = item.split_once(':') {
                    let key = key.trim().to_string();
                    let value = value.trim().to_string();
                    if !key.is_empty() {
                        results.push((key, value));
                    }
                } else {
                    results.push((String::new(), item.trim().to_string()));
                }
            }
        }
    }

    results
}

/// Extract `[[wiki-links]]` from content.
#[must_use]
pub fn parse_wiki_links(content: &str) -> Vec<String> {
    let re = Regex::new(r"\[\[([^\]]+)\]\]").expect("valid regex");
    re.captures_iter(content)
        .map(|caps| caps[1].to_string())
        .collect()
}

/// Extract markdown headings (# Title, ## Title, etc.).
#[must_use]
pub fn parse_headings(content: &str) -> Vec<(usize, String)> {
    let mut headings = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|&c| c == '#').count();
            let title = trimmed[level..].trim().to_string();
            if !title.is_empty() {
                headings.push((level, title));
            }
        }
    }
    headings
}

/// Slugify a name into a node ID component.
/// e.g. `john & jane doe` becomes `john-jane-doe`
#[must_use]
pub fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Parse simple `Key: Value` lines (no bold).
#[must_use]
pub fn parse_plain_key_values(content: &str) -> Vec<(String, String)> {
    let mut results = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = key.trim().to_string();
            let value = value.trim().to_string();
            if !key.is_empty() && !value.is_empty() && key.len() <= 30 {
                results.push((key, value));
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_parsing() {
        let content =
            "---\nsource: \"test.pdf\"\nsha256: \"abc123\"\ndoc_type: \"report\"\n---\nBody text here.";
        let (fm, body) = parse_frontmatter(content);
        assert_eq!(fm.get("source").unwrap(), "test.pdf");
        assert_eq!(fm.get("sha256").unwrap(), "abc123");
        assert_eq!(fm.get("doc_type").unwrap(), "report");
        assert_eq!(body.trim(), "Body text here.");
    }

    #[test]
    fn frontmatter_missing() {
        let content = "No frontmatter here.\nJust text.";
        let (fm, body) = parse_frontmatter(content);
        assert!(fm.is_empty());
        assert_eq!(body, content);
    }

    #[test]
    fn bold_key_values() {
        let content = "**Stand**: 13005\n**Status**: Not built\n**Name:** John Smith";
        let kv = parse_bold_key_values(content);
        assert_eq!(kv.len(), 3);
        assert_eq!(kv[0], ("Stand".into(), "13005".into()));
        assert_eq!(kv[1], ("Status".into(), "Not built".into()));
        assert_eq!(kv[2], ("Name".into(), "John Smith".into()));
    }

    #[test]
    fn list_items_parsing() {
        let content = "**Contact**:\n- Email: test@example.com\n- Phone: +1234\n**Status**: Active";
        let items = parse_list_items(content, "Contact");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], ("Email".into(), "test@example.com".into()));
        assert_eq!(items[1], ("Phone".into(), "+1234".into()));
    }

    #[test]
    fn wiki_links() {
        let content = "See [[agm-notice]] and [[financial-report]] for details.";
        let links = parse_wiki_links(content);
        assert_eq!(links, vec!["agm-notice", "financial-report"]);
    }

    #[test]
    fn slugify_names() {
        assert_eq!(slugify("John & Jane Doe"), "john-jane-doe");
        assert_eq!(slugify("AcmeCo"), "acmeco");
        assert_eq!(slugify("Example Services"), "example-services");
    }

    #[test]
    fn headings_parsing() {
        let content = "# Main Title\n\n## Section One\n\nText\n\n### Sub Section";
        let headings = parse_headings(content);
        assert_eq!(headings.len(), 3);
        assert_eq!(headings[0], (1, "Main Title".into()));
        assert_eq!(headings[1], (2, "Section One".into()));
        assert_eq!(headings[2], (3, "Sub Section".into()));
    }
}
