// The render loop: world, gems, base, robots (with name tags and chat bubbles), HUD.

// ---- Wall-bump red screen flash ----
let bumpPeak = 0, bumpStart = 0;
const BUMP_MS = 450;
function bumpGlow() {
    const t = (performance.now() - bumpStart) / BUMP_MS;
    return t >= 1 ? 0 : bumpPeak * (1 - t * t);
}
function onBump(b) {
    const i = Math.min(0.38, 0.12 + (b / G.maxSpeed) * 0.5);
    if (i > bumpGlow()) { bumpPeak = i; bumpStart = performance.now(); }
}

function accent(hue) { return `hsl(${hue} 78% 52%)`; }

// Name tag, then chat bubble above the robot (hidden if that player is blocked).
function drawRobotLabels(sx, sy, meta, now) {
    if (!meta) return;
    ART.nameTag(ctx, sx, sy + tile * 0.55, tile, meta.name, !!meta.crown);
    if (meta.chat && !blocked.has(meta.id)) ART.bubble(ctx, sx, sy - tile * 0.55, tile, meta.chat);
}

// Sparks flying off a drill tip at (tx, ty); `strength` 0..1 scales how many.
function drawDrillSparks(tx, ty, now, strength) {
    const n = 4 + Math.round(6 * strength);
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
        const t = ((now / 140) + i * 0.37) % 1, a = -Math.PI / 2 + (Math.sin(i * 12.9898 + Math.floor(now / 140) * 7.1) * 1.1);
        const d0 = tile * (0.05 + 0.25 * t), d1 = d0 + tile * 0.12;
        ctx.strokeStyle = `rgba(255,${190 + ((i * 37) % 60)},90,${1 - t})`;
        ctx.lineWidth = Math.max(1, tile * 0.05);
        ctx.beginPath();
        ctx.moveTo(tx + Math.cos(a) * d0, ty + Math.sin(a) * d0);
        ctx.lineTo(tx + Math.cos(a) * d1, ty + Math.sin(a) * d1);
        ctx.stroke();
    }
    ctx.restore();
}

// Your own drill: sparks, a progress ring around the tip, and what it costs.
function drawMyDrill(ax, ay, now, turn) {
    if (!(G.drill > 0)) return;
    // The drill sits in front of the robot, which swings off "up" while the camera catches up.
    const tx = ax + Math.sin(turn) * tile * 0.5, ty = ay - Math.cos(turn) * tile * 0.5;
    ctx.save();
    ctx.lineWidth = Math.max(2, tile * 0.1);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath(); ctx.arc(tx, ty, tile * 0.55, 0, TAU); ctx.stroke();
    ctx.strokeStyle = HUD.amber; ctx.shadowColor = HUD.amber; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(tx, ty, tile * 0.55, -Math.PI / 2, -Math.PI / 2 + TAU * G.drill); ctx.stroke();
    ctx.restore();
    drawDrillSparks(tx, ty, now, G.drill);
    pillText(G.cargo > 0 ? "DRILLING  -1 cargo" : "DRILLING  free, slow (no cargo)", ax, ay + tile * 1.6, HUD.amber);
}

const robotHits = [];           // tap targets this frame: { x, y, r, me } or { x, y, r, meta }

function drawOthers(cam, ax, ay, W, H, now) {
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h), pad = tile * 3;
    const labels = [];
    for (const [num, o] of G.others) {
        const meta = G.meta.get(num);
        if (!meta) continue;                       // wait for the name before drawing
        const p = otherPos(o, now);
        const [sx, sy] = screenPos(p.x, p.y, cam, cosr, sinr, ax, ay);
        if (sx < -pad || sx > W + pad || sy < -pad || sy > H + pad) continue;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(p.h - cam.h);                   // heading relative to the rotated map
        drawRobot(0, 0, tile, { player: accent(meta.hue) }, now);
        ctx.restore();
        if (o.f & 2) {                              // someone else is drilling: sparks at their tip
            const a = p.h - cam.h;
            drawDrillSparks(sx + Math.sin(a) * tile * 0.5, sy - Math.cos(a) * tile * 0.5, now, 0.6);
        }
        labels.push([sx, sy, meta]);
        robotHits.push({ x: sx, y: sy, r: tile * 0.75, meta });
    }
    for (const l of labels) drawRobotLabels(l[0], l[1], l[2], now);
}

