"""
detector.py
OpenCV-based region detection for 19th-century periodical pages.

Pipeline per page:
  1. Border crop   — strip dark camera/scanner border (black edges around scan)
  2. Preprocess    — grayscale, denoise, binarise (adaptive threshold)
  3. Morph ops     — dilate to merge text into blocks
  4. Contours      — find external contours of text/image blocks
  5. Filter        — remove noise, margins, spine strip, binding edge
  6. Classify      — heuristic rules → body | header | pagenum | footnote
  7. Normalise     — return coords as fractions of ORIGINAL image dimensions
  8. Body merge    — merge/preserve body regions per user settings
"""

import cv2
import numpy as np
from dataclasses import dataclass, asdict
from typing import List
import uuid


# ── Region types ──────────────────────────────────────────────────────────────
REGION_TYPES = ["body", "header", "pagenum", "footnote", "unknown"]

TYPE_COLOURS = {
    "body":      "#3d5a6b",
    "header":    "#c4922a",
    "pagenum":   "#8b3a1a",
    "footnote":  "#6b4a7a",
    "unknown":   "#5a5a5a",
}


@dataclass
class Region:
    id:         str
    type:       str
    x:          float
    y:          float
    w:          float
    h:          float
    confidence: float
    source:     str     # "detected" | "template" | "manual"

    def to_dict(self):
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "Region":
        return Region(**d)


