// Renders art mockups (scene + close-ups) with headless Chromium, reusing the
// game's real canvas code and textures (app/static/game.js) plus ./art.js.
//
// Run:  NODE_PATH=/opt/node22/lib/node_modules node scripts/mockups/render.cjs
// Output: scripts/mockups/out/scene.png, scripts/mockups/out/closeups.png

const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../../app");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    const file = path.join(ROOT, url === "/" ? "static/index.html" : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const ext = path.extname(file);
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[ext] || "text/plain";
    res.writeHead(200, { "content-type": type });
    res.end(fs.readFileSync(file));
});

const ART_JS = fs.readFileSync(path.join(__dirname, "art.js"), "utf8");

// Runs inside the page, on top of the game's own globals (drawWorld, drawRobot...).
function scene(kind) {
    const colors = { floor: "#e4c8be", rock: "#1e5231", grid: "#d8afa2", player: "#e53935", gem: "#fa2edb" };
    const ACC = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#8e24aa", "#fb8c00", "#00acc1", "#ec407a"];
    const W = canvas.width, H = canvas.height, now = 1000;
    const gem = hexRgb(colors.gem);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#05080a"; ctx.fillRect(0, 0, W, H);

    const setWorld = (cols, rows, isRock) => {
        const x0 = -Math.floor(cols / 2), y0 = -Math.floor(rows / 2), tiles = [];
        for (let r = 0; r < rows; r++) {
            const row = [];
            for (let c = 0; c < cols; c++) row.push(isRock(x0 + c, y0 + r) ? 0 : 1);
            tiles.push(row);
        }
        snap = { tiles, colors, x0, y0 };
    };
    const label = (s, x, y, color) => {
        ctx.font = `bold 15px ${HUD.font}`;
        const w = ctx.measureText(s).width + 20;
        rr(x - w / 2, y - 17, w, 25, 8); ctx.fillStyle = "rgba(4,12,12,0.78)"; ctx.fill();
        text(s, x, y, 15, color || HUD.neon, "center", 0);
    };

    if (kind === "scene") {
        tile = 44;
        setWorld(37, 25, (x, y) => Math.abs(y) >= 8 || x <= -13 ||
            (x >= 11 && x <= 14 && y >= -5 && y <= -2) || (x >= 0 && x <= 2 && y >= 5 && y <= 6));
        const cam = { x: 1, y: 0, h: 0 }, ax = W / 2, ay = H / 2;
        drawWorld(cam, ax, ay);
        const P = (wx, wy) => [ax + (wx - cam.x) * tile, ay + (wy - cam.y) * tile];
        const baseP = P(-8, 0);
        ART.baseRing(ctx, baseP[0], baseP[1], 10 * tile);

        const H1 = [2, -4], H2 = [9, 1], H3 = [-3, 5], GH = [8, -6];
        const hubs = [[H1, ACC[1], "out"], [H2, ACC[5], "out"], [H3, ACC[2], "out"]];
        const link = (a, b, d) => { const pa = P(...a), pb = P(...b); ART.track(ctx, pa[0], pa[1], pb[0], pb[1], tile, d); };
        link([-8, 0], H1, -1); link(H1, H2, -1); link([-8, 0], H3, -1);
        // Build preview: dashed green line from H2 to a ghost hub, with its cost.
        const p2 = P(...H2), pg = P(...GH);
        ctx.save(); ctx.setLineDash([10, 8]); ctx.lineWidth = 4; ctx.strokeStyle = "rgba(62,240,122,0.95)";
        ctx.beginPath(); ctx.moveTo(p2[0], p2[1]); ctx.lineTo(pg[0], pg[1]); ctx.stroke(); ctx.restore();
        ART.base(ctx, baseP[0], baseP[1], tile, now);
        for (const [pos, col] of hubs) { const p = P(...pos); ART.hub(ctx, p[0], p[1], tile, col, now); }
        ART.hub(ctx, pg[0], pg[1], tile, ACC[3], now, true);
        text("25 + 7 = 32", pg[0], pg[1] - tile * 0.8, 15, "#3ef07a", "center", 0);

        // Carts: one riding H2 -> H1 (toward base), one riding H1 -> base.
        const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        let c1 = lerp2(P(...H2), P(...H1), 0.45);
        ART.cart(ctx, c1[0], c1[1], tile, Math.atan2(P(...H1)[1] - P(...H2)[1], P(...H1)[0] - P(...H2)[0]), gem, drawCrystal, rngAt);
        let c2 = lerp2(P(...H1), baseP, 0.5);
        ART.cart(ctx, c2[0], c2[1], tile, Math.atan2(baseP[1] - P(...H1)[1], baseP[0] - P(...H1)[0]), gem, drawCrystal, rngAt);

        // Gems still in the walls, for scale.
        for (const [gx, gy, v] of [[-1, 2, 12], [11, -2, 38], [-6, -4, 22]]) {
            const p = P(gx, gy); drawCrystal(p[0], p[1], tile * (0.26 + ((v - 10) / 30) * 0.24), rngAt(gx, gy), gem, now, gx * 3);
        }

        // Robots: rotated by heading, name tag + bubble stay screen-upright.
        const bots = [
            { at: [-5, 2.5], h: 70, col: ACC[0], name: "Sparky", say: "anyone need a lift?" },
            { at: [6.5, 3], h: 200, col: ACC[1], name: "Mira", say: "hub at 9,1 is mine - pay up!" },
            { at: [0, 2], h: 300, col: ACC[2], name: "Kobold", crown: true, say: "gg" },
            { at: [-9, 5], h: 120, col: ACC[3], name: "DrillBill" },
            { at: [10, 4], h: 10, col: ACC[4], name: "Zed" },
        ];
        for (const b of bots) {
            const p = P(...b.at);
            ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(b.h * Math.PI / 180);
            drawRobot(0, 0, tile, { player: b.col }, now); ctx.restore();
            ART.nameTag(ctx, p[0], p[1] + tile * 0.55, tile, b.name, b.crown);
            if (b.say) ART.bubble(ctx, p[0], p[1] - tile * 0.5, tile, b.say);
        }
        label("MOCKUP - 2026-10-22 palette, real game textures", W / 2, 24, HUD.amber);
        label("dashed ring = base delivery zone  |  yellow chevrons = track leads toward base  |  dashed green = build preview", W / 2, H - 14, HUD.neon);
    } else {
        tile = 96;
        setWorld(13, 8, () => false);
        const cam = { x: 0, y: 0, h: 0 }, ax = W / 2, ay = H / 2;
        drawWorld(cam, ax, ay);
        const X = (i, n) => (W / n) * (i + 0.5);
        const rowY = [H * 0.2, H * 0.56, H * 0.86];
        // Row 1: robots in accent colours.
        ACC.slice(0, 6).forEach((col, i) => {
            const x = X(i, 6);
            drawRobot(x, rowY[0], tile, { player: col }, now);
            ART.nameTag(ctx, x, rowY[0] + tile * 0.55, tile * 0.8, ["Sparky", "Mira", "Kobold", "DrillBill", "Zed", "Pixel"][i], i === 2);
        });
        label("ROBOTS (accent colour per player, crown = yesterday's winner)", W / 2, 30);
        // Row 2: hubs, base, tracks.
        [ACC[1], ACC[5], ACC[2]].forEach((col, i) => ART.hub(ctx, X(i, 8), rowY[1], tile, col, now));
        ART.hub(ctx, X(3, 8), rowY[1], tile, ACC[3], now, true);
        ART.base(ctx, X(4.55, 8), rowY[1], tile * 0.9, now);
        ART.track(ctx, X(5.85, 8), rowY[1] - tile * 0.55, X(7.4, 8), rowY[1] - tile * 0.55, tile, 1);
        ART.track(ctx, X(5.85, 8), rowY[1] + tile * 0.55, X(7.4, 8), rowY[1] - tile * 0.1, tile, 0);
        label("HUBS (ring = builder's colour, 4th = build preview)", X(1.5, 8), rowY[1] - tile * 1.05);
        label("BASE DEPOT", X(4.55, 8), rowY[1] - tile * 1.65);
        label("TRACKS", X(6.6, 8), rowY[1] - tile * 1.05);
        // Row 3: cart, bubble, crown.
        ART.cart(ctx, X(0.7, 5), rowY[2], tile * 1.2, 0, gem, drawCrystal, rngAt);
        ART.cart(ctx, X(1.7, 5), rowY[2], tile * 1.2, Math.PI / 4, gem, drawCrystal, rngAt);
        ART.bubble(ctx, X(2.9, 5), rowY[2] + tile * 0.4, tile * 1.1, "hello from the deep core!");
        ART.crown(ctx, X(4.1, 5), rowY[2], tile * 0.8);
        label("MINE CARTS (shipping gems)", X(1.2, 5), rowY[2] - tile * 0.95);
        label("CHAT BUBBLE", X(2.9, 5), rowY[2] - tile * 0.95);
        label("CROWN", X(4.1, 5), rowY[2] - tile * 0.95);
    }
}

(async () => {
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
    for (const [kind, w, h] of [["scene", 1400, 900], ["closeups", 1400, 800]]) {
        const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
        await page.addInitScript(() => {
            window.requestAnimationFrame = () => 0;                  // freeze the game's own loop
            window.WebSocket = class { constructor() { this.readyState = 3; } send() { } close() { } };
        });
        await page.goto(`http://localhost:${port}/`);
        await page.addScriptTag({ content: ART_JS + "\nwindow.ART = ART;" });
        await page.evaluate(([w, h]) => {
            for (const id of ["menu", "howto", "pause", "gameover"]) document.getElementById(id).classList.add("hidden");
            canvas.width = w; canvas.height = h;
        }, [w, h]);
        await page.evaluate(`(${scene.toString()})(${JSON.stringify(kind)})`);
        await page.screenshot({ path: path.join(OUT, `${kind}.png`) });
        await page.close();
        console.log("wrote", path.join(OUT, `${kind}.png`));
    }
    await browser.close();
    server.close();
})().catch((e) => { console.error(e); process.exit(1); });