// ---- Rail: tracks, hubs and cargo carts ----
function hubPos(id) {
    if (id === 0) return [0, 0];
    const h = G.hubs.get(id);
    return h ? [h.x, h.y] : null;
}
function hubAccent(bn) { return bn ? accent(Math.floor(bn * 137.508) % 360) : "#8a93a0"; }

function drawRail(cam, ax, ay, W, H, now) {
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h), pad = tile * 2;
    const sp = (x, y) => screenPos(x, y, cam, cosr, sinr, ax, ay);
    for (const h of G.hubs.values()) {
        const to = h.out >= 0 ? hubPos(h.out) : null;
        if (!to) continue;
        const a = sp(h.x, h.y), b = sp(to[0], to[1]);
        if (Math.max(a[0], b[0]) < -pad || Math.min(a[0], b[0]) > W + pad ||
            Math.max(a[1], b[1]) < -pad || Math.min(a[1], b[1]) > H + pad) continue;
        ART.track(ctx, a[0], a[1], b[0], b[1], tile, 1);       // chevrons point toward the base
    }
    for (const h of G.hubs.values()) {
        const p = sp(h.x, h.y);
        if (p[0] < -pad || p[0] > W + pad || p[1] < -pad || p[1] > H + pad) continue;
        ctx.save();
        ctx.translate(p[0], p[1]); ctx.rotate(-cam.h);          // hubs turn with the map
        ART.hub(ctx, 0, 0, tile, hubAccent(h.bn), now, false);
        ctx.restore();
    }
}

function drawCarts(cam, ax, ay, W, H, now, colors) {
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h), pad = tile * 2, gem = hexRgb(colors.gem);
    for (const c of G.carts.values()) {
        const p = otherPos(c, now), [sx, sy] = screenPos(p.x, p.y, cam, cosr, sinr, ax, ay);
        if (sx < -pad || sx > W + pad || sy < -pad || sy > H + pad) continue;
        ART.cart(ctx, sx, sy, tile, c.a - cam.h, gem, drawCrystal, rngAt);
    }
}

function pillText(str, x, y, color) {
    const fs = Math.max(11, tile * 0.42);
    ctx.font = `bold ${fs}px ${HUD.font}`;
    const w = ctx.measureText(str).width + fs * 1.2, h = fs * 1.8;
    rr(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fillStyle = "rgba(4,12,12,0.85)"; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();
    text(str, x, y + fs * 0.35, fs, color, "center", 0);
}

// ---- Rail modes: ghost tracks for a new hub, or tracks you can ride along ----
// The candidate tracks as screen-space segments (shared with the tap handling in ui.js).
function railModeSegments(mode, cam, ax, ay) {
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h), segs = [];
    const sp = (x, y) => screenPos(x, y, cam, cosr, sinr, ax, ay);
    if (!mode) return segs;
    if (mode.kind === "hub") {
        const a = sp(mode.x, mode.y);
        for (const o of mode.opts) {
            const b = sp(o.x, o.y);
            segs.push({ to: o.to, ax: a[0], ay: a[1], bx: b[0], by: b[1], opt: o });
        }
    } else {
        const from = hubPos(mode.from);
        if (!from) return segs;
        const a = sp(from[0], from[1]);
        for (const id of mode.choices) {
            const p = hubPos(id);
            if (!p) continue;
            const b = sp(p[0], p[1]);
            segs.push({ to: id, ax: a[0], ay: a[1], bx: b[0], by: b[1], toll: hopToll(mode.from, id) });
        }
    }
    return segs;
}

