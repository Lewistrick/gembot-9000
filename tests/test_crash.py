"""Crashing into a wall shakes gems out of the cargo: nothing below 20% of top speed,
up to 10 at top speed, in proportion in between."""

import math

from app.grid import World
from app.player import CRASH_FREE, CRASH_MAX_LOSS, MAX_SPEED, Player

EAST = math.pi / 2  # heading 0 is up; forward = (sin h, -cos h)


class Wall(World):
    """Open floor for x < 3, rock from x = 3 on."""

    def __init__(self) -> None:
        super().__init__("t")

    def is_floor(self, x: int, y: int) -> bool:
        return x < 3


def crash(
    speed: float, cargo: int = 50, heading: float = EAST, throttle: bool = False
) -> Player:
    p = Player("p", 1, "P")
    p.place(2, 0)
    p.heading, p.speed, p.cargo = heading, speed, cargo
    p.set_controls(throttle, False, False, False)
    world = Wall()
    for _ in range(3):  # long enough to reach the wall (half a tile away)
        p.step(world)
    return p


def lost(p: Player) -> int:
    return sum(n["v"] for n in p.notices if n["t"] == "crash")


def test_top_speed_head_on_loses_the_most() -> None:
    p = crash(MAX_SPEED)
    assert lost(p) == CRASH_MAX_LOSS == 10 and p.cargo == 40


def test_slow_bumps_are_free() -> None:
    p = crash(CRASH_FREE * MAX_SPEED * 0.95)
    assert lost(p) == 0 and p.cargo == 50 and not p.notices


def test_the_loss_grows_with_speed() -> None:
    losses = [lost(crash(v)) for v in (4.0, 7.0, 10.0, 13.0)]
    assert losses == sorted(losses) and 0 < losses[0] < losses[-1] < CRASH_MAX_LOSS
    assert lost(crash(9.0)) == 5  # halfway between 3 and 15 tiles/s


def test_you_cannot_lose_more_than_you_carry() -> None:
    p = crash(MAX_SPEED, cargo=3)
    assert lost(p) == 3 and p.cargo == 0
    empty = crash(MAX_SPEED, cargo=0)
    assert not empty.notices and empty.cargo == 0


def test_a_glancing_scrape_costs_little() -> None:
    shallow = EAST - math.radians(75)  # mostly along the wall (up), a little into it
    assert lost(crash(MAX_SPEED, heading=shallow)) <= 2


def test_ramming_a_wall_to_drill_still_costs_the_crash_once() -> None:
    p = Player("p", 1, "P")
    p.place(2, 0)
    p.heading, p.speed, p.cargo = EAST, MAX_SPEED, 50
    p.set_controls(
        True, False, False, False
    )  # throttle held: the drill takes over after the hit
    world = Wall()
    for _ in range(40):
        p.step(world)
    assert (
        lost(p) == CRASH_MAX_LOSS
    )  # the hit, once; pushing the drill afterwards is free
    assert p.drill_progress > 0 or p.drilled_tile is not None


class Tunnel(World):
    """Rock from x = 3 on, except the tiles drilled so far."""

    def __init__(self) -> None:
        super().__init__("t")
        self.open: set[tuple[int, int]] = set()

    def is_floor(self, x: int, y: int) -> bool:
        return x < 3 or (x, y) in self.open


def test_tunnelling_on_through_a_wall_is_not_a_crash() -> None:
    p = Player("p", 1, "P")
    p.place(2.45, 0)  # already touching the rock
    p.heading, p.cargo = EAST, 50
    p.set_controls(True, False, False, False)
    world = Tunnel()
    for _ in range(400):  # ~20 s of holding forward: tile after tile bored out
        p.step(world)
        if p.drilled_tile is not None:
            world.open.add(p.drilled_tile)
            p.drilled_tile = None
    assert len(world.open) >= 4 and lost(p) == 0


def test_bouncing_back_into_the_wall_right_away_is_the_same_crash() -> None:
    p = crash(
        MAX_SPEED, throttle=True
    )  # the drill takes the hit; then it rolls on into the rock
    world = Wall()
    for _ in range(30):
        p.step(world)
    assert lost(p) == CRASH_MAX_LOSS


def test_a_new_crash_after_backing_off_counts_again() -> None:
    p = crash(MAX_SPEED)
    world = Wall()
    p.place(-8, 0)  # well away from the wall, then ram it again at full throttle
    p.heading, p.speed = EAST, MAX_SPEED
    p.set_controls(True, False, False, False)
    for _ in range(30):
        p.step(world)
    assert lost(p) == 2 * CRASH_MAX_LOSS
