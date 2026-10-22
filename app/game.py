"""One day's shared game: the world, every player, mined gems and the board.

``Game`` is plain, synchronous logic with an injectable clock so it can be unit
tested without sockets. The server calls :meth:`Game.tick` at 20 Hz; the
connection layer (``connection.py``) turns the state into network messages.
"""

import math
import os
import random
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from datetime import time as dtime
from typing import Self
from zoneinfo import ZoneInfo

from .grid import BASE_RADIUS, DEFAULT_STYLE, World
from .player import TICK, Player, Ride
from .rail import CART_SPEED, RIDE_SPEED, Hub, Network, Quote, advance

MAX_PLAYERS = 100
NAME_MAX = 16
CHAT_MAX = 60
CHAT_COOLDOWN = 1.0  # seconds between chat changes per player
IDLE_WARN = 9 * 60.0  # idle seconds before the "still there?" warning
IDLE_KICK = 10 * 60.0  # idle seconds before the player is removed
DISCONNECT_GRACE = 15.0  # seconds a dropped robot lingers before leaving the world
BOARD_EVERY = 40  # ticks between leaderboard refreshes (2 s at 20 Hz)
RUSH_START = 23 * 60  # minute of the day when gems become worth double
FINAL_WARN = 23 * 60 + 50  # minute of the day for the "deliver your cargo" warning
RUSH_MULTIPLIER = 2
SPAWN_RING = 8.0  # players spawn within this radius of the origin

# Control, format and bidi/zero-width code point ranges removed from names and chat.
_STRIP_RANGES = (
    (0x00, 0x1F),
    (0x7F, 0x9F),
    (0x200B, 0x200F),
    (0x2028, 0x202E),
    (0x2060, 0x2064),
)
_CONTROL_CHARS = re.compile(
    "[" + "".join(f"{chr(a)}-{chr(b)}" for a, b in _STRIP_RANGES) + "]"
)


def local_now() -> datetime:
    """The current time in the game's time zone (``GEMBOT_TZ``, default UTC)."""
    return datetime.now(ZoneInfo(os.environ.get("GEMBOT_TZ") or "UTC"))


def today() -> str:
    """Today's date as an ISO string: the world seed and the name of the day."""
    return local_now().date().isoformat()


def clean_text(text: object, limit: int) -> str:
    """Strip control/invisible characters, collapse spaces and cap the length."""
    if not isinstance(text, str):
        return ""
    return " ".join(_CONTROL_CHARS.sub(" ", text).split())[:limit].strip()


class Row(tuple):
    """``(num, x, y, heading, flags)`` for another robot, with its JSON text cached.

    Built once per robot per tick and shared by every client that sees it, so the
    rounding and formatting is not repeated for each of up to 100 viewers.
    """

    js: str

    def __new__(cls, num: int, x: float, y: float, heading: float, flags: int) -> Self:
        row = super().__new__(
            cls, (num, round(x, 2), round(y, 2), round(heading, 3), flags)
        )
        row.js = f"[{row[0]},{row[1]},{row[2]},{row[3]},{flags}]"
        return row


@dataclass
class Cart:
    """Gems shipped to the base on their own, riding the rails."""

    id: int
    owner: str
    value: int
    x: float
    y: float
    pts: list[tuple[float, float]]
    i: int = 0
    angle: float = 0.0  # direction of travel, atan2(dy, dx)


