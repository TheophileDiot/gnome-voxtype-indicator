// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the Shell-free helpers in common.js.
// Run from the repository root: gjs -m tests/test-common.js

import System from 'system';

import * as common from '../common.js';
import {
    FRAME_BYTES, MODE_IDLE, MODE_OFFLINE, MODE_RECORDING, MODE_TRANSCRIBING, STOPPED, VIEW_IDLE, VIEW_KEEP,
    VIEW_IDLE_INFERRED, VIEW_OFFLINE, VIEW_RECORDING, VIEW_TRANSCRIBING, VIEW_UNKNOWN, SHORTCUT_ROOT,
    VoiceTracker, buttonShown, cancelFilePath, capsFor, decodeFrames, displayFor, isBusy, isVoxtypeComm, lockFilePath,
    menuFor, parsePid, parseState, pickShortcutPath, receiptAllowed, receiptFor, shortcutBindings, stateFilePath,
    UnredirectHold, unitEffect, viewFor, voxtypeVerbOf,
} from '../common.js';

const failures = [];
let checks = 0;

function eq(actual, expected, label) {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        failures.push(`${label}: expected ${e}, got ${a}`);
}

// --- state -> view: one assertion per row of the table ---------------------

const view = text => viewFor(parseState(text));

eq(view('recording'), VIEW_RECORDING, 'recording');
eq(view('streaming'), VIEW_RECORDING, 'streaming maps to the recording view');
eq(view('transcribing'), VIEW_TRANSCRIBING, 'transcribing');
eq(view('idle'), VIEW_IDLE, 'idle');
eq(view('idle').mode, 'idle', 'idle view is the idle mode');
eq(viewFor(STOPPED), VIEW_OFFLINE, 'missing file / dead daemon (stopped) is offline');
eq(view('stopped'), VIEW_OFFLINE, 'the word stopped is offline');
eq(VIEW_OFFLINE.mode, 'offline', 'offline view is the offline mode');
eq('MODE_HIDDEN' in common, false, 'MODE_HIDDEN is gone');
eq('VIEW_HIDDEN' in common, false, 'VIEW_HIDDEN is gone');
eq(view(''), VIEW_KEEP, 'empty read keeps the current view');
eq(view('   \n'), VIEW_KEEP, 'whitespace-only read keeps the current view');
eq(view('shiny-new-state'), VIEW_UNKNOWN, 'unknown value');
eq(VIEW_UNKNOWN.mode, 'idle', 'unknown value shows the idle orb');
eq(VIEW_UNKNOWN, {...VIEW_IDLE, known: false}, 'unknown value is the idle view with known: false');
eq(VIEW_UNKNOWN.known, false, 'unknown value is flagged so it is logged once');
eq(view('Recording'), VIEW_UNKNOWN, 'state words are case-sensitive');

eq(view('recording\n'), VIEW_RECORDING, 'trailing newline');
eq(view('  transcribing \r\n'), VIEW_TRANSCRIBING, 'surrounding whitespace');

eq(VIEW_RECORDING.label, 'Listening…', 'recording pill text');
eq(VIEW_RECORDING.name, 'Voxtype: listening', 'recording accessible name');
eq(VIEW_TRANSCRIBING.label, 'Transcribing…', 'transcribing pill text');
eq(VIEW_TRANSCRIBING.name, 'Voxtype: transcribing', 'transcribing accessible name');
eq(VIEW_IDLE, {mode: 'idle', label: '', name: 'Voxtype: idle', known: true}, 'idle view');
eq(VIEW_OFFLINE, {mode: 'offline', label: '', name: 'Voxtype: not running', known: true}, 'offline view');
eq([Object.isFrozen(VIEW_IDLE), Object.isFrozen(VIEW_OFFLINE), Object.isFrozen(VIEW_UNKNOWN)], [true, true, true],
    'idle, offline and unknown views are frozen');

// Non-text input never throws and never invents a state
eq(parseState(null), '', 'parseState(null)');
eq(parseState(undefined), '', 'parseState(undefined)');
eq(viewFor(undefined), VIEW_UNKNOWN, 'viewFor(undefined)');

// --- parsePid ---------------------------------------------------------------------

eq(parsePid('1234'), 1234, 'pid: plain');
eq(parsePid('1234\n'), 1234, 'pid: trailing newline');
eq(parsePid('  42  '), 42, 'pid: surrounding whitespace');
eq(parsePid(''), null, 'pid: empty');
eq(parsePid('abc'), null, 'pid: garbage');
eq(parsePid('12abc'), null, 'pid: trailing garbage');
eq(parsePid('1 2'), null, 'pid: two numbers');
eq(parsePid('0'), null, 'pid: zero');
eq(parsePid('-5'), null, 'pid: negative');
eq(parsePid('1.5'), null, 'pid: fraction');
eq(parsePid('99999999999999999999'), null, 'pid: not a safe integer');
eq(parsePid(null), null, 'pid: null');
eq(parsePid(undefined), null, 'pid: undefined');

// --- isVoxtypeComm ----------------------------------------------------------------

eq(isVoxtypeComm('voxtype\n'), true, 'comm: voxtype');
eq(isVoxtypeComm('voxtype-onnx\n'), true, 'comm: voxtype variant');
eq(isVoxtypeComm('firefox\n'), false, 'comm: other program');
eq(isVoxtypeComm('a-voxtype\n'), false, 'comm: must start with voxtype');
eq(isVoxtypeComm(''), false, 'comm: empty');
eq(isVoxtypeComm(null), false, 'comm: null');

