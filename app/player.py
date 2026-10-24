"""A player's robot: vehicle physics, cargo and score bookkeeping.

The physics (steer, throttle, brake, drag, wall slide and bounce, smooth
about-face) is the single-player model from ``server.py`` with the energy
mechanic removed. A player never dies; the only way to stop is to brake.
"""

import math
from dataclasses import dataclass, field

from .grid import FloorMap

TICK = 0.05  # physics/stream step in seconds (20 Hz)
MAX_SPEED = 15.0  # tiles/second (must keep speed*TICK < 1 so we can't skip tiles)
ACCEL = 16.0  # tiles/second^2 while accelerating (Up)
BRAKE = 26.0  # tiles/second^2 while braking (Down)
DRAG = 0.5  # fraction of speed lost per second when coasting
STEER_SLOW = (
    3.2  # radians/second while steering at a crawl: sharp, so tight spots are easy
)
STEER_FAST = 1.6  # ...and at top speed: wide, so a fast robot can't whip around (radius ~9 tiles)
STEER_ACCEL = 8.0  # radians/second^2 the turn rate builds up while a steer key is held
STEER_EASE = 10.0  # radians/second^2 it eases back to straight once released

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

# Drilling: hold forward into a wall and the tile in front is bored out.
DRILL_COST = 1  # cargo points burned per drilled tile
DRILL_TIME = 1.0  # seconds per tile when you can pay the cost
DRILL_TIME_BROKE = 3.0  # seconds per tile with no cargo (free, but slow: never stuck)
DRILL_HEAD_ON = 0.7  # fraction of the motion that must point into the wall

# Crashing: hitting a wall hard shakes gems out of the cargo (they are lost).
CRASH_FREE = 0.2  # into-wall speeds up to this fraction of MAX_SPEED cost nothing
CRASH_MAX_LOSS = 10  # cargo lost hitting a wall head-on at top speed (linear between)
CRASH_FRESH = 10  # ticks off the wall before the next hit counts as a new crash (0.5 s)
DRILL_GRACE = 3  # ticks without contact before the progress is forgotten


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(v, hi))


@dataclass
class Ride:
    """A robot riding the rails: the points still to visit, in order."""

    pts: list[tuple[float, float]]
    i: int = 0
    ox: float = 0.0  # where the ride started (the hub boarded at)
    oy: float = 0.0
    seg: int = -1  # the stretch of track (index into pts) the turn below belongs to
    h0: float = 0.0  # heading when that stretch began


def hue_for(num: int) -> int:
    """A well-spread accent hue (degrees) for the player with this number."""
    return int(num * 137.508) % 360


