// Menus and overlays (HTML), keyboard input, chat bar, and the players panel.

const $ = (id) => document.getElementById(id);
const menuEl = $("menu"), howtoEl = $("howto"), pauseEl = $("pause"), noticeEl = $("notice");
const chatBarEl = $("chatbar"), chatInEl = $("chatin"), playersEl = $("players");
const nickEl = $("nick");
const playerMenuEl = $("playermenu");

let howReturnEl = menuEl;       // screen to restore when How-to's Back is pressed

// ---- Which overlay is open? (the game keeps running underneath; we just stop steering) ----
function overlayOpen() {
    return !!railMode || G.showBigMap ||
        [menuEl, howtoEl, pauseEl, noticeEl, chatBarEl, playerMenuEl, payBarEl].some((el) => !el.classList.contains("hidden"));
}
function hideAllScreens() {
    railMode = null;
    for (const el of [menuEl, howtoEl, pauseEl, noticeEl, chatBarEl, playerMenuEl, payBarEl]) el.classList.add("hidden");
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

function playerRow(id, name, extra, chat, idle) {
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
        const f = document.createElement("button"), on = followingId() === id;
        f.className = "pblock" + (on ? " on" : "");
        f.textContent = on ? "Unfollow" : idle ? "Inactive" : "Follow";
        f.disabled = !on && !!idle;                        // inactive players can't be followed
        f.addEventListener("click", () => toggleFollow(id));
        row.append(f);
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
    for (const m of rows) near.append(playerRow(m.id, m.name, m.idle ? "inactive" : "", m.chat, m.idle));
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


// ---- Rail: ship cargo, travel along a track, place a hub, and paying for it ----
// railMode: null, or the map is waiting for a tap on one of several candidate tracks:
//   { kind: "hub", x, y, opts: [{ to, x, y, cost, short, ... }] }   (ghost tracks for a new hub)
let railMode = null;
// travelMode: switched on with the TRAVEL button while parked on a hub. From then on a tap on
// a track from the hub you're on rides you to its other end, hub after hub, until the TRAVEL
// button is pressed again (it also switches off if you drive away from every hub).
let travelMode = false;
let travelIdle = 0;
let payRetry = null;            // the action to re-send if the player agrees to pay from score
const payBarEl = $("paybar");

function clearRailUi() {
    railMode = null;
    travelMode = false;
    payRetry = null;
    payBarEl.classList.add("hidden");
}
function closeRailMode() {
    if (!railMode) return;
    railMode = null;
    sendControls(true);
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

// Caption for the hub the robot is parked on (drawn by the HUD above the bottom buttons).
function hubCaption() {
    const h = parkedHub();
    if (!h) return "";
    return h.id === 0 ? "THE BASE" : `HUB #${h.id}  BY ${builderName(h.bn).toUpperCase()}`;
}

// -- What the map knows about the network (from the hubs the server sent) --
function hubNeighbours(id) {          // hubs joined to `id` by a single track
    const list = [];
    for (const o of G.hubs.values()) if (o.out === id) list.push(o.id);
    const h = G.hubs.get(id);
    if (h && h.out >= 0) list.push(h.out);
    return list;
}
function linkedToBase(id) {
    for (let cur = id, n = 0; n < 1000; n++) {
        if (cur === 0) return true;
        const h = G.hubs.get(cur);
        if (!h || h.out < 0) return false;
        cur = h.out;
    }
    return false;
}
function hopToll(fromId, toId) {      // hubs of other players at the two ends (the base is free)
    let n = 0;
    for (const id of [fromId, toId]) {
        const h = id === 0 ? null : G.hubs.get(id);
        if (h && h.bn && G.me && h.bn !== G.me.num) n++;
    }
    return n;
}

// -- Ship gems to the base --
function doShip() {
    const h = parkedHub();
    if (!h) return;
    if (h.id === 0) toast("You are already at the base.", HUD.amber, 2500);
    else if (G.cargo <= 0) toast("You carry no gems to ship.", HUD.amber, 2500);
    else if (G.cargo <= shipTolls(h.id)) toast(`The tolls (${shipTolls(h.id)}) would eat the whole shipment.`, HUD.amber, 3000);
    else if (!linkedToBase(h.id)) toast("This hub isn't linked to the base.", HUD.amber, 2500);
    else send({ action: "send_cargo" });
}
function canShip() {
    const h = parkedHub();
    return !!h && h.id !== 0 && G.cargo > shipTolls(h.id) && linkedToBase(h.id);   // the tolls must not eat the whole shipment
}
// Tolls a shipment from hub `id` pays on its way to the base: 1 per hub of another player on the route.
function shipTolls(id) {
    let n = 0;
    for (let cur = id, k = 0; cur !== 0 && k < 1000; k++) {
        const h = G.hubs.get(cur);
        if (!h) break;
        if (h.bn && G.me && h.bn !== G.me.num) n++;
        cur = h.out;
    }
    return n;
}

// -- Travel mode: the TRAVEL button switches it on and off --
function setTravel(on) {
    travelMode = on;
    travelIdle = 0;
    if (on) releaseKeys();                        // steering is off while travelling: let go of any held keys
    sendControls(true);
}
function toggleTravel() {
    if (travelMode) { setTravel(false); return; }
    const h = parkedHub();
    if (!h) return;
    if (!hubNeighbours(h.id).length) { toast("No track leads from here.", HUD.amber, 2500); return; }
    setTravel(true);
    toast("Travel mode: tap a track to ride along it.", HUD.neon, 3000);
}
function canTravel() {
    const h = parkedHub();
    return !!h && hubNeighbours(h.id).length > 0;
}
// The tracks you can ride from the hub you're parked on (null if not parked or travel mode is off).
function travelTargets() {
    if (!travelMode) return null;
    const h = parkedHub();
    return h ? { kind: "travel", from: h.id, choices: hubNeighbours(h.id) } : null;
}
// A tap on one of those tracks rides there. Returns true if it hit one.
function tapTravelTrack(sx, sy) {
    const mode = travelTargets();
    if (!mode) return false;
    const cam = currentCam(), r = canvas.getBoundingClientRect();
    let best = null, bd = Math.max(22, tile * 0.8);          // generous: fingers are fat
    for (const s of railModeSegments(mode, cam, r.width / 2, r.height * ANCHOR_Y)) {
        const d = distToSegment(sx, sy, s.ax, s.ay, s.bx, s.by);
        if (d <= bd) { bd = d; best = s; }
    }
    if (!best) return false;
    send({ action: "ride", to: best.to });
    return true;
}
// Travel mode ends by itself if you drive away from the hubs.
setInterval(() => {
    if (!travelMode) return;
    if (G.state !== "playing") { travelMode = false; return; }
    if (G.riding || G.showBigMap || parkedHub()) travelIdle = 0;
    else if (++travelIdle > 8) setTravel(false);
}, 200);

// -- Place a hub: stand still on an empty tile; the map then offers the tracks it could get --
function cheapestHub() {              // hub + the shortest track to any hub (rock and rules aside)
    let best = Math.hypot(G.x, G.y);  // distance to the base
    for (const h of G.hubs.values()) best = Math.min(best, Math.hypot(h.x - G.x, h.y - G.y));
    return best > G.maxTrack ? null : G.hubCost + Math.max(1, Math.round(best));
}
function canAffordHub() {             // the button is only shown to players who could pay
    const cost = cheapestHub();
    return cost !== null && G.cargo + Math.max(0, G.score) >= cost;
}
function canPlaceHub() {
    return G.state === "playing" && !G.riding && G.speed <= 1.5 && !overlayOpen() && !parkedHub();
}
function requestHubOptions() {
    if (G.state !== "playing" || overlayOpen()) return;
    if (canPlaceHub()) send({ action: "hub_options" });
    else toast("Stop on an empty tile to place a hub.", HUD.amber, 2500);
}
function openHubMode(m) {
    if (G.state !== "playing" || overlayOpen()) return;
    if (m.opts.length === 1) {            // only one possible track: nothing to choose, just build it
        send({ action: "build_hub", to: m.opts[0].to, x: m.x, y: m.y });   // (the server still asks about paying)
        return;
    }
    releaseKeys();
    playersEl.classList.add("hidden");
    railMode = { kind: "hub", x: m.x, y: m.y, opts: m.opts };
    sendControls(true);
}

// -- Tapping the map while a rail mode is active: a tap on a track picks it, anything else closes --
function screenToWorld(sx, sy) {
    const cam = currentCam(), r = canvas.getBoundingClientRect();
    const dx = sx - r.width / 2, dy = sy - r.height * ANCHOR_Y, c = Math.cos(cam.h), s = Math.sin(cam.h);
    return [cam.x + (dx * c - dy * s) / tile, cam.y + (dx * s + dy * c) / tile];
}
function distToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
function railTap(sx, sy) {
    const mode = railMode;
    railMode = null;
    sendControls(true);
    const cam = currentCam(), r = canvas.getBoundingClientRect();
    const segs = railModeSegments(mode, cam, r.width / 2, r.height * ANCHOR_Y);
    let best = null, bd = Math.max(22, tile * 0.8);          // generous: fingers are fat
    for (const s of segs) {
        const d = distToSegment(sx, sy, s.ax, s.ay, s.bx, s.by);
        if (d <= bd) { bd = d; best = s; }
    }
    const box = railLabelHits.find((h) => inRect(h, sx, sy));    // the small length/price box of a track picks that track too
    if (box) { send({ action: "build_hub", to: box.to, x: mode.x, y: mode.y }); return; }
    if (!best) return;                                       // tapped outside every track: just close
    send({ action: "build_hub", to: best.to, x: mode.x, y: mode.y });
}

// -- Paying: cargo goes first; the player is asked before banked score is used --
function openPayDialog(m) {
    railMode = null;
    payRetry = m.retry;
    $("payTitle").textContent = m.label;
    $("payText").textContent = m.cargo > 0
        ? `Costs ${m.cost}. Your cargo covers ${m.cargo}; pay the missing ${m.score} from your banked gems (score)?`
        : `Costs ${m.cost} and you carry no cargo. Pay it from your banked gems (score)?`;
    $("payYes").textContent = `Pay ${m.score} from score`;
    showScreen(payBarEl);
}
function closePayDialog() {
    payRetry = null;
    payBarEl.classList.add("hidden");
    sendControls(true);
}
$("payYes").addEventListener("click", () => {
    if (payRetry) send(Object.assign({}, payRetry, { pay_score: true }));
    closePayDialog();
});
$("payNo").addEventListener("click", closePayDialog);

// -- Following one other player: an arrow on your screen points at them --
function followingId() { return G.follow ? G.follow.id : null; }
function toggleFollow(id) {
    send({ action: "follow", id: followingId() === id ? null : id });   // the server answers with a "following" notice
}

// -- Player menu: tap another robot to see what it says, follow it or block it --
let pmId = null, pmIdle = false;
function refreshPlayerMenu() {
    const blockedNow = pmId !== null && blocked.has(pmId);
    $("pmBlock").textContent = blockedNow ? "Unblock chat" : "Block chat";
    const on = pmId !== null && followingId() === pmId;
    $("pmFollow").textContent = on ? "Unfollow" : pmIdle ? "Inactive" : "Follow";
    $("pmFollow").disabled = !on && pmIdle;           // inactive players can't be followed
}
function openPlayerMenu(meta) {
    pmId = meta.id;
    pmIdle = !!meta.idle;
    $("pmName").textContent = (meta.crown ? "\u265B " : "") + meta.name;
    $("pmChat").textContent = meta.chat ? `\u201C${meta.chat}\u201D` : "(no message)";
    refreshPlayerMenu();
    playersEl.classList.add("hidden");
    showScreen(playerMenuEl);
}
function closePlayerMenu() {
    if (playerMenuEl.classList.contains("hidden")) return;
    playerMenuEl.classList.add("hidden");
    pmId = null;
    sendControls(true);
}
$("pmBlock").addEventListener("click", () => { if (pmId !== null) { toggleBlock(pmId); refreshPlayerMenu(); } });
$("pmFollow").addEventListener("click", () => { if (pmId !== null) toggleFollow(pmId); });
$("pmClose").addEventListener("click", closePlayerMenu);

// Robots drawn this frame as tap targets (filled by main.js): tap yours to edit your
// message, tap someone else's to open their menu. Returns true if a robot was hit.
function tapRobot(x, y, scale) {
    let best = null, bd = Infinity;
    for (const r of robotHits) {
        const d = Math.hypot(r.x - x, r.y - y);
        if (d <= r.r * (scale || 1) && d < bd) { best = r; bd = d; }
    }
    if (!best) return false;
    if (best.me) openChat(); else openPlayerMenu(best.meta);
    return true;
}

// A tap on the map: dead-centre on a robot first, then (in travel mode) a track to ride,
// then anywhere else on a robot. Tracks start under your own robot, hence the order.
function tapWorld(x, y) {
    return tapRobot(x, y, 0.5) || tapTravelTrack(x, y) || tapRobot(x, y);
}

// ---- Main menu ----
try { nickEl.value = localStorage.getItem("gembot-name") || ""; } catch (e) { /* ignore */ }

async function refreshMenuStatus() {
    if (menuEl.classList.contains("hidden")) return;
    try {
        const r = await fetch("api/status", { cache: "no-store" });
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
    stopHowto();
    howtoEl.classList.add("hidden");
    showScreen(howReturnEl);
});
function openHowto(fromEl) {
    howReturnEl = fromEl;
    showScreen(howtoEl);
    startHowto();
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
    try { sessionStorage.setItem("gembot-zoom", String(tile)); } catch (e) { /* storage blocked */ }   // kept for this session
    reportViewport();
}
try { const z = +sessionStorage.getItem("gembot-zoom"); if (z) tile = clamp(z, MIN_TILE, MAX_TILE); } catch (e) { /* storage blocked */ }

window.addEventListener("keydown", (e) => {
    if (G.state !== "playing") return;
    if (railMode) {                              // waiting for a tap on a track
        if (e.key === "Escape") { e.preventDefault(); closeRailMode(); }
        return;
    }
    if (G.showBigMap) {                          // the big map
        if (e.key === "Escape" || e.key === "m" || e.key === "M") { e.preventDefault(); closeBigMap(); }
        else if (e.key === "+" || e.key === "=" || e.key === "-") {
            e.preventDefault();
            const r = canvas.getBoundingClientRect();
            mapZoomAt(r.width / 2, r.height / 2, e.key === "-" ? 1 / 1.25 : 1.25, r.width, r.height);
        }
        return;
    }
    if (overlayOpen()) {
        if (e.key === "Escape" && !pauseEl.classList.contains("hidden")) resume();
        else if (e.key === "Escape" && !playerMenuEl.classList.contains("hidden")) closePlayerMenu();
        else if (e.key === "Escape" && !payBarEl.classList.contains("hidden")) closePayDialog();
        return;
    }
    const k = KEYS[e.key];
    if (k && travelMode) {                       // steering is off in travel mode
        e.preventDefault();
    } else if (k) {
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
        e.preventDefault(); if (!e.repeat) requestHubOptions();
    } else if (e.key === "t" || e.key === "T") {
        e.preventDefault(); if (!e.repeat) toggleTravel();
    } else if (e.key === "m" || e.key === "M") {
        e.preventDefault(); if (!e.repeat) openBigMap();
    } else if (e.key === "g" || e.key === "G") {
        e.preventDefault(); if (!e.repeat) doShip();
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

// ---- View aids: the lens (arrows) and the minimap, remembered in this browser ----
function toggleView(flag, storeKey) {
    G[flag] = !G[flag];
    try { localStorage.setItem(storeKey, G[flag] ? "1" : "0"); } catch (e) { /* ignore */ }
}

// ---- The big map (tap the minimap): drag to pan, wheel or pinch to zoom, the cross (or Esc / M) to leave ----
// Its zoom is remembered for this browser session, like the game's.
try { const z = +sessionStorage.getItem("gembot-mapzoom"); if (z > 0) mapView.sc = z; } catch (e) { /* storage blocked */ }
function saveMapZoom() { try { sessionStorage.setItem("gembot-mapzoom", String(mapView.sc)); } catch (e) { /* ignore */ } }
function openBigMap() {
    const r = canvas.getBoundingClientRect();
    centreBigMap(r.width, r.height);
    G.showBigMap = true;
    releaseKeys();
    sendControls(true);
}
function closeBigMap() {
    G.showBigMap = false;
    mapPointers.clear();
    saveMapZoom();
    sendControls(true);
}
const mapPointers = new Map();     // pointerId -> { x, y } of the fingers / mouse button held on the big map
let mapMoved = 0;                  // how far the pointers travelled since the first went down (a drag is not a click)

canvas.addEventListener("pointerdown", (e) => {
    if (!G.showBigMap) return;
    const r = canvas.getBoundingClientRect();
    if (!mapPointers.size) mapMoved = 0;
    mapPointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});
canvas.addEventListener("pointermove", (e) => {
    const p = mapPointers.get(e.pointerId);
    if (!G.showBigMap || !p) return;
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (mapPointers.size >= 2) {                               // pinch: zoom about the midpoint, and follow it
        const other = [...mapPointers.entries()].find(([id]) => id !== e.pointerId)[1];
        const before = Math.hypot(p.x - other.x, p.y - other.y), after = Math.hypot(x - other.x, y - other.y);
        const mx0 = (p.x + other.x) / 2, my0 = (p.y + other.y) / 2, mx1 = (x + other.x) / 2, my1 = (y + other.y) / 2;
        mapPan(mx1 - mx0, my1 - my0, r.width, r.height);
        if (before > 0 && after > 0) mapZoomAt(mx1, my1, after / before, r.width, r.height);
    } else {
        mapPan(x - p.x, y - p.y, r.width, r.height);
    }
    mapMoved += Math.hypot(x - p.x, y - p.y);
    p.x = x; p.y = y;
});
function mapPointerEnd(e) { mapPointers.delete(e.pointerId); }
canvas.addEventListener("pointerup", mapPointerEnd);
canvas.addEventListener("pointercancel", mapPointerEnd);
canvas.addEventListener("wheel", (e) => {
    if (!G.showBigMap) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;       // lines -> pixels
    mapZoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * 0.0015), r.width, r.height);
}, { passive: false });

// ---- Taps on the canvas HUD ----
canvas.addEventListener("click", (e) => {
    if (G.state === "playing" && G.showBigMap) {
        const r = canvas.getBoundingClientRect();
        if (mapMoved < 10 && inRect(hudHit.mapClose, e.clientX - r.left, e.clientY - r.top)) closeBigMap();
        return;
    }
    if (G.state === "playing" && railMode) {
        const r = canvas.getBoundingClientRect();
        railTap(e.clientX - r.left, e.clientY - r.top);
        return;
    }
    if (G.state !== "playing" || overlayOpen()) return;
    if (touchMode && e.pointerType && e.pointerType !== "mouse" && !downOnHud) return;   // touch taps: see touch.js
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (inRect(hudHit.hamburger, x, y)) openPause();
    else if (inRect(hudHit.flip, x, y)) send({ action: "flip" });
    else if (inRect(hudHit.placeHub, x, y)) requestHubOptions();
    else if (inRect(hudHit.lens, x, y)) toggleView("showArrows", "gembot-arrows");
    else if (inRect(hudHit.minimap, x, y)) toggleView("showMap", "gembot-map");
    else if (inRect(hudHit.minimapView, x, y)) openBigMap();
    else if (inRect(hudHit.ship, x, y)) doShip();
    else if (inRect(hudHit.travel, x, y)) toggleTravel();
    else if (inRect(hudHit.score, x, y)) togglePlayersPanel();
    else tapWorld(x, y);
});

showScreen(menuEl);
