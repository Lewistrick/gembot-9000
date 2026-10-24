// The dashboard drawn on the canvas: compass + radar, score, speedometer, cargo,
// buttons, toasts and warning banners. Click targets go in hudHit each frame.

const hudHit = {};             // clickable HUD rects (CSS px), set each frame

function drawHamburger(x, y, s) {
    panel(x, y, s, s);
    ctx.strokeStyle = HUD.neon; ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2, s * 0.09);
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = 6;
    for (let i = 0; i < 3; i++) {
        const ly = y + s * 0.32 + i * s * 0.18;
        ctx.beginPath();
        ctx.moveTo(x + s * 0.26, ly); ctx.lineTo(x + s * 0.74, ly); ctx.stroke();
    }
    ctx.shadowBlur = 0;
}

function drawFlipButton(cx, cy, r, active) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = active ? "rgba(79,242,200,0.22)" : "rgba(4,12,12,0.62)"; ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.09); ctx.strokeStyle = HUD.neon;
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = active ? 12 : 7; ctx.stroke(); ctx.shadowBlur = 0;
    const w2 = r * 0.34, top = cy - r * 0.26, bot = cy + r * 0.3;
    ctx.strokeStyle = HUD.neon; ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.moveTo(cx - w2, bot); ctx.lineTo(cx - w2, top);
    ctx.arc(cx, top, w2, Math.PI, 0); ctx.lineTo(cx + w2, bot);
    ctx.stroke(); ctx.shadowBlur = 0;
    const hs = r * 0.18;                          // arrowhead pointing down
    ctx.fillStyle = HUD.neon;
    ctx.beginPath();
    ctx.moveTo(cx + w2, bot + hs);
    ctx.lineTo(cx + w2 - hs * 0.85, bot - hs * 0.2);
    ctx.lineTo(cx + w2 + hs * 0.85, bot - hs * 0.2);
    ctx.closePath(); ctx.fill();
}

