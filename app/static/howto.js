// How to Play: a slideshow of short slides. Each picture is a screenshot of the real game
// (app/static/howto/*.jpg, made by scripts/howto_shots.cjs) with blinking markers on top.
// Where things are in each picture comes from howto/shots.json.
//
// A marker is "name:kind": box or ring (drawn around the thing), or arrow-down / arrow-up /
// arrow-left / arrow-right (an arrow next to it that points in that direction).

// Every slide has at most one picture and at most three short lines (a picture shown
// beside another got too small on a phone).
const SLIDES = [
    {
        title: "You are a GemBot. Your goal is to collect gems.",
        imgs: [{ shot: "gem", marks: ["gem:ring", "gem:arrow-down"] }],
        lines: ["Drive over a gem to mine it.", "It goes into your <b>cargo</b>).", "A mined gem is gone for <b>everyone</b>."],
    },
    {
        title: "Bring gems to the base to score points.",
        imgs: [{ shot: "bank", marks: ["base:ring", "score:box", "robot:arrow-up"], banked: true }],
        lines: ["Your cargo is <b>banked</b>: it becomes score.", "You can carry up to 500 gems in your cargo."],
    },
    { title: "Steer your GemBot.", custom: "steering" },
    {
        title: "Spot them on the minimap.",
        imgs: [{ shot: "mega", marks: ["minimap:box"] }],
        lines: ["The <b>minimap</b> shows the gems around you."],
    },
    {
        title: "Drill through walls.",
        imgs: [{ shot: "drill", marks: ["wall:box"] }],
        lines: ["<b>Hold forward</b> into a wall.", "Each tile takes <b>1 second</b> and costs <b>1 cargo</b>.", "No cargo? It's <b>free</b>, but takes <b>3 seconds</b>.", "With some luck, you may find gems within rocks."],
    },
    {
        title: "Build a hub to create a rail.",
        imgs: [{ shot: "hubbtn", marks: ["hub:box", "hub:arrow-down"] }],
        lines: ["A hub costs 25 gems, plus its length.", "It connects to the base or to other hubs.", "Rails can't go through rock."],
    },
    {
        title: "Park on a hub to ship or travel.",
        imgs: [{ shot: "travel", marks: ["ship:box", "travel:box"] }],
        lines: ["Stand still on a hub (or the base).", "<b>SHIP</b> sends your cargo home on a cart (it shows the <b>tolls</b> on the way).", "<b>TRAVEL</b> turns travel mode on."],
    },
    {
        title: "In travel mode, you hop between hubs.",
        imgs: [{ shot: "travel", marks: ["tollPill:box", "travel:box"] }],
        lines: ["<b>Tap a track</b> to ride along it.", "Press <b>TRAVEL</b> again to stop.", "If you travel from or to someone else's hub, you pay 1 gem toll."],
    },
    {
        title: "You pay with cargo, unless you have none - then you pay with banked gems (your score).",
        imgs: [{ shot: "pay", marks: ["question:box", "yes:box"] }],
        lines: ["Hubs, tracks and tolls come out of your <b>cargo</b>.", "Nothing leaves your score without a <b>yes</b>."],
    },
    {
        title: "Tolls are calculated for both yourself and for cargo.",
        imgs: [{ shot: "travel", marks: ["tollPill:box", "tollPill:arrow-down"] }],
        lines: ["Each hub of someone else on your trip costs <b>1</b>.", "Your own hubs and the base are free."],
    },
    {
        title: "Earn tolls from your hubs.",
        imgs: [{ shot: "day", marks: ["score:box", "score:arrow-up"] }],
        lines: ["You earn toll from players riding over <b>your hubs</b>.", "Gems shipped over them pay you too.", "Your <b>score blinks</b> when a toll comes in."],
    },
    {
        title: "Hubs light up the mine up to 100 tiles.",
        imgs: [{ shot: "dim", marks: [] }],
        lines: ["When you go further from the closest hub, it gets darker.", "At <b>150</b> you get a short warning."],
    },
    {
        title: "Don't get lost.",
        imgs: [{ shot: "dark", marks: ["banner:box"] }],
        lines: ["At <b>250 tiles</b> it is pitch black.", "At <b>350</b> you are <b>lost</b>.", "You return to the base and lose <b>half your cargo</b>."],
    },
    {
        title: "Find your way using the toggles on the top.",
        imgs: [{ shot: "aids", marks: ["lens:box", "map:box", "minimap:box"] }],
        lines: ["The <b>lens</b> shows arrows to the base, the nearest gem and the nearest hub.", "The <b>map</b> button shows a minimap around you.", "<b>Tap the minimap</b> to see a big map."],
    },
    {
        title: "Click the minimap to see the big map.",
        imgs: [{ shot: "bigmap", marks: ["you:ring", "base:ring", "cross:box"] }],
        lines: ["It shows <b>150 tiles</b> around each hub. The <b>base</b> and <b>you</b> blink.", "<b>Drag</b> to pan. <b>Scroll</b> or <b>pinch</b> to zoom.", "Leave with the <b>cross</b> (or Esc)."],
    },
    {
        title: "Tap on your robot to chat.",
        imgs: [{ shot: "chat", marks: ["mine:box"] }],
        lines: ["<b>Tap your robot</b> to type a message.", "It floats above you until you change it.", "Please be kind."],
    },
    {
        title: "You can block players; just click on them.",
        imgs: [{ shot: "chat", marks: ["other:box"] }],
        lines: ["There you can <b>block</b> their chat.", "Blocking only hides bubbles for <b>you</b>."],
    },
    {
        title: "Follow a friend.",
        imgs: [{ shot: "chat", marks: ["other:box"] }],
        lines: ["Tap another robot (or open the players list) and choose <b>Follow</b>.", "A <b>black arrow</b> with a stripe in their colour points at them.", "They are told. Inactive players can't be followed."],
    },
    {
        title: "Every day is a new mine.",
        imgs: [{ shot: "day", marks: ["score:box"] }],
        lines: ["A <b>new mine</b> opens every day, the same for everyone.", "Up to <b>100 players</b> dig together.", "The most <b>banked</b> gems at midnight wins."],
    },
    {
        title: "Here's some extra rules.",
        imgs: [{ shot: "day", marks: ["clock:box"] }],
        lines: ["The winner wears a <b>crown</b> the next day.", "In the <b>last hour</b>, every gem is worth <b>double</b>.", "The clock shows how long the day has left."],
    },
    { title: "Handy keys (when you're on desktop).", custom: "keys" },
];

