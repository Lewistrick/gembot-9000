"""Per-socket protocol state: applies client input and builds server messages.

Kept free of any websocket code so it can be unit tested. The server calls
:meth:`Connection.frame` once per tick and sends the returned messages; reliable
messages (chunks, mined gems, chat, notices) are never dropped, while the
volatile ``tick`` message may be skipped for a slow client.

Messages, server -> client (``t`` is the type):

* ``welcome``  your id, day, world constants, base palette
* ``chunk``    one terrain chunk: packed floor bits, gem sites, already-mined gems
* ``drop``     chunks the client may forget (it is far from them now)
* ``mined``    gem cells mined since the last message (everyone's)
* ``meta``     name / chat / hue for robots that just came into view or changed
* ``tick``     your pose, cargo and score; every other tick also nearby robots
* ``board``    top of the daily leaderboard, your rank, online count, palette
* ``announce`` game-wide text; ``gain`` / ``delivered`` / ``warn`` / ``kicked``
  are private notices
"""

import base64
import math

from .game import MAX_PLAYERS, Game
from .grid import BASE_RADIUS, CHUNK
from .player import MAX_SPEED, TICK, Player

VIEW_MIN = 9
VIEW_MAX = 81  # tiles; caps how much of the world a client can ask for
NEAR_PAD = 4  # extra tiles around the view in which other robots are sent
CHUNK_MARGIN = CHUNK  # prefetch one chunk beyond the view
FORGET_MARGIN = 2  # chunks beyond the wanted range before the server says "drop"


def hue_for(num: int) -> int:
    """A well-spread accent hue (degrees) for the player with this number."""
    return int(num * 137.508) % 360


def _flag(msg: dict, key: str) -> bool:
    return msg.get(key) is True


