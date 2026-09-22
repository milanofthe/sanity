//! What the header readers make of real files.
//!
//! Run with: cargo run --release -p sanity-core --example probe -- <file>...

use sanity_core::media;

fn main() {
    let mut images = 0;
    let mut docs = 0;
    let mut unknown = 0;
    for path in std::env::args().skip(1) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        match media::probe(&path, &bytes) {
            Some(media::Media::Image { w, h }) => {
                images += 1;
                println!("image     {w}x{h}  {path}");
            }
            Some(media::Media::Document { pages, w, h }) => {
                docs += 1;
                let pages = if pages == 0 { "?".to_string() } else { pages.to_string() };
                println!("document  {pages} pages of {w}x{h} pt  {path}");
            }
            None => {
                unknown += 1;
                println!("unknown   {path}");
            }
        }
    }
    println!("\n{images} images, {docs} documents, {unknown} not read");
}
