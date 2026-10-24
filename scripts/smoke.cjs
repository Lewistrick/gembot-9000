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

    // --- Rail UI: ship/travel on a hub, place-hub with ghost tracks, and the pay dialog ---
    // (one page call: server ticks are frozen so the injected state is not overwritten)
    const rail = await a.evaluate(async () => {
        const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const sent = [], steer = [], realSend = window.send, realTick = HANDLERS.tick;
        window.send = (m) => { (m.action === "controls" ? steer : sent).push(m); };   // steering messages are kept apart
        HANDLERS.tick = () => {};
        const out = {};
        try {
            G.speed = 0; G.carts.clear(); G.hubs.clear(); G.others.clear();   // no other robot near enough to take the taps
            G.x = 30; G.y = 20; G.h = 0;                // fixed spot, well away from the base (which would count as the parked hub)
            camFrom = camTo = { x: 30, y: 20, h: 0 };
            const W = canvas.getBoundingClientRect().width, H = canvas.getBoundingClientRect().height;
            const mid = (s) => [(s.ax + s.bx) / 2, (s.ay + s.by) / 2];
            const segsOf = () => railModeSegments(railMode, currentCam(), W / 2, H * ANCHOR_Y);

            // The HUB button is only shown to players who could pay for a hub.
            G.cargo = 0; G.score = 0; await frames();
            out.hiddenWhenBroke = !canAffordHub() && !hudHit.placeHub;
            G.cargo = 0; G.score = 500; await frames();
            out.shownWhenRich = canAffordHub() && !!hudHit.placeHub && canPlaceHub();

            // Place hub: ghost tracks, a tap on one builds it, a tap elsewhere just closes.
            const gx = Math.round(G.x), gy = Math.round(G.y);
            HANDLERS.hubopts({ x: gx, y: gy, opts: [
                { to: 0, x: 0, y: 0, cost: 40, short: 40, len: 15, linked: true },
                { to: 1, x: gx + 12, y: gy, cost: 37, short: 0, len: 12, linked: true }] });
            G.hubs.set(1, { id: 1, x: gx + 12, y: gy, bn: 2, out: 0 });
            await frames();
            out.hubMode = !!railMode && railMode.kind === "hub" && overlayOpen() && !canSteer();
            const hs = segsOf();
            out.hubSegs = hs.length === 2;
            // Every offer has a small box (length, price) and they don't overlap or leave the screen.
            out.boxes = railLabelHits.length === 2 && railLabelHits.every((h) => h.w > 0 && h.x >= 0 && h.y >= 0 && h.x + h.w <= W && h.y + h.h <= H);
            const [b0, b1] = railLabelHits;
            out.boxesApart = !(b0.x < b1.x + b1.w && b1.x < b0.x + b0.w && b0.y < b1.y + b1.h && b1.y < b0.y + b0.h);
            const [mx, my] = mid(hs.find((s) => s.to === 1));
            railTap(mx, my + 1);
            out.hubBuilt = sent.some((m) => m.action === "build_hub" && m.to === 1 && m.x === gx && m.y === gy) && !railMode;
            sent.length = 0;
            HANDLERS.hubopts({ x: gx, y: gy, opts: [
                { to: 0, x: 0, y: 0, cost: 40, short: 0, len: 15, linked: true },
                { to: 1, x: gx + 12, y: gy, cost: 37, short: 0, len: 12, linked: true }] });
            railTap(W - 4, 4);
            out.hubCloses = !railMode && sent.length === 0;

            // The small box of a track is clickable too: tapping it picks that track.
            HANDLERS.hubopts({ x: gx, y: gy, opts: [
                { to: 0, x: 0, y: 0, cost: 40, short: 0, len: 15, linked: true },
                { to: 1, x: gx + 12, y: gy, cost: 37, short: 0, len: 12, linked: true }] });
            await frames();
            const box0 = railLabelHits.find((h) => h.to === 0);
            railTap(box0.x + box0.w / 2, box0.y + box0.h / 2);
            out.boxTap = sent.length === 1 && sent[0].action === "build_hub" && sent[0].to === 0 && !railMode;
            sent.length = 0;
            // The layout copes with tracks that leave in almost the same direction and that run off the screen.
            const sizeB = { w: 96, h: 34 }, region = { x0: 4, y0: 70, x1: W - 4, y1: H - 90 }, avoid = [{ x: W / 2 - 30, y: H * ANCHOR_Y - 30, w: 60, h: 60 }];
            const fan = (angles, len) => angles.map((a) => ({ ax: W / 2, ay: H * ANCHOR_Y, bx: W / 2 + Math.sin(a) * len, by: H * ANCHOR_Y - Math.cos(a) * len }));
            const apart = (rs) => rs.every((r, i) => rs.every((q, j) => i === j || !(r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h)));
            const inside = (rs) => rs.every((r) => r.x >= region.x0 - 1 && r.y >= region.y0 - 1 && r.x + r.w <= region.x1 + 1 && r.y + r.h <= region.y1 + 1);
            const clearOf = (rs) => rs.every((r) => !(r.x < avoid[0].x + avoid[0].w && avoid[0].x < r.x + r.w && r.y < avoid[0].y + avoid[0].h && avoid[0].y < r.y + r.h));
            const cases = [fan([0, 0.05, 0.1], 900), fan([0, 1.2, 2.4, 3.6], 1500), fan([0.3, 0.32, 0.34, 0.36], 60), fan([-1.5, 1.5, 3.1], 400)];
            const laid = cases.map((c) => layoutTrackLabels(c, sizeB, region, avoid).map((p) => p.rect));
            out.layoutApart = laid.every(apart);
            out.layoutOnScreen = laid.every(inside);
            out.layoutClearOfRobot = laid.every(clearOf);
            // Only one possible track: nothing to pick, it is built straight away.
            HANDLERS.hubopts({ x: gx, y: gy, opts: [{ to: 1, x: gx + 12, y: gy, cost: 37, short: 0, len: 12, linked: true }] });
            out.singleBuilds = !railMode && sent.length === 1 && sent[0].action === "build_hub" && sent[0].to === 1
                && sent[0].x === gx && sent[0].y === gy;
            sent.length = 0;

            // The pay dialog: the player must agree before score is used.
            HANDLERS.pay({ label: "Build a hub and track", cost: 45, cargo: 30, score: 15, retry: { action: "build_hub", to: 0, x: 1, y: 2 } });
            out.payOpen = !payBarEl.classList.contains("hidden") && overlayOpen() && $("payText").textContent.includes("15");
            $("payNo").click();
            out.payCancel = payBarEl.classList.contains("hidden") && sent.length === 0;
            HANDLERS.pay({ label: "Travel tolls", cost: 2, cargo: 0, score: 2, retry: { action: "ride", to: 3 } });
            $("payYes").click();
            out.payYes = sent.some((m) => m.action === "ride" && m.to === 3 && m.pay_score === true) && payBarEl.classList.contains("hidden");

            // Parked on a hub: only Ship and Travel; TRAVEL switches a mode on until it is pressed again.
            sent.length = 0;
            G.hubs.clear();
            G.hubs.set(1, { id: 1, x: G.x, y: G.y, bn: 2, out: 0 });
            G.cargo = 5; await frames();
            out.onlyShipTravel = !!parkedHub() && !!hudHit.ship && !!hudHit.travel && !hudHit.placeHub && canShip() && canTravel();
            // SHIP shows what the shipment would pay in tolls on its way home.
            out.shipToll = shipTolls(1) === 1;
            G.hubs.set(3, { id: 3, x: G.x + 40, y: G.y, bn: G.me.num, out: 1 });   // mine, then Bob's, then the base
            G.hubs.set(4, { id: 4, x: G.x + 80, y: G.y, bn: 5, out: 3 });
            out.shipTollChain = shipTolls(3) === 1 && shipTolls(4) === 2 && shipTolls(0) === 0;
            G.cargo = 1;
            out.shipNotWhenTollsEatIt = !canShip();
            G.cargo = 5;
            G.hubs.delete(3); G.hubs.delete(4);
            const near = (s, f) => [s.ax + (s.bx - s.ax) * f, s.ay + (s.by - s.ay) * f];
            const click = (b) => canvas.dispatchEvent(new MouseEvent("click",
                { clientX: canvas.getBoundingClientRect().left + b.x + b.w / 2, clientY: canvas.getBoundingClientRect().top + b.y + b.h / 2, bubbles: true }));
            const tapTrack = (to) => {
                const s = railModeSegments(travelTargets(), currentCam(), W / 2, H * ANCHOR_Y).find((q) => q.to === to);
                if (!s) return false;
                const [tx, ty] = near(s, 0.7);
                tapWorld(tx, ty);
                return true;
            };
            out.travelOff = !travelMode && !travelTargets();
            sent.length = 0;
            tapWorld(W / 2 + 90, H * 0.2);                // not in travel mode: tracks do nothing
            out.travelIdleTap = sent.length === 0;
            click(hudHit.travel);                         // switch on
            out.travelOn = travelMode === true && !!travelTargets();
            await frames();
            out.travelLabel = !!hudHit.travel && !!hudHit.ship && !hudHit.placeHub && !hudHit.flip;   // no about-face button on top of the tracks
            out.travelOne = tapTrack(0) && sent.length === 1 && sent[0].action === "ride" && sent[0].to === 0;
            sent.length = 0;
            out.travelStays = travelMode === true;      // still on after a tap
            // Steering is off in travel mode: a touch or a key must not drive the robot off the hub.
            out.travelNoSteer = !canSteer();
            steer.length = 0;
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
            const ts = railModeSegments(travelTargets(), currentCam(), W / 2, H * ANCHOR_Y).find((q) => q.to === 0);
            const [px, py] = near(ts, 0.7), r0 = canvas.getBoundingClientRect();
            const touch = (type) => canvas.dispatchEvent(new PointerEvent(type,
                { pointerId: 31, pointerType: "touch", clientX: r0.left + px, clientY: r0.top + py, bubbles: true }));
            touch("pointerdown"); touch("pointerup");
            canvas.dispatchEvent(new PointerEvent("click", { pointerType: "touch", clientX: r0.left + px, clientY: r0.top + py, bubbles: true }));   // what a real finger produces
            window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }));
            out.travelTouchRides = sent.length === 1 && sent[0].action === "ride" && sent[0].to === 0;
            out.travelNoDrive = !held.up && !steer.some((m) => m.up);
            sent.length = 0;
            G.hubs.set(2, { id: 2, x: G.x + 10, y: G.y, bn: 3, out: 1 });
            await frames();
            out.travelPick = tapTrack(2) && sent.length === 1 && sent[0].action === "ride" && sent[0].to === 2;
            sent.length = 0;
            tapWorld(W - 4, 4);                           // outside every track: nothing sent, mode stays on
            out.travelOutside = sent.length === 0 && travelMode === true;
            click(hudHit.travel);                         // switch off
            out.travelToggledOff = !travelMode && !travelTargets();
            tapTrack(2);
            out.travelOffNoRide = sent.length === 0;
            // Travel mode needs a track to ride and a hub to be parked on.
            G.hubs.clear(); G.hubs.set(1, { id: 1, x: G.x, y: G.y, bn: 2, out: -1 });
            await frames();
            toggleTravel();
            out.travelNoTrack = !travelMode;
            G.hubs.clear(); G.hubs.set(1, { id: 1, x: G.x, y: G.y, bn: 2, out: 0 });
            G.cargo = 5; await frames();
            doShip();
            out.ship = sent.length === 1 && sent[0].action === "send_cargo";
            sent.length = 0;
            G.cargo = 0; doShip();
            out.shipNeedsCargo = sent.length === 0;
        } finally {
            window.send = realSend; HANDLERS.tick = realTick;
            railMode = null; travelMode = false; G.hubs.clear(); G.cargo = 0; G.score = 0;
        }
        return out;
    });
    for (const [k, what] of [
        ["hiddenWhenBroke", "no HUB button when the player can't pay for a hub"],
        ["shownWhenRich", "the HUB button shows when the player can pay"],
        ["hubMode", "HUB opens a mode that stops steering"],
        ["hubSegs", "HUB offers each candidate as a track"],
        ["boxes", "each track offer has a box that is on screen"],
        ["boxesApart", "the boxes don't overlap"],
        ["boxTap", "tapping a track's box picks that track"],
        ["layoutApart", "labels of nearly parallel or off-screen tracks don't overlap"],
        ["layoutOnScreen", "labels stay inside the screen area"],
        ["layoutClearOfRobot", "labels stay off the robot"],
        ["hubBuilt", "tapping a ghost track builds that one"],
        ["hubCloses", "tapping outside every track closes the HUB menu"],
        ["singleBuilds", "a single possible track is built without asking to pick it"],
        ["payOpen", "a pay request opens the dialog with the missing amount"],
        ["payCancel", "cancelling the dialog pays nothing"],
        ["payYes", "agreeing re-sends the action with pay_score"],
        ["onlyShipTravel", "parked on a hub: only Ship and Travel"],
        ["shipToll", "SHIP counts the tolls the shipment would pay"],
        ["shipTollChain", "the tolls count every other player's hub on the way to the base"],
        ["shipNotWhenTollsEatIt", "SHIP is off when the tolls would eat the whole shipment"],
        ["travelOff", "travel mode starts off"],
        ["travelIdleTap", "tapping the map does nothing while travel mode is off"],
        ["travelOn", "TRAVEL switches travel mode on"],
        ["travelLabel", "travel mode keeps Ship and Travel but hides the about-face button"],
        ["travelOne", "tapping a track in travel mode rides along it"],
        ["travelStays", "travel mode stays on after a ride tap"],
        ["travelNoSteer", "steering is off in travel mode"],
        ["travelTouchRides", "a touch on a track rides along it"],
        ["travelNoDrive", "touching or pressing arrows in travel mode never drives the robot"],
        ["travelPick", "with several tracks, tapping one rides along that one"],
        ["travelOutside", "tapping outside every track does nothing and keeps the mode"],
        ["travelToggledOff", "pressing TRAVEL again switches it off"],
        ["travelOffNoRide", "tracks are inert again once it is off"],
        ["travelNoTrack", "travel mode refuses a hub with no track"],
        ["ship", "Ship sends the cargo to the base"],
        ["shipNeedsCargo", "Ship does nothing without cargo"],
    ]) check(rail[k] === true, what);

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

    // --- Lens and minimap buttons (the compass is gone) ---
    const aids = await a.evaluate(async () => {
        const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const out = { noCompass: typeof drawCompass === "undefined" };
        await frames();
        const rect = canvas.getBoundingClientRect();
        const click = (b) => canvas.dispatchEvent(new MouseEvent("click", { clientX: rect.left + b.x + b.w / 2, clientY: rect.top + b.y + b.h / 2, bubbles: true }));
        out.buttons = !!hudHit.lens && !!hudHit.minimap;
        click(hudHit.lens);
        out.arrowsOn = G.showArrows === true;
        G.hubs.set(1, { id: 1, x: Math.round(G.x) + 6, y: Math.round(G.y), bn: 2, out: 0 });
        await frames(); await frames();                  // arrows to the base, a gem (if any) and the hub draw
        out.nearestGem = nearestGem(G.x, G.y) === null || nearestGem(G.x, G.y).length === 3;
        // A mega gem's arrow is white with a gem-coloured glow, so it can't be taken for the base's.
        const ng = nearestGem(G.x, G.y);
        if (ng) {
            const c = [...chunks.values()].find((ch) => ch.gems.some((g) => g[0] === ng[0] && g[1] === ng[1]));
            c.mega.add(ng[0] + "," + ng[1]);
            await frames();
            const t = lensTargets.find((x) => x.mega);
            out.megaArrow = !!t && t.color === "#ffffff" && t.glow === curColors().gem && t.color !== lensTargets[0].color;
            c.mega.delete(ng[0] + "," + ng[1]);
        } else out.megaArrow = true;
        click(hudHit.lens);
        out.arrowsOff = G.showArrows === false;
        click(hudHit.minimap);
        out.mapOn = G.showMap === true;
        await frames(); await frames();                  // the minimap draws floor, rock, gems and hubs
        click(hudHit.minimap);
        out.mapOff = G.showMap === false;
        out.netButton = !!hudHit.network && hudHit.network.x > hudHit.minimap.x;
        G.hubs.set(1, { id: 1, x: 40, y: -10, bn: 2, out: 0 });
        G.hubs.set(2, { id: 2, x: 70, y: 30, bn: 3, out: 1 });
        const realTick = HANDLERS.tick;
        HANDLERS.tick = () => {};
        const ptr = (type, id, x, y, kind = "mouse") => canvas.dispatchEvent(new PointerEvent(type,
            { pointerId: id, pointerType: kind, clientX: rect.left + x, clientY: rect.top + y, bubbles: true }));
        const W = rect.width, H = rect.height;
        click(hudHit.network);
        out.netOn = G.showNetwork === true && overlayOpen() && !canSteer();
        await frames(); await frames();                  // fullscreen, north up, base and you marked
        out.netCross = !!hudHit.netClose && !hudHit.hamburger && !hudHit.minimap && hudHit.netClose.x > W / 2;
        const fit = netView.sc, c0 = [netView.cx, netView.cy];
        // Scroll zooms about the pointer: the world point under it stays put.
        const wx = netView.cx + (W * 0.7 - W / 2) / netView.sc, wy = netView.cy + (H * 0.3 - H / 2) / netView.sc;
        canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, clientX: rect.left + W * 0.7, clientY: rect.top + H * 0.3, bubbles: true, cancelable: true }));
        out.netZoomIn = netView.sc > fit * 1.3;
        out.netZoomAnchored = Math.abs(netView.cx + (W * 0.7 - W / 2) / netView.sc - wx) < 0.01
            && Math.abs(netView.cy + (H * 0.3 - H / 2) / netView.sc - wy) < 0.01;
        canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100000, clientX: rect.left + W / 2, clientY: rect.top + H / 2, bubbles: true, cancelable: true }));
        out.netZoomLimit = netView.sc >= fit * 0.5 - 1e-9 && netView.sc < fit;
        // Drag pans: the map follows the finger.
        const before = [netView.cx, netView.cy];
        ptr("pointerdown", 5, 300, 300); ptr("pointermove", 5, 340, 320); ptr("pointerup", 5, 340, 320);
        out.netPan = netView.cx < before[0] && netView.cy < before[1];
        // Pinch: two fingers moving apart zoom in.
        const s0 = netView.sc;
        ptr("pointerdown", 6, 300, 300, "touch"); ptr("pointerdown", 7, 400, 300, "touch");
        ptr("pointermove", 7, 500, 300, "touch");
        ptr("pointerup", 6, 300, 300, "touch"); ptr("pointerup", 7, 500, 300, "touch");
        out.netPinch = netView.sc > s0 * 1.5;
        await frames();
        // A drag that ends on the cross does not close the map; a plain click on it does.
        const cr = hudHit.netClose, mid = [cr.x + cr.w / 2, cr.y + cr.h / 2];
        ptr("pointerdown", 8, 300, 300); ptr("pointermove", 8, mid[0], mid[1]); ptr("pointerup", 8, mid[0], mid[1]);
        click(cr);
        out.netDragNoClose = G.showNetwork === true;
        ptr("pointerdown", 9, mid[0], mid[1]); ptr("pointerup", 9, mid[0], mid[1]);
        click(cr);
        out.netOff = G.showNetwork === false && !overlayOpen();
        // Reopening starts from the whole network again; Esc also leaves.
        await frames();
        click(hudHit.network);
        out.netRefit = G.showNetwork === true && Math.abs(netView.sc - fit) < 1e-6 && Math.abs(netView.cx - c0[0]) < 1e-6;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        out.netEsc = G.showNetwork === false;
        HANDLERS.tick = realTick;
        G.hubs.clear();
        return out;
    });
    for (const [k, what] of [
        ["noCompass", "the compass is gone"],
        ["buttons", "the lens and minimap buttons are in the top bar"],
        ["arrowsOn", "the lens button shows the arrows"],
        ["nearestGem", "the nearest gem can be found"],
        ["megaArrow", "the arrow to a mega gem is white with a gem-coloured glow"],
        ["arrowsOff", "clicking the lens again hides them"],
        ["mapOn", "the minimap button shows the minimap"],
        ["mapOff", "clicking it again hides the minimap"],
        ["netButton", "the network button sits next to the minimap button"],
        ["netOn", "the network button opens a fullscreen map that stops steering"],
        ["netCross", "the map has a cross and covers the other buttons"],
        ["netZoomIn", "scrolling up zooms in"],
        ["netZoomAnchored", "zoom keeps the point under the pointer in place"],
        ["netZoomLimit", "zooming out stops at half the fitted scale"],
        ["netPan", "dragging pans the map"],
        ["netPinch", "pinching zooms"],
        ["netDragNoClose", "a drag ending on the cross doesn't close the map"],
        ["netOff", "the cross leaves the network map"],
        ["netRefit", "reopening shows the whole network again"],
        ["netEsc", "Escape leaves the network map"],
    ]) check(aids[k] === true, what);

    // --- Banking: a "+amount" floats up from the robot and fades; tolls make the score blink ---
    const bank = await a.evaluate(async () => {
        const frames = (n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
        const out = {};
        G.floats.length = 0; G.scoreFlash = 0; G.toasts.length = 0;
        HANDLERS.delivered({ v: 57 });
        out.floatAdded = G.floats.length === 1 && G.floats[0].v === 57;
        await frames(12);                                  // drawn (above the robot) without errors
        out.floatStays = G.floats.length === 1;
        out.noBlinkForOwnGems = G.scoreFlash === 0;
        HANDLERS.toll({ v: 1, from: "Zed" });
        out.blink = performance.now() - G.scoreFlash < 100;
        await frames(12);
        await new Promise((r) => setTimeout(r, 1900));
        await frames(3);
        out.floatFades = G.floats.length === 0;
        // A crash scatters gems (they vanish quickly) and shows a small pop-up.
        HANDLERS.crash({ v: 4 });
        out.crashChips = G.chips.length === 11 && G.crashes.length === 1 && G.crashes[0].v === 4;
        await frames(8);                                    // drawn without errors
        await new Promise((r) => setTimeout(r, 800));
        await frames(2);
        out.chipsGone = G.chips.length === 0 && G.crashes.length === 1;   // the pebbles go first, the pop-up a bit later
        await new Promise((r) => setTimeout(r, 800));
        await frames(2);
        out.popupGone = G.crashes.length === 0;
        // Mining a gem floats a gem icon with the amount.
        G.floats.length = 0;
        HANDLERS.gain({ v: 12, mega: false });
        out.mineFloat = G.floats.length === 1 && G.floats[0].v === 12 && G.floats[0].gem === true;
        HANDLERS.gain({ v: 300, mega: true });
        out.megaFloat = G.floats.length === 2 && G.floats[1].mega === true;
        await frames(6);                                    // drawn without errors
        G.floats.length = 0;
        // A finished build floats what it cost, as a negative amount; track offers show length and price.
        HANDLERS.built({ v: 39 });
        out.costFloat = G.floats.length === 1 && G.floats[0].v === -39;
        await frames(6);
        out.noCostWithoutAmount = (HANDLERS.built({}), G.floats.length === 1);
        G.floats.length = 0;
        out.labelPlain = JSON.stringify(trackLabelLines({ len: 19.6, cost: 45, short: 0 })) === JSON.stringify(["length: 20m", "cost: 45"]);
        out.labelNoScore = JSON.stringify(trackLabelLines({ len: 20, cost: 45, short: 15 })) === JSON.stringify(["length: 20m", "cost: 45"]);   // paying by score is asked about afterwards
        G.toasts.length = 0; G.scoreFlash = 0;
        return out;
    });
    for (const [k, what] of [
        ["floatAdded", "banking gems floats the amount above the robot"],
        ["floatStays", "the amount stays for a moment"],
        ["noBlinkForOwnGems", "banking your own gems doesn't blink the score"],
        ["blink", "a toll makes the score blink"],
        ["floatFades", "the amount fades away"],
        ["crashChips", "a crash scatters gem pebbles and shows a pop-up"],
        ["chipsGone", "the pebbles disappear quickly"],
        ["popupGone", "the pop-up goes away too"],
        ["mineFloat", "mining a gem floats a gem icon with the amount"],
        ["megaFloat", "a mega gem floats too"],
        ["costFloat", "a finished build floats its cost as a negative amount"],
        ["noCostWithoutAmount", "a build without an amount floats nothing"],
        ["labelPlain", "a track offer's box says 'length: 20m' and 'cost: 45'"],
        ["labelNoScore", "the box never mentions paying from score"],
    ]) check(bank[k] === true, what);

    // --- Camera: follows the robot the short way round, and lazily while riding ---
    const camTest = await a.evaluate(async () => {
        const realTick = HANDLERS.tick, saved = { from: camFrom, to: camTo, h: camH, riding: G.riding };
        HANDLERS.tick = () => {};
        const out = {};
        try {
            const p = robotPose(), at = (h) => { camFrom = camTo = { x: p.x, y: p.y, h }; };
            const settleFrom = async (start, target, riding, ms) => {
                G.riding = riding; rodeAt = riding ? performance.now() : -1e9;
                at(target); camH = start; camHAt = performance.now();
                await new Promise((r) => setTimeout(r, ms));
                return camH;
            };
            const h1 = await settleFrom(0, Math.PI * 2 - 0.4, false, 150);   // 0.4 rad to the left, written as almost a full turn
            out.shortWay = h1 < 0 && h1 > -0.41;
            const driving = await settleFrom(0, 1.0, false, 200), riding = await settleFrom(0, 1.0, true, 200);
            out.slowWhileRiding = riding > 0.05 && riding < driving * 0.75;
            const big = await settleFrom(0, 1.6, true, 150), small = await settleFrom(0, 0.2, true, 150);
            out.fasterWhenFarOff = big > small * 4;
        } finally {
            HANDLERS.tick = realTick; camFrom = saved.from; camTo = saved.to; camH = saved.h; G.riding = saved.riding; rodeAt = -1e9;
        }
        return out;
    });
    for (const [k, what] of [
        ["shortWay", "the camera turns the short way round"],
        ["slowWhileRiding", "the camera swings slower while riding"],
        ["fasterWhenFarOff", "the camera turns faster when it is far off"],
    ]) check(camTest[k] === true, what);

    // --- Light: dark away from hubs, a notice at pitch black, and being sent home ---
    const light = await a.evaluate(async () => {
        const frames = (n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
        const realTick = HANDLERS.tick, saved = { x: G.x, y: G.y, from: camFrom, to: camTo };
        HANDLERS.tick = () => {};
        const out = {};
        try {
            G.hubs.clear(); G.toasts.length = 0;
            const at = (x, y) => { G.x = x; G.y = y; camFrom = camTo = { x, y, h: 0 }; };
            at(40, 0);
            await frames(60);
            out.litNearBase = G.dark === 0 && G.lightD < 50;
            at(175, 0);                                  // halfway between 100 and 250
            await frames(60);
            out.dim = G.dark > 0.45 && G.dark < 0.55;
            out.noNoticeYet = !G.toasts.some((t) => t.text.includes("pitch dark"));
            out.gentleWarn = G.toasts.filter((t) => t.text.startsWith("Getting dark")).length === 1;
            at(260, 0);
            await frames(90);
            out.black = G.dark === 1 && G.lightD >= G.light[1];
            out.pitchNotice = G.toasts.some((t) => t.text.includes("Hubs are required"));
            G.hubs.set(1, { id: 1, x: 250, y: 0, bn: 2, out: 0 });   // a hub brings the light back
            await frames(90);
            out.hubLights = G.dark === 0 && G.toasts.length > 0;
            // Sent home: the notice explains it, and the camera jumps instead of flying across the map.
            HANDLERS.lost({ v: 7 });
            out.lostNotice = G.toasts.some((t) => t.text.includes("lost in the dark") && t.text.includes("7"));
            HANDLERS.tick = realTick;
            realTick({ x: 3, y: 4, h: 0, s: 0, c: 1, sc: 0, f: false, r: 0 });
            const p = robotPose();
            out.snaps = Math.hypot(p.x - 3, p.y - 4) < 1e-6;
        } finally {
            HANDLERS.tick = realTick; G.hubs.clear(); G.dark = 0; G.toasts.length = 0;
            G.x = saved.x; G.y = saved.y; camFrom = saved.from; camTo = saved.to;
        }
        return out;
    });
    for (const [k, what] of [
        ["litNearBase", "no darkness near the base"],
        ["dim", "halfway between 100 and 250 tiles from a hub the screen is half dark"],
        ["noNoticeYet", "no darkness notice before it is pitch dark"],
        ["gentleWarn", "past 150 tiles a small 'getting dark' notice shows once"],
        ["black", "completely dark at 250 tiles"],
        ["pitchNotice", "pitch black says hubs are required to provide light"],
        ["hubLights", "a hub nearby brings the light back"],
        ["lostNotice", "being sent home shows the lost message"],
        ["snaps", "the camera jumps when sent back to base"],
    ]) check(light[k] === true, what);

    // --- Tap robots: yours edits your message, someone else's opens their menu ---
    // (done inside one page call: the server's next update would drop an injected robot)
    const taps = await a.evaluate(async () => {
        const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const realTick = HANDLERS.tick;
        HANDLERS.tick = () => {};     // freeze server updates so they can't drop the injected robot
        G.others.set(77, { from: { x: G.x + 2, y: G.y, h: 0 }, to: { x: G.x + 2, y: G.y, h: 0 }, t0: performance.now(), f: 0 });
        G.meta.set(77, { n: 77, id: "zed-id", name: "Zed", chat: "yo", hue: 200 });
        G.score = 500;                // enough to pay for a hub, so the HUB button is shown
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
        G.score = 0;
        HANDLERS.tick = realTick;
        return out;
    });
    check(taps.targets, "both robots are tap targets");
    check(taps.hud, "HUD has the hub button and no social buttons");
    check(taps.menuOpen, "tapping another robot opens its menu");
    check(taps.blocked, "the menu blocks and shows Unblock");
    check(taps.menuClosed, "the menu closes");
    check(taps.editor, "tapping your own robot opens the message editor");

    // --- How to Play slideshow: slides, arrows, keys, pictures, markers, the random banked amount ---
    const how = await a.evaluate(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const out = {};
        openPause();
        $("pauseHowBtn").click();
        await wait(400);                                   // the marker positions load
        const title = () => document.querySelector("#slide .stitle").textContent;
        const shown = (id) => !document.getElementById(id).classList.contains("hidden");
        out.opens = !howtoEl.classList.contains("hidden") && SLIDES.length >= 10;
        out.oneImageThreeLines = SLIDES.every((sl) => (!sl.imgs || sl.imgs.length <= 1) && (!sl.lines || sl.lines.length <= 3));
        out.first = title() === "You are a GemBot. Your goal is to collect gems." && $("slideCount").textContent.startsWith("1 /");
        out.firstArrows = shown("slideNext") && !shown("slidePrev");
        out.firstPicture = !!document.querySelector("#slide img") && document.querySelectorAll("#slide .mk").length >= 2;
        $("slideNext").click();
        out.second = title() === "Bring gems to the base to score points." && shown("slidePrev") && shown("slideNext");
        const amount = document.querySelector("#slide .floatamt").textContent;
        out.randomAmount = /^\+\d+$/.test(amount) && +amount.slice(1) >= 30 && +amount.slice(1) <= 100;
        const seen = new Set();
        for (let i = 0; i < 12; i++) { await wait(2700); seen.add(document.querySelector("#slide .floatamt").textContent); if (seen.size > 1) break; }
        out.amountChanges = seen.size > 1;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        out.third = document.querySelector("#slide .steerbox") !== null && document.querySelectorAll("#slide .steerbox").length === 2
            && [...document.querySelectorAll("#slide .steerbox")].every((b) => b.querySelectorAll("li").length <= 3)
            && /Keyboard/.test(howtoSlideEl.textContent) && /Phone/.test(howtoSlideEl.textContent);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        out.backOne = title().startsWith("Bring gems");
        // every slide renders, every picture loads, and every marker landed on its picture
        let broken = [], noMarks = [];
        for (let i = 0; i < SLIDES.length; i++) {
            goSlide(i);
            for (const img of howtoSlideEl.querySelectorAll("img")) {
                if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; });
                if (!img.naturalWidth) broken.push(img.getAttribute("src"));
            }
            const wanted = SLIDES[i].imgs ? SLIDES[i].imgs.reduce((n, im) => n + im.marks.length, 0) : 0;
            const got = howtoSlideEl.querySelectorAll(".mk").length;
            if (got < wanted * 0.6) noMarks.push(`${i + 1}:${got}/${wanted}`);     // a few may sit off-screen in a picture
        }
        out.picturesLoad = broken.length === 0;
        out.broken = broken.join(",");
        out.markersPlaced = noMarks.length === 0;
        out.noMarks = noMarks.join(",");
        out.lastSlide = !shown("slideNext") && shown("slidePrev") && $("slideCount").textContent.startsWith(`${SLIDES.length} /`);
        $("slideDots").querySelectorAll("button")[0].click();
        out.dots = title().startsWith("You are a GemBot");
        $("backBtn").click();
        out.backToPause = howtoEl.classList.contains("hidden") && !pauseEl.classList.contains("hidden");
        $("resumeBtn").click();
        return out;
    });
    for (const [k, what] of [
        ["opens", "How to Play opens a slideshow"],
        ["oneImageThreeLines", "every slide has at most one picture and three lines"],
        ["first", "slide 1 is 'You are a GemBot. Your goal is to collect gems.'"],
        ["firstArrows", "slide 1 has only the right arrow"],
        ["firstPicture", "slide 1 has a picture with blinking markers"],
        ["second", "the right arrow leads to slide 2 about banking, with both arrows"],
        ["randomAmount", "slide 2 floats a random 30-100 amount"],
        ["amountChanges", "the amount changes each time it floats up"],
        ["third", "slide 3 shows the steering for keyboard and phone"],
        ["backOne", "the left arrow key goes back a slide"],
        ["picturesLoad", `every slide picture loads ${how.broken || ""}`],
        ["markersPlaced", `every picture gets its markers ${how.noMarks || ""}`],
        ["lastSlide", "the last slide has only the left arrow"],
        ["dots", "the dots jump to a slide"],
        ["backToPause", "Back returns to where How to Play was opened"],
    ]) check(how[k] === true, what);

    // --- Status + leave ---
    const status = await (await fetch(`http://localhost:${PORT}/api/status`)).json();
    check(status.online === 2, `status reports 2 online (got ${status.online})`);
    await a.evaluate(() => leaveGame());
    await sleep(500);
    const after = await (await fetch(`http://localhost:${PORT}/api/status`)).json();
    check(after.online === 1, `leaving frees the slot (online=${after.online})`);

    // --- How to Play on phones: arrows at the sides, nothing wider than the screen, slides fit ---
    for (const [label, vp] of [["phone upright", { width: 390, height: 664 }], ["phone on its side", { width: 750, height: 342 }], ["small phone", { width: 320, height: 480 }]]) {
        const ctxP = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: true });
        const p = await ctxP.newPage();
        watch(p, label);
        await p.goto(`http://localhost:${PORT}/`);
        p.versioned = await p.evaluate(() => [...document.scripts].every((s) => /\?v=\w{10}$/.test(s.src))
            && /\?v=\w{10}$/.test(document.querySelector("link[rel=stylesheet]").href));
        await p.click("#howBtn");
        await p.waitForFunction(() => typeof howtoShots !== "undefined" && howtoShots, null, { timeout: 5000 });
        const lay = await p.evaluate(async () => {
            const res = { sides: true, wide: 0, overflow: [], hint: true };
            for (let i = 0; i < SLIDES.length; i++) {
                goSlide(i);
                for (const img of howtoSlideEl.querySelectorAll("img")) if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; });
                await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                const sl = howtoSlideEl.getBoundingClientRect(), n = $("slideNext").getBoundingClientRect(), pv = $("slidePrev").getBoundingClientRect();
                if (i > 0 && !(pv.width && pv.right <= sl.left + 1 && pv.left <= 8)) res.sides = false;
                if (i < SLIDES.length - 1 && !(n.width && n.left >= sl.right - 1 && n.right >= innerWidth - 8)) res.sides = false;
                for (const e of document.querySelectorAll("#howto *")) { const b = e.getBoundingClientRect(); if (b.width && (b.right > innerWidth + 1 || b.left < -1)) res.wide++; }
                const over = howtoSlideEl.scrollHeight - howtoSlideEl.clientHeight;
                if (over > 6) {
                    res.overflow.push(i + 1);
                    if (!howtoSlideEl.classList.contains("more")) res.hint = false;   // a slide that doesn't fit says so
                }
            }
            const back = $("backBtn").getBoundingClientRect();
            res.backVisible = back.bottom <= innerHeight && back.top >= 0;
            return res;
        });
        check(p.versioned, `${label}: scripts and styles are loaded with a version, so phones never mix in stale files`);
        check(lay.sides, `${label}: the slide arrows sit on the left and right of the screen, beside the slide`);
        check(lay.wide === 0, `${label}: nothing on the slides is wider than the screen`);
        check(lay.backVisible, `${label}: the Back button is on screen`);
        check(lay.hint, `${label}: a slide that doesn't fit shows a 'more below' hint`);
        if (label !== "small phone") check(lay.overflow.length === 0, `${label}: every slide fits on the screen${lay.overflow.length ? " (not: " + lay.overflow.join(",") + ")" : ""}`);
        await ctxP.close();
    }

    check(errors.length === 0, `no JavaScript errors${errors.length ? ": " + errors.join(" | ") : ""}`);
    check(!/Traceback/.test(serverLog), "no server tracebacks");
    if (/Traceback/.test(serverLog)) console.log(serverLog.slice(-1500));

    await browser.close();
    server.kill();
    console.log(failures ? `${failures} check(s) FAILED` : "all smoke checks passed");
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
