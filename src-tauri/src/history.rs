//! The history ticker's side of the backend: the commits, and a step between
//! any two states of the folder, as a batch the frontend plays like a save.
//! See `sanity_core::history`.

use std::collections::HashMap;
use std::sync::Mutex;

use sanity_core::history::{self, Side, Source};
use sanity_core::scan;
use sanity_core::wire::{encode, FLAG_BINARY};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

use crate::{file_info, pack_payloads, AppState, FileInfo};

/// One commit as the ticker shows it.
#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    sha: String,
    time: i64,
    author: String,
    subject: String,
}

/// Payloads of blobs already read, by blob id.
///
/// The same version of a file turns up in many commits, and a ticker is
/// stepped back and forth over the same stretch: keyed by content rather than
/// by path and commit, a second visit reads nothing and tokenises nothing.
/// Bounded by bytes and emptied when full, which for a cache whose entries are
/// all equally likely to come back is as good as anything cleverer.
#[derive(Default)]
pub struct BlobCache {
    held: Mutex<Cached>,
}

/// The payloads and rows by blob id, and the bytes they take.
type Cached = (HashMap<String, (FileInfo, Vec<u8>)>, usize);

const CACHE_BYTES: usize = 256 * 1024 * 1024;

/// The commits along the first parent, newest first.
#[tauri::command]
pub async fn history_log(
    skip: usize,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<CommitInfo>, String> {
    let root = state.repo.lock().map_err(|e| e.to_string())?.root.clone();
    if root.as_os_str().is_empty() {
        return Ok(Vec::new());
    }
    Ok(history::commits(&root, skip, limit)
        .into_iter()
        .map(|c| CommitInfo { sha: c.sha, time: c.time, author: c.author, subject: c.subject })
        .collect())
}

/// What the canvas has to change to go from `from` to `to`, each a commit or
/// `None` for the working tree.
///
/// Laid out as a small JSON header, the rows of the files that changed and the
/// paths that are gone, followed by the payloads in the format
/// `repo_payloads` uses: `[u32 header length][header][payloads]`.
#[tauri::command]
pub async fn history_step(
    from: Option<String>,
    to: Option<String>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let root = state.repo.lock().map_err(|e| e.to_string())?.root.clone();
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }
    let side = |s: Option<String>| s.map(Side::Commit).unwrap_or(Side::Live);
    let step = history::step(&root, &side(from), &side(to)).ok_or("git could not say")?;

    let (rows, payloads) = contents(&state, &root, &step.changed)?;
    pack(&rows, &step.removed, &payloads)
}

/// The files the loaded window of history needs room for beyond the working
/// tree: the ones the working tree does not have, and the ones that were
/// larger somewhere in the window than they are now, each at its largest
/// version, as rows and payloads in the format `history_step` uses, with
/// nothing removed.
///
/// So the history can be laid out once, for every file that exists anywhere
/// in it at the largest it gets, and a step moves nothing: a file that is not
/// there at the commit shown keeps its place empty, and a smaller version of
/// one fits the room a larger one was given.
#[tauri::command]
pub async fn history_window(limit: usize, state: State<'_, AppState>) -> Result<Response, String> {
    let root = state.repo.lock().map_err(|e| e.to_string())?.root.clone();
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }
    let window = history::window(&root, limit);
    let gone: Vec<(String, Source)> = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        window
            .into_iter()
            .filter(|(p, _, size)| repo.held.get(p).is_none_or(|h| *size > h.stamp.1))
            .map(|(p, blob, _)| (p, Source::Blob(blob)))
            .collect()
    };
    let (rows, payloads) = contents(&state, &root, &gone)?;
    pack(&rows, &[], &payloads)
}

/// Rows, and payloads by path.
type Contents = (Vec<FileInfo>, Vec<(String, Vec<u8>)>);

/// Rows and payloads for paths whose contents are a blob or the disk,
/// through the cache.
fn contents(
    state: &State<'_, AppState>,
    root: &std::path::Path,
    changed: &[(String, Source)],
) -> Result<Contents, String> {
    // What the cache does not have, read in one go.
    let missing: Vec<String> = {
        let cache = state.history.held.lock().map_err(|e| e.to_string())?;
        changed
            .iter()
            .filter_map(|(_, s)| match s {
                Source::Blob(id) if !cache.0.contains_key(id) => Some(id.clone()),
                _ => None,
            })
            .collect()
    };
    let read = history::blobs(root, &missing);

    let mut rows: Vec<FileInfo> = Vec::new();
    let mut payloads: Vec<(String, Vec<u8>)> = Vec::new();
    {
        let mut cache = state.history.held.lock().map_err(|e| e.to_string())?;
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        for (path, source) in changed {
            let got = match source {
                // The working tree as the backend holds it, which the watcher
                // keeps current.
                Source::Disk => repo.held.get(path).map(|h| (h.row.clone(), h.payload.clone())),
                Source::Blob(id) => {
                    if let Some((row, payload)) = cache.0.get(id) {
                        Some((FileInfo { path: path.clone(), ..row.clone() }, payload.clone()))
                    } else if let Some(bytes) = read.get(id) {
                        let (data, info) =
                            scan::data_from_bytes(path, bytes, bytes.len() as u64, 0);
                        // Skipped as the scan skips it: binary and not a picture.
                        if data.flags & FLAG_BINARY != 0 && info.media.is_none() {
                            None
                        } else {
                            let row = file_info(path, &data, &info);
                            let payload = encode(&data);
                            if cache.1 + payload.len() > CACHE_BYTES {
                                cache.0.clear();
                                cache.1 = 0;
                            }
                            cache.1 += payload.len();
                            cache.0.insert(id.clone(), (row.clone(), payload.clone()));
                            Some((row, payload))
                        }
                    } else {
                        None
                    }
                }
            };
            if let Some((row, payload)) = got {
                rows.push(row);
                payloads.push((path.clone(), payload));
            }
        }
    }
    Ok((rows, payloads))
}

/// `[u32 header length][header: rows and removed paths][payloads]`.
fn pack(rows: &[FileInfo], removed: &[String], payloads: &[(String, Vec<u8>)]) -> Result<Response, String> {
    #[derive(Serialize)]
    struct Header<'a> {
        rows: &'a [FileInfo],
        removed: &'a [String],
    }
    let header = serde_json::to_vec(&Header { rows, removed })
        .map_err(|e| e.to_string())?;
    let packed: Vec<(&str, &[u8])> =
        payloads.iter().map(|(p, b)| (p.as_str(), b.as_slice())).collect();
    let body = pack_payloads(&packed)?;
    let mut out = Vec::with_capacity(4 + header.len() + body.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&body);
    Ok(Response::new(out))
}
