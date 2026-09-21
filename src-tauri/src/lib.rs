//! Tauri shell. Thin by design: every decision about what a repository
//! contains lives in `sanity-core`, and this file only moves bytes between
//! that crate and the webview.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

mod watch;

use sanity_core::filter::{self as core_filter, Filter, Reason, Verdict};
use sanity_core::git::{self, Baseline};
use sanity_core::scan::{self, ScannedFile};
use sanity_core::wire::{encode, FileData, FLAG_BINARY};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{Emitter, Manager, State};

/// One file in the scan result, as the layout needs it.
#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    #[serde(rename = "lineCount")]
    pub line_count: u32,
    /// 90th percentile of line widths: what the panel is *sized* for. The
    /// maximum is set by a single outlier and sizing to it leaves panels
    /// mostly empty; see the note in `width_percentile`.
    #[serde(rename = "maxCols")]
    pub max_cols: u32,
    /// Longest line in the file: where the text may be *clipped*. Sizing and
    /// clipping are different questions, and using the percentile for both is
    /// what made the last tenth of every long line disappear even when the
    /// panel had room for it.
    #[serde(rename = "clipCols")]
    pub clip_cols: u32,
    /// Reason the filter classified this file as generated, if it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artefact: Option<String>,
}

/// Rows for the view picker: one per extension.
#[derive(Debug, Clone, Serialize)]
pub struct GroupInfo {
    pub id: String,
    pub files: u32,
    pub lines: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artefact: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanResult {
    pub root: String,
    pub files: Vec<FileInfo>,
    pub groups: Vec<GroupInfo>,
    /// Files skipped as binary, reported so the count adds up in the UI.
    pub binary: u32,
    /// Files with at least one changed line against the baseline.
    pub changed: u32,
    /// Which baseline the change state was computed against, echoed back so
    /// the UI states what it is showing rather than guessing.
    pub baseline: String,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u32,
}

/// The scan is kept in memory so payload requests do not re-read the tree.
/// A repository's line and span data is around 30 bytes per line, so a 200k
/// line project is a few megabytes: cheap enough to hold whole.
pub struct Repo {
    root: PathBuf,
    payloads: Vec<(String, Vec<u8>)>,
    /// Decoded payloads, kept so a git re-query can rewrite `line_state`
    /// without reading and tokenizing the tree again. Roughly the same size
    /// as `payloads`, which is a few megabytes for a large project.
    data: Vec<(String, FileData)>,
    /// Line count per path, which `git::line_changes` needs to size its
    /// per-line arrays.
    line_counts: HashMap<String, u32>,
    /// The filter the scan used, kept so the watcher classifies new files the
    /// same way rather than by a second set of rules.
    filter: Filter,
    /// Every path the scan produced. A watch event for one of these needs no
    /// further question; anything else has to be asked about.
    known: HashSet<String>,
    /// The baseline in force, so a watch-driven refresh uses the same one the
    /// scan did without the frontend having to repeat it.
    baseline: Baseline,
    /// The file rows as the layout needs them. Held so a watcher event can
    /// update one row and hand the whole index back without re-reading the
    /// tree, which takes four seconds on a large project.
    files: Vec<FileInfo>,
    /// Files skipped as binary, carried so the index still adds up.
    binary: u32,
}

impl Default for Repo {
    fn default() -> Self {
        Self {
            root: PathBuf::new(),
            payloads: Vec::new(),
            data: Vec::new(),
            line_counts: HashMap::new(),
            filter: Filter::new(),
            known: HashSet::new(),
            baseline: Baseline::Head,
            files: Vec::new(),
            binary: 0,
        }
    }
}

pub struct AppState {
    repo: Mutex<Repo>,
    watch: watch::WatchSlot,
}

/// 90th percentile of non-blank line widths.
///
/// Mirrors `widthPercentile` in `web/src/lib/canvas/data/synth.ts`; the two
/// have to agree or a synthetic repo and a real one would lay out differently.
fn width_percentile(line_cols: &[u16], p: f64) -> u32 {
    let mut v: Vec<u16> = line_cols.iter().copied().filter(|&c| c > 0).collect();
    if v.is_empty() {
        return 1;
    }
    v.sort_unstable();
    let idx = (((v.len() - 1) as f64) * p).floor() as usize;
    v[idx].max(1) as u32
}

/// Group key for the view picker: the lowercased extension, or `(none)`.
/// Delegates to the core so the grammar lookup and the picker cannot disagree
/// about what a file's extension is.
fn extension_of(path: &str) -> String {
    sanity_core::lang::extension_of(path)
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "(none)".to_string())
}

