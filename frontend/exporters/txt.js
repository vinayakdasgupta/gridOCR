/**
 * exporters/txt.js — Plain text exporter for gridOCR
 *
 * Exports the full project (all volumes, all spreads) as faithful OCR text.
 * No computer-assigned labels or page numbers — only what the OCR found.
 * Reading order per page: header → body → footnote.
 * Page numbers are intentionally omitted.
 *
 * To add a new exporter (e.g. TEI):
 *   1. Create exporters/tei.js with the same interface:
 *      export(appState) → { filename, content, mimeType }
 *   2. Add <script src="exporters/tei.js"> in index.html
 *   3. Add a button: <button onclick="exportWith(teiExporter)">TEI XML</button>
 */

const txtExporter = {
    name: "Plain TXT",
    extension: "txt",
    mimeType: "text/plain",

    export(appState) {
        const proj = appState.project;
        if (!proj) throw new Error("No project loaded");

        const volumes = proj.volumes || [];
        if (volumes.length === 0) throw new Error("No volumes in project");

        const ORDER = ["header", "body", "footnote"]; // pagenum omitted
        const blocks = [];

        for (const vol of volumes) {
            for (const spread of (vol.spreads || [])) {
                for (const side of ["left", "right"]) {
                    // Skip right side if this was a single-page spread
                    if (side === "right" && !spread.rightPath) continue;
                    const page = spread.pages?.[side];
                    if (!page) continue;

                    for (const type of ORDER) {
                        const segs = (page.segments || [])
                            .filter(s => s.type === type)
                            .sort((a, b) => a.y - b.y);

                        for (const seg of segs) {
                            const text = page.ocrResults?.[seg.id]?.text?.trim();
                            if (text) blocks.push(text);
                        }
                    }
                }
            }
        }

        if (blocks.length === 0)
            throw new Error("No OCR text to export — run OCR first");

        const safe = s => s.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
        const filename = `${safe(proj.name)}.txt`;
        return { filename, content: blocks.join("\n\n"), mimeType: "text/plain" };
    }
};

function exportWith(exporter) {
    try {
        const result = exporter.export(window._gridOCRState);
        const blob   = new Blob([result.content], { type: result.mimeType });
        const url    = URL.createObjectURL(blob);
        const a      = document.createElement("a");
        a.href = url; a.download = result.filename; a.click();
        URL.revokeObjectURL(url);
    } catch(e) {
        alert("Export failed: " + e.message);
    }
}

function exportTxt() { exportWith(txtExporter); }
