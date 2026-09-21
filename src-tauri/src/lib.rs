//! Tauri shell. Thin by design: every decision about what a repository
//! contains lives in `sanity-core`, and this file only moves bytes between
//! that crate and the webview.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use sanity_core::filter::{Filter, Reason, Verdict};
use sanity_core::scan::{self, ScannedFile};
use sanity_core::wire::{encode, FLAG_BINARY};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{Manager, State};

/// One file in the scan result, as the layout needs it.
#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    #[serde(rename = "lineCount")]
    pub line_count: u32,
    /// 90th percentile of line widths, which is what the panel is sized for.
    /// The maximum is set by a single outlier and would leave panels mostly
    /// empty; see the note in `width_percentile`.
    #[serde(rename = "maxCols")]
    pub max_cols: u32,
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
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u32,
}

/// The scan is kept in memory so payload requests do not re-read the tree.
/// A repository's line and span data is around 30 bytes per line, so a 200k
/// line project is a few megabytes: cheap enough to hold whole.
#[derive(Default)]
pub struct Repo {
    root: PathBuf,
    payloads: Vec<(String, Vec<u8>)>,
}

pub struct AppState {
    repo: Mutex<Repo>,
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
async fn scan_repo(path: String, state: State<'_, AppState>) -> Result<ScanResult, String> {
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
    let mut groups: Vec<GroupInfo> = Vec::new();
    let mut binary = 0u32;

    for rel in &listed {
        let Some((data, info)) = scan::read_file(&root, rel) else { continue };
        if data.flags & FLAG_BINARY != 0 {
            binary += 1;
            continue;
        }
        let artefact = match filter.classify_sized(rel, info.line_count) {
            Verdict::Keep => None,
            Verdict::Artefact(r) => Some(reason_text(r)),
        };
        push_group(&mut groups, rel, &info, artefact.as_deref());

        files.push(FileInfo {
            path: rel.clone(),
            line_count: info.line_count,
            max_cols: width_percentile(&data.line_cols, 0.9),
            artefact,
        });
        payloads.push((rel.clone(), encode(&data)));
    }

    groups.sort_by(|a, b| b.lines.cmp(&a.lines));

    let result = ScanResult {
        root: root.to_string_lossy().into_owned(),
        files,
        groups,
        binary,
        elapsed_ms: started.elapsed().as_millis() as u32,
    };

    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    repo.root = root;
    repo.payloads = payloads;

    Ok(result)
}

fn push_group(groups: &mut Vec<GroupInfo>, rel: &str, info: &ScannedFile, artefact: Option<&str>) {
    let ext = extension_of(rel);
    if let Some(g) = groups.iter_mut().find(|g| g.id == ext) {
        g.files += 1;
        g.lines += info.line_count;
        // A group is generated if any of its files is: the reason of the first
        // one that says so is representative enough for a picker row.
        if g.artefact.is_none() {
            g.artefact = artefact.map(str::to_string);
        }
    } else {
        groups.push(GroupInfo {
            id: ext,
            files: 1,
            lines: info.line_count,
            artefact: artefact.map(str::to_string),
        });
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
            app.manage(AppState { repo: Mutex::new(Repo::default()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_repo,
            repo_payloads,
            file_text,
            startup,
            open_in_editor
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