function fmtLeft(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p2 = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}h ${p2(m)}m` : `${m}m ${p2(sec)}s`;
}

// Small pill under the compass: time until midnight, and the rush-hour multiplier.
function drawDayClock(W, y) {
    if (!G.leftAt) return 0;
    const left = G.left - (performance.now() - G.leftAt) / 1000;
    const rush = G.mult > 1, fs = Math.max(11, Math.min(W * 0.03, 16));
    const label = rush ? `RUSH HOUR x${G.mult}  ${fmtLeft(left)}` : `DAY ENDS IN ${fmtLeft(left)}`;
    const color = rush ? HUD.amber : HUD.dim;
    ctx.font = `bold ${fs}px ${HUD.font}`;
    const w = ctx.measureText(label).width + fs * 1.4, h = fs * 1.7;
    const pulse = rush ? 0.75 + 0.25 * Math.sin(performance.now() / 300) : 1;
    ctx.save();
    ctx.globalAlpha = pulse;
    rr(W / 2 - w / 2, y, w, h, h / 2); ctx.fillStyle = "rgba(4,12,12,0.6)"; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = rush ? HUD.amber : "rgba(79,242,200,0.35)"; ctx.stroke();
    text(label, W / 2, y + h * 0.7, fs, color, "center", rush ? 6 : 0);
    ctx.restore();
    return h + 6;
}

function drawToasts(W, topY) {
    const now = performance.now();
    G.toasts = G.toasts.filter((t) => now - t.t0 < t.dur);
    let y = topY;
    const fs = Math.max(12, Math.min(W * 0.034, 20));
    for (const t of G.toasts) {
        const age = now - t.t0, fade = Math.min(1, (t.dur - age) / 400, age / 120 + 0.3);
        ctx.font = `bold ${fs}px ${HUD.font}`;
        const w = ctx.measureText(t.text).width + fs * 1.6, h = fs * 1.9;
        ctx.save();
        ctx.globalAlpha = Math.max(0, fade);
        rr(W / 2 - w / 2, y, w, h, h / 2); ctx.fillStyle = "rgba(4,12,12,0.78)"; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = t.color; ctx.stroke();
        text(t.text, W / 2, y + h * 0.68, fs, t.color, "center", 0);
        ctx.restore();
        y += h + 6;
    }
}

function drawBanner(W, H, msg, color) {
    const fs = Math.max(14, Math.min(W * 0.045, 26));
    ctx.font = `bold ${fs}px ${HUD.font}`;
    const w = Math.min(W - 24, ctx.measureText(msg).width + fs * 2), h = fs * 2.2;
    rr(W / 2 - w / 2, H * 0.3, w, h, 10); ctx.fillStyle = "rgba(20,4,4,0.82)"; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.stroke();
    ctx.shadowBlur = 0;
    text(msg, W / 2, H * 0.3 + h * 0.66, fs, color, "center", 6);
}

// Fit `str` into `maxW` pixels by shrinking the font if needed; returns the size used.
function fitSize(str, maxW, size, minSize) {
    ctx.font = `bold ${size}px ${HUD.font}`;
    const w = ctx.measureText(str).width;
    return w > maxW ? Math.max(minSize, size * maxW / w) : size;
}

// Top-right pane: cargo you carry (left) and your banked score and rank (right).
function drawScorePanel(x, y, w, h) {
    panel(x, y, w, h);
    const gem = hexRgb(curColors().gem), has = G.cargo > 0;
    const mid = x + w * 0.47;
    // Cargo: only counts once it reaches the base.
    const gs = h * 0.17, gx = x + h * 0.36, gy = y + h * 0.55;
    ctx.save();
    ctx.fillStyle = css(has ? gem : mix(gem, [60, 60, 60], 0.7));
    ctx.shadowColor = css(gem); ctx.shadowBlur = has ? 10 : 0;
    ctx.beginPath();
    ctx.moveTo(gx, gy - gs * 1.1); ctx.lineTo(gx + gs, gy - gs * 0.1); ctx.lineTo(gx + gs * 0.6, gy + gs);
    ctx.lineTo(gx - gs * 0.6, gy + gs); ctx.lineTo(gx - gs, gy - gs * 0.1); ctx.closePath();
    ctx.fill();
    ctx.restore();
    const cx = x + h * 0.66, cw = mid - cx - h * 0.12;
    text("CARGO", cx, y + h * 0.3, Math.max(9, h * 0.2), HUD.dim, "left", 0);
    const cs = String(G.cargo);
    text(cs, cx, y + h * 0.68, fitSize(cs, cw, Math.max(14, h * 0.4), 10), has ? HUD.amber : HUD.dim, "left", has ? 8 : 0);
    if (has && Math.hypot(G.x, G.y) > G.baseR) text("TO BASE", cx, y + h * 0.92, Math.max(8, h * 0.16), HUD.amber, "left", 0);
    ctx.strokeStyle = "rgba(79,242,200,0.25)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mid, y + h * 0.15); ctx.lineTo(mid, y + h * 0.85); ctx.stroke();
    // Score and the way home. It blinks for a moment after tolls came in (players or gems rode over your hubs).
    const rx = x + w - h * 0.3, sw = rx - mid - h * 0.15;
    const sinceToll = performance.now() - G.scoreFlash, blink = sinceToll < 1800 && Math.floor(sinceToll / 150) % 2 === 0;
    if (blink) { rr(mid + 2, y + 3, x + w - mid - 5, h - 6, Math.min(8, h * 0.2)); ctx.fillStyle = "rgba(62,240,122,0.5)"; ctx.fill(); }
    const dist = Math.max(0, Math.round(Math.hypot(G.x, G.y) - G.baseR));
    text("SCORE" + (G.rank ? `  #${G.rank}` : ""), rx, y + h * 0.3, Math.max(9, h * 0.2), HUD.dim, "right", 0);
    const ss = String(G.score);
    text(ss, rx, y + h * 0.63, fitSize(ss, sw, Math.max(14, h * 0.42), 10), blink ? "#ffffff" : HUD.neon, "right", 8);
    text(dist > 0 ? `BASE ${dist}m` : "AT BASE", rx, y + h * 0.9, Math.max(10, h * 0.22), HUD.amber, "right", 6);
}