fn reason_text(r: Reason) -> String {
    r.as_str().to_string()
}

/// Scan a folder: enumerate, read, classify, and encode every payload.
#[tauri::command]
async fn scan_repo(
    path: String,
    baseline: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let started = std::time::Instant::now();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    // List everything first, including artefacts: the picker needs to know
    // they exist in order to offer them, and hiding them here would make that
    // impossible.
    let mut all = Filter::new();
    all.show_artefacts = true;
    let listed = scan::list_files(&root, &all).map_err(|e| e.to_string())?;

    let mut filter = Filter::new();
    filter.load_gitattributes(&root, &listed);

    let mut files = Vec::with_capacity(listed.len());
    let mut payloads = Vec::with_capacity(listed.len());
    let mut binary = 0u32;

    let mut data: Vec<(String, FileData)> = Vec::with_capacity(listed.len());
    let mut line_counts: HashMap<String, u32> = HashMap::with_capacity(listed.len());

    for rel in &listed {
        let Some((data_one, info)) = scan::read_file(&root, rel) else { continue };
        if data_one.flags & FLAG_BINARY != 0 {
            binary += 1;
            continue;
        }
        let artefact = match filter.classify_sized(rel, info.line_count) {
            Verdict::Keep => None,
            Verdict::Artefact(r) => Some(reason_text(r)),
        };
        files.push(file_info(rel, &data_one, &info, artefact));
        line_counts.insert(rel.clone(), info.line_count);
        data.push((rel.clone(), data_one));
    }

    // Change state is stamped in after reading, not during: it takes two git
    // invocations for the whole repository rather than one per file, and it
    // needs the line counts the read produced.
    let baseline = baseline.as_deref().map(parse_baseline).unwrap_or(Baseline::Head);
    let changed = apply_changes(&root, baseline, &line_counts, &mut data);
    for (rel, data_one) in &data {
        payloads.push((rel.clone(), encode(data_one)));
    }

    let groups = groups_from(&files);

    let result = ScanResult {
        root: root.to_string_lossy().into_owned(),
        files: files.clone(),
        groups,
        binary,
        changed,
        baseline: baseline_name(baseline).to_string(),
        elapsed_ms: started.elapsed().as_millis() as u32,
    };

    {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.root = root.clone();
        repo.payloads = payloads;
        repo.data = data;
        repo.known = line_counts.keys().cloned().collect();
        repo.files = files;
        repo.line_counts = line_counts;
        repo.filter = filter.clone();
        repo.baseline = baseline;
        repo.binary = binary;
    }

    // Watching is what turns a snapshot into a monitor, so it starts with the
    // scan rather than on a separate call. A folder that cannot be watched is
    // still perfectly viewable, so a failure here is reported and not fatal.
    match start_watch(&app, &root, filter) {
        Ok(w) => {
            // Replacing the previous watch drops it, which releases the OS
            // watch on the folder that is no longer open.
            *state.watch.0.lock().map_err(|e| e.to_string())? = Some(w);
        }
        Err(e) => {
            let _ = app.emit("sanity://watch-failed", e);
        }
    }

    Ok(result)
}

