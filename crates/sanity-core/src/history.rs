//! A repository's history as a source of changes.
//!
//! A step from one state of the folder to another comes out as what the
//! watcher reports for a save: the paths whose contents differ, with where the
//! new contents are, and the paths that are gone. So the canvas plays a walk
//! through the history with the same cues it plays a save with, and walking
//! backwards is only a step the other way: the diff reverses, and with it
//! which lines go and which come.
//!
//! Nothing here touches the working tree. The contents of a commit come out of
//! the object store.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

/// One commit, as the ticker shows it.
#[derive(Debug, Clone)]
pub struct Commit {
    pub sha: String,
    /// Committer time, seconds since the epoch.
    pub time: i64,
    pub author: String,
    pub subject: String,
}

/// One end of a step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Side {
    Commit(String),
    /// The working tree as it is on disk, which is what the canvas shows
    /// when it is not in the history.
    Live,
}

/// Where the new contents of a changed path are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Blob(String),
    Disk,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Step {
    pub changed: Vec<(String, Source)>,
    pub removed: Vec<String>,
}

fn git(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    out.status.success().then_some(out.stdout)
}

/// Commits along the first parent, newest first, `limit` of them from `skip`.
///
/// First parent only: a merge is one step, the work it brings in seen as it
/// landed rather than replayed commit by commit from a branch that ran
/// alongside. Empty when the folder is not a repository or has no commits.
pub fn commits(root: &Path, skip: usize, limit: usize) -> Vec<Commit> {
    let skip = format!("--skip={skip}");
    let limit = format!("--max-count={limit}");
    let Some(out) = git(
        root,
        &["log", "--first-parent", "-z", "--format=%H%x1f%ct%x1f%an%x1f%s", &skip, &limit],
    ) else {
        return Vec::new();
    };
    out.split(|&b| b == 0)
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let r = String::from_utf8_lossy(r);
            let mut f = r.split('\u{1f}');
            Some(Commit {
                sha: f.next()?.trim().to_string(),
                time: f.next()?.parse().ok()?,
                author: f.next()?.to_string(),
                subject: f.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// `git diff --raw -z` read into (status, new blob, path).
fn raw_diff(out: &[u8]) -> Vec<(u8, String, String)> {
    let mut fields = out.split(|&b| b == 0);
    let mut rows = Vec::new();
    while let Some(meta) = fields.next() {
        if meta.is_empty() {
            continue;
        }
        let Some(path) = fields.next() else { break };
        // ":<old mode> <new mode> <old sha> <new sha> <status>"
        let meta = String::from_utf8_lossy(meta);
        let parts: Vec<&str> = meta.trim_start_matches(':').split(' ').collect();
        if parts.len() < 5 {
            continue;
        }
        let status = parts[4].as_bytes().first().copied().unwrap_or(b'M');
        rows.push((status, parts[3].to_string(), String::from_utf8_lossy(path).into_owned()));
    }
    rows
}

/// Files in the working tree git does not track and does not ignore.
fn untracked(root: &Path) -> Vec<String> {
    git(root, &["ls-files", "-z", "--others", "--exclude-standard"])
        .map(|out| {
            out.split(|&b| b == 0)
                .filter(|s| !s.is_empty())
                .map(|s| String::from_utf8_lossy(s).into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// What changes going from `from` to `to`, or None when git cannot say.
///
/// Always a diff between the two ends, however many commits lie between
/// them: dragging across a hundred commits is one step, not a hundred.
pub fn step(root: &Path, from: &Side, to: &Side) -> Option<Step> {
    let mut s = Step::default();
    let rows = match (from, to) {
        (Side::Live, Side::Live) => return Some(s),
        (Side::Commit(a), Side::Commit(b)) => {
            raw_diff(&git(root, &["diff", "--raw", "-z", "--no-renames", "--no-abbrev", a, b])?)
        }
        // Reversed, so the commit is the new side for both directions of a
        // step involving the working tree.
        (Side::Live, Side::Commit(c)) => {
            raw_diff(&git(root, &["diff", "-R", "--raw", "-z", "--no-renames", "--no-abbrev", c])?)
        }
        (Side::Commit(c), Side::Live) => {
            raw_diff(&git(root, &["diff", "--raw", "-z", "--no-renames", "--no-abbrev", c])?)
        }
    };
    let to_disk = *to == Side::Live;
    for (status, blob, path) in rows {
        if status == b'D' {
            s.removed.push(path);
        } else if to_disk {
            s.changed.push((path, Source::Disk));
        } else {
            s.changed.push((path, Source::Blob(blob)));
        }
    }
    // Files that only the working tree has: gone going into the history,
    // back coming out of it.
    match (from, to) {
        (Side::Live, Side::Commit(_)) => s.removed.extend(untracked(root)),
        (Side::Commit(_), Side::Live) => {
            s.changed.extend(untracked(root).into_iter().map(|p| (p, Source::Disk)));
        }
        _ => {}
    }
    s.changed.sort_by(|a, b| a.0.cmp(&b.0));
    s.removed.sort();
    Some(s)
}

/// The contents of blobs, by id, in one `git cat-file --batch`.
pub fn blobs(root: &Path, ids: &[String]) -> HashMap<String, Vec<u8>> {
    use std::io::{Read, Write};
    let mut out = HashMap::new();
    if ids.is_empty() {
        return out;
    }
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["cat-file", "--batch"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return out;
    };
    // Written from a thread of its own, for the reason `git_over_stdin` gives:
    // git answers as it reads, and its pipe fills long before the last id.
    let mut stdin = child.stdin.take();
    let request: Vec<u8> = ids.iter().flat_map(|id| format!("{id}\n").into_bytes()).collect();
    let writer = std::thread::spawn(move || {
        if let Some(s) = stdin.as_mut() {
            let _ = s.write_all(&request);
        }
    });
    let mut all = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_end(&mut all);
    }
    let _ = writer.join();
    let _ = child.wait();

    // "<sha> <type> <size>\n<contents>\n", or "<id> missing\n".
    let mut at = 0usize;
    while at < all.len() {
        let Some(nl) = all[at..].iter().position(|&b| b == b'\n') else { break };
        let header = String::from_utf8_lossy(&all[at..at + nl]).into_owned();
        at += nl + 1;
        let parts: Vec<&str> = header.split(' ').collect();
        if parts.len() != 3 {
            continue;
        }
        let Ok(size) = parts[2].parse::<usize>() else { continue };
        if at + size > all.len() {
            break;
        }
        out.insert(parts[0].to_string(), all[at..at + size].to_vec());
        at += size + 1;
    }
    out
}

/// A file's contents at a commit, or None when it is not there.
pub fn file_at(root: &Path, sha: &str, path: &str) -> Option<Vec<u8>> {
    git(root, &["cat-file", "blob", &format!("{sha}:{path}")])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository with three commits and a working tree that differs from
    /// the last of them.
    fn repo(name: &str) -> std::path::PathBuf {
        // One per test: they run in parallel.
        let dir = std::env::temp_dir().join(format!("sanity-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let ok = Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap().status.success();
            assert!(ok, "git {args:?}");
        };
        let commit = |msg: &str| {
            run(&["add", "-A"]);
            run(&["-c", "user.email=x@y", "-c", "user.name=Ada", "commit", "-qm", msg]);
        };
        run(&["init", "-q"]);
        std::fs::write(dir.join("a.rs"), "fn a() {}\n").unwrap();
        commit("first");
        std::fs::write(dir.join("a.rs"), "fn a() { 1 }\n").unwrap();
        std::fs::write(dir.join("b.rs"), "fn b() {}\n").unwrap();
        commit("second");
        std::fs::remove_file(dir.join("a.rs")).unwrap();
        commit("third");
        // Not committed: an edit and a new file.
        std::fs::write(dir.join("b.rs"), "fn b() { 2 }\n").unwrap();
        std::fs::write(dir.join("new.rs"), "fn n() {}\n").unwrap();
        dir
    }

    #[test]
    fn walking_the_history_forwards_and_back() {
        let dir = repo("walk");
        let log = commits(&dir, 0, 10);
        assert_eq!(log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["third", "second", "first"]);
        assert_eq!(log[0].author, "Ada");
        let [third, second, first] = [&log[0].sha, &log[1].sha, &log[2].sha].map(|s| Side::Commit(s.clone()));

        // Forwards over two commits in one step.
        let s = step(&dir, &first, &third).unwrap();
        assert_eq!(s.removed, ["a.rs"]);
        assert_eq!(s.changed.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["b.rs"]);

        // Backwards is the same step reversed: a.rs comes back, b.rs goes.
        let s = step(&dir, &third, &second).unwrap();
        assert_eq!(s.removed, Vec::<String>::new());
        assert_eq!(s.changed.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["a.rs"]);
        let s = step(&dir, &second, &first).unwrap();
        assert_eq!(s.removed, ["b.rs"]);

        // The contents of a changed file come out of the object store.
        let Source::Blob(id) = &step(&dir, &third, &second).unwrap().changed[0].1 else { panic!() };
        let got = blobs(&dir, std::slice::from_ref(id));
        assert_eq!(got[id], b"fn a() { 1 }\n");
        let Side::Commit(sha) = &second else { panic!() };
        assert_eq!(file_at(&dir, sha, "a.rs").unwrap(), b"fn a() { 1 }\n");
        assert_eq!(file_at(&dir, sha, "nope.rs"), None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stepping_between_the_working_tree_and_a_commit() {
        let dir = repo("live");
        let log = commits(&dir, 0, 10);
        let third = Side::Commit(log[0].sha.clone());

        // Into the history: the edit is undone from the commit's blob, and
        // the file only the working tree has goes.
        let into = step(&dir, &Side::Live, &third).unwrap();
        assert_eq!(into.removed, ["new.rs"]);
        assert!(matches!(&into.changed[..], [(p, Source::Blob(_))] if p == "b.rs"));

        // Out of it: both come back from the disk.
        let out = step(&dir, &third, &Side::Live).unwrap();
        assert_eq!(out.removed, Vec::<String>::new());
        assert_eq!(
            out.changed,
            vec![("b.rs".to_string(), Source::Disk), ("new.rs".to_string(), Source::Disk)],
        );
        assert_eq!(step(&dir, &Side::Live, &Side::Live), Some(Step::default()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_without_git_has_no_history() {
        let dir = std::env::temp_dir().join(format!("sanity-nohistory-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(commits(&dir, 0, 10).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
