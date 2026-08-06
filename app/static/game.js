const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");

const MARGIN = 4;              // extra viewport tiles beyond what rotation needs
const MIN_TILE = 10, MAX_TILE = 60, ZOOM_STEP = 3;
const ANCHOR_Y = 0.75;         // player sits 75% down the screen (more map ahead)
const RADAR_RADIUS = 45;       // tiles: how far the compass radar spots gems
const RADAR_MAX = 12;          // most gem blips shown on the compass at once
let tile = 26;
let ws = null;
let snap = null;               // latest server snapshot
// Camera interpolation (world-tile coords + heading in radians).
let camFrom = { x: 0, y: 0, h: 0 }, camTo = { x: 0, y: 0, h: 0 };
let segStart = 0, segDur = 50, haveCam = false;
let playing = false;           // false while a menu/overlay is showing
let pending = null;            // {seed, style} to apply once the socket is open
let gameOver = false;          // true once the game-over screen is showing
const hudHit = {};             // clickable HUD rects (CSS px), set each frame

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Tell the server whether the run is live, so energy only drains while playing.
function sendActive(on) { send({ action: "active", on }); }

function viewportTiles() {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    // Square viewport big enough that the rotated, off-centre screen always fits.
    // Farthest screen point from the anchor is a top corner.
    const reach = Math.hypot(rect.width / 2, rect.height * ANCHOR_Y);
    const n = Math.max(9, (Math.ceil((2 * reach) / tile) + MARGIN) | 1);
    return { cols: n, rows: n };
}

function reportViewport() {
    const { cols, rows } = viewportTiles();
    send({ action: "resize", cols, rows });
}

function lerp(a, b, t) { return a + (b - a) * t; }

function currentCam() {
    const t = Math.min(1, (performance.now() - segStart) / segDur);
    return {
        x: lerp(camFrom.x, camTo.x, t),
        y: lerp(camFrom.y, camTo.y, t),
        h: lerp(camFrom.h, camTo.h, t),
    };
}

// ---- Gem + rubble rendering (crystalline rock with a little glow) ----
const TAU = Math.PI * 2;
function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function css(c, alpha) {
    const s = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
    return alpha == null ? `rgb(${s})` : `rgba(${s},${alpha})`;
}
// Deterministic PRNG seeded by a tile coord — same shape every frame/visit.
function rngAt(x, y) {
    let s = ((((x * 73856093) ^ (y * 19349663)) >>> 0) ^ 0x9e3779b9) >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function screenPos(gx, gy, cam, cosr, sinr, ax, ay) {
    const lx = (gx - cam.x) * tile, ly = (gy - cam.y) * tile;
    return [lx * cosr - ly * sinr + ax, lx * sinr + ly * cosr + ay];
}

function drawCrystal(sx, sy, size, rng, gem, now, phase) {
    const dark = mix(gem, [0, 0, 0], 0.45), light = mix(gem, [255, 255, 255], 0.55);
    const twk = 0.6 + 0.4 * Math.sin(now / 320 + phase);
    ctx.globalCompositeOperation = "lighter";
    const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * 2.0);
    gr.addColorStop(0, css(light, 0.35 * twk));
    gr.addColorStop(1, css(gem, 0));
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(sx, sy, size * 2.0, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    const n = 5 + ((rng() * 3) | 0), base = rng() * TAU, verts = [];
    for (let i = 0; i < n; i++) {
        const a = base + (i / n) * TAU + (rng() - 0.5) * 0.6;
        const rr = size * (0.7 + rng() * 0.4);
        verts.push([sx + Math.cos(a) * rr, sy + Math.sin(a) * rr]);
    }
    const outline = () => {
        ctx.beginPath();
        verts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
    };
    outline(); ctx.fillStyle = css(dark); ctx.fill();
    const lightA = -2.2;
    for (let i = 0; i < n; i++) {
        const p = verts[i], q = verts[(i + 1) % n];
        const mA = Math.atan2((p[1] + q[1]) / 2 - sy, (p[0] + q[0]) / 2 - sx);
        const lit = 0.5 + 0.5 * Math.cos(mA - lightA);
        ctx.beginPath();
        ctx.moveTo(sx, sy); ctx.lineTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.closePath();
        ctx.fillStyle = css(mix(dark, light, lit)); ctx.fill();
    }
    outline();
    ctx.strokeStyle = css(mix(light, [255, 255, 255], 0.4), 0.85);
    ctx.lineWidth = Math.max(1, size * 0.08); ctx.stroke();
    ctx.fillStyle = `rgba(255,255,255,${0.7 * twk})`;
    ctx.beginPath();
    ctx.arc(sx - size * 0.28, sy - size * 0.32, size * 0.16, 0, TAU); ctx.fill();
}

function drawRubblePile(sx, sy, rng, gem, rock) {
    const count = 3 + ((rng() * 4) | 0);           // 3..6 pebbles
    for (let i = 0; i < count; i++) {
        const a = rng() * TAU, d = rng() * tile * 0.34;
        const px = sx + Math.cos(a) * d, py = sy + Math.sin(a) * d;
        const pr = tile * (0.05 + rng() * 0.11);   // random sizes
        const bcol = rng() < 0.5 ? gem : rock;     // gem- or rock-coloured
        ctx.fillStyle = css(mix(bcol, [0, 0, 0], 0.15));
        ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
        ctx.fillStyle = css(mix(bcol, [255, 255, 255], 0.3), 0.9);
        ctx.beginPath(); ctx.arc(px - pr * 0.25, py - pr * 0.28, pr * 0.5, 0, TAU); ctx.fill();
    }
}

function drawGems(cam, ax, ay, W, H, colors) {
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h), now = performance.now();
    const gem = hexRgb(colors.gem), rock = hexRgb(colors.rock);
    if (snap.rubble) for (const rb of snap.rubble) {
        const [sx, sy] = screenPos(rb.x, rb.y, cam, cosr, sinr, ax, ay);
        if (sx < -tile || sx > W + tile || sy < -tile || sy > H + tile) continue;
        drawRubblePile(sx, sy, rngAt(rb.x, rb.y), gem, rock);
    }
    if (snap.gems) for (const gm of snap.gems) {
        const [sx, sy] = screenPos(gm.x, gm.y, cam, cosr, sinr, ax, ay);
        const size = tile * (0.26 + ((gm.v - 10) / 30) * 0.24);
        if (sx < -tile * 2 || sx > W + tile * 2 || sy < -tile * 2 || sy > H + tile * 2) continue;
        drawCrystal(sx, sy, size, rngAt(gm.x, gm.y), gem, now, gm.x * 12.9 + gm.y * 7.7);
    }
}

