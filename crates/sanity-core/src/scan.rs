//! Deciding which files exist, and turning each one into line metrics.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::filter::Filter;
use crate::lang::{extension_of, grammar_for_extension};
use crate::tokenize::tokenize;
use crate::wire::{pack_span, FileData, Kind, LineState, FLAG_BINARY, FLAG_NO_GRAMMAR,
                  FLAG_TRUNCATED, MAX_COLS, MAX_SPAN_LEN};

/// How many columns a tab advances to. Only affects the visual indent, since
/// nothing here reflows text.
pub const TAB_WIDTH: u32 = 4;

/// Bytes read to decide whether a file is binary. Git uses the same idea.
const SNIFF_BYTES: usize = 8192;

#[derive(Debug, Clone)]
pub struct ScannedFile {
    /// Path relative to the repository root, forward slashes.
    pub path: String,
    pub line_count: u32,
    pub max_cols: u32,
    pub byte_len: u64,
}

#[derive(Debug)]
pub enum ScanError {
    Io(std::io::Error),
    NotADirectory(PathBuf),
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScanError::Io(e) => write!(f, "io error: {e}"),
            ScanError::NotADirectory(p) => write!(f, "not a directory: {}", p.display()),
        }
    }
}

impl std::error::Error for ScanError {}

impl From<std::io::Error> for ScanError {
    fn from(e: std::io::Error) -> Self {
        ScanError::Io(e)
    }
}

/// Every path git does not ignore: tracked, plus untracked that no ignore rule
/// covers. This is the whole gitignore question answered in one command, with
/// git's own semantics, including nested ignore files, excludesfile and the
/// user's global config.
pub fn git_listed_files(root: &Path) -> Option<Vec<String>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        out.stdout
            .split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
    )
}

/// Fallback for a folder that is not a git repository. Skips the usual
/// suspects by name, since without git there is no ignore file to consult.
fn walk(root: &Path) -> Result<Vec<String>, ScanError> {
    const SKIP_DIRS: &[&str] = &[
        ".git", "node_modules", "target", "dist", "build", ".venv", "venv",
        "__pycache__", ".next", ".cache", ".pytest_cache", ".mypy_cache",
    ];

    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let ty = entry.file_type()?;
            if ty.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if ty.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// A NUL byte in the first few kilobytes means binary. Crude and it is what
/// git does; the cases it gets wrong are files nobody wants to read anyway.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(SNIFF_BYTES).any(|&b| b == 0)
}

/// Visual width of a line in columns, and its leading indent, with tabs
/// expanded. Counts characters rather than bytes, so UTF-8 lines up; east
/// Asian double-width characters are counted as one, which is wrong and worth
/// fixing only once someone has a repo where it shows.
fn line_metrics(line: &str) -> (u32, u32) {
    let mut col = 0u32;
    let mut indent = None;
    for ch in line.chars() {
        match ch {
            '\t' => col += TAB_WIDTH - (col % TAB_WIDTH),
            ' ' => col += 1,
            _ => {
                if indent.is_none() {
                    indent = Some(col);
                }
                col += 1;
            }
        }
    }
    // A whitespace-only line has no indent worth reporting.
    (col, indent.unwrap_or(0))
}

/// Line metrics for a whole file, with every span marked `Plain`.
///
/// This is the tokeniser-free version: it already renders correctly, because
/// what the zoomed-out levels of detail show is indentation and line length,
/// not colour. The tree-sitter pass replaces the spans and nothing else.
pub fn plain_file_data(text: &str) -> FileData {
    let mut f = FileData { lang_id: 0, flags: 0, ..Default::default() };
    let mut truncated = false;

    for line in text.lines() {
        f.span_start.push(f.spans.len() as u32);
        let (cols, indent) = line_metrics(line);
        let clipped = cols.min(MAX_COLS);
        if cols > MAX_COLS {
            truncated = true;
        }
        f.line_cols.push(clipped as u16);
        f.line_indent.push(indent.min(u8::MAX as u32) as u8);
        f.line_state.push(LineState::Unchanged as u8);

        if clipped > indent {
            // One span covering the line's content. Longer than a span can
            // encode gets split, which keeps the encoding honest without a
            // special case downstream.
            let mut start = indent;
            while start < clipped {
                let len = (clipped - start).min(MAX_SPAN_LEN);
                f.spans.push(pack_span(start, len, Kind::Plain));
                start += len;
            }
        }
    }
    f.span_start.push(f.spans.len() as u32);
    if truncated {
        f.flags |= FLAG_TRUNCATED;
    }
    f
}

fn binary_file_data() -> FileData {
    let mut f = FileData { flags: FLAG_BINARY, ..Default::default() };
    f.span_start.push(0);
    f
}

