# PDF Page Turn

An [Obsidian](https://obsidian.md) plugin built for **Obsidian Mobile on iPad**. When a PDF file is open, it overlays two invisible touch zones on top of the PDF view:

- **Right third of the screen** — tap to advance one page.
- **Left third of the screen** — tap to go back one page.
- **Middle third** — untouched, so you can still scroll, select text, and interact with the PDF normally.

## How it works

- The active PDF view is detected via Obsidian's workspace events (`active-leaf-change`, `layout-change`, `file-open`), so the overlay follows you as you switch panes, split leaves, or open new PDFs.
- Page turns are driven entirely by **touch events** (`touchstart` / `touchmove` / `touchend`), not click events. A touch only counts as a "tap" if it stays within a small movement threshold and resolves quickly; anything that moves further (a scroll or a swipe) is left completely alone.
- Each tap scrolls the PDF's scroll container by exactly one page height, computed from the actual rendered page elements so taps land on page boundaries.
- A small margin is kept clear at the very left and right edges of the screen, and touch/scroll gestures are never intercepted before they're confirmed as a tap, so the overlay stays out of the way of Obsidian's swipe-to-go-back gesture on iPad.

## Settings

A single toggle in the plugin's settings tab turns the overlay on or off.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # type-check + production build
```

This produces `main.js`, which along with `manifest.json` and `styles.css` is what Obsidian loads from the plugin's folder (e.g. `<vault>/.obsidian/plugins/pdfpageturn/`).