function drawRailMode(cam, ax, ay, W, H, now) {
    if (!railMode) return;
    const segs = railModeSegments(railMode, cam, ax, ay);
    const pulse = 0.5 + 0.5 * Math.sin(now / 280);
    for (const s of segs) {
        if (railMode.kind === "hub") {
            ctx.save();
            ctx.globalAlpha = 0.45;                       // transparent: this is only an offer
            ART.track(ctx, s.ax, s.ay, s.bx, s.by, tile, 1);
            ctx.restore();
            const o = s.opt, mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
            const label = o.short > 0 ? `${o.cost}  (${o.short} from score)` : `${o.cost}`;
            pillText(label, mx, my, o.short > 0 ? HUD.amber : "#3ef07a");
        } else {
            ctx.save();                                   // a glowing band over the real track
            ctx.lineCap = "round";
            ctx.strokeStyle = `rgba(255,207,77,${0.18 + 0.2 * pulse})`;
            ctx.lineWidth = tile * 0.95;
            ctx.beginPath(); ctx.moveTo(s.ax, s.ay); ctx.lineTo(s.bx, s.by); ctx.stroke();
            ctx.restore();
            const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
            pillText(s.toll > 0 ? `toll ${s.toll}` : "free", mx, my, s.toll > 0 ? HUD.amber : "#3ef07a");
        }
    }
    if (railMode.kind === "hub") {                        // the hub that would be built, under your robot
        ctx.save(); ctx.translate(ax, ay); ctx.rotate(-cam.h);
        ART.hub(ctx, 0, 0, tile, accent(G.me.hue), now, true);
        ctx.restore();
    }
    pillText(railMode.kind === "hub" ? "TAP A TRACK TO BUILD IT" : "TAP A TRACK TO TRAVEL", W / 2, H * 0.2, HUD.neon);
    pillText("TAP ELSEWHERE TO CANCEL", W / 2, H * 0.2 + tile * 1.1, HUD.dim);
}

function draw() {
    requestAnimationFrame(draw);
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = canvas.width / dpr, H = canvas.height / dpr;

    ctx.fillStyle = "#05080a";
    ctx.fillRect(0, 0, W, H);
    if (G.state !== "playing" || !haveCam) {
        if (G.state === "joining" || G.state === "playing") {
            text(G.connected ? "ENTERING THE MINE…" : "CONNECTING…", W / 2, H / 2,
                Math.max(14, Math.min(W, H) * 0.04), HUD.neon, "center", 10);
        }
        return;
    }

    const now = performance.now();
    easeCamHeading(now);
    const cam = currentCam();
    const colors = curColors();
    const ax = W / 2, ay = H * ANCHOR_Y;   // player anchor on screen
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h);

    drawWorld(cam, ax, ay, colors);
    const bp = screenPos(0, 0, cam, cosr, sinr, ax, ay);
    ART.baseRing(ctx, bp[0], bp[1], G.baseR * tile);
    drawDrilledRubble(cam, ax, ay, W, H, colors);
    drawRail(cam, ax, ay, W, H, now);
    drawGems(cam, ax, ay, W, H, colors);
    ART.base(ctx, bp[0], bp[1], tile, now);
    drawCarts(cam, ax, ay, W, H, now, colors);
    robotHits.length = 0;
    drawOthers(cam, ax, ay, W, H, now);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(cam.rh - cam.h);                // the robot swings off "up" while the map catches up
    drawRobot(0, 0, tile, { player: accent(G.me.hue) }, now);
    ctx.restore();
    drawMyDrill(ax, ay, now, cam.rh - cam.h);
    robotHits.push({ x: ax, y: ay, r: tile * 0.75, me: true });
    drawRobotLabels(ax, ay, G.meta.get(G.me.num) || { name: G.me.name, chat: "", id: G.me.id }, now);
    drawRailMode(cam, ax, ay, W, H, now);

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

requestAnimationFrame(draw);