// --- paths ---------------------------------------------------------------------------

eq(stateFilePath().endsWith('/voxtype/state'), true, 'state path');
eq(lockFilePath().endsWith('/voxtype/voxtype.lock'), true, 'lock path');
eq(stateFilePath('/x/rt'), '/x/rt/voxtype/state', 'state path under a given runtime dir');
eq(lockFilePath('/x/rt'), '/x/rt/voxtype/voxtype.lock', 'lock path under a given runtime dir');

// --- level frames ---------------------------------------------------------------------------

const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function frameBytes(seq, peak) {
    const bytes = new Uint8Array(FRAME_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, seq, LE);
    view.setFloat32(4, -60, LE);
    view.setFloat32(8, -20, LE);
    view.setFloat32(12, peak, LE);
    return bytes;
}

const join = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};

{
    const frame = frameBytes(7, -33.5);
    const first = decodeFrames(new Uint8Array(0), frame.slice(0, 5));
    eq(first.frames, [], 'decode: 5 bytes make no frame');
    eq(first.carry.length, 5, 'decode: 5 bytes are carried');
    const second = decodeFrames(first.carry, frame.slice(5));
    eq(second.frames, [{seq: 7, db: -33.5, valid: true}], 'decode: 5 + 11 bytes make one frame');
    eq(second.carry.length, 0, 'decode: nothing carried after a whole frame');

    const three = decodeFrames(new Uint8Array(0),
        join(frameBytes(1, -10), frameBytes(2, -20.5), frameBytes(3, -30)));
    eq(three.frames.map(f => f.seq), [1, 2, 3], 'decode: three frames in one chunk, in order');
    eq(three.frames.map(f => f.db), [-10, -20.5, -30], 'decode: peak_dbfs is read, not min or max');

    const tail = decodeFrames(new Uint8Array(0), join(frameBytes(1, -10), frameBytes(2, -10).slice(0, 4)));
    eq([tail.frames.length, tail.carry.length], [1, 4], 'decode: a partial frame is carried, 0 to 15 bytes');
    const empty = decodeFrames(new Uint8Array(0), new Uint8Array(0));
    eq([empty.frames.length, empty.carry.length], [0, 0], 'decode: an empty chunk');

    const odd = decodeFrames(new Uint8Array(0), join(
        frameBytes(1, NaN), frameBytes(2, Infinity), frameBytes(3, 3), frameBytes(4, -Infinity),
        frameBytes(5, 0)));
    eq(odd.frames.map(f => f.valid), [false, false, false, true, true], 'decode: NaN, +Inf and +3 are invalid');
    eq(odd.frames[3].db, -120, 'decode: -Infinity is a clean mute, db -120');
    eq(odd.frames[4].db, 0, 'decode: 0 dBFS is valid');
}

// --- voice tracker ----------------------------------------------------------------------------

// A tracker on a 10 ms frame grid. `frames()` pushes `count` frames of `db` and advances the clock
// by 10 ms each; `batch` frames go into one pushFrames call, so frame times do not depend on it.
function sim() {
    const tr = new VoiceTracker();
    tr.reset(0);
    tr.setConnected(true);
    return {tr, us: 0, seq: 0};
}

function frames(s, db, count, batch = 1) {
    let left = count;
    while (left > 0) {
        const n = Math.min(batch, left);
        const list = [];
        for (let i = 0; i < n; i++)
            list.push({seq: s.seq++, db});
        s.us += n * 10000;
        s.tr.pushFrames(list, s.us);
        left -= n;
    }
}

const snap = s => s.tr.snapshot(s.us);

// dBFS for a given level, the inverse of clamp((db + 48) / 28, 0, 1).
const dbOf = level => level * 28 - 48;

// Followers: 5 ms frame spacing, so 25 ms and 140 ms are whole numbers of frames.
{
    const fine = (s, db, count) => {
        for (let i = 0; i < count; i++) {
            s.us += 5000;
            s.tr.pushFrames([{seq: s.seq++, db}], s.us);
        }
    };
    const s = sim();
    fine(s, -60, 100);
    fine(s, -20, 5);
    const up = snap(s).fast;
    eq(Math.abs(up - 0.632) <= 0.03, true, `fast: attack reaches 63% in 25 ms (got ${up})`);

    const t = sim();
    fine(t, -20, 400);
    eq(snap(t).fast > 0.999, true, 'fast: settles on a held level');
    fine(t, -60, 28);
    const down = snap(t).fast;
    eq(Math.abs(down - 0.368) <= 0.03, true, `fast: release falls to 37% in 140 ms (got ${down})`);

    // slow follows fast: for a unit step the continuous answer at 120 ms is 0.537.
    const u = sim();
    fine(u, -60, 100);
    fine(u, -20, 24);
    const slow = snap(u).slow;
    eq(Math.abs(slow - 0.537) <= 0.03, true, `slow: attack follows fast at 120 ms (got ${slow})`);
    const v = sim();
    fine(v, -20, 2000);
    fine(v, -60, 80);
    const slowDown = snap(v);
    eq(slowDown.slow > slowDown.fast, true, 'slow: release lags fast');
    // continuous answer at 400 ms: (400 e^-1 - 140 e^-2.86) / 260 = 0.535
    eq(Math.abs(slowDown.slow - 0.535) <= 0.03, true, `slow: release follows fast at 400 ms (got ${slowDown.slow})`);
}

