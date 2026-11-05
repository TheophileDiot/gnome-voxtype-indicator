// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the Trace · Pulse geometry in trace.js, against hand-built voice snapshots.
// Run from the repository root: gjs -m tests/test-trace.js

import GLib from 'gi://GLib';
import System from 'system';

import {TRACE_SIZE, createTrace} from '../trace.js';

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

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const log = line => print(`  ${line}`);

// --- deterministic voice simulator --------------------------------------------------------------
// It rebuilds what VoiceTracker does (common.js) on its 10 ms grid, so the snapshots here do not depend
// on that module: followers, gate, onsets, and the peak of the grid frames since the last display tick.

function rng(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 10 ms peak dBFS per scenario kind: syllables of about 200 ms in words with short gaps, a quiet room.
function makeSource(seed) {
    const R = rng(seed);
    let sylEnd = 0, sylStart = 0, sylPeak = -30, pauseUntil = 0, sylLeft = 0;
    return {
        speech(t) {
            if (t >= sylEnd && t >= pauseUntil) {
                if (sylLeft <= 0) {
                    sylLeft = 2 + Math.floor(R() * 4);
                    pauseUntil = t + (R() < 0.25 ? 700 + R() * 600 : 120 + R() * 120);
                }
                if (t >= pauseUntil) {
                    sylStart = t;
                    sylEnd = t + 150 + R() * 110;
                    sylPeak = -40 + R() * 20;
                    sylLeft--;
                }
            }
            if (t < sylEnd && t >= sylStart) {
                const p = (t - sylStart) / (sylEnd - sylStart);
                return -58 + (sylPeak + 58) * Math.sin(Math.PI * p) ** 2 + (R() - 0.5) * 3;
            }
            return -62 + (R() - 0.5) * 4;
        },
        quiet() {
            return -62 + (R() - 0.5) * 5 + (R() < 0.004 ? 9 : 0);
        },
        silent: () => -120,
        nofeed: () => -120,
        burst(t) { // 2 s of on/off bursts, then it stays on
            return Math.floor(t / 100) % 12 < 6 ? -22 : -58;
        },
    };
}

// script: [[kind, ms], ...], kind one of speech, quiet, silent, nofeed, burst. Returns one {dt, kind, v}
// per display tick; dtFn gives each tick's length.
function simulate(script, dtFn, seed = 7) {
    const src = makeSource(seed);
    const total = script.reduce((n, [, ms]) => n + ms, 0);
    const kindAt = t => {
        let end = 0;
        for (const [kind, ms] of script) {
            end += ms;
            if (t <= end)
                return kind;
        }
        return script[script.length - 1][0];
    };
    let fast = 0, gate = false, above = 0, below = 0, onsets = 0, level = 0, gridT = 0;
    const ticks = [];
    for (let t = 0; t < total;) {
        const dt = dtFn();
        t += dt;
        let peak = null;
        while (gridT + 10 <= t) {
            gridT += 10;
            const kind = kindAt(gridT);
            level = kind === 'silent' || kind === 'nofeed' ? 0 : clamp((src[kind](gridT) + 48) / 28, 0, 1);
            const before = fast;
            fast += (level - fast) * (1 - Math.exp(-10 / (level > fast ? 25 : 140)));
            if (!gate) {
                above = level >= 0.25 ? above + 10 : 0;
                if (above >= 60) {
                    gate = true;
                    below = 0;
                    onsets++;
                }
            } else {
                below = level < 0.12 ? below + 10 : 0;
                if (below >= 700) {
                    gate = false;
                    above = 0;
                }
            }
            if (fast - before > 0.072)
                onsets++;
            peak = peak === null ? level : Math.max(peak, level);
        }
        const kind = kindAt(t);
        const feed = kind === 'silent' ? 'silent' : kind === 'nofeed' ? 'nofeed' : 'live';
        ticks.push({dt, kind, v: {feed, level, peak: peak ?? level, fast, gate, onsets}});
    }
    return ticks;
}

const fixed = ms => () => ms;
const live = (peak, extra = {}) => ({feed: 'live', level: peak, peak, fast: peak, gate: false, onsets: 0, ...extra});
const silentV = {feed: 'silent', level: 0, peak: 0, fast: 0, gate: false, onsets: 0};
const nofeedV = {feed: 'nofeed', level: 0, peak: 0, fast: 0, gate: false, onsets: 0};

// --- raster, for motion energy: 16 x 16 device pixels, 4 x 4 sub-pixels, source-over --------------
const N = 16;
function coverage(dots) {
    const SS = 4;
    const k = N / TRACE_SIZE;
    const cov = new Float64Array(N * N);
    for (const d of dots) {
        const cx = d.x * k, cy = d.y * k, r = d.r * k, r2 = r * r;
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(N - 1, Math.floor(cy + r)); y++) {
            for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(N - 1, Math.floor(cx + r)); x++) {
                let hit = 0;
                for (let j = 0; j < SS; j++) {
                    for (let i = 0; i < SS; i++) {
                        const sx = x + (i + 0.5) / SS - cx, sy = y + (j + 0.5) / SS - cy;
                        if (sx * sx + sy * sy <= r2)
                            hit++;
                    }
                }
                const a = (hit / (SS * SS)) * d.a;
                cov[y * N + x] = cov[y * N + x] * (1 - a) + a;
            }
        }
    }
    return cov;
}

