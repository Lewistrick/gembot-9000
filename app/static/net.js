// Connection to the server and the client's copy of the shared game state.
// The server sends batches (JSON arrays) of typed messages; see app/connection.py.

const ANCHOR_Y = 0.75;         // player sits 75% down the screen (more map ahead)
const MARGIN = 4;              // extra viewport tiles beyond what rotation needs
const MIN_TILE = 10, MAX_TILE = 60, ZOOM_STEP = 3;
const OTHER_MS = 100;          // other robots update at 10 Hz; interpolate over that

const view = { cols: 41, rows: 41 };   // tiles the server should keep loaded around us
const DEFAULT_COLORS = { floor: "#d8c9a8", rock: "#2a2f38", grid: "#cbbd9d", player: "#e53935", gem: "#2ec4ff" };

const G = {
    state: "menu",             // menu | joining | playing | kicked | full
    connected: false,
    me: null,                  // { id, num, name, hue }
    day: "", cap: 100, tickMs: 50, maxSpeed: 15, baseR: 10,
    colors: null,              // base palette from welcome
    pal: null,                 // palette drifted by distance (from board messages)
    x: 0, y: 0, h: 0, speed: 0,
    cargo: 0, score: 0, flipping: false, bump: 0,
    rank: null, online: 0, top: [], mult: 1,
    left: 0, leftAt: 0,        // seconds until midnight, as of performance.now() == leftAt
    others: new Map(),         // num -> { from, to, t0 } (interpolated positions)
    meta: new Map(),           // num -> { id, name, chat, hue }
    hubs: new Map(),           // id -> { id, x, y, bn (builder num), out (hub id or -1) }
    carts: new Map(),          // id -> { from, to, t0, a } (interpolated like robots)
    riding: false,
    toasts: [],                // { text, color, t0, dur }
    idleUntil: 0,              // performance.now() deadline of the idle warning, or 0
};

let ws = null;
let myName = "";               // nickname sent when joining
let wantPlaying = false;       // true while we should (re)connect and stay in the game
let camFrom = { x: 0, y: 0, h: 0 }, camTo = { x: 0, y: 0, h: 0 };
let segStart = 0, segDur = 50, haveCam = false;

// Stable per-browser token so a reconnect resumes the same robot and score.
let token = null;
try { token = localStorage.getItem("gembot-token"); } catch (e) { /* storage blocked */ }
if (!token) {
    token = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    try { localStorage.setItem("gembot-token", token); } catch (e) { /* ignore */ }
}

function curColors() { return G.pal || G.colors || DEFAULT_COLORS; }

function send(msg) {
    if (msg.action !== "resize") G.idleUntil = 0;   // any real input dismisses the idle warning
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function toast(text, color, dur) {
    G.toasts.push({ text, color: color || HUD.neon, t0: performance.now(), dur: dur || 3500 });
    if (G.toasts.length > 5) G.toasts.shift();
}

function viewportTiles() {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    // Square viewport big enough that the rotated, off-centre screen always fits.
    const reach = Math.hypot(rect.width / 2, rect.height * ANCHOR_Y);
    const n = Math.max(9, (Math.ceil((2 * reach) / tile) + MARGIN) | 1);
    return { cols: n, rows: n };
}

function reportViewport() {
    const v = viewportTiles();
    view.cols = v.cols; view.rows = v.rows;
    send({ action: "resize", cols: v.cols, rows: v.rows });
}

function currentCam() {
    const t = Math.min(1, (performance.now() - segStart) / segDur);
    return {
        x: lerp(camFrom.x, camTo.x, t),
        y: lerp(camFrom.y, camTo.y, t),
        h: lerp(camFrom.h, camTo.h, t),
    };
}

function otherPos(o, now) {
    const t = Math.min(1, (now - o.t0) / OTHER_MS);
    return { x: lerp(o.from.x, o.to.x, t), y: lerp(o.from.y, o.to.y, t), h: lerp(o.from.h, o.to.h, t) };
}

// ---- Connecting ----
function resetClientWorld() {
    clearWorld();
    G.others.clear(); G.meta.clear(); G.toasts.length = 0; G.hubs.clear(); G.carts.clear(); G.riding = false;
    if (typeof clearRailUi === "function") clearRailUi();
    G.pal = null; G.cargo = G.score = 0; G.rank = null; G.idleUntil = 0;
    haveCam = false;
}

function connect() {
    if (ws) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}${location.pathname.replace(/\/?$/, "/")}ws?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
        G.connected = true;
        send({ action: "join", name: myName });
        reportViewport();
        sendControls(true);
    };
    sock.onmessage = (ev) => {
        let list;
        try { list = JSON.parse(ev.data); } catch (e) { return; }
        for (const m of list) { const h = HANDLERS[m.t]; if (h) h(m); }
    };
    sock.onclose = () => {
        if (ws === sock) ws = null;
        G.connected = false;
        if (wantPlaying) setTimeout(connect, 1000);
    };
}

