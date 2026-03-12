# gridOCR

**gridOCR** is a desktop OCR tool for digitising historical printed books and periodicals — particularly 19th-century volumes with running headers, footnotes, and bleed-through from aged paper. It runs entirely locally: no cloud, no subscription, no data leaving your machine.

It splits double-page spreads, detects text regions with OpenCV, runs Tesseract OCR, and lets you correct regions manually before exporting clean plain text.

![gridOCR interface](docs/screenshot.png)
<!-- Replace with an actual screenshot -->

---

## Features

- **Automatic spread splitting** — detects and splits double-page scans at the spine gutter; falls back to geometric centre if contrast is too low; handles single-page images automatically by aspect ratio
- **OpenCV region detection** — finds body text, running headers, page numbers, and footnotes using morphological operations and heuristic classification; strips camera/scanner dark borders and binding edge strips automatically
- **Bleed-through suppression** — two-pass relative sharpness filter discards ghost text from the reverse side of thin paper without discarding real content; works across DPI and paper quality variations
- **Tesseract OCR** — per-region preprocessing (upscale, background normalisation, adaptive binarisation, denoising) tuned for period typography; uses `tessdata_best` LSTM models automatically when available
- **Multi-script support** — English, Bengali, Hindi, Sanskrit, French, German, Latin; language pack and script are selectable per project
- **Manual region editing** — draw, resize, move, retype, or delete regions directly on the page image in the browser UI; changes are reflected in OCR output immediately
- **Volume template learning** — after a minimum of 3 confirmed pages, the detector learns the expected layout of a volume (Welford online statistics) and blends template predictions with fresh detections on subsequent pages
- **Reading-order text export** — exports clean plain text in reading order (header → body → footnote) with no scaffolding labels; page numbers omitted by default
- **Project save/load** — full project state (volumes, spreads, segments, OCR results) saved as `.gridocr` JSON files
- **Extensible exporter architecture** — plain TXT exporter included; TEI XML and other formats can be added by dropping a new file in `frontend/exporters/`
- **Fully local** — Flask + Python sidecar + browser UI; no internet connection required after install

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Python | 3.9+ | 3.11 recommended on Windows |
| Flask | any recent | `pip install flask` |
| OpenCV | 4.x | `pip install opencv-python` |
| pytesseract | any recent | `pip install pytesseract` |
| numpy | 1.x or 2.x | installed with OpenCV |
| Tesseract OCR | 5.x | see install instructions below |

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/yourname/gridOCR.git
cd gridOCR
```

### 2. Install Python dependencies

```bash
pip install flask opencv-python pytesseract numpy
```

On Windows with multiple Python versions:

```powershell
py -3.11 -m pip install flask opencv-python pytesseract numpy
```

### 3. Install Tesseract

**Windows:**
Download and run the installer from [UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki). The default install path is `C:\Program Files\Tesseract-OCR\`. gridOCR will find it automatically.

**macOS:**
```bash
brew install tesseract
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install tesseract-ocr
```

### 4. Install language packs

For English only, Tesseract's default install is sufficient. For other languages:

**Windows (UB Mannheim installer):** tick the languages you need during installation.

**Linux:**
```bash
sudo apt install tesseract-ocr-ben   # Bengali
sudo apt install tesseract-ocr-hin   # Hindi
sudo apt install tesseract-ocr-san   # Sanskrit
sudo apt install tesseract-ocr-fra   # French
sudo apt install tesseract-ocr-deu   # German
```

### 5. (Recommended) Install tessdata_best LSTM models

The standard Tesseract install uses legacy + LSTM hybrid models (`--oem 3`). For significantly better accuracy on period typography, install the best LSTM-only models:

1. Download `.traineddata` files for your languages from [tesseract-ocr/tessdata_best](https://github.com/tesseract-ocr/tessdata_best)
2. Place them in a folder named `tessdata_best` alongside your Tesseract install:
   - Windows: `C:\Program Files\Tesseract-OCR\tessdata_best\`
   - Linux/macOS: next to your `tessdata` directory, or set the `TESSDATA_BEST` environment variable to the full path

gridOCR detects this folder automatically at startup and switches to `--oem 1` (LSTM only). If the folder is not found, it falls back to standard tessdata gracefully.

---

## Running

```bash
python app.py
```

On Windows with multiple Python versions:
```powershell
py -3.11 app.py
```

The server starts at `http://localhost:5000` and opens in your default browser automatically. Press `Ctrl+C` to stop.

---

## Project structure

```
gridOCR/
├── app.py                  # Flask web server + sidecar manager
├── sidecar/
│   ├── main.py             # Sidecar dispatcher (JSON over stdin/stdout)
│   ├── detector.py         # OpenCV region detection
│   ├── ocr.py              # Tesseract wrapper + preprocessing
│   ├── splitter.py         # Spine detection and spread splitting
│   ├── compiler.py         # Reading-order text assembly
│   └── template.py         # Welford online volume template learning
├── frontend/
│   ├── index.html          # Main UI
│   ├── style.css           # Stylesheet
│   ├── app.js              # Frontend application logic
│   └── exporters/
│       └── txt.js          # Plain text exporter
└── projects/               # Created at runtime; project save files live here
```

