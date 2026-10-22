"""FastAPI server for GemBot 9000: one shared world per day, up to 100 players.

A single global 20 Hz loop advances the :class:`~app.game.Game` and pushes each
connected player their messages (built by :class:`~app.connection.Connection`).
Each socket has its own writer task, so one slow client can never stall the loop:
reliable messages queue up (and the client is dropped if it falls far behind)
while the volatile ``tick`` message is simply overwritten.
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import time
from collections import deque
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .connection import Connection
from .game import MAX_PLAYERS, Game
from .player import TICK

log = logging.getLogger("gembot")

_STATIC = Path(__file__).parent / "static"
_CHUNK_BUDGET = 12  # new chunks generated per tick across all players (~2 ms each)
_MAX_BACKLOG = 400  # queued reliable messages before a slow client is dropped
_MAX_MSG_LEN = 2048  # bytes; client messages are tiny
_MAX_MSGS_PER_SEC = 120  # per-socket flood limit


def today() -> str:
    """Today's date (in ``GEMBOT_TZ``, default UTC) as an ISO string: the world seed."""
    tz = ZoneInfo(os.environ.get("GEMBOT_TZ") or "UTC")
    return datetime.now(UTC).astimezone(tz).date().isoformat()


def _dump(obj: object) -> str:
    return json.dumps(obj, separators=(",", ":"))


class Link:
    """One live websocket: its protocol state, outbox and writer task."""

    def __init__(self, sock: WebSocket, conn: Connection) -> None:
        self.sock = sock
        self.conn = conn
        self.pending: list[str] = []  # reliable messages, already serialised
        self.latest: str | None = None  # newest volatile tick (older ones dropped)
        self.wake = asyncio.Event()
        self.closing = False
        self.slow = False

    def push(self, reliable: list[dict], tick: dict | None) -> None:
        self.pending.extend(_dump(m) for m in reliable)
        if len(self.pending) > _MAX_BACKLOG:
            self.slow, self.closing = True, True
        if tick is not None:
            self.latest = _dump(tick)
        self.wake.set()

    def finish(self) -> None:
        """Flush what is queued, then close the socket."""
        self.closing = True
        self.wake.set()

    async def writer(self) -> None:
        with contextlib.suppress(WebSocketDisconnect, RuntimeError):
            while True:
                await self.wake.wait()
                self.wake.clear()
                batch, self.pending = self.pending, []
                if self.latest is not None:
                    batch.append(self.latest)
                    self.latest = None
                if self.slow:
                    break
                if batch:
                    await self.sock.send_text("[" + ",".join(batch) + "]")
                if self.closing:
                    break
            await self.sock.close()


class Hub:
    """Owns the game, the live links and the global tick loop."""

    def __init__(self) -> None:
        self.game = Game(today())
        self.links: dict[str, Link] = {}
        self.tick_ms: deque[float] = deque(maxlen=400)

    def step(self) -> None:
        """One game tick plus one outgoing frame per connection."""
        self.game.tick()
        budget = [_CHUNK_BUDGET]
        links = list(self.links.values())
        if links:  # rotate the start so nobody is always first in line for chunks
            k = self.game.tick_count % len(links)
            links = links[k:] + links[:k]
        for link in links:
            reliable, tick = link.conn.frame(budget)
            link.push(reliable, tick)
            if not link.conn.player.in_world:
                link.finish()

    async def run(self) -> None:
        next_t = time.perf_counter()
        while True:
            t0 = time.perf_counter()
            try:
                self.step()
            except Exception:  # one bad tick must never kill the game
                log.exception("tick failed")
            now = time.perf_counter()
            self.tick_ms.append((now - t0) * 1000.0)
            next_t += TICK
            if next_t < now - 1.0:  # badly behind: resync instead of bursting
                next_t = now
            await asyncio.sleep(max(0.0, next_t - now))

    def perf(self) -> dict:
        ms = sorted(self.tick_ms)
        if not ms:
            return {"p50": 0.0, "p95": 0.0, "max": 0.0}
        return {
            "p50": round(ms[len(ms) // 2], 2),
            "p95": round(ms[int(len(ms) * 0.95)], 2),
            "max": round(ms[-1], 2),
        }


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    hub = Hub()
    app.state.hub = hub
    task = asyncio.create_task(hub.run())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="GemBot 9000", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=_STATIC), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return (_STATIC / "index.html").read_text(encoding="utf-8")


@app.get("/api/status")
async def status() -> dict:
    hub: Hub = app.state.hub
    game = hub.game
    return {
        "day": game.day,
        "online": game.online_count(),
        "cap": MAX_PLAYERS,
        "top": game.board_rows(5),
        "perf": hub.perf(),
    }


@app.websocket("/ws")
async def ws(sock: WebSocket) -> None:
    hub: Hub = app.state.hub
    token = sock.query_params.get("token") or ""
    await sock.accept()
    if not 8 <= len(token) <= 64:
        await sock.close(code=1008)
        return
    pid = hashlib.sha256(token.encode()).hexdigest()[:10]
    link: Link | None = None
    writer: asyncio.Task | None = None
    try:
        # The first message must be {"action": "join", "name": ...}.
        first = json.loads(await asyncio.wait_for(sock.receive_text(), timeout=10))
        if not isinstance(first, dict) or first.get("action") != "join":
            await sock.close(code=1008)
            return
        player = hub.game.join(pid, str(first.get("name") or ""))
        if player is None:
            await sock.send_text(
                _dump(
                    [
                        {
                            "t": "full",
                            "online": hub.game.online_count(),
                            "cap": MAX_PLAYERS,
                        }
                    ]
                )
            )
            await sock.close()
            return
        old = hub.links.pop(pid, None)
        if old is not None:  # same browser opened a second tab: the newer one wins
            old.push([{"t": "kicked", "why": "replaced"}], None)
            old.finish()
        conn = Connection(hub.game, player)
        link = Link(sock, conn)
        hub.links[pid] = link
        link.push([conn.welcome()], None)
        writer = asyncio.create_task(link.writer())

        window_start, count = time.monotonic(), 0
        while not link.closing:
            text = await sock.receive_text()
            now = time.monotonic()
            if now - window_start >= 1.0:
                window_start, count = now, 0
            count += 1
            if count > _MAX_MSGS_PER_SEC or len(text) > _MAX_MSG_LEN:
                continue
            try:
                msg = json.loads(text)
            except ValueError:
                continue
            if isinstance(msg, dict):
                conn.handle(msg)
    except WebSocketDisconnect, RuntimeError, TimeoutError, ValueError:
        pass
    finally:
        if link is not None and hub.links.get(pid) is link:
            del hub.links[pid]
            hub.game.leave(pid)
        if writer is not None:
            writer.cancel()
