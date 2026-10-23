// The dashboard drawn on the canvas: compass + radar, score, speedometer, cargo,
// buttons, toasts and warning banners. Click targets go in hudHit each frame.

const RADAR_RADIUS = 45;       // tiles: how far the compass radar spots gems
const RADAR_MEGA = 220;        // mega gems are visible from much farther away
const RADAR_MAX = 12;          // most gem blips shown on the compass at once
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

function drawCompass(cam, x, y, w, h) {
    panel(x, y, w, h);
    const cx = x + w / 2;
    const VIS = 100;                       // degrees shown across the strip
    const ppd = w / VIS;
    const bearing = ((cam.rh * 180 / Math.PI) % 360 + 360) % 360;
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
    const gemCol = curColors().gem;
    const near = [];
    for (const c of chunks.values()) {
        for (const g of c.gems) {
            const key = g[0] + "," + g[1];
            if (mined.has(key)) continue;
            const mega = c.mega.has(key), reach = mega ? RADAR_MEGA : RADAR_RADIUS;
            const dx = g[0] - cam.x, dy = g[1] - cam.y, dist = Math.hypot(dx, dy);
            if (dist > reach) continue;
            const delta = angleDelta(bearingTo(dx, dy), bearing);
            if (Math.abs(delta) <= VIS / 2) near.push({ delta, dist, mega, reach });
        }
    }
    near.sort((a, b) => a.dist / a.reach - b.dist / b.reach);
    for (let i = Math.min(near.length, RADAR_MAX) - 1; i >= 0; i--) {
        const b = near[i], t = 1 - b.dist / b.reach;       // 0 far .. 1 close
        const col = b.mega ? "#ffd64d" : gemCol;
        const bx = cx + b.delta * ppd, sz = h * ((b.mega ? 0.1 : 0.06) + 0.1 * t);
        ctx.fillStyle = col; ctx.shadowColor = col;
        ctx.globalAlpha = 0.35 + 0.55 * t; ctx.shadowBlur = 6 * t;
        ctx.beginPath();
        ctx.moveTo(bx, laneY - sz); ctx.lineTo(bx + sz, laneY);
        ctx.lineTo(bx, laneY + sz); ctx.lineTo(bx - sz, laneY);
        ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
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
    const maxV = G.maxSpeed || 15;
    const frac = Math.max(0, Math.min(1, G.speed / maxV));
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

// Score panel (top-right): banked score, rank, and the way home.
function drawScorePanel(x, y, w, h) {
    panel(x, y, w, h);
    const rx = x + w - h * 0.3;
    const dist = Math.max(0, Math.round(Math.hypot(G.x, G.y) - G.baseR));
    text("SCORE" + (G.rank ? `  #${G.rank}` : ""), rx, y + h * 0.3, Math.max(9, h * 0.2), HUD.dim, "right", 0);
    text(String(G.score), rx, y + h * 0.63, Math.max(14, h * 0.42), HUD.neon, "right", 8);
    text(dist > 0 ? `BASE ${dist}m` : "AT BASE", rx, y + h * 0.9, Math.max(10, h * 0.24), HUD.amber, "right", 6);
}

// Cargo (bottom-right): gems on board that only count once delivered to the base.
function drawCargoPanel(x, y, w, h) {
    panel(x, y, w, h);
    const gem = hexRgb(curColors().gem), has = G.cargo > 0;
    const gx = x + h * 0.42, gy = y + h * 0.52, gs = h * 0.22;
    ctx.save();
    ctx.fillStyle = css(has ? gem : mix(gem, [60, 60, 60], 0.7));
    ctx.shadowColor = css(gem); ctx.shadowBlur = has ? 10 : 0;
    ctx.beginPath();
    ctx.moveTo(gx, gy - gs * 1.1); ctx.lineTo(gx + gs, gy - gs * 0.1); ctx.lineTo(gx + gs * 0.6, gy + gs);
    ctx.lineTo(gx - gs * 0.6, gy + gs); ctx.lineTo(gx - gs, gy - gs * 0.1); ctx.closePath();
    ctx.fill();
    ctx.restore();
    const rx = x + w - h * 0.2;
    text("CARGO", rx, y + h * 0.3, Math.max(9, h * 0.2), HUD.dim, "right", 0);
    text(String(G.cargo), rx, y + h * 0.7, Math.max(14, h * 0.4), has ? HUD.amber : HUD.dim, "right", has ? 8 : 0);
    if (has && Math.hypot(G.x, G.y) > G.baseR) {
        text("DELIVER TO BASE", rx, y + h * 0.92, Math.max(8, h * 0.16), HUD.amber, "right", 0);
    }
}

// Round icon buttons beside the about-face button.
function drawIconButton(cx, cy, r, kind, on) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = on ? "rgba(79,242,200,0.22)" : "rgba(4,12,12,0.62)"; ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.09); ctx.strokeStyle = HUD.neon;
    ctx.shadowColor = HUD.neon; ctx.shadowBlur = on ? 12 : 7; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.strokeStyle = HUD.neon; ctx.fillStyle = HUD.neon;
    ctx.lineWidth = Math.max(2, r * 0.1); ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (kind === "chat") {
        const w2 = r * 0.5, h2 = r * 0.32;
        rr(cx - w2, cy - h2 - r * 0.08, w2 * 2, h2 * 2, r * 0.2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - w2 * 0.5, cy + h2 - r * 0.08); ctx.lineTo(cx - w2 * 0.7, cy + h2 + r * 0.26);
        ctx.lineTo(cx - w2 * 0.1, cy + h2 - r * 0.08); ctx.stroke();
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(cx + i * r * 0.24, cy - r * 0.08, r * 0.05, 0, TAU); ctx.fill(); }
    } else {
        for (const [dx, s] of [[-0.3, 0.8], [0.3, 0.8], [0, 1]]) {
            const px = cx + dx * r, py = cy + r * 0.02, hr = r * 0.17 * s;
            ctx.beginPath(); ctx.arc(px, py - r * 0.2, hr, 0, TAU); ctx.stroke();
            ctx.beginPath(); ctx.arc(px, py + r * 0.42 * s, r * 0.3 * s, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
        }
    }
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

function drawHUD(cam, W, H) {
    const S = Math.min(W, H);
    const M = Math.max(8, S * 0.028);
    const touch = typeof touchMode !== "undefined" && touchMode;
    const topH = Math.max(30, Math.min(58, S * 0.085));
    drawHamburger(M, M, topH);
    hudHit.hamburger = { x: M, y: M, w: topH, h: topH };
    const scoreW = Math.max(110, Math.min(W * 0.34, S * 0.36));
    drawScorePanel(W - M - scoreW, M, scoreW, topH);
    hudHit.score = { x: W - M - scoreW, y: M, w: scoreW, h: topH };
    const cLeft = M + topH + M, cRight = W - M - scoreW - M;
    if (cRight - cLeft > S * 0.14) drawCompass(cam, cLeft, M, cRight - cLeft, topH);
    const spR = Math.max(40, Math.min(94, S * 0.12));
    drawSpeedo(M + spR, H - M - spR, spR);
    const cw = Math.max(96, Math.min(170, S * 0.26)), ch = cw * 0.42;
    drawCargoPanel(W - M - cw, H - M - ch, cw, ch);

    // Bottom-centre: chat, about-face (thumb-sized on touch), players.
    const fbR = touch ? Math.max(28, Math.min(46, S * 0.075)) : Math.max(20, Math.min(38, S * 0.05));
    const fbx = W / 2, fby = H - M - fbR, sbR = fbR * 0.78, gap = fbR + sbR + M * 0.6;
    drawFlipButton(fbx, fby, fbR, G.flipping);
    hudHit.flip = { x: fbx - fbR, y: fby - fbR, w: 2 * fbR, h: 2 * fbR };
    drawIconButton(fbx - gap, fby + (fbR - sbR), sbR, "chat", false);
    hudHit.chat = { x: fbx - gap - sbR, y: fby + (fbR - sbR) - sbR, w: 2 * sbR, h: 2 * sbR };
    drawIconButton(fbx + gap, fby + (fbR - sbR), sbR, "players", false);
    hudHit.players = { x: fbx + gap - sbR, y: fby + (fbR - sbR) - sbR, w: 2 * sbR, h: 2 * sbR };

    const clockH = drawDayClock(W, M + topH + M * 0.6);
    drawToasts(W, M + topH + M * 0.6 + clockH + 4);
    if (G.idleUntil > performance.now()) {
        drawBanner(W, H, `STILL THERE?  MOVE WITHIN ${Math.ceil((G.idleUntil - performance.now()) / 1000)}s`, "#ff5a4d");
    } else if (!G.connected && wantPlaying) {
        drawBanner(W, H, "RECONNECTING…", HUD.amber);
    }
}
