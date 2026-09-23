//! Deciding which files exist, and turning each one into line metrics.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    /// Set when the file is a picture rather than text, with what the layout
    /// needs to size and shape its panel. See `media`.
    pub media: Option<crate::media::Media>,
    pub byte_len: u64,
    /// Modification time in nanoseconds since the epoch, as it was *before*
    /// the read, and 0 when the system does not report one.
    ///
    /// Taken before rather than after on purpose. A file written while it is
    /// being read would otherwise be recorded with the newer time against the
    /// older content, and the next event for it would be dismissed as
    /// something already seen.
    pub mtime: u128,
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

/// Every path git *does* ignore, capped.
///
/// The other half of `git_listed_files`, for the switch in the View menu that
/// brings ignored files into the layout. Capped because the answer is not
/// small: this repository ignores 83,014 files, nearly ten gigabytes of build
/// output, and a monitor that reads all of them to show you that they exist
/// has stopped being a monitor. Returns what fits and how many there were, so
/// the UI can say which it is showing.
pub fn git_ignored_files(root: &Path, cap: usize) -> (Vec<String>, usize) {
    let Ok(out) = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"])
        .output()
    else {
        return (Vec::new(), 0);
    };
    if !out.status.success() {
        return (Vec::new(), 0);
    }
    let all: Vec<String> = out
        .stdout
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    let total = all.len();
    let mut kept = all;
    kept.truncate(cap);
    (kept, total)
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

/// Largest file read whole. 16 MB is past every source file in the
/// repositories measured here and short of the build output a folder is full
/// of once ignored files are switched on.
pub const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

/// How much of a larger file is read, which is what the media probe and the
/// binary sniff see. Two megabytes rather than a few kilobytes because a PDF
/// keeps its page tree wherever it likes.
const PROBE_BYTES: usize = 2 * 1024 * 1024;

/// The first `n` bytes of a file, for something too large to hold.
fn read_head(path: &Path, n: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; n];
    let mut filled = 0usize;
    while filled < n {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(got) => filled += got,
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    Some(buf)
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

/// The text of a file as the canvas shows it.
///
/// The identity for everything except a notebook, whose cells are read out of
/// its JSON. Every reader goes through this: the scan for its metrics, the
/// `file_text` command for the glyphs, the content search for its hits, and
/// the dump for the demo. They have to agree, because a span's column is a
/// column of the line the renderer draws, and a hit's line number is a line
/// of the panel it lights up.
pub fn display_text(rel: &str, bytes: &[u8]) -> String {
    let raw = String::from_utf8_lossy(bytes);
    match notebook_of(rel, &raw) {
        Some(nb) => nb.source,
        None => raw.into_owned(),
    }
}

/// The notebook a file is, if it is one.
fn notebook_of(rel: &str, text: &str) -> Option<crate::notebook::Notebook> {
    if !crate::notebook::is_notebook(rel) {
        return None;
    }
    crate::notebook::parse(text)
}

/// Read one file and produce its payload. Returns `None` when the file cannot
/// be read at all, which happens for broken symlinks and races with a build.
pub fn read_file(root: &Path, rel: &str) -> Option<(FileData, ScannedFile)> {
    let full = root.join(rel);
    let mtime = mtime_of(&full);
    let size = std::fs::metadata(&full).ok()?.len();
    // Past a point a file is not read at all, only its head. Nothing on the
    // canvas wants the body of a 200 MB archive: it has no lines to draw, and
    // reading it costs a second and the memory of the whole project. The head
    // is still enough for the two questions that matter, whether it is a
    // picture and whether it is binary.
    let bytes = if size > MAX_READ_BYTES {
        read_head(&full, PROBE_BYTES)?
    } else {
        std::fs::read(&full).ok()?
    };
    let byte_len = size;

    // A picture is not text, but it is part of the project, so it is listed
    // with what its header says rather than skipped. Checked before the
    // binary sniff, since that is what used to swallow it.
    if let Some(media) = crate::media::probe(rel, &bytes) {
        return Some((
            binary_file_data(),
            ScannedFile {
                path: rel.to_string(),
                line_count: 0,
                max_cols: 0,
                media: Some(media),
                byte_len,
                mtime,
            },
        ));
    }

    if size > MAX_READ_BYTES || looks_binary(&bytes) {
        return Some((
            binary_file_data(),
            ScannedFile {
                path: rel.to_string(),
                line_count: 0,
                max_cols: 0,
                media: None,
                byte_len,
                mtime,
            },
        ));
    }

    let raw = String::from_utf8_lossy(&bytes);
    // A notebook is read once, and both its text and its spans come out of
    // that one reading: going through `display_text` here and then parsing
    // again would be parsing the cells as if they were the JSON, which is how
    // the output lines ended up with no colour of their own.
    let notebook = notebook_of(rel, &raw);
    let text: &str = notebook.as_ref().map(|nb| nb.source.as_str()).unwrap_or(&raw);
    // A grammar if one claims the extension, then the coarse lexer for the
    // languages that have no usable grammar, then line metrics alone. Plain
    // output still renders correctly: what the zoomed-out levels show is
    // indentation and line length, and only the colour is missing.
    let ext = extension_of(rel);
    let data = if let Some(nb) = notebook.as_ref() {
        crate::notebook::tokenize(nb)
    } else if let Some(grammar) = ext.and_then(grammar_for_extension) {
        tokenize(text, grammar)
    } else if let Some((id, _, syn)) = ext.and_then(crate::lang::syntax_for_extension) {
        crate::simple::lex(text, id, syn)
    } else {
        let mut d = plain_file_data(text);
        d.flags |= FLAG_NO_GRAMMAR;
        d
    };
    let scanned = ScannedFile {
        path: rel.to_string(),
        line_count: data.line_count() as u32,
        max_cols: data.line_cols.iter().copied().max().unwrap_or(0) as u32,
        media: None,
        byte_len,
        mtime,
    };
    Some((data, scanned))
}

/// Modification time in nanoseconds, or 0 when there is none to be had.
///
/// One `stat`, which is what makes it worth asking before deciding to read: a
/// stat is a few microseconds and reading plus tokenising a file is a few
/// hundred. A watcher on a repository somebody else is working in reports a
/// great many paths whose content has not moved.
pub fn mtime_of(path: &Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Modification time and size together, for deciding whether to read at all.
pub fn stamp_of(root: &Path, rel: &str) -> Option<(u128, u64)> {
    let m = std::fs::metadata(root.join(rel)).ok()?;
    let t = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((t, m.len()))
}

/// Read and tokenise many files at once, across the cores available.
///
/// Files are independent, so this is the easy kind of parallel: no shared
/// mutable state, no ordering, and the grammars are already immutable statics.
/// Measured on 218 thousand lines, single threaded, in a release build: 1.08
/// seconds, of which 132 milliseconds is reading the bytes and the rest is
/// parsing. That was the largest single cost in opening a project.
///
/// Results come back in the order asked for, so the payload index and the
/// layout stay deterministic; a repository that laid out differently run to
/// run would be unusable.
pub fn read_all(root: &Path, paths: &[String]) -> Vec<Option<(FileData, ScannedFile)>> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(16);
    if threads <= 1 || paths.len() < 8 {
        return paths.iter().map(|rel| read_file(root, rel)).collect();
    }

    // One contiguous slice per thread, written in place, so nothing has to be
    // merged or sorted afterwards.
    let mut out: Vec<Option<(FileData, ScannedFile)>> = (0..paths.len()).map(|_| None).collect();
    let chunk = paths.len().div_ceil(threads);

    std::thread::scope(|scope| {
        for (slot, work) in out.chunks_mut(chunk).zip(paths.chunks(chunk)) {
            scope.spawn(move || {
                for (dst, rel) in slot.iter_mut().zip(work) {
                    *dst = read_file(root, rel);
                }
            });
        }
    });
    out
}

/// List the files in `root` that should be laid out, in git's order.
///
/// Everything git does not ignore, and a plain walk when the folder is not a
/// repository. There is deliberately no second filter on top.
///
/// There used to be one, which classified generated files as artefacts and
/// drew them as placeholders: `linguist-generated` from `.gitattributes`, then
/// a heuristic over lock files, minified output, notebooks and large data
/// files. The measurement that motivated it still stands, a docs repository
/// measured 98 percent artefact by line count, but a heuristic that decides
/// for you is the wrong shape for that. The file type picker does the same job
/// per extension, visibly, and can be wrong without being a surprise.
pub fn list_files(root: &Path) -> Result<Vec<String>, ScanError> {
    if !root.is_dir() {
        return Err(ScanError::NotADirectory(root.to_path_buf()));
    }
    match git_listed_files(root) {
        Some(v) => Ok(v),
        None => walk(root),
    }
}

/// The files under one directory of the folder that belong in it, the way
/// `list_files` lists the whole of it, `""` being the whole of it.
///
/// For a watcher that has been told a directory changed without being told
/// what is in it: one that was moved or renamed, or everything, after events
/// were lost. Only what exists: git lists a tracked file whose directory has
/// just been moved away, and a file that is not there is not a change.
pub fn list_files_under(root: &Path, dir: &str) -> Vec<String> {
    let listed = if dir.is_empty() {
        list_files(root).unwrap_or_default()
    } else {
        let out = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"])
            .arg(dir)
            .output();
        match out {
            Ok(out) if out.status.success() => out
                .stdout
                .split(|&b| b == 0)
                .filter(|s| !s.is_empty())
                .map(|s| String::from_utf8_lossy(s).into_owned())
                .collect(),
            // Not a repository: the same walk the scan falls back to, from
            // the directory down, with paths made relative to the folder.
            _ => walk(&root.join(dir))
                .unwrap_or_default()
                .into_iter()
                .map(|p| format!("{dir}/{p}"))
                .collect(),
        }
    };
    listed.into_iter().filter(|p| root.join(p).is_file()).collect()
}

/// Feed a NUL separated path list to a git subcommand on stdin and return its
/// stdout.
///
/// The write has to happen on its own thread. git answers as it reads, so on a
/// repository of any size its stdout pipe fills up long before the last path
/// has been written, and writing and reading from the same thread deadlocks
/// both processes. That is exactly what it did on a 1508 file repo.
///
/// The exit status is deliberately not checked: `check-ignore` exits 1 when
/// nothing matched, which is a perfectly good answer.
fn git_over_stdin(root: &Path, args: &[&str], paths: &[String]) -> Option<Vec<u8>> {
    if paths.is_empty() {
        return None;
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let stdin = child.stdin.take();
    let mut buf = Vec::with_capacity(paths.iter().map(|p| p.len() + 1).sum());
    for p in paths {
        buf.extend_from_slice(p.as_bytes());
        buf.push(0);
    }
    let writer = std::thread::spawn(move || {
        if let Some(mut s) = stdin {
            use std::io::Write;
            // A broken pipe here just means git stopped early; the paths that
            // did get through are still answered.
            let _ = s.write_all(&buf);
            let _ = s.flush();
        }
        // Dropping the handle closes the pipe, which is what tells git to stop
        // waiting for more input.
    });

    let out = child.wait_with_output().ok();
    let _ = writer.join();
    out.map(|o| o.stdout)
}

/// Which of `paths` git considers ignored.
///
/// Used by the watcher for paths the scan never saw: a build writing into
/// `target/` produces thousands of events, and the only correct answer to
/// whether they matter is git's own. Tracked files are never reported as
/// ignored, which is what `check-ignore` does by default and what we want.
pub fn ignored_paths(root: &Path, paths: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(stdout) = git_over_stdin(root, &["check-ignore", "--stdin", "-z"], paths) else {
        return out;
    };
    for field in stdout.split(|&b| b == 0) {
        if field.is_empty() {
            continue;
        }
        out.insert(String::from_utf8_lossy(field).into_owned());
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    // The wiring, not the parser: a notebook on disk has to come back through
    // `read_file` measured as its cells. It used to be measured as JSON, which
    // put a file of 247 lines of code into a panel of nine thousand rows and
    // filled it with base64.
    #[test]
    fn a_notebook_is_read_as_its_cells() {
        let dir = std::env::temp_dir().join("sanity-notebook-scan-test");
        std::fs::create_dir_all(&dir).unwrap();
        let long = "A".repeat(4000);
        let doc = format!(
            r#"{{"cells": [
                 {{"cell_type": "markdown", "source": ["Heading of a cell\n"]}},
                 {{"cell_type": "code", "source": ["import numpy as np\n", "x = 1\n"],
                   "outputs": [{{"output_type": "display_data",
                                "data": {{"image/png": "{long}"}}}}]}}
               ], "metadata": {{"language_info": {{"file_extension": ".py"}}}}}}"#
        );
        std::fs::write(dir.join("nb.ipynb"), doc).unwrap();

        let (data, scanned) = read_file(&dir, "nb.ipynb").expect("reads");
        assert_eq!(scanned.line_count, 5, "heading, blank, two lines of code, one output");
        assert!(scanned.max_cols < 40, "no base64 line survived: {} columns", scanned.max_cols);
        assert!(data.validate().is_ok());
        // The output line is drawn, and in the colour a comment takes.
        let last = data.line_count() - 1;
        let s0 = data.span_start[last] as usize;
        let s1 = data.span_start[last + 1] as usize;
        assert_eq!(s1 - s0, 1);
        assert_eq!(crate::wire::span_kind(data.spans[s0]), Kind::Comment as u8);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_ignored_list_is_capped_and_says_how_many_there_were() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let (few, total) = git_ignored_files(root, 5);
        // This repository ignores its build output, so there is something to
        // find; if that ever stops being true the assertion says so.
        assert!(total > 5, "expected ignored files in the repository, got {total}");
        assert_eq!(few.len(), 5);
        assert!(few.iter().all(|p| !p.is_empty()));
        let (none, same) = git_ignored_files(root, 0);
        assert!(none.is_empty());
        assert_eq!(same, total);
    }

    #[test]
    fn git_reports_ignored_paths_and_leaves_tracked_ones() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        if !root.join(".git").exists() {
            return; // A source tarball rather than a checkout.
        }
        let probe = vec![
            "target/debug/whatever".to_string(),
            "crates/sanity-core/src/scan.rs".to_string(),
        ];
        let ignored = ignored_paths(root, &probe);
        assert!(ignored.contains("target/debug/whatever"), "target should be ignored");
        assert!(!ignored.contains("crates/sanity-core/src/scan.rs"), "source is not ignored");
    }

    #[test]
    fn an_empty_list_asks_git_nothing() {
        assert!(ignored_paths(Path::new(env!("CARGO_MANIFEST_DIR")), &[]).is_empty());
    }
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

    // What a watcher asks after a directory was moved outside git: the old
    // place lists nothing, though git still tracks it there, and the new one
    // lists what arrived.
    #[test]
    fn listing_under_a_moved_directory() {
        let dir = std::env::temp_dir().join(format!("sanity-under-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/sub")).unwrap();
        std::fs::write(dir.join("a/one.rs"), "x\n").unwrap();
        std::fs::write(dir.join("a/sub/two.rs"), "y\n").unwrap();
        std::fs::write(dir.join("keep.rs"), "z\n").unwrap();
        let git = |args: &[&str]| {
            Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap();
        };
        git(&["init", "-q"]);
        git(&["add", "-A"]);
        git(&["-c", "user.email=x@y", "-c", "user.name=x", "commit", "-qm", "init"]);
        std::fs::rename(dir.join("a"), dir.join("b")).unwrap();

        assert!(list_files_under(&dir, "a").is_empty());
        let mut moved = list_files_under(&dir, "b");
        moved.sort();
        assert_eq!(moved, vec!["b/one.rs", "b/sub/two.rs"]);
        let mut all = list_files_under(&dir, "");
        all.sort();
        assert_eq!(all, vec!["b/one.rs", "b/sub/two.rs", "keep.rs"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
