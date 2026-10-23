// Headless-browser smoke test: two players join a real server, drive, chat, block and
// steer by touch. It checks for JavaScript errors and that the protocol works end
// to end. It never judges how anything looks.
//
// Run:  NODE_PATH=/opt/node22/lib/node_modules node scripts/smoke.cjs

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require("playwright");

const net = require("net");
let PORT = 8765;   // replaced by a free port at start-up
const ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, what) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
}

async function waitFor(page, fn, what, timeout = 8000) {
    try { await page.waitForFunction(fn, null, { timeout }); check(true, what); }
    catch (e) { check(false, what); }
}

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
}

(async () => {
    PORT = await freePort();
    const server = spawn("uv", ["run", "uvicorn", "app.server:app", "--port", String(PORT)],
        { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", GEMBOT_DB: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gembot-smoke-")), "smoke.db") } });
    process.on("exit", () => { try { process.kill(-server.pid); } catch (e) { /* already gone */ } });   // never leave a server behind, even if a check throws
    let serverLog = "";
    server.stderr.on("data", (d) => (serverLog += d));
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`http://localhost:${PORT}/api/status`)).ok) break; } catch (e) { /* not up yet */ }
        await sleep(250);
    }

    const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
    const errors = [];
    const watch = (page, tag) => {
        page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
        page.on("console", (m) => { if (m.type() === "error") errors.push(`${tag} console: ${m.text()}`); });
    };

    const ctxA = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const ctxB = await browser.newContext({ viewport: { width: 400, height: 800 }, hasTouch: true });
    const a = await ctxA.newPage(), b = await ctxB.newPage();
    watch(a, "A"); watch(b, "B");
    await a.goto(`http://localhost:${PORT}/`);
    await b.goto(`http://localhost:${PORT}/`);

    // --- A joins and drives with the keyboard ---
    await a.fill("#nick", "Ann");
    await a.click("#playBtn");
    await waitFor(a, () => G.state === "playing" && chunks.size > 0, "A joined and received terrain");
    const y0 = await a.evaluate(() => G.y);
    await a.keyboard.down("ArrowUp");
    await sleep(1500);
    await a.keyboard.up("ArrowUp");
    const moved = await a.evaluate((y) => Math.hypot(G.x, G.y - y) > 0.5 || Math.hypot(G.x, G.y) > 0.5, y0);
    check(moved, "A moved after holding ArrowUp");

    // --- A chats ---
    await a.keyboard.press("Enter");
    await a.keyboard.type("hello from Ann");
    await a.keyboard.press("Enter");

    // --- B (touch) joins, sees A's chat, blocks A ---
    await b.fill("#nick", "Bob");
    await b.click("#playBtn");
    await waitFor(b, () => G.state === "playing", "B joined");
    await waitFor(b, () => [...G.meta.values()].some((m) => m.name === "Ann" && m.chat === "hello from Ann"),
        "B sees Ann's chat bubble text");

    // --- Touch steering: left only, right only, both, none ---
    const sendTouch = (type, id, x, y) => b.evaluate(([type, id, x, y]) => {
        const r = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent(type, { pointerType: "touch", pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true }));
        return lastControls;
    }, [type, id, x, y]);
    let c = JSON.parse(await sendTouch("pointerdown", 1, 60, 300));
    check(c.up && c.left && !c.right && !c.down, "touch: left half = forward + left");
    c = JSON.parse(await sendTouch("pointerdown", 2, 340, 300));
    check(c.up && !c.left && !c.right, "touch: both halves = straight");
    c = JSON.parse(await sendTouch("pointerup", 1, 60, 300));
    check(c.up && c.right && !c.left, "touch: right half only = forward + right");
    c = JSON.parse(await sendTouch("pointerup", 2, 340, 300));
    check(c.down && !c.up, "touch: no finger = brake");

    // --- Blocking hides the bubble for B only ---
    const annId = await b.evaluate(() => [...G.meta.values()].find((m) => m.name === "Ann").id);
    await b.evaluate((id) => toggleBlock(id), annId);
    check(await b.evaluate((id) => blocked.has(id), annId), "B can block Ann (stored locally)");
    check(await a.evaluate(() => blocked.size === 0), "A's block list is unaffected");

    // --- Rail UI: feed the page server-style messages and exercise the panels ---
    await a.evaluate(() => {
        HANDLERS.hubs({ list: [[1, 14, 0, 1, 0], [2, 28, 0, 2, 1]] });
        G.carts.set(1, { from: { x: 10, y: 0, h: 0 }, to: { x: 11, y: 0, h: 0 }, t0: performance.now(), a: 0 });
        HANDLERS.rail({ ok: true, msg: "Built (-39)" });
        HANDLERS.toll({ v: 1, from: "Bob" });
    });
    await sleep(300);   // let a few frames draw tracks, hubs, the cart and toasts
    await a.evaluate(() => HANDLERS.net({
        at: 2, cargo: 5, ship: { toll: 1 },
        hubs: [
            { id: 0, x: 0, y: 0, out: null, by: "BASE", bn: 0, toll: 1 },
            { id: 1, x: 14, y: 0, out: 0, by: "Ann", bn: 1, toll: 1 },
            { id: 2, x: 28, y: 0, out: 1, by: "Bob", bn: 2, toll: 0 },
        ],
    }));
    check(await a.evaluate(() => !netMapEl.classList.contains("hidden")), "network map opens");
    check(await a.evaluate(() => canSteer() === false), "steering is off while the map is open");
    await a.evaluate(() => { const h = nmHits.find((x) => x.id === 1); $("nmCanvas").dispatchEvent(new MouseEvent("click", { clientX: $("nmCanvas").getBoundingClientRect().left + h.px, clientY: $("nmCanvas").getBoundingClientRect().top + h.py, bubbles: true })); });
    check(await a.evaluate(() => nmSel === 1 && !$("nmRide").disabled), "tapping a hub selects it and enables Ride");
    check(await a.evaluate(() => !$("nmShip").disabled && !$("nmBase").disabled), "ship and ride-to-base are offered");
    await a.keyboard.press("Escape");
    check(await a.evaluate(() => netMapEl.classList.contains("hidden")), "Escape closes the map");

    await a.evaluate(() => {   // build mode with a fake preview
        buildMode = { target: { x: 40, y: 0 }, preview: null };
        onQuote({ ok: true, why: "", cost: 39, x: 40, y: 0, from: [28, 0], new: true, len: 12 });
    });
    await sleep(200);
    check(await a.evaluate(() => !$("buildOk").disabled && overlayOpen()), "a good quote enables Build");
    await a.evaluate(() => onQuote({ ok: false, why: "Rock in the way", cost: 0, x: 40, y: 0, from: [28, 0], new: true, len: 12 }));
    await sleep(200);
    check(await a.evaluate(() => $("buildOk").disabled), "a refused quote disables Build");
    await a.evaluate(() => endBuildMode());
    check(await a.evaluate(() => !buildMode && !overlayOpen()), "build mode ends cleanly");
    await a.evaluate(() => { G.hubs.clear(); G.carts.clear(); });

    // --- Drilling: tiles become floor, rubble and sparks draw without errors ---
    await a.evaluate(() => {
        HANDLERS.drilled({ c: [[50, 50], [51, 50]] });
        G.drill = 0.6;
        G.cargo = 3;
    });
    check(await a.evaluate(() => drilled.size === 2 && isFloor(50, 50) && isFloor(51, 50)),
        "drilled tiles count as floor on the client");
    await a.evaluate(() => { G.others.set(99, { from: { x: 2, y: 2, h: 0 }, to: { x: 2, y: 2, h: 0 }, t0: performance.now(), f: 2 }); G.meta.set(99, { n: 99, id: "zz", name: "Drillbot", chat: "", hue: 40 }); });
    await sleep(300);   // frames with the progress ring, sparks and another robot drilling
    await a.evaluate(() => { G.others.delete(99); G.meta.delete(99); G.drill = 0; clearWorld(); });
    check(await a.evaluate(() => drilled.size === 0), "leaving the world forgets drilled tiles");

    // --- Tap robots: yours edits your message, someone else's opens their menu ---
    // (done inside one page call: the server's next update would drop an injected robot)
    const taps = await a.evaluate(async () => {
        const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const realTick = HANDLERS.tick;
        HANDLERS.tick = () => {};     // freeze server updates so they can't drop the injected robot
        G.others.set(77, { from: { x: G.x + 2, y: G.y, h: 0 }, to: { x: G.x + 2, y: G.y, h: 0 }, t0: performance.now(), f: 0 });
        G.meta.set(77, { n: 77, id: "zed-id", name: "Zed", chat: "yo", hue: 200 });
        const find = () => [robotHits.find((r) => r.meta && r.meta.name === "Zed"), robotHits.find((r) => r.me)];
        for (let i = 0; i < 40 && !(find()[0] && find()[1]); i++) await frames();   // wait for a frame that drew both
        const out = {};
        const [other, mine] = find();
        out.targets = !!other && !!mine;
        if (!out.targets) { HANDLERS.tick = realTick; return out; }
        out.hud = !!hudHit.placeHub && !hudHit.chat && !hudHit.players && !hudHit.rails;
        tapRobot(other.x, other.y);
        out.menuOpen = !playerMenuEl.classList.contains("hidden") && $("pmName").textContent === "Zed" && overlayOpen();
        $("pmBlock").click();
        out.blocked = blocked.has("zed-id") && $("pmBlock").textContent.startsWith("Unblock");
        $("pmClose").click();
        out.menuClosed = playerMenuEl.classList.contains("hidden") && !overlayOpen();
        tapRobot(mine.x, mine.y);
        out.editor = !chatBarEl.classList.contains("hidden");
        closeChat();
        G.others.delete(77); G.meta.delete(77); blocked.delete("zed-id");
        HANDLERS.tick = realTick;
        return out;
    });
    check(taps.targets, "both robots are tap targets");
    check(taps.hud, "HUD has the hub button and no social buttons");
    check(taps.menuOpen, "tapping another robot opens its menu");
    check(taps.blocked, "the menu blocks and shows Unblock");
    check(taps.menuClosed, "the menu closes");
    check(taps.editor, "tapping your own robot opens the message editor");

    // --- Status + leave ---
    const status = await (await fetch(`http://localhost:${PORT}/api/status`)).json();
    check(status.online === 2, `status reports 2 online (got ${status.online})`);
    await a.evaluate(() => leaveGame());
    await sleep(500);
    const after = await (await fetch(`http://localhost:${PORT}/api/status`)).json();
    check(after.online === 1, `leaving frees the slot (online=${after.online})`);

    check(errors.length === 0, `no JavaScript errors${errors.length ? ": " + errors.join(" | ") : ""}`);
    check(!/Traceback/.test(serverLog), "no server tracebacks");
    if (/Traceback/.test(serverLog)) console.log(serverLog.slice(-1500));

    await browser.close();
    server.kill();
    console.log(failures ? `${failures} check(s) FAILED` : "all smoke checks passed");
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