const ARROW_SVG = '<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M20 3h16v25h14L28 53 6 28h14z" fill="#ffcf4d" stroke="#05080a" stroke-width="3" stroke-linejoin="round"/></svg>';

// The same fingerprint as on the scripts (see app/server.py), so new pictures replace cached ones.
const ASSET_V = (document.querySelector('meta[name="asset-v"]') || {}).content || "";
const assetUrl = (p) => (ASSET_V ? `${p}?v=${ASSET_V}` : p);

const howtoSlideEl = document.getElementById("slide"), howtoDotsEl = document.getElementById("slideDots");
const howtoPrev = document.getElementById("slidePrev"), howtoNext = document.getElementById("slideNext");
let howtoIndex = 0, howtoShots = null, howtoFloat = null;

function keyCap(label, extra) { return `<span class="kbd ${extra || ""}">${label}</span>`; }

function steeringSlide() {
    return `
    <div class="steer">
        <div class="steerbox">
            <h3>Keyboard</h3>
            <div class="keys">
                <span></span>${keyCap("&uarr;<small>W</small>", "hl d0")}<span></span>
                ${keyCap("&larr;<small>A</small>", "hl d1")}${keyCap("&darr;<small>S</small>", "hl d2")}${keyCap("&rarr;<small>D</small>", "hl d1")}
            </div>
            <ul class="slines">
                <li><b>&uarr;</b> faster, <b>&darr;</b> brake</li>
                <li><b>&larr; &rarr;</b> turn</li>
                <li><b>Space</b> turn around (180&deg;)</li>
            </ul>
        </div>
        <div class="steerbox">
            <h3>Phone or tablet</h3>
            <div class="phone">
                <div class="half left hl d0"><span>hold:<br>turn left</span></div>
                <div class="half right hl d1"><span>hold:<br>turn right</span></div>
                <div class="both hl d2"><span>both: straight</span></div>
                <div class="flip hl d2">&#8635;</div>
            </div>
            <ul class="slines">
                <li><b>Hold</b> the left or right half to turn</li>
                <li><b>Both</b> halves: straight on</li>
                <li><b>Lift</b> your fingers to brake, <b>&#8635;</b> turns you around</li>
            </ul>
        </div>
    </div>`;
}

