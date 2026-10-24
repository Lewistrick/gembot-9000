"""Robot physics: steering builds up and eases back instead of switching on and off."""

import math

from app.grid import World
from app.player import MAX_SPEED, STEER_FAST, STEER_SLOW, TICK, Player, turn_rate


class Open(World):
    def is_floor(self, x: int, y: int) -> bool:
        return True


def robot() -> tuple[Player, World]:
    p = Player("p", 1, "P")
    p.place(0, 0)
    p.speed = 8.0
    return p, Open("t")


def test_the_turn_rate_builds_up_gradually() -> None:
    p, world = robot()
    p.set_controls(False, False, False, True)
    p.step(world)
    first = p.spin
    assert 0 < first < turn_rate(8.0) * 0.5  # not instantly at full rate
    for _ in range(40):
        p.step(world)
    assert p.spin > first
    assert p.spin <= STEER_SLOW + 1e-9
    assert p.heading > 0  # right turns clockwise


def test_steering_left_and_right_cancel_out() -> None:
    p, world = robot()
    p.set_controls(False, False, True, True)
    for _ in range(20):
        p.step(world)
    assert p.spin == 0.0 and p.heading == 0.0


def test_the_turn_eases_back_to_straight_after_release() -> None:
    p, world = robot()
    p.set_controls(False, False, True, False)
    for _ in range(30):
        p.step(world)
    assert p.spin < 0
    p.release_controls()
    p.step(world)
    assert p.spin < 0  # still turning a moment after letting go
    for _ in range(40):
        p.step(world)
    assert p.spin == 0.0
    settled = p.heading
    p.step(world)
    assert p.heading == settled


def test_the_about_face_still_turns_exactly_half_a_circle() -> None:
    p, world = robot()
    p.set_controls(False, False, False, True)
    for _ in range(10):
        p.step(world)
    p.release_controls()
    p.spin = 0.0
    start = p.heading
    p.request_flip()
    for _ in range(int(1 / TICK)):
        p.step(world)
    assert math.isclose(p.heading - start, math.pi)


def test_the_turn_rate_falls_with_speed() -> None:
    assert turn_rate(0.0) == STEER_SLOW and turn_rate(MAX_SPEED) == STEER_FAST
    assert turn_rate(2.0) > turn_rate(8.0) > turn_rate(14.0)
    assert turn_rate(10 * MAX_SPEED) == STEER_FAST  # never extrapolates past top speed
    assert STEER_FAST < STEER_SLOW


def test_a_fast_robot_turns_wider_than_a_slow_one() -> None:
    def radius(speed: float) -> float:
        p, world = robot()
        p.set_controls(False, False, False, True)
        for _ in range(60):  # let the turn rate build up first (speed held constant)
            p.speed = speed
            p.step(world)
        before = p.heading
        for _ in range(40):
            p.speed = speed
            p.step(world)
        return speed / (
            (p.heading - before) / (40 * TICK)
        )  # radius = speed / turn rate

    assert radius(3.0) < 1.5  # a crawl turns on a coin
    assert 7 < radius(14.0) < 11  # top speed needs room
    assert radius(14.0) > 4 * radius(3.0)


class Pinch(World):
    """Open floor except two rocks that touch at a corner: (1, 0) and (0, 1)."""

    def __init__(self, rocks: set[tuple[int, int]]) -> None:
        super().__init__("t")
        self.rocks = rocks

    def is_floor(self, x: int, y: int) -> bool:
        return (x, y) not in self.rocks


SOUTH_EAST = 3 * math.pi / 4  # forward = (sin h, -cos h) = (+x, +y)


def test_no_squeezing_diagonally_between_two_rocks() -> None:
    world = Pinch({(1, 0), (0, 1)})
    p = Player("p", 1, "P")
    p.place(0, 0)
    p.heading, p.speed = SOUTH_EAST, 10.0
    for _ in range(40):  # coasting straight at the gap between the corners
        p.step(world)
        assert not (round(p.x) == 1 and round(p.y) == 1)


def test_a_diagonal_with_one_side_open_is_fine() -> None:
    world = Pinch({(1, 0)})
    p = Player("p", 1, "P")
    p.place(0, 0)
    p.heading, p.speed = SOUTH_EAST, 10.0
    for _ in range(10):
        p.step(world)
    assert p.x > 1.5 and p.y > 1.5


def test_pushing_into_the_pinch_drills_one_of_the_rocks() -> None:
    world = Pinch({(1, 0), (0, 1)})
    p = Player("p", 1, "P")
    p.place(0, 0)
    p.heading, p.cargo = SOUTH_EAST, 5
    p.set_controls(True, False, False, False)
    for _ in range(200):
        p.step(world)
        if p.drilled_tile is not None:
            break
    assert p.drilled_tile in {(1, 0), (0, 1)}
