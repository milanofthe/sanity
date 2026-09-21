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
  height, nested by directory. 83 to 99 percent of the canvas is panel,
  measured across seven repository shapes from 120 to 2500 files, and no panel
  is more than a tenth larger than the file in it needs at the 95th
  percentile. Long lines wrap rather than clip; no character is dropped.
- **Three levels of detail**, weighted as a partition of one so nothing
  double-draws through a transition. Below 1.8 pixels per line a file is one
  textured quad per column, sampled from a saturation-weighted mip chain.
  From 1.8 to 3.2 it hands over to one quad per token. From 4 to 6 it hands
  over to text.
- **Changes per save**, as an event rather than a state. A line diff against
  the version on screen, not against git: the lines that are going away are
  banded and fade out, then the new content lands and the lines that arrived
  are banded and settle. At the same moment the whole panel flashes for half a
  second, which is what says *where* something happened when a file is a few
  pixels tall, and the line bands are held for four seconds, which is what says
  *what*. A file that appeared arrives with every line marked; one that grew
  past its panel keeps its marks through the relayout. Then the canvas goes
  quiet and the frame loop stops: 42 frames for a change, against the 5400 a
  ninety second glow used to cost.
- **16 languages** through tree-sitter, plus a coarse lexer for Verilog-A and
  SPICE, which have no grammar that fits them. A code language gets a colour on
  70 to 89 percent of its characters, prose markup on less because prose is
  supposed to stay plain; `--example coverage` reports it per language and
  fails if one falls below what is expected of it.
- **Search from the toolbar**, over names and over text. Typing filters live:
  matching panels keep their brightness and take an accent border, everything
  else drops to a fifth, and the directories on the way to a match stay lit so
  the path is visible. Lines whose text matches are banded inside their panels.
  Enter walks what was found, files by name first and then hits line by line,
  flying the camera to each; Escape clears. The text search runs in the
  backend, which reads and scans the whole tree per keystroke, so nothing has
  to be held in memory: 11.6 MB in 5 to 6 milliseconds here, 18.6 MB in 7 to 8
  on a larger project.
- **Eight themes**: sanity's own, Mariana, One, Nord, Gruvbox, Monokai, and
  two light ones, Breakers and Solarized. The Theme menu shows each as a
  miniature of the canvas in it, ground, panel, header and token-coloured
  lines, rather than as three colour chips: the question when picking one is
  what your code looks like in it. A file type
  picker draws each extension in full, as a placeholder, or not at all. The
  placeholders of a directory are packed into a grid of named chips rather than
  put through the treemap, since a placeholder has a fixed size and carries no
  information about how large its file is.
- Read-only. A panel's header opens the file in `$SANITY_EDITOR`, `$VISUAL`,
  `$EDITOR`, or the platform handler.

![panels at a readable zoom](assets/screenshot-code.png)

## Measured

On [pathsim](https://github.com/pathsim/pathsim), 328 files and 71,278 lines
over 11.6 MB, release build, Apple M3.

| | |
|---|---|
| list the files | 9 ms |
| read and tokenise | 303 ms, across 8 cores |
| compute the layout | 5 ms |
| rasterise 328 overview textures | 108 ms |
| search every file for a word | 5 to 6 ms, across 8 cores |
| draw a frame | 0.20 to 0.90 ms of CPU |
| idle | 0.00 percent of a core |
| memory | 147 MB resident, 109 MB of texture |

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

`f` fits the whole project, `/` or the platform's find key jumps to the search
field, and a double click fits a panel or the project depending on what is
under the pointer.

`SANITY_LOD=a,b,c,d` moves the level-of-detail hand-over points.
`SANITY_WATCH_LOG=1` puts the watcher's batches on stderr, which is the only
way to see them: a Tauri window has no console a terminal can read.

## Checks

```sh
npm run check-all
```

Type checks, clippy with warnings denied, 106 TypeScript tests and 66 Rust
tests, then twelve checks that drive a real browser and assert on pixels: the
layout invariants, the dropdown geometry, that borders do not shimmer under a
subpixel pan, that a change flashes its panel and then stops, that no source text
is lost to wrapping, that a relayout re-uploads only what changed, that panels
animate and come to rest, that an idle canvas draws nothing, that the overview
texture is not smeared vertically, that a change plays as remove then add, and
that a search dims the project, lights its matches and flies to a line, and
that every theme is complete, legible and its own rather than falling back to
Mariana for whatever its block forgot. The
layout case list includes a project two thirds reduced to placeholders. Last, a
pass over this repository asserting that every language gets a colour on at
least as much of its text as it should.

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