// ---- Retro HUD ----
const HUD = {
    neon: "#4ff2c8",
    dim: "rgba(79,242,200,0.30)",
    amber: "#ffcf4d",
    ink: "#03110c",
    panel: "rgba(4,12,12,0.55)",
    font: '"Courier New", ui-monospace, monospace',
};
const DIR = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// Compass bearing (deg) of a world offset, matching the heading convention
// (0 = up/-y, increasing clockwise). Forward = (sin h, -cos h).
function bearingTo(dx, dy) { return Math.atan2(dx, -dy) * 180 / Math.PI; }
// Signed smallest difference a - b, wrapped to (-180, 180].
function angleDelta(a, b) { return ((a - b + 540) % 360) - 180; }

function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
function panel(x, y, w, h, r) {
    rr(x, y, w, h, r == null ? Math.min(10, h * 0.22) : r);
    ctx.fillStyle = HUD.panel; ctx.fill();
    ctx.lineWidth = Math.max(1.5, h * 0.045);
    ctx.strokeStyle = HUD.neon;
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
}
function text(str, x, y, size, color, align, glow) {
    ctx.font = `bold ${size}px ${HUD.font}`;
    ctx.textAlign = align || "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color;
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
    ctx.fillText(str, x, y);
    ctx.shadowBlur = 0;
}

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

function drawScorePanel(x, y, w, h) {
    panel(x, y, w, h);
    const rx = x + w - h * 0.3;
    const score = snap.score || 0;
    const dist = Math.round(Math.hypot(snap.player.x, snap.player.y));
    text("SCORE", rx, y + h * 0.3, Math.max(9, h * 0.2), HUD.dim, "right", 0);
    text(String(score), rx, y + h * 0.63, Math.max(14, h * 0.42), HUD.neon, "right", 8);
    text("DIST " + dist + "m", rx, y + h * 0.9, Math.max(10, h * 0.24), HUD.amber, "right", 6);
}

