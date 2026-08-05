const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");

const MARGIN = 4;              // extra viewport tiles beyond what rotation needs
const MIN_TILE = 10, MAX_TILE = 60, ZOOM_STEP = 3;
const ANCHOR_Y = 0.75;         // player sits 75% down the screen (more map ahead)
let tile = 26;
let ws = null;
let snap = null;               // latest server snapshot
// Camera interpolation (world-tile coords + heading in radians).
let camFrom = { x: 0, y: 0, h: 0 }, camTo = { x: 0, y: 0, h: 0 };
let segStart = 0, segDur = 50, haveCam = false;
let playing = false;           // false while the main menu is showing
let pending = null;            // {seed, style} to apply once the socket is open

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

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
    // Fixed centre marker (your heading).
    ctx.fillStyle = HUD.amber; ctx.shadowColor = HUD.amber; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(cx, y + h * 0.34);
    ctx.lineTo(cx - h * 0.13, y + h * 0.06);
    ctx.lineTo(cx + h * 0.13, y + h * 0.06);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
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

function drawBattery(x, y, w, h) {
    const nub = w * 0.06, bw = w - nub;
    rr(x, y, bw, h, Math.min(6, h * 0.2));
    ctx.fillStyle = "rgba(4,12,12,0.62)"; ctx.fill();
    ctx.lineWidth = Math.max(1.5, h * 0.08); ctx.strokeStyle = HUD.neon;
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.fillStyle = HUD.neon; ctx.fillRect(x + bw, y + h * 0.3, nub, h * 0.4);
    // Segments — 100% for now, so all filled.
    const pad = h * 0.18, gap = bw * 0.03, segs = 4;
    const inX = x + pad, inY = y + pad, inW = bw - 2 * pad, inH = h - 2 * pad;
    const sw = (inW - gap * (segs - 1)) / segs;
    ctx.fillStyle = HUD.neon; ctx.shadowColor = HUD.neon; ctx.shadowBlur = 6;
    for (let i = 0; i < segs; i++) ctx.fillRect(inX + i * (sw + gap), inY, sw, inH);
    ctx.shadowBlur = 0;
    text("100%", x + bw / 2, y + h * 0.66, Math.max(9, h * 0.36), HUD.ink, "center", 0);
}

function drawHUD(cam, W, H) {
    const S = Math.min(W, H);
    const M = Math.max(8, S * 0.028);
    const topH = Math.max(30, Math.min(58, S * 0.085));
    drawHamburger(M, M, topH);
    const scoreW = Math.max(96, Math.min(W * 0.34, S * 0.34));
    drawScorePanel(W - M - scoreW, M, scoreW, topH);
    const cLeft = M + topH + M, cRight = W - M - scoreW - M;
    if (cRight - cLeft > S * 0.14) drawCompass(cam, cLeft, M, cRight - cLeft, topH);
    const spR = Math.max(40, Math.min(94, S * 0.12));
    drawSpeedo(M + spR, H - M - spR, spR);
    const batW = Math.max(64, Math.min(140, S * 0.18)), batH = batW * 0.46;
    drawBattery(W - M - batW, H - M - batH, batW, batH);
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
    const { tiles, colors, x0, y0 } = snap;
    const rows = tiles.length, cols = tiles[0].length;
    const ax = W / 2, ay = H * ANCHOR_Y;   // player anchor on screen

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(-cam.h);                     // rotate the world so heading points up
    const half = tile / 2;
    for (let r = 0; r < rows; r++) {
        const wy = y0 + r, row = tiles[r];
        const ty = (wy - cam.y) * tile - half;
        for (let c = 0; c < cols; c++) {
            ctx.fillStyle = row[c] ? colors.floor : colors.rock;
            ctx.fillRect(Math.round((x0 + c - cam.x) * tile - half), Math.round(ty),
                tile + 1, tile + 1);
        }
    }
    ctx.restore();

    drawGems(cam, ax, ay, W, H, colors);

    // Player: an arrow at the anchor, always pointing up.
    const s = tile * 0.55;
    ctx.fillStyle = colors.player;
    ctx.beginPath();
    ctx.moveTo(ax, ay - s);
    ctx.lineTo(ax - s * 0.62, ay + s * 0.55);
    ctx.lineTo(ax, ay + s * 0.2);
    ctx.lineTo(ax + s * 0.62, ay + s * 0.55);
    ctx.closePath();
    ctx.fill();

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
    howtoEl.classList.remove("hidden");
});
document.getElementById("backBtn").addEventListener("click", () => {
    howtoEl.classList.add("hidden");
    menuEl.classList.remove("hidden");
});

updateMenu();
