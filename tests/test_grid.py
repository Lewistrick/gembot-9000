"""Terrain and gem generation: the numpy generator must match the original
pure-Python one exactly, and gem sites must obey their placement rules."""

import hashlib
import json
from pathlib import Path

import numpy as np

from app.grid import (
    CHUNK,
    MEGA_COUNT,
    MEGA_MAX_DIST,
    MEGA_MIN_DIST,
    MEGA_VALUE,
    World,
    generate_chunk,
    seed_to_int,
)

GOLDEN = json.loads((Path(__file__).parent / "golden_chunks.json").read_text())


def test_dungeon_terrain_matches_original_generator() -> None:
    """Hashes were recorded from the pre-numpy pure-Python generator."""
    for key, want in GOLDEN.items():
        seed, cx, cy = key.rsplit(":", 2)
        grid = generate_chunk(seed_to_int(seed), int(cx), int(cy), "dungeon")
        bits = "".join("1" if v else "0" for row in grid for v in row)
        assert hashlib.sha256(bits.encode()).hexdigest() == want, key


def test_spawn_disk_is_floor() -> None:
    world = World("2026-10-22")
    assert all(world.is_floor(x, y) for x in range(-7, 8) for y in range(-7, 8))


def test_region_matches_is_floor_across_chunk_borders() -> None:
    world = World("2026-10-22")
    x0, y0, cols, rows = -40, -35, 90, 80  # spans several chunks in both axes
    region = world.region(x0, y0, cols, rows)
    assert region.shape == (rows, cols)
    for r in range(0, rows, 7):
        for c in range(0, cols, 5):
            assert bool(region[r, c]) == world.is_floor(x0 + c, y0 + r)


def test_floor_bits_round_trip() -> None:
    world = World("2026-10-22")
    bits = np.unpackbits(np.frombuffer(world.floor_bits(2, -1), dtype=np.uint8))
    bits = bits[: CHUNK * CHUNK].reshape(CHUNK, CHUNK).astype(bool)
    assert (bits == world.chunk(2, -1).floor).all()


def test_eviction_regenerates_identical_chunk() -> None:
    world = World("2026-10-22")
    world.max_chunks = 4
    before = world.chunk(5, 5).floor.copy()
    for i in range(20):
        world.chunk(i, 9)
    assert (5, 5) not in world._chunks
    assert (world.chunk(5, 5).floor == before).all()


def test_gems_sit_on_wall_touching_floor_and_are_deterministic() -> None:
    a, b = World("2026-10-22"), World("2026-10-22")
    total = 0
    for cx in range(-3, 3):
        for cy in range(-3, 3):
            gems = a.chunk_gems(cx, cy)
            assert gems == b.chunk_gems(cx, cy)
            for (x, y), value in gems.items():
                assert a._wall_floor(x, y), (x, y)  # incl. cells on chunk edges
                assert value >= 10
            total += len(gems)
    assert total > 50


def test_gem_value_grows_with_distance() -> None:
    world = World("2026-10-22")
    near = [v for x, y, v in world.gems_in(-120, -120, 240, 240) if v < MEGA_VALUE]
    far = [v for x, y, v in world.gems_in(200, 200, 300, 300) if v < MEGA_VALUE]
    assert near and far
    assert sum(far) / len(far) > 2 * sum(near) / len(near)


def test_mega_gems_placed_far_out_and_fixed_value() -> None:
    world = World("2026-10-22")
    sites = world.mega_sites
    assert len(sites) == MEGA_COUNT
    for (x, y), value in sites.items():
        assert value == MEGA_VALUE
        assert world.is_mega(x, y)
        assert world._wall_floor(x, y)
        assert world.gem_on_floor(x, y) == MEGA_VALUE
        assert MEGA_MIN_DIST - 45 <= (x * x + y * y) ** 0.5 <= MEGA_MAX_DIST + 45
    assert World("2026-10-22").mega_sites == sites
    assert World("2026-10-23").mega_sites != sites
