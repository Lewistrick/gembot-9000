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

// ---- Lens: arrows around the robot to the base, the nearest gem and the nearest hub ----
function drawArrows(cam, ax, ay, now) {
    if (!G.showArrows) return;
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h), targets = [];
    targets.push({ x: 0, y: 0, color: HUD.amber, ring: 2.5 });                         // the base: yellow
    const gem = nearestGem(cam.x, cam.y);
    if (gem) targets.push({ x: gem[0], y: gem[1], color: gem[2] ? "#ffd64d" : curColors().gem, ring: 2.0 });
    let hub = null, hd = Infinity;
    for (const h of G.hubs.values()) {
        const d = Math.hypot(h.x - cam.x, h.y - cam.y);
        if (d < hd) { hd = d; hub = h; }
    }
    if (hub) targets.push({ x: hub.x, y: hub.y, color: "#aab2c0", ring: 1.5 });         // the nearest hub: gray
    ctx.save();
    ctx.lineJoin = "round";
    for (const t of targets) {
        const [sx, sy] = screenPos(t.x, t.y, cam, cosr, sinr, ax, ay);
        const vx = sx - ax, vy = sy - ay, d = Math.hypot(vx, vy), tiles = d / tile;
        if (tiles < 1.6) continue;                                  // you're practically there
        const ux = vx / d, uy = vy / d, r = tile * t.ring, len = tile * 0.5, half = tile * 0.24;
        const bx = ax + ux * r, by = ay + uy * r;                   // arrow base; the tip points at the target
        ctx.beginPath();
        ctx.moveTo(bx + ux * len, by + uy * len);
        ctx.lineTo(bx - uy * half, by + ux * half);
        ctx.lineTo(bx + uy * half, by - ux * half);
        ctx.closePath();
        ctx.fillStyle = t.color; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineWidth = Math.max(2, tile * 0.07);
        ctx.shadowColor = t.color; ctx.shadowBlur = 6;
        ctx.stroke(); ctx.fill();
        ctx.shadowBlur = 0;
        const fs = Math.max(10, tile * 0.34), lx = bx + ux * (len + fs * 0.9), ly = by + uy * (len + fs * 0.9);
        ctx.font = `bold ${fs}px ${HUD.font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(2, fs * 0.25); ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.strokeText(String(Math.round(tiles)), lx, ly);
        ctx.fillStyle = t.color; ctx.fillText(String(Math.round(tiles)), lx, ly);
    }
    ctx.restore();
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

// ---- Hub placement: every transparent track carries a small clickable box with its length and price ----
const railLabelHits = [];          // { to, x, y, w, h } of the boxes drawn last frame: a tap on one picks that track
const LABEL_GAP = 4;

// Part [t0, t1] of the segment a->b (t from 0 to 1) that lies inside the rectangle, or null.
function clipSegment(ax, ay, bx, by, x0, y0, x1, y1) {
    let t0 = 0, t1 = 1;
    for (const [p, q] of [[-(bx - ax), ax - x0], [bx - ax, x1 - ax], [-(by - ay), ay - y0], [by - ay, y1 - ay]]) {
        if (p === 0) { if (q < 0) return null; continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) return null; t0 = Math.max(t0, t); } else { if (t < t0) return null; t1 = Math.min(t1, t); }
    }
    return t0 <= t1 ? [t0, t1] : null;
}

const boxesOverlap = (a, b) => a.x < b.x + b.w + LABEL_GAP && b.x < a.x + a.w + LABEL_GAP && a.y < b.y + b.h + LABEL_GAP && b.y < a.y + a.h + LABEL_GAP;

// Where each label goes so that none overlaps another, the robot or the instructions:
//  1. on the part of its own track that is on screen (a label never sits off-screen),
//  2. otherwise slid along that track away from the others,
//  3. otherwise (tracks leaving in nearly the same direction) pushed sideways with a short leader line.
// segs: { ax, ay, bx, by }; size: { w, h }; region: { x0, y0, x1, y1 } the box may lie in; avoid: rects.
function layoutTrackLabels(segs, size, region, avoid) {
    const cx0 = region.x0 + size.w / 2, cx1 = region.x1 - size.w / 2, cy0 = region.y0 + size.h / 2, cy1 = region.y1 - size.h / 2;
    const placed = [], out = [];
    const free = (r) => !avoid.some((o) => boxesOverlap(r, o)) && !placed.some((o) => boxesOverlap(r, o));
    const rectAt = (x, y) => ({ x: x - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h });
    // the longest tracks first: they have the most room to slide
    const order = segs.map((_, i) => i).sort((i, j) => Math.hypot(segs[j].bx - segs[j].ax, segs[j].by - segs[j].ay) - Math.hypot(segs[i].bx - segs[i].ax, segs[i].by - segs[i].ay));
    const result = new Array(segs.length);
    for (const i of order) {
        const s = segs[i], len = Math.hypot(s.bx - s.ax, s.by - s.ay) || 1;
        const at = (t) => [s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t];
        const clip = clipSegment(s.ax, s.ay, s.bx, s.by, cx0, cy0, cx1, cy1);
        const lo = clip ? Math.max(clip[0], Math.min(clip[1], (tile * 1.9) / len)) : Math.min(1, (tile * 1.9) / len);
        const hi = clip ? clip[1] : lo;
        const pref = clamp(0.5, lo, hi), step = Math.max(0.02, 9 / len);
        let pos = null;
        for (let k = 0; !pos && (pref - k * step >= lo || pref + k * step <= hi); k++) {
            for (const t of k ? [pref + k * step, pref - k * step] : [pref]) {
                if (t < lo - 1e-9 || t > hi + 1e-9) continue;
                const [x, y] = at(t);
                if (free(rectAt(x, y))) { pos = { x, y, lead: null }; break; }
            }
        }
        if (!pos) {                                          // sideways, tied to the track by a leader line
            const nx = -(s.by - s.ay) / len, ny = (s.bx - s.ax) / len, [bx, by] = at(pref);
            for (let k = 1; !pos && k <= 6; k++) {
                for (const sign of [1, -1]) {
                    const d = sign * k * (size.h + LABEL_GAP), x = clamp(bx + nx * d, cx0, cx1), y = clamp(by + ny * d, cy0, cy1);
                    if (free(rectAt(x, y))) { pos = { x, y, lead: [bx, by] }; break; }
                }
            }
        }
        if (!pos) { const [x, y] = at(pref); pos = { x, y, lead: null }; }
        const r = rectAt(pos.x, pos.y);
        placed.push(r);
        result[i] = { rect: r, lead: pos.lead };
    }
    return result;
}

function gemPath(x, y, s) {             // a cut gem centred on (x, y), s from the centre to the tip
    ctx.beginPath();
    ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.9, y - s * 0.1); ctx.lineTo(x + s * 0.55, y + s * 0.9);
    ctx.lineTo(x - s * 0.55, y + s * 0.9); ctx.lineTo(x - s * 0.9, y - s * 0.1); ctx.closePath();
}
function drawGemIcon(x, y, s, color) {
    ctx.save();
    ctx.fillStyle = color; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineWidth = 1;
    gemPath(x, y, s);
    ctx.fill(); ctx.stroke();
    ctx.restore();
}

// The two lines on a track offer's box.
function trackLabelLines(o) { return [`length: ${Math.round(o.len)}m`, `cost: ${o.cost}`]; }

function drawRailMode(cam, ax, ay, W, H, now) {
    railLabelHits.length = 0;
    if (!railMode) return;
    const segs = railModeSegments(railMode, cam, ax, ay);
    for (const s of segs) {
        ctx.save();
        ctx.globalAlpha = 0.45;                           // transparent: this is only an offer
        ART.track(ctx, s.ax, s.ay, s.bx, s.by, tile, 1);
        ctx.restore();
    }
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(-cam.h);   // the hub that would be built, under your robot
    ART.hub(ctx, 0, 0, tile, accent(G.me.hue), now, true);
    ctx.restore();
    pillText("TAP A TRACK TO BUILD IT", W / 2, H * 0.2, HUD.neon);
    pillText("TAP ELSEWHERE TO CANCEL", W / 2, H * 0.2 + tile * 1.1, HUD.dim);

    // The boxes: small, two lines, clickable.
    const S = Math.min(W, H), M = Math.max(8, S * 0.028), topH = Math.max(30, Math.min(58, S * 0.085));
    const fs = clamp(tile * 0.4, 11, 17), gem = curColors().gem;
    ctx.font = `bold ${fs}px ${HUD.font}`;
    const lines = segs.map((s) => trackLabelLines(s.opt));
    const gemW = fs * 1.1;
    let w = 0;
    for (const [l1, l2] of lines) w = Math.max(w, ctx.measureText(l1).width, ctx.measureText(l2).width + gemW);
    const size = { w: w + fs * 1.1, h: fs * 2.55 };
    const region = { x0: 4, y0: M + topH + M * 1.4, x1: W - 4, y1: H - Math.max(60, S * 0.2) };
    const avoid = [{ x: ax - tile * 0.9, y: ay - tile * 0.9, w: tile * 1.8, h: tile * 1.8 }];
    for (const [str, y] of [["TAP A TRACK TO BUILD IT", H * 0.2], ["TAP ELSEWHERE TO CANCEL", H * 0.2 + tile * 1.1]]) {
        const pf = Math.max(11, tile * 0.42);
        ctx.font = `bold ${pf}px ${HUD.font}`;
        const pw = ctx.measureText(str).width + pf * 1.2, ph = pf * 1.8;
        avoid.push({ x: W / 2 - pw / 2, y: y - ph / 2, w: pw, h: ph });
    }
    ctx.font = `bold ${fs}px ${HUD.font}`;
    const placed = layoutTrackLabels(segs, size, region, avoid);
    segs.forEach((s, i) => {
        const { rect: r, lead } = placed[i];
        if (lead) {                                        // a short line back to the track it belongs to
            ctx.beginPath(); ctx.moveTo(lead[0], lead[1]); ctx.lineTo(r.x + r.w / 2, r.y + r.h / 2);
            ctx.strokeStyle = HUD.neon; ctx.lineWidth = 1.5; ctx.stroke();
        }
        rr(r.x, r.y, r.w, r.h, fs * 0.5);
        ctx.fillStyle = "rgba(4,12,12,0.92)"; ctx.fill();
        ctx.lineWidth = 1.8; ctx.strokeStyle = HUD.neon; ctx.stroke();
        const [l1, l2] = lines[i];
        text(l1, r.x + fs * 0.55, r.y + fs * 1.1, fs, "#cfeee6", "left", 0);
        text(l2, r.x + fs * 0.55, r.y + fs * 2.1, fs, gem, "left", 0);
        drawGemIcon(r.x + fs * 0.55 + ctx.measureText(l2).width + fs * 0.7, r.y + fs * 1.72, fs * 0.5, gem);
        railLabelHits.push({ to: s.to, x: r.x, y: r.y, w: r.w, h: r.h });
    });
}

// Travel mode: the tracks from the hub you're on glow; tapping one rides you along it.
function drawTravelMode(cam, ax, ay, W, H, now) {
    if (!travelMode) return;
    const mode = travelTargets(), pulse = 0.5 + 0.5 * Math.sin(now / 280);
    if (mode) {
        for (const s of railModeSegments(mode, cam, ax, ay)) {
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
    pillText(G.riding ? "TRAVELLING…" : "TRAVEL MODE: TAP A TRACK", W / 2, H * 0.2, HUD.amber);
    pillText("PRESS TRAVEL AGAIN TO STOP", W / 2, H * 0.2 + tile * 1.1, HUD.dim);
}

// "+amount" texts that float up from the robot and fade when gems are banked (in the gems' colour, with a dark outline to read on any floor).
const FLOAT_MS = 1700;
function drawFloats(ax, ay, now, colors) {
    G.floats = G.floats.filter((f) => now - f.t0 < FLOAT_MS);
    if (!G.floats.length) return;
    const fs = clamp(tile * 0.95, 20, 40);
    ctx.save();
    ctx.font = `bold ${fs}px ${HUD.font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const f of G.floats) {
        const t = (now - f.t0) / FLOAT_MS, ease = 1 - (1 - t) * (1 - t);
        const y = ay - tile * 1.9 - ease * tile * 2.6;                   // starts above the name tag, drifts up
        ctx.globalAlpha = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;           // holds, then fades
        // banked gems rise as +n, what a build cost as \u2212n, a mined gem as [gem] n
        const str = f.gem ? String(f.v) : f.v < 0 ? `\u2212${-f.v}` : `+${f.v}`;
        const color = f.mega ? "#ffd64d" : colors.gem;
        let x = ax;
        if (f.gem) {
            const icon = fs * 0.42, w = ctx.measureText(str).width, gap = fs * 0.2;
            x = ax + (icon * 2 + gap) / 2;                                  // centre icon + number together
            const gx = x - w / 2 - gap - icon;
            ctx.lineWidth = fs * 0.3; ctx.strokeStyle = "rgba(4,10,14,0.92)";
            gemPath(gx, y, icon); ctx.stroke();                              // dark outline, like the text's
            ctx.shadowColor = color; ctx.shadowBlur = fs * 0.5;
            ctx.fillStyle = color; gemPath(gx, y, icon); ctx.fill();
            ctx.shadowBlur = 0;
        }
        ctx.lineWidth = fs * 0.34; ctx.strokeStyle = "rgba(4,10,14,0.92)"; ctx.strokeText(str, x, y);
        ctx.shadowColor = color; ctx.shadowBlur = fs * 0.5;
        ctx.fillStyle = color; ctx.fillText(str, x, y);
        ctx.shadowBlur = 0;
    }
    ctx.restore();
}

