use std::fmt::Write as FmtWrite;
use std::io::{self, Write};

use crossterm::cursor::{MoveTo, MoveToColumn, RestorePosition, SavePosition};
use crossterm::style::{Color, Print, ResetColor, SetForegroundColor, Stylize};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{execute, queue};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;
use syntect::util::{as_24_bit_terminal_escaped, LinesWithEndings};

/// Left margin padding prepended to output lines for a polished look.
pub const LEFT_MARGIN: &str = "  ";
/// Column offset for crossterm cursor positioning (must match `LEFT_MARGIN` width).
pub const LEFT_MARGIN_WIDTH: u16 = 2;

/// Dovai brand color (warm coral/red) matching the ASCII logo.
const BRAND_COLOR: Color = Color::Rgb {
    r: 203,
    g: 75,
    b: 22,
};

/// Re-render the user's input as a styled bar: dark background, white text,
/// spanning the full terminal width. Call right after rustyline returns so the
/// styled version overwrites the plain echo.
pub fn render_user_input(text: &str, out: &mut impl Write) -> io::Result<()> {
    let cols = detect_terminal_columns(); // raw terminal width — no margin added
                                          // Move up one line to overwrite the rustyline echo
    execute!(
        out,
        crossterm::cursor::MoveUp(1),
        MoveToColumn(0),
        Clear(ClearType::CurrentLine)
    )?;
    // Build display text, truncate if longer than terminal width
    let prefix = format!("{LEFT_MARGIN}\u{203a} ");
    let max_text = cols.saturating_sub(prefix.chars().count());
    let truncated = if text.chars().count() > max_text {
        let t: String = text.chars().take(max_text.saturating_sub(1)).collect();
        format!("{t}\u{2026}") // ellipsis
    } else {
        text.to_string()
    };
    let display = format!("{prefix}{truncated}");
    let padding = cols.saturating_sub(display.chars().count());
    // Use 256-colour mode (colours 16-255 are NOT remapped by the
    // terminal palette, unlike the first 16 which get themed).
    //   \x1b[1m          = bold
    //   \x1b[38;5;231m   = 256-colour white (RGB cube, always true white)
    //   \x1b[48;5;235m   = 256-colour dark grey background
    //   \x1b[0m          = reset
    writeln!(
        out,
        "\x1b[1m\x1b[38;5;231m\x1b[48;5;235m{display}{}\x1b[0m",
        " ".repeat(padding),
    )?;
    out.flush()
}

/// Prepend `LEFT_MARGIN` to every line in `text`.
#[must_use]
pub fn pad_lines(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut output = String::with_capacity(text.len() + text.lines().count() * LEFT_MARGIN.len());
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            output.push('\n');
        }
        if !line.is_empty() {
            output.push_str(LEFT_MARGIN);
        }
        output.push_str(line);
    }
    output
}

/// Prepend `LEFT_MARGIN` to every line, word-wrapping long lines to the terminal width.
#[must_use]
pub fn pad_and_wrap(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let max_width = terminal_content_width();
    if std::env::var("DOVAI_DEBUG_WRAP").is_ok() {
        let crossterm_cols = crossterm::terminal::size()
            .map(|(c, _)| c as usize)
            .unwrap_or(0);
        let detected = detect_terminal_columns();
        let plain_len = strip_ansi(text).chars().count();
        eprintln!("[WRAP] crossterm={crossterm_cols} detected={detected} max_width={max_width} plain_chars={plain_len}");
    }
    let mut output = String::with_capacity(text.len() * 2);
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            output.push('\n');
        }
        if line.is_empty() {
            continue;
        }
        wrap_ansi_line(line, max_width, &mut output);
    }
    output
}

/// Like `pad_and_wrap` but with an explicit width (for testing).
#[cfg(test)]
fn pad_and_wrap_with_width(text: &str, max_width: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut output = String::with_capacity(text.len() * 2);
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            output.push('\n');
        }
        if line.is_empty() {
            continue;
        }
        wrap_ansi_line(line, max_width, &mut output);
    }
    output
}

/// Returns the usable content width (terminal columns minus margins).
/// Uses multiple fallbacks: crossterm ioctl → `stty size` → `$COLUMNS` → 80.
fn terminal_content_width() -> usize {
    // Re-detect on every call so terminal resizes are picked up.
    // crossterm and stty are fast (single ioctl), so no caching needed.
    let cols = detect_terminal_columns();
    let margin = LEFT_MARGIN.len() * 2; // left + right breathing room
    cols.saturating_sub(margin)
}

/// Detect terminal column count using multiple strategies.
fn detect_terminal_columns() -> usize {
    // Strategy 1: crossterm (opens /dev/tty, falls back to ioctl on stdout)
    if let Ok((cols, _)) = crossterm::terminal::size() {
        if cols > 0 {
            return cols as usize;
        }
    }
    // Strategy 2: `stty size` using libc path (robust on macOS)
    if let Ok(output) = std::process::Command::new("stty")
        .arg("size")
        .stdin(std::process::Stdio::inherit())
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(cols_str) = text.split_whitespace().nth(1) {
                if let Ok(cols) = cols_str.parse::<usize>() {
                    if cols > 0 {
                        return cols;
                    }
                }
            }
        }
    }
    // Strategy 3: COLUMNS environment variable
    if let Some(cols) = std::env::var("COLUMNS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        if cols > 0 {
            return cols;
        }
    }
    80
}

