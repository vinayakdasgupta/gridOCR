"""
ocr.py
Tesseract wrapper. Crops each region from the page image,
runs Tesseract with appropriate PSM mode per region type,
returns text results.

Bleed-through suppression strategy:
  Primary ink is darker AND sharper than bleed-through.
  We exploit this with a two-blur normalisation:
  - Slight blur (3px) preserves primary text sharpness
  - Heavy blur (61px) estimates background + bleed average
  - Dividing slight by heavy stretches primary ink contrast
    while flattening the softer bleed-through signal
"""

import cv2
from typing import List, Optional
import numpy as np
import pytesseract
from pytesseract import Output
import os
import sys


def _find_tesseract():
    if hasattr(sys, '_MEIPASS'):
        bundled = os.path.join(sys._MEIPASS, 'tesseract', 'tesseract')
        if os.path.isfile(bundled): return bundled
        bundled_win = bundled + '.exe'
        if os.path.isfile(bundled_win): return bundled_win
    env_path = os.environ.get('TESSERACT_CMD')
    if env_path and os.path.isfile(env_path): return env_path
    win_paths = [
        os.path.join("C:\\Program Files\\Tesseract-OCR", "tesseract.exe"),
        os.path.join("C:\\Program Files (x86)\\Tesseract-OCR", "tesseract.exe"),
    ]
    for p in win_paths:
        if os.path.isfile(p): return p
    return 'tesseract'


pytesseract.pytesseract.tesseract_cmd = _find_tesseract()


def _find_tessdata_best() -> Optional[str]:
    """
    Locate the tessdata_best directory.
    Checks alongside the Tesseract install, common manual install locations,
    and the TESSDATA_BEST environment variable override.
    Returns the path if found, None if not (falls back to default tessdata).
    """
    env = os.environ.get('TESSDATA_BEST')
    if env and os.path.isdir(env):
        return env

    tess_cmd = pytesseract.pytesseract.tesseract_cmd
    # Resolve tessdata_best relative to the tesseract executable
    if tess_cmd and tess_cmd != 'tesseract':
        tess_dir = os.path.dirname(tess_cmd)
        candidates = [
            os.path.join(tess_dir, 'tessdata_best'),
            os.path.join(tess_dir, '..', 'tessdata_best'),
            # Common manual download location alongside tessdata
            os.path.join(tess_dir, '..', 'share', 'tessdata_best'),
        ]
        for c in candidates:
            if os.path.isdir(c):
                return os.path.normpath(c)

    # Fallback: well-known Windows paths
    win_candidates = [
        os.path.join('C:\\Program Files\\Tesseract-OCR', 'tessdata_best'),
        os.path.join('C:\\Program Files (x86)\\Tesseract-OCR', 'tessdata_best'),
    ]
    for c in win_candidates:
        if os.path.isdir(c):
            return c

    return None


TESSDATA_BEST = _find_tessdata_best()




def _build_configs(language: str) -> dict:
    """
    Build Tesseract config strings for each region type.
    Uses tessdata_best + --oem 1 (LSTM only) when the best models are found;
    falls back to default tessdata + --oem 3 otherwise.
    The digit whitelist on pagenum is Latin-script only — dropped for scripts
    with their own numeral glyphs (Bengali, Devanagari, etc.)
    """
    LATIN_SCRIPT_LANGS = {'eng', 'fra', 'deu', 'lat', 'ita', 'spa', 'por'}
    use_latin_whitelist = language in LATIN_SCRIPT_LANGS
    l = language

    # tessdata_best models require --oem 1 (pure LSTM only).
    # We set TESSDATA_PREFIX as an environment variable rather than using
    # --tessdata-dir in the config string — avoids quoting issues with
    # paths containing spaces (e.g. C:\Program Files\...).
    oem = 1
    if TESSDATA_BEST:
        os.environ['TESSDATA_PREFIX'] = TESSDATA_BEST
    base = f'--oem {oem}'
    pagenum_config = (
        f"{base} --psm 6 -l {l} -c tessedit_char_whitelist=0123456789IVXivxLCDlcd.,- "
        if use_latin_whitelist
        else f"{base} --psm 6 -l {l}"
    )
    return {
        "body":     f"{base} --psm 6 -l {l}",
        "header":   f"{base} --psm 6 -l {l}",
        "pagenum":  pagenum_config,
        "footnote": f"{base} --psm 6 -l {l}",
        "unknown":  f"{base} --psm 3 -l {l}",
    }


