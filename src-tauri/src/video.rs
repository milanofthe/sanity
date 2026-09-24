//! A video being written, in pieces as the window encodes it.
//!
//! A minute of 4K is a few hundred megabytes, which is not something to hold
//! in the window and then send in one go. So the muxer's output comes over as
//! it is made, each piece with the offset it belongs at: the muxer writes the
//! header last, into room it left at the start, so the pieces are not in
//! order.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

struct Open {
    path: PathBuf,
    file: File,
    written: u64,
}

/// The one video being written, if any.
#[derive(Default)]
pub struct VideoSlot(Mutex<Option<Open>>);

impl VideoSlot {
    /// Start a file at `path`, giving up any video still open.
    pub fn open(&self, path: PathBuf) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|e| e.to_string())?;
        if let Some(old) = slot.take() {
            // Left behind by a window that went away mid-export.
            let _ = std::fs::remove_file(&old.path);
        }
        let file = File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        *slot = Some(Open { path, file, written: 0 });
        Ok(())
    }

    /// Write a piece: eight bytes of offset, little endian, then the bytes.
    pub fn write(&self, piece: &[u8]) -> Result<(), String> {
        if piece.len() < 8 {
            return Err("a piece of video needs its offset".into());
        }
        let offset = u64::from_le_bytes(piece[..8].try_into().unwrap());
        let mut slot = self.0.lock().map_err(|e| e.to_string())?;
        let open = slot.as_mut().ok_or("no video is being written")?;
        open.file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        open.file.write_all(&piece[8..]).map_err(|e| e.to_string())?;
        open.written += (piece.len() - 8) as u64;
        Ok(())
    }

    /// Finish the file and say where it is, or throw it away when the export
    /// was cancelled or failed: half a video is not a video.
    pub fn close(&self, keep: bool) -> Result<Option<String>, String> {
        let mut slot = self.0.lock().map_err(|e| e.to_string())?;
        let Some(mut open) = slot.take() else { return Ok(None) };
        if !keep {
            drop(open.file);
            let _ = std::fs::remove_file(&open.path);
            return Ok(None);
        }
        open.file.flush().map_err(|e| e.to_string())?;
        open.file.sync_all().map_err(|e| e.to_string())?;
        // Unconditional, as for an image: one line saying where it went.
        eprintln!("sanity: wrote {} bytes to {}", open.written, open.path.display());
        Ok(Some(open.path.display().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn piece(offset: u64, bytes: &[u8]) -> Vec<u8> {
        let mut out = offset.to_le_bytes().to_vec();
        out.extend_from_slice(bytes);
        out
    }

    #[test]
    fn pieces_land_at_their_offsets_whatever_the_order() {
        let path = std::env::temp_dir().join(format!("sanity-video-{}.mp4", std::process::id()));
        let slot = VideoSlot::default();
        slot.open(path.clone()).unwrap();
        // Room left at the start, filled in last, as the muxer does it.
        slot.write(&piece(4, b"body")).unwrap();
        slot.write(&piece(8, b"!")).unwrap();
        slot.write(&piece(0, b"head")).unwrap();
        let at = slot.close(true).unwrap().unwrap();
        assert_eq!(std::fs::read(&at).unwrap(), b"headbody!");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_cancelled_video_leaves_no_file() {
        let path = std::env::temp_dir().join(format!("sanity-video-cancel-{}.mp4", std::process::id()));
        let slot = VideoSlot::default();
        slot.open(path.clone()).unwrap();
        slot.write(&piece(0, b"half")).unwrap();
        assert_eq!(slot.close(false).unwrap(), None);
        assert!(!path.exists());
        assert!(slot.write(&piece(0, b"late")).is_err());
    }
}