// Round icon buttons beside the about-face button. `on` false draws it dimmed (unavailable).
function drawIconButton(cx, cy, r, kind, on, active) {
    const col = active ? HUD.amber : HUD.neon;      // lit buttons turn amber; a solid dark disc keeps them readable on light floor
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.6;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = active ? "rgba(52,34,0,0.94)" : "rgba(4,12,12,0.88)"; ctx.fill();
    ctx.lineWidth = Math.max(2, r * (active ? 0.14 : 0.09)); ctx.strokeStyle = col;
    ctx.shadowColor = col; ctx.shadowBlur = on ? 9 : 0; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = Math.max(2, r * 0.1); ctx.lineCap = "round"; ctx.lineJoin = "round";
    const sq = (px, py, s) => { rr(px - s, py - s, s * 2, s * 2, s * 0.25); ctx.stroke(); };
    if (kind === "hub") {                          // a hub with a "+": place one here
        sq(cx - r * 0.08, cy + r * 0.08, r * 0.38);
        ctx.beginPath(); ctx.arc(cx - r * 0.08, cy + r * 0.08, r * 0.1, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.moveTo(cx + r * 0.42, cy - r * 0.62); ctx.lineTo(cx + r * 0.42, cy - r * 0.18);
        ctx.moveTo(cx + r * 0.2, cy - r * 0.4); ctx.lineTo(cx + r * 0.64, cy - r * 0.4); ctx.stroke();
    } else if (kind === "ship") {                  // a mine cart heaped with gems, rolling to the base
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.46, cy - r * 0.12); ctx.lineTo(cx + r * 0.46, cy - r * 0.12);
        ctx.lineTo(cx + r * 0.34, cy + r * 0.3); ctx.lineTo(cx - r * 0.34, cy + r * 0.3);
        ctx.closePath(); ctx.stroke();
        for (const dx of [-0.22, 0.22]) { ctx.beginPath(); ctx.arc(cx + dx * r, cy + r * 0.46, r * 0.09, 0, TAU); ctx.fill(); }
        ctx.beginPath();                           // a gem on top
        ctx.moveTo(cx, cy - r * 0.5); ctx.lineTo(cx + r * 0.16, cy - r * 0.3); ctx.lineTo(cx, cy - r * 0.12);
        ctx.lineTo(cx - r * 0.16, cy - r * 0.3); ctx.closePath(); ctx.fill();
    } else {                                       // "travel": arrows along a line, both ways
        ctx.beginPath(); ctx.moveTo(cx - r * 0.5, cy); ctx.lineTo(cx + r * 0.5, cy); ctx.stroke();
        for (const sgn of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(cx + sgn * r * 0.5, cy);
            ctx.lineTo(cx + sgn * r * 0.26, cy - r * 0.2); ctx.lineTo(cx + sgn * r * 0.26, cy + r * 0.2);
            ctx.closePath(); ctx.fill();
        }
        ctx.beginPath(); ctx.moveTo(cx - r * 0.12, cy + r * 0.4); ctx.lineTo(cx + r * 0.12, cy + r * 0.4); ctx.stroke();
    }
    ctx.restore();
}

