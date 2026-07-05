# CV Variable Preview

Inspect Python debug variables as images, tables, and grids — directly inside VS Code, without writing a single line of display code.

▶ **[Watch demo video](https://github.com/ariharasudhanm/cv-variable-preview/releases/download/v0.2.0/demo.mp4)**



Hover over a variable name to see a thumbnail. Right-click a variable in the **Variables** or **Watch** panel to open a full zoomable preview. Turn on **Live** mode and the panel auto-refreshes as you step through your code.



---

## Features

### Instant preview — no typing required

Right-click any variable in the **Variables** or **Watch** debug panel and choose **CV Preview: Preview as Image** to open the preview panel immediately, using the correct stack frame without any prompts.

### Hover thumbnails

While paused in the debugger, hover over a variable name in the editor to see a compact thumbnail, shape, dtype, and an **Open Preview ▸** link — all without leaving the file. Thumbnails are downscaled to 96 px and embedded inline, so even large images appear instantly. Toggle via the `cvPreview.enableHoverPreview` setting.

### Zoom, pan, and pixel inspection

The preview panel renders images on a canvas element:

- **Scroll wheel** or **− / + / Reset** toolbar buttons to zoom up to 16×
- Pixel-perfect rendering at zoom > 100 % (`image-rendering: pixelated`)
- Hover over any pixel to see its displayed value **and** an approximate original value back-calculated from the array's min/max
- Live **per-channel histogram** (32 bins) computed directly from the pixel data

### Side-by-side comparison

- **Pin** the current view to the grid (one click, no typing)
- Right-click any variable and choose **CV Preview: Add to Compare** to add it to the grid directly from the Variables panel
- Click any grid thumbnail to promote it back to single view with full inspection tools

### Live auto-refresh while stepping

Toggle **Live** in the toolbar: the preview updates automatically each time the debugger pauses (after F10/F11 step, breakpoint hit, etc.). Live mode resets to Off on every new session so it never runs unexpectedly.

### Supported types

| Type | How it renders |
| --- | --- |
| `numpy.ndarray` | Image (auto-normalised to uint8) |
| `PIL.Image.Image` | Image (all modes including palette) |
| `torch.Tensor` | Image (CPU or CUDA, with or without grad) |
| `tensorflow.Tensor` | Image (eager tensors) |
| `pandas.DataFrame` / `Series` | Scrollable table (up to 200 rows) |
| `list` / `tuple` of arrays | Grid of images |
| `(N, H, W, C)` / `(N, C, H, W)` batch | Grid of images (up to 64 items) |

**Shapes:** `(H, W)`, `(H, W, 1)`, `(H, W, 3)`, `(H, W, 4)`, `(3, H, W)`, `(4, H, W)` and their batched forms.

**Dtypes:** `uint8`, any float, bool, and integer arrays (auto-normalised).

**Channel orders:** RGB/RGBA (default) or BGR/BGRA for OpenCV arrays.

---

## Requirements

- VS Code 1.90 or later
- A **Python debug session** paused at a breakpoint (any Python debugger that uses the Debug Adapter Protocol — the built-in Python extension, debugpy, etc.)
- **Pillow** or **OpenCV** installed in the Python environment being debugged:

```bash
pip install pillow
# or
pip install opencv-python
```

`torch`, `tensorflow`, and `pandas` are only needed if you want to preview those types.

---

## Installation

Install from the `.vsix` file:

```bash
code --install-extension cv-variable-preview-0.2.0.vsix
```

After installation **fully quit and relaunch VS Code** — a `Developer: Reload Window` alone does not always reload the extension host, especially when a debug session is involved.

---

## Usage

### Preview a variable

1. Start a Python debug session and pause at a breakpoint.
2. In the **Variables** or **Watch** panel, right-click the variable you want to inspect.
3. Choose **CV Preview: Preview as Image**.

The panel opens beside your editor. For OpenCV arrays, choose **BGR / BGRA** when prompted (the default is RGB).

### Hover preview

Hover over a variable name in the source file while the debugger is paused. A thumbnail and metadata appear after a short delay. Click **Open Preview ▸** in the tooltip to open the full panel.

> **Tip:** If the tooltip doesn't appear or disappears too quickly, hold **Alt** while hovering to force it to stay visible. You can also use the keyboard shortcut **`Ctrl+K Ctrl+I`** (`Cmd+K Cmd+I` on macOS) to show the hover info for the word under the cursor without using the mouse.

### Compare variables

**Option A — from the Variables panel (recommended):**

1. Right-click the first variable → **CV Preview: Preview as Image**
2. Right-click another variable → **CV Preview: Add to Compare**
3. Repeat for as many variables as you like; a grid appears automatically.

**Option B — using Pin:**

1. Open a preview.
2. Click **Pin** in the toolbar to add it to the comparison grid.
3. Open another preview and click **Add to Compare…** to add more by expression.

Click any thumbnail in the grid to bring it back to single view.

### Live mode

1. Open a preview.
2. Click **Live: Off** in the toolbar to toggle it on.
3. Step through your code (F10 / F11) — the panel updates after each pause.
4. Click **Live: On** to stop auto-refreshing.

### Typed command

`CV Preview: Preview Variable as Image` in the Command Palette lets you type any Python expression (not just simple identifiers) to preview — for example `model.encoder.weight[0]` or `batch["image"][0]`.

---

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cvPreview.channelOrder` | `RGB` | Channel interpretation for 3/4-channel arrays: `RGB` (numpy, Pillow, matplotlib) or `BGR` (OpenCV). |
| `cvPreview.enableHoverPreview` | `true` | Show inline thumbnails and metadata when hovering a variable name while paused. |
| `cvPreview.defaultExpression` | `img` | Default expression prefilled in the typed-command input box. |

---

## Known limitations

- **Temp PNG files are not deleted.** The Python helper writes one temp PNG per image (and one per grid item for batches/lists). VS Code reads them once but neither side cleans them up. OS temp directories (`/tmp`, `%TEMP%`) are typically cleared on reboot.
- **Batches and lists are capped at 64 items.** Larger batches are truncated; the metadata reports the original count.
- **DataFrame/Series previews are capped at 200 rows.**
- **Symbolic/graph TensorFlow tensors are not supported** — only eager tensors (`.numpy()` must work).
- **Hover expression resolution is word-only.** The hover provider uses VS Code's word range, so it fires on simple identifiers. Complex expressions like `arr[0]` require the typed command or right-click menu.

---

## Development

```bash
npm install       # install TypeScript toolchain
npm run compile   # compile to out/
npm run package   # compile + build .vsix
```

Install Python sample dependencies:

```bash
pip install -r samples/requirements.txt
pip install -r samples/requirements-extra.txt   # optional: torch, tensorflow
```

The samples are in `samples/`:

| File | What it exercises |
| --- | --- |
| `python_numpy_debug.py` | Basic numpy arrays and live-refresh stepping |
| `python_real_images_debug.py` | Real scikit-image photos (coins, moon, camera…) |
| `python_advanced_types_debug.py` | pandas, batch arrays, torch tensors |

### Publishing a GitHub release

Users can install the extension directly from a GitHub release without cloning the repo. To publish one:

1. **Tag the commit** and push the tag:

   ```bash
   git tag v0.2.0
   git push origin main --tags
   ```

2. **Build the installable VSIX:**

   ```bash
   npm run package
   # produces cv-variable-preview-0.2.0.vsix
   ```

3. **Create the release on GitHub:**
   - Go to your repository → **Releases** → **Draft a new release**
   - Under *Choose a tag*, select the tag you just pushed (`v0.2.0`)
   - Set the release title, e.g. `v0.2.0`
   - Drag the `.vsix` file into the **Assets** section
   - Click **Publish release**

Users can then download the `.vsix` from the Assets section and install it with:

```bash
code --install-extension cv-variable-preview-0.2.0.vsix
```

---

## Architecture notes

The extension follows a strict split: all image/table/grid conversion logic runs as Python code evaluated in the active debug frame via the Debug Adapter Protocol `evaluate` request. The TypeScript layer is only responsible for VS Code integration, the webview, and reading the temp PNG files written by the Python helper. No image libraries are required on the TypeScript side.
