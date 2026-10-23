// Shared helpers and globals used by every script (classic scripts, load order matters).
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");
const TAU = Math.PI * 2;
let tile = 26;                 // pixels per world tile (zoom)

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
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

function seededRng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const HUD = {
    neon: "#4ff2c8",
    dim: "rgba(79,242,200,0.30)",
    amber: "#ffcf4d",
    ink: "#03110c",
    panel: "rgba(4,12,12,0.55)",
    font: '"Courier New", ui-monospace, monospace',
};

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

function roundRectPath(c, x, y, w, h, tl, tr, br, bl) {
    c.beginPath();
    c.moveTo(x + tl, y);
    c.arcTo(x + w, y, x + w, y + h, tr);
    c.arcTo(x + w, y + h, x, y + h, br);
    c.arcTo(x, y + h, x, y, bl);
    c.arcTo(x, y, x + w, y, tl);
    c.closePath();
}
