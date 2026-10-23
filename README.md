# GemBot 9000 — one mine, one day, up to 100 miners

A shared, procedurally generated mine you drive a little **mining robot** through, in a
browser. Every day is a brand-new world (the date is the seed), the same for everyone, and
up to **100 players** dig in it at once. Whoever **delivers the most gems to the base** by
midnight wins the day.

## Play

```bash
docker compose up --build        # then open http://localhost:8004
```

or, without Docker (needs [uv](https://docs.astral.sh/uv/)):

```bash
uv run uvicorn app.server:app --port 8004 --reload
```

Pick a nickname on the menu and join. The map rotates to follow your heading with a little lag, so the robot swings off "up" while you turn. Steering builds up and eases back instead of snapping.

| Input | Keyboard | Touch |
|---|---|---|
| Drive / turn | ↑ accelerate, ↓ brake, ← → steer (or W A S D) | hold the **left half** to turn left, the **right half** to turn right, **both** to go straight; lift your fingers to brake |
| About-face (180°) | Space | the ↻ button |
| Chat | Enter | the speech-bubble button |
| Players, blocking | Tab | the two-heads button (or tap your score) |
| Rails | R (when parked on a hub) | the panel that appears on a hub |
| Place a hub where you stand | B | the **Place hub** button (shown when you stand still on an empty tile) |
| Zoom | PageUp / PageDown, + / − | |

## The rules

- **Gems.** Drive over one to mine it; it goes into your **cargo** (unlimited) and is gone for
  *everyone* for the rest of the day. They sit in rock faces, get **rarer but richer** with
  distance from the base (`value × (1 + distance/150)`), and ten rare **mega gems** (250 each)
  hide 60–400 tiles out; the radar shows them from far away and mining one is announced.
- **Score.** Cargo only scores once **delivered to the base**: drive into the dashed ring
  around the depot, ride in, or ship it. Undelivered cargo is lost at midnight.
- **Drilling.** Hold forward straight into a wall and your drill bores out the tile in front:
  about 1 s and **1 point of cargo** per tile, or **free but 3 s per tile with no cargo**, so
  nobody is ever stuck (some days start in a sealed pocket, 3-7 drilled tiles from the open
  cave). A drilled tile is floor for **everyone** (and for tracks and hubs) for the rest of
  the day. Releasing forward restarts the tile; the base itself can't be drilled.
- **Rails.** Park on a hub (or the base) and build a **straight track** (any angle, floor
  only, ≤ 60 tiles) to a new or existing hub. A **hub costs 25**, track **1 per tile**, paid
  from your score. Each hub has **one outgoing track** and any number of incoming ones, and
  loops are refused, so every linked hub has exactly one way home. Everything is shared.
  Preview first (green/red line with the cost), then tap again to build.
  You can also **place a hub where you stand** (stand still on an empty tile): you are offered
  the nearest hubs it could lead to (up to 3, only those you can afford with a clear track),
  and picking one builds the hub and its track together. A hub never exists without a track.
- **Using rails.** The network map lets you **ride** to any hub of the same network, in either
  direction (fast), or **ship your cargo** to the base on its own cart.
- **Tolls.** Every hub on your route that someone *else* built costs **1 point of cargo**,
  paid to its builder (start and end included, the base is free). Shipments pay out of
  themselves. **No cargo, no ride.**
- **Rush hour.** In the last hour of the day every gem is worth ×2. At 23:50 everyone is told
  to deliver; at midnight the winner is crowned (👑 until the next midnight) and a fresh mine opens.
- **Chat.** Type a message; it floats above your robot until you change or clear it. **Block**
  someone to hide their bubbles for you (kept in your browser).
- **Names** are unique per day (a taken name becomes `Name#2`) and stay reserved for their owner
  even while away.
- **Staying in.** 10 minutes without input removes you from the mine (warning at 9). Your record
  is kept for the day and rejoining resumes where you were. A dropped connection gets 15 s
  of grace. There is no energy and no game over; robots pass through each other.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GEMBOT_TZ` | `UTC` | time zone whose midnight ends the day (e.g. `Europe/Amsterdam`) |
| `GEMBOT_DB` | `data/gembot.db` | SQLite file (the compose file mounts `./data`) |

State (players, scores, mined gems, hubs, past winners) survives restarts; per-day data older
than a week is pruned, winners are kept forever.

## How it works

```
app/
  grid.py        # terrain: numpy noise + cellular automata, per-chunk gems, mega gems
  player.py      # robot physics (steer, throttle, brake, bounce, drilling), cargo and score parts
  rail.py        # hubs, straight tracks, loop-free routing, tolls (pure logic)
  game.py        # one day: players, mining, delivery, rail actions, carts, rush hour, board
  connection.py  # per-client protocol: what each client is sent, and how input is applied
  store.py       # SQLite persistence; the game process is the only writer
  server.py      # FastAPI + websockets, one global 20 Hz loop, day rollover
  static/        # the client: util, art, world, net, hud, touch, main, ui (+ index.html, style.css)
scripts/
  loadtest.py    # N bots against a real server: tick time, bandwidth, CPU
  smoke.cjs      # headless browsers: two players, chat, block, touch steering, rail UI
  mockups/       # renders the art (robots, hubs, tracks, base, carts) for review
  validate.py    # layout checks for the three generators
  preview.py     # render a region of a world to a PNG
tests/           # pytest: terrain, game rules, protocol, rail, store, websockets
```

- **Terrain** is a pure function of `(seed, chunk_x, chunk_y)`: fractal value noise thresholded
  and smoothed by cellular automata, ~2 ms per 33×33 chunk, identical on every run (golden
  hashes in `tests/` pin it to the original pure-Python generator). Chunks stream to each
  client once; only mined-gem changes and moving things are sent afterwards.
- **One loop, many sockets.** A single 20 Hz tick advances everything. Your own pose goes out
  20×/s, other robots 10×/s (shared pre-formatted rows, clients staggered across ticks). Each
  socket has its own writer task, so a slow client is dropped rather than slowing anyone else.
- **Persistence.** Memory is the source of truth; changes are snapshotted every 5 s and written in
  one transaction from a worker thread. Players never touch the database.

### Measured (100 bots driving around the base, one machine)

| | |
|---|---|
| tick loop | **p50 5 ms, p95 8 ms** (budget 50 ms) |
| per client | ~22 KB/s raw JSON, ~11 KB/s after compression |
| all 100 clients | ~18 Mbit/s raw, ~9 Mbit/s compressed (the worst case: everybody in view of everybody) |
| server CPU | ~40% of one core |

Reproduce with `PYTHONPATH=. uv run python scripts/loadtest.py --bots 100 --seconds 30`.

## Development

```bash
uv run pytest                                  # unit, protocol and websocket tests
ruff check . && ruff format --check .          # lint and format
uvx ty check                                   # types
PYTHONPATH=. uv run python scripts/validate.py # generator constraints
NODE_PATH=/opt/node22/lib/node_modules node scripts/smoke.cjs   # headless-browser smoke test
```

Docker without compose:

```bash
docker build -t gembot . && docker run --rm -p 8004:8000 -v "$PWD/data:/app/data" gembot
```
