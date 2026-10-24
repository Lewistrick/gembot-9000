// How to Play: a slideshow of short slides. Each picture is a screenshot of the real game
// (app/static/howto/*.jpg, made by scripts/howto_shots.cjs) with blinking markers on top.
// Where things are in each picture comes from howto/shots.json.
//
// A marker is "name:kind": box or ring (drawn around the thing), or arrow-down / arrow-up /
// arrow-left / arrow-right (an arrow next to it that points in that direction).

const SLIDES = [
    {
        title: "You are a GemBot. Your goal is to collect gems.",
        imgs: [{ shot: "gem", marks: ["gem:ring", "gem:arrow-down"] }],
        lines: ["Drive over a gem to mine it.", "It goes into your <b>cargo</b>.", "A mined gem is gone for <b>everyone</b>."],
    },
    {
        title: "Bring gems to the base to score points.",
        imgs: [{ shot: "bank", marks: ["base:ring", "score:box", "robot:arrow-up"], banked: true }],
        lines: ["Drive into the <b>dashed ring</b> around the base.", "Your cargo is <b>banked</b>: it becomes score.", "Cargo you don't bank is <b>lost at midnight</b>."],
    },
    { title: "Steer your GemBot.", custom: "steering" },
    {
        title: "Far-away gems are worth more.",
        imgs: [{ shot: "mega", marks: ["gem:ring", "gem:arrow-down", "minimap:box"] }],
        lines: ["The farther from the base, the <b>richer</b> the gems.", "They are also <b>rarer</b>.", "<b>Mega gems</b> glow amber and are worth a lot.", "The <b>minimap</b> shows them too."],
    },
    {
        title: "Drill through walls.",
        imgs: [{ shot: "drill", marks: ["wall:box", "wall:arrow-down"] }],
        lines: ["<b>Hold forward</b> into a wall.", "Each tile takes <b>1 second</b> and costs <b>1 cargo</b>.", "No cargo? It's <b>free</b>, but takes <b>3 seconds</b>.", "A drilled tile is open for <b>everyone</b>.", "The base itself can't be drilled."],
    },
    {
        title: "Build a hub to start a rail.",
        imgs: [
            { shot: "hubbtn", marks: ["hub:box", "hub:arrow-down"] },
            { shot: "ghosts", marks: ["priceA:box", "priceB:box"] },
        ],
        lines: ["Stand still and tap <b>HUB</b>.", "It only shows if you can <b>pay</b> for a hub.", "Each see-through track shows its <b>length</b> and <b>price</b>.", "<b>Tap one</b> to build the hub with that track.", "The cost floats up from your robot.", "Tap anywhere else to cancel.", "With only one choice, it is just built."],
    },
    {
        title: "Rail rules.",
        imgs: [{ shot: "ghosts", marks: ["priceA:box", "priceB:box"] }],
        lines: ["A hub costs <b>25</b>. A track costs <b>1 per tile</b>.", "Tracks are <b>straight</b>, up to <b>60 tiles</b>.", "Tracks need <b>floor</b> all the way.", "Every hub has <b>one track</b> leading home.", "So all hubs connect to the <b>base</b>.", "Everything is <b>shared</b> by all players."],
    },
    {
        title: "Park on a hub to ship or travel.",
        imgs: [{ shot: "travel", marks: ["ship:box", "travel:box", "tollPill:box"] }],
        lines: ["Stand still on a hub (or the base).", "<b>SHIP</b> sends your cargo home on a cart.", "<b>TRAVEL</b> turns travel mode on.", "Then <b>tap a track</b> to ride along it.", "Press <b>TRAVEL</b> again to stop.", "Steering is off while you travel."],
    },
    {
        title: "Cargo pays first.",
        imgs: [{ shot: "pay", marks: ["question:box", "yes:box"] }],
        lines: ["Hubs, tracks and tolls come out of your <b>cargo</b>.", "Short? You are <b>asked</b> to use your score.", "Nothing leaves your score without a <b>yes</b>.", "Each hub of someone else on your trip costs <b>1</b> (a <b>toll</b>).", "Your own hubs and the base are free."],
    },
    {
        title: "Earn tolls from your hubs.",
        imgs: [{ shot: "day", marks: ["score:box", "score:arrow-up"] }],
        lines: ["Players riding over <b>your hubs</b> pay you.", "Gems shipped over them pay you too.", "Each toll is <b>1 point</b>.", "Your <b>score blinks</b> when one comes in."],
    },
    {
        title: "Stay in the light.",
        imgs: [{ shot: "dim", marks: [] }, { shot: "dark", marks: ["banner:box"] }],
        lines: ["Hubs light up the mine. The <b>base</b> is a hub.", "<b>100 tiles</b> from the closest hub, it gets darker.", "At <b>250</b> it is pitch black.", "At <b>350</b> you are <b>lost</b>.", "You return to the base and lose <b>half your cargo</b>.", "Build hubs to push the dark back."],
    },
    {
        title: "Find your way.",
        imgs: [
            { shot: "aids", marks: ["lens:box", "map:box", "network:box"] },
            { shot: "network", marks: ["you:ring", "base:ring", "cross:box"] },
        ],
        lines: ["The <b>lens</b> shows arrows to the base, the nearest gem and the nearest hub.", "The <b>map</b> shows a minimap around you.", "The <b>network</b> button shows all rails, north up.", "<b>Drag</b> to pan. <b>Scroll</b> or <b>pinch</b> to zoom.", "Leave with the <b>cross</b>."],
    },
    {
        title: "Chat and block.",
        imgs: [{ shot: "chat", marks: ["mine:box", "other:box"] }],
        lines: ["<b>Tap your robot</b> to type a message.", "It floats above you until you change it.", "<b>Tap another robot</b> to open its menu.", "There you can <b>block</b> their chat.", "Blocking only hides bubbles for <b>you</b>."],
    },
    {
        title: "One mine, one day.",
        imgs: [{ shot: "day", marks: ["clock:box", "score:box"] }],
        lines: ["A <b>new mine</b> opens every day, the same for everyone.", "Up to <b>100 players</b> dig together.", "The most <b>banked</b> gems at midnight wins.", "The winner wears a <b>crown</b> the next day.", "In the <b>last hour</b>, every gem is worth <b>double</b>."],
    },
    {
        title: "Stay active.",
        imgs: [{ shot: "idle", marks: ["banner:box"] }],
        lines: ["No input for <b>10 minutes</b> removes you.", "You get a warning at <b>9 minutes</b>.", "Your score and cargo are <b>kept</b> for the day.", "Rejoin to carry on.", "Your name is yours for the day."],
    },
    { title: "Handy keys.", custom: "keys" },
];

