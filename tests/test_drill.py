"""Drilling: hold forward into a wall to bore it out (1 cargo and 1 s, or free but
3 s when you carry nothing). Drilled tiles are shared, persistent floor."""

import math
import random

import pytest

from app.connection import Connection
from app.game import Game
from app.grid import World
from app.player import DRILL_TIME, DRILL_TIME_BROKE, TICK, Player
from app.store import Store

EAST = math.pi / 2  # heading 0 is up; forward = (sin h, -cos h)


class WallWorld(World):
    """Open floor for x < 20, solid rock from x = 20 on, and no gems."""

    def is_floor(self, x: int, y: int) -> bool:
        return x < 20

    def gem_on_floor(self, x: int, y: int) -> int | None:
        return None


def make(cargo: int = 5, x: float = 19.0) -> tuple[Game, Player]:
    game = Game("2026-10-22", rng=random.Random(1))
    game.world = WallWorld("t")
    p = game.join("a", "Ann")
    assert p is not None
    p.place(x, 0)
    p.heading = EAST
    p.cargo = cargo
    game.control("a", True, False, False, False)  # hold forward
    return game, p


def ticks_until_drilled(game: Game, limit: int = 200) -> int:
    for n in range(1, limit + 1):
        game.tick()
        if game.drilled:
            return n
    raise AssertionError("never drilled through")


def test_holding_forward_drills_one_tile_for_one_cargo() -> None:
    game, p = make(cargo=5)
    n = ticks_until_drilled(game)
    assert game.drilled == {(20, 0)} and game.drilled_log == [(20, 0)]
    assert p.cargo == 4
    assert DRILL_TIME / TICK <= n <= DRILL_TIME / TICK + 15  # ~1 s plus the approach
    assert game.is_floor(20, 0) and not game.world.is_floor(20, 0)


def test_with_no_cargo_drilling_is_free_but_slow() -> None:
    game, p = make(cargo=0)
    n = ticks_until_drilled(game)
    assert p.cargo == 0 and p.score == 0  # nothing was charged, and nothing was needed
    assert n >= DRILL_TIME_BROKE / TICK
    assert n <= DRILL_TIME_BROKE / TICK + 15


def test_the_drill_takes_a_head_on_hit_without_bouncing() -> None:
    game, p = make(x=10.0)
    p.speed = 15.0
    for _ in range(25):
        game.tick()
        assert p.kx == 0.0 and p.bump == 0.0  # no knockback, no red flash
    assert 19.3 <= p.x <= 19.5 and p.speed == 0.0
    assert p.drill_target == (20, 0) and p.drill_progress > 0


def test_a_hit_without_the_throttle_still_bounces() -> None:
    game, p = make(x=19.4)
    game.control("a", False, False, False, False)  # let go of forward
    p.speed = 10.0
    p.step(game)
    assert p.bump > 0 and p.kx < 0 and not p.drill_target


def test_scraping_along_a_wall_does_not_drill() -> None:
    game, p = make(x=19.4)
    p.heading = EAST - 1.2  # mostly north, a little east: a glancing contact
    for _ in range(120):
        game.tick()
    assert not game.drilled and p.drill_progress == 0.0


def test_letting_go_resets_the_progress() -> None:
    game, p = make(cargo=5)
    for _ in range(15):  # ~0.75 s of drilling: almost through
        game.tick()
    assert 0 < p.drill_progress < 1 and not game.drilled
    game.control("a", False, False, False, False)
    for _ in range(8):  # longer than the grace period
        game.tick()
    assert p.drill_progress == 0.0 and p.drill_target is None
    game.control("a", True, False, False, False)
    for _ in range(15):  # another 0.75 s would finish it if progress had been kept
        game.tick()
    assert not game.drilled


def test_the_base_cannot_be_drilled() -> None:
    game, p = make()
    p.drilled_tile = (5, 5)
    game._drill(p)
    assert not game.drilled and p.cargo == 5 and p.drilled_tile is None


def test_a_tile_someone_else_just_drilled_costs_nothing() -> None:
    game, p = make(cargo=5)
    game.drilled.add((20, 0))
    p.drilled_tile = (20, 0)
    game._drill(p)
    assert p.cargo == 5 and len(game.drilled_log) == 0


def test_drilled_tiles_are_floor_for_everyone_and_for_the_rail() -> None:
    game, _ = make()
    ticks_until_drilled(game)
    assert not game.rail.quote_hub(
        game.world, 20, 0, 100
    ).ok  # the raw world is still rock
    assert game.rail.quote_hub(game, 20, 0, 100).ok  # but the game sees floor
    other = game.join("b", "Bob")
    assert other is not None
    other.place(18.0, 0)
    other.heading = EAST
    game.control("b", True, False, False, False)
    for _ in range(40):
        game.tick()
    assert other.x > 20.2  # drove through the tunnel that Ann made