class OCREngine:

    MIN_W = 20
    MIN_H = 10


    # Upscale factor for small regions
    SCALE_HEADER  = 3.0
    SCALE_SMALL   = 2.0   # regions < 200px tall
    SCALE_NORMAL  = 1.5   # everything else — slight upscale always helps

    def run(self, image_path: str, regions: List[dict], language: str = 'eng', preserve_newlines: bool = True) -> dict:
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Cannot read: {image_path}")
        h, w = img.shape[:2]
        results = {}
        type_config = _build_configs(language)



        for region in regions:
            rid   = region['id']
            rtype = region.get('type', 'unknown')

            # Padding: headers/pagenums get generous horizontal and top padding
            # but minimal bottom padding — body text starts close below and
            # bleeds into the crop if we pad symmetrically.
            if rtype in ('header', 'pagenum'):
                pad_x, pad_top, pad_bot = 8, 8, 2
            else:
                pad_x, pad_top, pad_bot = 4, 4, 4
            rx = max(0, int(region['x'] * w) - pad_x)
            ry = max(0, int(region['y'] * h) - pad_top)
            rw = min(w - rx, int(region['w'] * w) + pad_x * 2)
            rh = min(h - ry, int(region['h'] * h) + pad_top + pad_bot)

            if rw < self.MIN_W or rh < self.MIN_H:
                results[rid] = {"text": "", "confidence": 0.0,
                                "word_count": 0, "skipped": True}
                continue

            crop = img[ry:ry+rh, rx:rx+rw]
            processed = self._preprocess(crop, rtype, rh)

            config = type_config.get(rtype, type_config['unknown'])
            try:
                data = pytesseract.image_to_data(
                    processed, config=config, output_type=Output.DICT
                )
                text, conf = self._extract(data, preserve_newlines=preserve_newlines)
                results[rid] = {
                    "text":       text,
                    "confidence": conf,
                    "word_count": len(text.split()) if text.strip() else 0,
                }
            except Exception as e:
                results[rid] = {"text": "", "confidence": 0.0,
                                "word_count": 0, "error": str(e)}

        return results

    def _preprocess(self, crop: np.ndarray, rtype: str, region_h: int) -> np.ndarray:
        """
        Bleed-through suppression + upscale + binarise.

        Background normalisation: divide each pixel by a heavily blurred
        version of the image, which estimates the local background including
        bleed-through. Kernel size is proportional to crop height so it never
        exceeds the region itself (critical for short header/pagenum crops).
        """
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)

        # ── Background normalisation (bleed-through suppression) ──
        # Kernel must be odd and large enough to span a text line but not
        # so large it exceeds the crop (which produces garbage for headers).
        h_crop = gray.shape[0]
        bg_k = max(min(51, (h_crop // 2) * 2 - 1), 5)  # odd, 5..51
        bg   = cv2.GaussianBlur(gray, (bg_k, bg_k), 0).astype(np.float32)
        norm = np.clip(gray.astype(np.float32) / (bg + 1e-6) * 200,
                       0, 255).astype(np.uint8)

        # ── Scale factor ───────────────────────────────────
        if rtype in ('header', 'pagenum'):
            scale = self.SCALE_HEADER
        elif region_h < 200:
            scale = self.SCALE_SMALL
        else:
            scale = self.SCALE_NORMAL

        if scale > 1.0:
            norm = cv2.resize(
                norm,
                (int(norm.shape[1] * scale), int(norm.shape[0] * scale)),
                interpolation=cv2.INTER_CUBIC
            )

        # ── Denoise ───────────────────────────────────────
        norm = cv2.fastNlMeansDenoising(norm, h=10)

        # ── Binarise ──────────────────────────────────────
        # Adaptive threshold for all types — it handles local illumination
        # variation far better than Otsu on small crops. Block size must be
        # odd and smaller than the crop; scale with crop height after upscale.
        h_scaled = norm.shape[0]
        block = max(min(31, (h_scaled // 4) * 2 + 1), 11)  # odd, 11..31
        binary = cv2.adaptiveThreshold(
            norm, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            blockSize=block, C=12
        )

        return binary

    def _extract(self, data: dict, preserve_newlines: bool = True) -> tuple[str, float]:
        """
        Reconstruct text, optionally preserving line breaks.
        Tesseract's image_to_data gives block_num, par_num, line_num per word.
        When preserve_newlines=True, groups words by line and emits newlines.
        When preserve_newlines=False, joins everything with single spaces.
        """
        confs = []
        lines_map = {}  # (block, par, line) -> [words]
        order = []      # insertion-ordered keys

        n = len(data['text'])
        for i in range(n):
            word = data['text'][i].strip(' \t\r\n')  # ASCII-only strip — preserve ZWJ/ZWNJ
            conf = int(data['conf'][i])
            if conf < 0:
                continue
            if not word:
                continue
            key = (
                int(data['block_num'][i]),
                int(data['par_num'][i]),
                int(data['line_num'][i]),
            )
            if key not in lines_map:
                lines_map[key] = []
                order.append(key)
            lines_map[key].append(word)
            confs.append(conf)

        if not preserve_newlines:
            # Flatten everything to a single space-separated string
            all_words = [w for key in order for w in lines_map[key]]
            text = ' '.join(all_words)
        else:
            out_lines = []
            prev_block_par = None
            for key in order:
                block_par = key[:2]
                if prev_block_par is not None and block_par != prev_block_par:
                    out_lines.append('')  # blank line = paragraph break
                out_lines.append(' '.join(lines_map[key]))
                prev_block_par = block_par
            text = '\n'.join(out_lines)
        mean_conf = (sum(confs) / len(confs) / 100.0) if confs else 0.0
        return text, round(mean_conf, 3)
