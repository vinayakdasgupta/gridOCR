"""
pdf_importer.py
Converts a PDF to page images for gridOCR.

Two modes:
  - pdf_to_images(): convert whole PDF at once (simple, no progress)
  - pdf_start_job() + pdf_next_page(): page-by-page with progress reporting
"""

import os
import tempfile
from pathlib import Path

_jobs = {}  # job_id -> {doc, fitz, mat, out_dir, paths, next_page}


def _get_fitz():
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        pass
    try:
        import fitz
        return fitz
    except ImportError:
        import sys
        raise ImportError(
            f"pymupdf not found. Python: {sys.executable}. "
            f"Run: {sys.executable} -m pip install pymupdf"
        )


# ── Whole-PDF conversion ───────────────────────────────────────────────────

def pdf_to_images(pdf_path: str, out_dir: str = "", dpi: int = 200) -> dict:
    try:
        fitz = _get_fitz()
    except ImportError as e:
        return {"ok": False, "error": str(e)}
    try:
        if not out_dir:
            out_dir = tempfile.mkdtemp(prefix="gridocr_pdf_")
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        doc   = fitz.open(pdf_path)
        mat   = fitz.Matrix(dpi / 72, dpi / 72)
        paths = []
        for i, page in enumerate(doc):
            pix      = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
            out_path = os.path.join(out_dir, f"page_{i+1:04d}.png")
            pix.save(out_path)
            paths.append(out_path)
        doc.close()
        return {"ok": True, "page_paths": paths, "page_count": len(paths)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Page-by-page conversion (for progress reporting) ──────────────────────

def pdf_start_job(pdf_path: str, out_dir: str = "", dpi: int = 200) -> dict:
    """Open PDF and return job_id + page_count. Call pdf_next_page() repeatedly."""
    try:
        fitz = _get_fitz()
    except ImportError as e:
        return {"ok": False, "error": str(e)}
    try:
        if not out_dir:
            out_dir = tempfile.mkdtemp(prefix="gridocr_pdf_")
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        doc    = fitz.open(pdf_path)
        job_id = str(id(doc))
        _jobs[job_id] = {
            "doc":       doc,
            "fitz":      fitz,
            "mat":       fitz.Matrix(dpi / 72, dpi / 72),
            "out_dir":   out_dir,
            "paths":     [],
            "next_page": 0,
        }
        return {"ok": True, "job_id": job_id, "page_count": len(doc)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def pdf_next_page(job_id: str) -> dict:
    """Convert the next page. Returns done=True with all paths on last page."""
    job = _jobs.get(job_id)
    if not job:
        return {"ok": False, "error": f"Unknown job_id: {job_id}"}
    try:
        doc  = job["doc"]
        idx  = job["next_page"]
        # Already finished
        if idx >= len(doc):
            _jobs.pop(job_id, None)
            return {"ok": True, "done": True, "paths": job["paths"], "page_index": idx}
        # Convert one page
        fitz = job["fitz"]
        pix  = doc[idx].get_pixmap(matrix=job["mat"], colorspace=fitz.csRGB)
        out_path = os.path.join(job["out_dir"], f"page_{idx+1:04d}.png")
        pix.save(out_path)
        job["paths"].append(out_path)
        job["next_page"] = idx + 1
        done = (idx + 1 >= len(doc))
        if done:
            doc.close()
            _jobs.pop(job_id, None)
        return {
            "ok":         True,
            "done":       done,
            "page_index": idx + 1,
            "path":       out_path,
            "paths":      job["paths"] if done else [],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def pdf_page_count(pdf_path: str) -> int:
    try:
        fitz = _get_fitz()
        doc  = fitz.open(pdf_path)
        n    = len(doc)
        doc.close()
        return n
    except Exception:
        return -1