function keysSlide() {
    const row = (k, text) => `<li>${keyCap(k)} ${text}</li>`;
    return `
    <ul class="keylist">
        ${row("B", "place a <b>hub</b>")}
        ${row("T", "<b>travel</b> mode on / off")}
        ${row("G", "<b>ship</b> cargo home")}
        ${row("M", "the big <b>map</b>")}
        ${row("Space", "turn around")}
        ${row("Enter", "<b>chat</b>")}
        ${row("Tab", "<b>players</b> list")}
        ${row("+ &minus;", "<b>zoom</b> (or PageUp / PageDown)")}
        ${row("Esc", "<b>menu</b>")}
    </ul>
    <p class="slines hint">Every key also has a button on screen.</p>`;
}

function markHtml(spec, rect, w, h) {
    const [name, kind] = spec.split(":"), [x, y, rw, rh] = rect;
    const pc = (v, total) => `${(v / total * 100).toFixed(3)}%`;
    if (kind === "box" || kind === "ring") {
        const pad = kind === "ring" ? 0 : 4;
        return `<i class="mk ${kind}" data-name="${name}" style="left:${pc(x - pad, w)};top:${pc(y - pad, h)};width:${pc(rw + 2 * pad, w)};height:${pc(rh + 2 * pad, h)}"></i>`;
    }
    const a = 52, gap = 2, dir = kind.split("-")[1];
    const cx = x + rw / 2, cy = y + rh / 2;
    const pos = { down: [cx, y - a / 2 - gap, 0], up: [cx, y + rh + a / 2 + gap, 180], left: [x + rw + a / 2 + gap, cy, 90], right: [x - a / 2 - gap, cy, -90] }[dir];
    if (!pos) return "";
    return `<i class="mk arrow" data-name="${name}" style="left:${pc(pos[0] - a / 2, w)};top:${pc(pos[1] - a / 2, h)};width:${pc(a, w)};transform:rotate(${pos[2]}deg)">${ARROW_SVG}</i>`;
}

function shotHtml(img) {
    const info = howtoShots && howtoShots[img.shot];
    const w = info ? info.w : 720, h = info ? info.h : 405;
    let marks = "";
    if (info) for (const spec of img.marks) { const rect = info.marks[spec.split(":")[0]]; if (rect) marks += markHtml(spec, rect, w, h); }
    let extra = "";
    if (img.banked && info && info.marks.robot) {          // the amount that floats up when gems are banked (a new random one each time)
        const [x, y, rw] = info.marks.robot;
        extra = `<b class="floatamt" style="left:${((x + rw / 2) / w * 100).toFixed(2)}%;top:${((y - 34) / h * 100).toFixed(2)}%"></b>`;
    }
    return `<figure class="shot"><img src="${assetUrl(`static/howto/${img.shot}.jpg`)}" alt="" draggable="false" />${marks}${extra}</figure>`;
}

