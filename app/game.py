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
from datetime import datetime, timedelta
from datetime import time as dtime
from zoneinfo import ZoneInfo

from .grid import BASE_RADIUS, DEFAULT_STYLE, World
from .player import Player

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

    # ------------------------------------------------------------------ #
    # Joining and leaving
    # ------------------------------------------------------------------ #
    def online_count(self) -> int:
        return sum(1 for p in self.players.values() if p.in_world)

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
        player.in_world = False
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
            player.set_controls(up, down, left, right)
            self.touch(pid)

    def flip(self, pid: str) -> None:
        player = self.players.get(pid)
        if player is not None and player.in_world:
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
            player.step(self.world)
            self._pickup(player)
            self._deliver(player)
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