class Game:
    """The world and all players for a single day."""

    def __init__(
        self,
        day: str,
        *,
        clock: Callable[[], float] = time.monotonic,
        rng: random.Random | None = None,
        style: str = DEFAULT_STYLE,
        wall: Callable[[], datetime] = local_now,
        crown_pid: str | None = None,
    ) -> None:
        self.day = day
        self.wall = wall
        self.crown_pid = crown_pid  # yesterday's winner wears the crown
        self.rush = False
        self._final_warned = False
        self.day_left = 0  # seconds until midnight, refreshed with the board
        self.world = World(day, style)
        self.clock = clock
        self.rng = rng or random.Random()
        self.players: dict[str, Player] = {}
        self.names: dict[str, str] = {}  # lowercase name -> pid (reserved all day)
        self.mined: set[tuple[int, int]] = set()
        self.mined_log: list[tuple[int, int]] = []  # append-only, for client deltas
        self.announcements: list[tuple[int, str]] = []
        self.multiplier = 1  # gem value multiplier (rush hour)
        self.tick_count = 0
        self.board: list[Player] = []  # ranked, refreshed every BOARD_EVERY ticks
        self.rank: dict[str, int] = {}
        self._next_num = 1
        self._last_chat: dict[str, float] = {}
        self._present: list[Player] | None = None
        self._rows: dict[str, Row] = {}
        self._rows_tick = -1
        self.rail = Network()
        self.carts: list[Cart] = []
        self._next_cart = 1

    # ------------------------------------------------------------------ #
    # Joining and leaving
    # ------------------------------------------------------------------ #
    def online_count(self) -> int:
        return len(self.present)

    @property
    def present(self) -> list[Player]:
        """Players currently in the world (cached; membership changes reset it)."""
        if self._present is None:
            self._present = [p for p in self.players.values() if p.in_world]
        return self._present

    def row(self, q: Player) -> Row:
        """The shared network row for robot ``q`` this tick."""
        if self._rows_tick != self.tick_count:
            self._rows, self._rows_tick = {}, self.tick_count
        row = self._rows.get(q.pid)
        if row is None:
            row = self._rows[q.pid] = Row(
                q.num, q.x, q.y, q.heading, 1 if q.ride else 0
            )
        return row

    def join(self, pid: str, name: str) -> Player | None:
        """Add (or resume) a player. Returns ``None`` when the server is full."""
        player = self.players.get(pid)
        if (
            player is None or not player.in_world
        ) and self.online_count() >= MAX_PLAYERS:
            return None
        if player is None:
            player = Player(pid=pid, num=self._next_num, name="")
            self._next_num += 1
            player.name = self._claim_name(pid, name, player.num)
            self.players[pid] = player
            self._spawn(player)
        else:
            wanted = clean_text(name, NAME_MAX)
            if wanted and wanted.lower() != player.name.lower():
                self._rename(player, wanted)
            if not player.in_world:  # back after an idle kick: resume where we were
                player.release_controls()
        player.in_world = True
        player.connected = True
        player.disconnected_at = None
        self._present = None
        self.touch(pid)
        return player

    def leave(self, pid: str) -> None:
        """The socket dropped: keep the robot for a grace period, then remove it."""
        player = self.players.get(pid)
        if player is not None and player.in_world:
            player.connected = False
            player.disconnected_at = self.clock()
            player.release_controls()

    def quit(self, pid: str) -> None:
        """The player chose to leave: free their slot now (their record stays)."""
        player = self.players.get(pid)
        if player is not None:
            self._remove(player)

    def _remove(self, player: Player) -> None:
        player.ride = None  # a robot never stays "riding" while out of the world
        player.in_world = False
        self._present = None
        player.connected = False
        player.release_controls()
        player.speed = 0.0

    def _spawn(self, player: Player) -> None:
        angle = self.rng.random() * math.tau
        radius = SPAWN_RING * math.sqrt(self.rng.random())
        player.place(round(math.cos(angle) * radius), round(math.sin(angle) * radius))

    # ------------------------------------------------------------------ #
    # Names: reserved for the whole day, even while the owner is away
    # ------------------------------------------------------------------ #
    def _claim_name(self, pid: str, wanted: str, num: int) -> str:
        base = clean_text(wanted, NAME_MAX) or f"Bot-{num}"
        name, n = base, 1
        while self.names.get(name.lower(), pid) != pid:
            n += 1
            suffix = f"#{n}"
            name = base[: NAME_MAX - len(suffix)].rstrip() + suffix
        self.names[name.lower()] = pid
        return name

    def _rename(self, player: Player, wanted: str) -> None:
        old = player.name.lower()
        new = self._claim_name(player.pid, wanted, player.num)
        if new.lower() != old:
            self.names.pop(old, None)
            player.name = new
            player.meta_version += 1

    # ------------------------------------------------------------------ #
    # Input
    # ------------------------------------------------------------------ #
    def touch(self, pid: str) -> None:
        """Record real input from a player (resets the idle timer)."""
        player = self.players.get(pid)
        if player is not None:
            player.last_input = self.clock()
            player.warned = False

    def control(self, pid: str, up: bool, down: bool, left: bool, right: bool) -> None:
        player = self.players.get(pid)
        if player is not None and player.in_world:
            if player.ride is None:
                player.set_controls(up, down, left, right)
            self.touch(pid)

    def flip(self, pid: str) -> None:
        player = self.players.get(pid)
        if player is not None and player.in_world:
            if player.ride is None:
                player.request_flip()
            self.touch(pid)

    def set_chat(self, pid: str, text: object) -> bool:
        """Set (or clear) the speech bubble. False if rate-limited."""
        player = self.players.get(pid)
        if player is None or not player.in_world:
            return False
        self.touch(pid)
        now = self.clock()
        if now - self._last_chat.get(pid, -CHAT_COOLDOWN) < CHAT_COOLDOWN:
            return False
        self._last_chat[pid] = now
        cleaned = clean_text(text, CHAT_MAX)
        if cleaned != player.chat:
            player.chat = cleaned
            player.meta_version += 1
        return True

    def announce(self, text: str) -> None:
        self.announcements.append((len(self.announcements) + 1, text))

    # ------------------------------------------------------------------ #
    # The tick
    # ------------------------------------------------------------------ #
    def tick(self) -> None:
        now = self.clock()
        self.tick_count += 1
        for player in list(self.players.values()):
            if not player.in_world:
                continue
            if not player.connected:
                if now - (player.disconnected_at or now) >= DISCONNECT_GRACE:
                    self._remove(player)
                    continue
            else:
                idle = now - player.last_input
                if idle >= IDLE_KICK:
                    player.notices.append({"t": "kicked", "why": "idle"})
                    self._remove(player)
                    continue
                if idle >= IDLE_WARN and not player.warned:
                    player.warned = True
                    player.notices.append(
                        {"t": "warn", "left": int(IDLE_KICK - idle), "why": "idle"}
                    )
            if player.ride is not None:
                self._ride_step(player)
            else:
                player.step(self.world)
                self._pickup(player)
            self._deliver(player)
        self._move_carts()
        if self.tick_count % BOARD_EVERY == 1:
            self.refresh_board()
            self._clock_events()

    def _pickup(self, player: Player) -> None:
        cell = (round(player.x), round(player.y))
        if cell in self.mined:
            return
        base = self.world.gem_on_floor(*cell)
        if base is None:
            return
        value = base * self.multiplier
        self.mined.add(cell)
        self.mined_log.append(cell)
        player.cargo += value
        mega = self.world.is_mega(*cell)
        player.notices.append({"t": "gain", "v": value, "mega": mega})
        if mega:
            self.announce(f"{player.name} mined a MEGA gem worth {value}!")

    def _deliver(self, player: Player) -> None:
        if player.cargo and math.hypot(player.x, player.y) <= BASE_RADIUS:
            player.delivered += player.cargo
            player.notices.append({"t": "delivered", "v": player.cargo})
            player.cargo = 0

    # ------------------------------------------------------------------ #
    # Rail: hubs, tracks, riding, tolls and cargo carts
    # ------------------------------------------------------------------ #
    def _rail_player(self, pid: str) -> Player | None:
        """The player if they can act on the rail right now (present, not riding)."""
        player = self.players.get(pid)
        if player is None or not player.in_world:
            return None
        self.touch(pid)
        return None if player.ride is not None else player

    def _say(self, player: Player, ok: bool, text: str) -> None:
        player.notices.append({"t": "rail", "ok": ok, "msg": text})

    def hub_under(self, player: Player) -> Hub | None:
        """The hub the player is parked on (slow enough to count as stopped)."""
        if player.speed > 2.5 or player.ride is not None:
            return None
        return self.rail.nearest(player.x, player.y)

    @staticmethod
    def _quote_msg(q: Quote, origin: Hub) -> dict:
        return {
            "t": "quote",
            "ok": q.ok,
            "why": q.why,
            "cost": q.cost,
            "x": q.x,
            "y": q.y,
            "from": [origin.x, origin.y],
            "new": q.kind == "track",
            "len": round(q.length, 1),
        }

    def build_hub(self, pid: str) -> None:
        """Build a standalone hub where the player is standing."""
        player = self._rail_player(pid)
        if player is None:
            return
        q = self.rail.quote_hub(
            self.world, round(player.x), round(player.y), player.score
        )
        if not q.ok:
            return self._say(player, False, q.why)
        player.spent += q.cost
        self.rail.apply(q, pid)
        self._say(player, True, f"Hub built (-{q.cost})")

    def build_track(self, pid: str, x: int, y: int, confirm: bool) -> None:
        """Lay a track from the hub under the player to ``(x, y)`` (preview, then confirm)."""
        player = self._rail_player(pid)
        if player is None:
            return
        origin = self.hub_under(player)
        if origin is None:
            return self._say(player, False, "Stop on a hub to build a track from it.")
        q = self.rail.quote_track(self.world, origin.id, x, y, player.score)
        if not confirm:
            player.notices.append(self._quote_msg(q, origin))
        elif not q.ok:
            self._say(player, False, q.why)
        else:
            player.spent += q.cost
            self.rail.apply(q, pid)
            self._say(player, True, f"Built (-{q.cost})")
            player.notices.append({"t": "built"})

    def _pay_tolls(self, payer: Player, builders: list[str], from_cargo: bool) -> None:
        """Move one point per toll from the payer's cargo to each hub's builder."""
        if from_cargo:
            payer.cargo -= len(builders)
        owed: dict[str, int] = {}
        for b in builders:
            owed[b] = owed.get(b, 0) + 1
        for b, n in owed.items():
            builder = self.players.get(b)
            if builder is not None:
                builder.toll_income += n
                if builder.in_world:
                    builder.notices.append({"t": "toll", "v": n, "from": payer.name})

    def net_map(self, pid: str) -> None:
        """Send the network the player is parked on, with a toll quote per hub."""
        player = self._rail_player(pid)
        if player is None:
            return
        here = self.hub_under(player)
        if here is None:
            return self._say(player, False, "Stop on a hub to see its network.")
        rows = []
        for hid in self.rail.component(here.id):
            hub = self.rail.hubs[hid]
            route = self.rail.route(here.id, hid) or [hid]
            owner = self.players.get(hub.builder or "")
            rows.append(
                {
                    "id": hid,
                    "x": hub.x,
                    "y": hub.y,
                    "out": hub.out,
                    "by": owner.name if owner else ("BASE" if hid == 0 else "?"),
                    "bn": owner.num if owner else 0,
                    "toll": len(self.rail.toll_builders(route, player.pid)),
                }
            )
        ship = None
        to_base = self.rail.route(here.id, 0)
        if to_base is not None and here.id != 0:
            ship = {"toll": len(self.rail.toll_builders(to_base, player.pid))}
        player.notices.append(
            {
                "t": "net",
                "at": here.id,
                "hubs": rows,
                "cargo": player.cargo,
                "ship": ship,
            }
        )

    def ride(self, pid: str, to: int) -> None:
        """Ride the rails to another hub of the same network (tolls come out of cargo)."""
        player = self._rail_player(pid)
        if player is None:
            return
        here = self.hub_under(player)
        if here is None or to not in self.rail.hubs or to == here.id:
            return self._say(player, False, "Stop on a hub, then pick another one.")
        route = self.rail.route(here.id, to)
        if route is None:
            return self._say(player, False, "That hub is not on this network.")
        tolls = self.rail.toll_builders(route, pid)
        if player.cargo < len(tolls):
            return self._say(
                player,
                False,
                f"No cargo, no ride: the tolls are {len(tolls)} and you carry {player.cargo}.",
            )
        self._pay_tolls(player, tolls, from_cargo=True)
        player.place(float(here.x), float(here.y))
        player.ride = Ride(self.rail.points(route)[1:])
        player.speed = RIDE_SPEED
        if tolls:
            self._say(player, True, f"Riding. Tolls paid: {len(tolls)}")

    def send_cargo(self, pid: str) -> None:
        """Ship the whole cargo to the base on its own cart (tolls come out of it)."""
        player = self._rail_player(pid)
        if player is None:
            return
        here = self.hub_under(player)
        if here is None or here.id == 0:
            return self._say(
                player, False, "Stop on a hub (not the base) to ship cargo."
            )
        route = self.rail.route(here.id, 0)
        if route is None:
            return self._say(player, False, "This hub is not linked to the base.")
        if player.cargo <= 0:
            return self._say(player, False, "You carry nothing to ship.")
        tolls = self.rail.toll_builders(route, pid)
        if player.cargo <= len(tolls):
            return self._say(
                player, False, f"The tolls ({len(tolls)}) would eat the whole shipment."
            )
        value = player.cargo - len(tolls)
        self._pay_tolls(player, tolls, from_cargo=False)
        player.cargo = 0
        pts = self.rail.points(route)
        self.carts.append(
            Cart(self._next_cart, pid, value, pts[0][0], pts[0][1], pts[1:])
        )
        self._next_cart += 1
        self._say(
            player, True, f"Shipment sent: {value} to arrive (tolls {len(tolls)})"
        )

    def _ride_step(self, player: Player) -> None:
        ride = player.ride
        assert ride is not None
        x, y, ride.i = advance(player.x, player.y, ride.pts, ride.i, RIDE_SPEED * TICK)
        dx, dy = x - player.x, y - player.y
        if dx or dy:  # swing the heading toward the direction of travel, smoothly
            want = math.atan2(dx, -dy)
            diff = (want - player.heading + math.pi) % math.tau - math.pi
            player.heading += max(-0.3, min(0.3, diff))
        player.x, player.y = x, y
        if ride.i >= len(ride.pts):
            player.ride = None
            player.speed = 0.0

    def _move_carts(self) -> None:
        for cart in self.carts[:]:
            nx, ny, cart.i = advance(
                cart.x, cart.y, cart.pts, cart.i, CART_SPEED * TICK
            )
            if nx != cart.x or ny != cart.y:
                cart.angle = math.atan2(ny - cart.y, nx - cart.x)
            cart.x, cart.y = nx, ny
            if cart.i >= len(cart.pts):
                self._land(cart)

    def _land(self, cart: Cart) -> None:
        self.carts.remove(cart)
        owner = self.players.get(cart.owner)
        if owner is not None:
            owner.delivered += cart.value
            if owner.in_world:
                owner.notices.append({"t": "delivered", "v": cart.value})

    def settle_carts(self) -> None:
        """Credit every shipment still on the rails (the day or server is ending)."""
        for cart in self.carts[:]:
            self._land(cart)

    # ------------------------------------------------------------------ #
    # Time of day: rush hour and the end-of-day warning
    # ------------------------------------------------------------------ #
    def seconds_left(self) -> float:
        now = self.wall()
        midnight = datetime.combine(
            now.date() + timedelta(days=1), dtime.min, tzinfo=now.tzinfo
        )
        return max(0.0, (midnight - now).total_seconds())

    def _clock_events(self) -> None:
        now = self.wall()
        minute = now.hour * 60 + now.minute
        self.day_left = int(self.seconds_left())
        if minute >= RUSH_START and not self.rush:
            self.rush = True
            self.multiplier = RUSH_MULTIPLIER
            self.announce("RUSH HOUR! Every gem is worth double until midnight.")
        if minute >= FINAL_WARN and not self._final_warned:
            self._final_warned = True
            self.announce(
                "10 minutes left! Deliver your cargo, it is lost at midnight."
            )

    # ------------------------------------------------------------------ #
    # Restoring saved state (see store.py)
    # ------------------------------------------------------------------ #
    def restore_player(self, rec: dict) -> None:
        """Re-create a saved player. They are out of the world until they rejoin."""
        player = Player(pid=rec["pid"], num=rec["num"], name=rec["name"])
        player.x, player.y = rec["x"], rec["y"]
        player.delivered, player.spent = rec["delivered"], rec["spent"]
        player.toll_income, player.cargo = rec["toll_income"], rec["cargo"]
        player.chat = rec["chat"]
        self.players[player.pid] = player
        self.names[player.name.lower()] = player.pid
        self._next_num = max(self._next_num, player.num + 1)

    def restore_mined(self, cells: list[tuple[int, int]]) -> None:
        for cell in cells:
            if cell not in self.mined:
                self.mined.add(cell)
                self.mined_log.append(cell)

    # ------------------------------------------------------------------ #
    # Leaderboard
    # ------------------------------------------------------------------ #
    def refresh_board(self) -> None:
        ranked = [p for p in self.players.values() if p.score > 0 or p.in_world]
        ranked.sort(key=lambda p: (-p.score, p.num))
        self.board = ranked
        self.rank = {p.pid: i + 1 for i, p in enumerate(ranked)}

    def board_rows(self, limit: int = 10) -> list[dict]:
        return [
            {"id": p.pid, "n": p.name, "s": p.score, "on": p.in_world}
            for p in self.board[:limit]
        ]
