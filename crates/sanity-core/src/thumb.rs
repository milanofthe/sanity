//! Small versions of the pictures in a repository, made here rather than in
//! the browser.
//!
//! The canvas needs every picture at the size its panel is drawn at, and at
//! the zoom this app is watched at that size is a hundred pixels across. Left
//! to the frontend that still costs a full decode of the source: WebKit, which
//! is what the desktop app draws into, takes 2.1 seconds over a folder of 119
//! screenshots, and 41 MB crosses the process boundary to produce 119 smudges.
//!
//! Decoded here instead, in parallel, the same folder is 241 milliseconds and
//! 1 MB, and the frontend decodes 128 pixel PNGs, which costs about a
//! millisecond each. Anything larger than a thumbnail is still fetched and
//! decoded from the source, because that only happens for the handful of
//! panels somebody has zoomed into.

use std::io::Cursor;

/// Longest edge of a thumbnail, in pixels.
///
/// 128 covers every panel up to about a sixth of the window, which is past the
/// point where a picture in this app is a picture rather than a mark. Above it
/// the source is used. Four times the area of the 64 an overview panel needs,
/// so a little zooming does not immediately fall through to the source.
pub const THUMB_MAX: u32 = 128;

/// A thumbnail as PNG bytes, or None when the bytes are not a picture this
/// build can read.
///
/// PNG and not JPEG: a plot or a screenshot at this size is flat colour and
/// thin lines, which PNG holds exactly and small, and the alpha channel is
/// what tells the canvas to put a sheet of paper under it.
pub fn thumbnail(bytes: &[u8], max: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    // `thumbnail` rather than `resize`: a box filter over a picture that is
    // about to be drawn at a hundred pixels, which is what the mip chain on
    // the other side does anyway, at a fraction of the cost of Lanczos.
    let small = img.thumbnail(max, max);
    let mut out = Vec::new();
    small.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
    Some(out)
}

/// Thumbnails for many files at once, one thread per core.
///
/// Takes what to read rather than the bytes, so a caller does not have to hold
/// a folder of screenshots in memory to get a folder of thumbnails out.
/// Returns them in the order asked for, with None where a file could not be
/// read or decoded.
pub fn thumbnails(paths: &[std::path::PathBuf], max: u32) -> Vec<Option<Vec<u8>>> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut out: Vec<Option<Vec<u8>>> = (0..paths.len()).map(|_| None).collect();
    std::thread::scope(|scope| {
        // One slice of the output per thread, handed out by `chunks_mut`, so
        // there is nothing to lock and nothing to collect afterwards.
        let per = paths.len().div_ceil(threads.max(1)).max(1);
        for (chunk, slot) in paths.chunks(per).zip(out.chunks_mut(per)) {
            scope.spawn(move || {
                for (path, into) in chunk.iter().zip(slot.iter_mut()) {
                    let Ok(bytes) = std::fs::read(path) else { continue };
                    *into = thumbnail(&bytes, max);
                }
            });
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 4 by 2 PNG, written by hand so the test does not depend on the
    /// encoder it is testing the decoder of.
    fn tiny_png() -> Vec<u8> {
        let mut img = image::RgbaImage::new(400, 200);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn a_thumbnail_keeps_the_picture_s_proportion() {
        let png = tiny_png();
        let small = thumbnail(&png, 128).unwrap();
        let img = image::load_from_memory(&small).unwrap();
        assert_eq!((img.width(), img.height()), (128, 64));
        assert!(small.len() < png.len());
    }

    #[test]
    fn what_is_not_a_picture_has_no_thumbnail() {
        assert!(thumbnail(b"#!/bin/sh\necho hello\n", 128).is_none());
        assert!(thumbnail(&[], 128).is_none());
    }

    #[test]
    fn a_batch_answers_in_the_order_it_was_asked() {
        let dir = std::env::temp_dir().join("sanity-thumb-test");
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.png");
        let bad = dir.join("bad.png");
        std::fs::write(&good, tiny_png()).unwrap();
        std::fs::write(&bad, b"not a picture").unwrap();
        let out = thumbnails(&[bad.clone(), good.clone(), dir.join("missing.png")], 64);
        assert_eq!(out.len(), 3);
        assert!(out[0].is_none());
        assert!(out[1].is_some());
        assert!(out[2].is_none());
        let img = image::load_from_memory(out[1].as_ref().unwrap()).unwrap();
        assert_eq!(img.width(), 64);
    }
}
