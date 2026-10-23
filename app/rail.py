"""The shared rail network: hubs, straight tracks, routes and tolls.

Pure logic with no knowledge of players or sockets (``game.py`` wires it in).

* The base is built-in hub ``0`` at the origin and can never have an outgoing track.
* Every other hub has at most one **outgoing** track (``out``) and any number of
  incoming ones, and loops are refused, so the hubs form a forest. Each tree is
  rooted at a hub with no outgoing track; the one rooted at the base is "linked
  to base", and has exactly one route home from every hub.
* A track is a straight line (diagonals allowed) whose every tile must be floor.
  A hub costs ``HUB_COST`` and a track one point per tile of length (rounded).
* A hub is never built on its own: it is always placed together with the track
  that leads from it to an existing hub (see :meth:`Network.hub_options`).
"""

import math
from dataclasses import dataclass

from .grid import BASE_RADIUS, FloorMap

HUB_COST = 25
MAX_TRACK = 60  # longest single track, in tiles
MIN_SPACING = 3  # hubs must be at least this far apart (tiles)
BASE_GAP = 2  # new hubs must sit this far outside the base disk
BASE_TAP = 2.0  # tapping this close to the origin means "the base"
MAX_HUBS = 500
OPTION_LIMIT = 3  # target hubs proposed when placing a hub
OPTION_SEARCH = 24  # nearest hubs examined while looking for those
RIDE_SPEED = 30.0  # tiles/second for a robot riding the rails
CART_SPEED = 12.0  # tiles/second for a lone cargo cart


@dataclass
class Hub:
    id: int
    x: int
    y: int
    builder: str | None  # pid of the player who built it (None for the base)
    out: int | None = None  # hub this one's track leads to (toward the base)


@dataclass
class Quote:
    """What a build would do and cost (also the result once it is applied)."""

    ok: bool
    why: str = ""
    cost: int = 0
    kind: str = ""  # "track" (track + new hub) or "link"
    src: int | None = None  # hub the track starts at
    dst: int | None = None  # existing hub it ends at (link), else None
    x: int = 0  # target cell
    y: int = 0
    out_hub: int | None = None  # which hub gains an outgoing track...
    out_to: int | None = None  # ...pointing at this hub
    length: float = 0.0


def line_cells(x1: int, y1: int, x2: int, y2: int) -> list[tuple[int, int]]:
    """Bresenham line from ``(x1, y1)`` to ``(x2, y2)``, both ends included."""
    dx, dy = abs(x2 - x1), -abs(y2 - y1)
    sx, sy = (1 if x1 < x2 else -1), (1 if y1 < y2 else -1)
    err = dx + dy
    x, y = x1, y1
    cells = []
    while True:
        cells.append((x, y))
        if x == x2 and y == y2:
            return cells
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x += sx
        if e2 <= dx:
            err += dx
            y += sy


def track_cost(length: float) -> int:
    """One point per tile of length, rounded to whole tiles (at least 1)."""
    return max(1, int(length + 0.5))


def advance(
    x: float, y: float, pts: list[tuple[float, float]], i: int, dist: float
) -> tuple[float, float, int]:
    """Move ``dist`` along a polyline from ``(x, y)`` heading for ``pts[i]``."""
    while dist > 1e-9 and i < len(pts):
        tx, ty = pts[i]
        d = math.hypot(tx - x, ty - y)
        if d <= dist:
            x, y, dist, i = tx, ty, dist - d, i + 1
        else:
            x += (tx - x) / d * dist
            y += (ty - y) / d * dist
            dist = 0.0
    return x, y, i


