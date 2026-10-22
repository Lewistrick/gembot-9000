"""Persistence: SQLite, with the game process as its only writer.

Memory is the source of truth. Every few seconds the server takes a snapshot of
what changed (:meth:`Store.snapshot`, in the event loop, so it is consistent) and
writes it in a single transaction (:meth:`Store.write`, in a worker thread).
Players never touch the database, so SQLite's single-writer limit does not apply.
On startup :meth:`Store.load_into` restores today's players, mined gems and rail.
"""

import logging
import sqlite3
import threading

from .game import Game

log = logging.getLogger("gembot.store")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    day TEXT NOT NULL, pid TEXT NOT NULL, num INTEGER NOT NULL, name TEXT NOT NULL,
    delivered INTEGER NOT NULL, spent INTEGER NOT NULL, toll_income INTEGER NOT NULL,
    cargo INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, chat TEXT NOT NULL,
    PRIMARY KEY (day, pid)
);
CREATE TABLE IF NOT EXISTS mined (
    day TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
    PRIMARY KEY (day, x, y)
);
CREATE TABLE IF NOT EXISTS hubs (
    day TEXT NOT NULL, id INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
    builder TEXT NOT NULL, out INTEGER,
    PRIMARY KEY (day, id)
);
CREATE TABLE IF NOT EXISTS winners (
    day TEXT PRIMARY KEY, pid TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL
);
"""


class Store:
    """SQLite persistence for one game server."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(_SCHEMA)
        self._lock = threading.Lock()  # one writer at a time (snapshot bookkeeping too)
        self._saved_players: dict[str, tuple] = {}
        self._mined_saved = 0
        self._hubs_saved: dict[int, tuple] = {}

    def close(self) -> None:
        self.db.close()

    # ------------------------------------------------------------------ #
    # Saving
    # ------------------------------------------------------------------ #
    def snapshot(self, game: Game) -> dict:
        """What changed since the last successful write (call from the game loop)."""
        with self._lock:
            players = {}
            for p in game.players.values():
                row = (
                    p.num,
                    p.name,
                    p.delivered,
                    p.spent,
                    p.toll_income,
                    p.cargo,
                    round(p.x, 1),
                    round(p.y, 1),
                    p.chat,
                )
                if self._saved_players.get(p.pid) != row:
                    players[p.pid] = row
            hubs = {}
            rail = getattr(game, "rail", None)
            if rail is not None:
                for h in rail.hubs.values():
                    row = (h.x, h.y, h.builder, h.out)
                    if self._hubs_saved.get(h.id) != row:
                        hubs[h.id] = row
            return {
                "day": game.day,
                "players": players,
                "mined": list(game.mined_log[self._mined_saved :]),
                "mined_upto": len(game.mined_log),
                "hubs": hubs,
            }

    def write(self, snap: dict) -> None:
        """Write a snapshot in one transaction (safe to call from a worker thread)."""
        day = snap["day"]
        with self._lock, self.db:
            self.db.executemany(
                "INSERT OR REPLACE INTO players VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(day, pid, *row) for pid, row in snap["players"].items()],
            )
            self.db.executemany(
                "INSERT OR IGNORE INTO mined VALUES (?,?,?)",
                [(day, x, y) for x, y in snap["mined"]],
            )
            self.db.executemany(
                "INSERT OR REPLACE INTO hubs VALUES (?,?,?,?,?,?)",
                [(day, hid, *row) for hid, row in snap["hubs"].items()],
            )
            self._saved_players.update(snap["players"])
            self._mined_saved = max(self._mined_saved, snap["mined_upto"])
            self._hubs_saved.update(snap["hubs"])

    def flush(self, game: Game) -> None:
        """Snapshot and write in one go (shutdown and tests)."""
        self.write(self.snapshot(game))

    # ------------------------------------------------------------------ #
    # Loading
    # ------------------------------------------------------------------ #
    def load_into(self, game: Game) -> None:
        """Restore a day's saved players, mined gems and rail into a fresh game."""
        day = game.day
        with self._lock:
            for row in self.db.execute(
                "SELECT pid, num, name, delivered, spent, toll_income, cargo, x, y, chat"
                " FROM players WHERE day = ? ORDER BY num",
                (day,),
            ):
                pid, num, name, delivered, spent, toll, cargo, x, y, chat = row
                game.restore_player(
                    {
                        "pid": pid,
                        "num": num,
                        "name": name,
                        "delivered": delivered,
                        "spent": spent,
                        "toll_income": toll,
                        "cargo": cargo,
                        "x": x,
                        "y": y,
                        "chat": chat,
                    }
                )
                self._saved_players[pid] = (
                    num,
                    name,
                    delivered,
                    spent,
                    toll,
                    cargo,
                    round(x, 1),
                    round(y, 1),
                    chat,
                )
            cells = [
                (x, y)
                for x, y in self.db.execute(
                    "SELECT x, y FROM mined WHERE day = ?", (day,)
                )
            ]
            game.restore_mined(cells)
            self._mined_saved = len(game.mined_log)
            rail = getattr(game, "rail", None)
            if rail is not None:
                rows = self.db.execute(
                    "SELECT id, x, y, builder, out FROM hubs WHERE day = ? ORDER BY id",
                    (day,),
                ).fetchall()
                rail.restore(rows)
                self._hubs_saved = {hid: (x, y, b, o) for hid, x, y, b, o in rows}
        game.refresh_board()

    def reset_bookkeeping(self) -> None:
        """Forget what was saved (a new day starts with an empty slate)."""
        with self._lock:
            self._saved_players.clear()
            self._mined_saved = 0
            self._hubs_saved.clear()

    # ------------------------------------------------------------------ #
    # Winners (the hall of fame)
    # ------------------------------------------------------------------ #
    def record_winner(self, day: str, pid: str, name: str, score: int) -> None:
        with self._lock, self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO winners VALUES (?,?,?,?)",
                (day, pid, name, score),
            )

    def winners(self, limit: int = 10) -> list[dict]:
        with self._lock:
            rows = self.db.execute(
                "SELECT day, pid, name, score FROM winners ORDER BY day DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [{"day": d, "pid": p, "name": n, "score": s} for d, p, n, s in rows]

    def last_winner_before(self, day: str) -> str | None:
        """Pid of the most recent winner from a day before ``day`` (wears the crown)."""
        with self._lock:
            row = self.db.execute(
                "SELECT pid FROM winners WHERE day < ? ORDER BY day DESC LIMIT 1",
                (day,),
            ).fetchone()
        return row[0] if row else None

    def close_out_past_days(self, today: str) -> None:
        """Crown winners for finished days that were never recorded (server was down).

        Score is ``delivered + toll_income - spent``, the same as the live board.
        """
        with self._lock:
            days = [
                d
                for (d,) in self.db.execute(
                    "SELECT DISTINCT day FROM players WHERE day < ? AND day NOT IN"
                    " (SELECT day FROM winners)",
                    (today,),
                )
            ]
            for day in days:
                row = self.db.execute(
                    "SELECT pid, name, delivered + toll_income - spent AS s FROM players"
                    " WHERE day = ? ORDER BY s DESC, num ASC LIMIT 1",
                    (day,),
                ).fetchone()
                if row and row[2] > 0:
                    with self.db:
                        self.db.execute(
                            "INSERT OR REPLACE INTO winners VALUES (?,?,?,?)",
                            (day, row[0], row[1], row[2]),
                        )

    def prune(self, today: str, keep_days: int = 7) -> None:
        """Delete old per-day data (winners are kept forever)."""
        with self._lock, self.db:
            old = [
                d
                for (d,) in self.db.execute(
                    "SELECT DISTINCT day FROM players WHERE day < ? ORDER BY day DESC",
                    (today,),
                )
            ][keep_days:]
            for day in old:
                for table in ("players", "mined", "hubs"):
                    self.db.execute(f"DELETE FROM {table} WHERE day = ?", (day,))
