#!/usr/bin/env bash
# The GStreamer plugins the AppImage carries, gathered into one directory for
# linuxdeploy's GStreamer plugin to copy.
#
# WebKitGTK encodes WebCodecs video through GStreamer, and the AppImage brings
# its own libgstreamer but, without these, no plugins: linuxdeploy rewrites the
# library's built-in plugin path to a relative one that points nowhere, so the
# registry comes up empty and "Export history" finds no encoder at all, however
# many the machine has installed. `bundleMediaFramework` in tauri.conf.json
# turns the copying on; this decides what gets copied, since left to itself it
# takes every plugin on the build machine, which on a desktop distribution is
# hundreds of them and their libraries.
#
# VP9 only. It is what the export falls back to after H.264 (see
# web/src/lib/video.ts), libvpx is BSD licensed and the format royalty free.
# x264 is GPL and H.264 is patent encumbered, which an MIT licensed download
# should not take on without someone deciding to.
#
#   env $(scripts/appimage-gstreamer.sh target/gstreamer) \
#     NO_STRIP=true npx tauri build --bundles appimage
#
# Prints the two variables the plugin reads as NAME=value lines, which is what
# both `env` and $GITHUB_ENV take. (NO_STRIP is for Arch, whose libraries the
# strip inside linuxdeploy cannot read; CI does without it.)
set -euo pipefail

out="${1:?usage: $0 <output directory>}"

# Debian puts plugins under the multiarch triplet, Arch and Fedora do not.
for d in "/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0" /usr/lib64/gstreamer-1.0 /usr/lib/gstreamer-1.0; do
  if [ -f "$d/libgstcoreelements.so" ]; then src="$d"; break; fi
done
[ -n "${src:-}" ] || { echo "no GStreamer plugin directory found" >&2; exit 1; }

# gst-plugin-scanner lives beside the plugins on Arch and in a directory of its
# own on Debian. Without it the bundled GStreamer still works, scanning in
# process, but the plugin points GST_PLUGIN_SCANNER at where it would be.
for s in "/usr/lib/$(uname -m)-linux-gnu/gstreamer1.0/gstreamer-1.0" /usr/libexec/gstreamer-1.0 "$src"; do
  if [ -x "$s/gst-plugin-scanner" ]; then scanner="$s/gst-plugin-scanner"; break; fi
done

rm -rf "$out"
mkdir -p "$out/plugins" "$out/helpers"

need() {
  [ -f "$src/libgst$1.so" ] || { echo "missing GStreamer plugin: $1 (in $src)" >&2; exit 1; }
  cp "$src/libgst$1.so" "$out/plugins/"
}
want() {
  if [ -f "$src/libgst$1.so" ]; then cp "$src/libgst$1.so" "$out/plugins/"; fi
}

need coreelements
need app
need vpx
# One plugin from GStreamer 1.22, two before it (Ubuntu 22.04 has 1.20).
if [ -f "$src/libgstvideoconvertscale.so" ]; then
  need videoconvertscale
else
  need videoconvert
  need videoscale
fi
# What WebKit's autovideoflip resolves to, for frames that carry a rotation.
# The encoder works without them.
want autoconvert
want videofilter

if [ -n "${scanner:-}" ]; then cp "$scanner" "$out/helpers/"; fi

out="$(cd "$out" && pwd)"
echo "GSTREAMER_PLUGINS_DIR=$out/plugins"
echo "GSTREAMER_HELPERS_DIR=$out/helpers"
