//! File watching, debounced into batches.
//!
//! The renderer can rewrite one texture layer per file cheaply, so the job here
//! is to say *which* files moved and nothing more. Two things make that less
//! trivial than forwarding events:
//!
//! 1. A single save produces several events on macOS, and a `git checkout`
//!    produces thousands. Both have to arrive as one batch, or the frontend
//!    re-decodes the same file five times and a branch switch stutters.
//! 2. Everything under `.git` is noise here. Changes are shown per save, from a
//!    diff of the two versions of the file, so a commit or a checkout matters
//!    only through the files it rewrites, and those arrive as ordinary write
//!    events like any other.
//!
//! Two things the events do not say have to be asked for instead, and a batch
//! carries them as directories to reconcile against what the host holds:
//!
//! - A directory that is renamed or moved is reported as the directory alone.
//!   Checked on FSEvents with notify 8: `mv a b` gives events for `a` and `b`
//!   and none for the files inside either, so a watcher that only forwards
//!   file paths leaves the old panels standing and never shows the new ones.
//! - When the kernel drops events under load it says so, as a rescan flag,
//!   and after that nothing about the folder can be trusted until it has been
//!   listed again.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecursiveMode, Watcher as _};
use serde::Serialize;

/// How long the batch waits for silence before it is emitted. Long enough that
/// the three events of one save coalesce, short enough that a save feels
/// immediate.
const QUIET: Duration = Duration::from_millis(120);

/// A batch is emitted at the latest this long after its first event, however
/// much is still arriving. A `git checkout` of a large branch produces events
/// for several seconds, and holding the screen stale for all of it is worse
/// than sending two batches.
const MAX_HOLD: Duration = Duration::from_millis(600);

/// What the frontend is told.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Batch {
    /// Files that exist and should be re-read, repository-relative.
    pub changed: Vec<String>,
    /// Paths that are gone, repository-relative. A file, or a directory that
    /// took files with it; see `reconcile`.
    pub removed: Vec<String>,
    /// Directories whose contents the events do not describe, to be listed
    /// and compared with what is held: one that appeared or was renamed, or
    /// the whole folder, as `""`, after a rescan. For the host, not the
    /// frontend, which only ever sees files.
    #[serde(skip)]
    pub dirs: Vec<String>,
}

impl Batch {
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.removed.is_empty() && self.dirs.is_empty()
    }
}

