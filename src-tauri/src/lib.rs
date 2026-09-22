//! Tauri shell. Thin by design: every decision about what a repository
//! contains lives in `sanity-core`, and this file only moves bytes between
//! that crate and the webview.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

mod watch;

use sanity_core::find;
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
    /// Present when the file is a picture rather than text. The layout sizes
    /// and shapes its panel from this instead of from lines; see
    /// `sanity_core::media`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaInfo>,
}

/// What a picture is, for the layout. Flat rather than an enum so the
/// frontend can read it without a discriminant: an image has pixels, a
/// document has pages.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct MediaInfo {
    /// "image" or "document".
    pub kind: &'static str,
    /// Pixel size, 0 when the header did not say.
    pub w: u32,
    pub h: u32,
    /// Pages, 0 for an image.
    pub pages: u32,
}

impl From<sanity_core::media::Media> for MediaInfo {
    fn from(m: sanity_core::media::Media) -> Self {
        use sanity_core::media::Media;
        match m {
            Media::Image { w, h } => MediaInfo { kind: "image", w, h, pages: 0 },
            Media::Document { pages, w, h } => MediaInfo { kind: "document", w, h, pages },
        }
    }
}

/// Rows for the view picker: one per extension.
#[derive(Debug, Clone, Serialize)]
pub struct GroupInfo {
    pub id: String,
    pub files: u32,
    pub lines: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanResult {
    pub root: String,
    pub files: Vec<FileInfo>,
    pub groups: Vec<GroupInfo>,
    /// Files skipped as binary, reported so the count adds up in the UI.
    pub binary: u32,
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
    /// Line count per path, kept so a watcher refresh can report the index
    /// without re-reading the tree.
    line_counts: HashMap<String, u32>,
    /// Every path the scan produced. A watch event for one of these needs no
    /// further question; anything else has to be asked about.
    known: HashSet<String>,
    /// Modification time and size per path, as of the version held.
    ///
    /// A watcher reports a path when the filesystem touched it, which is not
    /// the same as the content having moved: an editor writing through a
    /// temporary file, a tool rewriting a file with what was already in it, a
    /// build stamping directories. Asking the filesystem first costs one stat
    /// and saves a read plus a tokenise, which is two orders of magnitude
    /// more.
    stamps: HashMap<String, (u128, u64)>,
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
            known: HashSet::new(),
            stamps: HashMap::new(),
            files: Vec::new(),
            binary: 0,
        }
    }
}

pub struct AppState {
    repo: Mutex<Repo>,
    watch: watch::WatchSlot,
    /// Where the next image goes, handed over by `stage_save` just before the
    /// bytes arrive. It lives here because the bytes travel as a raw request
    /// body, which carries no arguments of its own and whose headers are
    /// ASCII, while a path is neither.
    save_to: Mutex<Option<PathBuf>>,
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

/// Scan a folder: enumerate, read, classify, and encode every payload.
#[tauri::command]
async fn scan_repo(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let started = std::time::Instant::now();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let listed = scan::list_files(&root).map_err(|e| e.to_string())?;

    let mut files = Vec::with_capacity(listed.len());
    let mut payloads = Vec::with_capacity(listed.len());
    let mut binary = 0u32;

    let mut data: Vec<(String, FileData)> = Vec::with_capacity(listed.len());
    let mut line_counts: HashMap<String, u32> = HashMap::with_capacity(listed.len());
    let mut stamps: HashMap<String, (u128, u64)> = HashMap::with_capacity(listed.len());

    // Reading and tokenising is the largest cost in opening a project and the
    // files are independent, so it happens across the cores. Measured on 218
    // thousand lines: 1.07 seconds on one thread, 349 milliseconds on eight.
    for (rel, read) in listed.iter().zip(scan::read_all(&root, &listed)) {
        let Some((data_one, info)) = read else { continue };
        // A picture carries no lines, so its payload is empty, but it is a
        // file in the project and gets a panel. Everything else binary is
        // still only counted.
        if data_one.flags & FLAG_BINARY != 0 && info.media.is_none() {
            binary += 1;
            continue;
        }
        files.push(file_info(rel, &data_one, &info));
        line_counts.insert(rel.clone(), info.line_count);
        stamps.insert(rel.clone(), (info.mtime, info.byte_len));
        data.push((rel.clone(), data_one));
    }

    for (rel, data_one) in &data {
        payloads.push((rel.clone(), encode(data_one)));
    }

    let groups = groups_from(&files);

    let result = ScanResult {
        root: root.to_string_lossy().into_owned(),
        files: files.clone(),
        groups,
        binary,
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
        repo.stamps = stamps;
        repo.binary = binary;
    }

    // Watching is what turns a snapshot into a monitor, so it starts with the
    // scan rather than on a separate call. A folder that cannot be watched is
    // still perfectly viewable, so a failure here is reported and not fatal.
    match start_watch(&app, &root) {
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
            }
            None => groups.push(GroupInfo { id: ext, files: 1, lines: f.line_count }),
        }
    }
    groups.sort_by(|a, b| b.lines.cmp(&a.lines));
    groups
}

