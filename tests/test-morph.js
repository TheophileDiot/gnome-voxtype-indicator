// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the choreography geometry in morph.js, with the real trace.js and orb.js.
// Run from the repository root: gjs -m tests/test-morph.js

import System from 'system';

import {
    CHECK, FLAT, MORPH_MS, breakDots, checkDots, easeOutQuad, primeTrace, sashFade, through, unfold,
} from '../morph.js';
import {ORBS, SEED_IDLE, SEED_OFFLINE} from '../orb.js';
import {createTrace} from '../trace.js';

const failures = [];
let checks = 0;

function check(ok, label) {
    checks++;
    if (!ok)
        failures.push(label);
}

function eq(actual, expected, label) {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        failures.push(`${label}: expected ${e}, got ${a}`);
}

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function nearDot(actual, expected, label) {
    checks++;
    if (!actual || !['x', 'y', 'r', 'a'].every(k => near(actual[k], expected[k], 1e-6)))
        failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const QUIET = {feed: 'live', peak: 0, gate: false, onsets: 0};
const STEP = 1000 / 60;
const frames = totalMs => {
    const ts = [];
    for (let t = 0; t < totalMs; t += STEP)
        ts.push(t);
    ts.push(totalMs);
    return ts;
};
// A dot you can see: positive alpha and positive radius.
const seen = dots => dots.some(d => d.a > 0 && d.r > 0);
const moved = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);

// The settled sash, at upstream's reduced-motion instant and the extension's gain.
const SASH = ORBS.composing.frame(ORBS.composing.stillT).map(d => ({x: d.x, y: d.y, r: d.r * 1.5, a: d.a}));

function primed(voice = QUIET) {
    const trace = createTrace();
    primeTrace(trace, QUIET);
    return voice === QUIET ? trace.frame(0, QUIET) : trace.frame(0, voice);
}

// --- easeOutQuad and MORPH_MS --------------------------------------------------------------

eq([easeOutQuad(0), easeOutQuad(1), easeOutQuad(0.5)], [0, 1, 0.75], 'easeOutQuad: 0, 1 and 0.5');
eq([easeOutQuad(-3), easeOutQuad(7)], [0, 1], 'easeOutQuad: clamped to 0..1');
eq(MORPH_MS, {unfold: 240, handoff: 240, settle: 240, withdraw: 220, breakOut: 260, breakBack: 200}, 'MORPH_MS');
check(Object.isFrozen(MORPH_MS), 'MORPH_MS is frozen');

// --- primeTrace -------------------------------------------------------------------------------

{
    const real = createTrace();
    const dts = [];
    const voices = [];
    const spy = {
        frame(dt, v) {
            dts.push(dt);
            voices.push(v);
            return real.frame(dt, v);
        },
    };
    primeTrace(spy, QUIET);
    eq(dts.length, 13, 'primeTrace: 13 frames');
    check(dts.every(dt => dt <= 100), 'primeTrace: every dt stays under the 100 ms clamp');
    eq(dts.reduce((s, dt) => s + dt, 0), 650, 'primeTrace: the steps sum to exactly 650 ms');
    check(voices.every(v => v === QUIET), 'primeTrace: every frame gets the quiet snapshot');

    const centre = real.frame(0, QUIET).slice().sort((p, q) => q.x - p.x);
    eq(centre.length, 6, 'primeTrace: six columns of history');
    centre.forEach((d, k) => check(near(d.x, 17.8 - 3.2 * k, 0.01), `primeTrace: centre bead ${k} at x = 17.8 - 3.2 * ${k} (got ${d.x})`));
}

// --- through ----------------------------------------------------------------------------------

const HANDOFF = {gatherMs: 120, bloomStartMs: 50, totalMs: MORPH_MS.handoff};
const WITHDRAW = {gatherMs: 120, bloomStartMs: 80, totalMs: MORPH_MS.withdraw};
const CRASH = {gatherMs: 140, bloomStartMs: 60, totalMs: 220};

