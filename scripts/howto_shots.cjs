// Regenerates the screenshots on the How to Play slides (app/static/howto/*.jpg) and
// shots.json, which says where things are in each picture so the slideshow can put its
// blinking markers on them.
//
// It starts a real server on a fixed day (scripts/howto_server.py), joins it in a headless
// browser, arranges each scene on the client (server ticks are frozen so the injected state
// stays put) and takes a screenshot of the game. Nothing here judges how a picture looks:
// look at the result yourself.
//
// Run:  NODE_PATH=/opt/node22/lib/node_modules node scripts/howto_shots.cjs

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "app", "static", "howto");
const W = 720, H = 405;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

// Helpers that live in the page: finding spots on the real terrain, converting world to screen.
function installHelpers() {
    const frames = (n = 4) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const known = (x, y) => chunks.has(Math.floor(x / CS) + "," + Math.floor(y / CS));
    const cells = (x1, y1, x2, y2) => {
        const dx = Math.abs(x2 - x1), dy = -Math.abs(y2 - y1), sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
        let err = dx + dy, x = x1, y = y1;
        const out = [];
        for (;;) {
            out.push([x, y]);
            if (x === x2 && y === y2) return out;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x += sx; }
            if (e2 <= dx) { err += dx; y += sy; }
        }
    };
    const clear = (x1, y1, x2, y2) => cells(x1, y1, x2, y2).every(([x, y]) => isFloor(x, y));
    const heading = (fx, fy, tx, ty) => Math.atan2(tx - fx, -(ty - fy));
    const pose = (x, y, h) => {
        G.x = x; G.y = y; G.h = h; G.speed = 0;
        camFrom = camTo = { x, y, h }; camH = h; camHAt = performance.now();
    };
    const sp = (x, y) => {
        const cam = currentCam(), r = canvas.getBoundingClientRect();
        return screenPos(x, y, cam, Math.cos(-cam.h), Math.sin(-cam.h), r.width / 2, r.height * ANCHOR_Y);
    };
    const around = (cx, cy, hw, hh) => [cx - hw, cy - hh, 2 * hw, 2 * hh].map((v) => Math.round(v));
    const robot = (r = 0.85) => around(canvas.getBoundingClientRect().width / 2, canvas.getBoundingClientRect().height * ANCHOR_Y, tile * r, tile * r);
    const tileBox = (x, y, r = 0.8) => { const p = sp(x, y); return around(p[0], p[1], tile * r, tile * r); };
    const hud = (k) => (hudHit[k] ? [hudHit[k].x, hudHit[k].y, hudHit[k].w, hudHit[k].h].map(Math.round) : null);
    const dom = (id) => { const r = document.getElementById(id).getBoundingClientRect(), c = canvas.getBoundingClientRect(); return [r.left - c.left, r.top - c.top, r.width, r.height].map(Math.round); };
    const gems = () => {
        const out = [];
        for (const c of chunks.values()) for (const g of c.gems) if (!mined.has(g[0] + "," + g[1])) out.push({ x: g[0], y: g[1], c });
        return out;
    };
    const reset = () => {
        G.hubs.clear(); G.others.clear(); G.toasts.length = 0; G.floats.length = 0;
        for (const k of [...G.meta.keys()]) if (G.me && k !== G.me.num) G.meta.delete(k);
        G.cargo = 0; G.score = 0; G.rank = null; G.drill = 0; G.speed = 0; G.dark = 0; G.lightD = 0;
        G.light = [100, 250, 350]; G.showArrows = G.showMap = G.showNetwork = false;
        G.idleUntil = 0; G.mult = 1; G.leftAt = 0; G.riding = false; G.flipping = false; G.bump = 0;
        travelMode = false; railMode = null; wasDark = false; warnedFar = false;
        payBarEl.classList.add("hidden");
        if (G.me) G.meta.set(G.me.num, { n: G.me.num, id: G.me.id, name: G.me.name, chat: "", hue: G.me.hue });
    };
    // A floor tile P near the base with a clear straight line to the base and to another floor tile Q.
    const hubSpot = () => {
        for (let r = 13; r <= 24; r++) {
            for (let k = 0; k < 24; k++) {
                const a = (k * Math.PI * 2) / 24, px = Math.round(Math.sin(a) * r), py = Math.round(-Math.cos(a) * r);
                if (!isFloor(px, py) || !clear(px, py, 0, 0)) continue;
                for (let len = 14; len >= 10; len--) {
                    for (let j = 0; j < 36; j++) {
                        const b = (j * Math.PI * 2) / 36, qx = Math.round(px + Math.sin(b) * len), qy = Math.round(py - Math.cos(b) * len);
                        const da = Math.abs(((b - heading(px, py, 0, 0) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
                        if (da < 2.0) continue;               // keep it clearly apart from the track to the base
                        if (Math.hypot(qx, qy) < 14 || !known(qx, qy) || !isFloor(qx, qy) || !clear(px, py, qx, qy)) continue;
                        return { px, py, qx, qy, d0: Math.round(Math.hypot(px, py)), d1: len };
                    }
                }
            }
        }
        return null;
    };
    const between = (fx, fy, ax, ay, bx, by) => {          // heading halfway between the directions to two targets
        const h0 = heading(fx, fy, ax, ay), h1 = heading(fx, fy, bx, by), d = ((h1 - h0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        return h0 + d / 2;
    };
    window.S = { frames, between, wait, known, cells, clear, heading, pose, sp, around, robot, tileBox, hud, dom, gems, reset, hubSpot };
}

// ---- The scenes: each runs in the page and returns { marks } in screen pixels ----
const scenes = [
    ["gem", () => {
        const base = gems().filter((g) => Math.hypot(g.x, g.y) > 15 && Math.hypot(g.x, g.y) < 28).sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
        for (const g of base) for (let k = 0; k < 16; k++) {
            const a = (k * Math.PI * 2) / 16, rx = Math.round(g.x - Math.sin(a) * 5), ry = Math.round(g.y + Math.cos(a) * 5);
            if (!isFloor(rx, ry) || !clear(rx, ry, g.x, g.y) || !known(rx, ry)) continue;
            pose(rx, ry, heading(rx, ry, g.x, g.y));
            return { found: [g.x, g.y], marks: {} };
        }
        throw new Error("no spot for the gem scene");
    }, async () => ({ gem: tileBox(...S.last.found, 0.8), robot: robot() })],
    ["bank", () => {
        for (let r = 14; r <= 17; r++) for (let k = 0; k < 24; k++) {
            const a = (k * Math.PI * 2) / 24, px = Math.round(Math.sin(a) * r), py = Math.round(-Math.cos(a) * r);
            if (!isFloor(px, py) || !clear(px, py, 0, 0)) continue;
            pose(px, py, heading(px, py, 0, 0));
            G.score = 214; G.rank = 4;
            return { found: [px, py] };
        }
        throw new Error("no spot for the bank scene");
    }, async () => {
        const b = sp(0, 0), rr_ = G.baseR * tile;
        return { robot: robot(), base: around(b[0], b[1], rr_, rr_), score: hud("score") };
    }],
    ["mega", () => {
        const base = gems().filter((g) => Math.hypot(g.x, g.y) > 15 && Math.hypot(g.x, g.y) < 28).sort((a, b) => Math.hypot(b.x, b.y) - Math.hypot(a.x, a.y));
        for (const g of base) for (let k = 0; k < 16; k++) {
            const a = (k * Math.PI * 2) / 16, rx = Math.round(g.x - Math.sin(a) * 6), ry = Math.round(g.y + Math.cos(a) * 6);
            if (!isFloor(rx, ry) || !clear(rx, ry, g.x, g.y) || !known(rx, ry)) continue;
            g.c.mega.add(g.x + "," + g.y);           // dress one gem up as a mega gem for the picture
            pose(rx, ry, heading(rx, ry, g.x, g.y));
            G.showMap = true;
            return { found: [g.x, g.y] };
        }
        throw new Error("no spot for the mega scene");
    }, async () => {
        const S_ = Math.min(canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height), M = Math.max(8, S_ * 0.028);
        const topH = Math.max(30, Math.min(58, S_ * 0.085)), side = clamp(S_ * 0.3, 96, 190) * Math.SQRT2;
        return { gem: tileBox(...S.last.found, 0.9), minimap: [Math.round(M), Math.round(M + topH + M * 0.6), Math.round(side), Math.round(side)] };
    }],
    ["drill", () => {
        for (let r = 14; r <= 30; r++) for (let k = 0; k < 48; k++) {
            const a = (k * Math.PI * 2) / 48, fx = Math.round(Math.sin(a) * r), fy = Math.round(-Math.cos(a) * r);
            if (!isFloor(fx, fy) || !known(fx, fy)) continue;
            for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
                const rx = fx + dx, ry = fy + dy, bx = fx - dx, by = fy - dy;
                if (isFloor(rx, ry) || !known(rx, ry) || !isFloor(bx, by) || !isFloor(bx - dx, by - dy) || !isFloor(bx - 2 * dx, by - 2 * dy)) continue;
                if (isFloor(rx + dx, ry + dy)) continue;   // a thick wall, not a thin slab
                pose(fx, fy, heading(fx, fy, rx, ry));
                G.drill = 0.62; G.cargo = 12;
                return { found: [rx, ry] };
            }
        }
        throw new Error("no spot for the drill scene");
    }, async () => ({ wall: tileBox(...S.last.found, 0.7), robot: robot() })],
    ["hubbtn", () => {
        const s = hubSpot();
        if (!s) throw new Error("no spot for the hub scene");
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        G.score = 200; G.cargo = 10;
        return { found: [s.px, s.py] };
    }, async () => ({ hub: hud("placeHub"), robot: robot() })],
    ["ghosts", () => {
        const s = hubSpot();
        pose(s.px, s.py, between(s.px, s.py, 0, 0, s.qx, s.qy));      // both tracks in view
        G.score = 200; G.cargo = 10;
        G.hubs.set(1, { id: 1, x: s.qx, y: s.qy, bn: 2, out: 0 });
        HANDLERS.hubopts({ x: s.px, y: s.py, opts: [
            { to: 0, x: 0, y: 0, cost: 25 + s.d0, short: 0, len: s.d0, linked: true },
            { to: 1, x: s.qx, y: s.qy, cost: 25 + s.d1, short: 0, len: s.d1, linked: true }] });
        return { found: [s.px, s.py, s.qx, s.qy] };
    }, async () => {
        const box = (to) => { const h = railLabelHits.find((r) => r.to === to); return h && [h.x, h.y, h.w, h.h].map(Math.round); };
        return { priceA: box(1), priceB: box(0) };
    }],
    ["travel", () => {
        const s = hubSpot();
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        G.cargo = 35; G.score = 120;
        G.hubs.set(1, { id: 1, x: s.px, y: s.py, bn: G.me.num, out: 0 });
        G.hubs.set(2, { id: 2, x: s.qx, y: s.qy, bn: 2, out: 1 });
        travelMode = true;
        return { found: [s.px, s.py, s.qx, s.qy] };
    }, async () => {
        const [px, py, qx, qy] = S.last.found, a = sp((px + qx) / 2, (py + qy) / 2);
        return { tollPill: around(a[0], a[1], tile * 1.5, tile * 0.75), travel: hud("travel"), ship: hud("ship"), robot: robot() };
    }],
    ["pay", () => {
        const s = hubSpot();
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        G.cargo = 30; G.score = 180;
        G.hubs.set(1, { id: 1, x: s.qx, y: s.qy, bn: 2, out: 0 });
        HANDLERS.pay({ label: "Build a hub and track", cost: 45, cargo: 30, score: 15, retry: { action: "build_hub", to: 0, x: 1, y: 2 } });
        return { found: [s.px, s.py] };
    }, async () => ({ question: dom("payText"), yes: dom("payYes") })],
    ["dim", () => {
        const s = hubSpot();
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        G.x = 175; G.y = 0;                                   // 175 from the closest hub: halfway to pitch black
        G.score = 90;
        return { found: [s.px, s.py] };
    }, async () => ({ screen: [0, 0, 720, 405] })],
    ["dark", () => {
        const s = hubSpot();
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        G.x = 262; G.y = 0;                                   // past 250: pitch black, and 88 from being lost
        G.score = 90; G.cargo = 20;
        return { found: [s.px, s.py] };
    }, async () => {
        const c = canvas.getBoundingClientRect(), fs = Math.max(14, Math.min(c.width * 0.045, 26));
        ctx.font = `bold ${fs}px ${HUD.font}`;
        const msg = `TOO DARK · LOST IN ${Math.ceil(G.light[2] - G.lightD)}m`, w = Math.min(c.width - 24, ctx.measureText(msg).width + fs * 2);
        return { banner: around(c.width / 2, c.height * 0.3 + fs * 1.1, w / 2, fs * 1.1), robot: robot() };
    }],
    ["aids", () => {
        const s = hubSpot();
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        G.hubs.set(1, { id: 1, x: s.qx, y: s.qy, bn: 2, out: 0 });
        G.showArrows = true; G.showMap = true;
        return { found: [s.px, s.py] };
    }, async () => ({ lens: hud("lens"), map: hud("minimap"), network: hud("network"), robot: robot(2.6) })],
    ["network", () => {
        const spots = [[40, -20, 0], [80, 10, 1], [70, -60, 1], [-50, 30, 0], [-90, 70, 4], [10, 90, 0]];
        spots.forEach(([x, y, out], i) => G.hubs.set(i + 1, { id: i + 1, x, y, bn: i % 2 ? 2 : G.me.num, out }));
        G.x = 80; G.y = 10; G.h = 0.9;
        const r = canvas.getBoundingClientRect();
        fitNetwork(r.width, r.height);
        G.showNetwork = true;
        return {};
    }, async () => {
        const r = canvas.getBoundingClientRect(), at = (x, y) => [r.width / 2 + (x - netView.cx) * netView.sc, r.height / 2 + (y - netView.cy) * netView.sc];
        const you = at(G.x, G.y), base = at(0, 0);
        return { cross: hud("netClose"), you: around(you[0], you[1], 26, 26), base: around(base[0], base[1], 30, 30) };
    }],
    ["chat", () => {
        const s = hubSpot();
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        const p = { x: s.px, y: s.py };
        let ox = p.x, oy = p.y;                               // another robot a few tiles ahead of us
        for (const d of [[3, -4], [-3, -4], [4, -2], [-4, -2], [4, 0], [-4, 0]]) if (isFloor(p.x + d[0], p.y + d[1])) { ox = p.x + d[0]; oy = p.y + d[1]; break; }
        const t = { x: ox, y: oy, h: 0 };
        G.others.set(77, { from: t, to: t, t0: performance.now() - 1000, f: 0 });
        G.meta.set(77, { n: 77, id: "nova-id", name: "Nova", chat: "nice find!", hue: 200 });
        G.meta.set(G.me.num, { n: G.me.num, id: G.me.id, name: G.me.name, chat: "who wants a hub?", hue: G.me.hue });
        return { found: [ox, oy] };
    }, async () => {
        const o = sp(...S.last.found), c = canvas.getBoundingClientRect();
        return { other: around(o[0], o[1] - tile * 1.9, tile * 2.6, tile * 0.8), mine: around(c.width / 2, c.height * ANCHOR_Y - tile * 1.9, tile * 2.6, tile * 0.8) };
    }],
    ["day", () => {
        const s = hubSpot();
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        G.mult = 2; G.left = 1700; G.leftAt = performance.now(); G.score = 540; G.rank = 3; G.cargo = 66;
        return { found: [s.px, s.py] };
    }, async () => {
        const c = canvas.getBoundingClientRect(), S_ = Math.min(c.width, c.height), M = Math.max(8, S_ * 0.028), topH = Math.max(30, Math.min(58, S_ * 0.085));
        const fs = Math.max(11, Math.min(c.width * 0.03, 16));
        ctx.font = `bold ${fs}px ${HUD.font}`;
        const w = ctx.measureText(`RUSH HOUR x2  ${fmtLeft(1700)}`).width + fs * 1.4, h = fs * 1.7;
        return { clock: around(c.width / 2, M + topH + M * 0.6 + h / 2, w / 2 + 2, h / 2 + 2), score: hud("score") };
    }],
    ["idle", () => {
        const s = hubSpot();
        pose(s.px, s.py, heading(s.px, s.py, s.qx, s.qy));
        G.idleUntil = performance.now() + 42000;
        return { found: [s.px, s.py] };
    }, async () => {
        const c = canvas.getBoundingClientRect(), fs = Math.max(14, Math.min(c.width * 0.045, 26));
        ctx.font = `bold ${fs}px ${HUD.font}`;
        const w = Math.min(c.width - 24, ctx.measureText("STILL THERE?  MOVE WITHIN 42s").width + fs * 2);
        return { banner: around(c.width / 2, c.height * 0.3 + fs * 1.1, w / 2, fs * 1.1) };
    }],
];

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const PORT = await freePort();
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gembot-howto-")), "howto.db");
    const server = spawn("uv", ["run", "python", path.join(ROOT, "scripts", "howto_server.py")],
        { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT), GEMBOT_DB: db, PYTHONDONTWRITEBYTECODE: "1" } });
    process.on("exit", () => { try { process.kill(-server.pid); } catch (e) { /* already gone */ } });
    let log = "";
    server.stderr.on("data", (d) => (log += d));
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${PORT}/api/status`)).ok) break; } catch (e) { /* not up yet */ } await sleep(250); }

    const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
    const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/`);
    await page.fill("#nick", "GemBot");
    await page.click("#playBtn");
    await page.waitForFunction(() => G.state === "playing" && haveCam && chunks.size >= 4, null, { timeout: 20000 });
    await sleep(1500);
    await page.evaluate(installHelpers);
    await page.evaluate(() => { HANDLERS.tick = () => {}; });           // freeze the server's updates so scenes stay put

    const shots = {};
    const USE = "const { frames, between, wait, known, cells, clear, heading, pose, sp, around, robot, tileBox, hud, dom, gems, reset, hubSpot } = S;";
    for (const [name, setup, marks] of scenes) {
        const found = await page.evaluate(`(async () => {
            ${USE}
            reset(); await frames(2);
            S.last = (${setup.toString()})() || {};
            await wait(${name === "dim" || name === "dark" ? 1800 : 400}); await frames(4);
            return S.last;
        })()`);
        const m = await page.evaluate(`(async () => { ${USE} return await (${marks.toString()})(); })()`);
        await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: "jpeg", quality: 82, clip: { x: 0, y: 0, width: W, height: H } });
        // keep only markers whose centre is inside the picture
        const inside = (r) => r && r[0] + r[2] / 2 >= 0 && r[0] + r[2] / 2 <= W && r[1] + r[3] / 2 >= 0 && r[1] + r[3] / 2 <= H;
        shots[name] = { file: `${name}.jpg`, w: W, h: H, marks: Object.fromEntries(Object.entries(m).filter(([, v]) => inside(v))) };
        console.log(name, JSON.stringify(found.found || ""), Object.keys(shots[name].marks).join(","));
    }
    fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify(shots, null, 1) + "\n");
    await browser.close();
    if (errors.length) console.log("PAGE ERRORS", errors);
    if (log.trim().split("\n").some((l) => /Traceback|Error/.test(l))) console.log("SERVER LOG", log.slice(-500));
    process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