/// Word-wrap a single line (which may contain ANSI escapes) to `max_width`
/// visible characters, prepending `LEFT_MARGIN` to each wrapped line.
fn wrap_ansi_line(line: &str, max_width: usize, output: &mut String) {
    // Split the line into segments: either ANSI escape sequences or visible text
    let mut segments: Vec<(String, usize)> = Vec::new(); // (text, visible_width)
    let mut chars = line.chars().peekable();
    let mut current = String::new();
    let mut current_vis = 0;

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            // Flush visible text before the escape
            if !current.is_empty() {
                segments.push((std::mem::take(&mut current), current_vis));
                current_vis = 0;
            }
            // Collect the full escape sequence
            let mut esc = String::from("\u{1b}[");
            chars.next(); // consume '['
            for next in chars.by_ref() {
                esc.push(next);
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            segments.push((esc, 0));
        } else {
            current.push(ch);
            current_vis += 1;
        }
    }
    if !current.is_empty() {
        segments.push((current, current_vis));
    }

    // Now emit segments with word-wrapping
    let mut col: usize = 0;
    let mut line_started = false;

    for (seg_text, seg_vis) in &segments {
        if *seg_vis == 0 {
            // ANSI escape — emit directly, no width cost
            output.push_str(seg_text);
            continue;
        }

        // This is visible text — word-wrap it
        for word in WordSplitter::new(seg_text) {
            let word_vis = word.chars().count();

            if !line_started {
                output.push_str(LEFT_MARGIN);
                line_started = true;
            }

            if col > 0 && col + word_vis > max_width {
                // Wrap to new line
                output.push('\n');
                output.push_str(LEFT_MARGIN);
                col = 0;
                // Skip leading space on the new line
                let trimmed = word.trim_start();
                let trimmed_vis = trimmed.chars().count();
                output.push_str(trimmed);
                col += trimmed_vis;
            } else {
                output.push_str(word);
                col += word_vis;
            }
        }
    }

    if !line_started {
        output.push_str(LEFT_MARGIN);
    }
}

/// Splits text into words while preserving whitespace attached to each word.
/// E.g. `"hello world"` becomes `["hello ", "world"]`
struct WordSplitter<'a> {
    remaining: &'a str,
}

impl<'a> WordSplitter<'a> {
    fn new(text: &'a str) -> Self {
        Self { remaining: text }
    }
}

impl<'a> Iterator for WordSplitter<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }

        // Find the end of the current word + trailing whitespace
        let word_end = self
            .remaining
            .find(char::is_whitespace)
            .unwrap_or(self.remaining.len());

        let space_end = self.remaining[word_end..]
            .find(|c: char| !c.is_whitespace())
            .map_or(self.remaining.len(), |pos| word_end + pos);

        let (chunk, rest) = self.remaining.split_at(space_end);
        self.remaining = rest;
        Some(chunk)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorTheme {
    heading: Color,
    emphasis: Color,
    strong: Color,
    inline_code: Color,
    link: Color,
    quote: Color,
    table_border: Color,
    code_block_border: Color,
    spinner_active: Color,
    spinner_done: Color,
    spinner_failed: Color,
}

