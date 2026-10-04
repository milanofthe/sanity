Download the file for your machine, install it, open a folder.

**macOS** (`.dmg`, Intel and Apple Silicon in one): the build is
not notarised, so the first launch needs a right click on the app
and then Open, which gives you a dialog that has an Open button.
Double clicking it gives you one that does not.

**Windows** (`.exe` installer, or the `.msi`): the build is not
signed, so SmartScreen shows "Windows protected your PC". More
info, then Run anyway.

**Linux** (`.AppImage`, x86-64): `chmod +x` it and run it. It needs
nothing installed except `libfuse2`, which several distributions no
longer ship; without it the file refuses to start, and
`./sanity.AppImage --appimage-extract-and-run` runs it anyway. If
the window opens blank, the webview could not allocate its buffer:
start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1` in the
environment. On NVIDIA the app already does that for itself.
