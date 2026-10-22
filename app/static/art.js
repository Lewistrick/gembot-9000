// Sprites: gems, rubble, the robot, and the multiplayer art (tracks, hubs, base
// depot, mine carts, name tags, chat bubbles, crown). Plain canvas calls.

function drawCrystal(sx, sy, size, rng, gem, now, phase) {
    const dark = mix(gem, [0, 0, 0], 0.45), light = mix(gem, [255, 255, 255], 0.55);
    const twk = 0.6 + 0.4 * Math.sin(now / 320 + phase);
    ctx.globalCompositeOperation = "lighter";
    const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * 2.0);
    gr.addColorStop(0, css(light, 0.35 * twk));
    gr.addColorStop(1, css(gem, 0));
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(sx, sy, size * 2.0, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
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
        const bcol = rng() < 0.5 ? gem : rock;     // gem- or rock-coloured
        ctx.fillStyle = css(mix(bcol, [0, 0, 0], 0.15));
        ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
        ctx.fillStyle = css(mix(bcol, [255, 255, 255], 0.3), 0.9);
        ctx.beginPath(); ctx.arc(px - pr * 0.25, py - pr * 0.28, pr * 0.5, 0, TAU); ctx.fill();
    }
}

// ---- Player: a retro mining robot, always drawn facing up ----
// Sized to fill ~one tile so the sprite matches the tile-based collision hitbox.
function drawRobot(cx, cy, u, colors, now) {
    ctx.save();
    ctx.translate(cx, cy);
    const eye = "#5ffbe0", accent = colors.player;
    ctx.lineJoin = "round";

    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.beginPath(); ctx.ellipse(0, u * 0.40, u * 0.44, u * 0.18, 0, 0, TAU); ctx.fill();

    // Treads down each side.
    const tW = u * 0.2, tH = u * 0.66, tX = u * 0.3, tY = -u * 0.3;
    for (const sgn of [-1, 1]) {
        rr(sgn * tX - tW / 2, tY, tW, tH, u * 0.06);
        ctx.fillStyle = "#33393f"; ctx.fill();
        ctx.lineWidth = Math.max(1, u * 0.02); ctx.strokeStyle = "#12151a"; ctx.stroke();
        ctx.fillStyle = "#1c2024";
        for (let i = 0; i < 5; i++) {
            const ly = tY + u * 0.06 + i * (tH - u * 0.12) / 4;
            ctx.fillRect(sgn * tX - tW / 2 + u * 0.02, ly, tW - u * 0.04, u * 0.03);
        }
    }

    // Drill, pointing up.
    const dTip = -u * 0.46, dBase = -u * 0.2, dW = u * 0.16;
    const dg = ctx.createLinearGradient(-dW, 0, dW, 0);
    dg.addColorStop(0, "#9aa3b2"); dg.addColorStop(0.5, "#eef2f7"); dg.addColorStop(1, "#6b7280");
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.moveTo(0, dTip); ctx.lineTo(dW, dBase); ctx.lineTo(-dW, dBase); ctx.closePath();
    ctx.fill(); ctx.lineWidth = Math.max(1, u * 0.02); ctx.strokeStyle = "#2a2f38"; ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    for (let i = 1; i <= 2; i++) {
        const t = i / 3, yy = dBase - (dBase - dTip) * t;
        ctx.beginPath(); ctx.moveTo(-dW * (1 - t), yy); ctx.lineTo(dW * (1 - t), yy - u * 0.03); ctx.stroke();
    }

    // Body.
    const bx = -u * 0.28, by = -u * 0.12, bw = u * 0.56, bh = u * 0.46;
    const bg = ctx.createLinearGradient(0, by, 0, by + bh);
    bg.addColorStop(0, "#cfd6e0"); bg.addColorStop(1, "#8b93a1");
    rr(bx, by, bw, bh, u * 0.12); ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = Math.max(1.5, u * 0.03); ctx.strokeStyle = "#2a2f38"; ctx.stroke();
    rr(bx, by + bh * 0.52, bw, bh * 0.2, u * 0.04); ctx.fillStyle = accent; ctx.fill();

    // Head with a glowing visor.
    const hx = -u * 0.2, hy = -u * 0.28, hw = u * 0.4, hh = u * 0.22;
    rr(hx, hy, hw, hh, u * 0.08);
    const hg = ctx.createLinearGradient(0, hy, 0, hy + hh);
    hg.addColorStop(0, "#eef2f7"); hg.addColorStop(1, "#aab2c0");
    ctx.fillStyle = hg; ctx.fill();
    ctx.lineWidth = Math.max(1, u * 0.025); ctx.strokeStyle = "#2a2f38"; ctx.stroke();
    rr(hx + hw * 0.14, hy + hh * 0.3, hw * 0.72, hh * 0.42, u * 0.04);
    ctx.fillStyle = eye; ctx.shadowColor = eye; ctx.shadowBlur = u * 0.25; ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillRect(hx + hw * 0.2, hy + hh * 0.36, hw * 0.16, hh * 0.28);

    // Corner bolts.
    ctx.fillStyle = "#6b7280";
    for (const [sx, sy] of [[bx + u * 0.05, by + u * 0.05], [bx + bw - u * 0.05, by + u * 0.05],
    [bx + u * 0.05, by + bh - u * 0.05], [bx + bw - u * 0.05, by + bh - u * 0.05]]) {
        ctx.beginPath(); ctx.arc(sx, sy, u * 0.03, 0, TAU); ctx.fill();
    }

    // Antenna with a blinking beacon.
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = Math.max(1, u * 0.02);
    ctx.beginPath(); ctx.moveTo(hx + hw * 0.16, hy); ctx.lineTo(hx + hw * 0.02, hy - u * 0.14); ctx.stroke();
    const blink = 0.5 + 0.5 * Math.sin(now / 200);
    ctx.fillStyle = `rgba(255,80,80,${0.5 + 0.5 * blink})`;
    ctx.shadowColor = "#ff5050"; ctx.shadowBlur = u * 0.2 * blink;
    ctx.beginPath(); ctx.arc(hx + hw * 0.02, hy - u * 0.15, u * 0.035, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;

    ctx.restore();
}

// Draft art for the multiplayer revamp: tracks, hubs, base depot, mine cart,
// name tags, chat bubbles and the winner's crown. Plain canvas calls on the same
// context/units (u = pixels per tile) as the game's drawRobot, so these functions
// can move into the game's render module unchanged once approved.

const ART = (() => {
    const TAU2 = Math.PI * 2;

    function pill(c, x, y, w, h, r) {
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
    }

    // Straight track between two screen points: gravel bed, sleepers, two rails.
    // `dir` (+1 / -1 / 0) adds faint chevrons pointing toward the base end.
    function track(c, x1, y1, x2, y2, u, dir) {
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 1) return;
        c.save();
        c.translate(x1, y1);
        c.rotate(Math.atan2(y2 - y1, x2 - x1));
        const half = u * 0.30;
        c.fillStyle = "rgba(40,34,28,0.35)";                       // gravel bed
        c.fillRect(0, -half - u * 0.04, len, half * 2 + u * 0.08);
        c.fillStyle = "#6b4a2b";                                    // sleepers
        const gap = u * 0.32, sw = u * 0.11;
        for (let p = gap * 0.5; p < len; p += gap) c.fillRect(p - sw / 2, -half, sw, half * 2);
        c.fillStyle = "rgba(255,255,255,0.14)";
        for (let p = gap * 0.5; p < len; p += gap) c.fillRect(p - sw / 2, -half, sw * 0.35, half * 2);
        for (const s of [-1, 1]) {                                  // rails
            const ry = s * u * 0.17, rw = Math.max(2, u * 0.065);
            c.fillStyle = "#59616d"; c.fillRect(0, ry - rw / 2, len, rw);
            c.fillStyle = "#c4ccd8"; c.fillRect(0, ry - rw / 2, len, Math.max(1, rw * 0.35));
        }
        if (dir) {
            c.strokeStyle = "rgba(255,207,77,0.8)"; c.lineWidth = Math.max(2, u * 0.07);
            c.lineCap = "round"; c.lineJoin = "round";
            for (let p = u * 1.6; p < len - u * 0.8; p += u * 2.4) {
                const q = p * (dir > 0 ? 1 : 1), a = u * 0.13 * (dir > 0 ? 1 : -1);
                c.beginPath(); c.moveTo(q - a, -u * 0.1); c.lineTo(q + a, 0); c.lineTo(q - a, u * 0.1); c.stroke();
            }
        }
        c.restore();
    }

    // Hub (player-built station): square steel platform with a frame in the
    // builder's colour and a blinking signal lamp. `ghost` = build preview.
    function hub(c, cx, cy, u, color, now, ghost) {
        c.save();
        c.translate(cx, cy);
        if (ghost) c.globalAlpha = 0.6;
        c.fillStyle = "rgba(0,0,0,0.30)";
        pill(c, -u * 0.5, -u * 0.4, u * 1.06, u * 1.0, u * 0.12); c.fill();
        pill(c, -u * 0.5, -u * 0.5, u, u, u * 0.1);                  // frame (builder colour)
        c.fillStyle = color; c.fill();
        c.lineWidth = Math.max(1.5, u * 0.04); c.strokeStyle = "#1c2024"; c.stroke();
        pill(c, -u * 0.38, -u * 0.38, u * 0.76, u * 0.76, u * 0.06); // steel deck
        const g = c.createLinearGradient(0, -u * 0.38, 0, u * 0.38);
        g.addColorStop(0, "#d6dce6"); g.addColorStop(1, "#7d8594");
        c.fillStyle = g; c.fill(); c.stroke();
        c.strokeStyle = "rgba(0,0,0,0.25)"; c.lineWidth = Math.max(1, u * 0.025);
        c.beginPath();                                               // deck plating lines
        c.moveTo(-u * 0.38, 0); c.lineTo(u * 0.38, 0);
        c.moveTo(0, -u * 0.38); c.lineTo(0, u * 0.38);
        c.stroke();
        c.fillStyle = "#6b7280";                                     // corner bolts
        for (const [bx, by] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            c.beginPath(); c.arc(bx * u * 0.3, by * u * 0.3, u * 0.03, 0, TAU2); c.fill();
        }
        c.beginPath(); c.arc(0, 0, u * 0.16, 0, TAU2);               // lamp housing
        c.fillStyle = "#2a2f38"; c.fill();
        const blink = 0.5 + 0.5 * Math.sin(now / 350);
        c.beginPath(); c.arc(0, 0, u * 0.1, 0, TAU2);
        c.fillStyle = `rgba(95,251,224,${0.55 + 0.45 * blink})`;
        c.shadowColor = "#5ffbe0"; c.shadowBlur = u * 0.3 * blink; c.fill();
        c.restore();
    }

    // Base depot: big amber platform with the same house icon the radar uses.
    function base(c, cx, cy, u, now) {
        u *= 0.5;                                                    // half-size depot
        c.save();
        c.translate(cx, cy);
        c.fillStyle = "rgba(0,0,0,0.32)";
        c.beginPath(); c.ellipse(0, u * 0.25, u * 1.75, u * 1.45, 0, 0, TAU2); c.fill();
        c.beginPath();                                               // octagon pad
        for (let i = 0; i < 8; i++) {
            const a = Math.PI / 8 + i * Math.PI / 4;
            c.lineTo(Math.cos(a) * u * 1.6, Math.sin(a) * u * 1.6);
        }
        c.closePath();
        const g = c.createLinearGradient(0, -u * 1.6, 0, u * 1.6);
        g.addColorStop(0, "#ffd96b"); g.addColorStop(1, "#c98a1b");
        c.fillStyle = g; c.fill();
        c.lineWidth = Math.max(2, u * 0.07); c.strokeStyle = "#3a2a0a"; c.stroke();
        c.save();                                                    // hazard stripes on the rim
        c.clip();
        c.strokeStyle = "rgba(40,28,6,0.55)"; c.lineWidth = u * 0.16;
        for (let k = -8; k <= 8; k++) {
            c.beginPath(); c.moveTo(k * u * 0.4 - u * 1.6, u * 1.6); c.lineTo(k * u * 0.4 + u * 1.6, -u * 1.6); c.stroke();
        }
        c.restore();
        c.beginPath(); c.arc(0, 0, u * 1.2, 0, TAU2);                // inner floor
        c.fillStyle = "#2a2318"; c.fill();
        c.lineWidth = Math.max(1.5, u * 0.04); c.strokeStyle = "#ffcf4d"; c.stroke();
        const s = u * 0.5;                                           // house icon
        c.fillStyle = "#ffcf4d"; c.shadowColor = "#ffcf4d"; c.shadowBlur = u * 0.25;
        c.fillRect(-s, -s * 0.1, s * 2, s * 1.1);
        c.beginPath(); c.moveTo(-s * 1.3, -s * 0.1); c.lineTo(0, -s * 1.15); c.lineTo(s * 1.3, -s * 0.1);
        c.closePath(); c.fill();
        c.shadowBlur = 0;
        c.fillStyle = "#2a2318"; c.fillRect(-s * 0.22, s * 0.38, s * 0.44, s * 0.62);
        const blink = 0.5 + 0.5 * Math.sin(now / 300);               // corner beacons
        for (let i = 0; i < 4; i++) {
            const a = Math.PI / 4 + i * Math.PI / 2;
            c.beginPath(); c.arc(Math.cos(a) * u * 1.42, Math.sin(a) * u * 1.42, u * 0.07, 0, TAU2);
            c.fillStyle = `rgba(255,80,80,${0.4 + 0.6 * (i % 2 ? blink : 1 - blink)})`; c.fill();
        }
        c.restore();
    }

    // Dashed ring marking the edge of the delivery disk.
    function baseRing(c, cx, cy, radiusPx) {
        c.save();
        c.strokeStyle = "rgba(255,207,77,0.55)"; c.lineWidth = 3;
        c.setLineDash([14, 12]);
        c.beginPath(); c.arc(cx, cy, radiusPx, 0, TAU2); c.stroke();
        c.restore();
    }

    // Mine cart carrying a heap of gems, drawn pointing along `angle`.
    function cart(c, cx, cy, u, angle, gemRgb, drawCrystal, rngAt) {
        c.save();
        c.translate(cx, cy); c.rotate(angle);
        c.fillStyle = "rgba(0,0,0,0.30)";
        c.beginPath(); c.ellipse(0, u * 0.1, u * 0.52, u * 0.34, 0, 0, TAU2); c.fill();
        c.fillStyle = "#1c2024";                                     // wheels
        for (const sx of [-0.28, 0.28]) for (const sy of [-0.3, 0.3]) {
            c.beginPath(); c.arc(u * sx, u * sy, u * 0.1, 0, TAU2); c.fill();
        }
        c.beginPath();                                               // tub
        c.moveTo(-u * 0.46, -u * 0.26); c.lineTo(u * 0.46, -u * 0.26);
        c.lineTo(u * 0.38, u * 0.26); c.lineTo(-u * 0.38, u * 0.26); c.closePath();
        const g = c.createLinearGradient(0, -u * 0.26, 0, u * 0.26);
        g.addColorStop(0, "#9aa3b2"); g.addColorStop(1, "#5a626f");
        c.fillStyle = g; c.fill();
        c.lineWidth = Math.max(1.5, u * 0.04); c.strokeStyle = "#2a2f38"; c.stroke();
        c.restore();
        // Gem heap stays upright on screen (drawn after the tub, unrotated).
        for (const [dx, dy, s] of [[-0.16, -0.04, 0.2], [0.14, -0.06, 0.22], [0, 0.06, 0.26]]) {
            drawCrystal(cx + dx * u, cy + dy * u, u * s, rngAt(Math.round(dx * 99), Math.round(dy * 99)),
                gemRgb, performance.now(), dx * 9);
        }
    }

    // Name tag under a robot; optional crown for yesterday's winner.
    function nameTag(c, cx, cy, u, name, crowned) {
        c.save();
        const fs = Math.max(10, u * 0.3);
        c.font = `bold ${fs}px "Courier New", monospace`;
        const tw = c.measureText(name).width, pad = fs * 0.5;
        const cw = crowned ? fs * 1.3 : 0;
        const w = tw + pad * 2 + cw, h = fs * 1.5;
        const x = cx - w / 2, y = cy;
        pill(c, x, y, w, h, h / 2);
        c.fillStyle = "rgba(4,12,12,0.7)"; c.fill();
        c.lineWidth = 1.2; c.strokeStyle = "rgba(79,242,200,0.6)"; c.stroke();
        c.textAlign = "left"; c.textBaseline = "middle";
        c.fillStyle = "#eafff8"; c.fillText(name, x + pad + cw, y + h / 2 + 1);
        if (crowned) crown(c, x + pad + fs * 0.5, y + h / 2, fs * 0.9);
        c.restore();
    }

    function crown(c, cx, cy, s) {
        c.save();
        c.translate(cx, cy);
        c.fillStyle = "#ffcf4d"; c.strokeStyle = "#7a5a0a"; c.lineWidth = Math.max(1, s * 0.08);
        c.shadowColor = "#ffcf4d"; c.shadowBlur = s * 0.4;
        c.beginPath();
        c.moveTo(-s * 0.5, s * 0.3); c.lineTo(-s * 0.5, -s * 0.25); c.lineTo(-s * 0.25, 0);
        c.lineTo(0, -s * 0.4); c.lineTo(s * 0.25, 0); c.lineTo(s * 0.5, -s * 0.25);
        c.lineTo(s * 0.5, s * 0.3); c.closePath(); c.fill(); c.shadowBlur = 0; c.stroke();
        c.fillStyle = "#e53935";
        c.beginPath(); c.arc(0, s * 0.08, s * 0.07, 0, TAU2); c.fill();
        c.restore();
    }

    // Speech bubble above a robot: text wraps to 2 lines max, tail points down.
    function bubble(c, cx, bottomY, u, msg) {
        c.save();
        const fs = Math.max(11, u * 0.32);
        c.font = `bold ${fs}px system-ui, sans-serif`;
        const words = msg.split(" "), lines = [""];
        const maxW = u * 4.2;
        for (const w of words) {
            const cur = lines[lines.length - 1];
            if (c.measureText(cur ? cur + " " + w : w).width > maxW && cur) lines.push(w);
            else lines[lines.length - 1] = cur ? cur + " " + w : w;
        }
        const tw = Math.max(...lines.map((l) => c.measureText(l).width));
        const pad = fs * 0.6, lh = fs * 1.25;
        const w = tw + pad * 2, h = lines.length * lh + pad * 1.2;
        const x = cx - w / 2, y = bottomY - h - fs * 0.5;
        pill(c, x, y, w, h, Math.min(fs, h / 2));
        c.fillStyle = "rgba(255,255,255,0.95)"; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = "rgba(0,0,0,0.5)"; c.stroke();
        c.beginPath();                                               // tail
        c.moveTo(cx - fs * 0.4, y + h - 1); c.lineTo(cx, y + h + fs * 0.5); c.lineTo(cx + fs * 0.4, y + h - 1);
        c.closePath(); c.fillStyle = "rgba(255,255,255,0.95)"; c.fill();
        c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "#11181c";
        lines.forEach((l, i) => c.fillText(l, cx, y + pad * 0.6 + lh * (i + 0.5)));
        c.restore();
    }

    return { track, hub, base, baseRing, cart, nameTag, crown, bubble };
})();