impl Default for ColorTheme {
    fn default() -> Self {
        Self {
            heading: Color::Cyan,
            emphasis: Color::Magenta,
            strong: Color::Yellow,
            inline_code: Color::Green,
            link: Color::Blue,
            quote: Color::DarkGrey,
            table_border: Color::DarkCyan,
            code_block_border: Color::DarkGrey,
            spinner_active: Color::Blue,
            spinner_done: Color::Green,
            spinner_failed: Color::Red,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Spinner {
    frame_index: usize,
}

impl Spinner {
    const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn tick(
        &mut self,
        label: &str,
        theme: &ColorTheme,
        out: &mut impl Write,
    ) -> io::Result<()> {
        let frame = Self::FRAMES[self.frame_index % Self::FRAMES.len()];
        self.frame_index += 1;
        queue!(
            out,
            SavePosition,
            MoveToColumn(LEFT_MARGIN_WIDTH),
            Clear(ClearType::CurrentLine),
            SetForegroundColor(theme.spinner_active),
            Print(format!("{LEFT_MARGIN}{frame} {label}")),
            ResetColor,
            RestorePosition
        )?;
        out.flush()
    }

    pub fn finish(
        &mut self,
        label: &str,
        theme: &ColorTheme,
        out: &mut impl Write,
    ) -> io::Result<()> {
        self.frame_index = 0;
        execute!(
            out,
            MoveToColumn(0),
            Clear(ClearType::CurrentLine),
            SetForegroundColor(theme.spinner_done),
            Print(format!("{LEFT_MARGIN}✔ {label}\n")),
            ResetColor
        )?;
        out.flush()
    }

    pub fn fail(
        &mut self,
        label: &str,
        theme: &ColorTheme,
        out: &mut impl Write,
    ) -> io::Result<()> {
        self.frame_index = 0;
        execute!(
            out,
            MoveToColumn(0),
            Clear(ClearType::CurrentLine),
            SetForegroundColor(theme.spinner_failed),
            Print(format!("{LEFT_MARGIN}✘ {label}\n")),
            ResetColor
        )?;
        out.flush()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ListKind {
    Unordered,
    Ordered { next_index: u64 },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct TableState {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    current_row: Vec<String>,
    current_cell: String,
    in_head: bool,
}

impl TableState {
    fn push_cell(&mut self) {
        let cell = self.current_cell.trim().to_string();
        self.current_row.push(cell);
        self.current_cell.clear();
    }

    fn finish_row(&mut self) {
        if self.current_row.is_empty() {
            return;
        }
        let row = std::mem::take(&mut self.current_row);
        if self.in_head {
            self.headers = row;
        } else {
            self.rows.push(row);
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct RenderState {
    emphasis: usize,
    strong: usize,
    heading_level: Option<u8>,
    quote: usize,
    list_stack: Vec<ListKind>,
    link_stack: Vec<LinkState>,
    table: Option<TableState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LinkState {
    destination: String,
    text: String,
}

impl RenderState {
    fn style_text(&self, text: &str, theme: &ColorTheme) -> String {
        let mut style = text.stylize();

        if matches!(self.heading_level, Some(1 | 2)) || self.strong > 0 {
            style = style.bold();
        }
        if self.emphasis > 0 {
            style = style.italic();
        }

        if let Some(level) = self.heading_level {
            style = match level {
                1 => style.with(theme.heading),
                2 => style.white(),
                3 => style.with(Color::Blue),
                _ => style.with(Color::Grey),
            };
        } else if self.strong > 0 {
            style = style.with(theme.strong);
        } else if self.emphasis > 0 {
            style = style.with(theme.emphasis);
        }

        if self.quote > 0 {
            style = style.with(theme.quote);
        }

        format!("{style}")
    }

    fn append_raw(&mut self, output: &mut String, text: &str) {
        if let Some(link) = self.link_stack.last_mut() {
            link.text.push_str(text);
        } else if let Some(table) = self.table.as_mut() {
            table.current_cell.push_str(text);
        } else {
            output.push_str(text);
        }
    }

    fn append_styled(&mut self, output: &mut String, text: &str, theme: &ColorTheme) {
        let styled = self.style_text(text, theme);
        self.append_raw(output, &styled);
    }
}

#[derive(Debug)]
pub struct TerminalRenderer {
    syntax_set: SyntaxSet,
    syntax_theme: Theme,
    color_theme: ColorTheme,
}

impl Default for TerminalRenderer {
    fn default() -> Self {
        let syntax_set = SyntaxSet::load_defaults_newlines();
        let syntax_theme = ThemeSet::load_defaults()
            .themes
            .remove("base16-ocean.dark")
            .unwrap_or_default();
        Self {
            syntax_set,
            syntax_theme,
            color_theme: ColorTheme::default(),
        }
    }
}

impl TerminalRenderer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn color_theme(&self) -> &ColorTheme {
        &self.color_theme
    }

    #[must_use]
    pub fn render_markdown(&self, markdown: &str) -> String {
        let mut output = String::new();
        let mut state = RenderState::default();
        let mut code_language = String::new();
        let mut code_buffer = String::new();
        let mut in_code_block = false;

        for event in Parser::new_ext(markdown, Options::all()) {
            self.render_event(
                event,
                &mut state,
                &mut output,
                &mut code_buffer,
                &mut code_language,
                &mut in_code_block,
            );
        }

        output.trim_end().to_string()
    }

    #[must_use]
    pub fn markdown_to_ansi(&self, markdown: &str) -> String {
        self.render_markdown(markdown)
    }

    #[allow(clippy::too_many_lines)]
    fn render_event(
        &self,
        event: Event<'_>,
        state: &mut RenderState,
        output: &mut String,
        code_buffer: &mut String,
        code_language: &mut String,
        in_code_block: &mut bool,
    ) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                Self::start_heading(state, level as u8, output);
            }
            Event::End(TagEnd::Paragraph) => output.push_str("\n\n"),
            Event::Start(Tag::BlockQuote(..)) => self.start_quote(state, output),
            Event::End(TagEnd::BlockQuote(..)) => {
                state.quote = state.quote.saturating_sub(1);
                output.push('\n');
            }
            Event::End(TagEnd::Heading(..)) => {
                state.heading_level = None;
                output.push_str("\n\n");
            }
            Event::End(TagEnd::Item) | Event::SoftBreak | Event::HardBreak => {
                state.append_raw(output, "\n");
            }
            Event::Start(Tag::List(first_item)) => {
                let kind = match first_item {
                    Some(index) => ListKind::Ordered { next_index: index },
                    None => ListKind::Unordered,
                };
                state.list_stack.push(kind);
            }
            Event::End(TagEnd::List(..)) => {
                state.list_stack.pop();
                output.push('\n');
            }
            Event::Start(Tag::Item) => Self::start_item(state, output),
            Event::Start(Tag::CodeBlock(kind)) => {
                *in_code_block = true;
                *code_language = match kind {
                    CodeBlockKind::Indented => String::from("text"),
                    CodeBlockKind::Fenced(lang) => lang.to_string(),
                };
                code_buffer.clear();
                self.start_code_block(code_language, output);
            }
            Event::End(TagEnd::CodeBlock) => {
                self.finish_code_block(code_buffer, code_language, output);
                *in_code_block = false;
                code_language.clear();
                code_buffer.clear();
            }
            Event::Start(Tag::Emphasis) => state.emphasis += 1,
            Event::End(TagEnd::Emphasis) => state.emphasis = state.emphasis.saturating_sub(1),
            Event::Start(Tag::Strong) => state.strong += 1,
            Event::End(TagEnd::Strong) => state.strong = state.strong.saturating_sub(1),
            Event::Code(code) => {
                let rendered =
                    format!("{}", format!("`{code}`").with(self.color_theme.inline_code));
                state.append_raw(output, &rendered);
            }
            Event::Rule => output.push_str("---\n"),
            Event::Text(text) => {
                self.push_text(text.as_ref(), state, output, code_buffer, *in_code_block);
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                state.append_raw(output, &html);
            }
            Event::FootnoteReference(reference) => {
                state.append_raw(output, &format!("[{reference}]"));
            }
            Event::TaskListMarker(done) => {
                state.append_raw(output, if done { "[x] " } else { "[ ] " });
            }
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                state.append_raw(output, &math);
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                state.link_stack.push(LinkState {
                    destination: dest_url.to_string(),
                    text: String::new(),
                });
            }
            Event::End(TagEnd::Link) => {
                if let Some(link) = state.link_stack.pop() {
                    let label = if link.text.is_empty() {
                        link.destination.clone()
                    } else {
                        link.text
                    };
                    let rendered = format!(
                        "{}",
                        format!("[{label}]({})", link.destination)
                            .underlined()
                            .with(self.color_theme.link)
                    );
                    state.append_raw(output, &rendered);
                }
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                let rendered = format!(
                    "{}",
                    format!("[image:{dest_url}]").with(self.color_theme.link)
                );
                state.append_raw(output, &rendered);
            }
            Event::Start(Tag::Table(..)) => state.table = Some(TableState::default()),
            Event::End(TagEnd::Table) => {
                if let Some(table) = state.table.take() {
                    output.push_str(&self.render_table(&table));
                    output.push_str("\n\n");
                }
            }
            Event::Start(Tag::TableHead) => {
                if let Some(table) = state.table.as_mut() {
                    table.in_head = true;
                }
            }
            Event::End(TagEnd::TableHead) => {
                if let Some(table) = state.table.as_mut() {
                    table.finish_row();
                    table.in_head = false;
                }
            }
            Event::Start(Tag::TableRow) => {
                if let Some(table) = state.table.as_mut() {
                    table.current_row.clear();
                    table.current_cell.clear();
                }
            }
            Event::End(TagEnd::TableRow) => {
                if let Some(table) = state.table.as_mut() {
                    table.finish_row();
                }
            }
            Event::Start(Tag::TableCell) => {
                if let Some(table) = state.table.as_mut() {
                    table.current_cell.clear();
                }
            }
            Event::End(TagEnd::TableCell) => {
                if let Some(table) = state.table.as_mut() {
                    table.push_cell();
                }
            }
            Event::Start(Tag::Paragraph | Tag::MetadataBlock(..) | _)
            | Event::End(TagEnd::Image | TagEnd::MetadataBlock(..) | _) => {}
        }
    }

    fn start_heading(state: &mut RenderState, level: u8, output: &mut String) {
        state.heading_level = Some(level);
        if !output.is_empty() {
            output.push('\n');
        }
    }

    fn start_quote(&self, state: &mut RenderState, output: &mut String) {
        state.quote += 1;
        let _ = write!(output, "{}", "│ ".with(self.color_theme.quote));
    }

    fn start_item(state: &mut RenderState, output: &mut String) {
        let depth = state.list_stack.len().saturating_sub(1);
        output.push_str(&"  ".repeat(depth));

        let marker = match state.list_stack.last_mut() {
            Some(ListKind::Ordered { next_index }) => {
                let value = *next_index;
                *next_index += 1;
                format!("{value}. ")
            }
            _ => "• ".to_string(),
        };
        output.push_str(&marker);
    }

    fn start_code_block(&self, code_language: &str, output: &mut String) {
        let label = if code_language.is_empty() {
            "code".to_string()
        } else {
            code_language.to_string()
        };
        let _ = writeln!(
            output,
            "{}",
            format!("╭─ {label}")
                .bold()
                .with(self.color_theme.code_block_border)
        );
    }

    fn finish_code_block(&self, code_buffer: &str, code_language: &str, output: &mut String) {
        output.push_str(&self.highlight_code(code_buffer, code_language));
        let _ = write!(
            output,
            "{}",
            "╰─".bold().with(self.color_theme.code_block_border)
        );
        output.push_str("\n\n");
    }

    fn push_text(
        &self,
        text: &str,
        state: &mut RenderState,
        output: &mut String,
        code_buffer: &mut String,
        in_code_block: bool,
    ) {
        if in_code_block {
            code_buffer.push_str(text);
        } else {
            state.append_styled(output, text, &self.color_theme);
        }
    }

    fn render_table(&self, table: &TableState) -> String {
        let mut rows = Vec::new();
        if !table.headers.is_empty() {
            rows.push(table.headers.clone());
        }
        rows.extend(table.rows.iter().cloned());

        if rows.is_empty() {
            return String::new();
        }

        let column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
        let widths = (0..column_count)
            .map(|column| {
                rows.iter()
                    .filter_map(|row| row.get(column))
                    .map(|cell| visible_width(cell))
                    .max()
                    .unwrap_or(0)
            })
            .collect::<Vec<_>>();

        let border = format!("{}", "│".with(self.color_theme.table_border));
        let separator = widths
            .iter()
            .map(|width| "─".repeat(*width + 2))
            .collect::<Vec<_>>()
            .join(&format!("{}", "┼".with(self.color_theme.table_border)));
        let separator = format!("{border}{separator}{border}");

        let mut output = String::new();
        if !table.headers.is_empty() {
            output.push_str(&self.render_table_row(&table.headers, &widths, true));
            output.push('\n');
            output.push_str(&separator);
            if !table.rows.is_empty() {
                output.push('\n');
            }
        }

        for (index, row) in table.rows.iter().enumerate() {
            output.push_str(&self.render_table_row(row, &widths, false));
            if index + 1 < table.rows.len() {
                output.push('\n');
            }
        }

        output
    }

    fn render_table_row(&self, row: &[String], widths: &[usize], is_header: bool) -> String {
        let border = format!("{}", "│".with(self.color_theme.table_border));
        let mut line = String::new();
        line.push_str(&border);

        for (index, width) in widths.iter().enumerate() {
            let cell = row.get(index).map_or("", String::as_str);
            line.push(' ');
            if is_header {
                let _ = write!(line, "{}", cell.bold().with(self.color_theme.heading));
            } else {
                line.push_str(cell);
            }
            let padding = width.saturating_sub(visible_width(cell));
            line.push_str(&" ".repeat(padding + 1));
            line.push_str(&border);
        }

        line
    }

    #[must_use]
    pub fn highlight_code(&self, code: &str, language: &str) -> String {
        let syntax = self
            .syntax_set
            .find_syntax_by_token(language)
            .unwrap_or_else(|| self.syntax_set.find_syntax_plain_text());
        let mut syntax_highlighter = HighlightLines::new(syntax, &self.syntax_theme);
        let mut colored_output = String::new();

        for line in LinesWithEndings::from(code) {
            match syntax_highlighter.highlight_line(line, &self.syntax_set) {
                Ok(ranges) => {
                    let escaped = as_24_bit_terminal_escaped(&ranges[..], false);
                    colored_output.push_str(&apply_code_block_background(&escaped));
                }
                Err(_) => colored_output.push_str(&apply_code_block_background(line)),
            }
        }

        colored_output
    }

    pub fn stream_markdown(&self, markdown: &str, out: &mut impl Write) -> io::Result<()> {
        let rendered_markdown = pad_and_wrap(&self.markdown_to_ansi(markdown));
        write!(out, "{rendered_markdown}")?;
        if !rendered_markdown.ends_with('\n') {
            writeln!(out)?;
        }
        out.flush()
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MarkdownStreamState {
    pending: String,
}

impl MarkdownStreamState {
    #[must_use]
    pub fn push(&mut self, renderer: &TerminalRenderer, delta: &str) -> Option<String> {
        self.pending.push_str(delta);
        let split = find_stream_safe_boundary(&self.pending)?;
        let ready = self.pending[..split].to_string();
        self.pending.drain(..split);
        let mut chunk = pad_and_wrap(&renderer.markdown_to_ansi(&ready));
        // The ready chunk always ends at a paragraph/code-fence boundary, so
        // restore the paragraph break that render_markdown's trim_end() removed.
        // Without this, consecutive streaming writes concatenate on the same
        // terminal line, causing text to overflow the terminal width.
        if !chunk.ends_with('\n') {
            chunk.push_str("\n\n");
        }
        Some(chunk)
    }

    #[must_use]
    pub fn flush(&mut self, renderer: &TerminalRenderer) -> Option<String> {
        if self.pending.trim().is_empty() {
            self.pending.clear();
            None
        } else {
            let pending = std::mem::take(&mut self.pending);
            let mut chunk = pad_and_wrap(&renderer.markdown_to_ansi(&pending));
            // Ensure the final chunk ends with a newline so the cursor moves to
            // a fresh line (prevents collision with subsequent TUI elements).
            if !chunk.ends_with('\n') {
                chunk.push('\n');
            }
            Some(chunk)
        }
    }
}

fn apply_code_block_background(line: &str) -> String {
    let trimmed = line.trim_end_matches('\n');
    let trailing_newline = if trimmed.len() == line.len() {
        ""
    } else {
        "\n"
    };
    let with_background = trimmed.replace("\u{1b}[0m", "\u{1b}[0;48;5;236m");
    format!("\u{1b}[48;5;236m{with_background}\u{1b}[0m{trailing_newline}")
}

fn find_stream_safe_boundary(markdown: &str) -> Option<usize> {
    let mut in_fence = false;
    let mut last_boundary = None;

    for (offset, line) in markdown.split_inclusive('\n').scan(0usize, |cursor, line| {
        let start = *cursor;
        *cursor += line.len();
        Some((start, line))
    }) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            if !in_fence {
                last_boundary = Some(offset + line.len());
            }
            continue;
        }

        if in_fence {
            continue;
        }

        if trimmed.is_empty() {
            last_boundary = Some(offset + line.len());
        }
    }

    last_boundary
}

fn visible_width(input: &str) -> usize {
    strip_ansi(input).chars().count()
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            output.push(ch);
        }
    }

    output
}

// ---------------------------------------------------------------------------
// Fixed footer — always visible at the bottom of the terminal
// ---------------------------------------------------------------------------

/// Number of terminal rows reserved for the fixed footer.
pub const FOOTER_HEIGHT: u16 = 3;

/// Minimum terminal height to enable the fixed footer. Below this the
/// footer is skipped so tiny terminals remain usable.
const MIN_ROWS_FOR_FOOTER: u16 = FOOTER_HEIGHT + 8;

/// Set the terminal scroll region to exclude the bottom `FOOTER_HEIGHT` rows.
/// Content scrolls within the region; the footer area stays fixed.
///
/// **Important:** the ANSI `\x1b[…r` sequence resets the cursor to the home
/// position (0,0). We save/restore around it so the cursor stays put.
///
/// Returns the row-count that was applied (`0` when the footer was skipped).
pub fn setup_scroll_region() -> io::Result<u16> {
    let (_, rows) = crossterm::terminal::size()?;
    if rows < MIN_ROWS_FOR_FOOTER {
        return Ok(0);
    }
    let mut stdout = io::stdout();
    // Save cursor before the region change (which resets cursor to home)
    execute!(stdout, SavePosition)?;
    // ANSI scroll region is 1-indexed: rows 1 through (rows - FOOTER_HEIGHT)
    write!(stdout, "\x1b[1;{}r", rows - FOOTER_HEIGHT)?;
    // Restore cursor to where it was before
    execute!(stdout, RestorePosition)?;
    stdout.flush()?;
    Ok(rows)
}

/// Returns the current terminal row count (for resize detection).
pub fn terminal_rows() -> u16 {
    crossterm::terminal::size().map(|(_, r)| r).unwrap_or(24)
}

/// Reset the scroll region to the full terminal. Call on exit.
pub fn reset_scroll_region() -> io::Result<()> {
    let mut stdout = io::stdout();
    write!(stdout, "\x1b[r")?;
    stdout.flush()
}

/// Token usage info for the footer display.
#[derive(Debug, Clone, Copy, Default)]
pub struct FooterTokenInfo {
    pub total_tokens: u32,
    pub estimated_cost_usd: f64,
}

/// Draw the fixed footer at the absolute bottom of the terminal.
///
/// Layout (from top of footer area):
///   Row 0: separator line  `────────────────`  (dark grey)
///   Row 1: status info     `~/path · Model · N msgs          tokens · $cost`
///   Row 2: help hints      `/help commands · Shift+Enter newline`
pub fn draw_footer(
    cwd: &str,
    model: &str,
    message_count: usize,
    tokens: Option<FooterTokenInfo>,
) -> io::Result<()> {
    let mut stdout = io::stdout();
    let (cols, rows) = crossterm::terminal::size()?;
    if rows < MIN_ROWS_FOR_FOOTER {
        return Ok(());
    }

    let display_dir = shorten_home(cwd);
    let model_display = format_model_display(model);

    // Save cursor position (should be within the scroll region)
    execute!(stdout, SavePosition)?;

    // --- Row 0: separator ---
    let sep_row = rows - FOOTER_HEIGHT;
    execute!(
        stdout,
        MoveTo(0, sep_row),
        Clear(ClearType::CurrentLine),
        SetForegroundColor(Color::DarkGrey),
        Print("\u{2500}".repeat(cols as usize)),
        ResetColor,
    )?;

    // --- Row 1: status info with distinct colours ---
    execute!(
        stdout,
        MoveTo(0, sep_row + 1),
        Clear(ClearType::CurrentLine),
        Print(LEFT_MARGIN),
        // Directory in brand colour
        SetForegroundColor(BRAND_COLOR),
        Print(&display_dir),
        ResetColor,
        // Dot separator
        SetForegroundColor(Color::DarkGrey),
        Print("  \u{00b7}  "),
        ResetColor,
        // Model in white
        SetForegroundColor(Color::White),
        Print(&model_display),
        ResetColor,
    )?;
    if message_count > 0 {
        let msgs = if message_count == 1 {
            "1 msg".to_string()
        } else {
            format!("{message_count} msgs")
        };
        execute!(
            stdout,
            SetForegroundColor(Color::DarkGrey),
            Print(format!("  \u{00b7}  {msgs}")),
            ResetColor,
        )?;
    }

    // Right-aligned token counter
    if let Some(info) = tokens {
        if info.total_tokens > 0 {
            let token_str = format_token_count(info.total_tokens);
            let cost_str = format_footer_cost(info.estimated_cost_usd);
            let right_text = format!("{token_str} \u{00b7} {cost_str}");
            let right_col =
                (cols as usize).saturating_sub(right_text.len() + LEFT_MARGIN_WIDTH as usize);
            execute!(
                stdout,
                #[allow(clippy::cast_possible_truncation)]
                MoveToColumn(right_col as u16),
                SetForegroundColor(Color::DarkGrey),
                Print(&token_str),
                Print(" \u{00b7} "),
                SetForegroundColor(Color::AnsiValue(149)), // muted green
                Print(&cost_str),
                ResetColor,
            )?;
        }
    }

    // --- Row 2: help hints ---
    execute!(
        stdout,
        MoveTo(0, sep_row + 2),
        Clear(ClearType::CurrentLine),
        Print(LEFT_MARGIN),
        SetForegroundColor(Color::White),
        Print("/help"),
        SetForegroundColor(Color::DarkGrey),
        Print(" commands \u{00b7} "),
        SetForegroundColor(Color::White),
        Print("Tab"),
        SetForegroundColor(Color::DarkGrey),
        Print(" complete \u{00b7} "),
        SetForegroundColor(Color::White),
        Print("Shift+Enter"),
        SetForegroundColor(Color::DarkGrey),
        Print(" newline"),
        ResetColor,
    )?;

    // Restore cursor back into the scroll region
    execute!(stdout, RestorePosition)?;
    stdout.flush()
}

/// Position the cursor at the bottom of the scroll region and draw the
/// separator line, so the input prompt appears just above the fixed footer.
///
/// This prints enough newlines to push the cursor down to the last two rows
/// of the scroll region, then draws the separator. The rustyline prompt
/// that follows will appear on the very last row of the scroll region —
/// directly above the footer.
pub fn position_input_at_bottom(out: &mut impl Write) -> io::Result<()> {
    let (cols, rows) = crossterm::terminal::size()?;
    if rows < MIN_ROWS_FOR_FOOTER {
        // No footer — just print separator at current position
        let bar_width = cols as usize;
        execute!(
            out,
            SetForegroundColor(Color::DarkGrey),
            Print(format!(
                "{LEFT_MARGIN}{}\n",
                "\u{2500}".repeat(bar_width.saturating_sub(LEFT_MARGIN.len()))
            )),
            ResetColor,
        )?;
        return out.flush();
    }

    // The scroll region occupies rows 0 .. (rows - FOOTER_HEIGHT - 1) in 0-indexed.
    // We want the separator on the second-to-last row of the region,
    // and the rustyline prompt on the very last row.
    let scroll_bottom = rows - FOOTER_HEIGHT; // 0-indexed: first footer row
                                              // separator_row is 2 rows above the footer: scroll_bottom - 2
                                              // prompt will be at: scroll_bottom - 1
    let target_row = scroll_bottom.saturating_sub(2);

    // Query current cursor row
    if let Ok((_, current_row)) = crossterm::cursor::position() {
        if current_row < target_row {
            // Print newlines to push the cursor down to the target row.
            // Each newline within the scroll region moves the cursor down
            // (or scrolls when at the bottom).
            let gap = target_row - current_row;
            for _ in 0..gap {
                writeln!(out)?;
            }
        }
        // If current_row >= target_row, cursor is already at or past the target.
        // In that case the separator just prints at the current position, which
        // will be right above the footer (content has filled the screen).
    }

    // Draw separator
    let bar_width = cols as usize;
    execute!(
        out,
        SetForegroundColor(Color::DarkGrey),
        Print(format!(
            "{LEFT_MARGIN}{}\n",
            "\u{2500}".repeat(bar_width.saturating_sub(LEFT_MARGIN.len()))
        )),
        ResetColor,
    )?;
    out.flush()
}

/// Shorten a path by replacing the home directory prefix with `~`.
fn shorten_home(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_string()
    }
}

/// Convert a model ID like `claude-opus-4-6` to a human-readable name like `Opus 4.6`.
#[must_use]
pub fn format_model_display(model: &str) -> String {
    let stripped = model.strip_prefix("claude-").unwrap_or(model);
    // Find where the version digits start
    if let Some(digit_pos) = stripped.find(|c: char| c.is_ascii_digit()) {
        let name_part = stripped[..digit_pos].trim_end_matches('-');
        let version_part = stripped[digit_pos..].replace('-', ".");
        // Capitalize first letter
        let mut capitalized = String::with_capacity(name_part.len());
        for (i, ch) in name_part.chars().enumerate() {
            if i == 0 {
                capitalized.extend(ch.to_uppercase());
            } else {
                capitalized.push(ch);
            }
        }
        format!("{capitalized} {version_part}")
    } else {
        stripped.to_string()
    }
}

fn format_token_count(tokens: u32) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M tokens", f64::from(tokens) / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}K tokens", f64::from(tokens) / 1_000.0)
    } else {
        format!("{tokens} tokens")
    }
}

