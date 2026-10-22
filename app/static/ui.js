// Menus and overlays (HTML), keyboard input, chat bar, and the players panel.

const $ = (id) => document.getElementById(id);
const menuEl = $("menu"), howtoEl = $("howto"), pauseEl = $("pause"), noticeEl = $("notice");
const chatBarEl = $("chatbar"), chatInEl = $("chatin"), playersEl = $("players");
const nickEl = $("nick");
const hubPanelEl = $("hubpanel"), buildBarEl = $("buildbar"), netMapEl = $("netmap");

let howReturnEl = menuEl;       // screen to restore when How-to's Back is pressed

// ---- Which overlay is open? (the game keeps running underneath; we just stop steering) ----
function overlayOpen() {
    return !!buildMode ||
        [menuEl, howtoEl, pauseEl, noticeEl, chatBarEl, netMapEl].some((el) => !el.classList.contains("hidden"));
}
function hideAllScreens() {
    for (const el of [menuEl, howtoEl, pauseEl, noticeEl, chatBarEl, netMapEl]) el.classList.add("hidden");
    sendControls(true);
}
function showScreen(el) {
    releaseKeys();
    el.classList.remove("hidden");
    sendControls(true);
}
function showNotice(pair) {
    $("noticeTitle").textContent = pair[0];
    $("noticeText").textContent = pair[1];
    pauseEl.classList.add("hidden"); chatBarEl.classList.add("hidden"); playersEl.classList.add("hidden");
    clearRailUi();
    showScreen(noticeEl);
}

function releaseKeys() {
    let changed = false;
    for (const k in held) if (held[k]) { held[k] = false; changed = true; }
    touches.clear();
    if (changed) sendControls();
}

// ---- Blocking: hides a player's chat bubble for us (stored in this browser) ----
const blocked = new Set();
try { for (const id of JSON.parse(localStorage.getItem("gembot-blocked") || "[]")) blocked.add(id); } catch (e) { /* ignore */ }
function saveBlocked() {
    try { localStorage.setItem("gembot-blocked", JSON.stringify([...blocked])); } catch (e) { /* ignore */ }
}
function toggleBlock(id) {
    if (blocked.has(id)) blocked.delete(id); else blocked.add(id);
    saveBlocked();
    refreshPlayersPanel();
}

// ---- Players panel: robots near you, and today's top 10 ----
function playersPanelOpen() { return !playersEl.classList.contains("hidden"); }

function playerRow(id, name, extra, chat) {
    const row = document.createElement("div");
    row.className = "prow";
    const info = document.createElement("div");
    info.className = "pinfo";
    const nm = document.createElement("span");
    nm.className = "pname"; nm.textContent = name;
    info.append(nm);
    if (extra) { const ex = document.createElement("span"); ex.className = "pextra"; ex.textContent = extra; info.append(ex); }
    if (chat) { const ch = document.createElement("div"); ch.className = "pchat"; ch.textContent = chat; info.append(ch); }
    row.append(info);
    if (G.me && id !== G.me.id) {
        const b = document.createElement("button");
        b.className = "pblock" + (blocked.has(id) ? " on" : "");
        b.textContent = blocked.has(id) ? "Unblock" : "Block";
        b.addEventListener("click", () => toggleBlock(id));
        row.append(b);
    }
    return row;
}

function refreshPlayersPanel() {
    if (!playersPanelOpen()) return;
    const near = $("nearList"), top = $("topList");
    near.replaceChildren(); top.replaceChildren();
    const rows = [];
    for (const num of G.others.keys()) { const m = G.meta.get(num); if (m) rows.push(m); }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const m of rows) near.append(playerRow(m.id, m.name, "", m.chat));
    if (!rows.length) near.textContent = "Nobody in view.";
    G.top.forEach((r, i) => top.append(playerRow(r.id, r.n, `#${i + 1}  ${r.s}`, "")));
    if (!G.top.length) top.textContent = "No scores yet.";
}
function togglePlayersPanel() {
    playersEl.classList.toggle("hidden");
    refreshPlayersPanel();
}
$("playersClose").addEventListener("click", () => playersEl.classList.add("hidden"));