function drawCompass(cam, x, y, w, h) {
    panel(x, y, w, h);
    const cx = x + w / 2;
    const VIS = 100;                       // degrees shown across the strip
    const ppd = w / VIS;
    const bearing = ((cam.h * 180 / Math.PI) % 360 + 360) % 360;
    ctx.save();
    rr(x + 2, y + 2, w - 4, h - 4, Math.min(9, h * 0.2)); ctx.clip();
    const first = Math.ceil((bearing - VIS / 2) / 15) * 15;
    for (let d = first; d <= bearing + VIS / 2; d += 15) {
        const px = cx + (d - bearing) * ppd;
        const major = ((((d % 45) + 45) % 45) === 0);
        ctx.strokeStyle = major ? HUD.neon : HUD.dim;
        ctx.lineWidth = major ? Math.max(1.5, h * 0.04) : Math.max(1, h * 0.02);
        const th = major ? h * 0.3 : h * 0.16;
        ctx.beginPath();
        ctx.moveTo(px, y + h * 0.58); ctx.lineTo(px, y + h * 0.58 + th); ctx.stroke();
        if (major) {
            const lbl = DIR[((Math.round(d / 45) % 8) + 8) % 8];
            text(lbl, px, y + h * 0.44, Math.max(10, h * 0.32), HUD.neon, "center", 6);
        }
    }
    ctx.restore();

    // ---- Radar overlay: nearby gems + the way home ----
    const laneY = y + h * 0.30;
    ctx.save();
    rr(x + 2, y + 2, w - 4, h - 4, Math.min(9, h * 0.2)); ctx.clip();
    if (snap.gems && snap.gems.length) {
        const gemCol = snap.colors.gem;
        const near = [];
        for (const gm of snap.gems) {
            const dx = gm.x - cam.x, dy = gm.y - cam.y, dist = Math.hypot(dx, dy);
            if (dist > RADAR_RADIUS) continue;
            const delta = angleDelta(bearingTo(dx, dy), bearing);
            if (Math.abs(delta) <= VIS / 2) near.push({ delta, dist });
        }
        near.sort((a, b) => a.dist - b.dist);
        ctx.shadowColor = gemCol; ctx.fillStyle = gemCol;
        for (let i = Math.min(near.length, RADAR_MAX) - 1; i >= 0; i--) {
            const b = near[i], t = 1 - b.dist / RADAR_RADIUS;   // 0 far .. 1 close
            const bx = cx + b.delta * ppd, sz = h * (0.06 + 0.1 * t);
            ctx.globalAlpha = 0.35 + 0.55 * t; ctx.shadowBlur = 6 * t;
            ctx.beginPath();
            ctx.moveTo(bx, laneY - sz); ctx.lineTo(bx + sz, laneY);
            ctx.lineTo(bx, laneY + sz); ctx.lineTo(bx - sz, laneY);
            ctx.closePath(); ctx.fill();
        }
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    }
    ctx.restore();

    // Home marker: points at the origin, clamped to the strip edge when off-window.
    const hDelta = angleDelta(bearingTo(-cam.x, -cam.y), bearing);
    const inWin = Math.abs(hDelta) <= VIS / 2;
    const hx = inWin ? cx + hDelta * ppd : (hDelta > 0 ? x + w - h * 0.22 : x + h * 0.22);
    drawHomeMarker(hx, laneY, h, inWin, hDelta > 0);

    // Fixed centre marker (your heading).
    ctx.fillStyle = HUD.amber; ctx.shadowColor = HUD.amber; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(cx, y + h * 0.34);
    ctx.lineTo(cx - h * 0.13, y + h * 0.06);
    ctx.lineTo(cx + h * 0.13, y + h * 0.06);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
}