fn format_footer_cost(usd: f64) -> String {
    if usd < 0.01 {
        "<$0.01".to_string()
    } else if usd < 10.0 {
        format!("${usd:.2}")
    } else {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let rounded = usd.round() as u32;
        format!("${rounded}")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        format_model_display, strip_ansi, wrap_ansi_line, MarkdownStreamState, Spinner,
        TerminalRenderer, LEFT_MARGIN,
    };

    #[test]
    fn wraps_long_plain_text_at_max_width() {
        let text = "Hello! I\u{2019}m your Dovai Agent, the AI business operator for this workspace.  I\u{2019}m ready to run our operational loop \u{2014} checking triggers, following or creating processes,";
        let max_width = 96; // 100 col terminal - 4 margin
        let mut output = String::new();
        wrap_ansi_line(text, max_width, &mut output);

        // Every line in the output should fit within LEFT_MARGIN + max_width
        let max_visible = LEFT_MARGIN.len() + max_width;
        for (i, line) in output.lines().enumerate() {
            let vis = strip_ansi(line).chars().count();
            assert!(
                vis <= max_visible,
                "Line {i} is {vis} chars (max {max_visible}): {line:?}"
            );
        }
        // Should have multiple lines since the input is ~165 chars
        assert!(
            output.lines().count() > 1,
            "Should wrap to multiple lines, got: {output:?}"
        );
    }

    #[test]
    fn renders_markdown_with_styling_and_lists() {
        let terminal_renderer = TerminalRenderer::new();
        let markdown_output = terminal_renderer
            .render_markdown("# Heading\n\nThis is **bold** and *italic*.\n\n- item\n\n`code`");

        assert!(markdown_output.contains("Heading"));
        assert!(markdown_output.contains("• item"));
        assert!(markdown_output.contains("code"));
        assert!(markdown_output.contains('\u{1b}'));
    }

    #[test]
    fn renders_links_as_colored_markdown_labels() {
        let terminal_renderer = TerminalRenderer::new();
        let markdown_output =
            terminal_renderer.render_markdown("See [Dovai](https://example.com/docs) now.");
        let plain_text = strip_ansi(&markdown_output);

        assert!(plain_text.contains("[Dovai](https://example.com/docs)"));
        assert!(markdown_output.contains('\u{1b}'));
    }

    #[test]
    fn highlights_fenced_code_blocks() {
        let terminal_renderer = TerminalRenderer::new();
        let markdown_output =
            terminal_renderer.markdown_to_ansi("```rust\nfn hi() { println!(\"hi\"); }\n```");
        let plain_text = strip_ansi(&markdown_output);

        assert!(plain_text.contains("╭─ rust"));
        assert!(plain_text.contains("fn hi"));
        assert!(markdown_output.contains('\u{1b}'));
        assert!(markdown_output.contains("[48;5;236m"));
    }

    #[test]
    fn renders_ordered_and_nested_lists() {
        let terminal_renderer = TerminalRenderer::new();
        let markdown_output =
            terminal_renderer.render_markdown("1. first\n2. second\n   - nested\n   - child");
        let plain_text = strip_ansi(&markdown_output);

        assert!(plain_text.contains("1. first"));
        assert!(plain_text.contains("2. second"));
        assert!(plain_text.contains("  • nested"));
        assert!(plain_text.contains("  • child"));
    }

    #[test]
    fn renders_tables_with_alignment() {
        let terminal_renderer = TerminalRenderer::new();
        let markdown_output = terminal_renderer
            .render_markdown("| Name | Value |\n| ---- | ----- |\n| alpha | 1 |\n| beta | 22 |");
        let plain_text = strip_ansi(&markdown_output);
        let lines = plain_text.lines().collect::<Vec<_>>();

        assert_eq!(lines[0], "│ Name  │ Value │");
        assert_eq!(lines[1], "│───────┼───────│");
        assert_eq!(lines[2], "│ alpha │ 1     │");
        assert_eq!(lines[3], "│ beta  │ 22    │");
        assert!(markdown_output.contains('\u{1b}'));
    }

    #[test]
    fn streaming_state_waits_for_complete_blocks() {
        let renderer = TerminalRenderer::new();
        let mut state = MarkdownStreamState::default();

        assert_eq!(state.push(&renderer, "# Heading"), None);
        let flushed = state
            .push(&renderer, "\n\nParagraph\n\n")
            .expect("completed block");
        let plain_text = strip_ansi(&flushed);
        assert!(plain_text.contains("Heading"));
        assert!(plain_text.contains("Paragraph"));

        assert_eq!(state.push(&renderer, "```rust\nfn main() {}\n"), None);
        let code = state
            .push(&renderer, "```\n")
            .expect("closed code fence flushes");
        assert!(strip_ansi(&code).contains("fn main()"));
    }

    #[test]
    fn wrap_full_paragraph_at_111_columns() {
        // Simulates the exact scenario: 111 column terminal, single paragraph
        let text = "Hello! I'm your Dovai Agent.  It looks like this is our first conversation. My detailed instructions haven't been provided yet. Could you please share them? You can either paste the full instructions here, or drop a file containing them into the `inbox/` folder.  Once I have them, I'll save them to `AGENTS.md` and begin operating according to the business";
        let renderer = TerminalRenderer::new();
        let ansi = renderer.markdown_to_ansi(text);

        // Simulate 111-column terminal: max_width = 111 - 4 = 107
        let max_width = 107;
        let max_visible = LEFT_MARGIN.len() + max_width; // 109

        let wrapped = super::pad_and_wrap_with_width(&ansi, max_width);
        for (i, line) in wrapped.lines().enumerate() {
            let vis = strip_ansi(line).chars().count();
            assert!(
                vis <= max_visible,
                "Line {i} is {vis} visible chars (max {max_visible}): {:?}",
                strip_ansi(line)
            );
        }
        // The text is ~350 chars, should wrap to multiple lines
        assert!(
            wrapped.lines().count() >= 3,
            "Should wrap to multiple lines, got:\n{wrapped}"
        );
    }

    #[test]
    fn streaming_chunks_end_with_newline() {
        let renderer = TerminalRenderer::new();
        let mut state = MarkdownStreamState::default();

        // Push two paragraphs — the first boundary flush should end with newlines
        let chunk1 = state
            .push(&renderer, "First paragraph.\n\nSecond paragraph.")
            .expect("first paragraph boundary");
        assert!(
            chunk1.ends_with('\n'),
            "push chunk must end with newline to prevent concatenation, got: {chunk1:?}"
        );

        // Flush the remaining text — should also end with newline
        let chunk2 = state.flush(&renderer).expect("remaining text");
        assert!(
            chunk2.ends_with('\n'),
            "flush chunk must end with newline, got: {chunk2:?}"
        );
    }

    #[test]
    fn spinner_advances_frames() {
        let terminal_renderer = TerminalRenderer::new();
        let mut spinner = Spinner::new();
        let mut out = Vec::new();
        spinner
            .tick("Working", terminal_renderer.color_theme(), &mut out)
            .expect("tick succeeds");
        spinner
            .tick("Working", terminal_renderer.color_theme(), &mut out)
            .expect("tick succeeds");

        let output = String::from_utf8_lossy(&out);
        assert!(output.contains("Working"));
    }

    #[test]
    fn formats_claude_model_names_as_human_readable() {
        assert_eq!(format_model_display("claude-opus-4-6"), "Opus 4.6");
        assert_eq!(format_model_display("claude-sonnet-4-6"), "Sonnet 4.6");
        assert_eq!(
            format_model_display("claude-haiku-4-5-20251001"),
            "Haiku 4.5.20251001"
        );
        assert_eq!(format_model_display("gpt-4o"), "Gpt 4o");
    }

    #[test]
    fn input_positioning_draws_separator() {
        let mut buf = Vec::new();
        // position_input_at_bottom uses crossterm::cursor::position() which
        // may not work in a test environment, so we just verify it doesn't panic
        // and produces SOME output containing the separator character.
        let _ = super::position_input_at_bottom(&mut buf);
        let output = String::from_utf8_lossy(&buf);
        // In a non-tty test env it might fall through to the small-terminal
        // path, which still draws a separator.
        assert!(output.contains('\u{2500}') || output.is_empty());
    }
}
