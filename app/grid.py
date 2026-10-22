"""Infinite chunk-based grid generation for GemBot 9000.

The world is an infinite 2D grid of two tile kinds: ``floor`` (walkable corridor)
and ``rock`` (obstacle). It is generated in ``CHUNK`` x ``CHUNK`` chunks, each a
*pure function* of ``(seed, chunk_x, chunk_y, style)`` so any cell can be produced
on demand and a chunk always looks identical no matter when it is computed.

Three generation styles are available:

* ``"dungeon"`` (default, dense & organic) — fractal (Perlin-style) value noise
  smoothed by cellular automata into thick, irregular rock masses with winding
  floor chambers. No lattice, no erosion and no tunnelling: rocks form thick
  blocks (they need not border a corridor) and chambers connect only where the
  terrain itself connects them, so some chambers are sealed off.
* ``"aisles"`` (dense, regular) — a randomised braided maze of 1-wide corridors on
  a node lattice; every rock borders a corridor and all floor is reachable, at
  the cost of a visible grid.
* ``"cave"`` (sparse) — the same noise+CA as dungeon but floor-majority, eroded so
  rocks survive only as thin winding outlines.

The noise+CA is computed with an apron sampled from neighbouring chunks, so
terrain flows seamlessly across borders with no shared state. The aisles and cave
styles add **gateway stitching** — guaranteed floor cells on each chunk edge,
keyed by the shared edge id so neighbours agree on the exact world cells — plus
erosion and tunnelling to guarantee every floor tile is reachable.
"""

import colorsys
import hashlib
import math
import threading
from collections import OrderedDict

import numpy as np

CHUNK: int = 33
"""Chunk edge length in tiles.

Odd, so with step-2 aisles both chunk edges fall on node (floor-capable) columns
and neighbouring chunks interlock instead of meeting wall-to-wall at the border.
"""

_CA_ITERS: int = 3
"""Cellular-automata smoothing passes (also the apron width in tiles)."""

_AISLE_STEP: int = 2
"""Maze node spacing for the dense ``aisles`` style.

Tighter spacing keeps more rocks legally bordered, so *less* erosion fires and
more rock survives — 2 is the densest clean setting (~44% rock).
"""

_BRAID_PERMILLE: int = 90
"""Chance in 1000 of carving an extra corridor, adding loops (multiple paths)."""

_GATES_PER_EDGE: int = 6
"""Doorways carved per chunk edge; more keeps chunk borders porous and seamless."""

DEFAULT_STYLE: str = "dungeon"
"""Generation style used when none is specified."""

_SPAWN_RADIUS: int = 10
"""Tiles within this Euclidean radius of the origin are always floor (spawn area)."""

BASE_RADIUS: int = _SPAWN_RADIUS
"""The base: gems carried into this disk around the origin are delivered."""

_HUE_RATE: float = 0.0005
"""Hue turns (0..1) per tile of distance from the origin — a very slow colour drift."""

_GEM_MAX_P: float = 0.02
"""Gem chance per floor tile at the origin; decays with distance from it."""

_GEM_FALLOFF: float = 120.0
"""Distance (tiles) over which the gem chance falls off by a factor of e."""

_GEM_VALUE_MIN: int = 10
_GEM_VALUE_MAX: int = 40
"""Base value range of an ordinary gem, before the distance bonus."""

_GEM_VALUE_DIST: float = 150.0
"""Distance (tiles) at which an ordinary gem's value has doubled: ``v * (1 + d / this)``."""

MEGA_COUNT: int = 10
MEGA_VALUE: int = 250
MEGA_MIN_DIST: float = 60.0
MEGA_MAX_DIST: float = 400.0
"""Rare "mega" gems: how many exist per world, their fixed value, and the ring
(distance from the origin) their target positions are drawn from."""

_MEGA_SNAP_RADIUS: int = 40
"""How far (tiles) a mega gem's target may be moved to reach a wall-touching floor cell."""