class RegionDetector:

    # ── Morphological kernel sizes ─────────────────────────
    HORIZ_KERNEL = (55, 2)
    VERT_KERNEL  = (3, 10)

    # ── Page zone boundaries (fraction of page height) ────
    HEADER_ZONE  = 0.20
    FOOTER_ZONE  = 0.90
    FOOTNOTE_MIN = 0.75

    # ── Size thresholds (fraction of page area) ───────────
    MIN_REGION_AREA  = 0.0005
    MAX_REGION_AREA  = 0.85
    MIN_REGION_H     = 0.010   # regions shorter than 1% of page height are noise
    MIN_SHARPNESS        = 30.0  # Absolute floor — catches bleed-through on low-res scans
    BLEED_SHARPNESS_RATIO = 0.15  # Region must be ≥ 15% of page median sharpness

    # ── Bleed/binding edge filter ─────────────────────────
    # Narrow strips hugging the left inner edge = bleed-through or binding
    BLEED_EDGE_MAX_X = 0.12
    BLEED_EDGE_MAX_W = 0.13

    # ── Gutter/spine filter (for split spreads) ───────────
    # Narrow region near horizontal centre = spine strip
    GUTTER_X_MIN = 0.42
    GUTTER_X_MAX = 0.58
    GUTTER_MAX_W = 0.12
    SEAM_MIN_H       = 0.60   # region must span ≥ 60% page height to be seam
    SEAM_MAX_ASPECT  = 0.25   # width/height ratio; seams are tall slivers (≈ 0.11)

    # ── Dark border threshold ──────────────────────────────
    # Pixel brightness below this = camera/scanner dark border
    BORDER_THRESHOLD = 50
    BORDER_ERODE_PX  = 15    # erosion to find conservative page bounds

    def detect(
        self,
        image_path:        str,
        template=None,
        merge_body:        bool = True,
        preserve_paras:    bool = False,
        preserve_newlines: bool = False,
    ) -> List[dict]:
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Cannot read: {image_path}")

        h, w = img.shape[:2]

        # ── 1. Find and crop dark camera/scanner border ───
        gray_full = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, bright = cv2.threshold(gray_full, self.BORDER_THRESHOLD, 255, cv2.THRESH_BINARY)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT,
                     (self.BORDER_ERODE_PX, self.BORDER_ERODE_PX))
        page_mask = cv2.erode(bright, kernel)
        coords = cv2.findNonZero(page_mask)
        if coords is not None:
            px, py, pw, ph = cv2.boundingRect(coords)
            # Small safety margin
            px = max(0, px - 4);  py = max(0, py - 4)
            pw = min(w - px, pw + 8);  ph = min(h - py, ph + 8)
        else:
            px, py, pw, ph = 0, 0, w, h

        img_page = img[py:py+ph, px:px+pw]
        hp, wp = img_page.shape[:2]

        # ── 2. Find and skip left binding spine (if present) ─
        # Some scans have a visible binding spine that's darker than the page
        # but brighter than the camera border — detect it via column brightness dip
        gray_pg = cv2.cvtColor(img_page, cv2.COLOR_BGR2GRAY)
        col_means = gray_pg.mean(axis=0)
        page_avg = col_means[wp//4:3*wp//4].mean()
        binding_threshold = page_avg * 0.75  # columns darker than this = binding
        binding_end = 0
        scan_cols = wp // 5  # only look in left 20%
        for j in range(scan_cols):
            if col_means[j] < binding_threshold:
                # Find where it recovers
                for k in range(j, scan_cols):
                    if col_means[k] >= page_avg * 0.90:
                        binding_end = k
                        break
                break
        if binding_end > 0:
            # Trim the binding from the left side
            img_page = img_page[:, binding_end:, :]
            # Adjust px so normalised coords stay in full-image space
            px += binding_end
            hp, wp = img_page.shape[:2]

        # ── 3. Find and crop right-edge binding strip ─────
        # Mirror of step 2: some scans have a dark spine strip on the right
        # edge of the page image (inner binding edge of right-hand pages).
        gray_pg2 = cv2.cvtColor(img_page, cv2.COLOR_BGR2GRAY)
        col_means2 = gray_pg2.mean(axis=0)
        page_avg2 = col_means2[wp//4:3*wp//4].mean()
        binding_threshold2 = page_avg2 * 0.75
        binding_start_r = wp  # will trim to this column
        scan_cols_r = wp // 5  # only look in right 20%
        for j in range(wp - 1, wp - 1 - scan_cols_r, -1):
            if col_means2[j] < binding_threshold2:
                for k in range(j, wp - 1 - scan_cols_r, -1):
                    if col_means2[k] >= page_avg2 * 0.90:
                        binding_start_r = k + 1
                        break
                break
        if binding_start_r < wp:
            img_page = img_page[:, :binding_start_r, :]
            hp, wp = img_page.shape[:2]

        page_area = hp * wp

        # ── 2. Preprocess ─────────────────────────────────
        gray = cv2.cvtColor(img_page, cv2.COLOR_BGR2GRAY)
        denoised = cv2.fastNlMeansDenoising(gray, h=10,
                       templateWindowSize=7, searchWindowSize=21)
        binary = cv2.adaptiveThreshold(
            denoised, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            blockSize=35, C=10
        )

        # ── 3. Morphological dilation ─────────────────────
        kh = cv2.getStructuringElement(cv2.MORPH_RECT, self.HORIZ_KERNEL)
        horiz = cv2.dilate(binary, kh, iterations=1)
        kv = cv2.getStructuringElement(cv2.MORPH_RECT, self.VERT_KERNEL)
        blocks = cv2.dilate(horiz, kv, iterations=1)

        # ── 4. Find contours ──────────────────────────────
        contours, _ = cv2.findContours(blocks, cv2.RETR_EXTERNAL,
                                        cv2.CHAIN_APPROX_SIMPLE)

        # ── Pass 1: collect candidate contours and their sharpness ──
        # We use a relative sharpness threshold rather than an absolute one,
        # because Laplacian variance scales with resolution² — bleed-through
        # at 600 DPI is sharper than real ink at 150 DPI. Instead we compare
        # each region against the page median: bleed-through is always softer
        # than primary ink on the same scan regardless of DPI.
        candidates = []
        for cnt in contours:
            bx, by, bw, bh = cv2.boundingRect(cnt)
            area_frac = (bw * bh) / page_area
            if area_frac < self.MIN_REGION_AREA or area_frac > self.MAX_REGION_AREA:
                continue
            if bh / hp < self.MIN_REGION_H:
                continue
            nx_raw, ny_raw = bx / wp, by / hp
            nw_raw, nh_raw = bw / wp, bh / hp
            if nx_raw < self.BLEED_EDGE_MAX_X and nw_raw < self.BLEED_EDGE_MAX_W:
                continue
            if (nx_raw + nw_raw) > (1.0 - self.BLEED_EDGE_MAX_X) and nw_raw < self.BLEED_EDGE_MAX_W:
                continue
            seam_aspect = nw_raw / (nh_raw + 1e-6)
            if nh_raw > self.SEAM_MIN_H and seam_aspect < self.SEAM_MAX_ASPECT:
                continue
            cx = nx_raw + nw_raw / 2
            if (self.GUTTER_X_MIN < cx < self.GUTTER_X_MAX
                    and nw_raw < self.GUTTER_MAX_W):
                continue
            roi_gray = gray[by:by+bh, bx:bx+bw]
            sharpness = cv2.Laplacian(roi_gray, cv2.CV_64F).var()
            candidates.append((cnt, bx, by, bw, bh, nx_raw, ny_raw, nw_raw, nh_raw,
                                area_frac, sharpness))

        # Relative sharpness threshold: regions below 15% of the page median
        # are bleed-through. Falls back to absolute MIN_SHARPNESS if too few
        # candidates to compute a reliable median.
        if len(candidates) >= 3:
            median_sharpness = float(np.median([c[10] for c in candidates]))
            sharpness_threshold = max(self.MIN_SHARPNESS,
                                      median_sharpness * self.BLEED_SHARPNESS_RATIO)
        else:
            sharpness_threshold = self.MIN_SHARPNESS

        # ── Pass 2: classify surviving candidates ──────────
        regions = []
        for (cnt, bx, by, bw, bh, nx_raw, ny_raw, nw_raw, nh_raw,
             area_frac, sharpness) in candidates:

            # Sharpness filter: bleed-through is relatively soft vs primary ink
            if sharpness < sharpness_threshold:
                continue

            # Left-edge tightening only: morphological dilation inflates regions
            # leftward into the gutter/spine margin. Trim the LEFT edge to actual
            # ink extent. We do NOT tighten the right edge — poetry and ragged-right
            # text have few characters reaching the full width, so right-tightening
            # clips legitimate content (e.g. the last word on a long line).
            if nw_raw > 0.15:
                roi_tight = binary[by:by+bh, bx:bx+bw]
                col_ink = roi_tight.sum(axis=0)
                ink_col_thresh = max(col_ink.max() * 0.15, 1)
                ink_cols = np.where(col_ink > ink_col_thresh)[0]
                if len(ink_cols) > 4:
                    margin = max(3, int(wp * 0.004))
                    tight_bx = max(0, bx + ink_cols[0] - margin)
                    trimmed = bx - tight_bx  # how much we cut from left
                    # Only accept if we actually trimmed the left edge meaningfully
                    if trimmed > margin:
                        bw = bw + (bx - tight_bx)  # restore right edge
                        bx = tight_bx

            # Convert to full-image normalised coords
            nx = (px + bx) / w
            ny = (py + by) / h
            nw = bw / w
            nh = bh / h

            # Text density (used in classification)
            roi_binary = binary[by:by+bh, bx:bx+bw]
            text_density = roi_binary.mean() / 255.0

            # Classify using pre-tightening width (nw_raw) for header/pagenum
            # discrimination. Tightening can shrink a wide header below the 0.20
            # cutoff and cause it to be misclassified as a page number.
            rtype, confidence = self._classify(nx, ny, nw_raw, nh, text_density, area_frac)

            regions.append(Region(
                id=str(uuid.uuid4())[:8],
                type=rtype,
                x=nx, y=ny, w=nw, h=nh,
                confidence=confidence,
                source="detected",
            ))

        # ── 5. Merge overlapping regions ──────────────────
        regions = self._merge_overlapping(regions)

        # ── 6. Body region post-processing ───────────────
        # Drop noise regions (tiny unknowns from bleed-through)
        regions = [r for r in regions if not (r.type == 'unknown' and r.confidence < 0.20)]

        # Separate body from non-body; apply merge strategy
        body_regions = [r for r in regions if r.type == 'body']
        non_body     = [r for r in regions if r.type != 'body']

        # Always merge adjacent non-body same-type regions
        non_body = self._merge_adjacent_same_type(non_body, gap_threshold=0.06)

        if preserve_newlines:
            # No merging — every detected block stays independent
            pass
        elif preserve_paras:
            # Merge only within a paragraph (line gap ≤ 2.5% page height)
            body_regions = self._merge_adjacent_same_type(body_regions, gap_threshold=0.025)
        else:
            # Default: close all gaps then optionally collapse to one box
            body_regions = self._merge_adjacent_same_type(body_regions, gap_threshold=0.10)
            if merge_body and len(body_regions) > 1:
                body_regions = [self._merge_all_body(body_regions)]

        regions = non_body + body_regions

        # ── 6b. Demote false headers ──────────────────────
        # A running header must appear above the body text. Any region
        # classified as "header" whose top edge is at or below the top of
        # the earliest body region cannot be a real header — reclassify as body.
        body_tops = [r.y for r in regions if r.type == 'body']
        if body_tops:
            first_body_y = min(body_tops)
            regions = [
                Region(r.id, 'body', r.x, r.y, r.w, r.h, r.confidence, r.source)
                if r.type == 'header' and r.y >= first_body_y
                else r
                for r in regions
            ]

        # ── 7. Template blending ──────────────────────────
        if template is not None:
            regions = self._apply_template(regions, template, w, h)

        regions.sort(key=lambda r: r.y)
        return [r.to_dict() for r in regions]

    # ── Classification heuristics ─────────────────────────

    def _classify(self, x, y, w, h, text_density, area_frac):
        confidence = 0.7
        aspect = w / (h + 1e-6)

        # Running header: top zone, wide, short line
        # Width > 0.20 reliably distinguishes headers from page numbers
        if y < self.HEADER_ZONE and h < 0.08 and w > 0.20:
            return "header", 0.88

        # Page number: top zone, narrow, short
        if y < self.HEADER_ZONE and h < 0.08 and w <= 0.20:
            return "pagenum", 0.82

        # Page number: bottom zone
        if y > self.FOOTER_ZONE and h < 0.06 and w < 0.30:
            return "pagenum", 0.85

        # Footnote: lower page, moderate width
        if y > self.FOOTNOTE_MIN and h < 0.20 and w > 0.3:
            return "footnote", 0.72

        # Body text: main column area, or any region with readable density
        if text_density > 0.03:
            return "body", 0.80

        # Drop very small unknowns (likely bleed-through noise)
        if area_frac < 0.002:
            return "unknown", 0.10   # will be filtered by caller if desired

        return "unknown", 0.40

    # ── Merge all body regions into one bounding box ──────

    def _merge_all_body(self, body_regions: list) -> "Region":
        x1 = min(r.x for r in body_regions)
        y1 = min(r.y for r in body_regions)
        x2 = max(r.x + r.w for r in body_regions)
        y2 = max(r.y + r.h for r in body_regions)
        best_conf = max(r.confidence for r in body_regions)
        return Region(
            id=str(uuid.uuid4())[:8],
            type='body', x=x1, y=y1,
            w=x2 - x1, h=y2 - y1,
            confidence=best_conf, source='detected',
        )

    # ── Adjacent same-type merger ─────────────────────────

    def _merge_adjacent_same_type(self, regions: list, gap_threshold=0.06) -> list:
        if not regions:
            return regions
        changed = True
        while changed:
            changed = False
            merged = []
            used = set()
            regions_sorted = sorted(regions, key=lambda r: r.y)
            for i, ri in enumerate(regions_sorted):
                if i in used:
                    continue
                for j, rj in enumerate(regions_sorted):
                    if j <= i or j in used:
                        continue
                    if ri.type != rj.type:
                        continue
                    xi1, xi2 = ri.x, ri.x + ri.w
                    xj1, xj2 = rj.x, rj.x + rj.w
                    overlap = min(xi2, xj2) - max(xi1, xj1)
                    min_w = min(ri.w, rj.w)
                    if overlap < min_w * 0.5:
                        continue
                    gap = rj.y - (ri.y + ri.h)
                    if 0 <= gap <= gap_threshold:
                        new_x  = min(ri.x, rj.x)
                        new_y  = min(ri.y, rj.y)
                        new_x2 = max(ri.x + ri.w, rj.x + rj.w)
                        new_y2 = max(ri.y + ri.h, rj.y + rj.h)
                        ri = Region(
                            id=ri.id, type=ri.type,
                            x=new_x, y=new_y,
                            w=new_x2 - new_x, h=new_y2 - new_y,
                            confidence=max(ri.confidence, rj.confidence),
                            source=ri.source,
                        )
                        used.add(j)
                        changed = True
                merged.append(ri)
                used.add(i)
            regions = merged
        return regions

    # ── Overlap merging ───────────────────────────────────

    def _merge_overlapping(self, regions: list, iou_threshold=0.3) -> list:
        if not regions:
            return regions
        boxes = np.array([[r.x, r.y, r.x+r.w, r.y+r.h] for r in regions])
        merged_flags = [False] * len(regions)
        result = []
        for i, ri in enumerate(regions):
            if merged_flags[i]:
                continue
            group = [i]
            for j, rj in enumerate(regions):
                if i == j or merged_flags[j]:
                    continue
                if self._iou(boxes[i], boxes[j]) > iou_threshold:
                    group.append(j)
                    merged_flags[j] = True
            if len(group) == 1:
                result.append(ri)
            else:
                gx1 = min(boxes[k][0] for k in group)
                gy1 = min(boxes[k][1] for k in group)
                gx2 = max(boxes[k][2] for k in group)
                gy2 = max(boxes[k][3] for k in group)
                best = max(group, key=lambda k: regions[k].confidence)
                result.append(Region(
                    id=str(uuid.uuid4())[:8],
                    type=regions[best].type,
                    x=gx1, y=gy1, w=gx2-gx1, h=gy2-gy1,
                    confidence=regions[best].confidence * 0.9,
                    source="detected",
                ))
            merged_flags[i] = True
        return result

    @staticmethod
    def _iou(a, b) -> float:
        ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
        ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
        inter = max(0, ix2-ix1) * max(0, iy2-iy1)
        if inter == 0:
            return 0.0
        area_a = (a[2]-a[0]) * (a[3]-a[1])
        area_b = (b[2]-b[0]) * (b[3]-b[1])
        return inter / (area_a + area_b - inter)

    # ── Template blending ─────────────────────────────────

    def _apply_template(self, detected, template, w, h):
        template_regions = template.get_regions()
        used_detected = set()
        result = list(detected)
        for tr in template_regions:
            best_iou = 0.0
            best_idx = -1
            ta = [tr['x'], tr['y'], tr['x']+tr['w'], tr['y']+tr['h']]
            for i, dr in enumerate(detected):
                da = [dr.x, dr.y, dr.x+dr.w, dr.y+dr.h]
                iou = self._iou(ta, da)
                if iou > best_iou:
                    best_iou = iou
                    best_idx = i
            if best_iou > 0.4 and best_idx not in used_detected:
                result[best_idx] = Region(
                    **{**result[best_idx].to_dict(),
                       'confidence': min(0.98, result[best_idx].confidence + 0.15),
                       'source': 'detected+template'}
                )
                used_detected.add(best_idx)
            else:
                result.append(Region(
                    id=str(uuid.uuid4())[:8],
                    type=tr['type'],
                    x=tr['x'], y=tr['y'], w=tr['w'], h=tr['h'],
                    confidence=tr.get('confidence', 0.70) * 0.85,
                    source='template',
                ))
        return result
