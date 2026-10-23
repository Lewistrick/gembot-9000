"""Robot physics: steering builds up and eases back instead of switching on and off."""

import math

from app.grid import World
from app.player import STEER, TICK, Player


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
    assert 0 < first < STEER * 0.5  # not instantly at full rate
    for _ in range(40):
        p.step(world)
    assert p.spin > first
    assert p.spin <= STEER + 1e-9
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