// Square top-bar button with a small icon; lit while its view is switched on.
function drawSquareButton(x, y, s, kind, on) {
    panel(x, y, s, s);
    if (on) { rr(x, y, s, s, Math.min(10, s * 0.22)); ctx.fillStyle = "rgba(79,242,200,0.22)"; ctx.fill(); }
    const cx = x + s / 2, cy = y + s / 2;
    ctx.save();
    ctx.strokeStyle = HUD.neon; ctx.fillStyle = HUD.neon; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, s * 0.08);
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = on ? 8 : 4;
    if (kind === "lens") {                         // a magnifying glass
        ctx.beginPath(); ctx.arc(cx - s * 0.05, cy - s * 0.05, s * 0.2, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + s * 0.1, cy + s * 0.1); ctx.lineTo(cx + s * 0.3, cy + s * 0.3); ctx.stroke();
    } else if (kind === "close") {                 // a cross
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.22, cy - s * 0.22); ctx.lineTo(cx + s * 0.22, cy + s * 0.22);
        ctx.moveTo(cx + s * 0.22, cy - s * 0.22); ctx.lineTo(cx - s * 0.22, cy + s * 0.22); ctx.stroke();
    } else {                                       // a minimap: a round radar with a blip
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.28, 0, TAU); ctx.stroke();
        ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.beginPath(); ctx.moveTo(cx - s * 0.28, cy); ctx.lineTo(cx + s * 0.28, cy);
        ctx.moveTo(cx, cy - s * 0.28); ctx.lineTo(cx, cy + s * 0.28); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx + s * 0.1, cy - s * 0.1, s * 0.05, 0, TAU); ctx.fill();
    }
    ctx.restore();
}