// Summed |coverage change| over 100 ms (6 frames at 60 Hz), 20 s per kind after the first 3 s.
function motionEnergy(kind) {
    const ticks = simulate([[kind, 23000]], fixed(1000 / 60), 11);
    const trace = createTrace();
    const covs = ticks.map(t => coverage(trace.frame(t.dt, t.v)));
    const lag = 6;
    let sum = 0, n = 0;
    for (let i = 180 + lag; i < covs.length; i++) {
        for (let p = 0; p < covs[i].length; p++)
            sum += Math.abs(covs[i][p] - covs[i - lag][p]);
        n++;
    }
    return sum / n;
}

// --- bounds, over the scripted sequence at two tick rates -----------------------------------------
const SCRIPT = [['burst', 2000], ['silent', 3000], ['speech', 1000], ['nofeed', 3000], ['quiet', 3000]];

const dotsOk = dots => dots.every(d =>
    [d.x, d.y, d.r, d.a].every(Number.isFinite) &&
    d.x >= d.r && d.x <= TRACE_SIZE - d.r && d.y >= d.r && d.y <= TRACE_SIZE - d.r &&
    d.a >= 0.55 && d.a <= 1);

for (const dtMs of [16.7, 6.9]) {
    const ticks = simulate(SCRIPT, fixed(dtMs));
    const trace = createTrace();
    let bad = 0, most = 0;
    for (const t of ticks) {
        const dots = trace.frame(t.dt, t.v);
        most = Math.max(most, dots.length);
        if (!dotsOk(dots) || dots.length === 0 || dots.length > 220)
            bad++;
    }
    check(bad === 0, `bounds at ${dtMs} ms: ${bad} of ${ticks.length} frames out of bounds, empty or over 220 dots`);
    check(most <= 220, `bounds at ${dtMs} ms: at most ${most} dots`);

    // determinism: two fresh instances, same inputs, identical output
    const a = createTrace(), b = createTrace();
    check(ticks.every(t => JSON.stringify(a.frame(t.dt, t.v)) === JSON.stringify(b.frame(t.dt, t.v))),
        `determinism at ${dtMs} ms: two fresh instances differ`);
}

// --- column cadence -----------------------------------------------------------------------------
{
    const trace = createTrace();
    let dots = [];
    for (let i = 0; i < 130; i++)
        dots = trace.frame(10, live(0.5));
    const xs = [...new Set(dots.map(d => d.x.toFixed(2)))].map(Number).sort((p, q) => p - q);
    eq(xs.length, 6, 'column cadence: six visible columns after 1300 ms');
    const want = [1.8, 5.0, 8.2, 11.4, 14.6, 17.8];
    check(xs.length === 6 && xs.every((x, i) => Math.abs(x - want[i]) <= 0.01),
        `column cadence: columns at 1.8, 5.0, ..., 17.8, got ${xs}`);
    check(xs.length === 6 && xs.slice(1).every((x, i) => Math.abs(x - xs[i] - 3.2) <= 0.02),
        'column cadence: 3.2 apart');
    check(Math.abs(Math.max(...dots.map(d => d.x)) - 17.8) <= 0.01, 'column cadence: the newest column is at 17.8');
}

// --- pulse --------------------------------------------------------------------------------------
{
    const warm = () => {
        const trace = createTrace();
        for (let i = 0; i < 130; i++)
            trace.frame(10, live(0.5));
        return trace;
    };
    // centre bead of the newest column: at the right edge, on the middle row (peak 0.5 damps the wave to 0)
    const centre = dots => {
        const right = Math.max(...dots.map(d => d.x));
        return dots.find(d => d.x === right && Math.abs(d.y - 10) < 1e-9);
    };

    const pulsed = warm();
    const grown = centre(pulsed.frame(16.7, live(0.5, {onsets: 1})));
    check(grown && grown.r > 1.3, `pulse: onsets +1 grows the newest centre bead past 1.3, got ${grown && grown.r}`);
    let later;
    for (let i = 0; i < 60; i++)
        later = centre(pulsed.frame(16.7, live(0.5, {onsets: 1})));
    check(later && later.r <= 1.3 + 0.01, `pulse: it decays back, got ${later && later.r}`);

    const calm = warm();
    const plain = centre(calm.frame(16.7, live(0.5)));
    check(plain && plain.r <= 1.3, `pulse: without an onset the bead stays at 1.3 or below, got ${plain && plain.r}`);

    const muted = warm();
    const none = centre(muted.frame(16.7, {...silentV, onsets: 1}));
    check(none && none.r <= 1.3, 'pulse: an onset while muted does not grow the bead');
}