function drawHomeMarker(hx, ly, h, inWin, toRight) {
    const s = h * 0.13;
    ctx.save();
    ctx.fillStyle = HUD.amber; ctx.shadowColor = HUD.amber; ctx.shadowBlur = 6;
    ctx.beginPath();                              // house body
    ctx.moveTo(hx - s, ly - s * 0.1); ctx.lineTo(hx - s, ly + s);
    ctx.lineTo(hx + s, ly + s); ctx.lineTo(hx + s, ly - s * 0.1);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();                              // roof
    ctx.moveTo(hx - s * 1.3, ly - s * 0.1); ctx.lineTo(hx, ly - s * 1.15);
    ctx.lineTo(hx + s * 1.3, ly - s * 0.1); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    if (!inWin) {                                 // nudge arrow toward the edge
        const ax = hx + (toRight ? s * 1.8 : -s * 1.8), dir = toRight ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(ax, ly); ctx.lineTo(ax - dir * s, ly - s * 0.7);
        ctx.lineTo(ax - dir * s, ly + s * 0.7); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
}

function drawSpeedo(cx, cy, r) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = "rgba(4,12,12,0.62)"; ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.05); ctx.strokeStyle = HUD.neon;
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
    const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
    const maxV = snap.max_speed || 9;
    const frac = Math.max(0, Math.min(1, snap.player.speed / maxV));
    for (let i = 0; i <= 10; i++) {
        const f = i / 10, a = A0 + f * SWEEP, c = Math.cos(a), s = Math.sin(a);
        const inner = (i % 2 === 0) ? r * 0.66 : r * 0.76, outer = r * 0.86;
        ctx.strokeStyle = f <= frac ? HUD.neon : HUD.dim;
        ctx.lineWidth = (i % 2 === 0) ? Math.max(1.5, r * 0.045) : Math.max(1, r * 0.02);
        ctx.beginPath();
        ctx.moveTo(cx + c * inner, cy + s * inner);
        ctx.lineTo(cx + c * outer, cy + s * outer); ctx.stroke();
        if (i % 2 === 0) {
            text(String(i * 10), cx + c * r * 0.52, cy + s * r * 0.52 + r * 0.06,
                Math.max(8, r * 0.15), HUD.dim, "center", 0);
        }
    }
    const na = A0 + frac * SWEEP;
    ctx.strokeStyle = HUD.amber; ctx.shadowColor = HUD.amber; ctx.shadowBlur = 8;
    ctx.lineWidth = Math.max(2, r * 0.05); ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(na) * r * 0.12, cy - Math.sin(na) * r * 0.12);
    ctx.lineTo(cx + Math.cos(na) * r * 0.7, cy + Math.sin(na) * r * 0.7); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = HUD.amber; ctx.beginPath(); ctx.arc(cx, cy, r * 0.08, 0, TAU); ctx.fill();
    text(String(Math.round(frac * 100)), cx, cy + r * 0.52, Math.max(12, r * 0.34), HUD.neon, "center", 6);
    text("SPD", cx, cy + r * 0.74, Math.max(8, r * 0.15), HUD.dim, "center", 0);
}

// Energy colour ramp: red (empty) -> amber (half) -> green (full).
const E_RED = [255, 90, 77], E_YEL = [255, 207, 77], E_GRN = [62, 240, 122];
function energyColor(f) {
    return f >= 0.5 ? mix(E_YEL, E_GRN, (f - 0.5) * 2) : mix(E_RED, E_YEL, f * 2);
}

