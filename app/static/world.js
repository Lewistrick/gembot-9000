// The world as the client knows it: terrain chunks streamed by the server, the
// mined-gem set, per-world tile textures, and drawing of terrain + gems.

let CS = 33;                    // chunk edge in tiles (the server sends the real value)
const chunks = new Map();       // "cx,cy" -> { floor: Uint8Array(CS*CS), gems: [[x,y,v]], mega: Set }
const mined = new Set();        // "x,y" of every gem mined today (by anyone)
const drilled = new Map();      // "x,y" -> [x, y] of wall tiles drilled out today: floor for everyone
let chunkVersion = 0;           // bumped whenever terrain changes, to invalidate caches

function addChunk(m) {
    const bin = atob(m.bits), n = CS * CS, floor = new Uint8Array(n);
    for (let i = 0; i < n; i++) floor[i] = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
    const mega = new Set(m.mega.map((p) => p[0] + "," + p[1]));
    for (const p of m.mined) mined.add(p[0] + "," + p[1]);
    for (const p of m.drilled) drilled.set(p[0] + "," + p[1], p);
    chunks.set(m.cx + "," + m.cy, { cx: m.cx, cy: m.cy, floor, gems: m.gems, mega });
    chunkVersion++;
}
function dropChunks(list) {
    for (const p of list) chunks.delete(p[0] + "," + p[1]);
    chunkVersion++;
}
function addDrilled(list) {
    for (const p of list) drilled.set(p[0] + "," + p[1], p);
    chunkVersion++;                 // terrain changed: rebuild the cached view
}
function clearWorld() { chunks.clear(); mined.clear(); drilled.clear(); chunkVersion++; }

function isFloor(x, y) {
    const cx = Math.floor(x / CS), cy = Math.floor(y / CS);
    if (drilled.size && drilled.has(x + "," + y)) return true;
    const c = chunks.get(cx + "," + cy);
    return !!c && c.floor[(y - cy * CS) * CS + (x - cx * CS)] === 1;
}

// ---- Biomes: which of the day's three palettes (inner, middle, outer) a tile shows ----
// Decided per tile, from its position: the world is cut into 4x4-tile blocks, and in a
// ridge BIOMES.ridge tiles wide around each edge the blocks of the two biomes are mixed,
// from a few outer blocks on the inner side to a few inner ones on the outer side.
let BIOMES = null;              // { pals: [3 palettes], edges: [250, 600], ridge: 50, salt } from welcome
const BIOME_BLOCK = 4;
function blockRand(salt, bx, by, k) {          // deterministic 0..1 per block (same for every player)
    let h = (salt ^ Math.imul(bx, 0x27d4eb2d) ^ Math.imul(by, 0x165667b1) ^ Math.imul(k + 1, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function biomeAt(x, y) {
    if (!BIOMES) return 0;
    const bx = Math.floor(x / BIOME_BLOCK), by = Math.floor(y / BIOME_BLOCK);
    const d = Math.hypot((bx + 0.5) * BIOME_BLOCK, (by + 0.5) * BIOME_BLOCK), half = BIOMES.ridge / 2;
    let b = 0;
    for (let k = 0; k < BIOMES.edges.length; k++) {
        const e = BIOMES.edges[k];
        if (d >= e + half) { b = k + 1; continue; }
        if (d > e - half) {
            let t = (d - (e - half)) / BIOMES.ridge;
            t = t * t * (3 - 2 * t);                // eased: the mix thickens towards the middle
            if (blockRand(BIOMES.salt, bx, by, k) < t) b = k + 1;
        }
        break;
    }
    return b;
}
function biomePal(x, y) { return BIOMES ? BIOMES.pals[biomeAt(Math.round(x), Math.round(y))] : curColors(); }

// ---- Per-world tile textures (sandy floor, veined stone) ----
const NVAR = 6;                 // texture variants per tile kind
const atlases = new Map();      // key -> { floor:[canvas], rock:[canvas] } (one set per biome palette)

function offCanvas(w, h) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    return cv;
}
function seededRng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function makeFloorTile(ps, hex, variant) {
    const cv = offCanvas(ps, ps), c = cv.getContext("2d"), base = hexRgb(hex);
    c.fillStyle = hex; c.fillRect(0, 0, ps, ps);
    const rng = seededRng((variant * 2654435761) ^ 0x51ed3b7);
    // Broad, soft mottling so neighbouring grains aren't uniform.
    for (let i = 0; i < 4; i++) {
        const x = rng() * ps, y = rng() * ps, r = ps * (0.25 + rng() * 0.4);
        const d = rng() - 0.5;
        const col = d > 0 ? mix(base, [255, 255, 255], d * 0.3) : mix(base, [0, 0, 0], -d * 0.3);
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, css(col, 0.5)); g.addColorStop(1, css(col, 0));
        c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    }
    // Fine sand grain.
    const grains = Math.round(ps * ps * 0.09);
    for (let i = 0; i < grains; i++) {
        const x = rng() * ps, y = rng() * ps, r = ps * (0.006 + rng() * 0.018);
        const d = rng() - 0.5;
        const col = d > 0 ? mix(base, [255, 255, 255], 0.4) : mix(base, [0, 0, 0], 0.35);
        c.fillStyle = css(col, 0.35 + rng() * 0.5);
        c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    }
    return cv;
}

function makeRockTile(ps, hex, variant) {
    const cv = offCanvas(ps, ps), c = cv.getContext("2d"), base = hexRgb(hex);
    c.fillStyle = hex; c.fillRect(0, 0, ps, ps);
    const rng = seededRng((variant * 40503) ^ 0x9e3779b9);
    // Rocky blotches (lighter and darker patches).
    const blobs = 5 + ((rng() * 5) | 0);
    for (let i = 0; i < blobs; i++) {
        const x = rng() * ps, y = rng() * ps, r = ps * (0.12 + rng() * 0.24);
        const d = rng() - 0.45;
        const col = d > 0 ? mix(base, [255, 255, 255], d * 0.3) : mix(base, [0, 0, 0], -d * 0.55);
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, css(col, 0.6)); g.addColorStop(1, css(col, 0));
        c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    }
    // Mineral veins.
    const vein = mix(base, [255, 255, 255], 0.45);
    const veins = 1 + ((rng() * 2) | 0);
    for (let v = 0; v < veins; v++) {
        c.strokeStyle = css(vein, 0.3 + rng() * 0.3);
        c.lineWidth = Math.max(1, ps * (0.02 + rng() * 0.02));
        c.lineCap = "round";
        let x = rng() * ps, y = rng() * ps;
        c.beginPath(); c.moveTo(x, y);
        const segs = 2 + ((rng() * 3) | 0);
        for (let s = 0; s < segs; s++) {
            x += (rng() - 0.5) * ps * 0.9; y += (rng() - 0.5) * ps * 0.9;
            c.lineTo(x, y);
        }
        c.stroke();
    }
    // Bevel: catch light top-left, shadow bottom-right, for a chunky stone feel.
    c.lineWidth = Math.max(1, ps * 0.07);
    c.strokeStyle = "rgba(255,255,255,0.10)";
    c.beginPath(); c.moveTo(0, ps); c.lineTo(0, 0); c.lineTo(ps, 0); c.stroke();
    c.strokeStyle = "rgba(0,0,0,0.30)";
    c.beginPath(); c.moveTo(ps, 0); c.lineTo(ps, ps); c.lineTo(0, ps); c.stroke();
    return cv;
}

