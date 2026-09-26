//! Tauri shell. Thin by design: every decision about what a repository
//! contains lives in `sanity-core`, and this file only moves bytes between
//! that crate and the webview.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use sanity_core::process;
use std::sync::Mutex;


mod history;
mod scanjob;
mod video;

use sanity_core::find;
use sanity_watch::{self as watch, is_under, reconcile, DirIndex, WatchSlot};
use sanity_core::scan::{self, ScannedFile};
use sanity_core::wire::{encode, FileData, FLAG_BINARY};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{Emitter, Manager, State};

/// One file in the scan result, as the layout needs it.
#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    /// Set when git ignores this file, which is how the frontend knows to
    /// draw it as a placeholder: the contents were never read.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ignored: bool,
    /// Language the file was tokenised under. Taken from the payload rather
    /// than from the extension, because a notebook says which language its
    /// cells are in and the extension does not.
    pub lang: u32,
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
    /// Which version of a picture this row is, for pictures only: the file's
    /// modification time and size on disk, or `blob:<id>` for a row out of the
    /// history. Part of the key the window holds a picture by, so a picture
    /// that changed on disk is fetched again rather than drawn as it was, and
    /// one shown at a commit is fetched from that commit rather than from
    /// the disk, where it may be different or gone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Widths of the lines read to estimate a file that has not been read
    /// yet, a sample of the whole file's; see `scan::estimate`. The layout
    /// repeats them over the estimated lines to know how many wrap, which a
    /// line count alone does not say. Absent once the file is read.
    #[serde(rename = "sampleCols", skip_serializing_if = "Option::is_none")]
    pub sample_cols: Option<Vec<u16>>,
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
    /// Language id this extension is read under, 0 for one nothing claims.
    /// The picker turns it into the same family colour the canvas tints with,
    /// so the list of file types doubles as the legend for that.
    pub lang: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanResult {
    pub root: String,
    pub files: Vec<FileInfo>,
    pub groups: Vec<GroupInfo>,
    /// Files skipped as binary, reported so the count adds up in the UI.
    pub binary: u32,
    /// How many files git ignores in this folder, whether or not they were
    /// taken. The picker shows it, so switching them on is a decision with a
    /// number in front of it rather than a surprise.
    #[serde(rename = "ignoredTotal")]
    pub ignored_total: u32,
    /// And how many of those are in this scan, which is fewer whenever the
    /// folder has more of them than `IGNORED_CAP`.
    #[serde(rename = "ignoredShown")]
    pub ignored_shown: u32,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u32,
}

/// Most ignored files a scan will take.
///
/// There is no useful number here that is also unlimited: this repository
/// ignores 83,014 files and nearly ten gigabytes of build output, and a
/// monitor that reads all of them to show that they exist has stopped being a
/// monitor. Twenty thousand is more files than any project this was measured
/// on has in total, so the cap only bites on build output, and the UI says
/// when it did.
const IGNORED_CAP: usize = 20_000;

/// The scan is kept in memory so payload requests do not re-read the tree.
/// A repository's line and span data is around 30 bytes per line, so a 200k
/// line project is a few megabytes: cheap enough to hold whole.
///
/// By path. It used to be parallel vectors searched from the front, one
/// search per file per refresh, which for a checkout of a thousand files in a
/// project of a hundred thousand is a hundred million comparisons; and two
/// more copies, of the decoded files and of the line counts, that nothing
/// read any more.
#[derive(Default)]
pub struct Repo {
    root: PathBuf,
    /// Every file that was read: the scan's, and the watcher's since.
    held: HashMap<String, Held>,
    /// The directories those files are in; see `DirIndex`.
    dirs: DirIndex,
    /// Files git ignores, as placeholders: a row and nothing read.
    placeholders: Vec<FileInfo>,
    /// How many files git ignores here, and how many of them this scan took;
    /// carried so a relayout reports the same numbers the scan did.
    ignored_total: u32,
    ignored_shown: u32,
    /// Files skipped as binary, carried so the index still adds up.
    binary: u32,
}

