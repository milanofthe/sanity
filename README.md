<p align="center">
  <img src="assets/sanity-logo.png" width="340" alt="sanity">
</p>

Opens a folder and draws every file in it at once. Each file that git does not
ignore becomes a read-only panel, panels are packed by directory, and the whole
project fits on one screen. Zoomed out you see its shape; zoomed in you read
the code. Saves are picked up live and the lines that changed are marked.

It is meant to run in the background as a monitor, including while coding
agents work in the repository.

Try it on four public repositories, in the browser, no install:
[sanity.milanrother.com](https://sanity.milanrother.com/).

## Install

[Releases](https://github.com/milanofthe/sanity/releases) carry a `.dmg` for
macOS, Intel and Apple Silicon in one file, and an installer for Windows.
Neither build is signed, so the first launch needs a right click and Open on
macOS, and More info then Run anyway on Windows. Building from source is
`npm ci && npm ci --prefix web && npx tauri build`.

![the whole project at once](assets/screenshot-project.png)

## What it does

- **Layout.** A squarified treemap on an integer grid, one cell per line
  height, nested by directory. 83 to 99 percent of the canvas is panel,
  measured across seven repository shapes from 120 to 2500 files, and no panel
  is more than a tenth larger than the file in it needs at the 95th
  percentile. Long lines wrap rather than clip; no character is dropped, and a
  tab is four columns in the wire format and on screen alike.
- **Language tint, off by default.** A switch in the View menu colours the
  outermost zoom by language family, at each texel's own luminance, so a
  directory of YAML reads as a different kind of thing from a directory of
  code. Measured by `lang-check`: colour predicts the family 8.5 times better
  than it did untinted, and 100 percent of the within-panel structure
  survives. Off unless asked for, because the thing this canvas is usually
  watched for is where something changed, and a second colour scheme competes
  with that.
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
- **Pictures as pictures.** An image file is a panel like any other, in the
  image's own proportion and at most one code column wide, which is what makes
  a figure read as another column of the thing it belongs to rather than as a
  poster. A PDF shows its first page, at the page's own shape: the size and
  the rotation are read out of the file, including out of the compressed
  object streams a third of PDFs keep their page tree in, so a 16:9 slide deck
  is a 16:9 panel rather than an A4 one. Measured against `pdfinfo` over 25
  documents: 25 exact. The page itself is rendered by
  the platform in the app (ImageIO on macOS; Windows and Linux keep the
  placeholder for now, see issue #22) and rendered into the dump for the web
  demo, through a separate process rather than a linked library, since the
  good PDF renderers are AGPL and this is MIT. Whatever it came from, a page
  and a plot are ink with nothing behind them, so a picture that carries no
  background of its own is drawn on a sheet of paper rather than on the canvas
  ground.

  Pictures arrive in two steps. The backend thumbnails every one of them at
  128 pixels, across its cores and cached on disk by path, size and
  modification time, and that is what the canvas draws at any zoom where a
  panel is smaller than that. Only a panel somebody has zoomed into falls
  through to the source, decoded to the level under its own width and no
  further: holding the source pixels of pathsim's 47 images would be 730 MB
  against the 96 MB its whole code costs, and the budget for all of it is
  64 MB, shared between what is on screen.

  Decodes are paced rather than run as a burst, widest panel first, and none
  start while the camera is moving, apart from a picture being drawn from so
  little that waiting would show mush. Measured on a folder of 119 screenshots
  in WebKit, which is the engine the app ships: opening it went from 6999 ms of
  decoding and 69 MB read to 407 ms and 1.1 MB, a zoom sweep across the whole
  project asks for nothing at all, and zooming into one picture has it at full
  resolution 243 ms later.
- **Notebooks as cells**, not as the JSON they are stored in. A `.ipynb` is
  read into its code cells, its prose cells and one line per output naming
  what it is, so what a panel shows is the notebook. On pathsim's 34 notebooks
  that is 5733 lines instead of 12,634, 9 percent of the repository instead of
  18, and no base64.
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
- **Export to PNG**, from the right click menu: the view, or the whole project,
  into a 4K box at the aspect of what it frames, so there is no border around
  it. Not a screenshot of the window, since level of detail follows from pixels
  per line: the same rect rendered into a 4K frame draws at 1.5 pixels per line
  where the window had 0.5, so the image has three times the detail in it
  rather than three times the pixels. Takes about 130 ms.
- Read-only. A panel's header opens the file in `$SANITY_EDITOR`, `$VISUAL`,
  `$EDITOR`, or the platform handler.

![panels at a readable zoom](assets/screenshot-code.png)

## Measured

On [pathsim](https://github.com/pathsim/pathsim), 328 files and 64,377 lines
over 11.6 MB, release build, Apple M3. (It was 71,278 before notebooks were
read as their cells; the difference was JSON and base64.)

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

## The web demo

```sh
npm run demo           # clone the four repositories and dump them
npm run dev            # http://localhost:5183
```

The site at [sanity.milanrother.com](https://sanity.milanrother.com/) is this
app with four public repositories baked in, read over HTTP rather than from
disk: pathsim, rslab, rapidfem and nanospice. Same scan format, same decode,
same layout, same renderer. What it cannot do is watch, since a dump is a
snapshot of a head and there is no folder behind it.

The dumps are generated rather than committed, and `.github/workflows/pages.yml`
runs that command before it builds, so the site is made from the heads of those
four repositories and rebuilt weekly. The text of a repository is fetched after
its structure: pathsim's canvas is up after 0.4 MB and 0.9 seconds, while the
4 MB of text arrives behind it.

## Checks

```sh
npm run check-all
```

Type checks, clippy with warnings denied, 106 TypeScript tests and 66 Rust
tests, then sixteen checks that drive a real browser and assert on pixels: the
layout invariants, the dropdown geometry, that borders do not shimmer under a
subpixel pan, that a change flashes its panel and then stops, that no source text
is lost to wrapping, that a relayout re-uploads only what changed, that panels
animate and come to rest, that an idle canvas draws nothing, that the overview
texture is not smeared vertically, that a change plays as remove then add, and
that a search dims the project, lights its matches and flies to a line, and
that every theme is complete, legible and its own rather than falling back to
Mariana for whatever its block forgot, and that the text on screen is the text
in the file, character for character, compared against the bytes on disk rather
than against the canvas's own copy of them, and that the
demo opens every repository it lists with its text in place, and that a PNG
export is a 4K picture of the project, at the project's aspect with no
padding on any side, and that it leaves the canvas as it found it, and that a
picture in a repository is drawn, at a resolution that follows the zoom,
inside its budget, in its own proportion, a PDF's first page included.
The layout case list includes a project two thirds reduced to placeholders. Last, a
pass over this repository asserting that every language gets a colour on at
least as much of its text as it should.

`SANITY_SRC=demo=pathsim npm run glyph-check` points the text check at one of
the demo repositories instead of the fixture, which is how the notebook path
gets checked: a notebook's lines exist nowhere on disk, so the text the
renderer draws and the text the check compares against could drift apart while
both look plausible.

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

## Licence

MIT, see [LICENSE](LICENSE).
