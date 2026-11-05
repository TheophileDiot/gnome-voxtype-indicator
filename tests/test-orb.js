// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the orb geometry in orb.js (composing), against upstream's golden values.
// Run from the repository root: gjs -m tests/test-orb.js

import GLib from 'gi://GLib';
import System from 'system';

import {ORBS, ORB_SIZE, SEED_IDLE, SEED_OFFLINE, seedIdle, seedOffline} from '../orb.js';

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

const KEYS = ['x', 'y', 'z', 'r', 'white', 'a'];
const flat = dots => dots.flatMap(d => KEYS.map(k => d[k]));
const maxDiff = (p, q) => p.reduce((m, v, i) => Math.max(m, Math.abs(v - q[i])), 0);
const q4 = v => Math.round(v * 1e4);
// The z-sort reorders the dots as they move, so a loop is compared as a set of dots.
const canon = (orb, t) => flat(orb.frame(t).sort((p, q) => q4(p.x) - q4(q.x) || q4(p.y) - q4(q.y) || q4(p.z) - q4(q.z)));

const dir = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
const fixture = name => {
    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, name]));
    return JSON.parse(new TextDecoder().decode(bytes));
};

// Per state: golden file, dot count of the 20 px preset, loop length on upstream's clock, clock factor.
const STATES = {
    composing: {golden: 'orb-golden-composing-20.json', dots: 208, periodT: 20 * Math.PI, speed: 3.12, periodS: [20, 20.3]},
};

eq(Object.keys(ORBS), Object.keys(STATES), 'orb.js exports exactly the states under test');

for (const [name, cfg] of Object.entries(STATES)) {
    const orb = ORBS[name];
    const spec = fixture(cfg.golden);

    // --- upstream golden values: 20 px, four instants -----------------------------------
    eq(spec.cases.length, 4, `${name}: golden fixture holds four instants`);
    for (const c of spec.cases) {
        const dots = orb.frame(c.t);
        eq(dots.length, c.dotCount, `${name} t=${c.t}: dot count`);
        const got = flat(dots);
        eq(got.length, c.dots.length, `${name} t=${c.t}: value count`);
        check(got.length === c.dots.length && maxDiff(got, c.dots) <= spec.tolerance,
            `${name} t=${c.t}: dots differ from upstream by ${maxDiff(got, c.dots)} (tolerance ${spec.tolerance})`);
    }

    // --- shape of the frame ---------------------------------------------------------------
    eq(orb.frame(0).length, cfg.dots, `${name}: dot count of the 20 px preset`);
    eq(orb.frame(orb.stillT).length, cfg.dots, `${name}: the still frame has the same dot count`);
    eq(orb.stillT, 0.6, `${name}: still frame is upstream's reduced-motion instant`);

    for (const t of [-1e4, -3.3, 0, 0.6, 1.7, 5.1, 62.8, 1e3, 1e6]) {
        const dots = orb.frame(t);
        check(flat(dots).every(Number.isFinite), `${name} t=${t}: every value is finite`);
        check(dots.every(d => d.r >= 0.3), `${name} t=${t}: radius floor 0.3`);
        check(dots.every(d => d.a >= 0.02 && d.a <= 1), `${name} t=${t}: alpha in [0.02, 1]`);
        check(dots.every((d, i) => i === 0 || dots[i - 1].z <= d.z), `${name} t=${t}: drawn far to near`);
        check(dots.every(d => d.x - d.r >= 0 && d.x + d.r <= ORB_SIZE && d.y - d.r >= 0 && d.y + d.r <= ORB_SIZE),
            `${name} t=${t}: every dot stays inside the ${ORB_SIZE} px frame`);
    }

    eq(flat(orb.frame(3.3)), flat(orb.frame(3.3)), `${name}: same time, same frame`);
    check(maxDiff(flat(orb.frame(2)), flat(orb.frame(2.5))) > 0.1, `${name}: the orb moves`);
    {
        // a call must not leak state into the next one (composing shares its ghost dots)
        const before = flat(orb.frame(0.6));
        orb.frame(9.9);
        eq(flat(orb.frame(0.6)), before, `${name}: a frame does not change the next one`);
    }

    // --- loop and clock -------------------------------------------------------------------
    check(Math.abs(orb.time(orb.periodMs) - cfg.periodT) < 0.01,
        `${name}: periodMs is ${cfg.periodT / Math.PI} pi on the orb clock, to the millisecond`);
    for (const t of [0, orb.stillT, 1.7, 4.4]) {
        const a = canon(orb, t);
        const b = canon(orb, t + cfg.periodT);
        check(maxDiff(a, b) < 1e-9, `${name} t=${t}: back to the start after one period (diff ${maxDiff(a, b)})`);
    }
    check(maxDiff(canon(orb, 0), canon(orb, cfg.periodT / 2)) > 0.1, `${name}: half a period is a different frame`);
    check(orb.periodMs > cfg.periodS[0] * 1000 && orb.periodMs < cfg.periodS[1] * 1000,
        `${name}: period is about ${cfg.periodS[0]} s, got ${orb.periodMs} ms`);
    eq(orb.time(0), 0, `${name}: clock starts at 0`);
    check(Math.abs(orb.time(1000) - cfg.speed) < 1e-12, `${name}: the 20 px preset runs the clock at ${cfg.speed}x`);
}

// --- Seed: the static idle and offline dots --------------------------------