// Same frames, two refresh rates: followers, gate and onsets are per frame, so the snapshot rate is moot.
{
    const level = ms => (ms < 200 ? -70 : ms < 400 ? -20 : ms < 600 ? -70 : -30);
    const run = tickUs => {
        const tr = new VoiceTracker();
        tr.reset(0);
        tr.setConnected(true);
        let seq = 0;
        let next = 1; // generated frame k is due at k * 10 ms
        let last = null;
        for (let t = tickUs; t <= 1000000; t += tickUs) {
            const list = [];
            while (next * 10000 <= t)
                list.push({seq: seq++, db: level((next++ - 1) * 10)});
            tr.pushFrames(list, t);
            last = tr.snapshot(t);
        }
        return last;
    };
    const slowTick = run(16700);
    const fastTick = run(6900);
    const near = (a, b) => Math.abs(a - b) <= 0.01 * Math.max(Math.abs(a), Math.abs(b));
    eq(near(slowTick.fast, fastTick.fast), true, `rates: fast ${slowTick.fast} vs ${fastTick.fast}`);
    eq(near(slowTick.slow, fastTick.slow), true, `rates: slow ${slowTick.slow} vs ${fastTick.slow}`);
    eq(slowTick.onsets, fastTick.onsets, 'rates: onsets');
    eq(slowTick.onsets >= 2, true, 'rates: the signal does produce onsets');
}

// Batching: the frame i of n is timed 10 ms apart, so 4 frames advance the clock by 30 ms.
{
    const s = sim();
    frames(s, dbOf(0.3), 4, 4);
    frames(s, dbOf(0.3), 3, 3);
    eq(snap(s).gate, true, 'batching: 4 + 3 frames in 2 pushes open a 60 ms gate (7 frames, not 7 pushes)');
    const t = sim();
    frames(t, dbOf(0.3), 4, 4);
    frames(t, dbOf(0.3), 2, 2);
    eq(snap(t).gate, false, 'batching: 4 + 2 frames are 50 ms');
    const u = sim();
    frames(u, dbOf(0.3), 7, 7);
    eq(snap(u).gate, true, 'batching: 7 frames in one push open the gate');
    const v = sim();
    frames(v, -70, 10, 5);
    eq(snap(v).feedSeenMs, 100, 'batching: ten frames are 100 ms of feed, however pushed');
}

// Gate
{
    const s = sim();
    frames(s, dbOf(0.3), 6);
    eq(snap(s).gate, false, 'gate: 50 ms at level 0.3 is not open');
    frames(s, dbOf(0.3), 1);
    eq([snap(s).gate, snap(s).heard], [true, true], 'gate: 60 ms at level 0.3 opens it, and heard is set');
    frames(s, dbOf(0.1), 61);
    eq(snap(s).gate, true, 'gate: stays open through 600 ms at level 0.1');
    frames(s, dbOf(0.1), 9);
    eq(snap(s).gate, true, 'gate: still open at 690 ms');
    frames(s, dbOf(0.1), 1);
    eq(snap(s).gate, false, 'gate: closes at 700 ms');
    eq(snap(s).heard, true, 'gate: heard stays set after the gate closes');

    const h = sim();
    frames(h, dbOf(0.2), 300);
    eq(snap(h).gate, false, 'hysteresis: level 0.2 never opens the gate');
    frames(h, dbOf(0.3), 7);
    frames(h, dbOf(0.2), 300);
    eq(snap(h).gate, true, 'hysteresis: level 0.2 never closes an open gate');

    const r = sim();
    frames(r, dbOf(0.3), 4);
    frames(r, dbOf(0.2), 1);
    frames(r, dbOf(0.3), 4);
    eq(snap(r).gate, false, 'gate: a dip into the dead band restarts the opening hold');
    frames(r, dbOf(0.3), 3);
    eq(snap(r).gate, true, 'gate: the restarted hold opens 60 ms later');

    const c = sim();
    frames(c, dbOf(0.3), 7);
    frames(c, dbOf(0.1), 50);
    frames(c, dbOf(0.15), 1);
    frames(c, dbOf(0.1), 50);
    eq(snap(c).gate, true, 'gate: a frame at 0.15 restarts the closing hold');
}

// Onsets
{
    const q = sim();
    frames(q, -70, 100);
    eq(snap(q).onsets, 0, 'onsets: none in silence');

    const ramp = sim();
    for (let i = 0; i < 80; i++)
        frames(ramp, dbOf(Math.min(0.6, i * 0.01)), 1);
    eq(snap(ramp).onsets, 1, 'onsets: a slow ramp gives only the gate opening');

    const step = sim();
    frames(step, -70, 20);
    frames(step, -20, 3);
    eq(snap(step).onsets, 3, 'onsets: each of the first frames of a step rises more than 0.072');
    frames(step, -20, 4);
    eq(snap(step).onsets, 5, 'onsets: 4 rises, then the gate opening');
}