_CACHE_CHUNKS: int = 20000
"""Default chunk-cache size (~1 KB each), enough to hold a whole day's exploration."""

_MASK: int = (1 << 64) - 1


# --------------------------------------------------------------------------- #
# Hashing / deterministic randomness
# --------------------------------------------------------------------------- #
def _mix64(x: int) -> int:
    """Splitmix64 finaliser: scramble a 64-bit integer into a well-mixed one."""
    x = (x + 0x9E3779B97F4A7C15) & _MASK
    x = ((x ^ (x >> 30)) * 0xBF58476D1CE4E5B9) & _MASK
    x = ((x ^ (x >> 27)) * 0x94D049BB133111EB) & _MASK
    return x ^ (x >> 31)


def _hash(seed: int, *vals: int) -> int:
    """Hash a seed plus an arbitrary tuple of integers into a 64-bit value."""
    h = seed & _MASK
    for v in vals:
        h = _mix64(h ^ (v & _MASK))
    return h


def _rand01(seed: int, *vals: int) -> float:
    """Deterministic float in ``[0, 1)`` from a seed and integer coordinates."""
    return (_hash(seed, *vals) >> 11) / float(1 << 53)


def seed_to_int(seed: str) -> int:
    """Convert a seed string (e.g. a date) into a stable 64-bit integer.

    Uses SHA-256 rather than :func:`hash` so the value is identical across
    processes and runs.
    """
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


# --------------------------------------------------------------------------- #
# Vectorised hashing (bit-for-bit the same maths as the scalar helpers above)
# --------------------------------------------------------------------------- #
_U64 = np.uint64


def _mix64_arr(x: np.ndarray) -> np.ndarray:
    x = x + _U64(0x9E3779B97F4A7C15)
    x = (x ^ (x >> _U64(30))) * _U64(0xBF58476D1CE4E5B9)
    x = (x ^ (x >> _U64(27))) * _U64(0x94D049BB133111EB)
    return x ^ (x >> _U64(31))


def _hash_arr(seed: int, shape: tuple[int, ...], *vals: np.ndarray | int) -> np.ndarray:
    """Array version of :func:`_hash`: ints and int arrays are mixed in order."""
    h = np.full(shape, seed & _MASK, dtype=_U64)
    for v in vals:
        if isinstance(v, int):
            u = np.full(shape, v & _MASK, dtype=_U64)
        else:
            u = np.asarray(v, dtype=np.int64).view(_U64)
        h = _mix64_arr(h ^ u)
    return h


def _rand01_arr(
    seed: int, shape: tuple[int, ...], *vals: np.ndarray | int
) -> np.ndarray:
    return (_hash_arr(seed, shape, *vals) >> _U64(11)).astype(np.float64) / float(
        1 << 53
    )


# --------------------------------------------------------------------------- #
# Fractal value noise (Perlin-style) + cellular automata, vectorised
# --------------------------------------------------------------------------- #
def _smoothstep(t: np.ndarray) -> np.ndarray:
    return t * t * (3.0 - 2.0 * t)