---

## Usage walkthrough

### 1. Create a project
Click **+ Project** and give it a name.

### 2. Import spreads
Click **↑ Import Spreads** and select your scan images (JPEG or PNG). Both double-page spreads and single-page images are accepted in the same batch. gridOCR splits spreads automatically.

### 3. Detect regions
Click a spread in the sidebar to load it. Detection runs automatically. Detected regions are shown as coloured overlays on each page:

| Colour | Region type |
|---|---|
| Blue | Body text |
| Yellow | Running header |
| Red | Page number |
| Purple | Footnote |

### 4. Correct regions (optional)
- **Draw a new region:** select a type from the toolbar, then click and drag on the page
- **Resize:** drag the handle at the bottom-right corner of any region box
- **Retype:** click a region in the Regions panel and change its type
- **Delete:** click the × on a region in the Regions panel

### 5. Run OCR
Click **▶ OCR**. Results appear in the **OCR** tab. Select a language in **⚙ Settings** before running if your text is not in English.

### 6. Export
Go to the **Output** tab and click **Plain TXT** to download a clean text file of the current page. The exporter follows reading order (header → body → footnote) and omits page numbers.

### 7. Save your project
Click **💾 Save**. The project is saved to `projects/<name>/data/<name>.gridocr`. Load it later with **📂 Load**.

---

## Settings

Open **⚙ Settings** from the toolbar.

| Setting | Effect |
|---|---|
| Body / Header / Page No. / Footnote checkboxes | Filter auto-detected region types (you can still draw any type manually) |
| Preserve line breaks | When checked, keeps individual text lines as separate regions and preserves `\n` in OCR output; when unchecked, merges body blocks and joins lines with spaces |
| OCR language | Selects the Tesseract language pack; switch to Bengali, Hindi etc. for non-Latin scripts |

---

## Architecture

gridOCR uses a **Flask + Python sidecar** architecture. The browser UI communicates with a Flask server over HTTP; Flask forwards heavy work (OpenCV, Tesseract) to a Python subprocess (`sidecar/main.py`) over JSON-delimited stdin/stdout. This keeps the UI responsive and means the sidecar can be replaced or extended without touching the server or frontend.

```
Browser UI  ──fetch──▶  Flask (app.py)  ──JSON stdin──▶  Python sidecar
            ◀──JSON──                   ◀──JSON stdout──
```

All image paths are local filesystem paths. Images are never uploaded externally.

---

## Adding a new exporter

The exporter interface is a plain JS object with three fields:

```javascript
const myExporter = {
    name: "My Format",
    extension: "xml",
    mimeType: "application/xml",

    export(_, appState) {
        const proj = appState.project;
        // ... build your output string from proj.volumes → spreads → pages → segments
        return {
            filename: "output.xml",
            content: myXmlString,
            mimeType: "application/xml",
        };
    }
};
```

1. Save it as `frontend/exporters/myformat.js`
2. Add `<script src="exporters/myformat.js"></script>` in `index.html`
3. Add a button in the Output tab: `<button onclick="exportWith(myExporter)">My Format</button>`

The `appState.project` structure is documented in `frontend/app.js` (see `window._gridOCRState`).

---

## Troubleshooting

**The app crashes immediately with `JSONDecodeError`**
The sidecar printed something to stdout before responding to the ping. This is almost always a Python import error. Run `python sidecar/main.py` directly to see the traceback.

**`tesseract` is not found**
Set the `TESSERACT_CMD` environment variable to the full path of your Tesseract executable, e.g.:
```powershell
$env:TESSERACT_CMD = "C:\Program Files\Tesseract-OCR\tesseract.exe"
```

**OCR output is blank or garbled**
- Make sure the correct language pack is installed and selected in Settings
- Try toggling **Preserve line breaks** off; some layouts OCR better with merged body blocks
- Very low-DPI scans (below ~200 DPI) may not have enough resolution for reliable LSTM inference

**Bleed-through text is appearing in OCR results**
Increase the `MIN_SHARPNESS` constant in `detector.py` (default `30.0`) or the `BLEED_SHARPNESS_RATIO` constant (default `0.15`). These control how aggressively the sharpness filter rejects soft ghost text.

**Regions are not being detected correctly**
Click **⟳ Redetect** to re-run OpenCV detection with current settings. For volumes with a consistent layout, run several pages first — after 3 confirmed pages the volume template activates and improves subsequent detections automatically.

---

## Limitations

- Single-column layout assumed for template learning and region merging; multi-column periodicals will require manual region correction
- Right-to-left scripts (Arabic, Hebrew, Urdu) are not currently supported — Tesseract RTL support requires additional config not yet wired in
- TEI XML export is not yet implemented (see `frontend/exporters/txt.js` for the interface to follow)
- The volume template is held in memory and lost when the server restarts; save your project first

---

## Contributing

Pull requests welcome. The main areas where contributions would be useful:

- TEI XML exporter
- Multi-column detection heuristics
- RTL script support
- Better footnote detection for pages with long footnote sections
- Tests

Please open an issue before starting significant work so we can discuss approach.

---

## License

MIT — see [LICENSE](LICENSE).