// Silent feed
{
    const s = sim();
    frames(s, -120, 30);
    eq(snap(s).feed, 'live', 'silent: 290 ms of -120 is still live');
    frames(s, -120, 1);
    eq(snap(s).feed, 'silent', 'silent: 300 ms of -120 is silent');
    frames(s, -119, 1);
    eq(snap(s).feed, 'live', 'silent: one -119 frame ends it');

    const t = sim();
    frames(t, -120, 20);
    frames(t, -119, 1);
    frames(t, -120, 20);
    eq(snap(t).feed, 'live', 'silent: a -119 frame in the middle restarts the run');

    const u = sim();
    frames(u, -121, 41);
    eq(snap(u).feed, 'live', 'silent: 400 ms of a finite -121 is live, never silent');

    const v = sim();
    const muted = decodeFrames(new Uint8Array(0), join(...Array.from({length: 31}, (_, i) => frameBytes(i, -Infinity))));
    v.tr.pushFrames(muted.frames, 310000);
    eq(v.tr.snapshot(310000).feed, 'silent', 'silent: -Infinity frames, decoded to -120, are a mute');
}

// no-signal
{
    const s = sim();
    frames(s, -120, 200);
    eq([snap(s).feed, snap(s).hint], ['silent', 'listening'], 'no-signal: 1990 ms of silence');
    frames(s, -120, 1);
    eq(snap(s).hint, 'no-signal', 'no-signal: 2000 ms of silence');
    frames(s, -50, 1);
    eq([snap(s).feed, snap(s).hint], ['live', 'listening'], 'no-signal: cleared by the first frame above -120');

    const h = sim();
    frames(h, dbOf(0.5), 10);
    eq(snap(h).heard, true, 'no-signal (heard): speech first');
    frames(h, -120, 201);
    eq(snap(h).hint, 'listening', 'no-signal (heard): 2 s of silence is not enough');
    frames(h, -120, 299);
    eq(snap(h).hint, 'listening', 'no-signal (heard): 4990 ms');
    frames(h, -120, 1);
    eq(snap(h).hint, 'no-signal', 'no-signal (heard): 5000 ms');
}

// cant-hear
{
    const s = sim();
    frames(s, -70, 600);
    eq(snap(s).hint, 'listening', 'cant-hear: 5990 ms of live -70 dBFS');
    frames(s, -70, 1);
    eq(snap(s).hint, 'cant-hear', 'cant-hear: 6000 ms of live -70 dBFS');
    frames(s, dbOf(0.3), 7);
    eq([snap(s).hint, snap(s).heard], ['listening', true], 'cant-hear: cleared by the first gate opening');
    frames(s, -70, 1000);
    eq(snap(s).hint, 'listening', 'cant-hear: never again once heard');

    const m = sim();
    frames(m, -120, 600);
    frames(m, -70, 1);
    eq(snap(m).hint, 'listening', 'cant-hear: silent time is not live time');
}

// nofeed
{
    const tr = new VoiceTracker();
    tr.reset(0);
    tr.pushFrames([{seq: 0, db: -30}], 10000);
    eq([tr.snapshot(10000).feed, tr.snapshot(10000).hint], ['nofeed', 'listening'], 'nofeed: not connected');
    eq(tr.snapshot(0).feedSeenMs >= 0, true, 'nofeed: snapshot still works');

    const fresh = new VoiceTracker();
    fresh.reset(5000000);
    fresh.setConnected(true);
    eq(fresh.snapshot(5100000).feed, 'nofeed', 'nofeed: connected but no frame yet');

    const s = sim();
    frames(s, -70, 700);
    eq(snap(s).hint, 'cant-hear', 'nofeed: setup, the hint is up');
    eq(s.tr.snapshot(s.us + 400000).feed, 'live', 'nofeed: 400 ms after the last frame is still live');
    eq(s.tr.snapshot(s.us + 401000).feed, 'nofeed', 'nofeed: 401 ms after the last frame');
    eq(s.tr.snapshot(s.us + 401000).hint, 'listening', 'nofeed: claims nothing');

    const d = sim();
    frames(d, -70, 100);
    d.tr.setConnected(false);
    eq([snap(d).feed, snap(d).hint], ['nofeed', 'listening'], 'nofeed: connection lost');
    d.tr.setConnected(true);
    d.seq = 0;
    frames(d, -70, 5);
    eq(snap(d).feed, 'live', 'nofeed: frames restarting at seq 0 are live again');
    eq(snap(d).feedSeenMs, 1050, 'nofeed: feedSeenMs keeps counting across the reconnect');
}

// seq
{
    const s = sim();
    frames(s, dbOf(0.3), 4);
    s.seq += 5; // frames lost
    frames(s, dbOf(0.3), 4);
    eq(snap(s).gate, false, 'seq gap: 8 frames, but the gap restarted the hold');
    frames(s, dbOf(0.3), 3);
    eq(snap(s).gate, true, 'seq gap: the restarted hold opens 60 ms after the gap');

    const w = sim();
    w.seq = 0xFFFFFFF0;
    frames(w, dbOf(0.3), 7 + 0x10);
    eq(snap(w).gate, true, 'seq wrap: u32 wrap-around is contiguous');

    const d = sim();
    frames(d, dbOf(0.3), 4);
    d.seq -= 1; // the same seq twice
    frames(d, dbOf(0.3), 4);
    eq(snap(d).gate, false, 'seq repeat: a repeated seq is a gap');

    const r = sim();
    frames(r, -70, 501); // 5 s of quiet live
    r.seq = 0;
    frames(r, -70, 150);
    eq(snap(r).hint, 'listening', 'seq restart: 1.5 s after the restart, no hint');
    frames(r, -70, 450);
    eq(snap(r).hint, 'listening', 'seq restart: 5990 ms after the restart, no hint');
    frames(r, -70, 1);
    eq(snap(r).hint, 'cant-hear', 'seq restart: cant-hear 6 s after the restart');

    const z = sim();
    frames(z, -120, 150);
    z.seq = 0;
    frames(z, -120, 20);
    eq(snap(z).feed, 'live', 'seq restart: the silent run restarts too');
}