/// One file row from a fresh read. The same computation for a scan and for a
/// watcher refresh, so the two cannot disagree about a panel's size.
fn file_info(rel: &str, data: &FileData, info: &ScannedFile) -> FileInfo {
    FileInfo {
        path: rel.to_string(),
        line_count: info.line_count,
        max_cols: width_percentile(&data.line_cols, 0.9),
        clip_cols: info.max_cols,
        media: info.media.map(MediaInfo::from),
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

/// Whether the watch diagnostics are on. `SANITY_WATCH_LOG` turns them on,
/// which is the only way to see the live update loop from a terminal: the
/// webview console does not reach stdout.
fn watch_log() -> bool {
    std::env::var("SANITY_WATCH_LOG").is_ok()
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
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let (root, mut line_counts, held) = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        (repo.root.clone(), repo.line_counts.clone(), repo.stamps.clone())
    };
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }

    let mut fresh: Vec<(String, FileData)> = Vec::with_capacity(paths.len());
    let mut rows: Vec<FileInfo> = Vec::with_capacity(paths.len());
    let mut stamps: Vec<(String, (u128, u64))> = Vec::with_capacity(paths.len());
    let mut unchanged = 0usize;
    for rel in &paths {
        // Containment, as everywhere a path arrives from outside.
        let full = root.join(rel);
        let Ok(canonical) = full.canonicalize() else { continue };
        let Ok(root_canonical) = root.canonicalize() else { continue };
        if !canonical.starts_with(&root_canonical) {
            continue;
        }
        // The cheap question first: has this file actually moved? A watcher
        // reports a path when the filesystem touched it, and most of those
        // have the same content as the version already held.
        let now = scan::stamp_of(&root, rel);
        if let (Some(now), Some(was)) = (now, held.get(rel)) {
            if now == *was {
                unchanged += 1;
                continue;
            }
        }

        let Some((data_one, info)) = scan::read_file(&root, rel) else { continue };
        if data_one.flags & FLAG_BINARY != 0 && info.media.is_none() {
            continue;
        }
        stamps.push((rel.clone(), (info.mtime, info.byte_len)));
        line_counts.insert(rel.clone(), info.line_count);
        rows.push(file_info(rel, &data_one, &info));
        fresh.push((rel.clone(), data_one));
    }

    let out: Vec<(String, Vec<u8>)> =
        fresh.iter().map(|(rel, d)| (rel.clone(), encode(d))).collect();
    if watch_log() {
        eprintln!(
            "refresh_files: {} of {} paths re-read, {unchanged} unchanged by timestamp",
            out.len(),
            paths.len(),
        );
    }

    // Keep the held copy in step, so a later full payload request does not
    // hand back what was true before the edit.
    {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.line_counts = line_counts;
        for (rel, stamp) in stamps {
            repo.stamps.insert(rel, stamp);
        }
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

/// The file rows and picker groups as they now stand.
///
/// Answered from held state, so the frontend can pick up a file the watcher
/// added without the four seconds a full re-read of a large project costs.
#[tauri::command]
async fn repo_index(state: State<'_, AppState>) -> Result<ScanResult, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    if watch_log() {
        eprintln!("repo_index: {} files (relayout)", repo.files.len());
    }
    Ok(ScanResult {
        root: repo.root.to_string_lossy().into_owned(),
        files: repo.files.clone(),
        groups: groups_from(&repo.files),
        binary: repo.binary,
        elapsed_ms: 0,
    })
}

/// Start watching the open folder and forward each batch to the webview.
fn start_watch(app: &tauri::AppHandle, root: &Path) -> Result<watch::Watch, String> {
    let handle = app.clone();

    // The webview console is not visible from a terminal, so there has to be
    // some way to see that a batch went out. Off unless asked for: this fires
    // on every save.
    let log = watch_log();

    watch::start(root.to_path_buf(), move |batch| {
        let batch = settle_batch(&handle, batch);
        if batch.is_empty() {
            return;
        }
        if log {
            eprintln!(
                "watch: {} changed, {} removed {:?}",
                batch.changed.len(),
                batch.removed.len(),
                &batch.changed[..batch.changed.len().min(4)],
            );
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
    let ignored = scan::ignored_paths(&root, &unknown);

    batch.changed.retain(|p| !ignored.contains(p));
    // A removed path that was never known is nothing to report either way.
    batch.removed.retain(|p| known.contains(p));
    batch
}

/// Stop watching. Used when the window closes or a folder is closed without
/// another being opened.
#[tauri::command]
async fn stop_watch(state: State<'_, AppState>) -> Result<(), String> {
    if watch_log() {
        eprintln!("stop_watch");
    }
    *state.watch.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// A line from the webview, on stderr.
///
/// The webview console does not reach the terminal, so without this there is
/// no way to see what the frontend did with an event that the backend can
/// prove it sent. Only prints with `SANITY_WATCH_LOG` set.
#[tauri::command]
fn log_line(message: String) {
    if watch_log() {
        eprintln!("ui: {message}");
    }
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
        repo.stamps.remove(path);
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

/// Hits for a query across the whole open folder.
///
/// Reads and scans the tree on every call rather than holding its text: at
/// 18.6 MB over 1062 files that measured 7 to 8 milliseconds warm, across
/// eight cores, which is inside a keystroke. Holding the text instead would
/// cost more memory than the renderer uses and would be wrong the moment a
/// file is written, which for this tool is constantly.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FoundFile {
    path: String,
    /// Line and column pairs, flattened: two numbers per hit. Flat because a
    /// long query can find thousands and an object each would dominate the
    /// message.
    at: Vec<u32>,
    /// Hits past the per-file cap.
    more: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FoundResult {
    files: Vec<FoundFile>,
    /// Hits reported, and hits there are, which differ once a cap bites.
    shown: u32,
    total: u32,
    elapsed_ms: u32,
}

#[tauri::command]
async fn find_text(
    query: String,
    cap: usize,
    state: State<'_, AppState>,
) -> Result<FoundResult, String> {
    let (root, paths) = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        (
            repo.root.clone(),
            repo.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
        )
    };
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }
    let started = std::time::Instant::now();
    let found = find::find_in_files(&root, &paths, &query, cap.max(1));

    let mut shown = 0u32;
    let mut total = 0u32;
    let files = found
        .into_iter()
        .map(|f| {
            shown += f.hits.len() as u32;
            total += f.hits.len() as u32 + f.more;
            let mut at = Vec::with_capacity(f.hits.len() * 2);
            for h in &f.hits {
                at.push(h.line);
                at.push(h.col);
            }
            FoundFile { path: f.path, at, more: f.more }
        })
        .collect();
    Ok(FoundResult {
        files,
        shown,
        total,
        elapsed_ms: started.elapsed().as_millis() as u32,
    })
}

/// Name the file the next image goes to.
///
/// Its own command because of how the image itself travels: as a raw request
/// body, which carries no arguments and whose headers are ASCII, while a path
/// is neither. The window asks where through the same dialog plugin the folder
/// picker uses, then calls this, then sends the bytes.
#[tauri::command]
fn stage_save(path: String, state: State<'_, AppState>) -> Result<(), String> {
    if path.is_empty() {
        return Err("stage_save needs a path".into());
    }
    *state.save_to.lock().unwrap() = Some(PathBuf::from(path));
    Ok(())
}

/// Write the PNG the window rendered to the staged path.
///
/// The bytes arrive as the raw request body: a 4K image is a few megabytes,
/// and the default IPC would turn them into a string of decimal numbers six
/// times that size.
///
/// The path is taken rather than read, so a second call without a dialog in
/// front of it fails instead of overwriting the last file quietly.
#[tauri::command]
fn save_png(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_png expects the image as a raw body".into());
    };
    let path = state.save_to.lock().unwrap().take();
    write_image(path, bytes)
}

/// The part of `save_png` that does not need a window: take the staged path,
/// refuse the two ways this can be nothing, write the file.
fn write_image(path: Option<PathBuf>, bytes: &[u8]) -> Result<String, String> {
    let path = path.ok_or("no file was chosen for the image")?;
    if bytes.is_empty() {
        return Err("the image arrived empty".into());
    }
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    // Unconditional, unlike the watch diagnostics: writing a file is
    // something the user asked for, and one line saying where it went is what
    // makes an export that did not arrive debuggable at all.
    eprintln!("sanity: wrote {} bytes to {}", bytes.len(), path.display());
    Ok(path.display().to_string())
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
    // Through the same normalisation the scan uses, or a notebook's glyphs
    // would be drawn from its JSON while its spans came from its cells.
    Ok(scan::display_text(rel, &bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState {
                repo: Mutex::new(Repo::default()),
                watch: watch::WatchSlot::default(),
                save_to: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_repo,
            repo_payloads,
            file_text,
            find_text,
            startup,
            open_in_editor,
            refresh_files,
            stop_watch,
            drop_files,
            repo_index,
            stage_save,
            save_png,
            log_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running sanity");
}

#[cfg(test)]
mod tests {
    use super::*;

    // The export failed twice by producing nothing and saying nothing, once
    // per platform, so both ways of having nothing to write are errors here
    // rather than a quiet return.
    #[test]
    fn an_image_needs_a_path_and_some_bytes() {
        assert!(write_image(None, b"png").is_err());
        let dir = std::env::temp_dir().join("sanity-write-image-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("out.png");
        assert!(write_image(Some(file.clone()), b"").is_err());
        assert!(!file.exists(), "an empty image must not leave a file behind");

        let written = write_image(Some(file.clone()), b"\x89PNG-ish").unwrap();
        assert_eq!(written, file.display().to_string());
        assert_eq!(std::fs::read(&file).unwrap(), b"\x89PNG-ish");
        std::fs::remove_dir_all(&dir).ok();
    }

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
