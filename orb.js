// SPDX-License-Identifier: GPL-2.0-or-later AND MIT
// Geometry of the "composing" thinking orb at the 20 px preset. Shell-free: no St, Clutter or
// Cairo, so it loads under plain `gjs -m` and tests/test-orb.js can check it against upstream's golden values.
// Recording has its own orb in trace.js; nothing here draws it.
//
// Ported from thinking-orbs (src/engine/ribbon.ts, lattice.ts, core.ts, profiles.ts, presets.ts), commit
// de85557ca220332586d070d8788c0e1d6e877a0d, https://github.com/Jakubantalik/thinking-orbs
//
// MIT License
//
// Copyright (c) 2026 Jakub Antalik
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export const ORB_SIZE = 20;
// Upstream's reduced-motion instant, the same for every state.
const STILL_T = 0.6;

// The shipped 20 px composing tuning runs the shared clock 3.12x faster than wall time.
const COMPOSING_SPEED = 3.12;
// With spin 0 only two travelling waves move (angular speeds 1.7 and 1.1), so the frame repeats
// when both complete whole turns: t = 20 pi.
const COMPOSING_PERIOD_T = 20 * Math.PI;

// composing: preset values after upstream's scaling (spec/orbs-golden.json, resolved["composing-20"]).
const LANES = 10;       // round(round(5 * sqrt(0.051)) * bandMul 4.94)
const SEGS = 20;        // round(88 * sqrt(0.051))
const GHOST_N = 8;      // round(150 * 0.051)
const R_BASE = 1.1803;  // 1.1 * size 1.073
const R_DEPTH = 1.8241; // 1.7 * size 1.073
const R_MIN = 0.3;
const CAM_TILT = 0.3;
const BAND_TILT = 0.55;

const R = ORB_SIZE / 2 * 0.78;
const C = ORB_SIZE / 2;
// Dot radii were tuned for a 300 pt frame; upstream shrinks them sub-linearly with size.
const RS = (ORB_SIZE / 300) ** 0.6;

// spin = 0: the projection never turns, so it is built once.
const SIN_TILT = Math.sin(CAM_TILT);
const COS_TILT = Math.cos(CAM_TILT);
function project(x, y, z) {
    return [C + x, C - (y * COS_TILT - z * SIN_TILT), y * SIN_TILT + z * COS_TILT];
}

// Stable directions on a sphere (Fibonacci lattice).
function fibDir(i, n) {
    const y = 1 - 2 * (i + 0.5) / n;
    const rad = Math.sqrt(1 - y * y);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    return [rad * Math.cos(a), y, rad * Math.sin(a)];
}

// The ghost sphere does not move with spin 0, so it is computed once.
const GHOSTS = [];
for (let i = 0; i < GHOST_N; i++) {
    const d = fibDir(i, GHOST_N);
    const [x, y, z] = project(d[0] * R, d[1] * R, d[2] * R);
    const depth = (z / R + 1) / 2;
    GHOSTS.push({x, y, z, r: Math.max(R_MIN, 0.8 * RS), white: 0.78, a: 0.1 + 0.22 * depth});
}

// The band plane at spin 0: u = (1, 0, 0), v = (0, cos ta, sin ta), n = u x v.
const VY = Math.cos(BAND_TILT);
const VZ = Math.sin(BAND_TILT);
const NY = -VZ;
const NZ = VY;

// One instant as final draw instructions, far to near. Dot: {x, y, z, r, white, a} in a 20 x 20 frame;
// `white` is upstream's greyscale ink value and `a` its alpha. The extension has one ink colour, so it draws with
// `a` alone: near dots strong, far dots faint, on dark and light panels alike.
function composingFrame(t) {
    const dots = GHOSTS.map(g => ({...g}));
    for (let w = 0; w < LANES; w++) {
        const laneOff = (w - (LANES - 1) / 2) * 0.075;
        const edge = Math.abs(w - (LANES - 1) / 2) / Math.max(1, (LANES - 1) / 2);
        for (let k = 0; k < SEGS; k++) {
            const a = k / SEGS * 2 * Math.PI;
            const wob = 0.16 * Math.sin(a * 3 - t * 1.7 + w * 0.22) + 0.07 * Math.sin(a * 5 + t * 1.1);
            const off = laneOff + wob;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const x = ca;
            const y = VY * sa + NY * off;
            const z = VZ * sa + NZ * off;
            const l = Math.sqrt(x * x + y * y + z * z);
            const [px, py, zr] = project(x / l * R, y / l * R, z / l * R);
            const depth = (zr / R + 1) / 2;
            dots.push({
                x: px,
                y: py,
                z: zr,
                r: Math.max(R_MIN, (R_BASE + R_DEPTH * depth) * (1 - 0.25 * edge) * RS),
                white: 0.52 - 0.44 * depth + 0.18 * edge,
                a: 0.4 + 0.6 * depth,
            });
        }
    }
    return dots.filter(d => d.a >= 0.02).sort((p, q) => p.z - q.z);
}

// Per orb: frame(t) draws one instant, time(ms) maps elapsed wall time to upstream's clock, stillT is
// the reduced-motion instant and periodMs the loop after which frame(time(ms)) repeats.
const orb = (frame, speed, periodT) => Object.freeze({
    frame,
    time: elapsedMs => elapsedMs / 1000 * speed,
    stillT: STILL_T,
    periodMs: Math.round(periodT / speed * 1000),
});

export const ORBS = Object.freeze({
    composing: orb(composingFrame, COMPOSING_SPEED, COMPOSING_PERIOD_T),
});

// Seed, the idle and offline marks. Dots only, radii final, in the same 20-unit frame; `a` is
// the alpha of the one panel ink. `o` in 0..1 is how far the pointer has opened the Seed (0 at rest, 0.5 on hover or
// focus, 1 with the menu open); at o = 0 they are the frozen SEED_IDLE and SEED_OFFLINE below. The caller tweens `o`
// and repaints only the button's orb, so there is still no clock here.
const open = o => Math.max(0, Math.min(1, o));

const seed = dots => Object.freeze(dots.map(d => Object.freeze(d)));

// 19 hex-packed beads; p and q run -2..2 and |p + q| <= 2. The alpha falls off with the distance to the rim.
export function seedIdle(o) {
    o = open(o);
    const step = 2.7 + 0.2 * o;
    const radius = 1.2 + 0.12 * o;
    const slope = 0.38 - 0.18 * o;
    const dots = [];
    for (let q = -2; q <= 2; q++) {
        for (let p = -2; p <= 2; p++) {
            if (Math.abs(p + q) > 2)
                continue;
            const x = C + step * (p + q / 2);
            const y = C + step * q * Math.sqrt(3) / 2;
            const d = Math.hypot(x - C, y - C) / (2 * step);
            dots.push({x, y, r: radius, a: 1 - slope * d});
        }
    }
    return seed(dots);
}

// 10 beads on a ring of radius 6.2; positions 1 and 2 of 12 are left out, a gap at the top right.
export function seedOffline(o) {
    o = open(o);
    const dots = [];
    for (let i = 0; i < 12; i++) {
        if (i === 1 || i === 2)
            continue;
        const angle = i / 12 * 2 * Math.PI - Math.PI / 2;
        dots.push({x: C + 6.2 * Math.cos(angle), y: C + 6.2 * Math.sin(angle), r: 1.25 + 0.13 * o, a: 0.85 + 0.15 * o});
    }
    return seed(dots);
}

export const SEED_IDLE = seedIdle(0);
export const SEED_OFFLINE = seedOffline(0);