// Circular minimap around the player, turning with the heading like the main view:
// floor and rock, gems you haven't mined, hubs (gray) and the base (yellow).
const MAP_RADIUS = 26 * Math.SQRT2;   // tiles shown in every direction: twice the area of the original 26-tile map
function drawMinimap(cam, x, y, size) {
    const r = size / 2, cx = x + r, cy = y + r, px = r / MAP_RADIUS, colors = curColors();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    ctx.fillStyle = colors.rock; ctx.fillRect(x, y, size, size);          // rock and anything not loaded yet
    ctx.translate(cx, cy); ctx.rotate(-cam.h);
    const ox = Math.round(cam.x), oy = Math.round(cam.y), n = Math.ceil(MAP_RADIUS) + 1;
    ctx.fillStyle = colors.floor;
    for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
            if (i * i + j * j > n * n || !isFloor(ox + i, oy + j)) continue;
            ctx.fillRect((ox + i - cam.x - 0.5) * px, (oy + j - cam.y - 0.5) * px, px + 0.6, px + 0.6);
        }
    }
    const at = (wx, wy) => [(wx - cam.x) * px, (wy - cam.y) * px];
    const dot = Math.max(2, px * 0.9);
    ctx.lineCap = "round";
    for (const h of G.hubs.values()) {                                      // rails: each hub's track to the hub it leads to
        const to = h.out >= 0 ? hubPos(h.out) : null;
        if (!to || distToSegment(cam.x, cam.y, h.x, h.y, to[0], to[1]) > MAP_RADIUS + 2) continue;
        const [ax, ay] = at(h.x, h.y), [bx, by] = at(to[0], to[1]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.strokeStyle = "rgba(20,24,30,0.9)"; ctx.lineWidth = Math.max(3, px * 0.9); ctx.stroke();   // dark edge
        ctx.strokeStyle = "#c4ccd8"; ctx.lineWidth = Math.max(1.5, px * 0.45); ctx.stroke();           // the rail
    }
    for (const c of chunks.values()) {                                      // gems left to mine
        for (const g of c.gems) {
            const key = g[0] + "," + g[1];
            if (mined.has(key) || Math.hypot(g[0] - cam.x, g[1] - cam.y) > MAP_RADIUS + 2) continue;
            const [mx, my] = at(g[0], g[1]), mega = c.mega.has(key);
            ctx.fillStyle = mega ? "#ffd64d" : colors.gem;
            ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(mx, my, mega ? dot * 1.6 : dot, 0, TAU); ctx.fill(); ctx.stroke();
        }
    }
    for (const h of G.hubs.values()) {                                      // hubs
        if (Math.hypot(h.x - cam.x, h.y - cam.y) > MAP_RADIUS + 2) continue;
        const [mx, my] = at(h.x, h.y), s = Math.max(3, px * 1.5);
        ctx.fillStyle = "#aab2c0"; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 1;
        ctx.fillRect(mx - s / 2, my - s / 2, s, s); ctx.strokeRect(mx - s / 2, my - s / 2, s, s);
    }
    {                                                                       // the base
        const [mx, my] = at(0, 0), s = Math.max(4, px * 2.2);
        ctx.fillStyle = HUD.amber; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(mx, my, s, 0, TAU); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    ctx.save();                                                             // you, always pointing up
    ctx.translate(cx, cy);
    ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineWidth = 1.5;
    const a = Math.max(4, size * 0.04);
    ctx.beginPath(); ctx.moveTo(0, -a * 1.4); ctx.lineTo(a, a); ctx.lineTo(0, a * 0.4); ctx.lineTo(-a, a); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.lineWidth = Math.max(2, size * 0.02); ctx.strokeStyle = HUD.neon; ctx.shadowColor = HUD.neon; ctx.shadowBlur = 8;
    ctx.stroke(); ctx.shadowBlur = 0;
}

// ---- The big map: the minimap fullscreen and north up (tap the minimap), with pan and zoom ----
const mapView = { cx: 0, cy: 0, sc: 0 };       // world point at the screen centre, and px per tile (0: not chosen yet)
const MAP_MAX_SCALE = 40;
let bigMapTiles = null, bigMapKey = "";        // floor/rock of every loaded chunk, one pixel per tile (rebuilt when terrain changes)

function loadedBounds() {                       // tiles of the loaded chunks (null if none yet)
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const c of chunks.values()) { c0 = Math.min(c0, c.cx); c1 = Math.max(c1, c.cx); r0 = Math.min(r0, c.cy); r1 = Math.max(r1, c.cy); }
    return c0 === Infinity ? null : [c0 * CS, r0 * CS, (c1 + 1) * CS - 1, (r1 + 1) * CS - 1];
}
function bigMapBounds() {                       // what the map can show: the loaded terrain, the base, you and every hub
    let x0 = Math.min(0, G.x), x1 = Math.max(0, G.x), y0 = Math.min(0, G.y), y1 = Math.max(0, G.y);
    const lb = loadedBounds();
    if (lb) { x0 = Math.min(x0, lb[0]); y0 = Math.min(y0, lb[1]); x1 = Math.max(x1, lb[2]); y1 = Math.max(y1, lb[3]); }
    for (const h of G.hubs.values()) { x0 = Math.min(x0, h.x); x1 = Math.max(x1, h.x); y0 = Math.min(y0, h.y); y1 = Math.max(y1, h.y); }
    return [x0, y0, x1, y1];
}
function bigMapFitScale(W, H) {                 // the scale at which all of it fits on screen
    const [x0, y0, x1, y1] = bigMapBounds();
    return Math.min(W / Math.max(12, x1 - x0 + 4), H / Math.max(12, y1 - y0 + 4));
}
function clampMapView(W, H) {                   // keep the view on the map
    const [x0, y0, x1, y1] = bigMapBounds();
    mapView.sc = clamp(mapView.sc, Math.min(bigMapFitScale(W, H), MAP_MAX_SCALE), MAP_MAX_SCALE);
    mapView.cx = clamp(mapView.cx, x0 - 10, x1 + 10);
    mapView.cy = clamp(mapView.cy, y0 - 10, y1 + 10);
}
function centreBigMap(W, H) {                   // open on you, at the zoom you used last (or about 90 tiles across)
    mapView.cx = G.x; mapView.cy = G.y;
    if (!mapView.sc) mapView.sc = Math.min(W, H) / 90;
    clampMapView(W, H);
}
function mapPan(dx, dy, W, H) {                 // drag by (dx, dy) screen px
    mapView.cx -= dx / mapView.sc; mapView.cy -= dy / mapView.sc;
    clampMapView(W, H);
}
function mapZoomAt(px, py, factor, W, H) {      // zoom keeping the world point under (px, py) in place
    const wx = mapView.cx + (px - W / 2) / mapView.sc, wy = mapView.cy + (py - H / 2) / mapView.sc;
    mapView.sc *= factor;
    clampMapView(W, H);
    mapView.cx = wx - (px - W / 2) / mapView.sc; mapView.cy = wy - (py - H / 2) / mapView.sc;
    clampMapView(W, H);
}

