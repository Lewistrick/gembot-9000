# GemBot 9000 — infinite grid

An infinite, procedurally-generated mining grid you can walk around in a
browser. Two tile kinds: **floor** (walkable, a light tint) and **rock**
(obstacle, a dark tint). The world is generated per-day from a seed and computed
lazily one 33×33 chunk at a time. The default **Dungeon** layout is dense, organic
terrain — thick irregular rock masses with winding floor chambers.

## Run it

```bash
docker compose up --build
```

Then open <http://localhost:8004>. You drive a little **mining robot** (always
facing up) and **the map rotates to your heading**:

- **↑ accelerate**, **↓ brake**, **← / → steer** — steering is gentler at a crawl
  and firmer at speed. Release the throttle and you coast to a stop; glancing a
  rock makes you scrape along it, and slamming one **bounces** you off.
- **Space** (or the on-screen ↻ button) triggers a smooth 180° **about-face**.
- **PageUp / PageDown** zoom the map in and out.

The floor and rock each get their own seed-picked colour (floor always light, rock
always dark), with a grainy sand texture on the floor and veined stone on the rock
whose exposed corners are gently rounded.

You always start in a clear **10-tile-radius spawn area** at the origin, and the
world's hue drifts very slowly the further you travel from the centre.

Scattered around are glowing **gems** — crystalline rock embedded in the wall
faces (they only form on floor tiles that touch a rock). They're common near the
origin and grow rarer with distance, and each is worth 10–40 points (the more it's
worth, the brighter it glows). Drive over one to mine it: it's added to your score,
tops up your energy, and leaves behind a little rubble of gem- and rock-coloured
pebbles. Mined gems stay mined for the rest of the run, even after their chunk
scrolls away and back.

Keeping the lights on costs **energy** (the battery gauge, bottom-right, runs a
green → yellow → red gradient from full to empty). It drains slowly even when
you're parked and faster while you're accelerating, takes a bigger hit when you
slam into a rock (the harder and more head-on the impact, the more it costs — and
you **bounce** off it), and is replenished by mining gems (each gem restores its
value times a factor, so richer gems recharge you more). When it reaches zero the
run ends on a **game-over** screen showing your final score, where you can play
again or return to the menu. The idle drain, acceleration drain, hit-cost and
gem-gain factor are all tunable knobs (`DRAIN_ENERGY_LOSS`, `DRAIN_ACCEL_LOSS`,
`HIT_ENERGY_LOSS`, `GEM_ENERGY_GAIN` in `app/server.py`).

The rest of the dashboard is drawn on the canvas. The **compass** up top also acts
as a **radar**: uncollected gems within range show up as colour-coded blips
(bigger and brighter the closer they are), and a **house marker** points back to
the origin — handy, since gems are densest near the centre. Your **score** and
**distance** are top-right, with an analog **speedometer** and an **about-face**
button along the bottom. Tap the **☰** button (top-left) to pause, which opens an
overlay to resume, restart the run from the origin, return to the main menu, or
read How to Play.

Everything starts at the **main menu**, where you:

- pick a **day** with the ◄ / ► steppers — every date is its own world (different
  layout *and* colour scheme);
- choose a **mode** — *Dungeon* (default: dense, organic caverns), *Caves*
  (sparse, open floor), or *Aisles* (a maze of 1-wide corridors — regular grid);
- see your **high score** for the selected day + mode (kept in your browser);
- press **Play**, or open **How to Play** for the full rundown.

Prefer plain Docker?

```bash
docker build -t gembot .
docker run --rm -p 8004:8000 gembot
```

Or run it locally without Docker (needs [uv](https://docs.astral.sh/uv/)):

```bash
uv run uvicorn app.server:app --port 8004 --reload
```

(The container listens on 8000 internally; both Docker commands publish it on
host port **8004**.)

## How the world is generated

Almost everything runs in Python (`app/grid.py`, `app/server.py`). The vehicle
physics — heading, speed, acceleration, braking, drag, steering and collision —
all live server-side: a fixed 20 Hz tick loop integrates the motion and streams a
square viewport plus the exact float pose over a WebSocket. The browser is a thin
client that sends which keys are held, then rotates the canvas to the player's
heading and interpolates the camera (position and angle) between ticks, so motion
stays fluid regardless of key-repeat timing. Chunks are cached with **LRU eviction
bounded to the viewport**, so off-screen chunks are dropped from memory and
regenerated if you return.

Each **33×33 chunk** is a *pure function* of `(seed, chunk_x, chunk_y, style)`, so
a cell can be produced on demand and always looks the same. Three layout styles
are available:

- **Dungeon (default, dense & organic).** **Fractal value noise** (Perlin-style)
  thresholds an initial field, then **cellular automata** smooths it into thick,
  irregular rock masses with winding floor chambers (~47% rock). The CA runs
  over the chunk *plus an apron* sampled from neighbours' noise, so terrain flows
  seamlessly across chunk borders with no shared state. That's the whole pipeline:
  no lattice, no erosion and no tunnelling — rocks stay thick and organic, and
  chambers connect only where the terrain itself connects them, so some chambers
  are sealed off (most of the floor is reachable, but not all).
- **Aisles (dense, regular).** A randomised, *braided* maze carves 1-wide corridors
  between nodes on a 2-tile lattice (~45% rock). Every rock borders a corridor
  and all floor is reachable — at the cost of a visible grid.
- **Caves (sparse).** The same noise + CA as Dungeon, but floor-majority and then
  *eroded* so rocks survive only as thin, winding outlines (~14% rock).

The **Aisles** and **Caves** styles additionally guarantee full reachability via
two shared steps:

- **Gateway stitching** carves guaranteed floor cells on each chunk edge,
  positioned by a hash of the *shared edge id* so both neighbouring chunks agree
  on the exact world cells — this joins adjacent chunks. (The chunk size is odd so
  aisle chunks interlock at the border rather than meeting wall-to-wall.)
- **Erosion** (Caves) opens any rock that has no floor neighbour, and **region
  tunnelling** L-tunnels every disconnected region — and every gateway — into one
  connected component.

### Layout rules

The original strict rules — *every rock must border a corridor* and *every floor
tile must be reachable* — are still enforced by the **Aisles** and **Caves**
styles. The default **Dungeon** style deliberately relaxes both to allow a denser,
more organic look without any lattice: rocks may sit in thick blocks, and a
minority of floor chambers may be walled off. All styles allow dead ends and
multiple paths, and hash the seed date into every noise value and colour, so each
day is a completely different world.

Run `uv run python scripts/validate.py` to check both styles across several seeds:
it verifies every rock borders a corridor and the floor is one connected
component.

## Project layout

```
app/
  grid.py       # chunk generation (aisles + caves), constraints, colours
  server.py     # FastAPI + WebSocket game loop and player state
  static/
    index.html  # page markup
    style.css   # styling
    game.js     # canvas rendering, camera, input
scripts/
  validate.py   # checks the layout constraints hold
  preview.py    # renders a region of a world to a PNG
Dockerfile
docker-compose.yml
pyproject.toml
```
