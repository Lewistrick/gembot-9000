// Menus and overlays (HTML), keyboard input, chat bar, and the players panel.

const $ = (id) => document.getElementById(id);
const menuEl = $("menu"), howtoEl = $("howto"), pauseEl = $("pause"), noticeEl = $("notice");
const chatBarEl = $("chatbar"), chatInEl = $("chatin"), playersEl = $("players");
const nickEl = $("nick");

let howReturnEl = menuEl;       // screen to restore when How-to's Back is pressed

// ---- Which overlay is open? (the game keeps running underneath; we just stop steering) ----
function overlayOpen() {
    return [menuEl, howtoEl, pauseEl, noticeEl, chatBarEl].some((el) => !el.classList.contains("hidden"));
}
function hideAllScreens() {
    for (const el of [menuEl, howtoEl, pauseEl, noticeEl, chatBarEl]) el.classList.add("hidden");
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
