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

    // Hub (player-built station): steel platform, ring in the builder's colour,
    // and a blinking signal lamp. `tilt` is only used by the preview ghost.
    function hub(c, cx, cy, u, color, now, ghost) {
        c.save();
        c.translate(cx, cy);
        if (ghost) c.globalAlpha = 0.6;
        c.fillStyle = "rgba(0,0,0,0.30)";
        c.beginPath(); c.ellipse(0, u * 0.1, u * 0.62, u * 0.5, 0, 0, TAU2); c.fill();
        c.beginPath(); c.arc(0, 0, u * 0.55, 0, TAU2);               // outer ring (builder colour)
        c.fillStyle = color; c.fill();
        c.lineWidth = Math.max(1.5, u * 0.04); c.strokeStyle = "#1c2024"; c.stroke();
        c.beginPath(); c.arc(0, 0, u * 0.42, 0, TAU2);               // steel deck
        const g = c.createLinearGradient(0, -u * 0.4, 0, u * 0.4);
        g.addColorStop(0, "#d6dce6"); g.addColorStop(1, "#7d8594");
        c.fillStyle = g; c.fill(); c.stroke();
        c.strokeStyle = "rgba(0,0,0,0.25)"; c.lineWidth = Math.max(1, u * 0.025);
        for (let i = 0; i < 4; i++) {                                // deck plating lines
            const a = i * Math.PI / 4;
            c.beginPath(); c.moveTo(Math.cos(a) * u * 0.42, Math.sin(a) * u * 0.42);
            c.lineTo(-Math.cos(a) * u * 0.42, -Math.sin(a) * u * 0.42); c.stroke();
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
        c.font = `bold ${u * 0.3}px "Courier New", monospace`;
        c.textAlign = "center"; c.textBaseline = "middle";
        c.fillStyle = "#ffcf4d"; c.fillText("BASE", 0, u * 0.98);
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