/// Read one file and produce its payload. Returns `None` when the file cannot
/// be read at all, which happens for broken symlinks and races with a build.
pub fn read_file(root: &Path, rel: &str) -> Option<(FileData, ScannedFile)> {
    let full = root.join(rel);
    let bytes = std::fs::read(&full).ok()?;
    let byte_len = bytes.len() as u64;

    if looks_binary(&bytes) {
        return Some((
            binary_file_data(),
            ScannedFile { path: rel.to_string(), line_count: 0, max_cols: 0, byte_len },
        ));
    }

    let text = String::from_utf8_lossy(&bytes);
    // A grammar if one claims the extension, otherwise line metrics alone.
    // Plain output still renders correctly: what the zoomed-out levels show is
    // indentation and line length, and only the colour is missing.
    let data = match extension_of(rel).and_then(grammar_for_extension) {
        Some(grammar) => tokenize(&text, grammar),
        None => {
            let mut d = plain_file_data(&text);
            d.flags |= FLAG_NO_GRAMMAR;
            d
        }
    };
    let scanned = ScannedFile {
        path: rel.to_string(),
        line_count: data.line_count() as u32,
        max_cols: data.line_cols.iter().copied().max().unwrap_or(0) as u32,
        byte_len,
    };
    Some((data, scanned))
}

/// List the files in `root` that should be laid out, in git's order.
///
/// Uses git when it can and a plain walk otherwise, then applies `filter`,
/// which is where generated artefacts are dropped. See the note in
/// `filter.rs` for why gitignore alone is not enough.
pub fn list_files(root: &Path, filter: &Filter) -> Result<Vec<String>, ScanError> {
    if !root.is_dir() {
        return Err(ScanError::NotADirectory(root.to_path_buf()));
    }
    let listed = match git_listed_files(root) {
        Some(v) => v,
        None => walk(root)?,
    };
    Ok(listed.into_iter().filter(|p| filter.keep(root, p)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{span_col, span_kind, span_len};

    #[test]
    fn tabs_expand_to_the_next_stop() {
        assert_eq!(line_metrics("\tx"), (5, 4));
        assert_eq!(line_metrics("  \tx"), (5, 4));
        assert_eq!(line_metrics("ab\tc"), (5, 0));
        assert_eq!(line_metrics("    let x = 1;"), (14, 4));
    }

    #[test]
    fn blank_and_whitespace_lines_have_no_indent() {
        assert_eq!(line_metrics(""), (0, 0));
        assert_eq!(line_metrics("   "), (3, 0));
    }

    #[test]
    fn multibyte_counts_as_characters_not_bytes() {
        // Four characters, ten bytes.
        assert_eq!(line_metrics("aäöü").0, 4);
    }

    #[test]
    fn plain_data_is_valid_and_indexes_line_up() {
        let f = plain_file_data("fn main() {\n\n    let x = 1;\n}\n");
        f.validate().unwrap();
        assert_eq!(f.line_count(), 4);
        assert_eq!(f.line_cols.as_slice(), &[11, 0, 14, 1]);
        assert_eq!(f.line_indent.as_slice(), &[0, 0, 4, 0]);
        // The blank line owns no spans.
        assert_eq!(f.span_start[1], f.span_start[2]);
        // The indented line's span starts at its indent.
        let s = f.spans[f.span_start[2] as usize];
        assert_eq!(span_col(s), 4);
        assert_eq!(span_len(s), 10);
        assert_eq!(span_kind(s), Kind::Plain as u8);
    }

    #[test]
    fn a_very_long_line_is_clipped_and_flagged() {
        let text = "x".repeat(MAX_COLS as usize + 500);
        let f = plain_file_data(&text);
        f.validate().unwrap();
        assert_eq!(f.line_cols[0] as u32, MAX_COLS);
        assert!(f.flags & FLAG_TRUNCATED != 0);
        // Split into spans no longer than the encoding allows.
        assert!(f.spans.iter().all(|&s| span_len(s) <= MAX_SPAN_LEN));
        let covered: u32 = f.spans.iter().map(|&s| span_len(s)).sum();
        assert_eq!(covered, MAX_COLS);
    }

    #[test]
    fn binary_is_detected_by_nul() {
        assert!(looks_binary(b"\x7fELF\0\0\0"));
        assert!(!looks_binary(b"fn main() {}\n"));
    }

    #[test]
    fn empty_file_is_valid() {
        let f = plain_file_data("");
        f.validate().unwrap();
        assert_eq!(f.line_count(), 0);
    }

    #[test]
    fn crlf_does_not_leak_into_the_metrics() {
        let f = plain_file_data("a\r\nbb\r\n");
        assert_eq!(f.line_cols.as_slice(), &[1, 2]);
    }
}