{
    const red = primed();
    const amber = SASH;
    for (const [name, params] of [['hand-off', HANDOFF], ['withdraw', WITHDRAW], ['crash', CRASH]]) {
        const start = through(red, SASH, 0, params);
        eq(start.out, red, `through ${name}: the outgoing layer at 0 ms is unchanged`);
        eq(start.in, [], `through ${name}: nothing has bloomed at 0 ms`);
        const end = through(red, SASH, params.totalMs, params);
        eq(end.out, [], `through ${name}: nothing is left of the outgoing layer at the end`);
        eq(end.in, SASH, `through ${name}: the incoming layer at the end is the plain shape`);
        eq(through(red, SASH, -50, params), through(red, SASH, 0, params), `through ${name}: clamped before 0`);
        eq(through(red, SASH, params.totalMs + 400, params), end, `through ${name}: clamped after the end`);

        const gathered = through(red, SASH, params.gatherMs, params).out;
        if (gathered.length > 0) {
            check(gathered.every((d, i) => near(d.x, 10, 1e-9) && near(d.y, 10, 1e-9) && near(d.r, red[i].r * 0.4, 1e-9)),
                `through ${name}: by gatherMs the outgoing dots sit at (10, 10) at 40% radius`);
        }
        check(frames(params.totalMs).every(t => {
            const {out, in: inn} = through(red, SASH, t, params);
            return seen([...out, ...inn]);
        }), `through ${name}: the orb is never empty at any 60 Hz step`);
    }

    // The outgoing alpha is a * (1 - bloom): at the middle of the bloom the factor is not 1.
    const mid = through(red, SASH, 150, HANDOFF);
    check(mid.out.every((d, i) => d.a < red[i].a), 'through: the outgoing alpha falls once the bloom starts');
    const early = through(red, SASH, 30, HANDOFF);
    check(early.out.every((d, i) => near(d.a, red[i].a)), 'through: the outgoing alpha is untouched before the bloom starts');

    // Two outgoing layers keep their own inks: each call returns its layer, so both are unchanged at 0 ms.
    const a = through(red, SASH, 0, HANDOFF).out;
    const b = through(amber, SASH, 0, HANDOFF).out;
    eq(a, red, 'through: the red layer is unchanged at 0 ms');
    eq(b, amber, 'through: the amber layer is unchanged at 0 ms');
    check(a !== b, 'through: two layers do not share an array');
}

{
    // Per-frame moves in the hand-off stay under 2.7 units, for a quiet and for a speaking trace.
    const speaking = createTrace();
    primeTrace(speaking, QUIET);
    let loud;
    for (let i = 0; i < 6; i++)
        loud = speaking.frame(50, {feed: 'live', peak: 0.55, level: 0.55, fast: 0.55, gate: true, onsets: 1});
    for (const [name, out] of [['quiet', primed()], ['speaking', loud]]) {
        let worst = 0;
        let prev = through(out, SASH, 0, HANDOFF);
        for (const t of frames(MORPH_MS.handoff).slice(1)) {
            const cur = through(out, SASH, t, HANDOFF);
            // The outgoing list keeps its length until it ends; the incoming list appears at the centre.
            for (let i = 0; i < Math.min(prev.out.length, cur.out.length); i++)
                worst = Math.max(worst, moved(prev.out[i], cur.out[i]));
            for (let i = 0; i < Math.min(prev.in.length, cur.in.length); i++)
                worst = Math.max(worst, moved(prev.in[i], cur.in[i]));
            prev = cur;
        }
        check(worst <= 2.7, `through hand-off (${name} trace): a dot moves at most 2.7 per frame (worst ${worst.toFixed(3)})`);
    }
}

// --- unfold -----------------------------------------------------------------------------------

