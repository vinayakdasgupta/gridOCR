"""
ocr_corrector.py
Rule-based OCR post-correction for gridOCR.
Applies pre_correct.py substitution rules only.
No neural model.
"""

try:
    from pre_correct import apply as _pre_correct
except ImportError:
    def _pre_correct(text): return text


def is_available() -> bool:
    return True


def fix_encoding(text: str) -> str:
    """Fix Windows-1252 mojibake (cp1252 bytes misread as UTF-8)."""
    try:
        return text.encode('cp1252').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        out, buf = [], []
        for ch in text:
            if ord(ch) < 128:
                if buf:
                    try:
                        out.append(''.join(buf).encode('cp1252').decode('utf-8'))
                    except Exception:
                        out.extend(buf)
                    buf = []
                out.append(ch)
            else:
                buf.append(ch)
        if buf:
            try:
                out.append(''.join(buf).encode('cp1252').decode('utf-8'))
            except Exception:
                out.extend(buf)
        return ''.join(out)


def correct(text: str, **kwargs) -> dict:
    if not text or not text.strip():
        return {"ok": True, "corrected": text}
    try:
        result = _pre_correct(text)
        result = fix_encoding(result)
        return {"ok": True, "corrected": result}
    except Exception as e:
        return {"ok": False, "error": str(e)}