/// Accumulates paths until a batch is ready. Separated from the thread and the
/// clock so the timing rules can be tested without sleeping.
#[derive(Debug, Default)]
pub struct Debounce {
    paths: HashSet<PathBuf>,
    /// Paths whose event created or renamed them. A directory among these
    /// has contents nobody reported; a directory that was only touched, its
    /// timestamp moved by a file written inside it, does not.
    structural: HashSet<PathBuf>,
    /// Events were lost, or the watch failed: the whole folder is suspect.
    resync: bool,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Debounce {
    pub fn push_path(&mut self, path: PathBuf, now: Instant) {
        self.paths.insert(path);
        self.mark(now);
    }

    /// A path that was created or renamed; see `structural`.
    pub fn push_structural(&mut self, path: PathBuf, now: Instant) {
        self.structural.insert(path.clone());
        self.push_path(path, now);
    }

    /// Everything has to be listed again; see `Batch::dirs`.
    pub fn push_resync(&mut self, now: Instant) {
        self.resync = true;
        self.mark(now);
    }

    fn mark(&mut self, now: Instant) {
        if self.first.is_none() {
            self.first = Some(now);
        }
        self.last = Some(now);
    }

    pub fn pending(&self) -> bool {
        self.first.is_some()
    }

    /// True when the batch should go out: either nothing has arrived for
    /// `QUIET`, or it has been filling for `MAX_HOLD`.
    pub fn ready(&self, now: Instant) -> bool {
        let (Some(first), Some(last)) = (self.first, self.last) else { return false };
        now.duration_since(last) >= QUIET || now.duration_since(first) >= MAX_HOLD
    }

    /// How long to wait before asking again. `None` when nothing is pending.
    pub fn wait(&self, now: Instant) -> Option<Duration> {
        let (first, last) = (self.first?, self.last?);
        let till_quiet = QUIET.saturating_sub(now.duration_since(last));
        let till_hold = MAX_HOLD.saturating_sub(now.duration_since(first));
        Some(till_quiet.min(till_hold))
    }

    /// Take everything accumulated, classifying each path by whether it still
    /// exists. Existence is checked here rather than read off the event kind:
    /// a rename arrives as a remove plus a create, an editor that writes
    /// through a temporary file arrives as a create plus a rename, and in both
    /// cases the event kind describes an intermediate state that is already
    /// over by the time the batch flushes.
    pub fn take(&mut self, root: &Path) -> Batch {
        let mut batch = Batch::default();
        for path in self.paths.drain() {
            let Some(rel) = relative(root, &path) else { continue };
            if path.is_file() {
                batch.changed.push(rel);
            } else if path.is_dir() {
                // A directory that was only touched carries nothing: the file
                // written inside it arrives as its own event.
                if self.structural.contains(&path) {
                    batch.dirs.push(rel);
                }
            } else {
                batch.removed.push(rel);
            }
        }
        if std::mem::take(&mut self.resync) {
            batch.dirs = vec![String::new()];
        }
        self.structural.clear();
        batch.changed.sort();
        batch.removed.sort();
        batch.dirs.sort();
        self.first = None;
        self.last = None;
        batch
    }
}

/// Repository-relative path with forward slashes, or None if the path is not
/// inside `root`. Forward slashes because every other path in the wire format
/// and the layout uses them, including on Windows.
pub fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            // A path from the OS should not contain these, and if it does it is
            // not one we can reason about.
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Whether `path` is inside the directory `dir`, `""` being the whole folder.
pub fn is_under(dir: &str, path: &str) -> bool {
    dir.is_empty()
        || (path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/')
}

/// Compare a directory as it is listed now with the files held under it.
///
/// `listed` is every file that exists under `dir` and belongs in the project;
/// `held` is every file under it that the host has. Every listed file comes
/// back to be re-read, since a directory moved in brings files nobody has
/// seen and a rescan cannot say which held ones moved; the host's own check
/// of timestamps and content turns the ones that did not into no work at all.
/// Every held file that is not listed any more is gone.
pub fn reconcile<'a>(
    listed: Vec<String>,
    held: impl Iterator<Item = &'a str>,
) -> (Vec<String>, Vec<String>) {
    let present: HashSet<&str> = listed.iter().map(String::as_str).collect();
    let gone: Vec<String> = held.filter(|p| !present.contains(p)).map(str::to_owned).collect();
    (listed, gone)
}

/// The directories that hold at least one of a set of files, counted, so a
/// removed path can be told apart as a directory the host has files in
/// without walking every file it holds.
///
/// That question comes up for every path a batch reports gone and the host
/// does not hold as a file, and a build deleting its output reports thousands
/// of those, nearly all of them in directories the host has never held.
#[derive(Debug, Default, Clone)]
pub struct DirIndex {
    counts: HashMap<String, usize>,
}

impl DirIndex {
    pub fn add(&mut self, file: &str) {
        for dir in ancestors(file) {
            *self.counts.entry(dir.to_owned()).or_insert(0) += 1;
        }
    }

    pub fn remove(&mut self, file: &str) {
        for dir in ancestors(file) {
            if let Some(n) = self.counts.get_mut(dir) {
                *n -= 1;
                if *n == 0 {
                    self.counts.remove(dir);
                }
            }
        }
    }

