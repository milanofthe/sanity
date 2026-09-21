//! Substring search over the text of a repository.
//!
//! Here rather than in the frontend because the text is not in the frontend:
//! panels are drawn from spans and line widths, and a file's characters are
//! read on demand for the one panel being looked at. Shipping every byte to
//! the webview so it could search them would cost more memory than the whole
//! renderer uses.
//!
//! Case insensitive, ASCII only for the folding. A query with non-ASCII
//! characters still matches, it just matches exactly: lowering `İ` correctly
//! needs a table, the files this is pointed at are source code, and a wrong
//! fold is worse than none.

use std::collections::HashSet;
use std::path::Path;

use crate::scan;

/// One hit: the line it is on, counting from zero, and the column it starts
/// at, in characters rather than bytes so it lines up with what is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hit {
    pub line: u32,
    pub col: u32,
}

/// Hits in one file, in reading order.
#[derive(Debug, Clone)]
pub struct FileHits {
    pub path: String,
    pub hits: Vec<Hit>,
    /// Hits this file has beyond the ones listed, when the cap cut it short.
    pub more: u32,
}

/// Every hit for `needle` in `text`, up to `cap` of them.
///
/// The needle has to arrive already lowercased; doing it per file would lower
/// the same few characters a thousand times.
pub fn find_in_text(text: &str, needle_lower: &str, cap: usize) -> (Vec<Hit>, u32) {
    let mut out = Vec::new();
    let mut more = 0u32;
    if needle_lower.is_empty() {
        return (out, 0);
    }
    let n = needle_lower.as_bytes();

    for (line_no, line) in text.lines().enumerate() {
        let bytes = line.as_bytes();
        if bytes.len() < n.len() {
            continue;
        }
        let mut at = 0usize;
        while at + n.len() <= bytes.len() {
            if eq_folded(&bytes[at..at + n.len()], n) {
                if out.len() < cap {
                    // Byte offset to character column, which is what a panel
                    // draws. Equal for ASCII, which is nearly every line, and
                    // a short count for the rest.
                    let col = line[..at].chars().count() as u32;
                    out.push(Hit { line: line_no as u32, col });
                } else {
                    more += 1;
                }
                // Overlapping hits are not reported: "aa" in "aaa" is one hit
                // and a second one starting after it, which is what a reader
                // means by two occurrences.
                at += n.len();
            } else {
                at += 1;
            }
        }
    }
    (out, more)
}

/// ASCII case-insensitive comparison, without allocating.
fn eq_folded(a: &[u8], b_lower: &[u8]) -> bool {
    a.iter()
        .zip(b_lower)
        .all(|(x, y)| x.to_ascii_lowercase() == *y)
}

/// Search every path under `root`, in parallel, best effort.
///
/// Paths that cannot be read are skipped rather than reported: a file deleted
/// between the scan and the query is not an error a search should raise.
pub fn find_in_files(
    root: &Path,
    paths: &[String],
    query: &str,
    cap_per_file: usize,
) -> Vec<FileHits> {
    let needle = query.to_ascii_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(16);

    let mut out: Vec<Option<FileHits>> = (0..paths.len()).map(|_| None).collect();
    let chunk = paths.len().div_ceil(threads.max(1)).max(1);
    std::thread::scope(|scope| {
        for (slot, work) in out.chunks_mut(chunk).zip(paths.chunks(chunk)) {
            let needle = needle.as_str();
            scope.spawn(move || {
                for (dst, rel) in slot.iter_mut().zip(work) {
                    let Ok(bytes) = std::fs::read(root.join(rel)) else { continue };
                    // Binary files are skipped by the same rule the scan uses,
                    // so what can be searched is what can be shown.
                    if scan::looks_binary(&bytes) {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&bytes);
                    let (hits, more) = find_in_text(&text, needle, cap_per_file);
                    if hits.is_empty() {
                        continue;
                    }
                    *dst = Some(FileHits { path: rel.clone(), hits, more });
                }
            });
        }
    });
    out.into_iter().flatten().collect()
}

/// The subset of `paths` that is not ignored, for callers that hold a stale
/// list. Kept here so a search never reports a file the canvas does not draw.
pub fn drop_ignored(root: &Path, paths: Vec<String>) -> Vec<String> {
    let ignored: HashSet<String> = scan::ignored_paths(root, &paths);
    paths.into_iter().filter(|p| !ignored.contains(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_every_occurrence_with_its_line_and_column() {
        let text = "let x = 1;\nlet y = x + x;\n";
        let (hits, more) = find_in_text(text, "x", 10);
        assert_eq!(more, 0);
        // Line 1 is "let y = x + x;", so its x's are at 8 and 12; column 4
        // is the y.
        assert_eq!(
            hits,
            vec![
                Hit { line: 0, col: 4 },
                Hit { line: 1, col: 8 },
                Hit { line: 1, col: 12 },
            ]
        );
    }

    #[test]
    fn ignores_case_on_both_sides() {
        let (hits, _) = find_in_text("Foo FOO foo", "foo", 10);
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn an_empty_query_finds_nothing() {
        let (hits, more) = find_in_text("anything", "", 10);
        assert!(hits.is_empty());
        assert_eq!(more, 0);
    }

    #[test]
    fn a_hit_does_not_overlap_the_one_before_it() {
        // Three a's hold one "aa" and then nothing that starts after it.
        let (hits, _) = find_in_text("aaa", "aa", 10);
        assert_eq!(hits, vec![Hit { line: 0, col: 0 }]);
        let (four, _) = find_in_text("aaaa", "aa", 10);
        assert_eq!(four, vec![Hit { line: 0, col: 0 }, Hit { line: 0, col: 2 }]);
    }

    #[test]
    fn columns_are_characters_not_bytes() {
        // Four two-byte characters, then the needle.
        let (hits, _) = find_in_text("übüb x", "x", 10);
        assert_eq!(hits, vec![Hit { line: 0, col: 5 }]);
    }

    #[test]
    fn the_cap_counts_what_it_leaves_out() {
        let text = "x x x x x";
        let (hits, more) = find_in_text(text, "x", 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(more, 3);
    }

    #[test]
    fn a_line_shorter_than_the_query_is_skipped() {
        let (hits, _) = find_in_text("a\nab\nabc\n", "abc", 10);
        assert_eq!(hits, vec![Hit { line: 2, col: 0 }]);
    }

    #[test]
    fn a_needle_with_no_hit_reports_none() {
        let (hits, more) = find_in_text("the quick brown fox", "zebra", 10);
        assert!(hits.is_empty());
        assert_eq!(more, 0);
    }
}