/// The picker rows, derived from the file rows.
///
/// Derived rather than accumulated, so that a file the watcher adds or removes
/// updates the picker through the same code the scan used. Sorted by weight,
/// which is the order the picker shows.
fn groups_from(files: &[FileInfo]) -> Vec<GroupInfo> {
    let mut groups: Vec<GroupInfo> = Vec::new();
    for f in files {
        let ext = extension_of(&f.path);
        match groups.iter_mut().find(|g| g.id == ext) {
            Some(g) => {
                g.files += 1;
                g.lines += f.line_count;
                // A group is generated if any of its files is: the reason of
                // the first one that says so is representative for a row.
                if g.artefact.is_none() {
                    g.artefact = f.artefact.clone();
                }
            }
            None => groups.push(GroupInfo {
                id: ext,
                files: 1,
                lines: f.line_count,
                artefact: f.artefact.clone(),
            }),
        }
    }
    groups.sort_by(|a, b| b.lines.cmp(&a.lines));
    groups
}

/// One file row from a fresh read. The same computation for a scan and for a
/// watcher refresh, so the two cannot disagree about a panel's size.
fn file_info(rel: &str, data: &FileData, info: &ScannedFile, artefact: Option<String>) -> FileInfo {
    FileInfo {
        path: rel.to_string(),
        line_count: info.line_count,
        max_cols: width_percentile(&data.line_cols, 0.9),
        clip_cols: info.max_cols,
        artefact,
    }
}

/// Every payload concatenated, with an index, as raw bytes.
///
/// Returned through `ipc::Response` rather than as JSON: the default IPC would
/// base64 the whole thing and copy it twice, and a 200k line repository is
/// several megabytes of typed arrays. The index is a small JSON header the
/// frontend reads first; see `web/src/lib/sources/tauri.ts`.
#[tauri::command]
async fn repo_payloads(state: State<'_, AppState>) -> Result<Response, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    Ok(Response::new(pack_payloads(&repo.payloads)?))
}

/// Concatenate every payload behind a JSON index.
///
/// Layout, little endian:
///
/// ```text
/// u32  header length in bytes
/// u32  number of entries
/// ...  header: JSON array of [path, byteLength]
/// ...  payloads, in header order
/// ```
///
/// Split out from the command so it can be tested: `unpack` in
/// web/src/lib/sources/tauri.ts has to agree with it byte for byte, and both
/// sides assert against the same fixture.
pub fn pack_payloads(payloads: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let index: Vec<(&str, u32)> =
        payloads.iter().map(|(p, b)| (p.as_str(), b.len() as u32)).collect();
    let header = serde_json::to_vec(&index).map_err(|e| e.to_string())?;

    let total: usize = payloads.iter().map(|(_, b)| b.len()).sum();
    let mut out = Vec::with_capacity(8 + header.len() + total);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&(payloads.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    for (_, b) in payloads {
        out.extend_from_slice(b);
    }
    Ok(out)
}

/// Which baseline the frontend asked for. Unknown or absent means HEAD, the
/// answer to "what am I doing right now", which is what a monitor wants by
/// default.
fn parse_baseline(name: &str) -> Baseline {
    match name {
        "branch" | "mergeBase" | "merge-base" => Baseline::MergeBase,
        _ => Baseline::Head,
    }
}

fn baseline_name(b: Baseline) -> &'static str {
    match b {
        Baseline::Head => "head",
        Baseline::MergeBase => "branch",
    }
}

/// Stamp git's per-line change state into already-read payloads.
///
/// Returns the number of files that carry at least one changed line. A folder
/// that is not a repository leaves every state at `Unchanged`, which is the
/// correct answer rather than an error: sanity opens folders, and only some of
/// them have history.
fn apply_changes(
    root: &Path,
    baseline: Baseline,
    line_counts: &HashMap<String, u32>,
    data: &mut [(String, FileData)],
) -> u32 {
    if !git::is_repo(root) {
        return 0;
    }
    let changes = git::line_changes(root, baseline, line_counts);
    let mut changed = 0u32;
    for (rel, file) in data.iter_mut() {
        let n = file.line_count();
        match changes.get(rel) {
            Some(c) if c.lines.iter().any(|&s| s != 0) => {
                // The diff was computed from the same read, but a file can be
                // written between the two git calls, so the length is fitted
                // rather than trusted.
                file.line_state.clear();
                file.line_state.extend_from_slice(&c.lines[..c.lines.len().min(n)]);
                file.line_state.resize(n, 0);
                changed += 1;
            }
            _ => {
                // Reset rather than leave: on a re-query a file that was
                // changed and is now committed has to go cold.
                if file.line_state.iter().any(|&s| s != 0) {
                    file.line_state.clear();
                    file.line_state.resize(n, 0);
                }
            }
        }
    }
    changed
}

