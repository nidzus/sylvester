#!/usr/bin/env python3
"""Draws the app icon (assets/icon.png, 1024 x 1024, no transparency as the App Store requires): a white dumbbell on
the app's green. Standard library only, so anyone can regenerate it:  python scripts/make-icon.py"""

import struct
import zlib
from pathlib import Path

N = 1024
GREEN, WHITE, SHADE = (47, 107, 79), (255, 255, 255), (222, 236, 228)


def rounded(x, y, x0, y0, x1, y1, r):
    """Inside a rounded rectangle."""
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


SHAPES = [  # (colour, x0, y0, x1, y1, corner radius)
    (SHADE, 232, 496, 792, 528, 16),   # the bar
    (WHITE, 300, 332, 380, 692, 28),   # inner plates
    (WHITE, 644, 332, 724, 692, 28),
    (WHITE, 220, 392, 290, 632, 24),   # outer plates
    (WHITE, 734, 392, 804, 632, 24),
    (WHITE, 176, 472, 220, 552, 14),   # collars
    (WHITE, 804, 472, 848, 552, 14),
]


def pixel(x, y):
    for colour, x0, y0, x1, y1, r in SHAPES:
        if rounded(x, y, x0, y0, x1, y1, r):
            return colour
    return GREEN


def png(path):
    rows = b"".join(b"\x00" + bytes(c for x in range(N) for c in pixel(x, y)) for y in range(N))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", N, N, 8, 2, 0, 0, 0)
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "assets" / "icon.png"
    png(out)
    print(out)