def _fractal_field(
    seed: int, cx: int, cy: int, pad: int, scale: float, octaves: int = 3
) -> np.ndarray:
    """Fractal value noise in ``[0, 1]`` over the chunk plus an ``pad``-wide apron.

    Three octaves of bilinearly-interpolated, smoothstep-eased lattice noise. The
    apron samples the same global field, so neighbouring chunks agree exactly.
    """
    size = CHUNK + 2 * pad
    rows, cols = np.mgrid[0:size, 0:size]
    wx = (cx * CHUNK - pad + cols) * scale
    wy = (cy * CHUNK - pad + rows) * scale
    shape = (size, size)
    total = np.zeros(shape)
    amp, freq, norm = 1.0, 1.0, 0.0
    for o in range(octaves):
        sd = seed ^ (o * 0x9E37)
        x, y = wx * freq, wy * freq
        x0 = np.floor(x).astype(np.int64)
        y0 = np.floor(y).astype(np.int64)
        fx, fy = _smoothstep(x - x0), _smoothstep(y - y0)

        def lat(ix: np.ndarray, iy: np.ndarray, sd: int = sd) -> np.ndarray:
            return _rand01_arr(sd, shape, 0x1234, ix, iy)

        top = lat(x0, y0) + (lat(x0 + 1, y0) - lat(x0, y0)) * fx
        bot = lat(x0, y0 + 1) + (lat(x0 + 1, y0 + 1) - lat(x0, y0 + 1)) * fx
        total += amp * (top + (bot - top) * fy)
        norm += amp
        amp *= 0.5
        freq *= 2.0
    return total / norm


def _cellular_pass(field: np.ndarray) -> np.ndarray:
    """One cave-smoothing CA step: a cell is floor iff its 3x3 block has >=5 floors.

    Border cells of the padded field keep their value (the apron absorbs edge
    effects).
    """
    n = field.shape[0]
    count = np.zeros((n - 2, n - 2), dtype=np.int8)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            count += field[1 + dr : n - 1 + dr, 1 + dc : n - 1 + dc]
    out = field.copy()
    out[1:-1, 1:-1] = count >= 5
    return out


def _ca_array(
    seed: int, cx: int, cy: int, scale: float, thresh: float, iters: int
) -> np.ndarray:
    """Fractal-noise field smoothed by ``iters`` CA passes, cropped to the chunk.

    Computed over an ``iters``-wide apron so terrain flows seamlessly across chunk
    borders, then cropped to the ``CHUNK`` x ``CHUNK`` interior (``True`` = floor).
    """
    field = _fractal_field(seed, cx, cy, iters, scale) > thresh
    for _ in range(iters):
        field = _cellular_pass(field)
    return field[iters : iters + CHUNK, iters : iters + CHUNK]


def _ca_grid(
    seed: int, cx: int, cy: int, scale: float, thresh: float, iters: int
) -> list[list[bool]]:
    return _ca_array(seed, cx, cy, scale, thresh, iters).tolist()


def _gateway_positions(seed: int, cx: int, cy: int) -> list[tuple[int, int]]:
    """Local ``(row, col)`` cells to force to floor so this chunk joins neighbours.

    ``_GATES_PER_EDGE`` gateways per edge, each keyed by the id of the *shared*
    edge so both chunks touching that edge compute the identical world cell.
    Several doorways per edge keep chunk borders porous (no visible seam wall).
    """
    last = CHUNK - 1
    gates: list[tuple[int, int]] = []
    for k in range(_GATES_PER_EDGE):
        gates.append((_hash(seed, 1, cx - 1, cy, k) % CHUNK, 0))  # left
        gates.append((_hash(seed, 1, cx, cy, k) % CHUNK, last))  # right
        gates.append((0, _hash(seed, 2, cx, cy - 1, k) % CHUNK))  # top
        gates.append((last, _hash(seed, 2, cx, cy, k) % CHUNK))  # bottom
    return gates


def _erode_unbordered_rocks(grid: list[list[bool]]) -> None:
    """Flip any rock with no orthogonal in-chunk floor neighbour to floor.

    Uses a snapshot so a thick wall collapses to a single-tile-thick shell in one
    pass. Out-of-chunk neighbours are treated as non-floor (pessimistic), so every
    surviving rock is guaranteed to border real floor. Mutates ``grid``.
    """
    snap = [row[:] for row in grid]
    for r in range(CHUNK):
        for c in range(CHUNK):
            if snap[r][c]:
                continue  # already floor
            bordered = (
                (r > 0 and snap[r - 1][c])
                or (r < CHUNK - 1 and snap[r + 1][c])
                or (c > 0 and snap[r][c - 1])
                or (c < CHUNK - 1 and snap[r][c + 1])
            )
            if not bordered:
                grid[r][c] = True