// ---- Chat bar: type a message that appears above your robot ----
function openChat() {
    if (G.state !== "playing") return;
    playersEl.classList.add("hidden");
    const mine = G.me && G.meta.get(G.me.num);
    chatInEl.value = mine ? mine.chat : "";
    showScreen(chatBarEl);
    chatInEl.focus();
    chatInEl.select();
}
function closeChat() {
    chatInEl.blur();
    chatBarEl.classList.add("hidden");
    sendControls(true);
}
function sendChat(text) {
    send({ action: "chat", text });
    closeChat();
}
$("chatSend").addEventListener("click", () => sendChat(chatInEl.value));
$("chatClear").addEventListener("click", () => sendChat(""));
$("chatCancel").addEventListener("click", closeChat);
chatInEl.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); sendChat(chatInEl.value); }
    else if (e.key === "Escape") { e.preventDefault(); closeChat(); }
});


// ---- Rail: the hub panel, the network map, and build mode ----
let buildMode = null;           // { target: {x, y}, preview: quote } while laying a track
let netData = null, nmSel = null, nmHits = [];

function clearRailUi() {
    buildMode = null;
    buildBarEl.classList.add("hidden");
    netMapEl.classList.add("hidden");
    hubPanelEl.classList.add("hidden");
}

// The hub the robot is parked on (the base counts anywhere in its depot).
function parkedHub() {
    if (G.state !== "playing" || G.riding || G.speed > 1.5 || overlayOpen()) return null;
    if (Math.hypot(G.x, G.y) <= 2.0) return { id: 0, bn: 0 };
    for (const h of G.hubs.values()) if (Math.hypot(h.x - G.x, h.y - G.y) <= 0.9) return h;
    return null;
}

function builderName(bn) {
    if (!bn) return "";
    if (G.me && bn === G.me.num) return "you";
    const m = G.meta.get(bn);
    return m ? m.name : "another player";
}

function updateHubPanel() {
    const h = parkedHub();
    if (!h) { hubPanelEl.classList.add("hidden"); return; }
    hubPanelEl.classList.remove("hidden");
    $("hubTitle").textContent = h.id === 0 ? "The base" : `Hub #${h.id}  ·  built by ${builderName(h.bn)}`;
}
setInterval(updateHubPanel, 120);

$("hubNet").addEventListener("click", () => send({ action: "netmap" }));
$("hubBuild").addEventListener("click", startBuildMode);
$("pauseHubBtn").addEventListener("click", () => { resume(); send({ action: "build_hub" }); });

// -- Network map: pick a hub to ride to, or ship your cargo to the base --
function openNetMap(m) {
    netData = m;
    nmSel = null;
    playersEl.classList.add("hidden");
    showScreen(netMapEl);
    drawNetMap();
    updateNmInfo();
}
function closeNetMap() {
    netMapEl.classList.add("hidden");
    sendControls(true);
}
function nmRow(id) { return netData && netData.hubs.find((r) => r.id === id); }