/// Re-read the given files and hand back their payloads.
///
/// This is the path the watcher uses. It re-reads only what changed, but it
/// re-queries git for the whole repository, because one edit moves the diff of
/// nothing else while one commit moves the diff of everything, and telling the
/// two apart costs more than the query.
#[tauri::command]
async fn refresh_files(
    paths: Vec<String>,
    baseline: Option<String>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let (root, mut line_counts, held, filter) = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        (repo.root.clone(), repo.line_counts.clone(), repo.baseline, repo.filter.clone())
    };
    // The baseline is remembered from the scan, so the watcher does not have
    // to carry it through every event.
    let baseline = baseline.as_deref().map(parse_baseline).unwrap_or(held);
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }

    let mut fresh: Vec<(String, FileData)> = Vec::with_capacity(paths.len());
    let mut rows: Vec<FileInfo> = Vec::with_capacity(paths.len());
    for rel in &paths {
        // Containment, as everywhere a path arrives from outside.
        let full = root.join(rel);
        let Ok(canonical) = full.canonicalize() else { continue };
        let Ok(root_canonical) = root.canonicalize() else { continue };
        if !canonical.starts_with(&root_canonical) {
            continue;
        }
        let Some((data_one, info)) = scan::read_file(&root, rel) else { continue };
        if data_one.flags & FLAG_BINARY != 0 {
            continue;
        }
        let artefact = match filter.classify_sized(rel, info.line_count) {
            Verdict::Keep => None,
            Verdict::Artefact(r) => Some(reason_text(r)),
        };
        line_counts.insert(rel.clone(), info.line_count);
        rows.push(file_info(rel, &data_one, &info, artefact));
        fresh.push((rel.clone(), data_one));
    }

    apply_changes(&root, baseline, &line_counts, &mut fresh);

    let out: Vec<(String, Vec<u8>)> =
        fresh.iter().map(|(rel, d)| (rel.clone(), encode(d))).collect();

    // Keep the held copy in step, so a later full payload request does not
    // hand back what was true before the edit.
    {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.line_counts = line_counts;
        for row in rows {
            repo.known.insert(row.path.clone());
            match repo.files.iter_mut().find(|f| f.path == row.path) {
                Some(slot) => *slot = row,
                None => repo.files.push(row),
            }
        }
        for (rel, d) in fresh {
            match repo.data.iter_mut().find(|(p, _)| *p == rel) {
                Some(slot) => slot.1 = d,
                None => repo.data.push((rel.clone(), d)),
            }
            let bytes = out.iter().find(|(p, _)| *p == rel).map(|(_, b)| b.clone());
            if let Some(bytes) = bytes {
                match repo.payloads.iter_mut().find(|(p, _)| *p == rel) {
                    Some(slot) => slot.1 = bytes,
                    None => repo.payloads.push((rel, bytes)),
                }
            }
        }
    }

    Ok(Response::new(pack_payloads(&out)?))
}

