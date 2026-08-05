"""FastAPI server for GemBot 9000.

All game logic lives here in Python: world generation, the player's vehicle
physics (throttle / brake / steering), collision, seed selection and viewport
extraction. The browser is a thin client that streams which control keys are held
and smoothly renders the rotating viewport the server streams back each tick.
"""

import asyncio
import math
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .grid import CHUNK, DEFAULT_STYLE, World

_STATIC = Path(__file__).parent / "static"
_STYLES = {"dungeon", "aisles", "cave"}

_TICK = 0.05  # physics/stream step in seconds (20 Hz)
_MAX_SPEED = 15.0  # tiles/second (must keep speed*_TICK < 1 so we can't skip tiles)
_ACCEL = 16.0  # tiles/second^2 while accelerating (Up)
_BRAKE = 26.0  # tiles/second^2 while braking (Down)
_DRAG = 0.5  # fraction of speed lost per second when coasting
_STEER = 2.8  # radians/second while steering at speed (Left/Right)
_STEER_MIN = 0.35  # fraction of the steering rate available at a standstill

# Energy / scoring knobs (energy runs 0..100; tweak freely to tune the game).
DRAIN_ENERGY_LOSS = 1.8  # energy drained per second just by being powered on
HIT_ENERGY_LOSS = 0.9  # energy lost per tile/s of impact driven into a wall
GEM_ENERGY_GAIN = 0.6  # energy recovered per gem = its value times this factor


def _today() -> str:
    """Today's local date as an ISO string, used as the default seed."""
    return datetime.now().astimezone().date().isoformat()


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(v, hi))