// --- muted --------------------------------------------------------------------------------------
{
    const trace = createTrace();
    for (let i = 0; i < 120; i++)
        trace.frame(16.7, live(i % 12 < 6 ? 0.9 : 0.1, {gate: i % 12 < 6, onsets: Math.floor(i / 12)}));
    const busy = trace.frame(16.7, live(0.9, {gate: true, onsets: 10}));
    check(new Set(busy.map(d => d.y.toFixed(3))).size > 1, 'muted: bars are present before the mute');

    const first = trace.frame(16.7, silentV);
    check(first.length > 0 && first.every(d => d.y === 10), 'muted: the first silent frame is one straight row at y = 10');
    let straight = true, moved = true, prev = first;
    for (let i = 0; i < 180; i++) {
        const f = trace.frame(16.7, silentV);
        if (f.length === 0 || f.some(d => d.y !== 10))
            straight = false;
        if (i > 8 && JSON.stringify(f.map(d => d.x)) === JSON.stringify(prev.map(d => d.x)))
            moved = false;
        prev = f;
    }
    check(straight, 'muted: 3 s of silent frames are all one straight row');
    check(moved, 'muted: the row keeps scrolling, x changes on every frame');

    let bars = -1;
    for (let i = 0; i < 30 && bars < 0; i++) {
        if (trace.frame(16.7, live(0.9, {gate: true, onsets: 11})).some(d => d.y !== 10))
            bars = i;
    }
    check(bars >= 0, 'muted: with sound back, some dot leaves y = 10 within 0.5 s');
}

// --- energy: live silence < nofeed < speech ---------------------------------------------------------
let energy;
{
    energy = {speech: motionEnergy('speech'), quiet: motionEnergy('quiet'), nofeed: motionEnergy('nofeed'), silent: motionEnergy('silent')};
    check(energy.nofeed > energy.quiet && energy.nofeed < energy.speech,
        `nofeed energy: strictly between live silence and speech (${energy.quiet.toFixed(2)} < ${energy.nofeed.toFixed(2)} < ${energy.speech.toFixed(2)})`);
    // The swell at full scale measured 32.0 against speech at 39.0 ("nearly as busy as speech"), which is
    // what the 0.6 factor is for: demand a clear gap below speech.
    check(energy.nofeed <= 0.75 * energy.speech,
        `nofeed energy: at most 75% of speech (${energy.nofeed.toFixed(2)} vs ${energy.speech.toFixed(2)})`);
    check(energy.speech >= 3 * energy.quiet,
        `speech moves at least 3x live silence (${(energy.speech / energy.quiet).toFixed(2)}x)`);
}

// --- still ----------------------------------------------------------------------------------------
{
    const trace = createTrace();
    const straight = trace.still(silentV);
    check(straight.length > 0 && straight.every(d => d.y === 10), 'still: silent is one straight row');
    const bars = trace.still(live(0.9, {gate: true}));
    check(new Set(bars.map(d => d.y.toFixed(3))).size > 1, 'still: live with the gate open shows bars');
    for (const v of [silentV, nofeedV, live(0.2), live(0.9, {gate: true})]) {
        eq(trace.still(v), createTrace().still(v), `still ${v.feed}/${v.gate}: the same input gives the same output`);
        check(dotsOk(trace.still(v)) && trace.still(v).length > 0, `still ${v.feed}/${v.gate}: dots in bounds`);
    }
    // frame() must not leak into still()
    const before = JSON.stringify(trace.still(live(0.9, {gate: true})));
    for (let i = 0; i < 50; i++)
        trace.frame(16.7, live(0.7));
    eq(JSON.stringify(trace.still(live(0.9, {gate: true}))), before, 'still: a running trace does not change it');
}

// --- cost -----------------------------------------------------------------------------------------
let meanMs;
{
    const ticks = simulate([['speech', 4000], ['quiet', 2000], ['silent', 1500], ['nofeed', 2000]], fixed(16.7)).slice(0, 560);
    const trace = createTrace();
    const n = 20000;
    const t0 = GLib.get_monotonic_time();
    for (let i = 0; i < n; i++) {
        const t = ticks[i % ticks.length];
        trace.frame(t.dt, t.v);
    }
    meanMs = (GLib.get_monotonic_time() - t0) / 1000 / n;
    check(meanMs < 0.3, `cost: mean frame() ${meanMs.toFixed(4)} ms over ${n} calls, limit 0.3`);
}

// --- result ---------------------------------------------------------------------------------------

log(`energy per 100 ms: speech ${energy.speech.toFixed(2)}, live silence ${energy.quiet.toFixed(2)}, nofeed ${energy.nofeed.toFixed(2)}, silent ${energy.silent.toFixed(2)}`);
log(`mean frame() cost: ${meanMs.toFixed(4)} ms`);

if (failures.length > 0) {
    printerr(`FAIL (${failures.length} of ${checks} checks):`);
    for (const f of failures)
        printerr(`  - ${f}`);
    System.exit(1);
}
print(`ok: ${checks} checks`);
