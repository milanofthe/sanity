<p align="center">
  <img src="assets/sanity-logo.png" width="340" alt="sanity">
</p>

Opens a folder and draws every file in it at once. Each file that git does not
ignore becomes a read-only panel, panels are packed by directory, and the whole
project fits on one screen. Zoomed out you see its shape; zoomed in you read
the code. Saves are picked up live and the lines that changed are marked.

It is meant to run in the background as a monitor, including while coding
agents work in the repository.

![the whole project at once](assets/screenshot-project.png)

## What it does

- **Layout.** A squarified treemap on an integer grid, one cell per line
  height, nested by directory. 86 to 99 percent of the canvas is panel,
  measured across seven repositories from 120 to 2500 files. Long lines wrap
  rather than clip; no character is dropped.
- **Three levels of detail**, weighted as a partition of one so nothing
  double-draws through a transition. Below 1.8 pixels per line a file is one
  textured quad per column, sampled from a saturation-weighted mip chain.
  From 1.8 to 3.2 it hands over to one quad per token. From 4 to 6 it hands
  over to text.
- **Changes per save.** A line diff against the version on screen, not against
  git: the lines that are going away are banded and fade out, then the new
  content lands and the lines that arrived are banded and settle. The marks
  fade with the panel's glow, which decays over 90 seconds.
- **16 languages** through tree-sitter, plus a coarse lexer for Verilog-A and
  SPICE, which have no grammar that fits them. A code language gets a colour on
  63 to 88 percent of its characters, prose markup on less because prose is
  supposed to stay plain; `--example coverage` reports it per language and
  fails if one falls below what is expected of it.
- **Four themes**: Mariana, Monokai, Breakers, and sanity's own. A file type
  picker draws each extension in full, as a placeholder, or not at all.
- Read-only. A panel's header opens the file in `$SANITY_EDITOR`, `$VISUAL`,
  `$EDITOR`, or the platform handler.

![panels at a readable zoom](assets/screenshot-code.png)

## Measured

On `sane`, 1062 files and 217,831 lines, release build, Apple M3.

| | |
|---|---|
| list the files | 16 ms |
| read and tokenise | 349 ms, across 8 cores |
| compute the layout | 19 ms |
| rasterise 989 overview textures | 308 ms |
| draw a frame | 0.32 to 1.32 ms of CPU |
| idle | 0.00 percent of a core |
| memory | 196 MB resident, 249 MB of texture |

Idle is zero because the renderer draws on demand: the frame loop stops when
nothing is moving and the watch thread blocks until the filesystem says
something happened.

## Running it

```sh
npm install && npm install --prefix web
npm run app            # tauri dev
npm run app:build      # a bundle in src-tauri/target/release
```

The built binary takes the folder as its first argument, or reads
`SANITY_OPEN`; with neither it shows generated data until one is chosen from
the Project menu.

```sh
sanity /path/to/repo
```

`SANITY_LOD=a,b,c,d` moves the level-of-detail hand-over points.
`SANITY_WATCH_LOG=1` puts the watcher's batches on stderr, which is the only
way to see them: a Tauri window has no console a terminal can read.

## Checks

```sh
npm run check-all
```

Type checks, clippy with warnings denied, 71 TypeScript tests and 58 Rust
tests, then ten checks that drive a real browser and assert on pixels: the
layout invariants, the dropdown geometry, that borders do not shimmer under a
subpixel pan, that the glow reacts to a change and fades, that no source text
is lost to wrapping, that a relayout re-uploads only what changed, that panels
animate and come to rest, that an idle canvas draws nothing, that the overview
texture is not smeared vertically, and that a change plays as remove then add.
Last, a pass over this repository asserting that every language gets a colour
on at least as much of its text as it should.

`npm run icons` regenerates the mark: one description produces the app icon,
the favicon and the toolbar component.

## Layout

```
crates/sanity-core     scan, tokenise, wire format. No Tauri dependency.
src-tauri              the shell: commands, the file watcher
web/src/lib/canvas     camera, layout, and the WebGL2 renderer
web/src/lib/ui         components and tokens
web/scripts            the browser checks and the icon generator
```

Design decisions and measurements are tracked as GitHub issues, not as files
here.
