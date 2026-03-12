"""
gridOCR Python Sidecar
Communicates with Tauri shell via JSON over stdin/stdout.
Each message: one line of JSON in, one line of JSON out.
"""

import sys
import json
import traceback
import os

# Force UTF-8 on stdout/stderr regardless of Windows console code page.
# Without this, Bengali (and any non-ASCII) characters are mangled on output.
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)

from splitter import SpineSplitter
from detector import RegionDetector
from ocr import OCREngine
from compiler import TextCompiler
from template import VolumeTemplate

splitter  = SpineSplitter()
detector  = RegionDetector()
ocr       = OCREngine()
compiler  = TextCompiler()
templates = {}  # volume_id -> VolumeTemplate


def handle(msg: dict) -> dict:
    action = msg.get("action")

    # ── READ IMAGE AS BASE64 ──────────────────────────────
    if action == "image_to_base64":
        import base64, mimetypes
        path = msg["path"]
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("utf-8")
        ext = path.rsplit(".", 1)[-1].lower()
        mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                "tif": "image/tiff", "tiff": "image/tiff"}.get(ext, "image/jpeg")
        return {"ok": True, "data_url": f"data:{mime};base64,{data}"}

    # ── DEFAULT OUTPUT DIR ───────────────────────────────────
    if action == "get_default_output_dir":
        import pathlib
        docs = pathlib.Path.home() / "Documents" / "gridOCR"
        docs.mkdir(parents=True, exist_ok=True)
        return {"ok": True, "path": str(docs)}

    # ── PING ──────────────────────────────────────────────
    if action == "ping":
        return {"ok": True, "version": "0.1.0"}

    # ── SPLIT SPREAD ──────────────────────────────────────
    elif action == "split_spread":
        image_path = msg["image_path"]
        out_dir    = msg["out_dir"]
        result = splitter.split(image_path, out_dir)
        return {"ok": True, **result}

    # ── DETECT REGIONS ────────────────────────────────────
    elif action == "detect_regions":
        image_path        = msg["image_path"]
        page_side         = msg.get("page_side", "unknown")
        volume_id         = msg.get("volume_id")
        merge_body        = msg.get("merge_body", True)
        preserve_paras    = msg.get("preserve_paras", False)
        preserve_newlines = msg.get("preserve_newlines", False)
        template          = templates.get(volume_id) if volume_id else None

        regions = detector.detect(
            image_path,
            template=template,
            merge_body=merge_body,
            preserve_paras=preserve_paras,
            preserve_newlines=preserve_newlines,
        )
        return {"ok": True, "regions": regions}

    # ── RUN OCR ───────────────────────────────────────────
    elif action == "run_ocr":
        image_path        = msg["image_path"]
        regions           = msg["regions"]
        language          = msg.get("language", "eng")
        preserve_newlines = msg.get("preserve_newlines", True)
        results = ocr.run(image_path, regions, language=language,
                          preserve_newlines=preserve_newlines)
        return {"ok": True, "results": results}

    # ── COMPILE OUTPUT ────────────────────────────────────
    elif action == "compile":
        regions    = msg["regions"]
        ocr_results = msg["ocr_results"]
        out_path   = msg["out_path"]
        page_label = msg.get("page_label", "")
        text = compiler.compile_txt(regions, ocr_results, page_label)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        return {"ok": True, "out_path": out_path, "char_count": len(text)}

    # ── COMPILE VOLUME ─────────────────────────────────────
    elif action == "compile_volume":
        pages      = msg["pages"]            # list of {label, regions, ocr_results}
        out_path   = msg["out_path"]
        text = compiler.compile_volume_txt(pages)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        return {"ok": True, "out_path": out_path, "char_count": len(text)}

    # ── UPDATE TEMPLATE ───────────────────────────────────
    elif action == "update_template":
        volume_id  = msg["volume_id"]
        regions    = msg["regions"]   # confirmed/corrected regions (normalised)
        image_w    = msg["image_w"]
        image_h    = msg["image_h"]
        if volume_id not in templates:
            templates[volume_id] = VolumeTemplate(volume_id)
        templates[volume_id].add_sample(regions, image_w, image_h)
        summary = templates[volume_id].summary()
        return {"ok": True, "template_summary": summary}

    # ── GET TEMPLATE ──────────────────────────────────────
    elif action == "get_template":
        volume_id = msg["volume_id"]
        t = templates.get(volume_id)
        if t:
            return {"ok": True, "template": t.to_dict()}
        return {"ok": True, "template": None}

    # ── SAVE / LOAD TEMPLATE ──────────────────────────────
    elif action == "save_template":
        volume_id = msg["volume_id"]
        path      = msg["path"]
        t = templates.get(volume_id)
        if t:
            t.save(path)
            return {"ok": True}
        return {"ok": False, "error": "No template for volume"}

    elif action == "load_template":
        volume_id = msg["volume_id"]
        path      = msg["path"]
        t = VolumeTemplate(volume_id)
        t.load(path)
        templates[volume_id] = t
        return {"ok": True, "template": t.to_dict()}

    else:
        return {"ok": False, "error": f"Unknown action: {action}"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            response = handle(msg)
        except Exception as e:
            response = {
                "ok": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    import tempfile, datetime
    log = os.path.join(tempfile.gettempdir(), "gridocr_sidecar.log")
    with open(log, "w") as f:
        f.write(f"Sidecar started at {datetime.datetime.now()}\n")
        f.write(f"Python: {sys.version}\n")
        f.write(f"CWD: {os.getcwd()}\n")
    main()