function drawBattery(x, y, w, h, frac) {
    frac = Math.max(0, Math.min(1, frac));
    const nub = w * 0.06, bw = w - nub;
    const tip = energyColor(frac);
    rr(x, y, bw, h, Math.min(6, h * 0.2));
    ctx.fillStyle = "rgba(4,12,12,0.62)"; ctx.fill();
    ctx.lineWidth = Math.max(1.5, h * 0.08); ctx.strokeStyle = HUD.neon;
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.fillStyle = css(tip); ctx.fillRect(x + bw, y + h * 0.3, nub, h * 0.4);

    const pad = h * 0.18;
    const inX = x + pad, inY = y + pad, inW = bw - 2 * pad, inH = h - 2 * pad;
    const fillW = inW * frac;
    if (fillW > 0.5) {
        ctx.save();
        rr(inX, inY, inW, inH, Math.min(4, h * 0.12)); ctx.clip();
        const g = ctx.createLinearGradient(inX, 0, inX + inW, 0);
        g.addColorStop(0, css(E_RED));
        g.addColorStop(0.5, css(E_YEL));
        g.addColorStop(1, css(E_GRN));
        ctx.fillStyle = g;
        ctx.shadowColor = css(tip); ctx.shadowBlur = 8;
        ctx.fillRect(inX, inY, fillW, inH);
        ctx.shadowBlur = 0;
        ctx.restore();
    }
    // Retro segment dividers punched through the fill.
    ctx.strokeStyle = "rgba(4,12,12,0.85)"; ctx.lineWidth = Math.max(1, w * 0.012);
    for (let i = 1; i < 10; i++) {
        const sx = inX + inW * (i / 10);
        ctx.beginPath(); ctx.moveTo(sx, inY); ctx.lineTo(sx, inY + inH); ctx.stroke();
    }
    // Percentage, outlined so it reads over any fill level.
    const pct = Math.round(frac * 100) + "%";
    const fs = Math.max(9, h * 0.36);
    ctx.font = `bold ${fs}px ${HUD.font}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, fs * 0.2); ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.strokeText(pct, x + bw / 2, y + h * 0.52);
    ctx.fillStyle = "#eafff8"; ctx.fillText(pct, x + bw / 2, y + h * 0.52);
    ctx.textBaseline = "alphabetic";
}

// Bottom-centre about-face button (Space). U-turn arrow; glows while flipping.
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

function drawHUD(cam, W, H) {
    const S = Math.min(W, H);
    const M = Math.max(8, S * 0.028);
    const topH = Math.max(30, Math.min(58, S * 0.085));
    drawHamburger(M, M, topH);
    hudHit.hamburger = { x: M, y: M, w: topH, h: topH };
    const scoreW = Math.max(96, Math.min(W * 0.34, S * 0.34));
    drawScorePanel(W - M - scoreW, M, scoreW, topH);
    const cLeft = M + topH + M, cRight = W - M - scoreW - M;
    if (cRight - cLeft > S * 0.14) drawCompass(cam, cLeft, M, cRight - cLeft, topH);
    const spR = Math.max(40, Math.min(94, S * 0.12));
    drawSpeedo(M + spR, H - M - spR, spR);
    const batW = Math.max(64, Math.min(140, S * 0.18)), batH = batW * 0.46;
    const energy = snap.energy == null ? 100 : snap.energy;
    drawBattery(W - M - batW, H - M - batH, batW, batH, energy / 100);
    const fbR = Math.max(20, Math.min(38, S * 0.05));
    const fbx = W / 2, fby = H - M - fbR;
    drawFlipButton(fbx, fby, fbR, snap.flipping);
    hudHit.flip = { x: fbx - fbR, y: fby - fbR, w: 2 * fbR, h: 2 * fbR };
}

// ---- Per-world tile textures (sandy floor, veined stone) ----
const NVAR = 6;                 // texture variants per tile kind
let atlas = null;               // { key, floor:[canvas], rock:[canvas] }

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
    if (atlas && atlas.key === key) return atlas;
    const floor = [], rock = [];
    for (let i = 0; i < NVAR; i++) {
        floor.push(makeFloorTile(ps, floorHex, i));
        rock.push(makeRockTile(ps, rockHex, i));
    }
    atlas = { key, floor, rock };
    return atlas;
}

function roundRectPath(c, x, y, w, h, tl, tr, br, bl) {
    c.beginPath();
    c.moveTo(x + tl, y);
    c.arcTo(x + w, y, x + w, y + h, tr);
    c.arcTo(x + w, y + h, x, y + h, br);
    c.arcTo(x, y + h, x, y, bl);
    c.arcTo(x, y, x + w, y, tl);
    c.closePath();
}

function drawWorld(cam, ax, ay) {
    const { tiles, colors, x0, y0 } = snap;
    const rows = tiles.length, cols = tiles[0].length;
    const at = ensureAtlas(colors.floor, colors.rock);
    const half = tile / 2, sz = tile + 1, rad = tile * 0.3;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(-cam.h);                     // rotate the world so heading points up
    for (let r = 0; r < rows; r++) {
        const wy = y0 + r, row = tiles[r];
        const ry = Math.round((wy - cam.y) * tile - half);
        for (let c = 0; c < cols; c++) {
            const rx = Math.round((x0 + c - cam.x) * tile - half);
            const vi = (rngAt(x0 + c, wy)() * NVAR) | 0;
            if (row[c]) {
                ctx.drawImage(at.floor[vi], rx, ry, sz, sz);
                continue;
            }
            // Round only corners exposed to floor, so rock masses stay solid.
            const up = r > 0 ? tiles[r - 1][c] : false;
            const dn = r < rows - 1 ? tiles[r + 1][c] : false;
            const lf = c > 0 ? row[c - 1] : false;
            const rt = c < cols - 1 ? row[c + 1] : false;
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

// ---- Player: a retro mining robot, always drawn facing up ----
// Sized to fill ~one tile so the sprite matches the tile-based collision hitbox.
function drawRobot(cx, cy, u, colors, now) {
    ctx.save();
    ctx.translate(cx, cy);
    const eye = "#5ffbe0", accent = colors.player;
    ctx.lineJoin = "round";

    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.beginPath(); ctx.ellipse(0, u * 0.40, u * 0.44, u * 0.18, 0, 0, TAU); ctx.fill();

    // Treads down each side.
    const tW = u * 0.2, tH = u * 0.66, tX = u * 0.3, tY = -u * 0.3;
    for (const sgn of [-1, 1]) {
        rr(sgn * tX - tW / 2, tY, tW, tH, u * 0.06);
        ctx.fillStyle = "#33393f"; ctx.fill();
        ctx.lineWidth = Math.max(1, u * 0.02); ctx.strokeStyle = "#12151a"; ctx.stroke();
        ctx.fillStyle = "#1c2024";
        for (let i = 0; i < 5; i++) {
            const ly = tY + u * 0.06 + i * (tH - u * 0.12) / 4;
            ctx.fillRect(sgn * tX - tW / 2 + u * 0.02, ly, tW - u * 0.04, u * 0.03);
        }
    }

    // Drill, pointing up.
    const dTip = -u * 0.46, dBase = -u * 0.2, dW = u * 0.16;
    const dg = ctx.createLinearGradient(-dW, 0, dW, 0);
    dg.addColorStop(0, "#9aa3b2"); dg.addColorStop(0.5, "#eef2f7"); dg.addColorStop(1, "#6b7280");
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.moveTo(0, dTip); ctx.lineTo(dW, dBase); ctx.lineTo(-dW, dBase); ctx.closePath();
    ctx.fill(); ctx.lineWidth = Math.max(1, u * 0.02); ctx.strokeStyle = "#2a2f38"; ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    for (let i = 1; i <= 2; i++) {
        const t = i / 3, yy = dBase - (dBase - dTip) * t;
        ctx.beginPath(); ctx.moveTo(-dW * (1 - t), yy); ctx.lineTo(dW * (1 - t), yy - u * 0.03); ctx.stroke();
    }

    // Body.
    const bx = -u * 0.28, by = -u * 0.12, bw = u * 0.56, bh = u * 0.46;
    const bg = ctx.createLinearGradient(0, by, 0, by + bh);
    bg.addColorStop(0, "#cfd6e0"); bg.addColorStop(1, "#8b93a1");
    rr(bx, by, bw, bh, u * 0.12); ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = Math.max(1.5, u * 0.03); ctx.strokeStyle = "#2a2f38"; ctx.stroke();
    rr(bx, by + bh * 0.52, bw, bh * 0.2, u * 0.04); ctx.fillStyle = accent; ctx.fill();

    // Head with a glowing visor.
    const hx = -u * 0.2, hy = -u * 0.28, hw = u * 0.4, hh = u * 0.22;
    rr(hx, hy, hw, hh, u * 0.08);
    const hg = ctx.createLinearGradient(0, hy, 0, hy + hh);
    hg.addColorStop(0, "#eef2f7"); hg.addColorStop(1, "#aab2c0");
    ctx.fillStyle = hg; ctx.fill();
    ctx.lineWidth = Math.max(1, u * 0.025); ctx.strokeStyle = "#2a2f38"; ctx.stroke();
    rr(hx + hw * 0.14, hy + hh * 0.3, hw * 0.72, hh * 0.42, u * 0.04);
    ctx.fillStyle = eye; ctx.shadowColor = eye; ctx.shadowBlur = u * 0.25; ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillRect(hx + hw * 0.2, hy + hh * 0.36, hw * 0.16, hh * 0.28);

    // Corner bolts.
    ctx.fillStyle = "#6b7280";
    for (const [sx, sy] of [[bx + u * 0.05, by + u * 0.05], [bx + bw - u * 0.05, by + u * 0.05],
    [bx + u * 0.05, by + bh - u * 0.05], [bx + bw - u * 0.05, by + bh - u * 0.05]]) {
        ctx.beginPath(); ctx.arc(sx, sy, u * 0.03, 0, TAU); ctx.fill();
    }

    // Antenna with a blinking beacon.
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = Math.max(1, u * 0.02);
    ctx.beginPath(); ctx.moveTo(hx + hw * 0.16, hy); ctx.lineTo(hx + hw * 0.02, hy - u * 0.14); ctx.stroke();
    const blink = 0.5 + 0.5 * Math.sin(now / 200);
    ctx.fillStyle = `rgba(255,80,80,${0.5 + 0.5 * blink})`;
    ctx.shadowColor = "#ff5050"; ctx.shadowBlur = u * 0.2 * blink;
    ctx.beginPath(); ctx.arc(hx + hw * 0.02, hy - u * 0.15, u * 0.035, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;

    ctx.restore();
}

// ---- Wall-bump red screen flash ----
let bumpPeak = 0, bumpStart = 0;
const BUMP_MS = 450;
function bumpGlow() {
    const t = (performance.now() - bumpStart) / BUMP_MS;
    return t >= 1 ? 0 : bumpPeak * (1 - t * t);
}

function draw() {
    requestAnimationFrame(draw);
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = canvas.width / dpr, H = canvas.height / dpr;

    ctx.fillStyle = "#05080a";
    ctx.fillRect(0, 0, W, H);
    if (!snap) {
        text("CONNECTING…", W / 2, H / 2, Math.max(14, Math.min(W, H) * 0.04),
            HUD.neon, "center", 10);
        return;
    }

    const cam = currentCam();
    const colors = snap.colors;
    const ax = W / 2, ay = H * ANCHOR_Y;   // player anchor on screen

    drawWorld(cam, ax, ay);
    drawGems(cam, ax, ay, W, H, colors);
    drawRobot(ax, ay, tile, colors, performance.now());

    // Brief red vignette that fades after a wall bump.
    const flash = bumpGlow();
    if (flash > 0.002) {
        const g = ctx.createRadialGradient(
            W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
        g.addColorStop(0, "rgba(255,40,40,0)");
        g.addColorStop(1, `rgba(255,60,60,${flash})`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    drawHUD(cam, W, H);
}

function onSnapshot(s) {
    const p = s.player;
    camFrom = haveCam ? currentCam() : { x: p.x, y: p.y, h: p.heading };
    camTo = { x: p.x, y: p.y, h: p.heading };
    segStart = performance.now();
    segDur = s.tick_ms || 50;
    haveCam = true;
    snap = s;
    if (s.seed && typeof s.score === "number") bumpHi(s.seed, s.style, s.score);
    if (s.bump && s.max_speed) {           // wall hit: kick off the red flash
        const i = Math.min(0.38, 0.12 + (s.bump / s.max_speed) * 0.5);
        if (i > bumpGlow()) { bumpPeak = i; bumpStart = performance.now(); }
    }
    if (s.dead && !gameOver) showGameOver();
    else if (!s.dead) gameOver = false;
}

// Held-key controls: Up throttle, Down brake, Left/Right steer.
const KEYS = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};
const held = { up: false, down: false, left: false, right: false };
function sendControls() { send({ action: "controls", ...held }); }

window.addEventListener("keydown", (e) => {
    if (!playing) return;      // menu is up; let the DOM handle keys
    const k = KEYS[e.key];
    if (k) {
        e.preventDefault();
        if (!held[k]) { held[k] = true; sendControls(); }
    } else if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) send({ action: "flip" });   // about-face
    } else if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        const next = tile + (e.key === "PageUp" ? ZOOM_STEP : -ZOOM_STEP);
        tile = Math.max(MIN_TILE, Math.min(MAX_TILE, next));
        reportViewport();
    }
});
window.addEventListener("keyup", (e) => {
    if (!playing) return;
    const k = KEYS[e.key];
    if (k) { e.preventDefault(); held[k] = false; sendControls(); }
});
window.addEventListener("blur", () => {
    let changed = false;
    for (const k in held) if (held[k]) { held[k] = false; changed = true; }
    if (changed) sendControls();
});
window.addEventListener("resize", reportViewport);

// Tap the on-canvas hamburger (top-left) to open the pause overlay.
canvas.addEventListener("click", (e) => {
    if (!playing) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const hit = (b) => b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    if (hit(hudHit.hamburger)) openPause();
    else if (hit(hudHit.flip)) send({ action: "flip" });
});

// Stable per-browser token so a reconnect resumes the same run (position,
// score, mined gems) instead of starting over.
let token = localStorage.getItem("gembot-token");
if (!token) {
    token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("gembot-token", token);
}

function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
        reportViewport();
        if (pending) { send({ action: "seed", seed: pending.seed, style: pending.style }); pending = null; }
        else sendActive(playing);   // resync run state after a reconnect
    };
    ws.onmessage = (ev) => onSnapshot(JSON.parse(ev.data));
    ws.onclose = () => setTimeout(connect, 1000);
}
connect();
requestAnimationFrame(draw);

// ---- Main menu (opening screen) ----
const menuEl = document.getElementById("menu");
const howtoEl = document.getElementById("howto");
const dateValEl = document.getElementById("dateVal");
const hiScoreEl = document.getElementById("hiScore");
const modesEl = document.getElementById("modes");

let menuDate = new Date();
let menuMode = "dungeon";
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function isoLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
function displayDate(d) { return `${WEEKDAYS[d.getDay()]} ${isoLocal(d)}`; }

// High score per (day, mode), kept in this browser.
function hiKey(iso, mode) { return `gembot-hs:${iso}:${mode}`; }
function getHi(iso, mode) { return parseInt(localStorage.getItem(hiKey(iso, mode)) || "0", 10) || 0; }
function bumpHi(iso, mode, score) {
    if (score > getHi(iso, mode)) localStorage.setItem(hiKey(iso, mode), String(score));
}

function updateMenu() {
    dateValEl.textContent = displayDate(menuDate);
    for (const b of modesEl.querySelectorAll(".mode")) {
        b.classList.toggle("active", b.dataset.mode === menuMode);
    }
    hiScoreEl.textContent = getHi(isoLocal(menuDate), menuMode);
}
function shiftDate(delta) { menuDate.setDate(menuDate.getDate() + delta); updateMenu(); }

document.getElementById("datePrev").addEventListener("click", () => shiftDate(-1));
document.getElementById("dateNext").addEventListener("click", () => shiftDate(1));
for (const b of modesEl.querySelectorAll(".mode")) {
    b.addEventListener("click", () => { menuMode = b.dataset.mode; updateMenu(); });
}

document.getElementById("playBtn").addEventListener("click", () => {
    const seed = isoLocal(menuDate);
    pending = { seed, style: menuMode };
    if (ws && ws.readyState === WebSocket.OPEN) {
        send({ action: "seed", seed, style: menuMode });
        pending = null;
    }
    menuEl.classList.add("hidden");
    playing = true;
    reportViewport();
});
document.getElementById("howBtn").addEventListener("click", () => {
    menuEl.classList.add("hidden");
    openHowto(menuEl);
});
document.getElementById("backBtn").addEventListener("click", () => {
    howtoEl.classList.add("hidden");
    (howReturnEl || menuEl).classList.remove("hidden");
});

// ---- In-game pause overlay (opened from the HUD hamburger) ----
const pauseEl = document.getElementById("pause");
let howReturnEl = menuEl;       // screen to restore when How-to's Back is pressed

function openHowto(fromEl) {
    howReturnEl = fromEl;
    howtoEl.classList.remove("hidden");
}

function releaseKeys() {
    let changed = false;
    for (const k in held) if (held[k]) { held[k] = false; changed = true; }
    if (changed) sendControls();
}

function openPause() {
    releaseKeys();          // don't leave the vehicle driving while paused
    playing = false;
    sendActive(false);      // freeze physics + energy drain server-side
    pauseEl.classList.remove("hidden");
}

function resume() {
    pauseEl.classList.add("hidden");
    playing = true;
    sendActive(true);
}

document.getElementById("resumeBtn").addEventListener("click", resume);
document.getElementById("homeBtn").addEventListener("click", () => {
    pauseEl.classList.add("hidden");
    menuEl.classList.remove("hidden");
    updateMenu();               // refresh the high score for the current run
});
document.getElementById("restartBtn").addEventListener("click", () => {
    if (snap && snap.seed) send({ action: "seed", seed: snap.seed, style: snap.style });
    resume();                   // back to the origin, same day + mode
});
document.getElementById("pauseHowBtn").addEventListener("click", () => {
    pauseEl.classList.add("hidden");
    openHowto(pauseEl);
});

// ---- Game over ----
const gameoverEl = document.getElementById("gameover");
const finalScoreEl = document.getElementById("finalScore");

function showGameOver() {
    gameOver = true;
    playing = false;
    releaseKeys();
    pauseEl.classList.add("hidden");     // in case it was open
    finalScoreEl.textContent = snap ? snap.score : 0;
    gameoverEl.classList.remove("hidden");
}

document.getElementById("againBtn").addEventListener("click", () => {
    if (snap && snap.seed) send({ action: "seed", seed: snap.seed, style: snap.style });
    gameoverEl.classList.add("hidden");
    playing = true;                      // seed action restarts the run server-side
});
document.getElementById("goHomeBtn").addEventListener("click", () => {
    gameoverEl.classList.add("hidden");
    menuEl.classList.remove("hidden");
    updateMenu();
});

updateMenu();