class Connection:
    """The protocol state for one connected player."""

    def __init__(self, game: Game, player: Player) -> None:
        self.game = game
        self.player = player
        self.cols = self.rows = 41
        self.sent: set[tuple[int, int]] = set()
        self.mined_cursor = len(game.mined_log)
        self.ann_cursor = len(game.announcements)
        self.known: dict[int, int] = {}  # robot num -> meta_version already sent
        self.board_epoch = -1
        player.notices.clear()

    # ------------------------------------------------------------------ #
    def welcome(self) -> dict:
        g, p = self.game, self.player
        return {
            "t": "welcome",
            "you": {"id": p.pid, "num": p.num, "name": p.name, "hue": hue_for(p.num)},
            "day": g.day,
            "chunk": CHUNK,
            "cap": MAX_PLAYERS,
            "tick_ms": int(TICK * 1000),
            "max_speed": MAX_SPEED,
            "base": BASE_RADIUS,
            "colors": g.world.palette(0.0),
            "mult": g.multiplier,
        }

    # ------------------------------------------------------------------ #
    def handle(self, msg: dict) -> None:
        """Apply one client message. Unknown or malformed input is ignored."""
        g, pid = self.game, self.player.pid
        action = msg.get("action")
        if action == "resize":
            try:
                cols, rows = int(msg["cols"]), int(msg["rows"])
            except KeyError, TypeError, ValueError:
                return
            self.cols = min(VIEW_MAX, max(VIEW_MIN, cols)) | 1
            self.rows = min(VIEW_MAX, max(VIEW_MIN, rows)) | 1
        elif action == "controls":
            g.control(
                pid,
                _flag(msg, "up"),
                _flag(msg, "down"),
                _flag(msg, "left"),
                _flag(msg, "right"),
            )
        elif action == "flip":
            g.flip(pid)
        elif action == "chat":
            g.set_chat(pid, msg.get("text"))
        elif action == "quit":
            g.quit(pid)

    # ------------------------------------------------------------------ #
    def _chunk_range(self, margin: int) -> tuple[int, int, int, int]:
        p = self.player
        hw, hh = self.cols / 2 + margin, self.rows / 2 + margin
        return (
            math.floor((p.x - hw) / CHUNK),
            math.floor((p.x + hw) / CHUNK),
            math.floor((p.y - hh) / CHUNK),
            math.floor((p.y + hh) / CHUNK),
        )

    def _chunk_msg(self, cx: int, cy: int) -> dict:
        g = self.game
        gems = g.world.chunk_gems(cx, cy)
        mega = g.world.mega_sites
        return {
            "t": "chunk",
            "cx": cx,
            "cy": cy,
            "bits": base64.b64encode(g.world.floor_bits(cx, cy)).decode("ascii"),
            "gems": [[x, y, v] for (x, y), v in gems.items()],
            "mega": [[x, y] for (x, y) in gems if (x, y) in mega],
            "mined": [[x, y] for (x, y) in gems if (x, y) in g.mined],
        }

    def frame(self, chunk_budget: list[int]) -> tuple[list[dict], dict]:
        """Build this tick's messages: ``(reliable, volatile_tick)``.

        ``chunk_budget`` is a one-item list shared by every connection this tick,
        capping how many new chunks are generated so a crowd joining at once
        cannot stall the loop; connections that miss out catch up next tick.
        """
        g, p = self.game, self.player
        out: list[dict] = []

        # -- terrain ----------------------------------------------------- #
        cx0, cx1, cy0, cy1 = self._chunk_range(CHUNK_MARGIN)
        need = [
            (cx, cy)
            for cy in range(cy0, cy1 + 1)
            for cx in range(cx0, cx1 + 1)
            if (cx, cy) not in self.sent
        ]
        need.sort(
            key=lambda k: (
                (k[0] * CHUNK + CHUNK / 2 - p.x) ** 2
                + (k[1] * CHUNK + CHUNK / 2 - p.y) ** 2
            )
        )
        for key in need:
            if chunk_budget[0] <= 0:
                break
            chunk_budget[0] -= 1
            out.append(self._chunk_msg(*key))
            self.sent.add(key)
        if g.tick_count % 20 == 0 and self.sent:
            fx0, fx1, fy0, fy1 = self._chunk_range(CHUNK_MARGIN + FORGET_MARGIN * CHUNK)
            far = [
                k for k in self.sent if not (fx0 <= k[0] <= fx1 and fy0 <= k[1] <= fy1)
            ]
            if far:
                self.sent.difference_update(far)
                out.append({"t": "drop", "c": [list(k) for k in far]})

        # -- shared world changes --------------------------------------- #
        if self.mined_cursor < len(g.mined_log):
            out.append(
                {"t": "mined", "c": [list(c) for c in g.mined_log[self.mined_cursor :]]}
            )
            self.mined_cursor = len(g.mined_log)
        while self.ann_cursor < len(g.announcements):
            out.append({"t": "announce", "text": g.announcements[self.ann_cursor][1]})
            self.ann_cursor += 1

        # -- robots in view ---------------------------------------------- #
        hw, hh = self.cols / 2 + NEAR_PAD, self.rows / 2 + NEAR_PAD
        near = [
            q
            for q in g.players.values()
            if q is not p
            and q.in_world
            and abs(q.x - p.x) <= hw
            and abs(q.y - p.y) <= hh
        ]
        metas = []
        for q in [p, *near]:
            if self.known.get(q.num) != q.meta_version:
                self.known[q.num] = q.meta_version
                metas.append(
                    {
                        "n": q.num,
                        "id": q.pid,
                        "name": q.name,
                        "chat": q.chat,
                        "hue": hue_for(q.num),
                    }
                )
        if metas:
            out.append({"t": "meta", "list": metas})

        # -- private notices and the board -------------------------------- #
        if p.notices:
            out.extend(p.notices)
            p.notices.clear()
        epoch = g.tick_count // 40
        if epoch != self.board_epoch:
            self.board_epoch = epoch
            out.append(
                {
                    "t": "board",
                    "top": g.board_rows(10),
                    "you": {"rank": g.rank.get(p.pid), "score": p.score},
                    "online": g.online_count(),
                    "pal": g.world.palette(math.hypot(p.x, p.y)),
                    "mult": g.multiplier,
                }
            )

        tick: dict = {
            "t": "tick",
            "n": g.tick_count,
            "x": round(p.x, 2),
            "y": round(p.y, 2),
            "h": round(p.heading, 3),
            "s": round(p.speed, 2),
            "c": p.cargo,
            "sc": p.score,
            "f": p.flip_remaining > 0.0,
            "b": round(p.bump, 2),
        }
        if g.tick_count % 2 == 0:  # other robots update at 10 Hz
            tick["o"] = [
                [q.num, round(q.x, 2), round(q.y, 2), round(q.heading, 3), 0]
                for q in near
            ]
        return out, tick