// The terrain picture: every loaded tile as one pixel, floor and rock in the minimap's colours.
function bigMapTerrain(colors) {
    const lb = loadedBounds();
    if (!lb) return null;
    const key = `${chunkVersion}|${lb.join(",")}|${colors.floor}|${colors.rock}`;
    if (bigMapTiles && key === bigMapKey) return bigMapTiles;
    const [x0, y0, x1, y1] = lb, w = x1 - x0 + 1, h = y1 - y0 + 1;
    const cv = bigMapTiles && bigMapTiles.canvas.width === w && bigMapTiles.canvas.height === h ? bigMapTiles.canvas : document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d"), img = g.createImageData(w, h), d = img.data;
    const fl = hexRgb(colors.floor), rk = hexRgb(colors.rock);
    for (const c of chunks.values()) {
        for (let j = 0; j < CS; j++) {
            for (let i = 0; i < CS; i++) {
                const x = c.cx * CS + i, y = c.cy * CS + j, k = ((y - y0) * w + (x - x0)) * 4;
                const col = isFloor(x, y) ? fl : rk;
                d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255;
            }
        }
    }
    g.putImageData(img, 0, 0);
    bigMapTiles = { canvas: cv, x0, y0 };
    bigMapKey = key;
    return bigMapTiles;
}