// A connected socket that pauses with no EOF and resumes with the next seq: the gap is a restart too.
{
    const gapUs = 2490000; // plus the 10 ms the next frame advances: 2.5 s between the two frames

    const m = sim();
    frames(m, -120, 1);
    m.us += gapUs;
    frames(m, -120, 1);
    eq([snap(m).feed, snap(m).hint], ['live', 'listening'],
        'stale gap: two -120 frames 2.5 s apart are not a 2.5 s mute');

    const v = sim();
    frames(v, dbOf(0.3), 1);
    v.us += 500000;
    frames(v, dbOf(0.3), 1);
    eq([snap(v).gate, snap(v).heard], [false, false],
        'stale gap: two voiced frames 510 ms apart do not hold the gate open');

    const edge = sim();
    frames(edge, -120, 1);
    edge.us += 390000; // 400 ms between the frames: not stale yet
    frames(edge, -120, 1);
    eq(snap(edge).feed, 'silent', 'stale gap: 400 ms between frames is still one run');
    const over = sim();
    frames(over, -120, 1);
    over.us += 391000;
    frames(over, -120, 1);
    eq(snap(over).feed, 'live', 'stale gap: 401 ms between frames restarts the run');

    const c = sim();
    frames(c, -70, 100);
    c.us += gapUs;
    frames(c, -70, 550);
    eq(snap(c).hint, 'listening', 'stale gap: the cant-hear clock restarts after the pause');
    frames(c, -70, 51);
    eq(snap(c).hint, 'cant-hear', 'stale gap: cant-hear 6 s after the pause');

    const r = sim();
    frames(r, dbOf(0.5), 10);
    frames(r, -70, 90);
    r.us += gapUs;
    frames(r, -70, 100);
    const after = snap(r);
    eq([after.heard, after.feedSeenMs], [true, 2000],
        'stale gap: heard and the 2 s of feed survive for the receipt, the gap itself is not feed');
}

// peak and fields
{
    const s = sim();
    frames(s, dbOf(0.2), 1);
    frames(s, dbOf(0.8), 1);
    frames(s, dbOf(0.4), 1);
    eq(Math.abs(snap(s).peak - 0.8) < 1e-9, true, 'peak: the max since the previous snapshot');
    frames(s, dbOf(0.3), 1);
    eq(Math.abs(snap(s).peak - 0.3) < 1e-9, true, 'peak: reset to the next frame\'s level');
    eq(Math.abs(snap(s).peak - 0.3) < 1e-9, true, 'peak: with no new frame, the current level');
    eq(Math.abs(snap(s).level - 0.3) < 1e-9, true, 'level: clamp((db + 48) / 28)');
    frames(s, 5 - 5, 1);
    eq(snap(s).level, 1, 'level: 0 dBFS is 1');
    frames(s, -90, 1);
    eq(snap(s).level, 0, 'level: clamped at 0');

    const f = sim();
    frames(f, -70, 100);
    frames(f, -120, 100);
    const snapNow = snap(f);
    eq(snapNow.feedSeenMs, 2000, 'feedSeenMs: live and silent frames both count');
    eq(Object.keys(snapNow), ['feed', 'db', 'level', 'peak', 'fast', 'slow', 'gate', 'heard', 'onsets',
        'feedSeenMs', 'msSinceStart', 'hint'], 'snapshot fields');

    const r = new VoiceTracker();
    r.reset(1000000);
    r.setConnected(true);
    r.pushFrames([{seq: 0, db: dbOf(0.5)}], 1010000);
    eq(r.snapshot(3000000).msSinceStart, 2000, 'msSinceStart counts from reset');
    r.reset(9000000);
    const again = r.snapshot(9000000);
    eq([again.feed, again.heard, again.onsets, again.feedSeenMs, again.msSinceStart, again.gate],
        ['nofeed', false, 0, 0, 0, false], 'reset: a new recording starts clean');
}

// Receipt
eq(receiptFor({heard: false, feedSeenMs: 0}), 'done', 'receipt: no feed is done');
eq(receiptFor({heard: false, feedSeenMs: 1999}), 'done', 'receipt: 1999 ms of feed is done');
eq(receiptFor({heard: false, feedSeenMs: 2000}), 'nothing-heard', 'receipt: 2000 ms of feed, nothing heard');
eq(receiptFor({heard: true, feedSeenMs: 9000}), 'done', 'receipt: heard is done');
eq(receiptFor({heard: true, feedSeenMs: 0}), 'done', 'receipt: heard, no feed is done');