/// One file as the backend holds it.
struct Held {
    /// The row the layout needs. Held so a watcher event can update one and
    /// hand the whole index back without re-reading the tree, which takes
    /// four seconds on a large project.
    row: FileInfo,
    /// The encoded file, for payload requests and for telling a rewrite
    /// that changed nothing from one that did.
    payload: Vec<u8>,
    /// Modification time and size, as of the version held.
    ///
    /// A watcher reports a path when the filesystem touched it, which is not
    /// the same as the content having moved: an editor writing through a
    /// temporary file, a tool rewriting a file with what was already in it, a
    /// build stamping directories. Asking the filesystem first costs one stat
    /// and saves a read plus a tokenise, which is two orders of magnitude
    /// more.
    stamp: (u128, u64),
}

impl Repo {
    fn hold(&mut self, rel: String, held: Held) {
        self.dirs.add(&rel);
        if let Some(was) = self.held.insert(rel, held) {
            // Already counted; the add above counted it again.
            self.dirs.remove(&was.row.path);
        }
    }

    fn forget(&mut self, rel: &str) {
        if self.held.remove(rel).is_some() {
            self.dirs.remove(rel);
        }
    }

    /// Every file row, read ones and placeholders, in path order.
    fn rows(&self) -> Vec<FileInfo> {
        let mut rows: Vec<FileInfo> =
            self.held.values().map(|h| h.row.clone()).chain(self.placeholders.iter().cloned()).collect();
        rows.sort_by(|a, b| a.path.cmp(&b.path));
        rows
    }
}

pub struct AppState {
    repo: Mutex<Repo>,
    watch: WatchSlot,
    /// Where the next image goes, handed over by `stage_save` just before the
    /// bytes arrive. It lives here because the bytes travel as a raw request
    /// body, which carries no arguments of its own and whose headers are
    /// ASCII, while a path is neither.
    save_to: Mutex<Option<PathBuf>>,
    /// Payloads read out of the history; see `history::BlobCache`.
    history: history::BlobCache,
    /// The video being exported, if one is; see `video.rs`.
    video: video::VideoSlot,
    /// The folder being read, and what of it the window has not collected;
    /// see `scanjob.rs`.
    scan: scanjob::ScanJob,
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
                // The first file in the group that names a language speaks
                // for it: a folder of `.ipynb` is Python because its
                // notebooks say so, and one stray unreadable file should not
                // decide the colour.
                if g.lang == 0 {
                    g.lang = f.lang;
                }
            }
            None => groups.push(GroupInfo {
                id: ext,
                files: 1,
                lines: f.line_count,
                lang: f.lang,
            }),
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
        ignored: false,
        lang: data.lang_id,
        line_count: info.line_count,
        max_cols: width_percentile(&data.line_cols, 0.9),
        clip_cols: info.max_cols,
        media: info.media.map(MediaInfo::from),
        version: info.media.map(|_| format!("{}-{}", info.mtime, info.byte_len)),
        sample_cols: None,
    }
}

/// A file git ignores: listed, never read.
///
/// The switch that brings these in has to be usable, and reading them is not:
/// this repository's home folder ignores 8,680 files, and scanning them took
/// 12 seconds and put two million lines of node_modules on the canvas against
/// the twenty thousand the project itself has. Listed and stubbed instead, the
/// same folder costs a `ls-files` and a `stat` each, and what you get is what
/// the switch is for, which is seeing that they are there and how much room
/// they take.
fn ignored_info(rel: &str) -> FileInfo {
    FileInfo {
        path: rel.to_string(),
        ignored: true,
        // Never read, so the extension is all there is to go on.
        lang: sanity_core::lang::lang_id_for_extension(
            rel.rsplit('.').next().filter(|e| !e.contains('/')).unwrap_or(""),
        ),
        line_count: 0,
        max_cols: 0,
        clip_cols: 0,
        media: None,
        version: None,
        sample_cols: None,
    }
}

/// Where thumbnails are kept between runs.
///
/// A folder of screenshots costs 241 milliseconds of decoding to thumbnail,
/// which is fine once and pointless every time the same folder is opened. The
/// key is the path, the modification time and the length, so an edited picture
/// misses and is made again, and nothing has to be invalidated by hand.
/// Write a file whole or not at all: to a name of this process's own, then
/// renamed into place, which is atomic.
///
/// The thumbnail cache is shared by every instance of the app, and two of
/// them open on the same folder make the same thumbnails. Written directly,
/// one could read the other's half-written file.
fn write_atomic(path: &Path, bytes: &[u8]) -> bool {
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, path).is_ok()
}

