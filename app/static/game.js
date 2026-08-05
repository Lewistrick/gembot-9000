    const canvas = document.getElementById("c");
    const ctx = canvas.getContext("2d");
    const seedInput = document.getElementById("seed");
    const styleInput = document.getElementById("style");
    const statusEl = document.getElementById("status");

    const MARGIN = 4;          // extra viewport tiles beyond the rotated diagonal
    const MIN_TILE = 10, MAX_TILE = 60, ZOOM_STEP = 3;
    let tile = 26;
    let ws = null;
    let snap = null;           // latest server snapshot
    // Camera interpolation (world-tile coords + heading in radians).
    let camFrom = { x: 0, y: 0, h: 0 }, camTo = { x: 0, y: 0, h: 0 };
    let segStart = 0, segDur = 50, haveCam = false;

    function send(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function viewportTiles() {
        const rect = document.getElementById("stage").getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
        // Square viewport big enough to cover the screen at any rotation (diagonal).
        const diag = Math.ceil(Math.hypot(rect.width, rect.height) / tile);
        const n = Math.max(9, (diag + MARGIN) | 1);
        return { cols: n, rows: n };
    }

    function reportViewport() {
        const { cols, rows } = viewportTiles();
        send({ action: "resize", cols, rows });
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function currentCam() {
        const t = Math.min(1, (performance.now() - segStart) / segDur);
        return {
            x: lerp(camFrom.x, camTo.x, t),
            y: lerp(camFrom.y, camTo.y, t),
            h: lerp(camFrom.h, camTo.h, t),
        };
    }

    // ---- Gem + rubble rendering (crystalline rock with a little glow) ----
    const TAU = Math.PI * 2;
    function hexRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function mix(a, b, t) {
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    function css(c, alpha) {
        const s = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
        return alpha == null ? `rgb(${s})` : `rgba(${s},${alpha})`;
    }
    // Deterministic PRNG seeded by a tile coord — same shape every frame/visit.
    function rngAt(x, y) {
        let s = ((((x * 73856093) ^ (y * 19349663)) >>> 0) ^ 0x9e3779b9) >>> 0;
        return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }
    function screenPos(gx, gy, cam, cosr, sinr, W, H) {
        const lx = (gx - cam.x) * tile, ly = (gy - cam.y) * tile;
        return [lx * cosr - ly * sinr + W / 2, lx * sinr + ly * cosr + H / 2];
    }

    function drawCrystal(sx, sy, size, rng, gem, now, phase) {
        const dark = mix(gem, [0, 0, 0], 0.45), light = mix(gem, [255, 255, 255], 0.55);
        const twk = 0.6 + 0.4 * Math.sin(now / 320 + phase);
        // faint glow behind the rock
        ctx.globalCompositeOperation = "lighter";
        const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * 2.0);
        gr.addColorStop(0, css(light, 0.35 * twk));
        gr.addColorStop(1, css(gem, 0));
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(sx, sy, size * 2.0, 0, TAU); ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        // irregular angular silhouette (raw crystal)
        const n = 5 + ((rng() * 3) | 0), base = rng() * TAU, verts = [];
        for (let i = 0; i < n; i++) {
            const a = base + (i / n) * TAU + (rng() - 0.5) * 0.6;
            const rr = size * (0.7 + rng() * 0.4);
            verts.push([sx + Math.cos(a) * rr, sy + Math.sin(a) * rr]);
        }
        const outline = () => {
            ctx.beginPath();
            verts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
            ctx.closePath();
        };
        outline(); ctx.fillStyle = css(dark); ctx.fill();
        // facets from the centre, shaded by a fixed light direction
        const lightA = -2.2;
        for (let i = 0; i < n; i++) {
            const p = verts[i], q = verts[(i + 1) % n];
            const mA = Math.atan2((p[1] + q[1]) / 2 - sy, (p[0] + q[0]) / 2 - sx);
            const lit = 0.5 + 0.5 * Math.cos(mA - lightA);
            ctx.beginPath();
            ctx.moveTo(sx, sy); ctx.lineTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.closePath();
            ctx.fillStyle = css(mix(dark, light, lit)); ctx.fill();
        }
        outline();
        ctx.strokeStyle = css(mix(light, [255, 255, 255], 0.4), 0.85);
        ctx.lineWidth = Math.max(1, size * 0.08); ctx.stroke();
        // specular glint
        ctx.fillStyle = `rgba(255,255,255,${0.7 * twk})`;
        ctx.beginPath();
        ctx.arc(sx - size * 0.28, sy - size * 0.32, size * 0.16, 0, TAU); ctx.fill();
    }

    function drawRubblePile(sx, sy, rng, gem, rock) {
        const count = 3 + ((rng() * 4) | 0);           // 3..6 pebbles
        for (let i = 0; i < count; i++) {
            const a = rng() * TAU, d = rng() * tile * 0.34;
            const px = sx + Math.cos(a) * d, py = sy + Math.sin(a) * d;
            const pr = tile * (0.05 + rng() * 0.11);   // random sizes
            const bcol = rng() < 0.1 ? gem : rock;    // gem- or wall-coloured
            ctx.fillStyle = css(mix(bcol, [0, 0, 0], 0.15));
            ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
            ctx.fillStyle = css(mix(bcol, [255, 255, 255], 0.3), 0.9);
            ctx.beginPath(); ctx.arc(px - pr * 0.25, py - pr * 0.28, pr * 0.5, 0, TAU); ctx.fill();
        }
    }

    function drawGems(cam, W, H, colors) {
        const cosr = Math.cos(-cam.h), sinr = Math.sin(-cam.h), now = performance.now();
        const gem = hexRgb(colors.gem), rock = hexRgb(colors.rock);
        if (snap.rubble) for (const rb of snap.rubble) {
            const [sx, sy] = screenPos(rb.x, rb.y, cam, cosr, sinr, W, H);
            if (sx < -tile || sx > W + tile || sy < -tile || sy > H + tile) continue;
            drawRubblePile(sx, sy, rngAt(rb.x, rb.y), gem, rock);
        }
        if (snap.gems) for (const gm of snap.gems) {
            const [sx, sy] = screenPos(gm.x, gm.y, cam, cosr, sinr, W, H);
            const size = tile * (0.26 + ((gm.v - 10) / 30) * 0.24);
            if (sx < -tile * 2 || sx > W + tile * 2 || sy < -tile * 2 || sy > H + tile * 2) continue;
            drawCrystal(sx, sy, size, rngAt(gm.x, gm.y), gem, now, gm.x * 12.9 + gm.y * 7.7);
        }
    }

    function draw() {
        requestAnimationFrame(draw);
        if (!snap) return;
        const W = canvas.width, H = canvas.height;
        const cam = currentCam();
        const { tiles, colors, x0, y0 } = snap;
        const rows = tiles.length, cols = tiles[0].length;

        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate(-cam.h);                 // rotate the world so heading points up
        const half = tile / 2;
        for (let r = 0; r < rows; r++) {
            const wy = y0 + r;
            const row = tiles[r];
            const ty = (wy - cam.y) * tile - half;
            for (let c = 0; c < cols; c++) {
                ctx.fillStyle = row[c] ? colors.floor : colors.rock;
                ctx.fillRect(Math.round((x0 + c - cam.x) * tile - half), Math.round(ty),
                    tile + 1, tile + 1);
            }
        }
        ctx.restore();

        drawGems(cam, W, H, colors);

        // Player: an arrow at the screen centre, always pointing up.
        const s = tile * 0.55;
        ctx.fillStyle = colors.player;
        ctx.beginPath();
        ctx.moveTo(W / 2, H / 2 - s);
        ctx.lineTo(W / 2 - s * 0.62, H / 2 + s * 0.55);
        ctx.lineTo(W / 2, H / 2 + s * 0.2);
        ctx.lineTo(W / 2 + s * 0.62, H / 2 + s * 0.55);
        ctx.closePath();
        ctx.fill();
    }

    function onSnapshot(s) {
        const p = s.player;
        camFrom = haveCam ? currentCam() : { x: p.x, y: p.y, h: p.heading };
        camTo = { x: p.x, y: p.y, h: p.heading };
        segStart = performance.now();
        segDur = s.tick_ms || 50;
        haveCam = true;
        snap = s;
        if (!seedInput.value) seedInput.value = s.seed;
        if (s.style) styleInput.value = s.style;
        statusEl.textContent =
            `💎 ${s.score} · ${s.style} · seed ${s.seed} · ` +
            `speed ${p.speed.toFixed(1)} · zoom ${tile}px`;
    }

    // Held-key controls: Up throttle, Down brake, Left/Right steer.
    const KEYS = {
        ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    };
    const held = { up: false, down: false, left: false, right: false };
    function sendControls() { send({ action: "controls", ...held }); }

    window.addEventListener("keydown", (e) => {
        const k = KEYS[e.key];
        if (k) {
            e.preventDefault();
            if (!held[k]) { held[k] = true; sendControls(); }
        } else if (e.key === "PageUp" || e.key === "PageDown") {
            e.preventDefault();
            const next = tile + (e.key === "PageUp" ? ZOOM_STEP : -ZOOM_STEP);
            tile = Math.max(MIN_TILE, Math.min(MAX_TILE, next));
            reportViewport();
        }
    });
    window.addEventListener("keyup", (e) => {
        const k = KEYS[e.key];
        if (k) { e.preventDefault(); held[k] = false; sendControls(); }
    });
    window.addEventListener("blur", () => {
        let changed = false;
        for (const k in held) if (held[k]) { held[k] = false; changed = true; }
        if (changed) sendControls();
    });

    window.addEventListener("resize", reportViewport);
    document.getElementById("apply").addEventListener("click", () => {
        send({ action: "seed", seed: seedInput.value, style: styleInput.value });
    });

    // Stable per-browser token so a reconnect resumes the same run (position,
    // score, mined gems) instead of starting over.
    let token = localStorage.getItem("gembot-token");
    if (!token) {
        token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem("gembot-token", token);
    }

    function connect() {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
        ws.onopen = () => { statusEl.textContent = "connected"; reportViewport(); };
        ws.onmessage = (ev) => onSnapshot(JSON.parse(ev.data));
        ws.onclose = () => {
            statusEl.textContent = "disconnected — retrying…";
            setTimeout(connect, 1000);
        };
    }
    connect();
    requestAnimationFrame(draw);
