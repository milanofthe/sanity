//! Pages of a PDF as pictures, through the platform's own renderer.
//!
//! Through CoreGraphics rather than a PDF library: mupdf is AGPL and this is
//! MIT, pdfium is a ten megabyte binary to carry, and the operating system
//! already reads PDFs. It is reached through the objc2 bindings Tauri depends
//! on anyway. This replaced `sips`, which renders only the first page and
//! costs a process per page.
//!
//! Windows and Linux have no equivalent wired up yet, so a document's panel
//! keeps its placeholder there; see issue #22.

use std::path::Path;

/// Page `page`, counting from zero, rendered `width` pixels across on white,
/// as PNG.
#[cfg(target_os = "macos")]
pub fn render_page(path: &Path, page: u32, width: u32) -> Result<Vec<u8>, String> {
    use objc2_core_foundation::{CFURL, CGRect, CGPoint, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGContext, CGImageAlphaInfo,
        CGInterpolationQuality, CGPDFBox, CGPDFDocument, CGPDFPage,
    };

    let url = CFURL::from_file_path(path).ok_or("not a file path")?;
    let doc = CGPDFDocument::with_url(Some(&url)).ok_or("not a PDF CoreGraphics can read")?;
    let count = CGPDFDocument::number_of_pages(Some(&doc));
    if page as usize >= count {
        return Err(format!("page {page} of {count}"));
    }
    // CoreGraphics counts from one.
    let pg = CGPDFDocument::page(Some(&doc), page as usize + 1).ok_or("no such page")?;

    // The crop box as it is shown, which a page rotated by 90 or 270 degrees
    // shows sideways.
    let rect = CGPDFPage::box_rect(Some(&pg), CGPDFBox::CropBox);
    let turned = CGPDFPage::rotation_angle(Some(&pg)).rem_euclid(180) == 90;
    let (pw, ph) = if turned { (rect.size.height, rect.size.width) } else { (rect.size.width, rect.size.height) };
    if pw <= 0.0 || ph <= 0.0 {
        return Err("an empty page".into());
    }
    let w = width.clamp(16, 4096) as usize;
    let h = ((w as f64) * ph / pw).round().clamp(1.0, 8192.0) as usize;

    let space = CGColorSpace::new_device_rgb().ok_or("no colour space")?;
    let mut buf = vec![0u8; w * h * 4];
    // SAFETY: `buf` outlives the context, which draws into it and nowhere
    // else, and is exactly `h` rows of `w * 4` bytes.
    let ctx = unsafe {
        CGBitmapContextCreate(
            buf.as_mut_ptr().cast(),
            w,
            h,
            8,
            w * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0,
        )
    }
    .ok_or("no bitmap context")?;
    CGContext::set_interpolation_quality(Some(&ctx), CGInterpolationQuality::High);
    // Paper first: a page is ink on nothing, and a page is read on white.
    CGContext::set_rgb_fill_color(Some(&ctx), 1.0, 1.0, 1.0, 1.0);
    CGContext::fill_rect(
        Some(&ctx),
        CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: w as f64, height: h as f64 } },
    );
    // The page's own transform into the bitmap, which takes care of its
    // rotation and of where its crop box sits.
    let target = CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: w as f64, height: h as f64 } };
    let fit = CGPDFPage::drawing_transform(Some(&pg), CGPDFBox::CropBox, target, 0, true);
    CGContext::concat_ctm(Some(&ctx), fit);
    CGContext::draw_pdf_page(Some(&ctx), Some(&pg));
    // The context wrote into `buf`; make sure it is done with it.
    let _ = CGBitmapContextGetData(Some(&ctx));
    drop(ctx);

    sanity_core::thumb::encode_png(&buf, w as u32, h as u32).ok_or_else(|| "encoding failed".into())
}

#[cfg(not(target_os = "macos"))]
pub fn render_page(_path: &Path, _page: u32, _width: u32) -> Result<Vec<u8>, String> {
    Err("no PDF renderer on this platform yet".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Two pages: one 200 by 100 points with a red line, one 100 by 200 with a
    /// blue square. Hand-written, because a fixture would be a binary in the
    /// repository; CoreGraphics rebuilds the missing cross-reference table.
    const TWO_PAGES: &[u8] = b"%PDF-1.4\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n\
2 0 obj<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>endobj\n\
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>endobj\n\
4 0 obj<< /Length 31 >>stream\n1 0 0 RG 4 w 20 20 m 180 80 l S\nendstream\nendobj\n\
5 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Contents 6 0 R >>endobj\n\
6 0 obj<< /Length 29 >>stream\n0 0 1 rg 10 10 80 80 re f\nendstream\nendobj\n\
trailer<< /Root 1 0 R >>\n";

    fn size(png: &[u8]) -> (u32, u32) {
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']), "not a png");
        (
            u32::from_be_bytes([png[16], png[17], png[18], png[19]]),
            u32::from_be_bytes([png[20], png[21], png[22], png[23]]),
        )
    }

    #[test]
    fn every_page_renders_at_the_width_asked_for() {
        let dir = std::env::temp_dir().join(format!("sanity-pdf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("two.pdf");
        std::fs::write(&path, TWO_PAGES).unwrap();

        // The width asked for and each page's own proportion, so a fallback to
        // the first page or to the page's own size would fail here.
        assert_eq!(size(&render_page(&path, 0, 200).unwrap()), (200, 100));
        assert_eq!(size(&render_page(&path, 1, 200).unwrap()), (200, 400));
        assert!(render_page(&path, 2, 200).is_err(), "there is no third page");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// What a page costs, on a real document: `SANITY_PDF=path cargo test
    /// -p sanity --release -- --ignored page_cost --nocapture`.
    #[test]
    #[ignore]
    fn page_cost() {
        let path = std::path::PathBuf::from(std::env::var("SANITY_PDF").expect("SANITY_PDF"));
        for width in [256, 1024] {
            let t = std::time::Instant::now();
            let mut n = 0;
            while render_page(&path, n, width).is_ok() && n < 40 {
                n += 1;
            }
            let per = t.elapsed().as_secs_f64() * 1000.0 / n.max(1) as f64;
            println!("{n} pages at {width} px: {per:.1} ms a page");
        }
    }
}