fn thumb_cache_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("thumbs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// FNV-1a over what identifies a version of a file.
fn thumb_key(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut hash: u64 = 1469598103934665603;
    for b in path.as_os_str().as_encoded_bytes() {
        hash = (hash ^ *b as u64).wrapping_mul(1099511628211);
    }
    for b in stamp.to_le_bytes().iter().chain(meta.len().to_le_bytes().iter()) {
        hash = (hash ^ *b as u64).wrapping_mul(1099511628211);
    }
    Some(format!("{hash:016x}.png"))
}

/// Largest the cache may grow before the oldest entries are dropped, and what
/// it is cut back to. Thumbnails are about nine kilobytes each, so this is
/// tens of thousands of pictures, and the trim runs at most once a session.
const THUMB_CACHE_MAX: u64 = 128 * 1024 * 1024;
const THUMB_CACHE_KEEP: u64 = 64 * 1024 * 1024;

fn trim_thumb_cache(dir: &Path) {
    let mut entries: Vec<(std::time::SystemTime, u64, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((meta.modified().ok()?, meta.len(), e.path()))
        })
        .collect();
    let mut total: u64 = entries.iter().map(|(_, len, _)| len).sum();
    if total <= THUMB_CACHE_MAX {
        return;
    }
    entries.sort_by_key(|(when, _, _)| *when);
    for (_, len, path) in entries {
        if total <= THUMB_CACHE_KEEP {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

/// Thumbnails for many pictures at once.
///
/// One call rather than one per file, and decoded across the cores rather than
/// in the frontend: a folder of 119 screenshots is 241 milliseconds and 1 MB
/// here against 2.1 seconds and 41 MB of sources through WebKit. Opened a
/// second time it is neither, because what was made is kept on disk.
///
/// The reply is one buffer rather than JSON, since the parts of it are PNGs:
/// a u32 count, then per entry a u32 path length, a u32 data length, the path
/// as UTF-8 and the PNG. A data length of zero means the file could not be
/// read or is not a picture this build knows.
#[tauri::command]
async fn thumbs(
    paths: Vec<String>,
    versions: Option<Vec<Option<String>>>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let root = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.root.clone()
    };
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }
    let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;
    // Paths that leave the folder are dropped here rather than rejected, so
    // one stale entry in a batch does not cost the whole batch.
    let inside: Vec<Option<PathBuf>> = paths
        .iter()
        .map(|rel| {
            let full = root.join(rel).canonicalize().ok()?;
            full.starts_with(&root_canonical).then_some(full)
        })
        .collect();

    // A picture shown at a commit is its blob; see `FileInfo::version`.
    let blob_of = |i: usize| {
        versions.as_ref().and_then(|v| version_blob(v.get(i)?.as_deref())).map(str::to_string)
    };

    let cache = thumb_cache_dir(&app);
    // What the cache already holds, and what is left to decode. A blob is
    // keyed by its id, which names its contents, so its entry never goes
    // stale.
    let mut held: Vec<Option<Vec<u8>>> = Vec::with_capacity(paths.len());
    let mut keys: Vec<Option<PathBuf>> = Vec::with_capacity(paths.len());
    let mut todo: Vec<PathBuf> = Vec::new();
    let mut blobs_todo: Vec<String> = Vec::new();
    for (i, full) in inside.iter().enumerate() {
        let blob = blob_of(i);
        let key = match &blob {
            Some(id) => cache.as_ref().map(|dir| dir.join(format!("blob-{id}.png"))),
            None => full
                .as_ref()
                .zip(cache.as_ref())
                .and_then(|(f, dir)| thumb_key(f).map(|k| dir.join(k))),
        };
        let hit = key.as_ref().and_then(|k| std::fs::read(k).ok());
        if hit.is_none() {
            match (&blob, full) {
                (Some(id), _) => blobs_todo.push(id.clone()),
                (None, Some(f)) => todo.push(f.clone()),
                (None, None) => {}
            }
        }
        keys.push(key);
        held.push(hit);
    }

    let made = sanity_core::thumb::thumbnails(&todo, sanity_core::thumb::THUMB_MAX);
    let mut fresh = made.into_iter();
    let blob_bytes = sanity_core::history::blobs(&root, &blobs_todo);
    let mut wrote = false;
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&(paths.len() as u32).to_le_bytes());
    for (i, rel) in paths.iter().enumerate() {
        let mut data = held[i].take().unwrap_or_default();
        let made = if !data.is_empty() {
            None
        } else if let Some(id) = blob_of(i) {
            blob_bytes
                .get(&id)
                .and_then(|b| sanity_core::thumb::thumbnail(b, sanity_core::thumb::THUMB_MAX))
        } else if inside[i].is_some() {
            fresh.next().flatten()
        } else {
            None
        };
        if let Some(png) = made {
            if let Some(key) = &keys[i] {
                wrote |= write_atomic(key, &png);
            }
            data = png;
        }
        out.extend_from_slice(&(rel.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(rel.as_bytes());
        out.extend_from_slice(&data);
    }
    if wrote {
        if let Some(dir) = &cache {
            trim_thumb_cache(dir);
        }
    }
    Ok(Response::new(out))
}

/// The blob a picture's version names, if it names one; see
/// `FileInfo::version`. Checked to be an object id, since it is handed to git.
fn version_blob(version: Option<&str>) -> Option<&str> {
    let id = version?.strip_prefix("blob:")?;
    (id.len() >= 40 && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(id)
}

/// A picture's bytes: the file inside the open folder, or, when its version
/// names a blob, that blob out of the object store, which is how a picture
/// shown at a commit is the picture as it was there.
fn picture_bytes(root: &Path, rel: &str, version: Option<&str>) -> Result<Vec<u8>, String> {
    if let Some(id) = version_blob(version) {
        return sanity_core::history::blobs(root, &[id.to_string()])
            .remove(id)
            .ok_or_else(|| format!("{rel}: {id} is not in the repository"));
    }
    let canonical = root.join(rel).canonicalize().map_err(|e| e.to_string())?;
    let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root_canonical) {
        return Err("path outside the open folder".into());
    }
    std::fs::read(&canonical).map_err(|e| e.to_string())
}

/// The raw bytes of one file, for a picture the renderer is about to decode.
///
/// Raw rather than JSON for the same reason the payloads are: a PNG is
/// hundreds of kilobytes and the default IPC would base64 it. The path is
/// checked against the open folder the same way `file_text` checks it, so
/// this cannot be used to read the disk.
#[tauri::command]
async fn file_bytes(
    path: String,
    version: Option<String>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let root = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.root.clone()
    };
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }
    Ok(Response::new(picture_bytes(&root, &path, version.as_deref())?))
}

