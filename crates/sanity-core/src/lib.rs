//! Repository scanning, tokenisation and change tracking for sanity.
//!
//! Deliberately free of any Tauri dependency: the shell in `src-tauri` is a
//! thin wrapper, and keeping the logic here means it can be tested and checked
//! without a WebView.

pub mod find;
pub mod lang;
pub mod scan;
pub mod simple;
pub mod tokenize;
pub mod wire;
