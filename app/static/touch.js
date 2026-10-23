// Touch steering: hold the left half of the screen to turn left, the right half to
// turn right, both halves to drive straight, and lift every finger to brake.
// Buttons drawn on the canvas (hudHit) are excluded, so tapping them never steers.

let touchMode = false;          // becomes true on the first touch (enables brake-on-release)
let downOnHud = false;          // did the latest touch start on a HUD button? (so a click is a tap)
const touches = new Map();      // pointerId -> "L" | "R"
const downAt = new Map();       // pointerId -> { x, y, t } to tell a quick tap from a steering hold

function inRect(b, x, y) { return b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }
function onHudButton(x, y) {
    for (const k in hudHit) if (inRect(hudHit[k], x, y)) return true;
    return false;
}

function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, r.width];
}

function touchControls() {
    let l = false, r = false;
    for (const s of touches.values()) { if (s === "L") l = true; else r = true; }
    if (l || r) return { up: true, down: false, left: l && !r, right: r && !l };
    return { up: false, down: true, left: false, right: false };      // no finger = brake
}

canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    touchMode = true;
    const [x, y, w] = localPoint(e);
    downOnHud = onHudButton(x, y) || !!railMode || G.showNetwork;   // picking a track / the network map: a touch is a tap or a drag, not steering
    if (downOnHud) return;
    touches.set(e.pointerId, x < w / 2 ? "L" : "R");
    downAt.set(e.pointerId, { x, y, t: performance.now() });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    sendControls();
});
canvas.addEventListener("pointermove", (e) => {
    if (!touches.has(e.pointerId)) return;
    const [x, , w] = localPoint(e);
    const side = x < w / 2 ? "L" : "R";
    if (touches.get(e.pointerId) !== side) { touches.set(e.pointerId, side); sendControls(); }
});
function endTouch(e, cancelled) {
    const d = downAt.get(e.pointerId);
    downAt.delete(e.pointerId);
    if (touches.delete(e.pointerId)) sendControls();
    // A quick press-and-release is a tap: on a robot (edit your message / open their menu),
    // or on a track while travel mode is on.
    if (!cancelled && d && performance.now() - d.t < 250 && typeof tapWorld === "function") {
        const [x, y] = localPoint(e);
        if (Math.hypot(x - d.x, y - d.y) < 12 && canSteer()) tapWorld(x, y);
    }
}
canvas.addEventListener("pointerup", (e) => endTouch(e, false));
canvas.addEventListener("pointercancel", (e) => endTouch(e, true));

// Keyboard state lives here too so both input methods share one sender.
const held = { up: false, down: false, left: false, right: false };
let lastControls = "";

function canSteer() { return G.state === "playing" && !overlayOpen(); }

function sendControls(force) {
    let c = { up: false, down: false, left: false, right: false };
    if (canSteer()) {
        const kb = held.up || held.down || held.left || held.right;
        c = kb || !touchMode ? Object.assign({}, held) : touchControls();
    }
    const s = JSON.stringify(c);
    if (!force && s === lastControls) return;
    lastControls = s;
    send(Object.assign({ action: "controls" }, c));
}
