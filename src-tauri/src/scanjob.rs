//! Opening a folder in two stages: the layout at once, the contents as they
//! are read.
//!
//! Reading and tokenising every file is what opening a project costs, half a
//! second for a thousand files and seconds for more, and the window used to
//! show nothing until all of it was done. Now `scan_start` answers from each
//! file's size and first few kilobytes, which takes milliseconds (see
//! `scan::estimate`), so the window lays the whole project out at once with
//! empty panels. The reading carries on across the cores behind it, and the
//! window collects what is done with `scan_next` and fills the panels in.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use sanity_core::scan;
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{Emitter, Manager, State};

use super::{
    encode, file_info, groups_from, ignored_info, pack_payloads, start_watch, width_percentile,
    AppState, FileInfo, Held, MediaInfo, Repo, ScanResult, FLAG_BINARY, IGNORED_CAP,
};

/// Which scan is the current one. A scan started while another still reads
/// makes that one stop; see `scan::read_each`.
static CURRENT: AtomicU64 = AtomicU64::new(0);

/// What the reading has done that the window has not collected yet.
#[derive(Default)]
pub struct ScanJob(Mutex<Progress>);

#[derive(Default)]
struct Progress {
    scan: u64,
    /// Files read and not yet collected: their rows and payloads.
    ready: Vec<(FileInfo, Vec<u8>)>,
    /// Files that turned out to have no panel after all: binary past their
    /// first few kilobytes, or gone before they could be read.
    dropped: Vec<String>,
    read: usize,
    total: usize,
    done: bool,
}

/// List a folder and estimate every file in it, and start reading them.
#[tauri::command]
pub async fn scan_start(
    path: String,
    include_ignored: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let started = std::time::Instant::now();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let listed = scan::list_files(&root).map_err(|e| e.to_string())?;
    // What git ignores is a filter rather than a wall: counted always, taken
    // when asked for. Counting is one `ls-files`, 136 milliseconds on the
    // 83,014 files this repository ignores, against the hundreds the scan
    // itself takes.
    let (extra, ignored_total) = if include_ignored.unwrap_or(false) {
        scan::git_ignored_files(&root, IGNORED_CAP)
    } else {
        (Vec::new(), scan::git_ignored_files(&root, 0).1)
    };

    let mut rows: Vec<FileInfo> = Vec::with_capacity(listed.len());
    let mut to_read: Vec<String> = Vec::with_capacity(listed.len());
    let mut binary = 0u32;
    for (rel, est) in listed.iter().zip(scan::estimate_all(&root, &listed)) {
        let Some(est) = est else { continue };
        if est.binary {
            binary += 1;
            continue;
        }
        rows.push(estimated_row(rel, &est));
        to_read.push(rel.clone());
    }
    let placeholders: Vec<FileInfo> = extra.iter().map(|rel| ignored_info(rel)).collect();
    let files: Vec<FileInfo> = rows.into_iter().chain(placeholders.iter().cloned()).collect();

    // The folder is this one from now on. What is held fills in as the files
    // are read; the watch starts once they all are, since a change reported
    // before then would be compared against nothing.
    *state.watch.0.lock().map_err(|e| e.to_string())? = None;
    {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        *repo = Repo::default();
        repo.root = root.clone();
        repo.placeholders = placeholders;
        repo.binary = binary;
        repo.ignored_total = ignored_total as u32;
        repo.ignored_shown = extra.len() as u32;
    }
    let id = CURRENT.fetch_add(1, Ordering::SeqCst) + 1;
    *state.scan.0.lock().map_err(|e| e.to_string())? = Progress {
        scan: id,
        total: to_read.len(),
        ..Progress::default()
    };
    std::thread::spawn(move || read_behind(app, root, to_read, id));

    Ok(ScanResult {
        root: path,
        groups: groups_from(&files),
        files,
        binary,
        ignored_total: ignored_total as u32,
        ignored_shown: extra.len() as u32,
        elapsed_ms: started.elapsed().as_millis() as u32,
    })
}

/// A row from an estimate: the line count scaled from the lines that were
/// read, their widths as a sample of the whole file's.
fn estimated_row(rel: &str, est: &scan::Estimate) -> FileInfo {
    FileInfo {
        path: rel.to_string(),
        ignored: false,
        lang: sanity_core::lang::lang_id_for_extension(
            rel.rsplit('.').next().filter(|e| !e.contains('/')).unwrap_or(""),
        ),
        line_count: est.line_count,
        max_cols: width_percentile(&est.line_cols, 0.9),
        clip_cols: est.line_cols.iter().copied().max().unwrap_or(0) as u32,
        media: est.media.map(MediaInfo::from),
        version: est.media.map(|_| format!("{}-{}", est.mtime, est.byte_len)),
        sample_cols: est.media.is_none().then(|| thin(&est.line_cols, SAMPLE_COLS)),
    }
}