eq(receiptFor({heard: true, feedSeenMs: 9000, cancelled: true}), null, 'receipt: cancelled after speech is none');
eq(receiptFor({heard: false, feedSeenMs: 9000, cancelled: true}), null, 'receipt: cancelled with nothing heard is none');
eq(receiptFor({heard: false, feedSeenMs: 0, cancelled: false}), 'done', 'receipt: cancelled false changes nothing');

// A receipt needs the state file itself to say `idle` right after `transcribing`
eq(receiptAllowed(MODE_TRANSCRIBING, VIEW_IDLE), true, 'receiptAllowed: transcribing then a read idle');
eq(receiptAllowed(MODE_TRANSCRIBING, VIEW_UNKNOWN), false, 'receiptAllowed: an unknown word is no receipt');
eq(receiptAllowed(MODE_TRANSCRIBING, VIEW_IDLE_INFERRED), false, 'receiptAllowed: an inferred idle is no receipt');
eq(receiptAllowed(MODE_TRANSCRIBING, VIEW_OFFLINE), false, 'receiptAllowed: offline is no receipt');
eq(receiptAllowed(MODE_RECORDING, VIEW_IDLE), false, 'receiptAllowed: recording then idle is no receipt');
eq(receiptAllowed(MODE_IDLE, VIEW_IDLE), false, 'receiptAllowed: idle then idle is no receipt');
eq(receiptAllowed(null, VIEW_IDLE), false, 'receiptAllowed: the first view is no receipt');
eq(VIEW_IDLE_INFERRED.mode, MODE_IDLE, 'the inferred idle is the idle mode');
eq(VIEW_IDLE_INFERRED.known, true, 'the inferred idle is a known view');
eq(Object.isFrozen(VIEW_IDLE_INFERRED), true, 'the inferred idle is frozen');

// --- busy modes, cancel path ---------------------------------------------------------------

eq([MODE_RECORDING, MODE_TRANSCRIBING, MODE_IDLE, MODE_OFFLINE].map(isBusy), [true, true, false, false], 'isBusy');
eq(isBusy('keep'), false, 'isBusy: keep is not busy');
eq(cancelFilePath('/run/user/1000'), '/run/user/1000/voxtype/cancel', 'cancel trigger file path');

// --- menuFor: every row of the menu table ----------------------------------------------

const START = {label: 'Start dictation', verb: 'start'};
const STOP = {label: 'Stop and transcribe', verb: 'stop'};
const CANCEL = {label: 'Cancel', verb: 'cancel'};
const SYSTEMCTL = 'systemctl --user start voxtype';

eq(menuFor(VIEW_IDLE, {controls: true}), {header: 'Voxtype: idle', subtitle: null, actions: [START]}, 'menu: idle');
eq(menuFor(VIEW_IDLE, {controls: false}), {header: 'Voxtype: idle', subtitle: null, actions: []}, 'menu: idle, controls off');
eq(menuFor(VIEW_UNKNOWN, {controls: true}), {header: 'Voxtype: idle', subtitle: null, actions: [START]}, 'menu: unknown value is idle');
eq(menuFor(VIEW_RECORDING, {controls: true}),
    {header: 'Voxtype: listening', subtitle: null, actions: [STOP, CANCEL]}, 'menu: recording');
eq(menuFor(VIEW_RECORDING, {controls: true, hint: 'listening'}).header, 'Voxtype: listening', 'menu: hint listening');
eq(menuFor(VIEW_RECORDING, {controls: true, hint: 'cant-hear'}).header,
    "Voxtype: listening · can't hear you", 'menu: recording, cant-hear hint');
eq(menuFor(VIEW_RECORDING, {controls: true, hint: 'no-signal'}).header,
    'Voxtype: listening · no signal', 'menu: recording, no-signal hint');
eq(menuFor(VIEW_RECORDING, {controls: false, hint: 'no-signal'}),
    {header: 'Voxtype: listening · no signal', subtitle: null, actions: []}, 'menu: recording, controls off');
eq(menuFor(VIEW_RECORDING, {controls: true, hint: 'bogus'}).header, 'Voxtype: listening', 'menu: unknown hint adds nothing');
eq(menuFor(VIEW_TRANSCRIBING, {controls: true}),
    {header: 'Voxtype: transcribing', subtitle: null, actions: [CANCEL]}, 'menu: transcribing');
eq(menuFor(VIEW_TRANSCRIBING, {controls: false}),
    {header: 'Voxtype: transcribing', subtitle: null, actions: []}, 'menu: transcribing, controls off');
eq(menuFor(VIEW_TRANSCRIBING, {controls: true, hint: 'cant-hear'}).header, 'Voxtype: transcribing',
    'menu: a hint only belongs to recording');
for (const controls of [true, false]) {
    eq(menuFor(VIEW_OFFLINE, {controls}),
        {header: 'Voxtype is not running', subtitle: SYSTEMCTL, actions: []}, `menu: offline, controls ${controls}`);
}

// --- unitEffect: systemd ActiveState -> what the source does --------------------------------

eq(['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating'].map(unitEffect),
    ['read', 'none', 'offline', 'offline', 'offline', 'offline'], 'unitEffect: the six named states');
eq(['maintenance', 'weird', '', undefined, null, 'ACTIVE'].map(unitEffect), ['none', 'none', 'none', 'none', 'none', 'none'],
    'unitEffect: anything else is none');