const ARROW_SVG = '<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M20 3h16v25h14L28 53 6 28h14z" fill="#ffcf4d" stroke="#05080a" stroke-width="3" stroke-linejoin="round"/></svg>';

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
                <li><b>&uarr;</b> go faster</li>
                <li><b>&darr;</b> brake</li>
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
                <li><b>Hold</b> the left or right half</li>
                <li><b>Both</b> halves: straight on</li>
                <li><b>Lift</b> your fingers to brake</li>
                <li><b>&#8635;</b> turns you around</li>
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
    return `<figure class="shot"><img src="static/howto/${img.shot}.jpg" alt="" draggable="false" />${marks}${extra}</figure>`;
}

function renderSlide() {
    const s = SLIDES[howtoIndex];
    let html = `<h3 class="stitle">${s.title}</h3>`;
    if (s.custom === "steering") html += steeringSlide();
    else if (s.custom === "keys") html += keysSlide();
    else {
        html += `<div class="shots n${s.imgs.length}">${s.imgs.map(shotHtml).join("")}</div>`;
        html += `<ul class="slines">${s.lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;
    }
    howtoSlideEl.innerHTML = html;
    howtoSlideEl.scrollTop = 0;
    howtoPrev.classList.toggle("hidden", howtoIndex === 0);
    howtoNext.classList.toggle("hidden", howtoIndex === SLIDES.length - 1);
    document.getElementById("slideCount").textContent = `${howtoIndex + 1} / ${SLIDES.length}`;
    howtoDotsEl.querySelectorAll("button").forEach((d, i) => d.classList.toggle("on", i === howtoIndex));
    startFloatAmount();
}

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
        fetch("static/howto/shots.json").then((r) => r.json()).then((j) => { howtoShots = j; renderSlide(); }).catch(() => { /* no markers */ });
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