    /// Whether any file is held under `dir`.
    pub fn holds(&self, dir: &str) -> bool {
        self.counts.contains_key(dir)
    }
}

/// The directories a file sits in, outermost first, without the folder
/// itself: `a/b/c.rs` gives `a` and `a/b`.
fn ancestors(file: &str) -> impl Iterator<Item = &str> {
    file.match_indices('/').map(move |(i, _)| &file[..i])
}

/// A running watch. Dropping it stops the thread and releases the OS watch.
pub struct Watch {
    // Held only to keep the watch alive; notify stops watching on drop.
    _watcher: notify::RecommendedWatcher,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Start watching `root` recursively, calling `emit` once per batch.
///
/// Whether a path the scan never saw is gitignored needs git, and asking per
/// event would mean a process per keystroke, so it is asked once per batch by
/// the caller. Everything under `.git` is dropped here, where it is free.
pub fn start<E>(root: PathBuf, emit: E) -> Result<Watch, String>
where
    E: Fn(Batch) + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        // A send error means the receiving thread is gone, which happens on
        // shutdown; there is nothing useful to do about it.
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;

    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread_root = root.clone();

    std::thread::Builder::new()
        .name("sanity-watch".into())
        .spawn(move || {
            let mut pending = Debounce::default();
            loop {
                if thread_stop.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                // Blocking when nothing is pending, rather than waking on a
                // timer to find nothing. This process is meant to sit in the
                // background while something else works, and four wakeups a
                // second for the length of a working day is a cost with
                // nothing on the other side of it. The channel disconnects
                // when the watch is dropped, so the thread still exits.
                let received = match pending.wait(Instant::now()) {
                    Some(timeout) => rx.recv_timeout(timeout),
                    None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match received {
                    Ok(Ok(event)) => {
                        let now = Instant::now();
                        // Before the paths, which on a rescan are the folder
                        // itself or nothing at all.
                        if event.need_rescan() {
                            pending.push_resync(now);
                        }
                        let structural = matches!(
                            event.kind,
                            EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
                        );
                        for path in event.paths {
                            let Some(rel) = relative(&thread_root, &path) else { continue };
                            if rel == ".git" || rel.starts_with(".git/") {
                                continue;
                            }
                            if structural {
                                pending.push_structural(path, now);
                            } else {
                                pending.push_path(path, now);
                            }
                        }
                    }
                    // The watch could not say what happened, which is the one
                    // answer that cannot be ignored: listed again, whole.
                    Ok(Err(_)) => pending.push_resync(Instant::now()),
                    Err(RecvTimeoutError::Timeout) => {}
                    // The watcher was dropped.
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                if pending.pending() && pending.ready(Instant::now()) {
                    let batch = pending.take(&thread_root);
                    if !batch.is_empty() {
                        emit(batch);
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(Watch { _watcher: watcher, stop })
}

/// The app holds at most one watch: opening a folder replaces the previous one.
#[derive(Default)]
pub struct WatchSlot(pub Mutex<Option<Watch>>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_relativise_with_forward_slashes() {
        let root = Path::new("/tmp/repo");
        assert_eq!(relative(root, Path::new("/tmp/repo/src/a.rs")).as_deref(), Some("src/a.rs"));
        assert_eq!(relative(root, Path::new("/tmp/repo/a.rs")).as_deref(), Some("a.rs"));
        // The root itself is not a file in the root.
        assert_eq!(relative(root, Path::new("/tmp/repo")), None);
        // Outside the root.
        assert_eq!(relative(root, Path::new("/tmp/other/a.rs")), None);
    }

    #[test]
    fn a_quiet_gap_releases_the_batch() {
        let t0 = Instant::now();
        let mut d = Debounce::default();
        d.push_path(PathBuf::from("/tmp/repo/a.rs"), t0);
        // Still arriving.
        assert!(!d.ready(t0 + Duration::from_millis(50)));
        d.push_path(PathBuf::from("/tmp/repo/b.rs"), t0 + Duration::from_millis(50));
        assert!(!d.ready(t0 + Duration::from_millis(100)));
        // Quiet for long enough after the last event.
        assert!(d.ready(t0 + Duration::from_millis(50) + QUIET));
    }

    #[test]
    fn a_continuous_stream_is_released_by_the_hold() {
        let t0 = Instant::now();
        let mut d = Debounce::default();
        // An event every 10 ms never goes quiet, which is what a checkout of a
        // large branch looks like.
        for i in 0..200 {
            let now = t0 + Duration::from_millis(i * 10);
            d.push_path(PathBuf::from(format!("/tmp/repo/f{i}.rs")), now);
            if d.ready(now) {
                assert!(now.duration_since(t0) >= MAX_HOLD);
                return;
            }
        }
        panic!("the hold never released the batch");
    }

    #[test]
    fn waiting_never_overshoots_either_deadline() {
        let t0 = Instant::now();
        let mut d = Debounce::default();
        assert_eq!(d.wait(t0), None);
        d.push_path(PathBuf::from("/tmp/repo/a.rs"), t0);
        // Just after the first event, the quiet gap is the nearer deadline.
        assert_eq!(d.wait(t0), Some(QUIET));
        // Late in the hold, the hold is nearer.
        let late = t0 + MAX_HOLD - Duration::from_millis(20);
        d.push_path(PathBuf::from("/tmp/repo/b.rs"), late);
        assert_eq!(d.wait(late), Some(Duration::from_millis(20)));
    }

    #[test]
    fn taking_a_batch_classifies_and_resets() {
        let dir = std::env::temp_dir().join(format!("sanity-watch-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/there.rs"), b"fn main() {}\n").unwrap();

        let mut d = Debounce::default();
        let now = Instant::now();
        d.push_path(dir.join("src/there.rs"), now);
        d.push_path(dir.join("src/gone.rs"), now);

        let batch = d.take(&dir);
        assert_eq!(batch.changed, vec!["src/there.rs"]);
        assert_eq!(batch.removed, vec!["src/gone.rs"]);

        // A taken batch leaves nothing behind, or the next one would repeat it.
        assert!(!d.pending());
        assert!(d.take(&dir).is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The sending side, end to end: a real watch on a real directory, a real
    /// write, and the batch that comes out. Everything above this test is the
    /// parts; this is whether they are connected.
    #[test]
    fn writing_a_file_produces_one_batch() {
        let dir = std::env::temp_dir().join(format!("sanity-live-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.rs"), b"fn main() {}\n").unwrap();
        // FSEvents reports the resolved path, and /var is a symlink to
        // /private/var on macOS, so a watch on the unresolved path would never
        // match its own events.
        let dir = dir.canonicalize().unwrap();

        let (tx, rx) = mpsc::channel::<Batch>();
        let watch = start(dir.clone(), move |b| {
            let _ = tx.send(b);
        })
        .expect("the watch has to start");

        // FSEvents needs a moment to arm before it reports anything.
        std::thread::sleep(Duration::from_millis(400));
        std::fs::write(dir.join("src/a.rs"), b"fn main() { println!(); }\n").unwrap();

        let batch = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a write has to produce a batch");
        assert!(
            batch.changed.contains(&"src/a.rs".to_string()),
            "the written file has to be in the batch: {batch:?}"
        );

        drop(watch);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Several writes in quick succession arrive as one batch, not five. This
    /// is the property the whole debounce exists for.
    #[test]
    fn a_burst_of_writes_arrives_as_few_batches() {
        let dir = std::env::temp_dir().join(format!("sanity-burst-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();

        let (tx, rx) = mpsc::channel::<Batch>();
        let watch = start(dir.clone(), move |b| {
            let _ = tx.send(b);
        })
        .expect("the watch has to start");
        std::thread::sleep(Duration::from_millis(400));

        // Twenty files written as fast as they can be, which is what a
        // formatter pass over a directory looks like.
        for i in 0..20 {
            std::fs::write(dir.join(format!("f{i}.txt")), b"x\n").unwrap();
        }

        // Collect until it goes quiet.
        let mut batches = 0;
        let mut seen = HashSet::new();
        while let Ok(b) = rx.recv_timeout(Duration::from_secs(2)) {
            batches += 1;
            for p in b.changed {
                seen.insert(p);
            }
        }

        assert_eq!(seen.len(), 20, "every write has to be reported: {seen:?}");
        assert!(batches <= 3, "twenty writes came as {batches} batches, not a handful");

        drop(watch);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_directory_that_appeared_is_reconciled_and_a_touched_one_is_not() {
        let dir = std::env::temp_dir().join(format!("sanity-dirs-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("moved/in")).unwrap();
        std::fs::create_dir_all(dir.join("touched")).unwrap();
        let now = Instant::now();
        let mut d = Debounce::default();
        d.push_structural(dir.join("moved"), now);
        d.push_path(dir.join("touched"), now);
        // Renamed away: gone, whatever it was.
        d.push_structural(dir.join("old"), now);
        let batch = d.take(&dir);
        assert_eq!(batch.dirs, vec!["moved"]);
        assert_eq!(batch.removed, vec!["old"]);
        assert!(batch.changed.is_empty());
        // Nothing carries over into the next batch.
        d.push_path(dir.join("moved"), now);
        assert!(d.take(&dir).dirs.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rescan_reconciles_the_whole_folder() {
        let now = Instant::now();
        let mut d = Debounce::default();
        d.push_resync(now);
        assert!(d.pending());
        assert!(!d.ready(now));
        assert!(d.ready(now + QUIET));
        let batch = d.take(Path::new("/tmp/repo-none"));
        assert_eq!(batch.dirs, vec![String::new()]);
        assert!(!batch.is_empty());
        assert!(d.take(Path::new("/tmp/repo-none")).is_empty());
    }

    #[test]
    fn under_means_inside_not_sharing_a_prefix() {
        assert!(is_under("a", "a/b.rs"));
        assert!(is_under("a", "a/b/c.rs"));
        assert!(!is_under("a", "ab/c.rs"));
        assert!(!is_under("a", "a"));
        assert!(is_under("", "anything.rs"));
    }

    #[test]
    fn reconciling_reports_what_is_there_and_what_went() {
        let held = ["d/keep.rs", "d/gone.rs", "d/sub/gone.rs"];
        let (changed, gone) =
            reconcile(vec!["d/keep.rs".into(), "d/new.rs".into()], held.iter().copied());
        assert_eq!(changed, vec!["d/keep.rs", "d/new.rs"]);
        assert_eq!(gone, vec!["d/gone.rs", "d/sub/gone.rs"]);
    }

    #[test]
    fn the_dir_index_counts_files_per_directory() {
        let mut ix = DirIndex::default();
        ix.add("a/b/c.rs");
        ix.add("a/d.rs");
        assert!(ix.holds("a") && ix.holds("a/b"));
        assert!(!ix.holds("a/b/c.rs") && !ix.holds("b"));
        ix.remove("a/b/c.rs");
        assert!(ix.holds("a") && !ix.holds("a/b"));
        ix.remove("a/d.rs");
        assert!(!ix.holds("a"));
    }

    /// The case this module was missing: a directory renamed with its files
    /// in it. On FSEvents the files are never reported, so what has to come
    /// out is the old directory as gone and the new one to be listed.
    #[test]
    fn moving_a_directory_asks_for_it_to_be_listed() {
        let dir = std::env::temp_dir().join(format!("sanity-move-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("a/sub")).unwrap();
        for f in ["a/one.rs", "a/two.rs", "a/sub/three.rs"] {
            std::fs::write(dir.join(f), b"x\n").unwrap();
        }
        let dir = dir.canonicalize().unwrap();

        let (tx, rx) = mpsc::channel::<Batch>();
        let watch = start(dir.clone(), move |b| {
            let _ = tx.send(b);
        })
        .expect("the watch has to start");
        std::thread::sleep(Duration::from_millis(400));
        std::fs::rename(dir.join("a"), dir.join("b")).unwrap();

        let mut dirs = HashSet::new();
        let mut removed = HashSet::new();
        while let Ok(b) = rx.recv_timeout(Duration::from_secs(2)) {
            dirs.extend(b.dirs);
            removed.extend(b.removed);
        }
        assert!(dirs.contains("b"), "the directory moved in has to be listed: {dirs:?}");
        assert!(removed.contains("a"), "the directory moved away has to be gone: {removed:?}");

        drop(watch);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicate_events_for_one_save_collapse() {
        let mut d = Debounce::default();
        let now = Instant::now();
        // What one save actually looks like on macOS.
        for _ in 0..5 {
            d.push_path(PathBuf::from("/tmp/repo-none/src/a.rs"), now);
        }
        assert_eq!(d.paths.len(), 1);
    }
}
