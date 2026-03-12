"""
template.py
Volume template: learns the expected layout of a volume from
confirmed/corrected pages and propagates it to new pages.

After MIN_SAMPLES confirmed pages, the template is "active" and
will be passed to the detector for template-blended results.

Each region type is tracked independently. For each type we store:
  - Mean normalised position (cx, cy) and size (w, h)
  - Standard deviation (for confidence scoring)
  - Count

On each new page the template predicts expected regions; the detector
blends them with its own detections.
"""

import json
import math
from collections import defaultdict
from pathlib import Path
import uuid


MIN_SAMPLES = 3          # Pages needed before template is "active"
MAX_SAMPLES = 50         # Cap to avoid memory growth; use rolling window


class RegionStats:
    """Running mean + variance for a single region slot."""

    def __init__(self):
        self.n    = 0
        self.mean = {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}
        self.M2   = {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}  # Welford

    def update(self, x, y, w, h):
        self.n += 1
        for key, val in [("x", x), ("y", y), ("w", w), ("h", h)]:
            delta  = val - self.mean[key]
            self.mean[key] += delta / self.n
            delta2 = val - self.mean[key]
            self.M2[key] += delta * delta2

    def variance(self, key) -> float:
        if self.n < 2:
            return 0.1
        return self.M2[key] / (self.n - 1)

    def std(self, key) -> float:
        return math.sqrt(self.variance(key))

    def confidence(self) -> float:
        """Higher confidence when position is stable across samples."""
        if self.n < MIN_SAMPLES:
            return 0.0
        pos_std = self.std("x") + self.std("y")
        # Map: std=0 → 0.95, std=0.1 → ~0.5, std=0.2+ → ~0.3
        return max(0.3, min(0.95, 0.95 - pos_std * 4.5))

    def to_dict(self) -> dict:
        return {
            "n":    self.n,
            "mean": self.mean.copy(),
            "std":  {k: self.std(k) for k in self.mean},
            "confidence": self.confidence(),
        }

    @staticmethod
    def from_dict(d: dict) -> "RegionStats":
        rs = RegionStats()
        rs.n    = d["n"]
        rs.mean = d["mean"]
        # Rebuild M2 from stored std (approximate)
        rs.M2 = {k: (d["std"][k] ** 2) * max(1, rs.n - 1) for k in rs.mean}
        return rs


class VolumeTemplate:

    def __init__(self, volume_id: str):
        self.volume_id  = volume_id
        self.n_samples  = 0
        # type → list of RegionStats (one per distinct region slot)
        # Simple model: one slot per type for now (single-column periodicals)
        self._stats: dict[str, list[RegionStats]] = defaultdict(list)

    @property
    def is_active(self) -> bool:
        return self.n_samples >= MIN_SAMPLES

    def add_sample(self, regions: list[dict], image_w: int, image_h: int):
        """
        Feed a confirmed page layout into the template.
        Regions should already be normalised (0–1 coords).
        """
        # Group by type
        by_type: dict[str, list[dict]] = defaultdict(list)
        for r in regions:
            rtype = r.get('type', 'unknown')
            if rtype in ('unknown',):
                continue
            by_type[rtype].append(r)

        for rtype, rlist in by_type.items():
            # Sort by vertical position so slot indices are stable
            rlist_sorted = sorted(rlist, key=lambda r: r['y'])

            # Grow slots list if needed
            while len(self._stats[rtype]) < len(rlist_sorted):
                self._stats[rtype].append(RegionStats())

            for i, r in enumerate(rlist_sorted):
                self._stats[rtype][i].update(r['x'], r['y'], r['w'], r['h'])

        self.n_samples = min(self.n_samples + 1, MAX_SAMPLES)

    def get_regions(self) -> list[dict]:
        """
        Return predicted regions from template (only if active).
        """
        if not self.is_active:
            return []

        regions = []
        for rtype, slots in self._stats.items():
            for slot in slots:
                if slot.n < MIN_SAMPLES:
                    continue
                regions.append({
                    "id":         str(uuid.uuid4())[:8],
                    "type":       rtype,
                    "x":          slot.mean["x"],
                    "y":          slot.mean["y"],
                    "w":          slot.mean["w"],
                    "h":          slot.mean["h"],
                    "confidence": slot.confidence(),
                    "source":     "template",
                })
        return regions

    def summary(self) -> dict:
        return {
            "volume_id":  self.volume_id,
            "n_samples":  self.n_samples,
            "is_active":  self.is_active,
            "types":      {t: len(slots) for t, slots in self._stats.items()},
            "min_samples_needed": max(0, MIN_SAMPLES - self.n_samples),
        }

    def to_dict(self) -> dict:
        return {
            "volume_id": self.volume_id,
            "n_samples": self.n_samples,
            "stats": {
                rtype: [s.to_dict() for s in slots]
                for rtype, slots in self._stats.items()
            }
        }

    def save(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w') as f:
            json.dump(self.to_dict(), f, indent=2)

    def load(self, path: str):
        with open(path, 'r') as f:
            d = json.load(f)
        self.volume_id = d['volume_id']
        self.n_samples = d['n_samples']
        self._stats    = defaultdict(list)
        for rtype, slot_list in d.get('stats', {}).items():
            self._stats[rtype] = [RegionStats.from_dict(s) for s in slot_list]
