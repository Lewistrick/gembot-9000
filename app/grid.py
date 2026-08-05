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
from collections import OrderedDict

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

_HUE_RATE: float = 0.0005
"""Hue turns (0..1) per tile of distance from the origin — a very slow colour drift."""

_GEM_MAX_P: float = 0.02
"""Gem chance per floor tile at the origin; decays with distance from it."""

_GEM_FALLOFF: float = 120.0
"""Distance (tiles) over which the gem chance falls off by a factor of e."""

_GEM_VALUE_MIN: int = 10
_GEM_VALUE_MAX: int = 40
"""Score value range of a gem (also drives how strongly it glows)."""

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
# Fractal value noise (Perlin-style)
# --------------------------------------------------------------------------- #
def _smoothstep(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def _lattice(seed: int, ix: int, iy: int) -> float:
    """Pseudo-random value in ``[0, 1)`` at integer lattice point ``(ix, iy)``."""
    return _rand01(seed, 0x1234, ix, iy)


def _value_noise(seed: int, x: float, y: float) -> float:
    """Bilinearly-interpolated, smoothstep-eased value noise at ``(x, y)``."""
    x0, y0 = int(x // 1), int(y // 1)
    fx, fy = _smoothstep(x - x0), _smoothstep(y - y0)
    v00 = _lattice(seed, x0, y0)
    v10 = _lattice(seed, x0 + 1, y0)
    v01 = _lattice(seed, x0, y0 + 1)
    v11 = _lattice(seed, x0 + 1, y0 + 1)
    top = v00 + (v10 - v00) * fx
    bot = v01 + (v11 - v01) * fx
    return top + (bot - top) * fy


def _fractal(seed: int, x: float, y: float, octaves: int = 3) -> float:
    """Sum several octaves of value noise into a fractal field in ``[0, 1]``."""
    total = 0.0
    amp = 1.0
    freq = 1.0
    norm = 0.0
    for o in range(octaves):
        total += amp * _value_noise(seed ^ (o * 0x9E37), x * freq, y * freq)
        norm += amp
        amp *= 0.5
        freq *= 2.0
    return total / norm


# --------------------------------------------------------------------------- #
# Chunk generation
# --------------------------------------------------------------------------- #
def _initial_field(
    seed: int, cx: int, cy: int, pad: int, scale: float, thresh: float
) -> list[list[bool]]:
    """Noise-thresholded floor/rock field over the chunk plus an apron.

    ``scale`` is the noise frequency and ``thresh`` the floor cutoff (higher =>
    less floor => denser rock cover). Returns a ``(CHUNK + 2*pad)`` square grid of
    booleans (``True`` = floor). The apron extends into neighbouring chunks using
    the same global noise field so the cellular automata is seamless across
    borders.
    """
    size = CHUNK + 2 * pad
    base_x = cx * CHUNK - pad
    base_y = cy * CHUNK - pad
    field: list[list[bool]] = []
    for row in range(size):
        wy = (base_y + row) * scale
        line: list[bool] = []
        for col in range(size):
            wx = (base_x + col) * scale
            line.append(_fractal(seed, wx, wy) > thresh)
        field.append(line)
    return field


def _cellular_pass(field: list[list[bool]]) -> list[list[bool]]:
    """One cave-smoothing CA step: a cell is floor iff it has >=5 floor neighbours.

    Counts the 3x3 neighbourhood (including the cell itself). Border cells of the
    padded field keep their value (the apron absorbs edge effects).
    """
    size = len(field)
    out = [row[:] for row in field]
    for r in range(1, size - 1):
        for c in range(1, size - 1):
            floors = 0
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if field[r + dr][c + dc]:
                        floors += 1
            out[r][c] = floors >= 5
    return out


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


def _ca_grid(
    seed: int, cx: int, cy: int, scale: float, thresh: float, iters: int
) -> list[list[bool]]:
    """Fractal-noise field smoothed by ``iters`` cellular-automata passes.

    Computed over the chunk plus an ``iters``-wide apron so caves flow seamlessly
    across chunk borders, then cropped to the ``CHUNK`` x ``CHUNK`` interior.
    """
    pad = iters
    field = _initial_field(seed, cx, cy, pad, scale, thresh)
    for _ in range(iters):
        field = _cellular_pass(field)
    return [row[pad : pad + CHUNK] for row in field[pad : pad + CHUNK]]


def _cave_grid(seed: int, cx: int, cy: int) -> list[list[bool]]:
    """Sparse organic style: open caverns with thin winding rock outlines."""
    return _ca_grid(seed, cx, cy, scale=0.34, thresh=0.50, iters=_CA_ITERS)


def _dungeon_grid(seed: int, cx: int, cy: int) -> list[list[bool]]:
    """Dense organic style: irregular rock masses and floor chambers.

    Pure fractal-noise + cellular-automata terrain — no gateways, no erosion and
    no tunnelling. Rock blocks stay thick and organic (rocks need not border a
    corridor), and chambers are connected only where the terrain itself connects
    them (most of the floor, but some chambers are sealed off).
    """
    return _ca_grid(seed, cx, cy, scale=0.16, thresh=0.50, iters=5)


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


def generate_chunk(
    seed: int, cx: int, cy: int, style: str = DEFAULT_STYLE
) -> list[list[bool]]:
    """Generate a chunk as ``grid[row][col]`` booleans (``True`` = floor).

    Pure function of ``(seed, cx, cy, style)``. See the module docstring.
    """
    # Dungeon is pure organic terrain: no stitching, erosion or tunnelling.
    if style == "dungeon":
        grid = _dungeon_grid(seed, cx, cy)
    else:
        # Aisles and caves promise full reachability: stitch, enforce, connect.
        grid = (
            _aisle_grid(seed, cx, cy) if style == "aisles" else _cave_grid(seed, cx, cy)
        )
        for r, c in _gateway_positions(seed, cx, cy):
            grid[r][c] = True
        _erode_unbordered_rocks(grid)  # every rock must border a corridor
        _connect_regions(grid)

    _carve_spawn_disk(grid, cx, cy)  # guarantee an open spawn area at the origin
    return grid


# --------------------------------------------------------------------------- #
# World access (cached)
# --------------------------------------------------------------------------- #
class World:
    """A single infinite world for one seed with an LRU cache of chunks.

    Only chunks touched recently (i.e. on or near the screen) are kept; the cache
    is bounded by :attr:`max_chunks`, so off-screen chunks are evicted and their
    memory reclaimed. Re-entering an evicted area simply regenerates it.
    """

    def __init__(self, seed_str: str, style: str = DEFAULT_STYLE) -> None:
        self.seed_str = seed_str
        self.style = style
        self.seed = seed_to_int(seed_str)
        self._chunks: OrderedDict[tuple[int, int], list[list[bool]]] = OrderedDict()
        self.max_chunks = 64
        self.colors = colors_for_seed(self.seed)  # base palette (origin)

    def palette(self, distance: float) -> dict[str, str]:
        """Palette with the hue drifted by ``distance`` tiles from the origin."""
        return colors_for_seed(self.seed, distance)

    def _chunk(self, cx: int, cy: int) -> list[list[bool]]:
        key = (cx, cy)
        chunk = self._chunks.get(key)
        if chunk is not None:
            self._chunks.move_to_end(key)  # mark most-recently used
            return chunk
        chunk = generate_chunk(self.seed, cx, cy, self.style)
        self._chunks[key] = chunk
        while len(self._chunks) > self.max_chunks:
            self._chunks.popitem(last=False)  # evict least-recently used
        return chunk

    def is_floor(self, x: int, y: int) -> bool:
        """True if the world cell ``(x, y)`` is a walkable floor tile."""
        cx, cy = x // CHUNK, y // CHUNK
        return self._chunk(cx, cy)[y - cy * CHUNK][x - cx * CHUNK]

    def viewport(self, x0: int, y0: int, cols: int, rows: int) -> list[list[int]]:
        """Return a ``rows x cols`` grid of 1 (floor) / 0 (rock) from ``(x0, y0)``."""
        return [
            [1 if self.is_floor(x0 + c, y0 + r) else 0 for c in range(cols)]
            for r in range(rows)
        ]

    def gem_on_floor(self, x: int, y: int) -> int | None:
        """Gem value at a known-floor cell, or ``None``. Deterministic per seed.

        Gems grow exponentially rarer with distance from the origin, so a floor
        tile passes the roll with probability ``_GEM_MAX_P * e**(-d/fall)``. They
        only form on floor tiles that touch a wall (an orthogonal rock neighbour),
        so gems sit embedded in the rock face rather than out in the open.
        Collection is tracked elsewhere; this reflects only the world's terrain.
        """
        prob = _GEM_MAX_P * math.exp(-math.hypot(x, y) / _GEM_FALLOFF)
        if _rand01(self.seed, 0x6E71, x, y) >= prob:
            return None
        touches_wall = not (
            self.is_floor(x + 1, y)
            and self.is_floor(x - 1, y)
            and self.is_floor(x, y + 1)
            and self.is_floor(x, y - 1)
        )
        if not touches_wall:
            return None
        span = _GEM_VALUE_MAX - _GEM_VALUE_MIN + 1
        return _GEM_VALUE_MIN + int(_rand01(self.seed, 0x6E70, x, y) * span)

    def gem_at(self, x: int, y: int) -> int | None:
        """Gem value at a world cell (floor tiles only), or ``None``."""
        return self.gem_on_floor(x, y) if self.is_floor(x, y) else None


# --------------------------------------------------------------------------- #
# Colours (derived from the seed)
# --------------------------------------------------------------------------- #
def _hex(r: float, g: float, b: float) -> str:
    return f"#{round(r * 255):02x}{round(g * 255):02x}{round(b * 255):02x}"


def colors_for_seed(seed: int, distance: float = 0.0) -> dict[str, str]:
    """Derive a floor (light tint) and rock (dark tint) colour from the seed.

    ``distance`` (tiles from the origin) drifts the hue very slowly, so the world
    gradually changes colour the further the player travels from the centre.
    """
    hue = (_rand01(seed, 0xC010) + _HUE_RATE * distance) % 1.0
    sat = 0.30 + 0.35 * _rand01(seed, 0xC011)
    floor = colorsys.hls_to_rgb(hue, 0.82, sat)
    rock = colorsys.hls_to_rgb(hue, 0.22, sat * 0.9)
    grid = colorsys.hls_to_rgb(hue, 0.74, sat)
    # Gem colour is fixed by the seed (no distance drift) and vivid, to contrast.
    gem = colorsys.hls_to_rgb(_rand01(seed, 0x6E72), 0.58, 0.95)
    return {
        "floor": _hex(*floor),
        "rock": _hex(*rock),
        "grid": _hex(*grid),
        "player": "#e53935",
        "gem": _hex(*gem),
    }