/// A page of a PDF as PNG, `width` pixels across: the first by default, any
/// with `page`, counting from zero. The same renderer on every platform; see
/// `sanity_core::pdf`.
///
/// The first page is what a document's panel shows; the rest are for the
/// option that expands a document into all of its pages.
#[tauri::command]
async fn pdf_page(
    path: String,
    width: u32,
    page: Option<u32>,
    version: Option<String>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let root = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.root.clone()
    };
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }
    let t = std::time::Instant::now();
    let bytes = picture_bytes(&root, &path, version.as_deref())?;
    let png = sanity_core::pdf::render_page(&bytes, page.unwrap_or(0) as usize, width)?;
    if watch_log() {
        eprintln!("pdf_page {path} page {} at {width} px: {:.1} ms", page.unwrap_or(0), t.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(Response::new(png))
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
pub fn pack_payloads(payloads: &[(&str, &[u8])]) -> Result<Vec<u8>, String> {
    let index: Vec<(&str, u32)> = payloads.iter().map(|(p, b)| (*p, b.len() as u32)).collect();
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

/// Re-read the given files and hand back the payloads of the ones that moved.
///
/// This is the path the watcher uses. Two questions before anything is sent:
/// whether the file's timestamp and size moved, which is a stat, and after a
/// read, whether its content did. The second catches what the first cannot:
/// `touch`, a formatter with nothing to do, a checkout writing what was there.
/// Those used to come back and flash their panels as if they had been edited.
#[tauri::command]
async fn refresh_files(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let (root, stamps): (PathBuf, HashMap<String, (u128, u64)>) = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        let stamps =
            paths.iter().filter_map(|p| repo.held.get(p).map(|h| (p.clone(), h.stamp))).collect();
        (repo.root.clone(), stamps)
    };
    if root.as_os_str().is_empty() {
        return Err("no folder open".into());
    }
    let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;

    let mut fresh: Vec<(String, Held)> = Vec::with_capacity(paths.len());
    let mut unchanged = 0usize;
    for rel in &paths {
        // Containment, as everywhere a path arrives from outside.
        let Ok(canonical) = root.join(rel).canonicalize() else { continue };
        if !canonical.starts_with(&root_canonical) {
            continue;
        }
        // The cheap question first: has this file actually moved?
        let now = scan::stamp_of(&root, rel);
        if let (Some(now), Some(was)) = (now, stamps.get(rel)) {
            if now == *was {
                unchanged += 1;
                continue;
            }
        }

        let Some((data_one, info)) = scan::read_file(&root, rel) else { continue };
        if data_one.flags & FLAG_BINARY != 0 && info.media.is_none() {
            continue;
        }
        fresh.push((
            rel.clone(),
            Held {
                row: file_info(rel, &data_one, &info),
                payload: encode(&data_one),
                stamp: (info.mtime, info.byte_len),
            },
        ));
    }

    // Kept in step, so a later full payload request does not hand back what
    // was true before the edit; and compared, so a rewrite with the same
    // content is not sent at all.
    let mut out: Vec<(String, Vec<u8>)> = Vec::with_capacity(fresh.len());
    let mut same = 0usize;
    {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        for (rel, h) in fresh {
            if let Some(was) = repo.held.get_mut(&rel) {
                // A picture's payload is its size and nothing of its pixels,
                // so the same payload says nothing about whether it changed:
                // a plot drawn again in other colours at the same size was
                // taken for an identical rewrite, kept its version, and was
                // drawn as it had been. Its time on disk moved, which is all
                // there is to go on and enough.
                if was.payload == h.payload && h.row.media.is_none() {
                    was.stamp = h.stamp;
                    same += 1;
                    continue;
                }
            }
            out.push((rel.clone(), h.payload.clone()));
            repo.hold(rel, h);
        }
    }
    if watch_log() {
        eprintln!(
            "refresh_files: {} of {} paths sent, {unchanged} unchanged by timestamp, {same} by content",
            out.len(),
            paths.len(),
        );
    }

    let out: Vec<(&str, &[u8])> = out.iter().map(|(p, b)| (p.as_str(), b.as_slice())).collect();
    Ok(Response::new(pack_payloads(&out)?))
}

/// The file rows and picker groups as they now stand.
///
/// Answered from held state, so the frontend can pick up a file the watcher
/// added without the four seconds a full re-read of a large project costs.
#[tauri::command]
async fn repo_index(state: State<'_, AppState>) -> Result<ScanResult, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    let files = repo.rows();
    if watch_log() {
        eprintln!("repo_index: {} files (relayout)", files.len());
    }
    Ok(ScanResult {
        root: repo.root.to_string_lossy().into_owned(),
        groups: groups_from(&files),
        files,
        binary: repo.binary,
        ignored_total: repo.ignored_total,
        ignored_shown: repo.ignored_shown,
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

/// Turn what the watcher saw into the files that changed and the files that
/// are gone.
///
/// Three kinds of path arrive. A file the folder holds passes straight
/// through. Any other file goes to git, in one call, because a build writing
/// into an ignored directory produces thousands of events and the only
/// correct answer to whether they matter is git's own. And a directory whose
/// contents the events do not describe, one moved in or out or everything
/// after a rescan, is listed again and compared with what is held under it;
/// see `sanity_watch::reconcile`.
fn settle_batch(app: &tauri::AppHandle, batch: watch::Batch) -> watch::Batch {
    let state: State<'_, AppState> = app.state();
    let (root, mut removed, unknown, to_list) = {
        let Ok(repo) = state.repo.lock() else { return watch::Batch::default() };
        let mut removed = Vec::new();
        let mut to_list = batch.dirs.clone();
        for p in &batch.removed {
            if repo.held.contains_key(p) {
                removed.push(p.clone());
            } else if repo.dirs.holds(p) {
                // A directory the folder had files in, moved or deleted
                // whole. A path held by nobody is nothing either way, which
                // is most of what a build clearing its output reports.
                to_list.push(p.clone());
            }
        }
        let unknown: Vec<String> =
            batch.changed.iter().filter(|p| !repo.held.contains_key(*p)).cloned().collect();
        (repo.root.clone(), removed, unknown, to_list)
    };

    let ignored = scan::ignored_paths(&root, &unknown);
    let mut changed: Vec<String> =
        batch.changed.into_iter().filter(|p| !ignored.contains(p)).collect();

    for dir in &to_list {
        // Listed without the lock: it is a git call.
        let listed = scan::list_files_under(&root, dir);
        let Ok(repo) = state.repo.lock() else { return watch::Batch::default() };
        let held = repo.held.keys().map(String::as_str).filter(|p| is_under(dir, p));
        let (present, gone) = reconcile(listed, held);
        changed.extend(present);
        removed.extend(gone);
    }

    changed.sort();
    changed.dedup();
    removed.sort();
    removed.dedup();
    watch::Batch { changed, removed, dirs: Vec::new() }
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
        repo.forget(path);
        repo.placeholders.retain(|f| f.path != *path);
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
            let spawned: Result<String, String> = process::command(&program)
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
    process::command("open")
        .arg(path)
        .spawn()
        .map(|_| "open".to_string())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn platform_open(path: &Path) -> Result<String, String> {
    process::command("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| "xdg-open".to_string())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn platform_open(path: &Path) -> Result<String, String> {
    process::command("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .spawn()
        .map(|_| "start".to_string())
        .map_err(|e| e.to_string())
}

/// Take WebKitGTK off its DMA-BUF renderer where that renderer cannot work.
///
/// WebKitGTK composites into a buffer it allocates through GBM, and against
/// the proprietary NVIDIA driver the allocation fails. The window opens at the
/// right size and stays completely blank, with `Failed to create GBM buffer of
/// size 1600x1000: Invalid argument` on stderr and nothing on screen to say
/// so. The other path draws the whole interface correctly, so it is taken on
/// the machines that need it and Mesa, where DMA-BUF works and is the faster
/// of the two, keeps it.
///
/// Set by the process rather than by the bundle because there is nowhere in
/// the bundle to set it: Tauri 2 builds its AppImage with linuxdeploy and no
/// longer wraps the binary in a launcher script. Doing it here also means
/// `npm run app` behaves like a release build without anyone remembering to
/// export anything.
///
/// Only when the variable is absent, so `WEBKIT_DISABLE_DMABUF_RENDERER=0`
/// still means what it says and the faster path can be asked for on a machine
/// this misjudges. `/sys/module/nvidia` is there while the proprietary module
/// is loaded, and asking the filesystem starts no process; see clippy.toml.
#[cfg(target_os = "linux")]
fn prefer_software_compositing() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VAR).is_none() && Path::new("/sys/module/nvidia").exists() {
        // Sound only because nothing has started yet: this runs before the
        // builder, so there is no second thread to read the environment while
        // it is being written. The 2024 edition asks for `unsafe` here for
        // exactly that reason.
        std::env::set_var(VAR, "1");
    }
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
    // The directory test belongs in the search rather than after it. `find`
    // stops at the first argument that is not a flag and a later `filter`
    // then throws it away if it is not a folder, having already skipped the
    // fall back to `SANITY_OPEN` and passed over any real folder behind it.
    // A launcher that hands over a field code it did not expand is enough to
    // hit that: `sanity %F /repo` opened nothing.
    let from_arg = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_dir());
    let repo = from_arg
        .or_else(|| std::env::var("SANITY_OPEN").ok())
        .map(PathBuf::from)
        // Still needed: `SANITY_OPEN` has not been tested by the search.
        .filter(|p| p.is_dir())
        .map(|p| p.canonicalize().unwrap_or(p).to_string_lossy().into_owned());
    let lod = std::env::var("SANITY_LOD").ok().filter(|v| !v.trim().is_empty());
    Startup { repo, lod }
}

/// The text of one file, for the readable zoom level. Read on demand rather
/// than held: the payloads are compact, the source text is not.
///
/// `at` a commit when the canvas is showing the history: the file as it was
/// there, out of the object store rather than off the disk.
#[tauri::command]
async fn file_text(
    path: String,
    at: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.root.clone()
    };
    match at {
        Some(sha) => sanity_core::history::file_at(&root, &sha, &path)
            .map(|bytes| scan::display_text(&path, &bytes))
            .ok_or_else(|| format!("{path} is not in {sha}")),
        None => read_text(&root, &path),
    }
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
            repo.rows().into_iter().map(|f| f.path).collect::<Vec<_>>(),
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

/// Start writing a video to the path `stage_save` was given.
#[tauri::command]
fn video_open(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.save_to.lock().unwrap().take().ok_or("no file was chosen for the video")?;
    state.video.open(path)
}

/// A piece of the video, as a raw body: its offset, then its bytes.
#[tauri::command]
fn video_write(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("video_write expects a raw body".into());
    };
    state.video.write(bytes)
}

/// Finish the video, or throw it away; where it went, if it was kept.
#[tauri::command]
fn video_close(keep: bool, state: State<'_, AppState>) -> Result<Option<String>, String> {
    state.video.close(keep)
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
    // Before the builder, which is what makes the window and its webview:
    // WebKitGTK reads this when the web process starts, and the window from
    // tauri.conf.json exists before `.setup` below is reached.
    #[cfg(target_os = "linux")]
    prefer_software_compositing();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState {
                repo: Mutex::new(Repo::default()),
                watch: watch::WatchSlot::default(),
                save_to: Mutex::new(None),
                history: history::BlobCache::default(),
                video: video::VideoSlot::default(),
                scan: scanjob::ScanJob::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scanjob::scan_start,
            scanjob::scan_next,
            file_text,
            file_bytes,
            thumbs,
            pdf_page,
            find_text,
            startup,
            open_in_editor,
            refresh_files,
            stop_watch,
            drop_files,
            repo_index,
            stage_save,
            save_png,
            video_open,
            video_write,
            video_close,
            log_line,
            history::history_log,
            history::history_step
        ])
        .run(tauri::generate_context!())
        .expect("error while running sanity");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_object_id_is_taken_for_a_blob() {
        let id = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(version_blob(Some(&format!("blob:{id}"))), Some(id));
        assert_eq!(version_blob(Some("1712345678-2048")), None);
        assert_eq!(version_blob(Some("blob:--upload-pack=x")), None);
        assert_eq!(version_blob(Some("blob:HEAD")), None);
        assert_eq!(version_blob(None), None);
    }

    #[test]
    fn a_picture_at_a_commit_is_read_from_the_commit() {
        let dir = std::env::temp_dir().join(format!("sanity-picture-at-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            assert!(sanity_core::process::git(&dir).args(args).output().unwrap().status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(dir.join("a.png"), b"as it was").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.email=x@y", "-c", "user.name=Ada", "commit", "-qm", "one"]);
        let id = String::from_utf8(
            sanity_core::process::git(&dir).args(["rev-parse", "HEAD:a.png"]).output().unwrap().stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        // Changed on disk since, and then gone.
        std::fs::write(dir.join("a.png"), b"as it is").unwrap();
        assert_eq!(picture_bytes(&dir, "a.png", None).unwrap(), b"as it is");
        std::fs::remove_file(dir.join("a.png")).unwrap();
        let version = format!("blob:{id}");
        assert_eq!(picture_bytes(&dir, "a.png", Some(&version)).unwrap(), b"as it was");
        assert!(picture_bytes(&dir, "a.png", None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    // The cache key for a thumbnail. Worth a test because a key that does not
    // move when the file does would serve the old picture forever, and one
    // that moves when nothing did would make the cache pointless.
    #[test]
    fn a_thumbnail_key_follows_the_file_it_is_for() {
        let dir = std::env::temp_dir().join("sanity-thumb-key");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("picture.png");
        std::fs::write(&path, b"one").unwrap();
        let first = thumb_key(&path).unwrap();
        assert_eq!(first, thumb_key(&path).unwrap());
        // Same length, later modification time.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&path, b"two").unwrap();
        assert_ne!(first, thumb_key(&path).unwrap());
        // A different file, same contents.
        let other = dir.join("other.png");
        std::fs::write(&other, b"two").unwrap();
        assert_ne!(thumb_key(&path).unwrap(), thumb_key(&other).unwrap());
        assert!(thumb_key(&dir.join("missing.png")).is_none());
    }

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
    fn payload_fixture() -> Vec<(&'static str, &'static [u8])> {
        vec![("src/a.rs", &[1, 2, 3, 4]), ("b.ts", &[9]), ("c/d/e.py", &[7, 7, 7])]
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
            assert_eq!(&packed[offset..offset + bytes.len()], *bytes);
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
