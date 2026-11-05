// SPDX-License-Identifier: GPL-2.0-or-later
// Shell-free helpers shared by extension.js (gnome-shell process) and tests/.
// Import only gi://GLib and gi://Gio here: this file must load under plain `gjs -m`.

import GLib from 'gi://GLib';

// `stopped` is never written by Voxtype: it is what a missing file or a dead daemon means.
export const STOPPED = 'stopped';

export const MODE_RECORDING = 'recording';
export const MODE_TRANSCRIBING = 'transcribing';
export const MODE_IDLE = 'idle';
export const MODE_OFFLINE = 'offline';
export const MODE_KEEP = 'keep';

export const VIEW_RECORDING = Object.freeze({
    mode: MODE_RECORDING, label: 'Listening…', name: 'Voxtype: listening', known: true,
});
export const VIEW_TRANSCRIBING = Object.freeze({
    mode: MODE_TRANSCRIBING, label: 'Transcribing…', name: 'Voxtype: transcribing', known: true,
});
export const VIEW_IDLE = Object.freeze({mode: MODE_IDLE, label: '', name: 'Voxtype: idle', known: true});
export const VIEW_OFFLINE = Object.freeze({mode: MODE_OFFLINE, label: '', name: 'Voxtype: not running', known: true});
// Idle by inference: the state file is missing and the lock PID lives. No state file said `idle`.
export const VIEW_IDLE_INFERRED = Object.freeze({...VIEW_IDLE, inferred: true});
// The writer truncates before it writes, so an empty read is a race, not a state.
export const VIEW_KEEP = Object.freeze({
    mode: MODE_KEEP, label: '', name: '', known: true,
});
// A state word from a newer Voxtype: show the idle orb, and let the caller log it once.
export const VIEW_UNKNOWN = Object.freeze({...VIEW_IDLE, known: false});

export const isBusy = mode => mode === MODE_RECORDING || mode === MODE_TRANSCRIBING;

export function stateDirPath(runtimeDir = GLib.get_user_runtime_dir()) {
    return GLib.build_filenamev([runtimeDir, 'voxtype']);
}

export function stateFilePath(runtimeDir) {
    return GLib.build_filenamev([stateDirPath(runtimeDir), 'state']);
}

export function lockFilePath(runtimeDir) {
    return GLib.build_filenamev([stateDirPath(runtimeDir), 'voxtype.lock']);
}

// `voxtype record cancel` drops this trigger file; the daemon deletes it once it has acted.
export function cancelFilePath(runtimeDir) {
    return GLib.build_filenamev([stateDirPath(runtimeDir), 'cancel']);
}

// File content -> state word. Anything that is not text, or is blank, is ''.
export function parseState(text) {
    return typeof text === 'string' ? text.trim() : '';
}

// State word -> what to draw. `known: false` lets the caller log an unexpected value once.
export function viewFor(state) {
    switch (state) {
    case 'recording':
    case 'streaming':
        return VIEW_RECORDING;
    case 'transcribing':
        return VIEW_TRANSCRIBING;
    case 'idle':
        return VIEW_IDLE;
    case STOPPED:
        return VIEW_OFFLINE;
    case '':
        return VIEW_KEEP;
    default:
        return VIEW_UNKNOWN;
    }
}