function renderSlide() {
    const s = SLIDES[howtoIndex];
    let body;
    if (s.custom === "steering") body = steeringSlide();
    else if (s.custom === "keys") body = keysSlide();
    else {
        body = `<div class="shots n${s.imgs.length}">${s.imgs.map(shotHtml).join("")}</div>`
            + `<ul class="slines">${s.lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;
    }
    howtoSlideEl.innerHTML = `<h3 class="stitle">${s.title}</h3><div class="sbody ${s.custom ? "custom" : `n${s.imgs.length}`}">${body}</div>`;
    howtoSlideEl.scrollTop = 0;
    markOverflow();
    for (const img of howtoSlideEl.querySelectorAll("img")) img.addEventListener("load", markOverflow, { once: true });
    howtoPrev.classList.toggle("hidden", howtoIndex === 0);
    howtoNext.classList.toggle("hidden", howtoIndex === SLIDES.length - 1);
    document.getElementById("slideCount").textContent = `${howtoIndex + 1} / ${SLIDES.length}`;
    howtoDotsEl.querySelectorAll("button").forEach((d, i) => d.classList.toggle("on", i === howtoIndex));
    startFloatAmount();
}

// A slide taller than the screen gets a "more below" hint at the bottom until it is scrolled down.
function markOverflow() {
    const el = howtoSlideEl;
    el.classList.toggle("more", el.scrollHeight - el.clientHeight - el.scrollTop > 6);
}
howtoSlideEl.addEventListener("scroll", markOverflow, { passive: true });
window.addEventListener("resize", () => { if (!document.getElementById("howto").classList.contains("hidden")) markOverflow(); });

// The "+amount" over the robot on the banking slide: a random 30-100 each time it floats up.
function startFloatAmount() {
    clearInterval(howtoFloat);
    howtoFloat = null;
    const el = howtoSlideEl.querySelector(".floatamt");
    if (!el) return;
    const again = () => {
        el.textContent = `+${30 + Math.floor(Math.random() * 71)}`;
        el.classList.remove("go");
        void el.offsetWidth;                              // restart the animation
        el.classList.add("go");
    };
    again();
    howtoFloat = setInterval(again, 2600);
}

function goSlide(i) {
    howtoIndex = Math.max(0, Math.min(SLIDES.length - 1, i));
    renderSlide();
}

function startHowto() {
    howtoDotsEl.replaceChildren(...SLIDES.map((s, i) => {
        const d = document.createElement("button");
        d.className = "dot"; d.setAttribute("aria-label", `Slide ${i + 1}`);
        d.addEventListener("click", () => goSlide(i));
        return d;
    }));
    howtoIndex = 0;
    renderSlide();
    if (!howtoShots) {                                    // marker positions; the slides work without them
        fetch(assetUrl("static/howto/shots.json")).then((r) => r.json()).then((j) => { howtoShots = j; renderSlide(); }).catch(() => { /* no markers */ });
    }
}

function stopHowto() {
    clearInterval(howtoFloat);
    howtoFloat = null;
}

howtoPrev.addEventListener("click", () => goSlide(howtoIndex - 1));
howtoNext.addEventListener("click", () => goSlide(howtoIndex + 1));

window.addEventListener("keydown", (e) => {
    if (document.getElementById("howto").classList.contains("hidden")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); goSlide(howtoIndex + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); goSlide(howtoIndex - 1); }
    else if (e.key === "Escape") { e.preventDefault(); document.getElementById("backBtn").click(); }
});

// Swipe left / right on a touch screen.
let swipeFrom = null;
howtoSlideEl.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") swipeFrom = { x: e.clientX, y: e.clientY }; });
howtoSlideEl.addEventListener("pointerup", (e) => {
    if (!swipeFrom) return;
    const dx = e.clientX - swipeFrom.x, dy = e.clientY - swipeFrom.y;
    swipeFrom = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) goSlide(howtoIndex + (dx < 0 ? 1 : -1));
});