function drawBigMap(W, H) {
    const S = Math.min(W, H), M = Math.max(8, S * 0.028), topH = Math.max(30, Math.min(58, S * 0.085));
    const sc = mapView.sc, colors = curColors(), now = performance.now();
    const at = (wx, wy) => [W / 2 + (wx - mapView.cx) * sc, H / 2 + (wy - mapView.cy) * sc];

    ctx.save();
    ctx.fillStyle = "#05080a"; ctx.fillRect(0, 0, W, H);                   // not explored yet
    const terrain = bigMapTerrain(colors);
    if (terrain) {
        const [tx, ty] = at(terrain.x0 - 0.5, terrain.y0 - 0.5);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(terrain.canvas, tx, ty, terrain.canvas.width * sc, terrain.canvas.height * sc);
        ctx.imageSmoothingEnabled = true;
    }
    ctx.lineCap = "round";
    for (const h of G.hubs.values()) {                                      // rails, as on the minimap
        const to = h.out >= 0 ? hubPos(h.out) : null;
        if (!to) continue;
        const [ax, ay] = at(h.x, h.y), [bx, by] = at(to[0], to[1]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.strokeStyle = "rgba(20,24,30,0.9)"; ctx.lineWidth = clamp(sc * 0.9, 3, 12); ctx.stroke();
        ctx.strokeStyle = "#c4ccd8"; ctx.lineWidth = clamp(sc * 0.45, 1.5, 6); ctx.stroke();
    }
    const dot = clamp(sc * 0.45, 1.6, 9);
    for (const c of chunks.values()) {                                      // gems left to mine
        for (const g of c.gems) {
            const key = g[0] + "," + g[1];
            if (mined.has(key)) continue;
            const [mx, my] = at(g[0], g[1]);
            if (mx < -20 || my < -20 || mx > W + 20 || my > H + 20) continue;
            const mega = c.mega.has(key);
            ctx.fillStyle = mega ? "#ffd64d" : colors.gem; ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(mx, my, mega ? dot * 1.6 : dot, 0, TAU); ctx.fill(); ctx.stroke();
        }
    }
    for (const h of G.hubs.values()) {                                      // hubs
        const [mx, my] = at(h.x, h.y), hs = clamp(sc * 1.5, 4, 16);
        ctx.fillStyle = "#aab2c0"; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 1;
        ctx.fillRect(mx - hs / 2, my - hs / 2, hs, hs); ctx.strokeRect(mx - hs / 2, my - hs / 2, hs, hs);
    }
    // The base and you, each with a slowly blinking circle around it.
    const blink = 0.5 + 0.5 * Math.sin(now / 320);
    const ring = (x, y, r, color) => {
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.75 * blink;
        ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.shadowColor = color; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
        ctx.restore();
    };
    {
        const [bx, by] = at(0, 0), br = Math.max(4, sc * 2.2);
        ctx.fillStyle = HUD.amber; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill(); ctx.stroke();
        ring(bx, by, Math.max(16, G.baseR * sc), HUD.amber);
    }
    {
        const [px, py] = at(G.x, G.y), a = Math.max(6, S * 0.016);
        ctx.save(); ctx.translate(px, py); ctx.rotate(G.h);                 // pointing where you face
        ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, -a * 1.5); ctx.lineTo(a, a); ctx.lineTo(0, a * 0.4); ctx.lineTo(-a, a); ctx.closePath();
        ctx.fill(); ctx.stroke(); ctx.restore();
        ring(px, py, a * 2.6, "#ffffff");
    }
    const fs = clamp(S * 0.03, 11, 18);
    {                                                                       // north marker, top left
        const nx = M + fs, ny = M + topH + M + fs;
        ctx.font = `bold ${fs * 1.2}px ${HUD.font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.strokeText("N", nx, ny + fs * 0.9);
        ctx.fillStyle = HUD.neon; ctx.fillText("N", nx, ny + fs * 0.9);
        ctx.beginPath(); ctx.moveTo(nx, ny - fs * 0.7); ctx.lineTo(nx - fs * 0.4, ny - fs * 0.05);
        ctx.lineTo(nx + fs * 0.4, ny - fs * 0.05); ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    pillLabel("MAP", W / 2, M + topH / 2, HUD.neon, Math.max(12, topH * 0.36));
    pillLabel("drag to pan \u00b7 scroll or pinch to zoom", W / 2, H - M - fs * 0.6, HUD.dim, Math.max(10, S * 0.022));
    drawSquareButton(W - M - topH, M, topH, "close", false);                // the cross that leaves the map
    hudHit.mapClose = { x: W - M - topH, y: M, w: topH, h: topH };
}

// Small caption pill centred at (x, y).
function pillLabel(str, x, y, color, size) {
    ctx.font = `bold ${size}px ${HUD.font}`;
    const w = ctx.measureText(str).width + size * 1.2, h = size * 1.8;
    rr(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fillStyle = "rgba(4,12,12,0.7)"; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = color; ctx.stroke();
    text(str, x, y + size * 0.35, size, color, "center", 0);
}

function drawHUD(cam, W, H) {
    const S = Math.min(W, H);
    if (G.showBigMap) {
        // The big map covers the game: only its cross, toasts and warnings stay live.
        for (const k in hudHit) hudHit[k] = null;
        drawBigMap(W, H);
        drawToasts(W, Math.max(8, S * 0.028) * 1.6 + Math.max(30, Math.min(58, S * 0.085)));
        if (G.idleUntil > performance.now()) drawBanner(W, H, `STILL THERE?  MOVE WITHIN ${Math.ceil((G.idleUntil - performance.now()) / 1000)}s`, "#ff5a4d");
        return;
    }
    const M = Math.max(8, S * 0.028);
    const touch = typeof touchMode !== "undefined" && touchMode;
    const topH = Math.max(30, Math.min(58, S * 0.085));
    drawHamburger(M, M, topH);
    hudHit.hamburger = { x: M, y: M, w: topH, h: topH };
    const scoreW = Math.max(160, Math.min(W * 0.42, 280));
    drawScorePanel(W - M - scoreW, M, scoreW, topH);
    hudHit.score = { x: W - M - scoreW, y: M, w: scoreW, h: topH };
    // Next to the menu button: the lens (arrows to base, gem, hub) and the minimap.
    const gap0 = M * 0.6;
    drawSquareButton(M + topH + gap0, M, topH, "lens", G.showArrows);
    hudHit.lens = { x: M + topH + gap0, y: M, w: topH, h: topH };
    drawSquareButton(M + 2 * (topH + gap0), M, topH, "map", G.showMap);
    hudHit.minimap = { x: M + 2 * (topH + gap0), y: M, w: topH, h: topH };
    hudHit.minimapView = null;
    if (G.showMap) {                                // tapping the minimap opens the big map
        const ms = Math.max(96, Math.min(190, S * 0.3)) * Math.SQRT2, my = M + topH + gap0;
        drawMinimap(cam, M, my, ms);
        hudHit.minimapView = { x: M, y: my, w: ms, h: ms };
    }

    // Bottom centre: [hub | ship]  [about-face]  [travel], thumb-sized on touch.
    const fbR = touch ? Math.max(28, Math.min(46, S * 0.075)) : Math.max(20, Math.min(38, S * 0.05));
    const fbx = W / 2, fby = H - M - fbR, sbR = fbR * 0.78, gap = fbR + sbR + M * 0.6;
    const sby = fby + (fbR - sbR), cap = Math.max(8, S * 0.02);
    if (travelMode) {
        hudHit.flip = null;       // steering is off in travel mode, and tracks behind you run right through this spot
    } else {
        drawFlipButton(fbx, fby, fbR, G.flipping);
        hudHit.flip = { x: fbx - fbR, y: fby - fbR, w: 2 * fbR, h: 2 * fbR };
    }
    const parked = typeof parkedHub === "function" && parkedHub();
    const box = (cx) => ({ x: cx - sbR, y: sby - sbR, w: 2 * sbR, h: 2 * sbR });
    hudHit.placeHub = hudHit.ship = hudHit.travel = null;
    if (parked || travelMode) {
        // Parked on a hub (or travelling hub to hub): ship gems to the base, or switch travel mode.
        const ship = canShip(), go = canTravel() || travelMode;
        drawIconButton(fbx - gap, sby, sbR, "ship", ship);
        hudHit.ship = box(fbx - gap);
        // The tolls the shipment would pay on the way, so you can choose to drive it home yourself.
        const tolls = parked.id ? shipTolls(parked.id) : 0;
        const shipLabel = parked.id ? `SHIP \u00b7 ${tolls ? `TOLL ${tolls}` : "FREE"}` : "SHIP";
        pillLabel(shipLabel, fbx - gap, sby - sbR - cap * 1.3, ship ? (tolls ? HUD.amber : HUD.neon) : HUD.dim, cap);
        drawIconButton(fbx + gap, sby, sbR, "travel", go, travelMode);
        hudHit.travel = box(fbx + gap);
        pillLabel(travelMode ? "TRAVEL ON" : "TRAVEL", fbx + gap, sby - sbR - cap * 1.3, travelMode ? HUD.amber : go ? HUD.neon : HUD.dim, cap);
        const title = typeof hubCaption === "function" ? hubCaption() : "";
        if (title) pillLabel(title, fbx, fby - fbR - cap * 1.9, HUD.amber, cap * 1.15);
    } else if (typeof canAffordHub === "function" && canAffordHub()) {
        // Only players who could pay for a hub see the button (dimmed until they stop).
        const can = canPlaceHub();
        drawIconButton(fbx - gap, sby, sbR, "hub", can);
        hudHit.placeHub = box(fbx - gap);
        pillLabel("HUB", fbx - gap, sby - sbR - cap * 1.3, can ? HUD.neon : HUD.dim, cap);
    }

    const clockH = drawDayClock(W, M + topH + M * 0.6);
    drawToasts(W, M + topH + M * 0.6 + clockH + 4);
    if (G.idleUntil > performance.now()) {
        drawBanner(W, H, `STILL THERE?  MOVE WITHIN ${Math.ceil((G.idleUntil - performance.now()) / 1000)}s`, "#ff5a4d");
    } else if (!G.connected && wantPlaying) {
        drawBanner(W, H, "RECONNECTING…", HUD.amber);
    } else if (G.lightD >= G.light[1]) {
        drawBanner(W, H, `TOO DARK \u00b7 LOST IN ${Math.max(0, Math.ceil(G.light[2] - G.lightD))}m`, "#ff5a4d");
    }
}