function drawNetMap() {
    const cv = $("nmCanvas"), c = cv.getContext("2d"), dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    nmHits = [];
    if (!netData) return;
    const rows = netData.hubs;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const r of rows) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x); y0 = Math.min(y0, r.y); y1 = Math.max(y1, r.y); }
    const pad = 36, sc = Math.min((w - 2 * pad) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0), 12);
    const ox = w / 2 - ((x0 + x1) / 2) * sc, oy = h / 2 - ((y0 + y1) / 2) * sc;
    const pos = (r) => [ox + r.x * sc, oy + r.y * sc];
    const byId = new Map(rows.map((r) => [r.id, r]));
    c.lineCap = "round";
    for (const r of rows) {                          // tracks, with an arrow toward the base
        const to = r.out == null ? null : byId.get(r.out);
        if (!to) continue;
        const a = pos(r), b = pos(to);
        c.strokeStyle = "#59616d"; c.lineWidth = 5; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
        c.strokeStyle = "#c4ccd8"; c.lineWidth = 1.6; c.stroke();
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        c.save(); c.translate(mx, my); c.rotate(ang); c.fillStyle = HUD.amber;
        c.beginPath(); c.moveTo(7, 0); c.lineTo(-5, -5); c.lineTo(-5, 5); c.closePath(); c.fill(); c.restore();
    }
    for (const r of rows) {
        const [px, py] = pos(r), sel = r.id === nmSel, here = r.id === netData.at;
        nmHits.push({ id: r.id, px, py });
        c.save(); c.translate(px, py);
        if (r.id === 0) {
            c.fillStyle = HUD.amber; c.beginPath(); c.arc(0, 0, 13, 0, TAU); c.fill();
            c.fillStyle = "#2a2318"; c.beginPath(); c.moveTo(-7, -1); c.lineTo(0, -8); c.lineTo(7, -1); c.lineTo(7, 7); c.lineTo(-7, 7); c.closePath(); c.fill();
        } else {
            c.fillStyle = hubAccent(r.bn); c.fillRect(-9, -9, 18, 18);
            c.fillStyle = "#cfd6e0"; c.fillRect(-6, -6, 12, 12);
        }
        if (here || sel) {
            c.strokeStyle = sel ? HUD.neon : "#ffffff"; c.lineWidth = sel ? 3 : 2;
            c.strokeRect(-14, -14, 28, 28);
        }
        c.restore();
        c.font = `bold 12px ${HUD.font}`; c.textAlign = "center";
        if (here) { c.fillStyle = "#ffffff"; c.fillText("YOU", px, py - 19); }
        else if (r.toll > 0) { c.fillStyle = HUD.amber; c.fillText(`-${r.toll}`, px, py - 19); }
    }
}

function updateNmInfo() {
    const row = nmRow(nmSel), cargo = netData ? netData.cargo : 0, at = netData ? netData.at : -1;
    const base = nmRow(0);
    $("nmInfo").textContent = !row ? `Tap a hub. Tolls come out of your cargo (${cargo}); your own hubs are free.`
        : row.id === at ? "You are here."
        : `${row.id === 0 ? "The base" : `Hub #${row.id} by ${row.by}`}: toll ${row.toll}, you carry ${cargo}.`;
    $("nmRide").disabled = !row || row.id === at || cargo < row.toll;
    $("nmRide").textContent = row && row.id !== at ? `Ride (-${row.toll})` : "Ride";
    $("nmBase").disabled = !base || at === 0 || cargo < base.toll;
    $("nmBase").textContent = base && at !== 0 ? `To base (-${base.toll})` : "To base";
    const ship = netData && netData.ship;
    $("nmShip").disabled = !ship || cargo <= ship.toll;
    $("nmShip").textContent = ship ? `Ship cargo (+${Math.max(0, cargo - ship.toll)})` : "Ship cargo";
}

function nmRide(id) {
    const row = nmRow(id);
    if (!row || row.id === netData.at || netData.cargo < row.toll) return;
    send({ action: "ride", to: id });
    closeNetMap();
}
$("nmCanvas").addEventListener("click", (e) => {
    const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 22;
    for (const h of nmHits) { const d = Math.hypot(h.px - x, h.py - y); if (d < bd) { bd = d; best = h; } }
    nmSel = best ? best.id : null;
    drawNetMap(); updateNmInfo();
});
$("nmRide").addEventListener("click", () => nmRide(nmSel));
$("nmBase").addEventListener("click", () => nmRide(0));
$("nmShip").addEventListener("click", () => { send({ action: "send_cargo" }); closeNetMap(); });
$("nmClose").addEventListener("click", closeNetMap);
window.addEventListener("resize", () => { if (!netMapEl.classList.contains("hidden")) drawNetMap(); });

function nmKey(e) {
    if (e.key === "Escape") { e.preventDefault(); closeNetMap(); return; }
    if (e.key === "h" || e.key === "H") { e.preventDefault(); nmRide(0); return; }
    if (e.key === "s" || e.key === "S") { e.preventDefault(); if (!$("nmShip").disabled) $("nmShip").click(); return; }
    if (e.key === "Enter") { e.preventDefault(); nmRide(nmSel); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const ids = netData.hubs.map((r) => r.id).sort((a, b) => a - b);
        const i = ids.indexOf(nmSel), step = e.key === "ArrowRight" ? 1 : -1;
        nmSel = ids[(i < 0 ? (step > 0 ? 0 : ids.length - 1) : (i + step + ids.length) % ids.length)];
        drawNetMap(); updateNmInfo();
    }
}