{
    const live = primed();
    const at0 = unfold(SEED_IDLE, live, 0);
    eq(at0.seed, SEED_IDLE, 'unfold: the seed layer at 0 ms is the plain Seed');
    check(at0.trace === live, 'unfold: the trace dots pass through unchanged');
    const end = unfold(SEED_IDLE, live, MORPH_MS.unfold);
    eq(end.seed, [], 'unfold: the seed layer is empty from 240 ms');
    check(end.trace === live, 'unfold: the trace dots still pass through at the end');
    eq(unfold(SEED_IDLE, live, -20).seed, at0.seed, 'unfold: clamped before 0');
    eq(unfold(SEED_IDLE, live, 900).seed, [], 'unfold: clamped after the end');

    check(frames(MORPH_MS.unfold).every(t => {
        const f = unfold(SEED_IDLE, live, t);
        return seen([...f.seed, ...f.trace]);
    }), 'unfold: the orb is never empty at any 60 Hz step');

    let worst = 0;
    let prev = unfold(SEED_IDLE, live, 0).seed;
    for (const t of frames(MORPH_MS.unfold).slice(1, -1)) {
        const cur = unfold(SEED_IDLE, live, t).seed;
        eq(cur.length, 19, `unfold: 19 seed beads at ${t.toFixed(1)} ms`);
        for (let i = 0; i < cur.length; i++)
            worst = Math.max(worst, moved(prev[i], cur[i]));
        prev = cur;
    }
    check(worst <= 1.1, `unfold: a bead moves at most 1.1 per frame (worst ${worst.toFixed(3)})`);

    // The centre row (SEED_IDLE[7..11], p = -2..2) heads for column k = 3 - p at x = 17.8 - 3.2 * (k + t / 130).
    // pos = seed + (target - seed) * easeOutQuad(t / 240), so the target comes back out of the output.
    const targetOf = (i, t) => {
        const f = easeOutQuad(t / MORPH_MS.unfold);
        const s = unfold(SEED_IDLE, live, t).seed[i];
        return {x: SEED_IDLE[i].x + (s.x - SEED_IDLE[i].x) / f, y: SEED_IDLE[i].y + (s.y - SEED_IDLE[i].y) / f};
    };
    const columns = live.slice().sort((p, q) => q.x - p.x); // k = 0..5, newest first
    for (let p = 2; p >= -2; p--) {
        const i = 9 + p;
        const k = 3 - p;
        for (const t of [60, 120, 180]) {
            const tg = targetOf(i, t);
            check(near(tg.x, 17.8 - 3.2 * (k + t / 130), 1e-6), `unfold: row bead p = ${p} heads for x = 17.8 - 3.2 * (${k} + ${t} / 130), got ${tg.x}`);
            check(near(tg.y, 10, 1e-6), `unfold: row bead p = ${p} stays on the centre line`);
        }
        // At t = 0 the target is the primed trace's own centre bead of column k.
        const t0 = 2 * targetOf(i, 60).x - targetOf(i, 120).x;
        check(near(t0, columns[k].x, 0.01), `unfold: row bead p = ${p} targets the primed trace's column ${k} at 0 ms (${t0} vs ${columns[k].x})`);
    }
    // The other fourteen beads slide onto the centre line and shrink to radius 0.
    const late = unfold(SEED_IDLE, live, 239).seed;
    for (let i = 0; i < 19; i++) {
        check(near(late[i].y, 10, 0.05), `unfold: bead ${i} is on the centre line just before the end (y = ${late[i].y})`);
        check(late[i].r < 0.05, `unfold: bead ${i} has shrunk away just before the end (r = ${late[i].r})`);
    }
}

// --- breakDots --------------------------------------------------------------------------------

{
    eq(breakDots(0, 'out'), SEED_IDLE, "breakDots: 'out' starts as the Seed");
    eq(breakDots(MORPH_MS.breakOut, 'out'), SEED_OFFLINE, "breakDots: 'out' ends as the ring");
    eq(breakDots(0, 'back'), SEED_OFFLINE, "breakDots: 'back' starts as the ring");
    eq(breakDots(MORPH_MS.breakBack, 'back'), SEED_IDLE, "breakDots: 'back' ends as the Seed");
    eq(breakDots(-30, 'out'), SEED_IDLE, "breakDots: 'out' clamped before 0");
    eq(breakDots(2000, 'out'), SEED_OFFLINE, "breakDots: 'out' clamped after the end");
    eq(breakDots(2000, 'back'), SEED_IDLE, "breakDots: 'back' clamped after the end");

    for (const [dir, ms] of [['out', MORPH_MS.breakOut], ['back', MORPH_MS.breakBack]]) {
        check(frames(ms).every(t => seen(breakDots(t, dir))), `breakDots ${dir}: never empty at any 60 Hz step`);
        let worst = 0;
        let prev = breakDots(0, dir);
        for (const t of frames(ms).slice(1)) {
            const cur = breakDots(t, dir);
            // Beads only shrink away or stay; none appears. Each bead of a frame comes from one in the frame before.
            for (const d of (dir === 'out' ? cur : prev)) {
                const nearest = Math.min(...(dir === 'out' ? prev : cur).map(e => moved(d, e)));
                worst = Math.max(worst, nearest);
            }
            prev = cur;
        }
        check(worst <= 0.3, `breakDots ${dir}: a bead moves at most 0.3 per frame (worst ${worst.toFixed(3)})`);
    }

    // The two gap beads (slots 1 and 2) shrink first (g 0 to 0.6), the seven inner beads right behind (0.15 to 0.85).
    eq(breakDots(60, 'out').length, 19, "breakDots: all 19 beads are still there at 60 ms");
    eq(breakDots(130, 'out').length, 17, "breakDots: the two gap beads are gone halfway");
    eq(breakDots(200, 'out').length, 10, "breakDots: only the ten ring beads are left at 200 ms");
}

