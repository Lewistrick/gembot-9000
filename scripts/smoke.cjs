// Headless-browser smoke test: two players join a real server, drive, chat, block and
// steer by touch. It checks for JavaScript errors and that the protocol works end
// to end. It never judges how anything looks.
//
// Run:  NODE_PATH=/opt/node22/lib/node_modules node scripts/smoke.cjs

const { spawn } = require("child_process");
const path = require("path");
const { chromium } = require("playwright");

const PORT = 8765;
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

(async () => {
    const server = spawn("uv", ["run", "uvicorn", "app.server:app", "--port", String(PORT)],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
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
