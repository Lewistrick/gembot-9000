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

Pick a nickname on the menu and join. The map rotates to follow your heading with a little lag, so the robot swings off "up" while you turn. Steering builds up and eases back instead of snapping, and the turn rate falls with speed: sharp at a crawl (3.2 rad/s), wide at top speed (1.6 rad/s, a turn radius of about 9 tiles).

| Input | Keyboard | Touch |
|---|---|---|
| Drive / turn | ↑ accelerate, ↓ brake, ← → steer (or W A S D) | hold the **left half** to turn left, the **right half** to turn right, **both** to go straight; lift your fingers to brake |
| About-face (180°) | Space | the ↻ button |
| Chat | Enter, or click your own robot | tap your own robot |
| Block someone | click their robot, then Block | tap their robot, then Block (Tab or your score lists nearby players) |
| Ship gems / travel (parked on a hub) | G / T | the **SHIP** and **TRAVEL** buttons that appear beside ↻ when you park on a hub; TRAVEL toggles travel mode, then tap a track to ride it |
| Place a hub where you stand | B | the **HUB** button beside ↻ (only shown if you could pay for one; lit when you stand still on an empty tile) |
| Lens / minimap / big map | the 🔍 and map buttons beside the menu button; **tap the minimap** (or press M) for the big map: the minimap fullscreen, north up, with floor, rock, gems, hubs and tracks within 150 tiles of a hub or the base (the rest is black), the base and you blinking; drag to pan, scroll/pinch to zoom, ✕ or Esc to leave | the same buttons, tap the minimap |
| Zoom | PageUp / PageDown, + / − (kept for the browser session, like the big map's zoom) | |

## The rules

- **Colours.** Each day has three biomes, each a different hand-made theme (copper mine, emerald
  cave, ice cavern, lava, desert sandstone, amethyst, coal and gold, coral reef, jungle, glacier
  night) a little varied by the date: within 250 tiles of the base, 250-600, and beyond. Each
  tile shows the biome of its own position; at each edge a ridge 100 tiles wide mixes single tiles of
  the two biomes, gradually going from one to the other.
- **Gems.** Drive over one to mine it (a gem icon and its value float up from your robot); it goes into your **cargo** (at most **500**: a full robot leaves gems where they are, so bank or ship
  it) and is gone for
  *everyone* for the rest of the day. They sit in rock faces: common within 250 tiles of the base, **sparse** beyond (about one per
  150×150 tiles, mostly 100-200 tiles apart), and **richer** with distance from the base (`value × (1 + distance/150)`), and ten rare **mega gems** (250 each)
  hide 60–400 tiles out; they glow amber on the minimap (which also draws hubs, rails and the base) and mining one is announced.
- **Score.** Cargo only scores once **delivered to the base**: drive into the dashed ring
  around the depot, ride in, or ship it. Undelivered cargo is lost at midnight. Banking (driving in or by rail) floats the amount (`+57`)
  up from your robot in the gems' colour; your score pane **blinks** when tolls come in.
- **Crashes.** Hitting a wall hard shakes gems out of your cargo and they are lost: nothing below
  20% of top speed, rising to **10** at top speed (the into-wall part of the speed counts, so a glancing
  scrape costs little). Only a fresh hit counts: leaning on a wall or drilling on is free. A small
  pop-up shows the loss while the gems scatter.
- **Corners.** Two rocks that touch at a corner are a wall: robots can't squeeze diagonally between
  them (hold forward into the corner to drill one of them).
- **Drilling.** Hold forward straight into a wall and your drill bores out the tile in front:
  about 1 s and **1 point of cargo** per tile, or **free but 3 s per tile with no cargo**, so
  nobody is ever stuck (some days start in a sealed pocket, 3-7 drilled tiles from the open
  cave). A drilled tile is floor for **everyone** (and for tracks and hubs) for the rest of
  the day. Releasing forward restarts the tile; the base itself can't be drilled. One drilled rock
  in 100 hides a gem, valued like the gems lying at that distance (`10-40 × (1 + distance/150)`).
- **Rails.** A hub costs **25** and a track **1 per tile** (straight, any angle, floor only,
  ≤ 60 tiles). Each hub has **one outgoing track** and any number of incoming ones, and loops
  are refused, so every linked hub has exactly one way home. Everything is shared.
  To place a hub, stand still on an empty tile and press **HUB** (only shown if you could pay):
  the tracks it could get are drawn as **transparent tracks** to the nearest hubs. Each carries a small
  clickable box (`length: 20m` / `cost: 45` with a gem), placed on the visible part of its track and
  nudged along it (or sideways, with a leader line) so boxes never overlap. Tapping a track or its box
  builds the hub with that track (the cost then floats up from your robot as `−45`); tapping anywhere
  else cancels. Paying part of it from score is asked about afterwards, not shown here. With only one
  possible track nothing needs picking: it is just built. A hub never exists without a track.
- **Hub menu.** Parked on a hub (or the base) you can only **ship** your gems to the base on their
  own cart (the SHIP button shows the tolls it would pay on the way, so you can drive it home
  yourself instead) or switch on **travel mode**, which also turns steering off and stays on until you press TRAVEL again (or drive away
  from the hubs), and tapping a track leaving your hub rides along it, hop after hop.
- **Light.** Away from hubs it gets dark: from **100** tiles to the closest hub (the base counts) the
  screen darkens, at **150** a small notice says it is getting dark, at **250** it is pitch black and you are told that hubs are needed for light, and at
  **350** you are *lost*: sent back to the base with **half your cargo** (rounded down, the rest is
  delivered). Build hubs to push the dark back. Riding the rails is never dark-checked.
- **Paying is cargo-first.** Hubs, tracks and tolls come out of your cargo; if it falls short you
  are asked whether to pay the missing part from your banked score, and nothing is taken from
  your score without a yes. Without enough cargo plus score the action is refused.
- **Tolls.** Each hub on your hop that someone *else* built (either end; the base is free) costs
  **1**, paid to its builder. A shipment pays its tolls out of itself.
- **Rush hour.** In the last hour of the day every gem is worth ×2. At 23:50 everyone is told
  to deliver; at midnight the winner is crowned (👑 until the next midnight) and a fresh mine opens.
- **Chat.** Type a message; it floats above your robot until you change or clear it. **Block**
  someone to hide their bubbles for you (kept in your browser).
- **Following.** Tap another robot (or use the players list) and choose **Follow**: a black arrow
  with a stripe in their colour then points at them wherever they are, like the lens arrows (with or
  without the lens). You follow one player at a time; they are told. Players without input for 5
  minutes are inactive and can't be followed, and following stops when they go inactive or leave.
- **Names** are unique per day (a taken name becomes `Name#2`) and stay reserved for their owner
  even while away.
- **Staying in.** While more than 10 players are in the mine, 10 minutes without input removes you
  (warning at 9); with 10 or fewer nobody is removed for idling, and when it fills up a long-idle
  player gets the warning first. Your record
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
  static/        # the client: util, art, world, net, hud, touch, main, howto, ui (+ index.html, style.css)
  static/howto/  # screenshots + marker positions for the How to Play slideshow (generated)
scripts/
  loadtest.py    # N bots against a real server: tick time, bandwidth, CPU
  smoke.cjs      # headless browsers: two players, chat, block, touch steering, rail UI, slideshow
  howto_shots.cjs  # regenerates the How to Play pictures (needs howto_server.py: a real server on a fixed day)
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
NODE_PATH=/opt/node22/lib/node_modules node scripts/howto_shots.cjs   # redo the How to Play pictures after the art or HUD changes
scripts/reset-day.sh                           # wipe today's board (backs up the DB first); -n previews, -y skips the prompt
```

Docker without compose:

```bash
docker build -t gembot . && docker run --rm -p 8004:8000 -v "$PWD/data:/app/data" gembot
```