function joinGame(name) {
    myName = name;
    wantPlaying = true;
    G.state = "joining";
    resetClientWorld();
    connect();
}

function leaveGame() {
    wantPlaying = false;
    send({ action: "quit" });
    const sock = ws;
    ws = null;
    if (sock) sock.close();
    G.state = "menu";
    G.connected = false;
}

// ---- Server messages ----
const HANDLERS = {
    welcome(m) {
        G.me = m.you; G.day = m.day; G.cap = m.cap; G.tickMs = m.tick_ms;
        G.maxSpeed = m.max_speed; G.baseR = m.base; G.colors = m.colors; G.mult = m.mult;
        CS = m.chunk;
        G.state = "playing";
        hideAllScreens();
    },
    chunk(m) { addChunk(m); },
    drop(m) { dropChunks(m.c); },
    mined(m) { for (const p of m.c) mined.add(p[0] + "," + p[1]); },
    meta(m) { for (const e of m.list) G.meta.set(e.n, e); },
    tick(m) {
        camFrom = haveCam ? currentCam() : { x: m.x, y: m.y, h: m.h };
        camTo = { x: m.x, y: m.y, h: m.h };
        segStart = performance.now();
        segDur = G.tickMs;
        haveCam = true;
        G.x = m.x; G.y = m.y; G.h = m.h; G.speed = m.s;
        G.cargo = m.c; G.score = m.sc; G.flipping = m.f; G.riding = !!m.r;
        if (m.b) { G.bump = m.b; onBump(m.b); }
        if (m.o) {
            const now = performance.now(), seen = new Set();
            for (const r of m.o) {
                seen.add(r[0]);
                const to = { x: r[1], y: r[2], h: r[3] };
                const o = G.others.get(r[0]);
                if (o) { o.from = otherPos(o, now); o.to = to; o.t0 = now; }
                else G.others.set(r[0], { from: to, to, t0: now });
            }
            for (const k of G.others.keys()) if (!seen.has(k)) G.others.delete(k);
            const keep = new Set();
            for (const r of m.k || []) {
                keep.add(r[0]);
                const to = { x: r[1], y: r[2], h: 0 }, c = G.carts.get(r[0]);
                if (c) { c.from = otherPos(c, now); c.to = to; c.t0 = now; c.a = r[3]; }
                else G.carts.set(r[0], { from: to, to, t0: now, a: r[3] });
            }
            for (const k of G.carts.keys()) if (!keep.has(k)) G.carts.delete(k);
        }
    },
    board(m) {
        G.top = m.top; G.rank = m.you.rank; G.online = m.online; G.mult = m.mult;
        G.left = m.left; G.leftAt = performance.now();
        G.pal = Object.assign({}, m.pal, { player: "#e53935" });
        if (typeof refreshPlayersPanel === "function") refreshPlayersPanel();
    },
    announce(m) { toast(m.text, HUD.amber, 5000); },
    hubs(m) { for (const r of m.list) G.hubs.set(r[0], { id: r[0], x: r[1], y: r[2], bn: r[3], out: r[4] }); },
    rail(m) { toast(m.msg, m.ok ? "#3ef07a" : "#ff6b5e", m.ok ? 2500 : 4000); },
    toll(m) { toast(`+${m.v} toll from ${m.from}`, "#3ef07a", 2500); },
    quote(m) { onQuote(m); },
    built() { endBuildMode(); },
    net(m) { openNetMap(m); },
    newday(m) {
        // The server closes the socket next; onclose reconnects us into the new day.
        resetClientWorld();
        toast(m.winner ? `NEW DAY! Yesterday's winner: ${m.winner.name} (${m.winner.score})`
            : "NEW DAY! A fresh mine awaits.", HUD.amber, 9000);
    },
    gain(m) { toast(`+${m.v}${m.mega ? "  MEGA GEM!" : ""}`, m.mega ? HUD.amber : HUD.neon, m.mega ? 4500 : 1800); },
    delivered(m) { toast(`BANKED +${m.v}`, "#3ef07a", 3000); },
    warn(m) { G.idleUntil = performance.now() + m.left * 1000; },
    kicked(m) {
        wantPlaying = false;
        G.state = "kicked";
        showNotice(m.why === "replaced"
            ? ["Opened elsewhere", "This game was opened in another tab or window, so this one was closed."]
            : ["Removed for inactivity", "You were idle for 10 minutes. Your score and cargo are kept for today."]);
    },
    full(m) {
        wantPlaying = false;
        G.state = "full";
        showNotice(["Server full", `${m.online} / ${m.cap} players are online. Try again in a moment.`]);
    },
};
