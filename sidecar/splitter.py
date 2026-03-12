"""
splitter.py
Detects the spine/gutter of an open-book spread and splits into
left and right page images.

Strategy:
  1. Convert to grayscale
  2. Compute column-wise brightness profile
  3. Find the darkest vertical band in the centre third (the gutter shadow)
  4. Split there; fall back to geometric centre if detection is uncertain
"""

import os
from typing import Optional
import cv2
import numpy as np
from pathlib import Path


class SpineSplitter:

    # Only look for spine in the central band (as fraction of width)
    SEARCH_BAND = (0.35, 0.65)
    # Minimum darkness contrast required to trust the detected spine
    MIN_CONTRAST_RATIO = 0.08

    # Images with aspect ratio below this are treated as single pages
    # (portrait page ~0.7, open book spread ~1.4+)
    SPREAD_ASPECT_MIN = 1.1

    def split(self, image_path: str, out_dir: str) -> dict:
        """
        Split a spread image into left and right pages.
        If the image looks like a single page (narrow aspect ratio),
        returns it as-is without splitting.

        Returns:
            {
                left_path: str,
                right_path: Optional[str],
                spine_x: int,
                method: "detected" | "centre" | "single",
                image_w: int,
                image_h: int,
                is_single: bool,
            }
        """
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Cannot read image: {image_path}")

        h, w = img.shape[:2]
        Path(out_dir).mkdir(parents=True, exist_ok=True)

        # Detect single page by aspect ratio
        aspect = w / h
        if aspect < self.SPREAD_ASPECT_MIN:
            return self.split_single_page(image_path, out_dir)

        spine_x, method = self._find_spine(img)

        # Crop left and right pages
        left  = img[:, :spine_x]
        right = img[:, spine_x:]

        stem = Path(image_path).stem
        left_path  = os.path.join(out_dir, f"{stem}_left.jpg")
        right_path = os.path.join(out_dir, f"{stem}_right.jpg")

        cv2.imwrite(left_path,  left,  [cv2.IMWRITE_JPEG_QUALITY, 95])
        cv2.imwrite(right_path, right, [cv2.IMWRITE_JPEG_QUALITY, 95])

        return {
            "left_path":  left_path,
            "right_path": right_path,
            "spine_x":    spine_x,
            "method":     method,
            "image_w":    w,
            "image_h":    h,
            "is_single":  False,
        }

    def _find_spine(self, img: np.ndarray) -> tuple[int, str]:
        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Column-wise mean brightness
        col_mean = gray.mean(axis=0).astype(float)

        # Smooth to reduce noise from text lines
        kernel = np.ones(20) / 20
        col_smooth = np.convolve(col_mean, kernel, mode='same')

        # Search only in centre band
        lo = int(w * self.SEARCH_BAND[0])
        hi = int(w * self.SEARCH_BAND[1])
        band = col_smooth[lo:hi]

        global_mean = col_smooth.mean()
        band_min    = band.min()
        contrast    = (global_mean - band_min) / (global_mean + 1e-6)

        if contrast >= self.MIN_CONTRAST_RATIO:
            spine_x = int(lo + band.argmin())
            method  = "detected"
        else:
            spine_x = w // 2
            method  = "centre"

        # Clamp to safe range (never cut off more than 15% from either edge)
        spine_x = max(int(w * 0.15), min(int(w * 0.85), spine_x))
        return spine_x, method

    def split_single_page(self, image_path: str, out_dir: str) -> dict:
        """
        For title pages, plates etc. that are already single pages.
        Just copies / re-saves to out_dir.
        """
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Cannot read image: {image_path}")
        h, w = img.shape[:2]
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        stem = Path(image_path).stem
        out_path = os.path.join(out_dir, f"{stem}_single.jpg")
        cv2.imwrite(out_path, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        return {
            "left_path":  out_path,
            "right_path": None,
            "spine_x":    w,
            "method":     "single",
            "image_w":    w,
            "image_h":    h,
            "is_single":  True,
        }