function ensureAtlas(floorHex, rockHex) {
    const dpr = window.devicePixelRatio || 1;
    const ps = Math.max(6, Math.round(tile * dpr));
    const key = `${ps}|${floorHex}|${rockHex}`;
    const have = atlases.get(key);
    if (have) return have;
    const floor = [], rock = [];
    for (let i = 0; i < NVAR; i++) {
        floor.push(makeFloorTile(ps, floorHex, i));
        rock.push(makeRockTile(ps, rockHex, i));
    }
    if (atlases.size >= 8) atlases.delete(atlases.keys().next().value);   // old zoom levels
    const at = { key, floor, rock };
    atlases.set(key, at);
    return at;
}

// Floor/rock and biome of the tiles around the camera, cached until something changes:
// each entry is floor (bit 0) | biome << 1.
let viewCache = null;
function viewTiles(x0, y0, cols, rows) {
    const key = x0 + "|" + y0 + "|" + cols + "|" + rows + "|" + chunkVersion + "|" + (BIOMES ? BIOMES.salt : 0);
    if (viewCache && viewCache.key === key) return viewCache.tiles;
    const tiles = [];
    for (let r = 0; r < rows; r++) {
        const row = new Array(cols);
        for (let c = 0; c < cols; c++) row[c] = (isFloor(x0 + c, y0 + r) ? 1 : 0) | (biomeAt(x0 + c, y0 + r) << 1);
        tiles.push(row);
    }
    viewCache = { key, tiles };
    return tiles;
}