// --- displayFor, buttonShown ------------------------------------------------------------------

eq(displayFor({panelOrb: 'never', showPill: false}), {panelOrb: 'never', showPill: true},
    'display: never with the pill off shows the pill');
eq(displayFor({panelOrb: 'never', showPill: true}), {panelOrb: 'never', showPill: true}, 'display: never, pill on');
eq(displayFor({panelOrb: 'busy', showPill: false}), {panelOrb: 'busy', showPill: false}, 'display: busy, pill off passes through');
eq(displayFor({panelOrb: 'always', showPill: false}), {panelOrb: 'always', showPill: false}, 'display: always, pill off passes through');
eq(displayFor({panelOrb: 'always', showPill: true}), {panelOrb: 'always', showPill: true}, 'display: always, pill on passes through');
eq(displayFor({panelOrb: 'bogus', showPill: true}), {panelOrb: 'always', showPill: true}, 'display: a bogus panel-orb becomes always');
eq(displayFor({panelOrb: 'bogus', showPill: false}), {panelOrb: 'always', showPill: false},
    'display: a bogus panel-orb becomes always, and the pill setting stays');
eq(displayFor({panelOrb: undefined, showPill: true}).panelOrb, 'always', 'display: no panel-orb becomes always');

const MODES = [MODE_RECORDING, MODE_TRANSCRIBING, MODE_IDLE, MODE_OFFLINE];
eq(MODES.map(m => buttonShown('always', m)), [true, true, true, true], 'button: always');
eq(MODES.map(m => buttonShown('busy', m)), [true, true, false, false], 'button: busy only');
eq(MODES.map(m => buttonShown('never', m)), [false, false, false, false], 'button: never');
eq(buttonShown('bogus', MODE_IDLE), true, 'button: an unknown setting acts as always');

// --- key caps and the shortcut matcher ----------------------------

eq(capsFor('<Alt>space'), ['Alt', 'Space'], 'caps: <Alt>space');
eq(capsFor('<Shift><Alt>space'), ['Alt', 'Shift', 'Space'], 'caps: <Shift><Alt>space is ordered Alt, Shift, key');
eq(capsFor('<Primary><Shift>F12'), ['Ctrl', 'Shift', 'F12'], 'caps: <Primary><Shift>F12');
eq(capsFor('<Super>a'), ['Super', 'A'], 'caps: <Super>a');
eq(capsFor('<Control>x'), ['Ctrl', 'X'], 'caps: Control shows as Ctrl');
eq(capsFor('<Primary>x'), ['Ctrl', 'X'], 'caps: Primary shows as Ctrl');
eq(capsFor('<Shift><Alt><Control><Super>Return'), ['Super', 'Ctrl', 'Alt', 'Shift', 'Return'],
    'caps: all four modifiers are ordered Super, Ctrl, Alt, Shift');
eq(capsFor('<alt>space'), ['Alt', 'Space'], 'caps: modifier names are case-insensitive');
eq(capsFor('<Alt><Alt>space'), ['Alt', 'Space'], 'caps: a repeated modifier shows once');
eq(capsFor(''), null, 'caps: empty binding');
eq(capsFor('garbage<'), null, 'caps: garbage<');
eq(capsFor('<Alt>'), null, 'caps: a modifier with no key');
eq(capsFor('<Foo>a'), null, 'caps: an unknown modifier');
eq(capsFor('<Alt>two words'), null, 'caps: a key with a space');
eq(capsFor(undefined), null, 'caps: undefined');
eq(capsFor(null), null, 'caps: null');

eq(voxtypeVerbOf('/usr/bin/voxtype record toggle'), 'toggle', 'verb: /usr/bin/voxtype record toggle');
eq(voxtypeVerbOf('voxtype record cancel'), 'cancel', 'verb: voxtype record cancel');
eq(voxtypeVerbOf('  voxtype   record   toggle  '), 'toggle', 'verb: extra whitespace');
eq(voxtypeVerbOf("'/opt/my tools/voxtype' record toggle"), 'toggle', 'verb: a quoted path with a space');
eq(voxtypeVerbOf('voxtype record start'), null, 'verb: record start is rejected');
eq(voxtypeVerbOf('voxtype record stop'), null, 'verb: record stop is rejected');
eq(voxtypeVerbOf('notvoxtype record toggle'), null, 'verb: notvoxtype is rejected');
eq(voxtypeVerbOf('voxtype record toggle --now'), null, 'verb: a trailing argument is rejected');
eq(voxtypeVerbOf('voxtype record toggle extra'), null, 'verb: a trailing word is rejected');
eq(voxtypeVerbOf('voxtype record'), null, 'verb: no verb');
eq(voxtypeVerbOf('voxtype toggle'), null, 'verb: no record');
eq(voxtypeVerbOf('env voxtype record toggle'), null, 'verb: a wrapper is rejected');
eq(voxtypeVerbOf(''), null, 'verb: empty command');
eq(voxtypeVerbOf("voxtype record 'toggle"), null, 'verb: an unbalanced quote');
eq(voxtypeVerbOf(undefined), null, 'verb: undefined');