def turn_rate(speed: float) -> float:
    """Radians/second available when steering at ``speed`` (tiles/second)."""
    return STEER_SLOW + (STEER_FAST - STEER_SLOW) * _clamp(speed / MAX_SPEED, 0.0, 1.0)


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
    spin: float = 0.0  # current turn rate in radians/second (+ is clockwise / right)
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
    ride: Ride | None = None  # set while riding the rails (no steering, no mining)

    drill_target: tuple[int, int] | None = None  # wall tile being drilled
    drill_progress: float = 0.0  # 0..1 of the current tile
    drill_gap: int = 0  # ticks since the drill last touched the wall
    drilled_tile: tuple[int, int] | None = (
        None  # set when a tile finishes; the game takes it
    )
    since_wall: int = 1_000_000  # ticks since the robot last touched a wall
    follow: str | None = None  # pid of the player followed (an arrow points there)
    inactive: bool = False  # no input for a while: others can't follow this one
    full_told: float = -1e9  # clock time of the last "cargo full" notice

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
        self.spin = 0.0
        self.drill_target, self.drill_progress, self.drill_gap = None, 0.0, 0
        self.release_controls()

    @property
    def drilling(self) -> bool:
        """True while the drill is biting into a wall."""
        return self.drill_progress > 0.0 and self.drill_gap == 0

    def _press_drill(self, tile: tuple[int, int], dt: float) -> None:
        """One tick of the drill pressed against ``tile``; flags it when it is through."""
        if tile != self.drill_target:
            self.drill_target, self.drill_progress = tile, 0.0
        self.drill_gap = 0
        seconds = DRILL_TIME if self.cargo >= DRILL_COST else DRILL_TIME_BROKE
        self.drill_progress += dt / seconds
        if self.drill_progress >= 1.0:
            self.drilled_tile = tile
            self.drill_progress = 0.0

    def _crash(self, into: float) -> None:
        """Hitting a wall at ``into`` tiles/second (the part of the motion into it) loses cargo."""
        free = CRASH_FREE * MAX_SPEED
        if into <= free or self.cargo <= 0:
            return
        loss = int(CRASH_MAX_LOSS * min(1.0, (into - free) / (MAX_SPEED - free)) + 0.5)
        loss = min(loss, self.cargo)
        if loss > 0:
            self.cargo -= loss
            self.notices.append({"t": "crash", "v": loss})

    def step(self, world: FloorMap, dt: float = TICK) -> None:
        """Advance the vehicle one physics step: steer, throttle/brake, move."""
        self.drill_gap += 1
        self.since_wall += 1
        if self.drill_gap > DRILL_GRACE:  # the drill lost the wall: start over
            self.drill_target, self.drill_progress = None, 0.0
        if self.flip_remaining > 0.0:
            # About-face: rotate steadily toward the reversed heading and coast
            # down to a near-stop, ignoring steer/throttle until it finishes.
            step = min(self.flip_remaining, FLIP_RATE * dt)
            self.heading += step
            self.flip_remaining -= step
            self.speed *= FLIP_SLOW
            self.spin = 0.0
        else:
            # The turn rate falls as speed rises (sharp at a crawl, wide at full speed), and the
            # robot only builds up to it and eases back, so steering is not abrupt.
            turn = turn_rate(self.speed)
            want = turn * (self.right - self.left)
            rate = STEER_ACCEL if want else STEER_EASE
            self.spin += _clamp(want - self.spin, -rate * dt, rate * dt)
            self.heading += self.spin * dt
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
        cx, cy = round(self.x), round(self.y)
        nx, ny = round(self.x + dx), round(self.y + dy)
        # Stepping diagonally into the next tile needs at least one of the two tiles beside
        # that corner open: no squeezing between two rocks that touch at a corner.
        pinched = nx != cx and ny != cy and not floor(nx, cy) and not floor(cx, ny)
        if floor(nx, ny) and not pinched:
            self.x += dx
            self.y += dy
            return
        bx = not floor(nx, cy)  # blocked in x
        by = not floor(cx, ny)  # blocked in y
        if not bx and not by:  # clipped a diagonal corner
            bx = by = True
        total = math.hypot(vx, vy) or 1e-9
        into = math.hypot(vx if bx else 0.0, vy if by else 0.0)
        drilling = (
            self.up and self.flip_remaining == 0.0 and into / total >= DRILL_HEAD_ON
        )
        # Only a fresh hit is a crash, not leaning on (or tunnelling into) a wall.
        if self.since_wall > CRASH_FRESH:
            self._crash(into)
        self.since_wall = 0
        if drilling:
            # Pushing straight into the rock with the throttle held: the drill
            # takes the hit (no bounce) and bores into the tile in front.
            self.speed = 0.0
            self.kx = self.ky = 0.0
            if pinched:  # bore into one of the two rocks, the one more ahead
                tx, ty = (nx, cy) if abs(vx) >= abs(vy) else (cx, ny)
            else:
                tx = nx if bx else cx
                ty = ny if by else cy
            self._press_drill((tx, ty), dt)
            return
        if not bx:  # slide along whichever axis is still open
            self.x += dx
        if not by:
            self.y += dy
        # Kill the into-wall part of the drive, keep the glancing part.
        self.bump = into
        tang = 0.0 if (bx and by) else (abs(vy) if bx else abs(vx))
        self.speed *= HIT_SLOW * (tang / total)
        # Reflect the blocked velocity back out as knockback (next tick).
        if bx:
            self.kx = -vx * BOUNCE
        if by:
            self.ky = -vy * BOUNCE