/// Most line widths an estimated row carries: enough for the share of lines
/// that wrap, and small enough that thirty thousand rows are not megabytes.
const SAMPLE_COLS: usize = 64;

/// Every so many of `v`, at most `n` of them, spread over all of it.
fn thin(v: &[u16], n: usize) -> Vec<u16> {
    if v.len() <= n {
        return v.to_vec();
    }
    (0..n).map(|k| v[k * v.len() / n]).collect()
}

/// Read every file, handing each to the window's queue as it is done, then
/// hold them all and start watching.
fn read_behind(app: tauri::AppHandle, root: PathBuf, paths: Vec<String>, id: u64) {
    let state = app.state::<AppState>();
    let held: Mutex<Vec<(String, Held)>> = Mutex::new(Vec::with_capacity(paths.len()));
    scan::read_each(
        &root,
        &paths,
        // The window is drawing the project as it fills in, rasterising what
        // arrives on workers of its own, and it needs the cores for that:
        // with all of them reading, the frames came 78 ms apart at the 95th
        // percentile on sane; with half, still 88; with one, 30. A quarter
        // reads a thousand files in about a second.
        std::thread::available_parallelism().map(|n| n.get() - (n.get() / 4).max(1)).unwrap_or(0),
        || CURRENT.load(Ordering::SeqCst) == id,
        |i, read| {
            let rel = &paths[i];
            let kept = read.and_then(|(data, info)| {
                // A picture carries no lines, so its payload is empty, but it is
                // a file in the project and gets a panel. Everything else binary
                // does not.
                if data.flags & FLAG_BINARY != 0 && info.media.is_none() {
                    return None;
                }
                Some(Held {
                    row: file_info(rel, &data, &info),
                    payload: encode(&data),
                    stamp: (info.mtime, info.byte_len),
                })
            });
            let Ok(mut p) = state.scan.0.lock() else { return };
            if p.scan != id {
                return;
            }
            p.read += 1;
            match kept {
                Some(h) => {
                    p.ready.push((h.row.clone(), h.payload.clone()));
                    held.lock().unwrap().push((rel.clone(), h));
                }
                None => p.dropped.push(rel.clone()),
            }
        },
    );
    if CURRENT.load(Ordering::SeqCst) != id {
        return;
    }
    {
        let Ok(mut repo) = state.repo.lock() else { return };
        for (rel, h) in held.into_inner().unwrap() {
            repo.hold(rel, h);
        }
    }
    // Watching is what turns a snapshot into a monitor. A folder that cannot
    // be watched is still perfectly viewable, so a failure here is reported
    // and not fatal.
    match start_watch(&app, &root) {
        Ok(w) => {
            if let Ok(mut slot) = state.watch.0.lock() {
                *slot = Some(w);
            }
        }
        Err(e) => {
            let _ = app.emit("sanity://watch-failed", e);
        }
    }
    let finished = state.scan.0.lock().map(|mut p| {
        if p.scan == id {
            p.done = true;
        }
    });
    drop(finished);
}

/// What has been read since the last call, as a raw body:
/// `[u32 header length][header][payloads]`, the header holding the rows, the
/// dropped paths and how far the reading is, the payloads packed as
/// `pack_payloads` packs them.
#[tauri::command]
pub fn scan_next(state: State<'_, AppState>) -> Result<Response, String> {
    #[derive(Serialize)]
    struct Header<'a> {
        rows: &'a [FileInfo],
        dropped: &'a [String],
        read: usize,
        total: usize,
        done: bool,
    }
    let (ready, dropped, read, total, done) = {
        let mut p = state.scan.0.lock().map_err(|e| e.to_string())?;
        (std::mem::take(&mut p.ready), std::mem::take(&mut p.dropped), p.read, p.total, p.done)
    };
    let rows: Vec<FileInfo> = ready.iter().map(|(r, _)| r.clone()).collect();
    let header = serde_json::to_vec(&Header { rows: &rows, dropped: &dropped, read, total, done })
        .map_err(|e| e.to_string())?;
    let packed: Vec<(&str, &[u8])> =
        ready.iter().map(|(r, b)| (r.path.as_str(), b.as_slice())).collect();
    let mut out = (header.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(&header);
    out.extend_from_slice(&pack_payloads(&packed)?);
    Ok(Response::new(out))
}