function drawWorld(cam, ax, ay, colors) {
    const cols = view.cols, rows = view.rows;
    const x0 = Math.round(cam.x) - (cols >> 1), y0 = Math.round(cam.y) - (rows >> 1);
    const tiles = viewTiles(x0, y0, cols, rows);
    const pals = BIOMES ? BIOMES.pals : [colors];
    const ats = pals.map((p) => ensureAtlas(p.floor, p.rock));
    const half = tile / 2, sz = tile + 1, rad = tile * 0.3;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(-cam.h);                     // rotate the world so heading points up
    for (let r = 0; r < rows; r++) {
        const wy = y0 + r, row = tiles[r];
        const ry = Math.round((wy - cam.y) * tile - half);
        for (let c = 0; c < cols; c++) {
            const rx = Math.round((x0 + c - cam.x) * tile - half);
            const vi = (rngAt(x0 + c, wy)() * NVAR) | 0, at = ats[row[c] >> 1] || ats[0];
            if (row[c] & 1) {
                ctx.drawImage(at.floor[vi], rx, ry, sz, sz);
                continue;
            }
            // Round only corners exposed to floor, so rock masses stay solid.
            const up = r > 0 ? tiles[r - 1][c] & 1 : 0;
            const dn = r < rows - 1 ? tiles[r + 1][c] & 1 : 0;
            const lf = c > 0 ? row[c - 1] & 1 : 0;
            const rt = c < cols - 1 ? row[c + 1] & 1 : 0;
            const tl = up && lf ? rad : 0, tr = up && rt ? rad : 0;
            const br = dn && rt ? rad : 0, bl = dn && lf ? rad : 0;
            if (tl || tr || br || bl) {
                ctx.drawImage(at.floor[vi], rx, ry, sz, sz);   // sand shows at the cut
                ctx.save();
                roundRectPath(ctx, rx, ry, sz, sz, tl, tr, br, bl);
                ctx.clip();
                ctx.drawImage(at.rock[vi], rx, ry, sz, sz);
                ctx.restore();
            } else {
                ctx.drawImage(at.rock[vi], rx, ry, sz, sz);
            }
        }
    }
    ctx.restore();
}

// The nearest gem still in the rock among the chunks the server has sent, as [x, y, mega].
function nearestGem(x, y) {
    let best = null, bd = Infinity;
    for (const c of chunks.values()) {
        for (const g of c.gems) {
            const key = g[0] + "," + g[1];
            if (mined.has(key)) continue;
            const d = Math.hypot(g[0] - x, g[1] - y);
            if (d < bd) { bd = d; best = [g[0], g[1], c.mega.has(key)]; }
        }
    }
    return best;
}

// Drilled-out tiles are floor now; leave a little rock rubble where the wall was.
function drawDrilledRubble(cam, ax, ay, W, H, colors) {
    if (!drilled.size) return;
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h);
    for (const p of drilled.values()) {
        const [sx, sy] = screenPos(p[0], p[1], cam, cosr, sinr, ax, ay);
        if (sx < -tile || sx > W + tile || sy < -tile || sy > H + tile) continue;
        const rock = hexRgb(biomePal(p[0], p[1]).rock);      // the rock of that tile's biome
        drawRubblePile(sx, sy, rngAt(p[0], p[1]), rock, rock);
    }
}

// Gem sites in loaded chunks: glowing crystals for unmined, rubble for mined.
const MEGA_COLOR = [255, 214, 77];
function drawGems(cam, ax, ay, W, H, colors) {
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h), now = performance.now();
    // each gem in its own tile's biome colours
    const pals = BIOMES ? BIOMES.pals : [colors];
    const gems = pals.map((p) => hexRgb(p.gem)), rocks = pals.map((p) => hexRgb(p.rock));
    const reach = Math.hypot(W, H) / tile / 2 + CS;
    for (const c of chunks.values()) {
        if (Math.hypot(c.cx * CS + CS / 2 - cam.x, c.cy * CS + CS / 2 - cam.y) > reach + CS) continue;
        for (const g of c.gems) {
            const [sx, sy] = screenPos(g[0], g[1], cam, cosr, sinr, ax, ay);
            if (sx < -tile * 2 || sx > W + tile * 2 || sy < -tile * 2 || sy > H + tile * 2) continue;
            const key = g[0] + "," + g[1], bi = BIOMES ? biomeAt(g[0], g[1]) : 0, gem = gems[bi], rock = rocks[bi];
            if (mined.has(key)) { drawRubblePile(sx, sy, rngAt(g[0], g[1]), gem, rock); continue; }
            const mega = c.mega.has(key);
            const size = tile * (mega ? 0.62 : 0.26 + clamp((g[2] - 10) / 60, 0, 1) * 0.26);
            const phase = g[0] * 12.9 + g[1] * 7.7;
            if (mega) {                       // pulsing amber halo so a mega gem is unmissable
                const pulse = 0.5 + 0.5 * Math.sin(now / 260 + phase);
                ctx.save();
                ctx.globalCompositeOperation = "lighter";
                ctx.fillStyle = `rgba(255,214,77,${0.10 + 0.14 * pulse})`;
                ctx.beginPath(); ctx.arc(sx, sy, tile * (1.2 + 0.4 * pulse), 0, TAU); ctx.fill();
                ctx.restore();
            }
            drawCrystal(sx, sy, size, rngAt(g[0], g[1]), mega ? MEGA_COLOR : gem, now, phase);
        }
    }
}