def _label_regions(grid: list[list[bool]]) -> list[list[tuple[int, int]]]:
    """Return the connected floor regions as lists of ``(row, col)`` cells."""
    seen = [[False] * CHUNK for _ in range(CHUNK)]
    regions: list[list[tuple[int, int]]] = []
    for sr in range(CHUNK):
        for sc in range(CHUNK):
            if not grid[sr][sc] or seen[sr][sc]:
                continue
            stack = [(sr, sc)]
            seen[sr][sc] = True
            cells: list[tuple[int, int]] = []
            while stack:
                r, c = stack.pop()
                cells.append((r, c))
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nr, nc = r + dr, c + dc
                    if (
                        0 <= nr < CHUNK
                        and 0 <= nc < CHUNK
                        and grid[nr][nc]
                        and not seen[nr][nc]
                    ):
                        seen[nr][nc] = True
                        stack.append((nr, nc))
            regions.append(cells)
    return regions


def _connect_regions(grid: list[list[bool]]) -> None:
    """L-tunnel every floor region into the largest one. Mutates ``grid``.

    Guarantees a single connected floor component. Tunnels only add floor. Used by
    the aisles and cave styles (the dungeon style leaves chambers as generated).
    """
    regions = _label_regions(grid)
    if len(regions) <= 1:
        return
    main = max(regions, key=len)
    mr, mc = main[0]
    for region in regions:
        if region is main:
            continue
        rr, rc = region[0]
        for c in range(min(rc, mc), max(rc, mc) + 1):
            grid[rr][c] = True
        for r in range(min(rr, mr), max(rr, mr) + 1):
            grid[r][mc] = True


def _cave_grid(seed: int, cx: int, cy: int) -> list[list[bool]]:
    """Sparse organic style: open caverns with thin winding rock outlines."""
    return _ca_grid(seed, cx, cy, scale=0.34, thresh=0.50, iters=_CA_ITERS)


def _dungeon_array(seed: int, cx: int, cy: int) -> np.ndarray:
    """Dense organic style as a numpy bool array (see :func:`_dungeon_grid`)."""
    return _ca_array(seed, cx, cy, scale=0.16, thresh=0.50, iters=5)


def _dungeon_grid(seed: int, cx: int, cy: int) -> list[list[bool]]:
    """Dense organic style: irregular rock masses and floor chambers.

    Pure fractal-noise + cellular-automata terrain — no gateways, no erosion and
    no tunnelling. Rock blocks stay thick and organic (rocks need not border a
    corridor), and chambers are connected only where the terrain itself connects
    them (most of the floor, but some chambers are sealed off).
    """
    return _dungeon_array(seed, cx, cy).tolist()


def _carve_between(
    grid: list[list[bool]], r: int, c: int, dr: int, dc: int, step: int
) -> None:
    """Carve a 1-wide corridor from node ``(r, c)`` to the node ``step`` away."""
    sr = (dr > 0) - (dr < 0)
    sc = (dc > 0) - (dc < 0)
    for k in range(step + 1):
        grid[r + sr * k][c + sc * k] = True