// Light: the robot sees only near a hub (the base is one). Darker from G.light[0] tiles away,
// pitch black from G.light[1]; the server sends the robot home from G.light[2].
let wasDark = false, lightAt = 0;
function updateLight(now) {
    let d = Math.hypot(G.x, G.y);
    for (const h of G.hubs.values()) d = Math.min(d, Math.hypot(h.x - G.x, h.y - G.y));
    G.lightD = d;
    const [dim, dark] = G.light, want = clamp((d - dim) / (dark - dim), 0, 1);
    const dt = Math.min(100, now - lightAt);
    lightAt = now;
    G.dark = Math.abs(want - G.dark) < 0.002 ? want : G.dark + (want - G.dark) * (1 - Math.exp(-dt / 150));   // eased: a new hub brightens it smoothly
    const pitch = d >= dark;
    if (pitch && !wasDark) toast("It is pitch dark here. Hubs are required to provide light!", HUD.amber, 6000);
    wasDark = pitch;
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
    updateLight(now);
    if (G.dark > 0.003) { ctx.fillStyle = `rgba(0,0,0,${G.dark})`; ctx.fillRect(0, 0, W, H); }   // the world goes dark; you, the arrows and the HUD stay
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(cam.rh - cam.h);                // the robot swings off "up" while the map catches up
    drawRobot(0, 0, tile, { player: accent(G.me.hue) }, now);
    ctx.restore();
    drawMyDrill(ax, ay, now, cam.rh - cam.h);
    robotHits.push({ x: ax, y: ay, r: tile * 0.75, me: true });
    drawRobotLabels(ax, ay, G.meta.get(G.me.num) || { name: G.me.name, chat: "", id: G.me.id }, now);
    drawArrows(cam, ax, ay, now);
    drawFloats(ax, ay, now, colors);
    drawRailMode(cam, ax, ay, W, H, now);
    drawTravelMode(cam, ax, ay, W, H, now);

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
