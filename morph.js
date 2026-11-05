// SPDX-License-Identifier: GPL-2.0-or-later
// Choreography geometry of the orb transitions. Pure and Shell-free, no imports at all:
// every function takes elapsed milliseconds and returns dots, and applies EASE_OUT_QUAD to each phase itself because
// phases overlap (a gather from 0 to 120 ms, a bloom from 50 to 240 ms). A Clutter.Timeline only supplies the time.
//
// A dot is {x, y, r, a} in the 20-unit orb frame, as in orb.js and trace.js. A layer is a frozen array of dots; a
// caller paints each layer in its own ink, so two inks never blend into one dot.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// Exact at both ends, so a finished transition equals the plain shape.
const lerp = (a, b, f) => f <= 0 ? a : f >= 1 ? b : a + (b - a) * f;

const C = 10;

export const easeOutQuad = x => {
    const t = clamp(x, 0, 1);
    return 1 - (1 - t) * (1 - t);
};

export const MORPH_MS = Object.freeze({unfold: 240, handoff: 240, settle: 240, withdraw: 220, breakOut: 260, breakBack: 200});

// A phase that runs from startMs to endMs, eased on its own linear progress.
const phase = (t, startMs, endMs) => endMs > startMs ? easeOutQuad((t - startMs) / (endMs - startMs)) : t >= endMs ? 1 : 0;

const layer = dots => Object.freeze(dots.map(d => Object.freeze(d)));

// 650 ms of quiet history in 13 steps of 50 ms, under trace.js's 100 ms clamp. That leaves six
// columns at ages 0, 130 ... 650 ms, so a recording starts with a trace that already has a past. It takes the trace
// object so this module still imports nothing.
export function primeTrace(trace, quiet) {
    for (let i = 0; i < 13; i++)
        trace.frame(50, quiet);
}

// Everything leaves through the centre and the next shape comes out of it. The outgoing dots move to
// (10, 10) and shrink to 40% by gatherMs; the incoming dots grow from the centre between bloomStartMs and totalMs;
// the outgoing alpha is a * (1 - bloom), so the orb is never empty. Call it once per outgoing layer, so each keeps its
// own ink. Returns {out, in}.
export function through(outDots, inDots, tMs, {gatherMs, bloomStartMs, totalMs}) {
    const t = clamp(tMs, 0, totalMs);
    const gather = phase(t, 0, gatherMs);
    const bloom = phase(t, bloomStartMs, totalMs);
    const out = bloom < 1
        ? outDots.map(d => ({x: lerp(d.x, C, gather), y: lerp(d.y, C, gather), r: d.r * (1 - 0.6 * gather), a: d.a * (1 - bloom)}))
        : [];
    const inn = bloom > 0
        ? inDots.map(d => ({x: lerp(C, d.x, bloom), y: lerp(C, d.y, bloom), r: d.r * bloom, a: d.a * bloom}))
        : [];
    return {out: layer(out), in: layer(inn)};
}

// The trace's newest column and its spacing, as in trace.js: a column of age `ms` sits at x = 17.8 - 3.2 * ms / 130.
const NEWEST_X = 17.8;
const SPACING = 3.2;
const COLUMN_MS = 130;

// Seed -> trace (idle -> recording). The Seed's centre row (q = 0, p = 2 ... -2) heads for the
// trace's columns k = 1 ... 5, bead p to column k = 3 - p, at x = 17.8 - 3.2 * (k + t / 130): it scrolls left exactly as
// a column of that age would, and shrinks away as the live column takes its place. The other beads slide onto the
// centre line and shrink to radius 0. `traceDots` come back untouched, the caller draws them from the first frame.
// Returns {seed, trace}; the seed layer is empty from 240 ms.
export function unfold(seedDots, traceDots, tMs) {
    if (tMs >= MORPH_MS.unfold)
        return {seed: layer([]), trace: traceDots};
    const t = Math.max(0, tMs);
    const f = easeOutQuad(t / MORPH_MS.unfold);
    const row = [];
    seedDots.forEach((d, i) => {
        if (Math.abs(d.y - C) < 1e-6)
            row.push(i);
    });
    row.sort((p, q) => seedDots[q].x - seedDots[p].x);
    const targetX = new Map(row.map((i, j) => [i, NEWEST_X - SPACING * (j + 1 + t / COLUMN_MS)]));
    const seed = seedDots.map((d, i) => {
        let tx = targetX.get(i);
        if (tx === undefined) {
            // The nearest row bead in x: the bead slides into the column its neighbour is becoming.
            let best = -1;
            for (const j of row) {
                if (best < 0 || Math.abs(seedDots[j].x - d.x) < Math.abs(seedDots[best].x - d.x))
                    best = j;
            }
            tx = best < 0 ? d.x : targetX.get(best);
        }
        return {x: lerp(d.x, tx, f), y: lerp(d.y, C, f), r: d.r * (1 - f), a: d.a};
    });
    return {seed: layer(seed), trace: traceDots};
}