class Session:
    """Per-connection game state: world, the player vehicle and the viewport."""

    def __init__(self) -> None:
        self.style = DEFAULT_STYLE
        self.world = World(_today(), self.style)
        self.px = 0.0
        self.py = 0.0
        self.heading = 0.0  # radians; 0 points up (-y). Forward = (sin, -cos).
        self.speed = 0.0  # tiles/second, never negative
        self.up = self.down = self.left = self.right = False
        self.cols = 41
        self.rows = 41
        self.score = 0
        self.energy = 100.0  # 0..100; hitting 0 ends the run
        self.collected: set[tuple[int, int]] = set()  # gems already picked up
        self.running = False  # True only while the client is actively playing
        self.dead = False  # True once energy has run out
        self._dirty = True
        self._spawn()

    def _spawn(self) -> None:
        """Place the player on the nearest floor tile to the origin, at rest."""
        self.speed = 0.0
        self.heading = 0.0
        for radius in range(64):
            for dy in range(-radius, radius + 1):
                for dx in range(-radius, radius + 1):
                    if self.world.is_floor(dx, dy):
                        self.px, self.py = float(dx), float(dy)
                        return

    def _bound_cache(self) -> None:
        """Keep only the on-screen chunks (plus a one-chunk margin) in memory."""
        span = (self.cols // CHUNK + 3) * (self.rows // CHUNK + 3)
        self.world.max_chunks = max(span, 16)

    def set_controls(self, up: bool, down: bool, left: bool, right: bool) -> None:
        self.up, self.down, self.left, self.right = up, down, left, right
        self._dirty = True

    def regenerate(self, seed: str, style: str) -> None:
        self.style = style if style in _STYLES else self.style
        self.world = World(seed, self.style)
        self.up = self.down = self.left = self.right = False
        self.score = 0  # a new world is a fresh run
        self.energy = 100.0
        self.dead = False
        self.running = True  # pressing Play/Restart starts the run
        self.collected.clear()
        self._bound_cache()
        self._spawn()
        self._dirty = True

    def set_running(self, on: bool) -> None:
        """Pause/resume the run (menu, pause overlay). Stops drain when off."""
        if not self.dead:
            self.running = on
        if not on:  # freeze the vehicle while paused
            self.up = self.down = self.left = self.right = False
        self._dirty = True

    def resize(self, cols: int, rows: int) -> None:
        self.cols = max(9, cols | 1)
        self.rows = max(9, rows | 1)
        self._bound_cache()
        self._dirty = True

    def active(self) -> bool:
        """Whether the client needs a steady frame stream (energy always drifts
        while a run is live, so we stream continuously until paused or dead)."""
        return self.running and not self.dead

    def tick(self) -> None:
        """Advance the vehicle one physics step: steer, throttle/brake, move."""
        if not self.running or self.dead:
            return
        dt = _TICK
        # Turn rate scales with speed (subtle at a crawl, fuller at speed).
        turn = _STEER * (_STEER_MIN + (1.0 - _STEER_MIN) * self.speed / _MAX_SPEED)
        if self.left:
            self.heading -= turn * dt
        if self.right:
            self.heading += turn * dt
        if self.up:
            self.speed += _ACCEL * dt
        if self.down:
            self.speed -= _BRAKE * dt
        self.speed -= self.speed * _DRAG * dt  # coasting drag
        self.speed = _clamp(self.speed, 0.0, _MAX_SPEED)
        if self.speed < 0.05 and not self.up:
            self.speed = 0.0

        self.energy -= DRAIN_ENERGY_LOSS * dt  # steady power drain

        impact = 0.0  # speed driven into a wall this step (0 = clean move)
        if self.speed > 0.0:
            vx = math.sin(self.heading) * self.speed * dt
            vy = -math.cos(self.heading) * self.speed * dt
            floor = self.world.is_floor
            if floor(round(self.px + vx), round(self.py + vy)):
                self.px, self.py = self.px + vx, self.py + vy
            elif floor(round(self.px + vx), round(self.py)):
                impact = self.speed * abs(math.cos(self.heading))  # y blocked
                self.px += vx  # slide along a rock horizontally
                self.speed *= 0.7
            elif floor(round(self.px), round(self.py + vy)):
                impact = self.speed * abs(math.sin(self.heading))  # x blocked
                self.py += vy  # slide along a rock vertically
                self.speed *= 0.7
            else:
                impact = self.speed  # ran head-on into a rock
                self.speed = 0.0

        if impact > 0.0:
            self.energy -= HIT_ENERGY_LOSS * impact  # harder = costlier
            self._dirty = True

        self._collect()  # pick up a gem on the current tile (even while parked)

        if self.energy >= 100.0:
            self.energy = 100.0
        elif self.energy <= 0.0:  # out of power: end the run
            self.energy = 0.0
            self.dead = True
            self.running = False
            self.speed = 0.0
            self.up = self.down = self.left = self.right = False
            self._dirty = True

    def _collect(self) -> None:
        """Collect an uncollected gem under the player, once, adding its value."""
        cell = (round(self.px), round(self.py))
        if cell in self.collected:
            return
        value = self.world.gem_at(*cell)
        if value is not None:
            self.collected.add(cell)
            self.score += value
            self.energy = min(100.0, self.energy + value * GEM_ENERGY_GAIN)
            self._dirty = True

    def take_dirty(self) -> bool:
        was, self._dirty = self._dirty, False
        return was

    def state(self) -> dict:
        """A square viewport plus the exact float pose for smooth rotation."""
        cxi, cyi = round(self.px), round(self.py)
        x0 = cxi - self.cols // 2
        y0 = cyi - self.rows // 2
        tiles = self.world.viewport(x0, y0, self.cols, self.rows)

        # Gem sites visible in this viewport: uncollected ones glow as gems,
        # collected ones are drawn as leftover rubble by the client.
        gems = []
        rubble = []
        collected = self.collected
        gem = self.world.gem_on_floor
        for r, row in enumerate(tiles):
            wy = y0 + r
            for c, floor in enumerate(row):
                if not floor:
                    continue
                wx = x0 + c
                value = gem(wx, wy)
                if value is None:
                    continue
                if (wx, wy) in collected:
                    rubble.append({"x": wx, "y": wy})
                else:
                    gems.append({"x": wx, "y": wy, "v": value})

        return {
            "x0": x0,
            "y0": y0,
            "cols": self.cols,
            "rows": self.rows,
            "tiles": tiles,
            "gems": gems,
            "rubble": rubble,
            "score": self.score,
            "energy": self.energy,
            "dead": self.dead,
            "player": {
                "x": self.px,
                "y": self.py,
                "heading": self.heading,
                "speed": self.speed,
            },
            "max_speed": _MAX_SPEED,
            "moving": self.speed > 1e-3,
            "tick_ms": int(_TICK * 1000),
            "colors": self.world.palette(math.hypot(self.px, self.py)),
            "seed": self.world.seed_str,
            "style": self.style,
        }


app = FastAPI(title="GemBot 9000")
app.mount("/static", StaticFiles(directory=_STATIC), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return (_STATIC / "index.html").read_text(encoding="utf-8")


async def _reader(sock: WebSocket, session: Session) -> None:
    """Apply incoming client messages to the session until it disconnects."""
    while True:
        msg = await sock.receive_json()
        action = msg.get("action")
        if action == "controls":
            session.set_controls(
                bool(msg.get("up")),
                bool(msg.get("down")),
                bool(msg.get("left")),
                bool(msg.get("right")),
            )
        elif action == "seed":
            session.regenerate(
                str(msg.get("seed") or _today()),
                str(msg.get("style") or session.style),
            )
        elif action == "resize":
            session.resize(
                int(msg.get("cols", session.cols)), int(msg.get("rows", session.rows))
            )
        elif action == "active":
            session.set_running(bool(msg.get("on")))


# Sessions are keyed by a client token so a dropped/reconnected socket (e.g. a
# brief network blip) resumes the same run instead of respawning at the origin.
_SESSIONS: dict[str, Session] = {}


@app.websocket("/ws")
async def ws(sock: WebSocket) -> None:
    await sock.accept()
    token = sock.query_params.get("token")
    session = _SESSIONS.get(token) if token else None
    if session is None:
        session = Session()
        if token:
            _SESSIONS[token] = session
    await sock.send_json(session.state())
    reader = asyncio.create_task(_reader(sock, session))
    try:
        while not reader.done():
            session.tick()
            if session.active() or session.take_dirty():
                await sock.send_json(session.state())
            await asyncio.sleep(_TICK)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader.cancel()
