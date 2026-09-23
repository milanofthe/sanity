//! Pages of a PDF as pictures.
//!
//! Through hayro, a PDF rasteriser in pure Rust, so a page comes out the same
//! on macOS, Windows and Linux, and in the demo's dump, with nothing to ship
//! per platform. This replaced two things: `sips` on macOS, which renders only
//! the first page and costs a process per page, and nothing at all on Windows
//! and Linux. A CoreGraphics path was tried in between and dropped: besides
//! being one platform again, its page transform never scales up, so every
//! page rendered wider than it is in points came out small in a white margin.
//!
//! Measured in release on three documents, a page at 256 pixels across takes
//! 1 to 9 milliseconds and one at 1024 takes 9 to 44, PNG included. The large
//! ones are only ever asked for the few pages on screen.

use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{render, RenderCache, RenderSettings};

/// Widest a page is rendered, in pixels: past this a page costs more to make
/// than any screen can show of it.
pub const MAX_WIDTH: u32 = 2048;

/// How many pages a document has, or None when it cannot be read.
pub fn page_count(bytes: &[u8]) -> Option<usize> {
    Pdf::new(bytes.to_vec()).ok().map(|pdf| pdf.pages().len())
}

/// Page `page`, counting from zero, `width` pixels across on white, as PNG.
pub fn render_page(bytes: &[u8], page: usize, width: u32) -> Result<Vec<u8>, String> {
    let (rgba, w, h) = render_rgba(bytes, page, width)?;
    crate::thumb::encode_png(&rgba, w, h).ok_or_else(|| "encoding failed".into())
}

/// The same page as RGBA pixels, opaque, with its width and height.
pub fn render_rgba(bytes: &[u8], page: usize, width: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let pdf = Pdf::new(bytes.to_vec()).map_err(|e| format!("not a PDF that can be read: {e:?}"))?;
    let pages = pdf.pages();
    let Some(p) = pages.get(page) else {
        return Err(format!("page {page} of {}", pages.len()));
    };
    let (pw, ph) = p.render_dimensions();
    if pw <= 0.0 || ph <= 0.0 {
        return Err("an empty page".into());
    }
    let w = width.clamp(16, MAX_WIDTH) as f32;
    let scale = w / pw;
    let settings = RenderSettings { x_scale: scale, y_scale: scale, bg_color: WHITE, ..Default::default() };
    let pix = render(p, &RenderCache::new(), &InterpreterSettings::default(), &settings);
    // On white, so every pixel is opaque and premultiplied is the same as not.
    Ok((pix.data_as_u8_slice().to_vec(), pix.width() as u32, pix.height() as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two pages: one 200 by 100 points with a red line, one 100 by 200 with a
    /// blue square. Written with a correct cross-reference table, so this
    /// tests the renderer and not how forgiving its parser is.
    fn two_pages() -> Vec<u8> {
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>".to_string(),
            stream("1 0 0 RG 4 w 20 20 m 180 80 l S"),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Contents 6 0 R >>".to_string(),
            stream("0 0 1 rg 10 10 80 80 re f"),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, o) in objs.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).bytes());
        for o in offsets {
            out.extend(format!("{o:010} 00000 n \n").bytes());
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).bytes());
        out
    }

    fn stream(body: &str) -> String {
        format!("<< /Length {} >>\nstream\n{body}\nendstream", body.len())
    }

    fn decoded(png: &[u8]) -> image::RgbaImage {
        image::load_from_memory(png).expect("a png").to_rgba8()
    }

    #[test]
    fn every_page_renders_at_the_width_asked_for() {
        let pdf = two_pages();
        assert_eq!(page_count(&pdf), Some(2));
        // The width asked for and each page's own proportion.
        let first = decoded(&render_page(&pdf, 0, 200).unwrap());
        assert_eq!(first.dimensions(), (200, 100));
        let second = decoded(&render_page(&pdf, 1, 200).unwrap());
        assert_eq!(second.dimensions(), (200, 400));
        assert!(render_page(&pdf, 2, 200).is_err(), "there is no third page");
    }

    #[test]
    fn a_page_is_drawn_to_its_edges_and_on_white() {
        // Twice the page's own width: the renderer this replaced never scaled
        // up, and drew such a page small in a white margin.
        let second = decoded(&render_page(&two_pages(), 1, 200).unwrap());
        let px = |x, y| second.get_pixel(x, y).0;
        assert_eq!(px(2, 2), [255, 255, 255, 255], "white paper in the corner");
        // The blue square covers 10 to 90 points of 100, so the middle of the
        // lower part of the page, in pixels 40 to 360 across the 400 tall.
        let blue = px(100, 300);
        assert!(blue[2] > 200 && blue[0] < 60, "the square is blue where it should be: {blue:?}");
    }
}
