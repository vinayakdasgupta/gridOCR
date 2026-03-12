"""
app.py — gridOCR web server
Replaces the Tauri/Rust shell. Run with: python app.py
Then open http://localhost:5000 in your browser.
"""

import os
import sys
import json
import base64
import threading
import webbrowser
import subprocess
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory

# ── Paths ──────────────────────────────────────────────────────────────────
BASE_DIR     = Path(__file__).parent
FRONTEND_DIR = BASE_DIR / "frontend"
SIDECAR_DIR  = BASE_DIR / "sidecar"
PROJECTS_DIR = BASE_DIR / "projects"   # all project files live here
PROJECTS_DIR.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=str(FRONTEND_DIR))

# ── Sidecar process ────────────────────────────────────────────────────────

class Sidecar:
    def __init__(self):
        self.proc  = None
        self.lock  = threading.Lock()

    def start(self):
        main_py = SIDECAR_DIR / "main.py"
        self.proc = subprocess.Popen(
            [sys.executable, str(main_py)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            encoding='utf-8',  # explicit UTF-8 — critical for Bengali and other non-ASCII scripts
            bufsize=1,
        )
        # Verify it's alive
        result = self.call({"action": "ping"})
        if not result.get("ok"):
            raise RuntimeError("Sidecar ping failed")
        print(f"  Sidecar ready — version {result.get('version', '?')}")

    def call(self, message: dict) -> dict:
        with self.lock:
            line = json.dumps(message, ensure_ascii=False) + "\n"
            self.proc.stdin.write(line)
            self.proc.stdin.flush()
            response = self.proc.stdout.readline()
            return json.loads(response)

    def stop(self):
        if self.proc:
            self.proc.stdin.close()
            self.proc.wait()

sidecar = Sidecar()

# ── Routes — frontend ──────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(FRONTEND_DIR, filename)

# ── Routes — sidecar proxy ─────────────────────────────────────────────────

@app.route("/api/sidecar", methods=["POST"])
def sidecar_call():
    message = request.get_json()
    if not message:
        return jsonify({"ok": False, "error": "No JSON body"}), 400
    try:
        result = sidecar.call(message)
        return jsonify(result)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# ── Routes — file utilities ────────────────────────────────────────────────

@app.route("/api/upload", methods=["POST"])
def upload_images():
    """Receive uploaded image files, save to temp dir, return paths."""
    import tempfile
    files = request.files.getlist("files")
    if not files:
        return jsonify({"ok": False, "error": "No files"}), 400
    tmp_dir = Path(tempfile.mkdtemp(prefix="gridocr_"))
    paths = []
    for f in files:
        dest = tmp_dir / f.filename
        f.save(str(dest))
        paths.append(str(dest))
    return jsonify({"ok": True, "paths": paths})

@app.route("/api/image", methods=["GET"])
def serve_image():
    """Serve a local image file as base64 data URL."""
    path = request.args.get("path")
    if not path or not os.path.isfile(path):
        return jsonify({"ok": False, "error": "File not found"}), 404
    ext  = path.rsplit(".", 1)[-1].lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
            "png": "image/png", "tif": "image/tiff",
            "tiff": "image/tiff"}.get(ext, "image/jpeg")
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")
    return jsonify({"ok": True, "data_url": f"data:{mime};base64,{data}"})

# ── Routes — project save/load ────────────────────────────────────────────

@app.route("/api/project/save", methods=["POST"])
def save_project():
    data    = request.get_json()
    project = data.get("project")
    if not project:
        return jsonify({"ok": False, "error": "No project data"}), 400
    name     = project.get("name", "untitled").strip() or "untitled"
    proj_dir = PROJECTS_DIR / name / "data"
    proj_dir.mkdir(parents=True, exist_ok=True)
    save_path = proj_dir / f"{name}.gridocr"
    import json as _json
    with open(save_path, "w", encoding="utf-8") as f:
        _json.dump(project, f, indent=2, ensure_ascii=False)
    return jsonify({"ok": True, "path": str(save_path)})

@app.route("/api/project/load", methods=["POST"])
def load_project():
    data = request.get_json()
    path = data.get("path")
    if not path or not os.path.isfile(path):
        return jsonify({"ok": False, "error": "File not found"}), 404
    import json as _json
    with open(path, "r", encoding="utf-8") as f:
        project = _json.load(f)
    return jsonify({"ok": True, "project": project})

@app.route("/api/project/list", methods=["GET"])
def list_projects():
    """List all .gridocr save files under projects/*/data/."""
    files = []
    if PROJECTS_DIR.exists():
        for gridocr_file in sorted(
            PROJECTS_DIR.glob("*/data/*.gridocr"),
            key=lambda x: -x.stat().st_mtime,
        ):
            files.append({
                "name":     gridocr_file.stem,
                "path":     str(gridocr_file),
                "modified": gridocr_file.stat().st_mtime,
            })
    return jsonify({"ok": True, "files": files})

# ── Main ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 50)
    print("  gridOCR")
    print("=" * 50)

    print("  Starting sidecar…")
    sidecar.start()

    port = 5000
    url  = f"http://localhost:{port}"
    print(f"  Server running at {url}")
    print(f"  Press Ctrl+C to stop")
    print("=" * 50)

    # Open browser after short delay
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