// voxtype.lock content -> PID, or null when it is not a positive integer.
export function parsePid(text) {
    if (typeof text !== 'string')
        return null;
    const m = /^\s*(\d+)\s*$/.exec(text);
    if (!m)
        return null;
    const pid = Number(m[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

// /proc/<pid>/comm content -> is it the Voxtype daemon? A recycled PID belongs to another program.
export function isVoxtypeComm(text) {
    return typeof text === 'string' && text.startsWith('voxtype');
}

// --- level socket: frame decoding and the voice tracker ---------------------------------

// Voxtype's level frame: seq u32, min f32, max f32, peak_dbfs f32, native byte order.
export const FRAME_BYTES = 16;
const FRAME_MS = 10;
const FRAME_US = FRAME_MS * 1000;
const SILENT_DB = -120;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

// Carry-over bytes + a read chunk -> every complete frame, plus the 0-15 byte tail.
export function decodeFrames(carry, chunk) {
    const buf = new Uint8Array(carry.length + chunk.length);
    buf.set(carry, 0);
    buf.set(chunk, carry.length);
    const view = new DataView(buf.buffer);
    const count = Math.floor(buf.length / FRAME_BYTES);
    const frames = [];
    for (let i = 0; i < count; i++) {
        const at = i * FRAME_BYTES;
        const peak = view.getFloat32(at + 12, LITTLE_ENDIAN);
        // NaN and +Infinity fail `<= 0` too; -Infinity is a clean mute.
        frames.push({
            seq: view.getUint32(at, LITTLE_ENDIAN),
            db: peak === -Infinity ? SILENT_DB : peak,
            valid: peak <= 0,
        });
    }
    return {frames, carry: buf.slice(count * FRAME_BYTES)};
}

const levelOf = db => Math.min(1, Math.max(0, (db + 48) / 28));
const follow = (value, target, dtMs, attackMs, releaseMs) =>
    value + (target - value) * (1 - Math.exp(-dtMs / (target > value ? attackMs : releaseMs)));

const GATE_OPEN_LEVEL = 0.25;
const GATE_OPEN_US = 60000;
const GATE_CLOSE_LEVEL = 0.12;
const GATE_CLOSE_US = 700000;
const ONSET_RISE = 0.072;
const SILENT_US = 300000;
const NOFEED_US = 400000;
const NO_SIGNAL_MS = 2000;
const NO_SIGNAL_HEARD_MS = 5000;
const CANT_HEAR_MS = 6000;

// Frames and time -> the snapshot the orb and the label read. Pure: no actor, no clock of its own.
// Every "held" or "lasted" duration is the span between the first and the last frame of the run, so
// a 60 ms hold takes 7 frames at 100 Hz. Frame times are integer microseconds on the caller's clock.
export class VoiceTracker {
    constructor() {
        this.reset(0);
    }

    reset(nowUs) {
        this._startUs = nowUs;
        this._connected = false;
        this._lastSeq = null;
        this._lastFrameUs = null;
        this._db = SILENT_DB;
        this._level = 0;
        this._fast = 0;
        this._slow = 0;
        this._gate = false;
        this._heard = false;
        this._onsets = 0;
        this._feedSeenMs = 0;
        this._peak = -1;
        this._resetTimers();
    }

    // The gate holds and the hint timers: a lost frame or a new daemon restarts them.
    _resetTimers() {
        this._openSinceUs = null;
        this._belowSinceUs = null;
        this._silentSinceUs = null;
        this._silent = false;
        this._silentMs = 0;
        this._liveMs = 0;
    }

    setConnected(connected) {
        this._connected = connected;
        if (connected)
            return;
        this._lastSeq = null;
        this._lastFrameUs = null;
        this._resetTimers();
    }

    // Frame i of n arrived with the read at `arrivalUs`: back-date it 10 ms per frame behind the last.
    pushFrames(frames, arrivalUs) {
        const n = frames.length;
        frames.forEach((frame, i) => this._push(frame, arrivalUs - (n - 1 - i) * FRAME_US));
    }

    _push({seq, db}, timeUs) {
        const prevUs = this._lastFrameUs;
        const us = prevUs === null ? timeUs : Math.max(timeUs, prevUs);
        // A pause past the nofeed threshold is a restart even with the next seq: the socket stayed open
        // but the holds and hint timers must not bridge it. heard and feedSeenMs are recording-wide.
        const stale = prevUs !== null && us - prevUs > NOFEED_US;
        const restart = this._lastSeq === null || stale || ((seq - this._lastSeq) >>> 0) !== 1;
        if (restart)
            this._resetTimers();
        const dtMs = prevUs === null || stale ? FRAME_MS : Math.min(100, (us - prevUs) / 1000);

        const level = levelOf(db);
        const fastBefore = this._fast;
        this._fast = follow(this._fast, level, dtMs, 25, 140);
        this._slow = follow(this._slow, this._fast, dtMs, 120, 400);
        // 0.072 per 10 ms, scaled to the real spacing so a read that is late does not make onsets.
        let onset = this._fast - fastBefore > ONSET_RISE * dtMs / FRAME_MS;

        if (!this._gate) {
            this._belowSinceUs = null;
            if (level >= GATE_OPEN_LEVEL) {
                this._openSinceUs ??= us;
                if (us - this._openSinceUs >= GATE_OPEN_US) {
                    this._gate = true;
                    this._heard = true;
                    this._openSinceUs = null;
                    onset = true;
                }
            } else {
                this._openSinceUs = null;
            }
        } else {
            this._openSinceUs = null;
            if (level < GATE_CLOSE_LEVEL) {
                this._belowSinceUs ??= us;
                if (us - this._belowSinceUs >= GATE_CLOSE_US) {
                    this._gate = false;
                    this._belowSinceUs = null;
                }
            } else {
                this._belowSinceUs = null;
            }
        }
        if (onset)
            this._onsets++;

        // Exactly -120: a finite -121 is a very quiet microphone, not a dead one.
        if (db === SILENT_DB) {
            this._silentSinceUs ??= us;
            this._silent = us - this._silentSinceUs >= SILENT_US;
            this._silentMs = (us - this._silentSinceUs) / 1000;
        } else {
            this._silentSinceUs = null;
            this._silent = false;
            this._silentMs = 0;
        }
        if (!restart && !this._silent)
            this._liveMs += dtMs;

        this._feedSeenMs += dtMs;
        this._lastSeq = seq;
        this._lastFrameUs = us;
        this._db = db;
        this._level = level;
        this._peak = Math.max(this._peak, level);
    }

    snapshot(nowUs) {
        const stale = this._lastFrameUs === null || nowUs - this._lastFrameUs > NOFEED_US;
        const feed = !this._connected || stale ? 'nofeed' : this._silent ? 'silent' : 'live';
        let hint = 'listening';
        if (feed === 'silent' && this._silentMs >= (this._heard ? NO_SIGNAL_HEARD_MS : NO_SIGNAL_MS))
            hint = 'no-signal';
        else if (feed === 'live' && !this._heard && this._liveMs >= CANT_HEAR_MS)
            hint = 'cant-hear';
        // A snapshot with no new frame reports the current level, not zero.
        const peak = this._peak >= 0 ? this._peak : this._level;
        this._peak = -1;
        return {
            feed, db: this._db, level: this._level, peak, fast: this._fast, slow: this._slow,
            gate: this._gate, heard: this._heard, onsets: this._onsets,
            feedSeenMs: this._feedSeenMs, msSinceStart: (nowUs - this._startUs) / 1000, hint,
        };
    }
}

// What the end receipt says: `Nothing heard` only when the feed was there and the user never spoke.
// A cancelled recording says nothing (null): `Done` would claim a result that was discarded.
export function receiptFor({heard, feedSeenMs, cancelled = false}) {
    if (cancelled)
        return null;
    return feedSeenMs >= 2000 && !heard ? 'nothing-heard' : 'done';
}

// A receipt follows only a state file that itself said `idle` right after `transcribing`: an unknown state word
// or an inferred idle (no file, live daemon) proves nothing about the transcription.
export function receiptAllowed(prevMode, view) {
    return prevMode === MODE_TRANSCRIBING && view.mode === MODE_IDLE && view.known && !view.inferred;
}

// --- panel menu, systemd and settings rules --------------------------------------------------

const HINT_SUFFIX = {'cant-hear': ' · can\'t hear you', 'no-signal': ' · no signal'};
const ACTION_START = Object.freeze({label: 'Start dictation', verb: 'start'});
const ACTION_STOP = Object.freeze({label: 'Stop and transcribe', verb: 'stop'});
const ACTION_CANCEL = Object.freeze({label: 'Cancel', verb: 'cancel'});

// View (+ settings, + the tracker's hint) -> the menu's header, subtitle and dictation actions.
// The `Show pill` switch and `Settings…` come after these and belong to every state.
export function menuFor(view, {controls, hint = 'listening'}) {
    let header = 'Voxtype: idle';
    let subtitle = null;
    let actions = [ACTION_START];
    switch (view.mode) {
    case MODE_RECORDING:
        header = `Voxtype: listening${HINT_SUFFIX[hint] ?? ''}`;
        actions = [ACTION_STOP, ACTION_CANCEL];
        break;
    case MODE_TRANSCRIBING:
        header = 'Voxtype: transcribing';
        actions = [ACTION_CANCEL];
        break;
    case MODE_OFFLINE:
        header = 'Voxtype is not running';
        subtitle = 'systemctl --user start voxtype';
        actions = [];
        break;
    }
    return {header, subtitle, actions: controls ? actions.map(a => ({...a})) : []};
}

// systemd `ActiveState` of voxtype.service -> what the state source does with it.
export function unitEffect(activeState) {
    switch (activeState) {
    case 'active':
        return 'read';
    case 'inactive':
    case 'failed':
    case 'activating':
    case 'deactivating':
        return 'offline';
    default:
        return 'none';
    }
}

const PANEL_ORB_VALUES = ['always', 'busy', 'never'];

// Raw settings -> what to show. An unknown `panel-orb` is `always`; `never` with the pill off would
// leave the extension invisible, so the pill wins.
export function displayFor({panelOrb, showPill}) {
    const orb = PANEL_ORB_VALUES.includes(panelOrb) ? panelOrb : 'always';
    return {panelOrb: orb, showPill: orb === 'never' ? true : Boolean(showPill)};
}

export function buttonShown(panelOrb, mode) {
    switch (panelOrb) {
    case 'busy':
        return isBusy(mode);
    case 'never':
        return false;
    default:
        return true;
    }
}

// --- key caps and the shortcut matcher ----------------------------------

const CAP_MODIFIERS = {super: 'Super', primary: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift'};
const CAP_ORDER = ['Super', 'Ctrl', 'Alt', 'Shift'];

// A GTK accelerator such as `<Shift><Alt>space` -> its key caps, ordered Super, Ctrl, Alt, Shift, key.
// Anything it cannot read is null: nothing is guessed.
export function capsFor(binding) {
    if (typeof binding !== 'string')
        return null;
    const found = new Set();
    let rest = binding.trim();
    for (let m = rest.match(/^<([^<>]*)>/); m; m = rest.match(/^<([^<>]*)>/)) {
        const cap = CAP_MODIFIERS[m[1].toLowerCase()];
        if (!cap)
            return null;
        found.add(cap);
        rest = rest.slice(m[0].length);
    }
    if (rest === '' || /[<>\s]/.test(rest))
        return null;
    const key = rest === 'space' ? 'Space' : rest.length === 1 ? rest.toUpperCase() : rest;
    return [...CAP_ORDER.filter(c => found.has(c)), key];
}

// The command of a GNOME custom shortcut -> 'toggle' or 'cancel' when it is exactly
// `<path>/voxtype record toggle|cancel`, else null (a trailing argument or a wrapper is not a match).
export function voxtypeVerbOf(command) {
    if (typeof command !== 'string')
        return null;
    let argv;
    try {
        [, argv] = GLib.shell_parse_argv(command);
    } catch (_e) {
        return null;
    }
    if (argv.length !== 3 || GLib.path_get_basename(argv[0]) !== 'voxtype' || argv[1] !== 'record')
        return null;
    return argv[2] === 'toggle' || argv[2] === 'cancel' ? argv[2] : null;
}

// --- setting the shortcuts -----------------------------------------------------------------------
// Pure helpers for the capture dialog and the writer in shortcuts.js, which runs in the preferences process.

export const SHORTCUT_ROOT = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/';
const SHORTCUT_LEAF = Object.freeze({toggle: 'voxtype', cancel: 'voxtype-cancel'});

// A keyval -> 'modifier' (waits), 'function' (F1-F24 and the XF86 keys: valid alone) or 'key' (needs Ctrl, Alt or
// Super). Numeric ranges from the X11 keysym table, so this needs no Gdk and runs under plain gjs.
export function keyClass(keyval) {
    if ((keyval >= 0xffe1 && keyval <= 0xffee) || (keyval >= 0xfe01 && keyval <= 0xfe13) || keyval === 0xff7e)
        return 'modifier';
    if ((keyval >= 0xffbe && keyval <= 0xffd5) || (keyval >= 0x1008fe00 && keyval <= 0x1008ffff))
        return 'function';
    return 'key';
}

// The custom-keybindings path for a new `voxtype record <verb>` entry: voxtype/ (toggle) or voxtype-cancel/, then
// -2, -3 and so on while the path is taken. `isTaken(path)` also claims a path that is not in the list yet: another
// process may have written its entry and not appended it.
export function pickShortcutPath(paths, verb, isTaken = () => false) {
    const leaf = SHORTCUT_LEAF[verb];
    if (!leaf)
        throw new Error(`unknown verb ${verb}`);
    for (let n = 1; ; n++) {
        const path = `${SHORTCUT_ROOT}${n === 1 ? leaf : `${leaf}-${n}`}/`;
        if (!paths.includes(path) && !isTaken(path))
            return path;
    }
}

// `[{command, binding}]` in list order -> `{toggle, cancel}`: the binding of the first entry whose command is
// `voxtype record <verb>`, or null. A disabled first entry stays the answer (binding ''): the menu and Settings both
// use this rule, so they never show different entries.
export function shortcutBindings(entries) {
    const found = {toggle: null, cancel: null};
    for (const {command, binding} of entries) {
        const verb = voxtypeVerbOf(command);
        if (verb && found[verb] === null)
            found[verb] = binding;
    }
    return found;
}

// The command of a new entry. GNOME runs it through a shell parse, so a path with a space is quoted.
export function shortcutCommand(binary, verb) {
    return `${/^[\w./+-]+$/.test(binary) ? binary : GLib.shell_quote(binary)} record ${verb}`;
}

// One inhibit of direct scanout (unredirect), held while the pill is on screen. Without a top bar a maximised
// window covers its whole monitor and Mutter scans it out directly, so a Shell actor like the pill is not composited
// there. `acquire` and `release` are idempotent, so a second show or a hide that was never shown cannot unbalance the
// compositor's counter. The two functions come from the Shell side (feature-detected); null means this shell has none.
export class UnredirectHold {
    constructor(disable, enable) {
        this._disable = disable;
        this._enable = enable;
        this.held = false;
    }

    acquire() {
        if (this.held)
            return;
        try {
            this._disable?.();
        } catch (e) {
            console.warn(`[Dictation Indicator] cannot inhibit unredirect: ${e.message}`);
            return;
        }
        this.held = true;
    }

    release() {
        if (!this.held)
            return;
        this.held = false;
        try {
            this._enable?.();
        } catch (e) {
            console.warn(`[Dictation Indicator] cannot lift the unredirect inhibit: ${e.message}`);
        }
    }
}
