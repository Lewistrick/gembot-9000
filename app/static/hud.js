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
    // Score and the way home.
    const rx = x + w - h * 0.3, sw = rx - mid - h * 0.15;
    const dist = Math.max(0, Math.round(Math.hypot(G.x, G.y) - G.baseR));
    text("SCORE" + (G.rank ? `  #${G.rank}` : ""), rx, y + h * 0.3, Math.max(9, h * 0.2), HUD.dim, "right", 0);
    const ss = String(G.score);
    text(ss, rx, y + h * 0.63, fitSize(ss, sw, Math.max(14, h * 0.42), 10), HUD.neon, "right", 8);
    text(dist > 0 ? `BASE ${dist}m` : "AT BASE", rx, y + h * 0.9, Math.max(10, h * 0.22), HUD.amber, "right", 6);
}

// Round icon buttons beside the about-face button. `on` false draws it dimmed (unavailable).
function drawIconButton(cx, cy, r, kind, on) {
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.45;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = "rgba(4,12,12,0.62)"; ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.09); ctx.strokeStyle = HUD.neon;
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = on ? 7 : 0; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.strokeStyle = HUD.neon; ctx.fillStyle = HUD.neon;
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
const MAP_RADIUS = 26;          // tiles shown in every direction
function drawMinimap(cam, x, y, size) {
    const r = size / 2, cx = x + r, cy = y + r, px = r / MAP_RADIUS, colors = curColors();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    ctx.fillStyle = colors.rock; ctx.fillRect(x, y, size, size);          // rock and anything not loaded yet
    ctx.translate(cx, cy); ctx.rotate(-cam.h);
    const ox = Math.round(cam.x), oy = Math.round(cam.y), n = MAP_RADIUS + 1;
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
    if (G.showMap) drawMinimap(cam, M, M + topH + gap0, Math.max(192, Math.min(380, S * 0.6, W * 0.8)));

    // Bottom centre: [hub | ship]  [about-face]  [travel], thumb-sized on touch.
    const fbR = touch ? Math.max(28, Math.min(46, S * 0.075)) : Math.max(20, Math.min(38, S * 0.05));
    const fbx = W / 2, fby = H - M - fbR, sbR = fbR * 0.78, gap = fbR + sbR + M * 0.6;
    const sby = fby + (fbR - sbR), cap = Math.max(8, S * 0.02);
    drawFlipButton(fbx, fby, fbR, G.flipping);
    hudHit.flip = { x: fbx - fbR, y: fby - fbR, w: 2 * fbR, h: 2 * fbR };
    const parked = typeof parkedHub === "function" && parkedHub();
    const box = (cx) => ({ x: cx - sbR, y: sby - sbR, w: 2 * sbR, h: 2 * sbR });
    hudHit.placeHub = hudHit.ship = hudHit.travel = null;
    if (parked) {
        // Parked on a hub: the only choices are to ship gems to the base or to travel.
        const ship = canShip(), go = canTravel();
        drawIconButton(fbx - gap, sby, sbR, "ship", ship);
        hudHit.ship = box(fbx - gap);
        text("SHIP", fbx - gap, sby - sbR - 5, cap, ship ? HUD.neon : HUD.dim, "center", 0);
        drawIconButton(fbx + gap, sby, sbR, "travel", go);
        hudHit.travel = box(fbx + gap);
        text("TRAVEL", fbx + gap, sby - sbR - 5, cap, go ? HUD.neon : HUD.dim, "center", 0);
        const title = typeof hubCaption === "function" ? hubCaption() : "";
        if (title) pillLabel(title, fbx, fby - fbR - cap * 1.9, HUD.amber, cap * 1.15);
    } else if (typeof canAffordHub === "function" && canAffordHub()) {
        // Only players who could pay for a hub see the button (dimmed until they stop).
        const can = canPlaceHub();
        drawIconButton(fbx - gap, sby, sbR, "hub", can);
        hudHit.placeHub = box(fbx - gap);
        text("HUB", fbx - gap, sby - sbR - 5, cap, can ? HUD.neon : HUD.dim, "center", 0);
    }

    const clockH = drawDayClock(W, M + topH + M * 0.6);
    drawToasts(W, M + topH + M * 0.6 + clockH + 4);
    if (G.idleUntil > performance.now()) {
        drawBanner(W, H, `STILL THERE?  MOVE WITHIN ${Math.ceil((G.idleUntil - performance.now()) / 1000)}s`, "#ff5a4d");
    } else if (!G.connected && wantPlaying) {
        drawBanner(W, H, "RECONNECTING…", HUD.amber);
    }
}
