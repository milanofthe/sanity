//! Child processes, started without a window of their own.
//!
//! The app is a windowed program, and on Windows every console program it
//! starts gets a console window of its own unless it is told not to. The app
//! starts `git` for every scan, every change the watcher reports and every
//! step through the history, so without this a console flashed up over the
//! window each time. Everything the app runs goes through here; clippy refuses
//! `Command::new` anywhere else (see clippy.toml), so nothing can start one
//! the old way by accident.

use std::ffi::OsStr;
use std::process::Command;

/// `CREATE_NO_WINDOW`, from the Windows process creation flags.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command for `program` that opens no console window. The same as
/// `Command::new` everywhere but Windows.
#[allow(clippy::disallowed_methods)]
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(program);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    Command::new(program)
}

/// `git -C root`, with no window.
pub fn git(root: impl AsRef<OsStr>) -> Command {
    let mut c = command("git");
    c.arg("-C").arg(root);
    c
}