// shortcutBindings: the menu and Settings share it, so both pick the same entry.
const T = (binding, command = '/usr/bin/voxtype record toggle') => ({command, binding});
const C = (binding, command = '/usr/bin/voxtype record cancel') => ({command, binding});
eq(shortcutBindings([]), {toggle: null, cancel: null}, 'bindings: no entries');
eq(shortcutBindings([T('<Alt>space'), C('<Shift><Alt>space')]), {toggle: '<Alt>space', cancel: '<Shift><Alt>space'},
    'bindings: one entry per verb');
eq(shortcutBindings([{command: 'launcher', binding: '<Control>F12'}, T('<Alt>F9')]), {toggle: '<Alt>F9', cancel: null},
    'bindings: an unrelated entry is skipped');
eq(shortcutBindings([T('<Alt>F9'), T('<Alt>F10')]).toggle, '<Alt>F9', 'bindings: the first duplicate wins');
eq(shortcutBindings([T(''), T('<Alt>F10')]).toggle, '', 'bindings: a disabled first duplicate does not fall through');
eq(shortcutBindings([C(''), C('<Alt>F10')]).cancel, '', 'bindings: same for cancel');
eq(capsFor(shortcutBindings([T(''), T('<Alt>F10')]).toggle ?? ''), null, 'bindings: the disabled first one shows no caps');
eq(shortcutBindings([T('<Alt>F9', 'env voxtype record toggle'), T('<Alt>F10')]).toggle, '<Alt>F10',
    'bindings: only an exact `voxtype record toggle` command matches');
eq(pickShortcutPath([], 'toggle', p => p.endsWith('/voxtype/')), `${SHORTCUT_ROOT}voxtype-2/`,
    'path: an entry already written there makes the path taken');
eq(pickShortcutPath([], 'toggle', () => false), `${SHORTCUT_ROOT}voxtype/`, 'path: nothing written means free');

// --- the unredirect hold: every acquire is matched by one release, whatever path the pill takes ----------

// A counting stand-in for the two compositor calls; `depth` is how many inhibits are outstanding.
function fakeCompositor() {
    const c = {disabled: 0, enabled: 0, depth: 0};
    c.disable = () => {
        c.disabled++;
        c.depth++;
    };
    c.enable = () => {
        c.enabled++;
        c.depth--;
    };
    return c;
}

function holdPath(label, steps, expected) {
    const c = fakeCompositor();
    const hold = new UnredirectHold(c.disable, c.enable);
    for (const step of steps)
        hold[step]();
    eq({disabled: c.disabled, enabled: c.enabled, depth: c.depth, held: hold.held}, expected, `unredirect: ${label}`);
}

holdPath('nothing happens', [], {disabled: 0, enabled: 0, depth: 0, held: false});
holdPath('show, hide', ['acquire', 'release'], {disabled: 1, enabled: 1, depth: 0, held: false});
holdPath('show, show, hide: the second show is a no-op', ['acquire', 'acquire', 'release'],
    {disabled: 1, enabled: 1, depth: 0, held: false});
holdPath('hide without show', ['release'], {disabled: 0, enabled: 0, depth: 0, held: false});
holdPath('hide twice', ['acquire', 'release', 'release'], {disabled: 1, enabled: 1, depth: 0, held: false});
holdPath('disable mid-fade: the fade never completes, disable releases once', ['acquire', 'release'],
    {disabled: 1, enabled: 1, depth: 0, held: false});
// The pill: show, hand-off (no call), receipt show (no-op), receipt hide.
holdPath('receipt path', ['acquire', 'acquire', 'release'], {disabled: 1, enabled: 1, depth: 0, held: false});
// A fade-out is cut short by a new show: the hold stays, the interrupted fade never releases.
holdPath('fade interrupted by a new show', ['acquire', 'acquire', 'release'],
    {disabled: 1, enabled: 1, depth: 0, held: false});
holdPath('two dictations in a row', ['acquire', 'release', 'acquire', 'release'],
    {disabled: 2, enabled: 2, depth: 0, held: false});
holdPath('held stays true while the pill is up', ['acquire'], {disabled: 1, enabled: 0, depth: 1, held: true});
{
    // Animations off or `motion` still: the pill hides at once, so show and hide are adjacent calls.
    const c = fakeCompositor();
    const hold = new UnredirectHold(c.disable, c.enable);
    for (let i = 0; i < 5; i++) {
        hold.acquire();
        hold.acquire();
        hold.release();
    }
    eq([c.disabled, c.enabled, c.depth], [5, 5, 0], 'unredirect: five still-motion cycles balance');
}
{
    // No API on this shell: both calls are skipped, the hold still tracks its flag.
    const hold = new UnredirectHold(null, null);
    hold.acquire();
    eq(hold.held, true, 'unredirect: without an API the flag still follows');
    hold.release();
    eq(hold.held, false, 'unredirect: without an API the release clears it');
}
{
    // A throwing disable leaves nothing held, so the matching release does not enable an inhibit that never was.
    const c = fakeCompositor();
    const hold = new UnredirectHold(() => {
        throw new Error('no display');
    }, c.enable);
    hold.acquire();
    hold.release();
    eq([hold.held, c.enabled], [false, 0], 'unredirect: a failed disable holds nothing');
}

// --- result ----------------------------------------------------------------------------

if (failures.length > 0) {
    printerr(`FAIL (${failures.length} of ${checks} checks):`);
    for (const f of failures)
        printerr(`  - ${f}`);
    System.exit(1);
}
print(`ok: ${checks} checks`);
