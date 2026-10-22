"""A player's robot: vehicle physics, cargo and score bookkeeping.

The physics (steer, throttle, brake, drag, wall slide and bounce, smooth
about-face) is the single-player model from ``server.py`` with the energy
mechanic removed. A player never dies; the only way to stop is to brake.
"""

import math
from dataclasses import dataclass, field

from .grid import World

TICK = 0.05  # physics/stream step in seconds (20 Hz)
MAX_SPEED = 15.0  # tiles/second (must keep speed*TICK < 1 so we can't skip tiles)
ACCEL = 16.0  # tiles/second^2 while accelerating (Up)
BRAKE = 26.0  # tiles/second^2 while braking (Down)
DRAG = 0.5  # fraction of speed lost per second when coasting
STEER = 2.8  # radians/second while steering at speed (Left/Right)
STEER_MIN = 0.35  # fraction of the steering rate available at a standstill

# Wall-bounce knobs. On a hit the into-wall speed is reversed into a short-lived
# "knockback" velocity (heading is left alone), so the vehicle rebounds off the
# rock and the player steers/throttles their way back out.
BOUNCE = 0.85  # fraction of the into-wall speed reflected back as knockback
HIT_SLOW = 0.85  # forward speed kept after a hit (times the glancing fraction)
KNOCK_KEEP = 0.88  # knockback velocity retained per tick (~0.35 s to fade out)

# About-face knobs: the 180° turn is smooth, coasting down to a near-stop.
FLIP_TIME = 0.6  # seconds to complete the half-turn
FLIP_RATE = math.pi / FLIP_TIME  # radians/second while turning around
FLIP_SLOW = 0.88  # speed retained per tick during the turn


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(v, hi))


@dataclass
class Player:
    """One robot in the world. Pure state plus movement; no networking."""

    pid: str  # public id (never the secret token)
    num: int  # short per-day number, used in compact network messages
    name: str
    x: float = 0.0
    y: float = 0.0
    heading: float = 0.0  # radians; 0 points up (-y). Forward = (sin, -cos).
    speed: float = 0.0  # tiles/second along the heading, never negative
    kx: float = 0.0  # knockback velocity (tiles/s), decoupled from heading
    ky: float = 0.0
    bump: float = 0.0  # into-wall impact this tick (drives the client's red flash)
    flip_remaining: float = 0.0  # radians left in a smooth 180° about-face
    up: bool = False
    down: bool = False
    left: bool = False
    right: bool = False

    cargo: int = 0  # value of mined gems not yet delivered to the base
    delivered: int = 0  # total value banked at the base
    toll_income: int = 0  # tolls earned from other players riding your hubs
    spent: int = 0  # score spent on building hubs and tracks
    chat: str = ""
    meta_version: int = 1  # bumped whenever name or chat changes

    in_world: bool = False  # robot is present (frees its slot when False)
    connected: bool = False  # a socket is attached right now
    last_input: float = 0.0  # clock time of the last real input
    disconnected_at: float | None = None
    warned: bool = False  # idle warning already sent
    notices: list[dict] = field(default_factory=list)  # private messages to send

    @property
    def score(self) -> int:
        """Leaderboard score: banked gems plus tolls earned, minus what was spent."""
        return self.delivered + self.toll_income - self.spent

    def set_controls(self, up: bool, down: bool, left: bool, right: bool) -> None:
        self.up, self.down, self.left, self.right = up, down, left, right

    def release_controls(self) -> None:
        self.up = self.down = self.left = self.right = False

    def request_flip(self) -> None:
        """Begin a smooth 180° about-face (ignored if one is already running)."""
        if self.flip_remaining == 0.0:
            self.flip_remaining = math.pi

    def place(self, x: float, y: float) -> None:
        """Put the robot at rest at ``(x, y)`` facing up."""
        self.x, self.y = x, y
        self.heading = 0.0
        self.speed = 0.0
        self.kx = self.ky = self.bump = 0.0
        self.flip_remaining = 0.0
        self.release_controls()

    def step(self, world: World, dt: float = TICK) -> None:
        """Advance the vehicle one physics step: steer, throttle/brake, move."""
        if self.flip_remaining > 0.0:
            # About-face: rotate steadily toward the reversed heading and coast
            # down to a near-stop, ignoring steer/throttle until it finishes.
            step = min(self.flip_remaining, FLIP_RATE * dt)
            self.heading += step
            self.flip_remaining -= step
            self.speed *= FLIP_SLOW
        else:
            # Turn rate scales with speed (subtle at a crawl, fuller at speed).
            turn = STEER * (STEER_MIN + (1.0 - STEER_MIN) * self.speed / MAX_SPEED)
            if self.left:
                self.heading -= turn * dt
            if self.right:
                self.heading += turn * dt
            if self.up:
                self.speed += ACCEL * dt
            if self.down:
                self.speed -= BRAKE * dt
            self.speed -= self.speed * DRAG * dt  # coasting drag
            self.speed = _clamp(self.speed, 0.0, MAX_SPEED)
            if self.speed < 0.05 and not self.up:
                self.speed = 0.0

        # Fade any lingering knockback from an earlier bounce, then apply it.
        self.kx *= KNOCK_KEEP
        self.ky *= KNOCK_KEEP
        if abs(self.kx) < 1e-3:
            self.kx = 0.0
        if abs(self.ky) < 1e-3:
            self.ky = 0.0

        # Combined velocity: steady drive along the heading + knockback drift.
        fx, fy = math.sin(self.heading), -math.cos(self.heading)
        vx = fx * self.speed + self.kx
        vy = fy * self.speed + self.ky
        mag = math.hypot(vx, vy)
        if mag > MAX_SPEED:  # cap the step so we can't skip over a thin wall
            vx *= MAX_SPEED / mag
            vy *= MAX_SPEED / mag

        self.bump = 0.0
        dx, dy = vx * dt, vy * dt
        if not (dx or dy):
            return
        floor = world.is_floor
        if floor(round(self.x + dx), round(self.y + dy)):
            self.x += dx
            self.y += dy
            return
        bx = not floor(round(self.x + dx), round(self.y))  # blocked in x
        by = not floor(round(self.x), round(self.y + dy))  # blocked in y
        if not bx and not by:  # clipped a diagonal corner
            bx = by = True
        if not bx:  # slide along whichever axis is still open
            self.x += dx
        if not by:
            self.y += dy
        # Kill the into-wall part of the drive, keep the glancing part.
        total = math.hypot(vx, vy) or 1e-9
        self.bump = math.hypot(vx if bx else 0.0, vy if by else 0.0)
        tang = 0.0 if (bx and by) else (abs(vy) if bx else abs(vx))
        self.speed *= HIT_SLOW * (tang / total)
        # Reflect the blocked velocity back out as knockback (next tick).
        if bx:
            self.kx = -vx * BOUNCE
        if by:
            self.ky = -vy * BOUNCE
