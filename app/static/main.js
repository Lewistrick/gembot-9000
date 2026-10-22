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
        labels.push([sx, sy, meta]);
    }
    for (const l of labels) drawRobotLabels(l[0], l[1], l[2], now);
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
    const cam = currentCam();
    const colors = curColors();
    const ax = W / 2, ay = H * ANCHOR_Y;   // player anchor on screen
    const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h);

    drawWorld(cam, ax, ay, colors);
    const bp = screenPos(0, 0, cam, cosr, sinr, ax, ay);
    ART.baseRing(ctx, bp[0], bp[1], G.baseR * tile);
    drawGems(cam, ax, ay, W, H, colors);
    ART.base(ctx, bp[0], bp[1], tile, now);
    drawOthers(cam, ax, ay, W, H, now);
    drawRobot(ax, ay, tile, { player: accent(G.me.hue) }, now);
    drawRobotLabels(ax, ay, G.meta.get(G.me.num) || { name: G.me.name, chat: "", id: G.me.id }, now);

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
