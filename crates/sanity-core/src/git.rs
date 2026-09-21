//! Change state from git, per line.
//!
//! Shells out to `git` rather than linking a library. That gets git's own
//! semantics for free, including submodules, worktrees, `core.excludesfile`
//! and whatever the user has configured, and it keeps the dependency count
//! where it is. The cost is process spawns, which is a few milliseconds per
//! repository and happens once per scan or once per batch of file events.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::wire::LineState;

/// What a file's working tree looks like against the index and HEAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FileStatus {
    #[default]
    Unmodified,
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflicted,
}

/// Per-line change state for one file, indexed by line number from zero.
#[derive(Debug, Default, Clone)]
pub struct FileChanges {
    pub status: FileStatus,
    /// One entry per line of the working-tree file, as `LineState as u8`.
    pub lines: Vec<u8>,
}

/// What to compare the working tree against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Baseline {
    /// Uncommitted work: the working tree against HEAD. Answers "what am I
    /// doing right now".
    Head,
    /// The whole branch: the working tree against its merge base with `main`
    /// or `master`. Answers "what has this branch changed".
    MergeBase,
}

fn run(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// True when `root` is inside a git work tree.
pub fn is_repo(root: &Path) -> bool {
    run(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// The revision to diff against, or None when there is no history yet.
fn baseline_rev(root: &Path, baseline: Baseline) -> Option<String> {
    match baseline {
        Baseline::Head => {
            // A repository with no commits has no HEAD to diff against.
            run(root, &["rev-parse", "--verify", "HEAD"]).map(|s| s.trim().to_string())
        }
        Baseline::MergeBase => {
            for base in ["main", "master"] {
                if let Some(s) = run(root, &["merge-base", "HEAD", base]) {
                    let rev = s.trim().to_string();
                    if !rev.is_empty() {
                        return Some(rev);
                    }
                }
            }
            // No main or master: fall back to HEAD, which at least answers
            // something rather than nothing.
            run(root, &["rev-parse", "--verify", "HEAD"]).map(|s| s.trim().to_string())
        }
    }
}

/// Parse `git status --porcelain=v2 -z` into a status per path.
///
/// Porcelain v2 because v1 cannot be parsed unambiguously: it does not say how
/// many fields a line has, and paths with spaces or renames make the columns
/// slide. NUL separation for the same reason.
pub fn statuses(root: &Path) -> HashMap<String, FileStatus> {
    let mut out = HashMap::new();
    let Some(text) = run(root, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])
    else {
        return out;
    };

    let mut fields = text.split('\0').peekable();
    while let Some(entry) = fields.next() {
        if entry.is_empty() {
            continue;
        }
        let mut parts = entry.splitn(2, ' ');
        let kind = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match kind {
            // Ordinary change: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
            "1" => {
                let mut it = rest.split(' ');
                let xy = it.next().unwrap_or("");
                // Six more fields after XY, then the path, which may itself
                // contain spaces and so is rejoined rather than taken.
                let path = it.clone().skip(6).collect::<Vec<_>>().join(" ");
                if !path.is_empty() {
                    out.insert(path, status_from_xy(xy));
                }
            }
            // Rename or copy: the same, plus a score, and the original path is
            // the next NUL-separated field.
            "2" => {
                let mut it = rest.split(' ');
                let _xy = it.next().unwrap_or("");
                // Six fields, then the rename score, then the path.
                let path = it.clone().skip(7).collect::<Vec<_>>().join(" ");
                if !path.is_empty() {
                    out.insert(path, FileStatus::Renamed);
                }
                // Consume the original path so it is not read as an entry.
                fields.next();
            }
            // Unmerged: `u <XY> ...`
            "u" => {
                let path = rest.split(' ').skip(9).collect::<Vec<_>>().join(" ");
                if !path.is_empty() {
                    out.insert(path, FileStatus::Conflicted);
                }
            }
            // Untracked and ignored are just `? <path>` and `! <path>`.
            "?" => {
                if !rest.is_empty() {
                    out.insert(rest.to_string(), FileStatus::Untracked);
                }
            }
            "!" => {
                if !rest.is_empty() {
                    out.insert(rest.to_string(), FileStatus::Ignored);
                }
            }
            _ => {}
        }
    }
    out
}

fn status_from_xy(xy: &str) -> FileStatus {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let tree = chars.next().unwrap_or('.');
    // The working tree is what is on screen, so it wins when the two differ.
    for c in [tree, index] {
        match c {
            'A' => return FileStatus::Added,
            'D' => return FileStatus::Deleted,
            'M' | 'T' => return FileStatus::Modified,
            'R' => return FileStatus::Renamed,
            _ => {}
        }
    }
    FileStatus::Unmodified
}

/// Per-line change state for every changed file, from one diff invocation.
///
/// `-U0` asks for no context, so every hunk header describes exactly the
/// changed lines. `--no-color`, `--no-ext-diff` and `--no-textconv` keep a
/// user's configuration from rewriting the output into something unparseable,
/// which is the usual way shelling out to git goes wrong.
pub fn line_changes(
    root: &Path,
    baseline: Baseline,
    line_counts: &HashMap<String, u32>,
) -> HashMap<String, FileChanges> {
    let mut out: HashMap<String, FileChanges> = HashMap::new();
    let status = statuses(root);

    // Untracked files are entirely new; git diff will not mention them.
    for (path, st) in &status {
        if *st == FileStatus::Untracked {
            let n = line_counts.get(path).copied().unwrap_or(0) as usize;
            out.insert(
                path.clone(),
                FileChanges { status: *st, lines: vec![LineState::Added as u8; n] },
            );
        }
    }

    let Some(rev) = baseline_rev(root, baseline) else {
        // No history: every tracked file is as new as the untracked ones.
        return out;
    };

    let Some(diff) = run(
        root,
        &[
            // Without this, git C-quotes any path with a non-ASCII byte, and
            // umlauts in a path are not exotic.
            "-c",
            "core.quotepath=false",
            "diff",
            "-U0",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            &rev,
        ],
    ) else {
        return out;
    };

    let mut current: Option<String> = None;
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("+++ b/") {
            current = diff_path(rest);
            continue;
        }
        if line.starts_with("+++ /dev/null") {
            // The file was deleted; it is not on screen, so nothing to mark.
            current = None;
            continue;
        }
        if !line.starts_with("@@") {
            continue;
        }
        let Some(path) = current.clone() else { continue };
        let Some(hunk) = parse_hunk(line) else { continue };

        let n = line_counts.get(&path).copied().unwrap_or(0) as usize;
        let entry = out.entry(path.clone()).or_insert_with(|| FileChanges {
            status: status.get(&path).copied().unwrap_or(FileStatus::Modified),
            lines: vec![LineState::Unchanged as u8; n],
        });
        if entry.lines.len() < n {
            entry.lines.resize(n, LineState::Unchanged as u8);
        }

        if hunk.new_count == 0 {
            // A pure deletion has no line of its own. `@@ -4,2 +3,0 @@` means
            // the lines were removed *after* new line 3, so the line that now
            // sits at the seam is new line 4, which is index 3 zero-based.
            //
            // A deletion at the end of the file has no line below it at all.
            // The wire format has no row past the last one, so the marker goes
            // on the last line; at the zoom where a row is a couple of pixels
            // the two seams are indistinguishable, and losing the change
            // entirely would be worse. Issue #9 covers a proper gap.
            let at = (hunk.new_start as usize).min(entry.lines.len().saturating_sub(1));
            if at < entry.lines.len() {
                entry.lines[at] = LineState::DeletedBelow as u8;
            }
            continue;
        }

        // A hunk that both removes and adds is a modification; one that only
        // adds is an addition.
        let state = if hunk.old_count > 0 { LineState::Modified } else { LineState::Added };
        let from = hunk.new_start.saturating_sub(1) as usize;
        for i in from..(from + hunk.new_count as usize).min(entry.lines.len()) {
            entry.lines[i] = state as u8;
        }
    }

    out
}

/// The path out of a `+++ b/...` line.
///
/// git appends a tab after the name when the name contains a space, so that
/// the end of the path is unambiguous. It is not documented as a trailing
/// tab, it is documented as a field separator, and reading it as part of the
/// filename is why `a dir/a file.txt` was never found in the diff.
///
/// A path that still arrives quoted (a real tab or quote in the name) is left
/// alone rather than half-decoded: no match is better than a wrong match.
fn diff_path(rest: &str) -> Option<String> {
    if rest.starts_with('"') {
        return None;
    }
    let path = match rest.find('\t') {
        Some(i) => &rest[..i],
        None => rest,
    };
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Hunk {
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
}

/// Parse `@@ -a,b +c,d @@`. The counts default to 1 when omitted, which is
/// what the unified diff format says and the single most common shape.
fn parse_hunk(line: &str) -> Option<Hunk> {
    let body = line.strip_prefix("@@ ")?;
    let end = body.find(" @@")?;
    let mut parts = body[..end].split(' ');
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;

    let pair = |s: &str| -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let (old_start, old_count) = pair(old)?;
    let (new_start, new_count) = pair(new)?;
    Some(Hunk { old_start, old_count, new_start, new_count })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn hunk_headers_parse() {
        assert_eq!(
            parse_hunk("@@ -12,3 +12,4 @@ fn thing() {"),
            Some(Hunk { old_start: 12, old_count: 3, new_start: 12, new_count: 4 })
        );
        // Counts default to one when the comma is omitted.
        assert_eq!(
            parse_hunk("@@ -5 +5 @@"),
            Some(Hunk { old_start: 5, old_count: 1, new_start: 5, new_count: 1 })
        );
        // A pure addition has an old count of zero.
        assert_eq!(
            parse_hunk("@@ -0,0 +1,10 @@"),
            Some(Hunk { old_start: 0, old_count: 0, new_start: 1, new_count: 10 })
        );
        // A pure deletion has a new count of zero.
        assert_eq!(
            parse_hunk("@@ -7,4 +6,0 @@"),
            Some(Hunk { old_start: 7, old_count: 4, new_start: 6, new_count: 0 })
        );
        assert_eq!(parse_hunk("not a hunk"), None);
        assert_eq!(parse_hunk("@@ garbage @@"), None);
    }

    #[test]
    fn diff_paths_stop_at_the_separator_tab() {
        assert_eq!(diff_path("src/main.rs").as_deref(), Some("src/main.rs"));
        // A name with a space gets a tab appended by git.
        assert_eq!(diff_path("a dir/a file.txt\t").as_deref(), Some("a dir/a file.txt"));
        // A quoted name is not decoded here.
        assert_eq!(diff_path("\"odd\\tname\""), None);
        assert_eq!(diff_path(""), None);
    }

    #[test]
    fn xy_codes_map_to_a_status() {
        // Index column, then working tree; the working tree wins.
        assert_eq!(status_from_xy(".M"), FileStatus::Modified);
        assert_eq!(status_from_xy("M."), FileStatus::Modified);
        assert_eq!(status_from_xy("A."), FileStatus::Added);
        assert_eq!(status_from_xy(".D"), FileStatus::Deleted);
        assert_eq!(status_from_xy("R."), FileStatus::Renamed);
        assert_eq!(status_from_xy(".."), FileStatus::Unmodified);
    }

/// A throwaway repository with known edits. The parsing is only as good as
    /// the shapes it has seen, and the shapes that break it (a hunk at line
    /// zero, a deletion with no line of its own, a rename, a path with a
    /// space) do not reliably occur in whatever repository the tests run in.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("sanity-git-{name}-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(&dir).unwrap();
            let s = Scratch(dir);
            s.git(&["init", "-q", "-b", "main"]);
            s
        }

        fn git(&self, args: &[&str]) {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                // Committing needs an identity and must not reach for the
                // user's signing key on a machine that has one configured.
                .args(["-c", "user.email=t@example.com", "-c", "user.name=t"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        fn counts(&self, files: &[(&str, u32)]) -> HashMap<String, u32> {
            files.iter().map(|(p, n)| (p.to_string(), *n)).collect()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn lines(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn a_modification_marks_only_the_changed_lines() {
        let s = Scratch::new("mod");
        s.write("a.txt", &lines(10));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "base"]);

        // Change line 3 in place; nothing else moves.
        let mut text: Vec<String> = lines(10).lines().map(str::to_string).collect();
        text[2] = "line three, edited".into();
        s.write("a.txt", &format!("{}\n", text.join("\n")));

        let c = line_changes(&s.0, Baseline::Head, &s.counts(&[("a.txt", 10)]));
        let f = c.get("a.txt").expect("a.txt should be reported");
        assert_eq!(f.status, FileStatus::Modified);
        assert_eq!(f.lines.len(), 10);
        let mut want = vec![LineState::Unchanged as u8; 10];
        want[2] = LineState::Modified as u8;
        assert_eq!(f.lines, want);
    }

    #[test]
    fn appended_lines_are_additions_not_modifications() {
        let s = Scratch::new("add");
        s.write("a.txt", &lines(5));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "base"]);

        s.write("a.txt", &format!("{}{}", lines(5), "six\nseven\n"));

        let c = line_changes(&s.0, Baseline::Head, &s.counts(&[("a.txt", 7)]));
        let f = c.get("a.txt").unwrap();
        // The hunk is `@@ -5,0 +6,2 @@`: an old count of zero, so an addition.
        assert_eq!(
            f.lines,
            vec![0, 0, 0, 0, 0, LineState::Added as u8, LineState::Added as u8]
        );
    }

    #[test]
    fn a_deletion_marks_the_line_that_took_its_place() {
        let s = Scratch::new("del");
        s.write("a.txt", &lines(10));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "base"]);

        // Remove lines 4 and 5. Eight lines remain, and the deletion itself
        // has no line to mark, so the line that now sits at the seam carries
        // the marker.
        let kept: Vec<String> =
            lines(10).lines().enumerate().filter(|(i, _)| *i != 3 && *i != 4)
                .map(|(_, l)| l.to_string()).collect();
        s.write("a.txt", &format!("{}\n", kept.join("\n")));

        let c = line_changes(&s.0, Baseline::Head, &s.counts(&[("a.txt", 8)]));
        let f = c.get("a.txt").unwrap();
        assert_eq!(f.lines.len(), 8);
        let marked: Vec<usize> =
            f.lines.iter().enumerate().filter(|(_, &s)| s != 0).map(|(i, _)| i).collect();
        assert_eq!(marked.len(), 1, "one seam, not a range: {:?}", f.lines);
        assert_eq!(f.lines[marked[0]], LineState::DeletedBelow as u8);
        // The seam is where the removed lines were: index 3 of the new file.
        assert_eq!(marked[0], 3);
    }

    #[test]
    fn an_untracked_file_is_entirely_new() {
        let s = Scratch::new("untracked");
        s.write("a.txt", &lines(3));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "base"]);
        s.write("fresh.txt", &lines(4));

        let c = line_changes(
            &s.0,
            Baseline::Head,
            &s.counts(&[("a.txt", 3), ("fresh.txt", 4)]),
        );
        let f = c.get("fresh.txt").expect("untracked files have to be reported");
        assert_eq!(f.status, FileStatus::Untracked);
        assert_eq!(f.lines, vec![LineState::Added as u8; 4]);
        // The untouched file is either absent or entirely unchanged.
        assert!(c.get("a.txt").map(|f| f.lines.iter().all(|&s| s == 0)).unwrap_or(true));
    }

    #[test]
    fn paths_with_spaces_survive_status_parsing() {
        let s = Scratch::new("spaces");
        s.write("a dir/a file.txt", &lines(2));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "base"]);
        s.write("a dir/a file.txt", &lines(4));

        let st = statuses(&s.0);
        assert_eq!(st.get("a dir/a file.txt"), Some(&FileStatus::Modified));

        let c = line_changes(&s.0, Baseline::Head, &s.counts(&[("a dir/a file.txt", 4)]));
        let f = c.get("a dir/a file.txt").expect("the path must not be split on its space");
        assert_eq!(f.lines, vec![0, 0, LineState::Added as u8, LineState::Added as u8]);
    }

    #[test]
    fn a_rename_is_reported_as_a_rename_and_not_as_two_entries() {
        let s = Scratch::new("rename");
        s.write("old.txt", &lines(20));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "base"]);
        s.git(&["mv", "old.txt", "new.txt"]);

        let st = statuses(&s.0);
        assert_eq!(st.get("new.txt"), Some(&FileStatus::Renamed));
        // The original path is consumed as part of the rename entry, so it
        // must not appear as an entry of its own.
        assert!(!st.contains_key("old.txt"), "old path leaked as an entry: {st:?}");
    }

    #[test]
    fn a_repository_without_commits_reports_everything_as_new() {
        let s = Scratch::new("empty");
        s.write("a.txt", &lines(3));

        let c = line_changes(&s.0, Baseline::Head, &s.counts(&[("a.txt", 3)]));
        let f = c.get("a.txt").expect("an untracked file in a fresh repo is still new");
        assert_eq!(f.lines, vec![LineState::Added as u8; 3]);
    }

    #[test]
    fn the_branch_baseline_ignores_what_main_already_had() {
        let s = Scratch::new("branch");
        s.write("a.txt", &lines(10));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "base"]);
        s.git(&["checkout", "-qb", "feature"]);

        // Committed on the branch: invisible against HEAD, visible against the
        // merge base. That difference is the whole point of the two baselines.
        s.write("a.txt", &format!("{}{}", lines(10), "eleven\n"));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "on the branch"]);

        let counts = s.counts(&[("a.txt", 11)]);
        let head = line_changes(&s.0, Baseline::Head, &counts);
        assert!(
            head.get("a.txt").map(|f| f.lines.iter().all(|&s| s == 0)).unwrap_or(true),
            "a committed change is not uncommitted work"
        );

        let branch = line_changes(&s.0, Baseline::MergeBase, &counts);
        let f = branch.get("a.txt").expect("the branch changed this file");
        assert_eq!(f.lines[10], LineState::Added as u8);
        assert!(f.lines[..10].iter().all(|&s| s == 0));
    }

    #[test]
    fn a_file_shorter_than_its_diff_claims_is_clamped() {
        // The read and the diff are two moments; a file written between them
        // would otherwise produce a per-line array longer than the panel.
        let s = Scratch::new("clamp");
        s.write("a.txt", &lines(10));
        s.git(&["add", "-A"]);
        s.git(&["commit", "-qm", "base"]);
        s.write("a.txt", &lines(30));

        // Claim the file is still ten lines long.
        let c = line_changes(&s.0, Baseline::Head, &s.counts(&[("a.txt", 10)]));
        let f = c.get("a.txt").unwrap();
        assert_eq!(f.lines.len(), 10, "the array has to match the claimed length");
    }

    #[test]
    fn this_repository_reports_a_status() {
        // An integration check against the repo the tests run in: it has to be
        // a work tree, and status has to parse into something.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        if !is_repo(root) {
            return; // A source tarball rather than a checkout.
        }
        let st = statuses(root);
        // Every reported path has to be relative and non-empty.
        for path in st.keys() {
            assert!(!path.is_empty());
            assert!(!path.starts_with('/'), "{path} is absolute");
        }
    }
}
