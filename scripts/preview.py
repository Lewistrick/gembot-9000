"""Render a region of a world to a PNG (pure stdlib) for a quick visual check.

Usage: uv run python scripts/preview.py <seed> <out.png>
"""

import struct
import sys
import zlib

from app.grid import World


def _png(path: str, w: int, h: int, rows: list[bytes]) -> None:
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b"")
        )


def _rgb(hexcol: str) -> tuple[int, int, int]:
    h = hexcol.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def render(
    seed: str,
    out: str,
    style: str = "dungeon",
    cols: int = 160,
    rows: int = 110,
    px: int = 5,
) -> None:
    world = World(seed, style)
    floor = _rgb(world.colors["floor"])
    rock = _rgb(world.colors["rock"])
    x0, y0 = -cols // 2, -rows // 2
    scaled: list[bytes] = []
    for r in range(rows):
        line = bytearray()
        for c in range(cols):
            px_bytes = bytes(floor if world.is_floor(x0 + c, y0 + r) else rock)
            line += px_bytes * px  # widen each tile horizontally
        row = bytes(line)
        scaled.extend([row] * px)  # widen each tile vertically
    _png(out, cols * px, rows * px, scaled)
    print(f"wrote {out} for seed {seed}")


if __name__ == "__main__":
    style = sys.argv[3] if len(sys.argv) > 3 else "dungeon"
    render(sys.argv[1], sys.argv[2], style)