def _aisle_grid(seed: int, cx: int, cy: int) -> list[list[bool]]:
    """Dense style: a randomised braided maze of 1-wide aisles through rock.

    Nodes sit on a ``_AISLE_STEP`` lattice and are always floor. A deterministic
    randomised-DFS spanning tree carves 1-wide corridors between them (connecting
    all aisles), then braiding carves a few extra corridors to add loops. Erosion
    (applied later) opens any rock left unbordered.
    """
    step = _AISLE_STEP
    grid = [[False] * CHUNK for _ in range(CHUNK)]
    coords = list(range(0, CHUNK, step))
    nodeset = set(coords)

    state = _hash(seed, 7, cx, cy)

    def rnd() -> int:
        nonlocal state
        state = _mix64(state)
        return state

    # Randomised-DFS (recursive backtracker) spanning tree over the node lattice.
    start = (0, 0)
    grid[0][0] = True
    visited = {start}
    stack = [start]
    while stack:
        r, c = stack[-1]
        nbrs = [
            (dr, dc)
            for dr, dc in ((step, 0), (-step, 0), (0, step), (0, -step))
            if (r + dr) in nodeset
            and (c + dc) in nodeset
            and (r + dr, c + dc) not in visited
        ]
        if not nbrs:
            stack.pop()
            continue
        dr, dc = nbrs[rnd() % len(nbrs)]
        _carve_between(grid, r, c, dr, dc, step)
        visited.add((r + dr, c + dc))
        stack.append((r + dr, c + dc))

    # Braiding: occasionally carve an extra edge to create loops (multiple paths).
    for r in coords:
        for c in coords:
            for dr, dc in ((step, 0), (0, step)):
                if (
                    (r + dr) in nodeset
                    and (c + dc) in nodeset
                    and rnd() % 1000 < _BRAID_PERMILLE
                ):
                    _carve_between(grid, r, c, dr, dc, step)
    return grid


def _carve_spawn_disk(grid: list[list[bool]], cx: int, cy: int) -> None:
    """Force cells within ``_SPAWN_RADIUS`` of the origin to floor. Mutates ``grid``.

    Only chunks overlapping the disk do any work (the rest reject in O(1)).
    """
    bx, by = cx * CHUNK, cy * CHUNK
    nearest_x = min(max(0, bx), bx + CHUNK - 1)  # closest chunk cell to origin
    nearest_y = min(max(0, by), by + CHUNK - 1)
    r2 = _SPAWN_RADIUS * _SPAWN_RADIUS
    if nearest_x * nearest_x + nearest_y * nearest_y > r2:
        return
    for row in range(CHUNK):
        wy2 = (by + row) ** 2
        for col in range(CHUNK):
            if (bx + col) ** 2 + wy2 <= r2:
                grid[row][col] = True


def _spawn_mask(cx: int, cy: int) -> np.ndarray | None:
    """Boolean mask of this chunk's cells inside the spawn disk (None if no overlap)."""
    bx, by = cx * CHUNK, cy * CHUNK
    nearest_x = min(max(0, bx), bx + CHUNK - 1)
    nearest_y = min(max(0, by), by + CHUNK - 1)
    r2 = _SPAWN_RADIUS * _SPAWN_RADIUS
    if nearest_x * nearest_x + nearest_y * nearest_y > r2:
        return None
    ys, xs = np.mgrid[by : by + CHUNK, bx : bx + CHUNK]
    return xs * xs + ys * ys <= r2


def _chunk_array(seed: int, cx: int, cy: int, style: str) -> np.ndarray:
    """Chunk as a contiguous ``(CHUNK, CHUNK)`` bool array (``True`` = floor)."""
    if style == "dungeon":
        arr = np.ascontiguousarray(_dungeon_array(seed, cx, cy))
        mask = _spawn_mask(cx, cy)
        if mask is not None:
            arr |= mask
        return arr
    return np.array(generate_chunk(seed, cx, cy, style), dtype=bool)


def generate_chunk(
    seed: int, cx: int, cy: int, style: str = DEFAULT_STYLE
) -> list[list[bool]]:
    """Generate a chunk as ``grid[row][col]`` booleans (``True`` = floor).

    Pure function of ``(seed, cx, cy, style)``. See the module docstring.
    """
    # Dungeon is pure organic terrain: no stitching, erosion or tunnelling.
    if style == "dungeon":
        return _chunk_array(seed, cx, cy, style).tolist()

    # Aisles and caves promise full reachability: stitch, enforce, connect.
    grid = _aisle_grid(seed, cx, cy) if style == "aisles" else _cave_grid(seed, cx, cy)
    for r, c in _gateway_positions(seed, cx, cy):
        grid[r][c] = True
    _erode_unbordered_rocks(grid)  # every rock must border a corridor
    _connect_regions(grid)
    _carve_spawn_disk(grid, cx, cy)  # guarantee an open spawn area at the origin
    return grid