/// Re-query git for every held file and return the payloads whose change state
/// moved. Used when HEAD moves: a commit or a checkout changes the baseline for
/// files that were never written.
#[tauri::command]
async fn refresh_changes(
    baseline: Option<String>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let (root, line_counts, mut data, held) = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        (repo.root.clone(), repo.line_counts.clone(), repo.data.clone(), repo.baseline)
    };
    let baseline = baseline.as_deref().map(parse_baseline).unwrap_or(held);
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }

    let before: Vec<Vec<u8>> = data.iter().map(|(_, d)| d.line_state.clone()).collect();
    apply_changes(&root, baseline, &line_counts, &mut data);

    let mut out: Vec<(String, Vec<u8>)> = Vec::new();
    for (i, (rel, d)) in data.iter().enumerate() {
        if before[i] != d.line_state {
            out.push((rel.clone(), encode(d)));
        }
    }

    {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        for (rel, bytes) in &out {
            if let Some(slot) = repo.payloads.iter_mut().find(|(p, _)| p == rel) {
                slot.1 = bytes.clone();
            }
        }
        repo.data = data;
        repo.baseline = baseline;
    }

    Ok(Response::new(pack_payloads(&out)?))
}

/// The file rows and picker groups as they now stand.
///
/// Answered from held state, so the frontend can pick up a file the watcher
/// added without the four seconds a full re-read of a large project costs.
#[tauri::command]
async fn repo_index(state: State<'_, AppState>) -> Result<ScanResult, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    Ok(ScanResult {
        root: repo.root.to_string_lossy().into_owned(),
        files: repo.files.clone(),
        groups: groups_from(&repo.files),
        binary: repo.binary,
        changed: repo.data.iter().filter(|(_, d)| d.line_state.iter().any(|&s| s != 0)).count()
            as u32,
        baseline: baseline_name(repo.baseline).to_string(),
        elapsed_ms: 0,
    })
}

/// Start watching the open folder and forward each batch to the webview.
fn start_watch(app: &tauri::AppHandle, root: &Path, filter: Filter) -> Result<watch::Watch, String> {
    let handle = app.clone();
    // The watch thread only gets the cheap, pure part of the decision. Whether
    // an unseen path is gitignored needs git, and asking per event would mean a
    // process per keystroke; it is asked once per batch instead, below.
    let keep = move |rel: &str| filter.keep(Path::new(""), rel);

    watch::start(root.to_path_buf(), keep, move |batch| {
        let batch = settle_batch(&handle, batch);
        if batch.is_empty() {
            return;
        }
        // An emit failure means the window is gone, which is not something to
        // recover from in a watch callback.
        let _ = handle.emit("sanity://changed", batch);
    })
}

/// Drop the paths in a batch that the open folder does not contain.
///
/// Paths the scan already produced pass straight through. The rest go to git in
/// one call, because a build writing into an ignored directory produces
/// thousands of events and the only correct answer to whether they matter is
/// git's own.
fn settle_batch(app: &tauri::AppHandle, mut batch: watch::Batch) -> watch::Batch {
    let state: State<'_, AppState> = app.state();
    let (root, known) = match state.repo.lock() {
        Ok(repo) => (repo.root.clone(), repo.known.clone()),
        Err(_) => return watch::Batch::default(),
    };

    let unknown: Vec<String> = batch
        .changed
        .iter()
        .chain(batch.removed.iter())
        .filter(|p| !known.contains(*p))
        .cloned()
        .collect();
    let ignored = core_filter::ignored_paths(&root, &unknown);

    batch.changed.retain(|p| !ignored.contains(p));
    // A removed path that was never known is nothing to report either way.
    batch.removed.retain(|p| known.contains(p));
    batch
}