// -- Build mode: tap a spot, see the straight line and its cost, tap again to build --
function startBuildMode() {
    if (!parkedHub()) return;
    playersEl.classList.add("hidden");
    releaseKeys();
    buildMode = { target: null, preview: null };
    $("buildOk").disabled = true;
    $("buildMsg").textContent = "Tap a spot for a new hub, or tap a hub to link to it.";
    buildBarEl.classList.remove("hidden");
    hubPanelEl.classList.add("hidden");
    sendControls(true);
}
function endBuildMode() {
    if (!buildMode) return;
    buildMode = null;
    buildBarEl.classList.add("hidden");
    sendControls(true);
}
function onQuote(q) {
    if (!buildMode) return;
    buildMode.preview = q;
    $("buildOk").disabled = !q.ok;
    $("buildMsg").textContent = q.ok
        ? `${q.new ? "New hub + track" : "Link"}: ${q.len} tiles, cost ${q.cost}. Tap the spot again or press Build.`
        : q.why;
}
function screenToWorld(sx, sy) {
    const cam = currentCam(), r = canvas.getBoundingClientRect();
    const dx = sx - r.width / 2, dy = sy - r.height * ANCHOR_Y, c = Math.cos(cam.h), s = Math.sin(cam.h);
    return [cam.x + (dx * c - dy * s) / tile, cam.y + (dx * s + dy * c) / tile];
}
function buildTap(sx, sy) {
    const [wx, wy] = screenToWorld(sx, sy), x = Math.round(wx), y = Math.round(wy), t = buildMode.target;
    if (t && t.x === x && t.y === y && buildMode.preview && buildMode.preview.ok) { confirmBuild(); return; }
    buildMode.target = { x, y };
    buildMode.preview = null;
    $("buildOk").disabled = true;
    send({ action: "build_track", x, y, confirm: false });
}
function confirmBuild() {
    if (!buildMode || !buildMode.target || !buildMode.preview || !buildMode.preview.ok) return;
    send({ action: "build_track", x: buildMode.target.x, y: buildMode.target.y, confirm: true });
}
$("buildOk").addEventListener("click", confirmBuild);
$("buildCancel").addEventListener("click", endBuildMode);

// ---- Main menu ----
try { nickEl.value = localStorage.getItem("gembot-name") || ""; } catch (e) { /* ignore */ }

async function refreshMenuStatus() {
    if (menuEl.classList.contains("hidden")) return;
    try {
        const r = await fetch("/api/status", { cache: "no-store" });
        const s = await r.json();
        $("dayVal").textContent = s.day;
        $("onlineVal").textContent = `${s.online} / ${s.cap}`;
        const list = $("menuBoard");
        list.replaceChildren();
        s.top.forEach((row, i) => {
            const li = document.createElement("li");
            const a = document.createElement("span"); a.textContent = `${i + 1}. ${row.n}`;
            const b = document.createElement("span"); b.textContent = row.s;
            li.append(a, b);
            list.append(li);
        });
        if (!s.top.length) { const li = document.createElement("li"); li.textContent = "No scores yet today"; list.append(li); }
        const wins = $("menuWinners");
        wins.replaceChildren();
        for (const w of s.winners || []) {
            const li = document.createElement("li");
            const a = document.createElement("span"); a.textContent = `\u265B ${w.name}`;
            const b = document.createElement("span"); b.textContent = `${w.day}  ${w.score}`;
            li.append(a, b);
            wins.append(li);
        }
        $("winnersField").classList.toggle("hidden", !(s.winners || []).length);
    } catch (e) { /* server unreachable: leave the last values */ }
}
setInterval(refreshMenuStatus, 4000);
refreshMenuStatus();

function showMenu() {
    showScreen(menuEl);
    refreshMenuStatus();
}