const near = (dot, want, label) => {
    for (const [k, v] of Object.entries(want))
        check(Math.abs(dot[k] - v) < 1e-3, `${label}.${k}: expected ${v}, got ${dot[k]}`);
};

eq(SEED_IDLE.length, 19, 'seed idle: 19 beads');
eq(SEED_IDLE[9], {x: 10, y: 10, r: 1.2, a: 1}, 'seed idle: the centre bead');
near(SEED_IDLE[0], {x: 7.3, y: 5.3235, r: 1.2, a: 0.62}, 'seed idle[0]');
near(SEED_IDLE[18], {x: 12.7, y: 14.6765, r: 1.2, a: 0.62}, 'seed idle[18]');
eq(SEED_OFFLINE.length, 10, 'seed offline: 10 beads');
near(SEED_OFFLINE[0], {x: 10, y: 3.8, r: 1.25, a: 0.85}, 'seed offline[0]');
near(SEED_OFFLINE[1], {x: 16.2, y: 10, r: 1.25, a: 0.85}, 'seed offline[1]');
near(SEED_OFFLINE[9], {x: 6.9, y: 4.6307, r: 1.25, a: 0.85}, 'seed offline[9]');

for (const [name, dots] of [['idle', SEED_IDLE], ['offline', SEED_OFFLINE]]) {
    check(Object.isFrozen(dots), `seed ${name}: the array is frozen`);
    check(dots.every(d => Object.isFrozen(d)), `seed ${name}: every dot is frozen`);
    check(dots.every(d => Object.keys(d).join() === 'x,y,r,a'), `seed ${name}: dots are {x, y, r, a}`);
    check(dots.every(d => d.x - d.r >= 0 && d.x + d.r <= ORB_SIZE && d.y - d.r >= 0 && d.y + d.r <= ORB_SIZE),
        `seed ${name}: every dot stays inside the ${ORB_SIZE} px frame`);
    check(dots.every(d => d.a >= 0.55 && d.a <= 1), `seed ${name}: alpha in [0.55, 1]`);
}
// The gap at the top right: no offline bead sits between 12 and 2 o'clock.
check(SEED_OFFLINE.every(d => !(d.x > 10.5 && d.y < 8.5 && d.x < 15.5)), 'seed offline: gap at the top right');

// --- Seed at an "open" amount o -------------------------------------------

eq(seedIdle(0), SEED_IDLE, 'seedIdle(0) equals the frozen SEED_IDLE');
eq(seedOffline(0), SEED_OFFLINE, 'seedOffline(0) equals the frozen SEED_OFFLINE');
// Golden values at o = 1: spacing 2.9, radius 1.32, rim alpha slope 0.2; ring bead radius 1.38, alpha 1.
eq(seedIdle(1).length, 19, 'seedIdle(1): 19 beads');
near(seedIdle(1)[0], {x: 7.1, y: 4.97705, r: 1.32, a: 0.8}, 'seedIdle(1)[0]');
near(seedIdle(1)[9], {x: 10, y: 10, r: 1.32, a: 1}, 'seedIdle(1)[9]');
eq(seedOffline(1).length, 10, 'seedOffline(1): 10 beads');
near(seedOffline(1)[0], {x: 10, y: 3.8, r: 1.38, a: 1}, 'seedOffline(1)[0]');
// Halfway: spacing 2.8, radius 1.26, slope 0.29; ring radius 1.315, alpha 0.925.
near(seedIdle(0.5)[18], {x: 12.8, y: 10 + 2.8 * Math.sqrt(3), r: 1.26, a: 0.71}, 'seedIdle(0.5)[18]');
near(seedOffline(0.5)[1], {x: 16.2, y: 10, r: 1.315, a: 0.925}, 'seedOffline(0.5)[1]');
eq(seedIdle(-3), SEED_IDLE, 'seedIdle clamps o below 0');
eq(seedIdle(7), seedIdle(1), 'seedIdle clamps o above 1');
eq(seedOffline(-0.2), SEED_OFFLINE, 'seedOffline clamps o below 0');
eq(seedOffline(12), seedOffline(1), 'seedOffline clamps o above 1');
for (const o of [0.25, 1]) {
    check(seedIdle(o).every(d => d.x - d.r >= 0 && d.x + d.r <= ORB_SIZE && d.y - d.r >= 0 && d.y + d.r <= ORB_SIZE),
        `seedIdle(${o}): every dot stays inside the frame`);
    check(seedOffline(o).every(d => d.x - d.r >= 0 && d.x + d.r <= ORB_SIZE && d.y - d.r >= 0 && d.y + d.r <= ORB_SIZE),
        `seedOffline(${o}): every dot stays inside the frame`);
}
check(Object.isFrozen(seedIdle(0.5)) && seedIdle(0.5).every(d => Object.isFrozen(d)), 'seedIdle(0.5): frozen dots');
// Brighter when open: no bead gets dimmer or smaller as o rises.
check(seedIdle(1).every((d, i) => d.a >= seedIdle(0)[i].a && d.r >= seedIdle(0)[i].r), 'seedIdle: opening only brightens');

// --- result ----------------------------------------------------------------------------

if (failures.length > 0) {
    printerr(`FAIL (${failures.length} of ${checks} checks):`);
    for (const f of failures)
        printerr(`  - ${f}`);
    System.exit(1);
}
print(`ok: ${checks} checks`);