// The Seed and the offline ring, built here with the very formulas of orb.js (this module imports nothing). The
// tests pin both ends of the break against orb.js's SEED_IDLE and SEED_OFFLINE.
const TAU = 2 * Math.PI;
const ringPos = i => {
    const angle = i / 12 * TAU - Math.PI / 2;
    return {x: C + 6.2 * Math.cos(angle), y: C + 6.2 * Math.sin(angle)};
};

const BEADS = [];
for (let q = -2; q <= 2; q++) {
    for (let p = -2; p <= 2; p++) {
        if (Math.abs(p + q) > 2)
            continue;
        const x = C + 2.7 * (p + q / 2);
        const y = C + 2.7 * q * Math.sqrt(3) / 2;
        const d = Math.hypot(x - C, y - C) / (2 * 2.7);
        const bead = {x, y, r: 1.2, a: 1 - 0.38 * d, slot: -1};
        // The twelve rim beads (hex distance 2) already sit on the ring's 30 degree slots.
        if (Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q)) === 2)
            bead.slot = ((Math.round((Math.atan2(y - C, x - C) + Math.PI / 2) / (TAU / 12)) % 12) + 12) % 12;
        BEADS.push(bead);
    }
}
const IDLE = layer(BEADS.map(({x, y, r, a}) => ({x, y, r, a})));
const OFFLINE = layer((() => {
    const dots = [];
    for (let i = 0; i < 12; i++) {
        if (i !== 1 && i !== 2)
            dots.push({...ringPos(i), r: 1.25, a: 0.85});
    }
    return dots;
})());

// Seed <-> offline ring. `g` = 0 is the Seed, 1 the ring. The rim stretches to radius 6.2, the two
// beads of the gap (slots 1 and 2) shrink first (g 0 to 0.6) and the seven inner beads right behind them (0.15 to 0.85).
function breakShape(g) {
    if (g <= 0)
        return IDLE;
    if (g >= 1)
        return OFFLINE;
    const dots = [];
    for (const b of BEADS) {
        if (b.slot < 0) {
            dots.push({x: b.x, y: b.y, r: 1.2 * (1 - clamp((g - 0.15) / 0.7, 0, 1)), a: b.a});
            continue;
        }
        const to = ringPos(b.slot);
        const gap = b.slot === 1 || b.slot === 2;
        dots.push({
            x: lerp(b.x, to.x, g),
            y: lerp(b.y, to.y, g),
            r: gap ? 1.2 * (1 - clamp(g / 0.6, 0, 1)) : lerp(1.2, 1.25, g),
            a: lerp(b.a, 0.85, g),
        });
    }
    return layer(dots.filter(d => d.r > 0.05));
}

// 'out' (Seed -> ring, 260 ms) or 'back' (ring -> Seed, 200 ms). The ends are exactly SEED_IDLE and SEED_OFFLINE.
export function breakDots(tMs, direction) {
    return direction === 'back'
        ? breakShape(1 - easeOutQuad(tMs / MORPH_MS.breakBack))
        : breakShape(easeOutQuad(tMs / MORPH_MS.breakOut));
}

// The receipt glyphs. CHECK: 8 beads on the polyline (4.6, 10.8) -> (8.2, 14.4) -> (15.4, 6.2),
// the first segment in round(len / 2.4) = 2 steps and the second in 5, the shared corner once. FLAT: the trace's six
// muted columns as a line, `Nothing heard`.
export const CHECK = layer((() => {
    const pts = [[4.6, 10.8], [8.2, 14.4], [15.4, 6.2]];
    const dots = [];
    for (let s = 0; s < 2; s++) {
        const [a, b] = [pts[s], pts[s + 1]];
        const n = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.4);
        for (let i = s ? 1 : 0; i <= n; i++)
            dots.push({x: a[0] + (b[0] - a[0]) * i / n, y: a[1] + (b[1] - a[1]) * i / n});
    }
    return dots.map((d, i) => ({x: d.x, y: d.y, r: 1.3, a: 0.6 + 0.4 * i / (dots.length - 1)}));
})());

export const FLAT = layer(Array.from({length: 6}, (_, i) => ({x: NEWEST_X - SPACING * (5 - i), y: C, r: 1.3, a: 0.55 + 0.45 * i / 5})));

// The glyph beads `tMs` after the receipt starts: bead i grows with r * easeOutQuad((t - 60 - 26 i) / 200) and is left
// out while its radius is under 0.02. Complete at 442 ms for 'done' and 390 ms for 'nothing-heard'.
export function checkDots(kind, tMs) {
    const glyph = kind === 'done' ? CHECK : FLAT;
    const dots = [];
    glyph.forEach((d, i) => {
        const r = d.r * easeOutQuad((tMs - 60 - 26 * i) / 200);
        if (r >= 0.02)
            dots.push({x: d.x, y: d.y, r, a: d.a});
    });
    return layer(dots);
}

// The alpha factor of the frozen sash while the glyph draws.
export const sashFade = tMs => 1 - easeOutQuad(tMs / 140);