/// Stop watching. Used when the window closes or a folder is closed without
/// another being opened.
#[tauri::command]
async fn stop_watch(state: State<'_, AppState>) -> Result<(), String> {
    *state.watch.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// Forget a file that is gone, so a later full payload request does not hand
/// back something that no longer exists.
#[tauri::command]
async fn drop_files(paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    for path in &paths {
        repo.payloads.retain(|(p, _)| p != path);
        repo.data.retain(|(p, _)| p != path);
        repo.line_counts.remove(path);
        repo.known.remove(path);
        repo.files.retain(|f| f.path != *path);
    }
    Ok(())
}

/// Open a file in an external editor.
///
/// Resolution order: `SANITY_EDITOR`, then `VISUAL`, then `EDITOR`, then the
/// platform's own handler. The variable may carry arguments, as `EDITOR`
/// commonly does (`code -g`, `subl -n`), so it is split on whitespace; a path
/// containing spaces still works because only the command is split, never the
/// argument that is appended.
///
/// A terminal editor in `EDITOR` would have nowhere to run, so a command that
/// looks like one is skipped in favour of the platform handler.
const TERMINAL_EDITORS: &[&str] = &["vi", "vim", "nvim", "nano", "emacs", "helix", "hx", "micro"];

#[tauri::command]
async fn open_in_editor(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.root.clone()
    };
    // Same containment check as reading: a path from the frontend is not
    // trusted just because the frontend is ours.
    let full = root.join(&path);
    let canonical = full.canonicalize().map_err(|e| e.to_string())?;
    let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root_canonical) {
        return Err("path outside the open folder".into());
    }

    let configured = ["SANITY_EDITOR", "VISUAL", "EDITOR"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.trim().is_empty());

    if let Some(cmd) = configured {
        let mut parts = cmd.split_whitespace();
        let program = parts.next().unwrap_or_default().to_string();
        let base = program.rsplit('/').next().unwrap_or(&program);
        if !TERMINAL_EDITORS.contains(&base) {
            let args: Vec<String> = parts.map(str::to_string).collect();
            let spawned: Result<String, String> = Command::new(&program)
                .args(&args)
                .arg(&canonical)
                .spawn()
                .map(|_| program.clone())
                .map_err(|e| format!("{program}: {e}"));
            if spawned.is_ok() {
                return spawned;
            }
            // Fall through to the platform handler rather than failing: a
            // stale EDITOR should not make the feature unusable.
        }
    }

    platform_open(&canonical)
}

#[cfg(target_os = "macos")]
fn platform_open(path: &Path) -> Result<String, String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| "open".to_string())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn platform_open(path: &Path) -> Result<String, String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| "xdg-open".to_string())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn platform_open(path: &Path) -> Result<String, String> {
    Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .spawn()
        .map(|_| "start".to_string())
        .map_err(|e| e.to_string())
}

/// What the window should do on startup.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Startup {
    /// Folder to open, from the first command line argument or `SANITY_OPEN`.
    /// Makes `sanity <path>` behave the way a CLI is expected to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Level-of-detail hand-over points from `SANITY_LOD`, as the frontend's
    /// `?lod=` takes them. A window has no query string, and where a hand-over
    /// belongs is settled by moving the numbers while watching.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lod: Option<String>,
}

#[tauri::command]
fn startup() -> Startup {
    let from_arg = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    let repo = from_arg
        .or_else(|| std::env::var("SANITY_OPEN").ok())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .map(|p| p.canonicalize().unwrap_or(p).to_string_lossy().into_owned());
    let lod = std::env::var("SANITY_LOD").ok().filter(|v| !v.trim().is_empty());
    Startup { repo, lod }
}

/// The text of one file, for the readable zoom level. Read on demand rather
/// than held: the payloads are compact, the source text is not.
#[tauri::command]
async fn file_text(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.root.clone()
    };
    read_text(&root, &path)
}

