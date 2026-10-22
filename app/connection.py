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
* ``hubs``     rail hubs (all of them on join, then any new or re-linked ones)
* ``board``    top of the daily leaderboard, your rank, online count, palette
* ``announce`` game-wide text; ``gain`` / ``delivered`` / ``warn`` / ``kicked``
  ``toll`` / ``rail`` (a message for a toast) / ``quote`` (build preview) /
  ``net`` (the network map) are private notices
"""

import base64
import json
import math

from .game import MAX_PLAYERS, Game, Row
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


def dump_tick(tick: dict) -> str:
    """JSON for a tick message, splicing in the robots' pre-formatted row text."""
    rows = tick.get("o")
    if not rows or not isinstance(rows[0], Row):
        return json.dumps(tick, separators=(",", ":"))
    rest = {k: v for k, v in tick.items() if k != "o"}
    head = json.dumps(rest, separators=(",", ":"))
    return head[:-1] + ',"o":[' + ",".join(r.js for r in rows) + "]}"


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
        self.hub_cursor = -1  # -1: the full hub list has not been sent yet
        self.phase = player.num % 2  # half the clients update robots on odd ticks
        self._want: tuple[int, int, int, int] | None = None
        self._starved = False  # chunks still owed (ran out of this tick's budget)
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
        elif action == "build_hub":
            g.build_hub(pid)
        elif action == "build_track":
            try:
                x, y = int(msg["x"]), int(msg["y"])
            except KeyError, TypeError, ValueError:
                return
            g.build_track(pid, x, y, _flag(msg, "confirm"))
        elif action == "netmap":
            g.net_map(pid)
        elif action == "ride":
            try:
                g.ride(pid, int(msg["to"]))
            except KeyError, TypeError, ValueError:
                return
        elif action == "send_cargo":
            g.send_cargo(pid)

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

    def _hub_row(self, hid: int) -> list:
        """``[id, x, y, builder_num, out]`` (out is -1 when the hub has no track)."""
        h = self.game.rail.hubs[hid]
        builder = self.game.players.get(h.builder or "")
        return [
            h.id,
            h.x,
            h.y,
            builder.num if builder else 0,
            -1 if h.out is None else h.out,
        ]

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
        want = self._chunk_range(CHUNK_MARGIN)
        if want != self._want or self._starved:  # only re-plan when we moved chunks
            self._want = want
            cx0, cx1, cy0, cy1 = want
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
            self._starved = False
            for key in need:
                if chunk_budget[0] <= 0:
                    self._starved = True
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

        # -- rail ------------------------------------------------------------ #
        log = g.rail.log
        if self.hub_cursor < 0:
            touched = [h for h in g.rail.hubs if h != 0]
        else:
            touched = sorted(set(log[self.hub_cursor :]))
        self.hub_cursor = len(log)
        if touched:
            out.append({"t": "hubs", "list": [self._hub_row(h) for h in touched]})

        # -- robots in view (on this client's update ticks only) ------------- #
        hw, hh = self.cols / 2 + NEAR_PAD, self.rows / 2 + NEAR_PAD
        update = (g.tick_count + self.phase) % 2 == 0
        near: list[Player] = []
        if update:
            px, py = p.x, p.y
            near = [
                q
                for q in g.present
                if q is not p and -hw <= q.x - px <= hw and -hh <= q.y - py <= hh
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
                            "crown": q.pid == g.crown_pid,
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
                    "left": g.day_left,
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
            "r": 1 if p.ride else 0,
        }
        if update:  # other robots update at 10 Hz
            tick["o"] = [g.row(q) for q in near]
            tick["k"] = [
                [c.id, round(c.x, 2), round(c.y, 2), round(c.angle, 3)]
                for c in g.carts
                if abs(c.x - p.x) <= hw and abs(c.y - p.y) <= hh
            ]
        return out, tick
