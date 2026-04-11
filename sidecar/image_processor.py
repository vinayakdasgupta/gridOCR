"""
image_processor.py
Image manipulation operations for gridOCR.
All operations save to a new file and return the new path.
The original is never overwritten.
"""

import cv2
import numpy as np
import os
from pathlib import Path


def _save(path: str, img) -> None:
    """Save image, using PNG for .png files, JPEG otherwise."""
    ext = Path(path).suffix.lower()
    if ext == '.png':
        cv2.imwrite(path, img)
    else:
        cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 95])


def _out_path(image_path: str, suffix: str) -> str:
    """Generate output path by appending suffix before extension."""
    p = Path(image_path)
    return str(p.parent / f"{p.stem}_{suffix}{p.suffix}")


def deskew(image_path: str) -> dict:
    """
    Detect and correct skew using Hough line detection.
    Returns {ok, new_path, angle} where angle is degrees corrected.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"ok": False, "error": f"Cannot read: {image_path}"}

    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Binarise
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Detect lines via Hough
    edges = cv2.Canny(binary, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=100,
                             minLineLength=w//4, maxLineGap=20)

    if lines is None or len(lines) == 0:
        # No lines found — return original
        return {"ok": True, "new_path": image_path, "angle": 0.0}

    # Collect angles of near-horizontal lines only
    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        if x2 == x1:
            continue
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        # Only consider lines within ±20° of horizontal
        if abs(angle) <= 20:
            angles.append(angle)

    if not angles:
        return {"ok": True, "new_path": image_path, "angle": 0.0}

    # Use median angle
    skew_angle = float(np.median(angles))

    if abs(skew_angle) < 0.1:
        return {"ok": True, "new_path": image_path, "angle": 0.0}

    # Rotate to correct skew
    corrected = _rotate_image(img, skew_angle)
    out = _out_path(image_path, "deskewed")
    _save(out, corrected)
    return {"ok": True, "new_path": out, "angle": round(skew_angle, 2)}


def rotate(image_path: str, angle: float) -> dict:
    """
    Rotate image by given angle (degrees, positive = clockwise).
    For 90/180/270 uses lossless cv2 rotation; otherwise full rotation.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"ok": False, "error": f"Cannot read: {image_path}"}

    angle = float(angle) % 360

    # Lossless for right angles
    if angle in (90, 270, 180):
        if angle == 90:
            rotated = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        elif angle == 270:
            rotated = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
        else:
            rotated = cv2.rotate(img, cv2.ROTATE_180)
    else:
        rotated = _rotate_image(img, -angle)  # negative = clockwise

    out = _out_path(image_path, f"rotated_{int(angle)}")
    _save(out, rotated)
    return {"ok": True, "new_path": out}


def adjust_levels(image_path: str, black_pt: int, white_pt: int,
                  gamma: float = 1.0) -> dict:
    """
    Apply levels adjustment: remap [black_pt..white_pt] to [0..255],
    then apply gamma correction.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"ok": False, "error": f"Cannot read: {image_path}"}

    black_pt = max(0, min(254, int(black_pt)))
    white_pt = max(black_pt + 1, min(255, int(white_pt)))
    gamma    = max(0.1, min(5.0, float(gamma)))

    # Build LUT
    lut = np.zeros(256, dtype=np.uint8)
    for i in range(256):
        val = (i - black_pt) / (white_pt - black_pt)
        val = np.clip(val, 0.0, 1.0)
        if gamma != 1.0:
            val = val ** (1.0 / gamma)
        lut[i] = int(np.clip(val * 255, 0, 255))

    adjusted = cv2.LUT(img, lut)
    out = _out_path(image_path, "levels")
    _save(out, adjusted)
    return {"ok": True, "new_path": out}


def perspective_correct(image_path: str, src_points: list) -> dict:
    """
    Apply perspective correction given four source points.
    src_points: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] as fractions (0-1)
    in order: top-left, top-right, bottom-right, bottom-left.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"ok": False, "error": f"Cannot read: {image_path}"}

    h, w = img.shape[:2]

    # Convert normalised points to pixels
    pts = np.array([[p[0]*w, p[1]*h] for p in src_points], dtype=np.float32)
    tl, tr, br, bl = pts

    # Compute destination dimensions
    width_top    = np.linalg.norm(tr - tl)
    width_bottom = np.linalg.norm(br - bl)
    dst_w = int(max(width_top, width_bottom))

    height_left  = np.linalg.norm(bl - tl)
    height_right = np.linalg.norm(br - tr)
    dst_h = int(max(height_left, height_right))

    dst_pts = np.array([
        [0,         0        ],
        [dst_w - 1, 0        ],
        [dst_w - 1, dst_h - 1],
        [0,         dst_h - 1],
    ], dtype=np.float32)

    M = cv2.getPerspectiveTransform(pts, dst_pts)
    warped = cv2.warpPerspective(img, M, (dst_w, dst_h),
                                  flags=cv2.INTER_CUBIC)

    out = _out_path(image_path, "perspective")
    _save(out, warped)
    return {"ok": True, "new_path": out, "new_w": dst_w, "new_h": dst_h}


def _rotate_image(img: np.ndarray, angle: float) -> np.ndarray:
    """
    Rotate image by angle degrees (positive = counter-clockwise in image coords).
    After rotation, crop to the largest axis-aligned rectangle that fits
    within the rotated content — no expanding whitespace.
    """
    h, w = img.shape[:2]
    cx, cy = w / 2, h / 2
    M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)

    # Expand canvas to fit rotated image
    cos = abs(M[0, 0]); sin = abs(M[0, 1])
    new_w = int(h * sin + w * cos)
    new_h = int(h * cos + w * sin)
    M[0, 2] += new_w / 2 - cx
    M[1, 2] += new_h / 2 - cy

    rotated = cv2.warpAffine(img, M, (new_w, new_h),
                              flags=cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_REPLICATE)

    # Crop to largest inscribed rectangle (removes border artifacts)
    # For small angles the inscribed rect is well approximated by:
    rad = abs(np.radians(angle))
    if rad < 1e-4:
        return rotated
    # Largest rectangle inscribed in rotated original rectangle
    if w <= 0 or h <= 0:
        return rotated
    cos_a = np.cos(rad); sin_a = np.sin(rad)
    if w >= h:
        half_w = h * sin_a / 2 / cos_a if cos_a > 1e-6 else 0
        in_w = int(w * cos_a - h * sin_a)
        in_h = int(h * cos_a - w * sin_a) if h * cos_a > w * sin_a else int((h - w * sin_a) / cos_a)
    else:
        in_w = int(w * cos_a - h * sin_a) if w * cos_a > h * sin_a else int((w - h * sin_a) / cos_a)
        in_h = int(h * cos_a - w * sin_a)

    in_w = max(1, in_w)
    in_h = max(1, in_h)

    # Centre-crop
    rh, rw = rotated.shape[:2]
    x1 = max(0, (rw - in_w) // 2)
    y1 = max(0, (rh - in_h) // 2)
    x2 = min(rw, x1 + in_w)
    y2 = min(rh, y1 + in_h)

    return rotated[y1:y2, x1:x2]