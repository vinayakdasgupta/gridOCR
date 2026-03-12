"""
compiler.py
Assembles OCR results into plain-text output in reading order.
Handles: page headers, body text, footnotes, page numbers, engravings.

Reading order for a single page:
  1. Running header (top)
  2. Body text (top to bottom)
  3. Footnotes
  4. Page number (bottom)
  [Engravings get a placeholder marker]

Volume compilation: pages in order, with page break markers.
"""

from typing import List
from datetime import datetime


# ── Section separators ────────────────────────────────────────────────────────
PAGE_BREAK      = "\n" + "─" * 60 + "\n"
SECTION_SEP     = "\n"

# ── Type rendering order (lower = earlier on page) ───────────────────────────
TYPE_ORDER = {
    "header":    0,
    "body":      1,
    "unknown":   2,
    "engraving": 3,
    "footnote":  4,
    "pagenum":   5,
}

# ── Prefix labels in output ───────────────────────────────────────────────────
TYPE_LABELS = {
    "header":    None,           # No label — just render the text
    "body":      None,
    "unknown":   None,
    "engraving": "[ENGRAVING]",
    "footnote":  None,
    "pagenum":   None,
}


class TextCompiler:

    def compile_txt(
        self,
        regions: List[dict],
        ocr_results: dict,
        page_label: str = "",
    ) -> str:
        """
        Compile a single page to plain text.

        Args:
            regions:     list of region dicts (with id, type, x, y, w, h)
            ocr_results: {region_id: {"text": str, ...}}
            page_label:  e.g. "Vol. 1, p. 12 (recto)"
        """
        lines = []

        if page_label:
            lines.append(f"[{page_label}]")
            lines.append("")

        # Sort regions by type order, then by vertical position
        def sort_key(r):
            return (TYPE_ORDER.get(r.get('type', 'unknown'), 99), r.get('y', 0))

        sorted_regions = sorted(regions, key=sort_key)

        for region in sorted_regions:
            rid   = region['id']
            rtype = region.get('type', 'unknown')
            result = ocr_results.get(rid, {})
            text   = result.get('text', '').strip()

            if not text:
                continue

            label = TYPE_LABELS.get(rtype)

            if rtype == 'engraving':
                lines.append(f"\n[ENGRAVING — {text if text != '[ENGRAVING]' else 'illustration'}]\n")

            elif rtype == 'header':
                # Header: separated, not labelled
                lines.append(text)
                lines.append("")

            elif rtype == 'pagenum':
                # Page number at end, indented right
                lines.append(f"\n{'':>50}{text}")

            elif rtype == 'footnote':
                lines.append(f"\n  {text}")

            else:
                # Body, unknown
                lines.append(text)

        return "\n".join(lines)

    def compile_volume_txt(self, pages: List[dict]) -> str:
        """
        Compile an entire volume.

        Args:
            pages: list of {
                label: str,
                regions: List[dict],
                ocr_results: dict,
            }
        """
        header = self._volume_header(pages)
        parts  = [header]

        for i, page in enumerate(pages):
            page_text = self.compile_txt(
                page['regions'],
                page['ocr_results'],
                page.get('label', f'Page {i+1}'),
            )
            if page_text.strip():
                parts.append(page_text)
                parts.append(PAGE_BREAK)

        return "\n".join(parts)

    def _volume_header(self, pages: List[dict]) -> str:
        n = len(pages)
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        return (
            f"PageForge — Compiled Output\n"
            f"Generated: {now}\n"
            f"Pages: {n}\n"
            f"{'═' * 60}\n"
        )