// --- the receipt ---------------------------------------------------------

eq(CHECK.length, 8, 'CHECK: 8 beads');
eq(FLAT.length, 6, 'FLAT: 6 beads');
nearDot(CHECK[0], {x: 4.6, y: 10.8, r: 1.3, a: 0.6}, 'CHECK[0]');
nearDot(CHECK[2], {x: 8.2, y: 14.4, r: 1.3, a: 0.6 + 0.4 * 2 / 7}, 'CHECK[2], the corner');
nearDot(CHECK[7], {x: 15.4, y: 6.2, r: 1.3, a: 1}, 'CHECK[7]');
nearDot(FLAT[5], {x: 17.8, y: 10, r: 1.3, a: 1}, 'FLAT[5]');
nearDot(FLAT[0], {x: 1.8, y: 10, r: 1.3, a: 0.55}, 'FLAT[0]');
for (const [name, dots] of [['CHECK', CHECK], ['FLAT', FLAT]]) {
    check(Object.isFrozen(dots) && dots.every(d => Object.isFrozen(d)), `${name}: frozen array of frozen dots`);
    check(dots.every(d => Object.keys(d).join() === 'x,y,r,a'), `${name}: dots are {x, y, r, a}`);
}

eq(checkDots('done', 442), CHECK, "checkDots: 'done' at 442 ms is the whole CHECK");
eq(checkDots('nothing-heard', 390), FLAT, "checkDots: 'nothing-heard' at 390 ms is the whole FLAT");
eq(checkDots('done', 5000), CHECK, "checkDots: 'done' stays complete");
eq(checkDots('done', 0), [], "checkDots: nothing is drawn at 0 ms");
eq(checkDots('done', 60), [], 'checkDots: the first bead has radius 0 at 60 ms');
{
    const a = checkDots('done', 100);
    check(a.length > 0 && a.length < 8, 'checkDots: the beads grow one after another');
    check(a[0].r > 0.02 && a[0].r < 1.3, 'checkDots: the first bead is partway grown at 100 ms');
    let prevCount = 0;
    let prevR = 0;
    for (let t = 0; t <= 460; t += 10) {
        const d = checkDots('done', t);
        check(d.length >= prevCount, `checkDots: no bead disappears (t = ${t})`);
        prevCount = d.length;
        const r0 = d.length > 0 ? d[0].r : 0;
        check(r0 >= prevR - 1e-12, `checkDots: the first bead only grows (t = ${t})`);
        prevR = r0;
    }
    // Skipped while its radius is under 0.02: no tiny bead is ever listed.
    check(frames(460).every(t => checkDots('done', t).every(d => d.r >= 0.02)), 'checkDots: no bead under radius 0.02');
}

eq([sashFade(0), sashFade(140), sashFade(70)], [1, 0, 0.25], 'sashFade: 1 at 0, 0 at 140 and 0.25 at 70 ms');
eq([sashFade(-10), sashFade(900)], [1, 0], 'sashFade: clamped');

// --- result ----------------------------------------------------------------------------------

if (failures.length > 0) {
    printerr(`FAIL (${failures.length} of ${checks} checks):`);
    for (const f of failures)
        printerr(`  - ${f}`);
    System.exit(1);
}
print(`ok: ${checks} checks`);
