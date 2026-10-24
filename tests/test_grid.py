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


def test_gems_are_common_near_the_base_and_sparse_but_evenly_spread_far_out() -> None:
    import math

    world = World("2026-10-22")
    inner = [g for g in world.gems_in(-200, -200, 400, 400) if g[2] < MEGA_VALUE]
    assert len(inner) > 100  # plenty within the inner radius
    megas = (
        world.mega_sites
    )  # (far gems can be worth as much as a mega gem: tell them by place)
    far = [
        (x, y) for x, y, _ in world.gems_in(450, 450, 900, 900) if (x, y) not in megas
    ]
    # about one per 150x150 square out there (36 squares here, a few spill over the edge)
    assert 30 <= len(far) <= 40
    nn = [
        min(math.hypot(x - a, y - b) for a, b in far if (a, b) != (x, y))
        for x, y in far
    ]
    mostly = sum(90 <= d <= 210 for d in nn) / len(nn)
    assert mostly >= 0.8  # neighbours mostly 100-200 tiles apart


def test_every_far_square_gets_one_gem_and_chunks_agree_on_it() -> None:
    a, b = World("2026-10-24"), World("2026-10-24")
    sites = [a._outer_site(gx, gy) for gx in range(3, 9) for gy in range(3, 9)]
    found = [st for st in sites if st is not None]
    assert len(found) == len(sites)
    for x, y in found[
        :6
    ]:  # the chunk holding the site has the gem, however it is reached
        assert (x, y) in b.chunk_gems(x // CHUNK, y // CHUNK)