def test_drilling_survives_a_restart(tmp_path) -> None:
    game, _ = make()
    ticks_until_drilled(game)
    store = Store(str(tmp_path / "d.db"))
    store.flush(game)
    assert store.snapshot(game)["drilled"] == []  # saved once, not again
    store.close()
    again = Store(str(tmp_path / "d.db"))
    game2 = Game("2026-10-22")
    again.load_into(game2)
    assert game2.drilled == {(20, 0)} and game2.drilled_log == [(20, 0)]
    again.close()


def test_other_days_do_not_see_the_tunnel(tmp_path) -> None:
    game, _ = make()
    ticks_until_drilled(game)
    store = Store(str(tmp_path / "d.db"))
    store.flush(game)
    tomorrow = Game("2026-10-23")
    store.load_into(tomorrow)
    assert not tomorrow.drilled
    store.close()


# -- what clients are sent ------------------------------------------------------ #
def of(frame: list[dict], kind: str) -> list[dict]:
    return [m for m in frame if m["t"] == kind]


def test_drilling_reaches_clients_in_chunks_deltas_and_ticks() -> None:
    game = Game("2026-10-22", rng=random.Random(2))
    a, b = game.join("a", "Ann"), game.join("b", "Bob")
    assert a and b
    a.place(0, 0)
    b.place(3, 3)
    ca, cb = Connection(game, a), Connection(game, b)
    ca.frame([100])
    cb.frame([100])
    game.drilled.add((20, 5))
    game.drilled_log.append((20, 5))
    assert of(ca.frame([0])[0], "drilled") == [{"t": "drilled", "c": [[20, 5]]}]
    assert of(cb.frame([0])[0], "drilled") == [{"t": "drilled", "c": [[20, 5]]}]
    assert not of(ca.frame([0])[0], "drilled")  # once only
    late = Connection(game, a)  # a client that joins later gets it with the chunk
    chunk = next(
        c for c in of(late.frame([100])[0], "chunk") if (c["cx"], c["cy"]) == (0, 0)
    )
    assert [20, 5] in chunk["drilled"]
    assert "d" not in ca.frame([0])[1]
    a.drill_progress, a.drill_gap = 0.4, 0
    assert ca.frame([0])[1]["d"] == 0.4


def test_other_robots_show_a_drilling_flag() -> None:
    game = Game("2026-10-22", rng=random.Random(2))
    a = game.join("a", "Ann")
    assert a is not None
    a.drill_progress, a.drill_gap = 0.5, 0
    assert game.row(a)[4] & 2
    game.tick_count += 1
    a.drill_gap = 5
    assert not game.row(a)[4] & 2


# -- the reason this exists: a sealed base ------------------------------------------ #
def _pocket_escape_cost(day: str, radius: int = 150) -> tuple[int, int, int]:
    """(tiles to drill, size of the base pocket, size of the open cave) for a day.

    Labels every floor region in a window around the base, takes the biggest
    region that is not the base's own as "the open cave", then runs a 0-1 BFS
    from the base pocket where floor is free and each rock tile costs one drill.
    """
    from collections import deque

    world = World(day)
    world.max_chunks = 10_000
    n = 2 * radius + 1
    floor = world.region(-radius, -radius, n, n).astype(bool).tolist()
    label = [[-1] * n for _ in range(n)]
    sizes: list[int] = []
    for sy in range(n):
        for sx in range(n):
            if not floor[sy][sx] or label[sy][sx] >= 0:
                continue
            ident, size = len(sizes), 0
            label[sy][sx] = ident
            todo = deque([(sy, sx)])
            while todo:
                y, x = todo.popleft()
                size += 1
                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if (
                        0 <= ny < n
                        and 0 <= nx < n
                        and floor[ny][nx]
                        and label[ny][nx] < 0
                    ):
                        label[ny][nx] = ident
                        todo.append((ny, nx))
            sizes.append(size)
    home = label[radius][radius]
    open_id = max((i for i in range(len(sizes)) if i != home), key=sizes.__getitem__)
    dist = {(y, x): 0 for y in range(n) for x in range(n) if label[y][x] == home}
    todo = deque(dist)
    while todo:
        y, x = todo.popleft()
        if label[y][x] == open_id:
            return dist[(y, x)], sizes[home], sizes[open_id]
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < n and 0 <= nx < n:
                step = 0 if floor[ny][nx] else 1
                if dist[(y, x)] + step < dist.get((ny, nx), 10**9):
                    dist[(ny, nx)] = dist[(y, x)] + step
                    (todo.appendleft if step == 0 else todo.append)((ny, nx))
    return -1, sizes[home], sizes[open_id]


@pytest.mark.parametrize("day", ["2026-10-23", "2026-10-24", "2026-10-28"])
def test_a_sealed_base_is_only_a_few_drilled_tiles_from_the_open_cave(day: str) -> None:
    """These days start in a closed pocket; a handful of drilled tiles break out."""
    cost, pocket, cave = _pocket_escape_cost(day)
    assert 1 <= cost <= 8, (cost, pocket, cave)
    assert cave >= 5_000  # and what lies beyond is a real cave, not another pocket