$("playBtn").addEventListener("click", () => {
    const name = nickEl.value.trim().slice(0, 16);
    try { localStorage.setItem("gembot-name", name); } catch (e) { /* ignore */ }
    menuEl.classList.add("hidden");
    joinGame(name);
});
nickEl.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") $("playBtn").click(); });
$("howBtn").addEventListener("click", () => { menuEl.classList.add("hidden"); openHowto(menuEl); });
$("backBtn").addEventListener("click", () => {
    howtoEl.classList.add("hidden");
    showScreen(howReturnEl);
});
function openHowto(fromEl) {
    howReturnEl = fromEl;
    showScreen(howtoEl);
}

// ---- In-game menu (the game keeps running; your robot just coasts to a stop) ----
function openPause() { playersEl.classList.add("hidden"); showScreen(pauseEl); }
function resume() { pauseEl.classList.add("hidden"); sendControls(true); }
$("resumeBtn").addEventListener("click", resume);
$("pausePlayersBtn").addEventListener("click", () => { resume(); togglePlayersPanel(); });
$("pauseHowBtn").addEventListener("click", () => { pauseEl.classList.add("hidden"); openHowto(pauseEl); });
$("leaveBtn").addEventListener("click", () => { pauseEl.classList.add("hidden"); leaveGame(); showMenu(); });
$("noticeBtn").addEventListener("click", () => {
    noticeEl.classList.add("hidden");
    G.state = "menu";
    showMenu();
});

// ---- Keyboard ----
const KEYS = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    w: "up", s: "down", a: "left", d: "right",
};
function zoom(delta) {
    tile = clamp(tile + delta, MIN_TILE, MAX_TILE);
    reportViewport();
}

window.addEventListener("keydown", (e) => {
    if (G.state !== "playing") return;
    if (buildMode) {
        if (e.key === "Escape") { e.preventDefault(); endBuildMode(); }
        else if (e.key === "Enter") { e.preventDefault(); confirmBuild(); }
        return;
    }
    if (!netMapEl.classList.contains("hidden")) { nmKey(e); return; }
    if (overlayOpen()) {
        if (e.key === "Escape" && !pauseEl.classList.contains("hidden")) resume();
        return;
    }
    const k = KEYS[e.key];
    if (k) {
        e.preventDefault();
        if (!held[k]) { held[k] = true; sendControls(); }
    } else if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) send({ action: "flip" });
    } else if (e.key === "PageUp" || e.key === "+" || e.key === "=") {
        e.preventDefault(); zoom(ZOOM_STEP);
    } else if (e.key === "PageDown" || e.key === "-") {
        e.preventDefault(); zoom(-ZOOM_STEP);
    } else if (e.key === "Enter") {
        e.preventDefault(); openChat();
    } else if (e.key === "Tab") {
        e.preventDefault(); togglePlayersPanel();
    } else if (e.key === "b" || e.key === "B") {
        e.preventDefault(); if (!e.repeat) send({ action: "build_hub" });
    } else if (e.key === "r" || e.key === "R") {
        e.preventDefault(); if (parkedHub()) send({ action: "netmap" });
    } else if (e.key === "Escape") {
        e.preventDefault();
        if (playersPanelOpen()) playersEl.classList.add("hidden"); else openPause();
    }
});
window.addEventListener("keyup", (e) => {
    const k = KEYS[e.key];
    if (k && held[k]) { held[k] = false; sendControls(); }
});
window.addEventListener("blur", releaseKeys);
window.addEventListener("resize", reportViewport);

// ---- Taps on the canvas HUD ----
canvas.addEventListener("click", (e) => {
    if (G.state === "playing" && buildMode) {
        const r = canvas.getBoundingClientRect();
        buildTap(e.clientX - r.left, e.clientY - r.top);
        return;
    }
    if (G.state !== "playing" || overlayOpen()) return;
    if (touchMode && e.pointerType && e.pointerType !== "mouse" && !downOnHud) return;   // end of a steering hold
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (inRect(hudHit.hamburger, x, y)) openPause();
    else if (inRect(hudHit.flip, x, y)) send({ action: "flip" });
    else if (inRect(hudHit.chat, x, y)) openChat();
    else if (inRect(hudHit.players, x, y) || inRect(hudHit.score, x, y)) togglePlayersPanel();
});

showScreen(menuEl);