fn read_text(root: &Path, rel: &str) -> Result<String, String> {
    // Refuse to escape the open folder, however the path was spelled.
    let full = root.join(rel);
    let canonical = full.canonicalize().map_err(|e| e.to_string())?;
    let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root_canonical) {
        return Err("path outside the open folder".into());
    }
    let bytes = std::fs::read(&canonical).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState {
                repo: Mutex::new(Repo::default()),
                watch: watch::WatchSlot::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_repo,
            repo_payloads,
            file_text,
            startup,
            open_in_editor,
            refresh_files,
            refresh_changes,
            stop_watch,
            drop_files,
            repo_index
        ])
        .run(tauri::generate_context!())
        .expect("error while running sanity");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_editors_are_recognised_by_basename() {
        // The check has to survive a full path in EDITOR, which is common.
        for cmd in ["vim", "/usr/bin/vim", "/opt/homebrew/bin/nvim"] {
            let base = cmd.rsplit('/').next().unwrap();
            assert!(TERMINAL_EDITORS.contains(&base), "{cmd} should be terminal");
        }
        for cmd in ["code", "/usr/local/bin/code", "subl", "zed"] {
            let base = cmd.rsplit('/').next().unwrap();
            assert!(!TERMINAL_EDITORS.contains(&base), "{cmd} should not be terminal");
        }
    }

    #[test]
    fn extensions_handle_dotfiles_and_paths() {
        assert_eq!(extension_of("src/main.rs"), "rs");
        assert_eq!(extension_of("web/src/App.svelte"), "svelte");
        assert_eq!(extension_of("Makefile"), "(none)");
        // A leading dot is a name, not an extension.
        assert_eq!(extension_of(".gitignore"), "(none)");
        assert_eq!(extension_of("a/.env"), "(none)");
        assert_eq!(extension_of("x/y.MD"), "md");
    }

    #[test]
    fn percentile_ignores_blank_lines() {
        // Nine short lines, one long one: the percentile must not follow the
        // outlier, which is the whole reason it exists.
        let cols: Vec<u16> = vec![0, 0, 20, 22, 24, 21, 23, 20, 22, 300];
        let p = width_percentile(&cols, 0.9);
        assert!(p < 100, "percentile {p} followed the outlier");
        assert!(p >= 20);
    }

    #[test]
    fn percentile_of_empty_is_one() {
        assert_eq!(width_percentile(&[], 0.9), 1);
        assert_eq!(width_percentile(&[0, 0], 0.9), 1);
    }

    /// The fixture the TypeScript side unpacks. Printed by
    /// `cargo test -p sanity -- --nocapture payload_golden`.
    fn payload_fixture() -> Vec<(String, Vec<u8>)> {
        vec![
            ("src/a.rs".to_string(), vec![1, 2, 3, 4]),
            ("b.ts".to_string(), vec![9]),
            ("c/d/e.py".to_string(), vec![7, 7, 7]),
        ]
    }

    #[test]
    fn payload_packing_is_self_consistent() {
        let payloads = payload_fixture();
        let packed = pack_payloads(&payloads).unwrap();

        let header_len = u32::from_le_bytes(packed[0..4].try_into().unwrap()) as usize;
        let count = u32::from_le_bytes(packed[4..8].try_into().unwrap()) as usize;
        assert_eq!(count, payloads.len());

        let index: Vec<(String, u32)> =
            serde_json::from_slice(&packed[8..8 + header_len]).unwrap();
        assert_eq!(index.len(), payloads.len());

        let mut offset = 8 + header_len;
        for ((path, bytes), (ipath, ilen)) in payloads.iter().zip(index.iter()) {
            assert_eq!(path, ipath);
            assert_eq!(*ilen as usize, bytes.len());
            assert_eq!(&packed[offset..offset + bytes.len()], bytes.as_slice());
            offset += bytes.len();
        }
        assert_eq!(offset, packed.len(), "no trailing bytes");
    }

    #[test]
    fn payload_golden() {
        let packed = pack_payloads(&payload_fixture()).unwrap();
        let hex: String = packed.iter().map(|b| format!("{b:02x}")).collect();
        println!("payload golden {} bytes: {hex}", packed.len());
        // Guards the one thing a refactor could silently change: the order of
        // the two length words in front of the header.
        assert_eq!(u32::from_le_bytes(packed[4..8].try_into().unwrap()), 3);
    }

    #[test]
    fn packing_an_empty_repo_is_valid() {
        let packed = pack_payloads(&[]).unwrap();
        let header_len = u32::from_le_bytes(packed[0..4].try_into().unwrap()) as usize;
        assert_eq!(u32::from_le_bytes(packed[4..8].try_into().unwrap()), 0);
        let index: Vec<(String, u32)> =
            serde_json::from_slice(&packed[8..8 + header_len]).unwrap();
        assert!(index.is_empty());
    }
}
