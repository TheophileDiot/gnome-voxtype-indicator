// SPDX-License-Identifier: GPL-2.0-or-later
// Trace · Pulse: the recording orb. Pure geometry, no imports, no Shell, no Cairo.
//
// A row of dotted columns scrolls left. Each column holds the peak level of its 130 ms slot as a centre
// bead plus up to three beads above and below; the right edge is "now". createTrace() returns one
// stateful instance per recording: frame(dtMs, v) advances it and returns the dots, still(v) is the
// stateless reduced-motion frame. `v` is the snapshot of VoiceTracker (common.js): feed, level, peak,
// fast, gate, onsets. Dots live in a 20-unit frame, radii are final (no gain).

export const TRACE_SIZE = 20;

const TAU = Math.PI * 2;
const COLUMN_MS = 130;
const SPACING = 3.2;
const NEWEST_X = 17.8;
const MAX_COLUMNS = 8;
const RADIUS = 1.3;
const PITCH = 2.5;
const BEADS = 3;
const PULSE_GAIN = 0.45;
const WAVE_AMP = 1.5;
const WAVE_MS = 2200;
// The autonomous swell of a missing feed, scaled to sit between live silence and speech.
const NOFEED_SCALE = 0.6;
const STILL_BARS = [0.2, 0.55, 0.95, 0.6, 0.85, 0.4];
const STILL_COLUMNS = 6;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function put(out, x, y, r, a) {
    if (r < 0.12)
        return;
    out.push({x: clamp(x, r, TRACE_SIZE - r), y: clamp(y, r, TRACE_SIZE - r), r, a: clamp(a, 0.55, 1)});
}

function column(out, x, age, val, y, pop) {
    const taper = clamp((x - 0.8) / 2.6, 0, 1);
    if (!taper)
        return;
    const a = 0.55 + 0.45 * taper * (1 - 0.3 * clamp(age / 560, 0, 1));
    const r = (RADIUS + pop * PULSE_GAIN) * taper;
    put(out, x, y, r, a);
    for (let j = 1; j <= BEADS; j++) {
        const f = clamp(val * 7.6 / PITCH - (j - 1), 0, 1);
        put(out, x, y - PITCH * j, r * f, a);
        put(out, x, y + PITCH * j, r * f, a);
    }
}

export function createTrace() {
    let clock = 0;
    let flat = 0;
    let pulse = 0;
    let onsets = null;
    const cols = [{age: 0, val: 0, pop: 0}];

    return {
        frame(dtMs, v) {
            // A stalled shell can hand over a huge dt; it must not spawn a burst of columns.
            const dt = clamp(dtMs, 0, 100);
            clock += dt;

            // Muted or dead input: the line goes straight at once but keeps scrolling, so it still shows
            // that the recording runs. The wave fades back in over 200 ms when sound returns.
            if (v.feed === 'silent') {
                flat = 1;
                pulse = 0;
                for (const c of cols) {
                    c.val = 0;
                    c.pop = 0;
                }
            } else {
                flat -= flat * (1 - Math.exp(-dt / 200));
            }

            for (const c of cols)
                c.age += dt;
            let last = cols[cols.length - 1];
            while (last.age >= COLUMN_MS) {
                last = {age: last.age - COLUMN_MS, val: 0, pop: 0};
                cols.push(last);
                if (cols.length > MAX_COLUMNS)
                    cols.shift();
            }

            let sample = v.feed === 'live' ? v.peak : 0;
            if (v.feed === 'nofeed')
                sample = NOFEED_SCALE * (0.3 + 0.28 * Math.sin(clock / 1200 * TAU) + 0.1 * Math.sin(clock / 380 * TAU));
            last.val = Math.max(last.val, sample);

            if (v.feed === 'live' && onsets !== null && v.onsets > onsets)
                pulse = 1;
            onsets = v.onsets;
            pulse *= Math.exp(-dt / COLUMN_MS);
            last.pop = pulse;

            const out = [];
            const wobble = v.feed === 'nofeed' ? 0 : WAVE_AMP * (1 - flat);
            for (const c of cols) {
                const x = NEWEST_X - SPACING * c.age / COLUMN_MS;
                const y = 10 + wobble * (1 - Math.min(1, c.val * 4)) * Math.sin(clock / WAVE_MS * TAU - x * 0.5);
                column(out, x, c.age, c.val, y, c.pop * Math.exp(-c.age / COLUMN_MS));
            }
            return out;
        },

        still(v) {
            const out = [];
            for (let i = 0; i < STILL_COLUMNS; i++) {
                const x = NEWEST_X - SPACING * (STILL_COLUMNS - 1 - i);
                const val = v.feed === 'silent' ? 0 : v.feed === 'nofeed' ? (i % 2 ? 0.5 : 0.3) : v.gate ? STILL_BARS[i % STILL_BARS.length] : 0;
                const wobble = v.feed === 'live' && !v.gate ? WAVE_AMP * Math.sin(1 - x * 0.5) : 0;
                column(out, x, 0, val, 10 + wobble, 0);
            }
            return out;
        },
    };
}
