"""Load test: N bots join a real server, drive around at random, and chat.

Reports the server's tick-loop time (p50 / p95 / max, from /api/status), the
bandwidth each client receives, the total upload, and the server's CPU use.
Bandwidth is shown raw (plain JSON) and estimated after compression: uvicorn
enables per-message deflate, which JSON like this shrinks several times over.

Run (starts its own throw-away server):
    uv run python scripts/loadtest.py --bots 100 --seconds 30
Or against a running one:
    uv run python scripts/loadtest.py --url http://localhost:8004 --no-spawn
"""

import argparse
import asyncio
import json
import os
import random
import resource
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib
from dataclasses import dataclass, field

import websockets


@dataclass
class Stats:
    raw: int = 0
    deflated: int = 0
    messages: int = 0
    joined: int = 0
    full: int = 0
    errors: int = 0
    kinds: dict[str, int] = field(default_factory=dict)


async def bot(i: int, ws_url: str, stats: Stats, stop: asyncio.Event) -> None:
    rng = random.Random(i)
    token = f"loadtest-bot-{i:05d}-padding"
    try:
        async with websockets.connect(
            f"{ws_url}/ws?token={token}", max_size=None
        ) as ws:
            await ws.send(json.dumps({"action": "join", "name": f"Bot{i}"}))
            await ws.send(json.dumps({"action": "resize", "cols": 51, "rows": 51}))

            async def drive() -> None:
                while not stop.is_set():
                    turn = rng.choice(["left", "right", None, None])
                    ctl = {"action": "controls", "up": True}
                    if turn:
                        ctl[turn] = True
                    await ws.send(json.dumps(ctl))
                    if rng.random() < 0.08:
                        await ws.send(
                            json.dumps(
                                {
                                    "action": "chat",
                                    "text": f"bot {i} says hi {rng.randint(0, 99)}",
                                }
                            )
                        )
                    if rng.random() < 0.05:
                        await ws.send(json.dumps({"action": "flip"}))
                    await asyncio.sleep(rng.uniform(0.4, 1.6))

            driver = asyncio.create_task(drive())
            try:
                while not stop.is_set():
                    try:
                        text = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    except TimeoutError:
                        continue
                    data = text.encode() if isinstance(text, str) else text
                    stats.raw += len(data)
                    stats.deflated += len(zlib.compress(data, 3))
                    stats.messages += 1
                    for m in json.loads(data):
                        stats.kinds[m["t"]] = stats.kinds.get(m["t"], 0) + 1
                        if m["t"] == "welcome":
                            stats.joined += 1
                        elif m["t"] == "full":
                            stats.full += 1
            finally:
                driver.cancel()
    except OSError, websockets.WebSocketException, ValueError:
        stats.errors += 1


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get_status(http_url: str) -> dict:
    with urllib.request.urlopen(f"{http_url}/api/status", timeout=5) as r:
        return json.load(r)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bots", type=int, default=100)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--url", default="")
    ap.add_argument("--no-spawn", action="store_true")
    args = ap.parse_args()

    server = None
    if args.no_spawn:
        http_url = args.url or "http://localhost:8000"
    else:
        port = free_port()
        http_url = f"http://127.0.0.1:{port}"
        env = dict(
            os.environ,
            GEMBOT_DB=os.path.join(tempfile.mkdtemp(), "load.db"),
            PYTHONDONTWRITEBYTECODE="1",
        )
        cmd = [sys.executable, "-m", "uvicorn", "app.server:app", "--port", str(port)]
        cmd += ["--ws-max-size", "65536", "--log-level", "warning"]
        server = await asyncio.to_thread(subprocess.Popen, cmd, env=env)
        for _ in range(80):
            try:
                get_status(http_url)
                break
            except OSError:
                await asyncio.sleep(0.25)
    ws_url = http_url.replace("http", "ws", 1)

    stats, stop = Stats(), asyncio.Event()
    cpu0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.monotonic()
    tasks = []
    for i in range(args.bots):  # stagger the joins a little, like real arrivals
        tasks.append(asyncio.create_task(bot(i, ws_url, stats, stop)))
        await asyncio.sleep(0.02)
    settle = 5.0  # let chunk streaming and joining settle before measuring
    await asyncio.sleep(settle)
    stats_start = (stats.raw, stats.deflated)
    t_measure = time.monotonic()
    await asyncio.sleep(args.seconds)
    elapsed = time.monotonic() - t_measure
    status = get_status(http_url)
    steady_raw, steady_def = stats.raw - stats_start[0], stats.deflated - stats_start[1]
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    wall = time.monotonic() - t0

    cpu = None
    if server is not None:
        server.terminate()
        server.wait(timeout=10)
        r = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu = (r.ru_utime + r.ru_stime) - (cpu0.ru_utime + cpu0.ru_stime)

    n = max(1, stats.joined)
    print(
        f"bots asked for: {args.bots}   joined: {stats.joined}   server-full: {stats.full}   errors: {stats.errors}"
    )
    print(f"online (server view): {status['online']} / {status['cap']}")
    print(
        f"tick loop ms:  p50={status['perf']['p50']}  p95={status['perf']['p95']}  max={status['perf']['max']}   (budget: 50 ms per tick)"
    )
    print(f"per client (steady state, {elapsed:.0f}s window):")
    print(f"  raw JSON         {steady_raw / elapsed / n / 1024:7.1f} KB/s")
    print(f"  ~deflated        {steady_def / elapsed / n / 1024:7.1f} KB/s")
    print("server upload (all clients):")
    print(f"  raw JSON         {steady_raw / elapsed * 8 / 1e6:7.2f} Mbit/s")
    print(f"  ~deflated        {steady_def / elapsed * 8 / 1e6:7.2f} Mbit/s")
    if cpu is not None:
        print(
            f"server CPU: {cpu:.1f} s over {wall:.0f} s wall  (~{100 * cpu / wall:.0f}% of one core, includes startup)"
        )
    top = sorted(stats.kinds.items(), key=lambda kv: -kv[1])[:6]
    print("most frequent messages:", ", ".join(f"{k}={v}" for k, v in top))
    ok = stats.joined >= min(args.bots, 100) and status["perf"]["p95"] < 25
    print("RESULT:", "OK (p95 under 25 ms)" if ok else "SLOW or incomplete")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