# --------------------------------------------------------------------------- #
# World access (cached)
# --------------------------------------------------------------------------- #
class Chunk:
    """One cached chunk: its floor bitmap and (lazily) the gem sites inside it."""

    __slots__ = ("floor", "gems")

    def __init__(self, floor: np.ndarray) -> None:
        self.floor = floor  # (CHUNK, CHUNK) bool, [row, col], True = floor
        self.gems: dict[tuple[int, int], int] | None = None  # world (x, y) -> value


class World:
    """A single infinite world for one seed with a thread-safe LRU chunk cache.

    Chunks are generated on demand (about 2 ms each) and kept until the cache
    exceeds :attr:`max_chunks`; re-entering an evicted area regenerates it
    identically. Gem sites are computed once per chunk, including a handful of
    rare "mega" gems placed far from the origin.
    """

    def __init__(self, seed_str: str, style: str = DEFAULT_STYLE) -> None:
        self.seed_str = seed_str
        self.style = style
        self.seed = seed_to_int(seed_str)
        self._chunks: OrderedDict[tuple[int, int], Chunk] = OrderedDict()
        self._lock = threading.Lock()
        self._mega: dict[tuple[int, int], int] | None = None
        self._mega_lock = threading.Lock()
        self.max_chunks = _CACHE_CHUNKS
        self.colors = colors_for_seed(self.seed)  # base palette (origin)

    def palette(self, distance: float) -> dict[str, str]:
        """Palette with the hue drifted by ``distance`` tiles from the origin."""
        return colors_for_seed(self.seed, distance)

    # -- terrain ----------------------------------------------------------- #
    def chunk(self, cx: int, cy: int) -> Chunk:
        key = (cx, cy)
        with self._lock:
            found = self._chunks.get(key)
            if found is not None:
                self._chunks.move_to_end(key)  # mark most-recently used
                return found
        fresh = Chunk(_chunk_array(self.seed, cx, cy, self.style))  # outside the lock
        with self._lock:
            found = self._chunks.get(key)
            if found is not None:  # another thread got there first
                return found
            self._chunks[key] = fresh
            while len(self._chunks) > self.max_chunks:
                self._chunks.popitem(last=False)  # evict least-recently used
            return fresh

    def is_floor(self, x: int, y: int) -> bool:
        """True if the world cell ``(x, y)`` is a walkable floor tile."""
        cx, cy = x // CHUNK, y // CHUNK
        return bool(self.chunk(cx, cy).floor[y - cy * CHUNK, x - cx * CHUNK])

    def floor_bits(self, cx: int, cy: int) -> bytes:
        """Chunk floor map packed 8 cells per byte (row-major), for the wire."""
        return np.packbits(self.chunk(cx, cy).floor.ravel()).tobytes()

    def region(self, x0: int, y0: int, cols: int, rows: int) -> np.ndarray:
        """``(rows, cols)`` uint8 array of 1 (floor) / 0 (rock) from ``(x0, y0)``."""
        out = np.zeros((rows, cols), dtype=np.uint8)
        for cy in range(y0 // CHUNK, (y0 + rows - 1) // CHUNK + 1):
            for cx in range(x0 // CHUNK, (x0 + cols - 1) // CHUNK + 1):
                gx0, gx1 = max(x0, cx * CHUNK), min(x0 + cols, (cx + 1) * CHUNK)
                gy0, gy1 = max(y0, cy * CHUNK), min(y0 + rows, (cy + 1) * CHUNK)
                out[gy0 - y0 : gy1 - y0, gx0 - x0 : gx1 - x0] = self.chunk(
                    cx, cy
                ).floor[
                    gy0 - cy * CHUNK : gy1 - cy * CHUNK,
                    gx0 - cx * CHUNK : gx1 - cx * CHUNK,
                ]
        return out

    def viewport(self, x0: int, y0: int, cols: int, rows: int) -> list[list[int]]:
        """Return a ``rows x cols`` grid of 1 (floor) / 0 (rock) from ``(x0, y0)``."""
        return self.region(x0, y0, cols, rows).tolist()

    # -- gems -------------------------------------------------------------- #
    def chunk_gems(self, cx: int, cy: int) -> dict[tuple[int, int], int]:
        """Gem sites in a chunk as ``{(x, y): value}``. Deterministic per seed.

        Ordinary gems form only on floor tiles that touch a wall, so they sit in
        the rock face. They grow exponentially rarer with distance from the origin
        (chance ``_GEM_MAX_P * e**(-d/fall)``) but richer (``base * (1 + d/150)``).
        Collection is tracked elsewhere; this reflects only the world's terrain.
        """
        chunk = self.chunk(cx, cy)
        if chunk.gems is None:
            chunk.gems = self._compute_gems(cx, cy)
        return chunk.gems

    def _compute_gems(self, cx: int, cy: int) -> dict[tuple[int, int], int]:
        c = CHUNK
        big = np.block(
            [
                [self.chunk(cx + dx, cy + dy).floor for dx in (-1, 0, 1)]
                for dy in (-1, 0, 1)
            ]
        )
        mid = big[c : 2 * c, c : 2 * c]
        all_around = (
            big[c - 1 : 2 * c - 1, c : 2 * c]
            & big[c + 1 : 2 * c + 1, c : 2 * c]
            & big[c : 2 * c, c - 1 : 2 * c - 1]
            & big[c : 2 * c, c + 1 : 2 * c + 1]
        )
        rows, cols = np.nonzero(mid & ~all_around)  # floor cells touching rock
        gems: dict[tuple[int, int], int] = {}
        if rows.size:
            xs, ys = cx * c + cols.astype(np.int64), cy * c + rows.astype(np.int64)
            dist = np.hypot(xs, ys)
            prob = _GEM_MAX_P * np.exp(-dist / _GEM_FALLOFF)
            keep = _rand01_arr(self.seed, xs.shape, 0x6E71, xs, ys) < prob
            xs, ys, dist = xs[keep], ys[keep], dist[keep]
            if xs.size:
                span = _GEM_VALUE_MAX - _GEM_VALUE_MIN + 1
                base = _GEM_VALUE_MIN + (
                    _rand01_arr(self.seed, xs.shape, 0x6E70, xs, ys) * span
                ).astype(np.int64)
                vals = np.rint(base * (1.0 + dist / _GEM_VALUE_DIST)).astype(np.int64)
                gems = {
                    (int(x), int(y)): int(v)
                    for x, y, v in zip(xs, ys, vals, strict=True)
                }
        for (x, y), value in self.mega_sites.items():
            if x // c == cx and y // c == cy:
                gems[(x, y)] = value
        return gems

    def gem_on_floor(self, x: int, y: int) -> int | None:
        """Gem value at world cell ``(x, y)``, or ``None``."""
        return self.chunk_gems(x // CHUNK, y // CHUNK).get((x, y))

    gem_at = gem_on_floor

    def gems_in(
        self, x0: int, y0: int, cols: int, rows: int
    ) -> list[tuple[int, int, int]]:
        """All gem sites ``(x, y, value)`` inside the given rectangle."""
        found: list[tuple[int, int, int]] = []
        for cy in range(y0 // CHUNK, (y0 + rows - 1) // CHUNK + 1):
            for cx in range(x0 // CHUNK, (x0 + cols - 1) // CHUNK + 1):
                for (x, y), v in self.chunk_gems(cx, cy).items():
                    if x0 <= x < x0 + cols and y0 <= y < y0 + rows:
                        found.append((x, y, v))
        return found

    # -- mega gems ----------------------------------------------------------- #
    @property
    def mega_sites(self) -> dict[tuple[int, int], int]:
        """The world's mega gem sites ``{(x, y): value}`` (computed once)."""
        with self._mega_lock:
            if self._mega is None:
                self._mega = self._compute_mega()
            return self._mega

    def is_mega(self, x: int, y: int) -> bool:
        return (x, y) in self.mega_sites

    def _wall_floor(self, x: int, y: int) -> bool:
        """True for a floor cell with at least one orthogonal rock neighbour."""
        return self.is_floor(x, y) and not (
            self.is_floor(x + 1, y)
            and self.is_floor(x - 1, y)
            and self.is_floor(x, y + 1)
            and self.is_floor(x, y - 1)
        )

    def _compute_mega(self) -> dict[tuple[int, int], int]:
        sites: dict[tuple[int, int], int] = {}
        for k in range(MEGA_COUNT):
            angle = _rand01(self.seed, 0x4E67, k, 0) * math.tau
            dist = MEGA_MIN_DIST + _rand01(self.seed, 0x4E67, k, 1) * (
                MEGA_MAX_DIST - MEGA_MIN_DIST
            )
            tx, ty = round(math.cos(angle) * dist), round(math.sin(angle) * dist)
            for r in range(_MEGA_SNAP_RADIUS + 1):  # nearest valid cell, ring by ring
                ring = (
                    [(0, 0)]
                    if r == 0
                    else [(dx, dy) for dx in range(-r, r + 1) for dy in (-r, r)]
                    + [(dx, dy) for dy in range(-r + 1, r) for dx in (-r, r)]
                )
                spot = next(
                    (
                        (tx + dx, ty + dy)
                        for dx, dy in ring
                        if self._wall_floor(tx + dx, ty + dy)
                    ),
                    None,
                )
                if spot is not None:
                    sites[spot] = MEGA_VALUE
                    break
        return sites


# --------------------------------------------------------------------------- #
# Colours (derived from the seed)
# --------------------------------------------------------------------------- #
def _hex(r: float, g: float, b: float) -> str:
    return f"#{round(r * 255):02x}{round(g * 255):02x}{round(b * 255):02x}"


def colors_for_seed(seed: int, distance: float = 0.0) -> dict[str, str]:
    """Derive a floor and a rock colour from the seed.

    Floor and rock get *independent* hues and saturations, so a world can pair
    (say) a sandy floor with blue-grey rock. Only the lightness is constrained:
    floor is always light and rock always dark, keeping the two readable apart.

    ``distance`` (tiles from the origin) drifts both hues very slowly, so the
    world gradually recolours the further the player travels from the centre.
    """
    drift = _HUE_RATE * distance
    floor_hue = (_rand01(seed, 0xC010) + drift) % 1.0
    rock_hue = (_rand01(seed, 0xC013) + drift) % 1.0
    floor_sat = 0.24 + 0.45 * _rand01(seed, 0xC011)
    rock_sat = 0.18 + 0.40 * _rand01(seed, 0xC014)
    floor = colorsys.hls_to_rgb(floor_hue, 0.82, floor_sat)  # always light
    rock = colorsys.hls_to_rgb(rock_hue, 0.22, rock_sat)  # always dark
    grid = colorsys.hls_to_rgb(floor_hue, 0.74, floor_sat)
    # Gem colour is fixed by the seed (no distance drift) and vivid, to contrast.
    gem = colorsys.hls_to_rgb(_rand01(seed, 0x6E72), 0.58, 0.95)
    return {
        "floor": _hex(*floor),
        "rock": _hex(*rock),
        "grid": _hex(*grid),
        "player": "#e53935",
        "gem": _hex(*gem),
    }
