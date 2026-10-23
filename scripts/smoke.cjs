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
            const [mx, my] = mid(hs.find((s) => s.to === 1));
            railTap(mx, my + 1);
            out.hubBuilt = sent.some((m) => m.action === "build_hub" && m.to === 1 && m.x === gx && m.y === gy) && !railMode;
            sent.length = 0;
            HANDLERS.hubopts({ x: gx, y: gy, opts: [
                { to: 0, x: 0, y: 0, cost: 40, short: 0, len: 15, linked: true },
                { to: 1, x: gx + 12, y: gy, cost: 37, short: 0, len: 12, linked: true }] });
            railTap(W - 4, 4);
            out.hubCloses = !railMode && sent.length === 0;

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
            out.travelLabel = !!hudHit.travel && !!hudHit.ship && !hudHit.placeHub;
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
            canvas.dispatchEvent(new MouseEvent("click", { clientX: r0.left + px, clientY: r0.top + py, bubbles: true }));
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
        ["hubBuilt", "tapping a ghost track builds that one"],
        ["hubCloses", "tapping outside every track closes the HUB menu"],
        ["singleBuilds", "a single possible track is built without asking to pick it"],
        ["payOpen", "a pay request opens the dialog with the missing amount"],
        ["payCancel", "cancelling the dialog pays nothing"],
        ["payYes", "agreeing re-sends the action with pay_score"],
        ["onlyShipTravel", "parked on a hub: only Ship and Travel"],
        ["travelOff", "travel mode starts off"],
        ["travelIdleTap", "tapping the map does nothing while travel mode is off"],
        ["travelOn", "TRAVEL switches travel mode on"],
        ["travelLabel", "travel mode keeps the Ship and Travel buttons"],
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