class Network:
    """All hubs and tracks for one day."""

    def __init__(self) -> None:
        self.hubs: dict[int, Hub] = {0: Hub(0, 0, 0, None, None)}
        self.next_id = 1
        self.log: list[int] = []  # ids of hubs created or re-linked, append-only

    # -- lookup ----------------------------------------------------------- #
    def at(self, x: int, y: int) -> Hub | None:
        """The hub on cell ``(x, y)``; the base answers to anywhere near the origin."""
        if math.hypot(x, y) <= BASE_TAP:
            return self.hubs[0]
        for h in self.hubs.values():
            if h.x == x and h.y == y:
                return h
        return None

    def has_hub_within(self, x: float, y: float, reach: float) -> bool:
        """Is any hub (the base included) within ``reach`` tiles of ``(x, y)``?"""
        limit = reach * reach
        return any((h.x - x) ** 2 + (h.y - y) ** 2 <= limit for h in self.hubs.values())

    def nearest(self, x: float, y: float, reach: float = 0.9) -> Hub | None:
        """The hub a robot at ``(x, y)`` is standing on (base: its whole depot)."""
        best, best_d = None, reach
        for h in self.hubs.values():
            d = math.hypot(h.x - x, h.y - y)
            if h.id == 0:
                d = max(0.0, d - (BASE_TAP - reach))  # the depot is bigger than a hub
            if d <= best_d:
                best, best_d = h, d
        return best

    def chain(self, hid: int) -> list[int]:
        """``hid`` followed by each hub its tracks lead to, ending at a root."""
        out, seen = [hid], {hid}
        while (nxt := self.hubs[out[-1]].out) is not None and nxt not in seen:
            out.append(nxt)
            seen.add(nxt)
        return out

    def root(self, hid: int) -> int:
        return self.chain(hid)[-1]

    def route(self, a: int, b: int) -> list[int] | None:
        """Hub ids from ``a`` to ``b`` along tracks (either direction), or None."""
        ca, cb = self.chain(a), self.chain(b)
        if ca[-1] != cb[-1]:
            return None
        on_b = set(cb)
        i = next(i for i, h in enumerate(ca) if h in on_b)
        return ca[: i + 1] + list(reversed(cb[: cb.index(ca[i])]))

    def neighbours(self, hid: int) -> list[int]:
        """Hubs joined to ``hid`` by a single track (the one it leads to, and the
        ones that lead into it), nearest first."""
        hub = self.hubs[hid]
        near = [h.id for h in self.hubs.values() if h.out == hid]
        if hub.out is not None:
            near.append(hub.out)
        return sorted(
            near,
            key=lambda h: math.hypot(self.hubs[h].x - hub.x, self.hubs[h].y - hub.y),
        )

    def component(self, hid: int) -> list[int]:
        r = self.root(hid)
        return sorted(h for h in self.hubs if self.root(h) == r)

    def points(self, route: list[int]) -> list[tuple[float, float]]:
        return [(float(self.hubs[h].x), float(self.hubs[h].y)) for h in route]

    def toll_builders(self, route: list[int], payer: str) -> list[str]:
        """One entry per hub on the route built by someone other than ``payer``."""
        return [
            b for h in route if (b := self.hubs[h].builder) is not None and b != payer
        ]

    # -- placement rules ---------------------------------------------------- #
    def _hub_site_problem(self, world: FloorMap, x: int, y: int) -> str:
        if len(self.hubs) > MAX_HUBS:
            return "The mine is full of hubs."
        if not world.is_floor(x, y):
            return "A hub needs a floor tile."
        if math.hypot(x, y) < BASE_RADIUS + BASE_GAP:
            return "Too close to the base."
        for h in self.hubs.values():
            if h.id != 0 and math.hypot(h.x - x, h.y - y) < MIN_SPACING:
                return "Too close to another hub."
        return ""

    def hub_options(
        self, world: FloorMap, x: int, y: int, funds: int
    ) -> tuple[list[Quote], str]:
        """Where a new hub on cell ``(x, y)`` could lead, nearest first.

        Returns up to ``OPTION_LIMIT`` OK quotes (``quote.src`` is the existing hub
        the new hub's track would lead to), or no quotes and the reason why.
        """
        why = self._hub_site_problem(world, x, y)
        if why:
            return [], why
        near = sorted(
            (
                h
                for h in self.hubs.values()
                if math.hypot(h.x - x, h.y - y) <= MAX_TRACK
            ),
            key=lambda h: math.hypot(h.x - x, h.y - y),
        )[:OPTION_SEARCH]
        if not near:
            return [], f"No hub within {MAX_TRACK} tiles to lead to."
        quotes = [self.quote_track(world, h.id, x, y, funds) for h in near]
        ok = [q for q in quotes if q.ok][:OPTION_LIMIT]
        if ok:
            return ok, ""
        poor = [q for q in quotes if q.why.startswith("Needs")]
        if poor:  # the track is clear but too dear: say what the cheapest costs
            return [], min(poor, key=lambda q: q.cost).why
        return [], "Rock blocks the way to every hub in reach."

    def quote_track(
        self, world: FloorMap, src: int, tx: int, ty: int, funds: int
    ) -> Quote:
        """A straight track from hub ``src`` to the target cell.

        An empty target gets a new hub whose outgoing track leads back to ``src``.
        An existing hub is linked instead: its outgoing track goes to whichever of
        the two has none yet, and a link that would close a loop is refused.
        """
        a = self.hubs[src]
        other = self.at(tx, ty)
        if other is not None:
            tx, ty = other.x, other.y
        q = Quote(
            False,
            "",
            0,
            "link" if other else "track",
            src,
            other.id if other else None,
            tx,
            ty,
        )
        if other is not None and other.id == src:
            q.why = "You are already on that hub."
            return q
        q.length = math.hypot(tx - a.x, ty - a.y)
        if q.length > MAX_TRACK:
            q.why = f"Too far: tracks are at most {MAX_TRACK} tiles."
            return q
        if q.length < 1:
            q.why = "Too short."
            return q
        if other is None:
            q.why = self._hub_site_problem(world, tx, ty)
            if q.why:
                return q
            q.out_hub, q.out_to = None, src  # decided on apply: the new hub -> src
        else:
            if a.out is None and a.id != 0 and other.id not in self._subtree_ids(a.id):
                q.out_hub, q.out_to = a.id, other.id
            elif (
                other.out is None
                and other.id != 0
                and a.id not in self._subtree_ids(other.id)
            ):
                q.out_hub, q.out_to = other.id, a.id
            elif self.root(a.id) == self.root(other.id):
                q.why = "Those hubs are already connected (no loops)."
                return q
            else:
                q.why = "Both hubs already lead somewhere else."
                return q
        if any(not world.is_floor(cx, cy) for cx, cy in line_cells(a.x, a.y, tx, ty)):
            q.why = "Rock in the way: a track needs floor all along."
            return q
        q.cost = track_cost(q.length) + (HUB_COST if other is None else 0)
        if funds < q.cost:
            q.why = f"Needs {q.cost} points (you have {funds})."
            return q
        q.ok = True
        return q

    def _subtree_ids(self, hid: int) -> set[int]:
        """``hid`` and every hub whose tracks eventually lead into it."""
        return {h for h in self.hubs if hid in self.chain(h)}

    # -- changes ------------------------------------------------------------- #
    def apply(self, q: Quote, builder: str) -> Hub | None:
        """Carry out an OK quote. Returns the hub that was created, if any."""
        if not q.ok:
            raise ValueError("cannot apply a refused quote")
        created = None
        if q.kind == "track":
            created = Hub(self.next_id, q.x, q.y, builder, None)
            self.hubs[created.id] = created
            self.next_id += 1
            self.log.append(created.id)
            created.out = q.src
        else:
            assert q.out_hub is not None and q.out_to is not None
            self.hubs[q.out_hub].out = q.out_to
            self.log.append(q.out_hub)
        return created

    def restore(self, rows: list[tuple]) -> None:
        """Load saved hubs ``(id, x, y, builder, out)``."""
        for hid, x, y, builder, out in rows:
            self.hubs[hid] = Hub(hid, x, y, builder, out)
            self.next_id = max(self.next_id, hid + 1)
            self.log.append(hid)
