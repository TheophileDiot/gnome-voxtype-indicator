// SPDX-License-Identifier: GPL-2.0-or-later
// The preferences window. It runs in the preferences process, never in the Shell, so it
// may use Adw and Gtk but never the Shell's own modules. One Adw.PreferencesPage: a preview tour drawn with the
// real trace.js, orb.js and morph.js, then the eight keys, the key caps of the user's GNOME shortcuts, what the
// extension sees of Voxtype (read once, nothing polls) and the About rows. Voxtype's config is only ever read.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    MODE_IDLE, MODE_OFFLINE, MODE_RECORDING, MODE_TRANSCRIBING, MODE_KEEP,
    buttonShown, capsFor, displayFor, keyClass, stateDirPath,
} from './common.js';
import {MORPH_MS, breakDots, checkDots, easeOutQuad, primeTrace, sashFade, through, unfold} from './morph.js';
import {ORBS, ORB_SIZE, SEED_IDLE, SEED_OFFLINE} from './orb.js';
import {createTrace} from './trace.js';
import {
    MSG_NOT_PAUSED, MSG_UNAVAILABLE, conflictMessage, entryFor, evaluateKey, findConflict, pressedAccel, readShortcuts,
    shortcutsAvailable, writeShortcut,
} from './shortcuts.js';
import {VoxtypeStateSource} from './source.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gtk.UriLauncher.prototype, 'launch', 'launch_finish');

const LOG = '[Dictation Indicator]';

// --- the preview tour -----------------------------------------------------------------------------------

const STATES = Object.freeze([
    {id: 'recording', chip: 'Recording', dwell: 3600},
    {id: 'quiet', chip: 'Quiet mic', dwell: 3000},
    {id: 'transcribing', chip: 'Transcribing', dwell: 2600},
    {id: 'done', chip: 'Done', dwell: 1600},
    {id: 'idle', chip: 'Idle', dwell: 2200},
    {id: 'offline', chip: 'Not running', dwell: 2600},
]);

const INK_RED = [1, 0.384, 0.404];
const INK_AMBER = [1, 0.678, 0.259];
const INK_WHITE = [1, 1, 1];

// The composing dots are drawn at 1.5 times their upstream radius, as the Shell does (extension.js DOT_GAIN).
const DOT_GAIN = 1.5;
const QUIET = {feed: 'live', peak: 0, gate: false, onsets: 0};
const ORB_PX = 16;
const BAR_PX = 26;
const PILL_PX = 30;
const PILL_GAP = 12;
const SCREEN_PX = 172;

// The receipt, as the Shell paints it: the glyph draws in about 442 ms, holds, then the pill leaves.
const RECEIPT_MS = 442;
const RECEIPT_HIDE_AT_MS = 900;
const FADE_IN_MS = 150;
const RISE_MS = 180;
const FADE_OUT_MS = 100;
const GLIDE_MS = 200;
const LABEL_OUT_MS = 60;
const LABEL_IN_MS = 90;
const CAPTION_OUT_MS = 90;
const CAPTION_IN_MS = 150;

const RISE_EM = 0.4;
const LIFT_EM = 0.2;

const kindOf = id => id === 'recording' || id === 'quiet' ? 'rec' : id === 'transcribing' ? 'busy' : id === 'offline' ? 'off' : 'rest';
const modeOf = id => kindOf(id) === 'rec' ? MODE_RECORDING : id === 'transcribing' ? MODE_TRANSCRIBING : id === 'offline' ? MODE_OFFLINE : MODE_IDLE;
const isBusyState = id => id === 'recording' || id === 'quiet' || id === 'transcribing';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// A scripted voice: words of six syllables with a pause between, so the trace has something to follow.
const SYLLABLES = [0.9, 0.65, 0.8, 0.55, 0.75, 0.5];
function speech(ms) {
    const cycle = 1900;
    const t = ms % cycle;
    const words = Math.floor(ms / cycle);
    if (t > 1500)
        return {feed: 'live', peak: 0.04, gate: false, onsets: words * 6 + 6};
    const syllable = Math.floor(t / 250);
    const env = Math.sin(Math.PI * (t % 250) / 250) ** 1.5;
    return {feed: 'live', peak: clamp(0.14 + env * SYLLABLES[syllable] * 0.85, 0, 1), gate: true, onsets: words * 6 + syllable + 1};
}

const layerOf = (dots, ink) => ({dots, ink});
const lerpInk = (a, b, f) => a.map((c, i) => c + (b[i] - c) * clamp(f, 0, 1));

class Tween {
    constructor(value) {
        this.from = this.to = value;
        this.start = 0;
        this.dur = 0;
    }

    set(to, now, dur) {
        this.from = this.value(now);
        this.to = to;
        this.start = now;
        this.dur = dur;
    }

    jump(value) {
        this.from = this.to = value;
        this.dur = 0;
    }

    value(now) {
        if (this.dur <= 0)
            return this.to;
        return this.from + (this.to - this.from) * easeOutQuad((now - this.start) / this.dur);
    }

    running(now) {
        return this.dur > 0 && now - this.start < this.dur;
    }
}

class Preview {
    constructor({area, chips, hairs, play, caption, settings, settingsGtk}) {
        this._area = area;
        this._chips = chips;
        this._hairs = hairs;
        this._play = play;
        this._caption = caption;
        this._settings = settings;
        this._gtkSettings = settingsGtk;

        this._state = 0;
        this._playing = true;
        this._stateAt = 0;
        this._dwellAt = 0;
        this._tr = null;
        this._tickId = 0;
        this._lastMs = 0;
        this._layers = {bar: [], pill: []};
        this._traceDots = [];
        this._trace = createTrace();
        this._orbMs = 0;
        this._pillOn = false;
        this._alpha = new Tween(0);
        this._rise = new Tween(0);
        this._width = new Tween(0);
        this._label = {cur: '', prev: '', start: -1e9};
        this._cap = {text: '', next: null, start: 0, swapped: true};
        this._handlers = [];
        this._ids = [];
        this._read();
        const now = this._now();
        this._lastMs = now;
        this._state = this._animated() ? 0 : 4;
        this._enter(this._state, now, null, false);
        this._syncChips();
        this._frame(now);
    }

    // --- settings -------------------------------------------------------------------------------------

    _read() {
        const s = this._settings;
        const display = displayFor({panelOrb: s.get_string('panel-orb'), showPill: s.get_boolean('show-pill')});
        this._panelOrb = display.panelOrb;
        this._showPill = display.showPill;
        this._hints = s.get_boolean('mic-hints');
        this._receipt = s.get_boolean('receipt');
        this._motion = s.get_string('motion');
    }

    // GNOME animations and the extension's own `motion` key.
    _animated() {
        return this._gtkSettings.gtk_enable_animations && this._motion === 'follow';
    }

    _now() {
        return GLib.get_monotonic_time() / 1000;
    }

    connect() {
        const s = this._settings;
        for (const key of ['panel-orb', 'show-pill', 'mic-hints', 'receipt', 'motion']) {
            const id = s.connect(`changed::${key}`, () => this._onSettings());
            this._handlers.push([s, id]);
        }
        const gid = this._gtkSettings.connect('notify::gtk-enable-animations', () => this._onSettings());
        this._handlers.push([this._gtkSettings, gid]);
        this._ids.push([this._area, this._area.connect('map', () => {
            this._lastMs = this._now();
            this._frame(this._lastMs);
            this._wake();
        })]);
        this._ids.push([this._area, this._area.connect('unmap', () => this._sleep())]);
        this._ids.push([this._play, this._play.connect('clicked', () => this._togglePlay())]);
        STATES.forEach((_s, i) => {
            this._ids.push([this._chips[i], this._chips[i].connect('clicked', () => this._pick(i))]);
        });
        this._wake();
    }

    // Everything the window set up, undone on close-request: no tick, no handler survives.
    destroy() {
        this._sleep();
        for (const [obj, id] of [...this._handlers, ...this._ids])
            obj.disconnect(id);
        this._handlers = [];
        this._ids = [];
    }

    _onSettings() {
        const wasAnimated = this._animated();
        this._read();
        const now = this._now();
        if (wasAnimated && !this._animated()) {
            // Reduced motion: no tour, no transition, every tween at its end.
            this._playing = false;
            this._tr = null;
            this._settleTweens();
        } else if (!wasAnimated && this._animated()) {
            this._playing = true;
            this._dwellAt = now;
        }
        this._retarget(now, false);
        this._setCaption(now);
        this._syncPlay();
        this._frame(now);
        this._wake();
    }

    // --- the tour ---------------------------------------------------------------------------------------

    _pick(i) {
        this._playing = false;
        const now = this._now();
        if (i !== this._state)
            this._select(i, now);
        this._syncPlay();
        this._frame(now);
        this._wake();
    }

    _togglePlay() {
        if (!this._animated())
            return;
        this._playing = !this._playing;
        const now = this._now();
        this._dwellAt = now;
        this._syncPlay();
        this._frame(now);
        this._wake();
    }

    _select(i, now) {
        const prev = STATES[this._state].id;
        const from = {bar: this._layers.bar, pill: this._pillVisible(now) ? this._layers.pill : []};
        this._state = i;
        this._enter(i, now, prev, this._animated(), from);
        this._syncChips();
    }

    _enter(i, now, prev, animated, from = null) {
        const id = STATES[i].id;
        this._stateAt = now;
        this._dwellAt = now;
        this._tr = null;
        if (id === 'recording' || id === 'quiet') {
            if (prev === null || kindOf(prev) !== 'rec') {
                this._trace = createTrace();
                if (animated)
                    primeTrace(this._trace, QUIET);
                this._traceDots = [];
            }
        } else if (id === 'transcribing') {
            this._orbMs = 0;
        }
        if (animated && prev !== null && from)
            this._tr = this._transition(prev, id, from);
        this._retarget(now, animated && prev !== null, prev);
        this._setCaption(now);
    }

    // What the change from one state to the next looks like, or null.
    _transition(prev, next, from) {
        if (!from.bar.length && !from.pill.length)
            return null;
        const a = kindOf(prev);
        const b = kindOf(next);
        let tr = null;
        if (a === 'rec' && b === 'rec')
            return null;
        if (b === 'rec' || b === 'busy') {
            tr = a === 'rest' && b === 'rec'
                ? {kind: 'unfold', ms: MORPH_MS.unfold}
                : {kind: 'through', ms: MORPH_MS.handoff, gather: 120, bloom: 50};
        } else if (next === 'done' && prev === 'transcribing') {
            tr = {kind: 'receipt', ms: RECEIPT_MS, extra: 34};
        } else if ((a === 'rec' || a === 'busy') && b === 'rest') {
            tr = {kind: 'through', ms: MORPH_MS.withdraw, gather: 120, bloom: 80};
        } else if ((a === 'rec' || a === 'busy') && b === 'off') {
            tr = {kind: 'through', ms: 220, gather: 140, bloom: 60};
        } else if (a === 'rest' && b === 'off') {
            tr = {kind: 'break', ms: MORPH_MS.breakOut, back: false};
        } else if (a === 'off' && b === 'rest') {
            tr = {kind: 'break', ms: MORPH_MS.breakBack, back: true};
        }
        return tr ? {extra: 0, start: null, from, ...tr} : null;
    }

    _tourRunning() {
        return this._playing && this._animated();
    }

    // --- pill, label, caption targets -----------------------------------------------------------------

    _id() {
        return STATES[this._state].id;
    }

    _pillWanted(now) {
        const id = this._id();
        if (!this._showPill)
            return false;
        if (id === 'done')
            return this._receipt && (!this._tourRunning() || now - this._stateAt < RECEIPT_HIDE_AT_MS);
        return isBusyState(id);
    }

    _pillVisible(now) {
        return this._alpha.value(now) > 0 && this._layers.pill.length > 0;
    }

    _labelText() {
        switch (this._id()) {
        case 'quiet':
            return this._hints ? 'Can\'t hear you' : 'Listening…';
        case 'transcribing':
            return 'Transcribing…';
        case 'done':
            return 'Done';
        default:
            return 'Listening…';
        }
    }

    _font(px, bold) {
        const fd = this._area.get_pango_context().get_font_description().copy();
        fd.set_absolute_size(px * Pango.SCALE);
        fd.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
        return fd;
    }

    _measure(text, px, bold) {
        const layout = this._area.create_pango_layout(text);
        layout.set_font_description(this._font(px, bold));
        return layout.get_pixel_size()[0];
    }

    // The pill reserves the width of the widest label of its mode, so a hint never re-centres it.
    _reservedWidth() {
        const id = this._id();
        const labels = id === 'transcribing' ? ['Transcribing…', 'Still transcribing…']
            : id === 'done' ? ['Done']
                : this._hints ? ['Listening…', 'Can\'t hear you', 'No signal'] : ['Listening…'];
        return Math.max(...labels.map(t => this._measure(t, 14, false)));
    }

    // Retargets the pill's opacity, rise, width and label for the current state and settings.
    _retarget(now, glide, prev = null) {
        const animated = this._animated();
        const em = 14;
        const want = this._pillWanted(now);
        const width = this._reservedWidth();
        if (want !== this._pillOn) {
            this._pillOn = want;
            if (want) {
                this._width.jump(width);
                this._label = {cur: this._labelText(), prev: '', start: -1e9};
                if (animated) {
                    this._alpha.set(1, now, FADE_IN_MS);
                    this._rise.from = -RISE_EM * em;
                    this._rise.to = 0;
                    this._rise.start = now;
                    this._rise.dur = RISE_MS;
                } else {
                    this._alpha.jump(1);
                    this._rise.jump(0);
                }
            } else if (animated) {
                this._alpha.set(0, now, FADE_OUT_MS);
                this._rise.set(-LIFT_EM * em, now, FADE_OUT_MS);
            } else {
                this._alpha.jump(0);
                this._rise.jump(0);
            }
        } else if (want) {
            if (animated && glide && prev === 'recording' && this._id() === 'transcribing')
                this._width.set(width, now, GLIDE_MS);
            else if (animated && glide && prev === 'quiet' && this._id() === 'transcribing')
                this._width.set(width, now, GLIDE_MS);
            else
                this._width.jump(width);
            const text = this._labelText();
            if (text !== this._label.cur) {
                this._label = animated
                    ? {cur: text, prev: this._label.cur, start: now}
                    : {cur: text, prev: '', start: -1e9};
            }
        }
    }

    _settleTweens() {
        this._alpha.jump(this._alpha.to);
        this._rise.jump(this._rise.to);
        this._width.jump(this._width.to);
        this._label = {cur: this._label.cur, prev: '', start: -1e9};
        this._cap.next = null;
        this._cap.swapped = true;
        this._caption.set_opacity(1);
    }

    _captionText() {
        const id = this._id();
        switch (id) {
        case 'recording':
            return 'Recording. The trace follows your voice; the pill says “Listening…”.';
        case 'quiet':
            return this._hints
                ? 'Quiet mic. Nothing heard yet, so the pill says “Can’t hear you”.'
                : 'Quiet mic. The microphone warnings are off, so the pill keeps saying “Listening…”.';
        case 'transcribing':
            return 'Transcribing. The amber sash undulates until the text is pasted.';
        case 'done':
            return this._receipt
                ? 'Done. The receipt shows for half a second, then the pill leaves.'
                : 'Done. The receipt is off, so the pill just leaves.';
        case 'idle':
            return this._panelOrb === 'always'
                ? 'Idle. The Seed waits in the bar; the pill stays away.'
                : 'Idle. The bar keeps no orb until Voxtype is busy.';
        default:
            return this._panelOrb === 'always'
                ? 'Not running. A broken ring; the menu shows how to start the daemon.'
                : 'Not running. The bar keeps no orb until Voxtype is busy.';
        }
    }

    _setCaption(now) {
        const text = this._captionText();
        if (text === (this._cap.next ?? this._cap.text))
            return;
        if (this._animated() && this._area.get_mapped()) {
            this._cap = {text: this._cap.text, next: text, start: now, swapped: false};
        } else {
            this._cap = {text, next: null, start: 0, swapped: true};
            this._caption.set_label(text);
            this._caption.set_opacity(1);
        }
    }

    // --- the frame ------------------------------------------------------------------------------------

    _voice(now) {
        return this._id() === 'quiet' ? QUIET : speech(now - this._stateAt);
    }

    _steady(name, now, ms = 0) {
        const id = this._id();
        if (id === 'recording' || id === 'quiet')
            return [layerOf(this._traceDots, INK_RED)];
        if (id === 'transcribing') {
            const dots = ORBS.composing.frame(this._animated() ? ORBS.composing.time(this._orbMs) : ORBS.composing.stillT)
                .map(d => ({x: d.x, y: d.y, r: d.r * DOT_GAIN, a: d.a}));
            return [layerOf(dots, INK_AMBER)];
        }
        if (name === 'pill')
            return id === 'done' ? [layerOf(checkDots('done', 1e6), INK_AMBER)] : this._layers.pill;
        return [layerOf(id === 'offline' ? SEED_OFFLINE : SEED_IDLE, INK_WHITE)];
    }

    _layersFor(name, now) {
        const tr = this._tr;
        const from = tr?.from[name] ?? [];
        if (!tr || from.length === 0)
            return this._steady(name, now);
        const ms = clamp(now - tr.start, 0, tr.ms);
        switch (tr.kind) {
        case 'unfold': {
            if (name === 'pill')
                return this._steady(name, now);
            const live = this._steady(name, now)[0];
            const {seed} = unfold(from[0].dots, live.dots, ms);
            return [layerOf(seed, lerpInk(from[0].ink, live.ink, ms / 150)), live];
        }
        case 'break':
            return name === 'pill' ? this._steady(name, now) : [layerOf(breakDots(ms, tr.back ? 'back' : 'out'), INK_WHITE)];
        case 'receipt': {
            if (name !== 'pill')
                return this._steady(name, now);
            const layers = [];
            if (ms < 140) {
                const factor = sashFade(ms);
                for (const l of from)
                    layers.push(layerOf(l.dots.map(d => ({x: d.x, y: d.y, r: d.r, a: d.a * factor})), l.ink));
            }
            layers.push(layerOf(checkDots('done', ms), INK_AMBER));
            return layers;
        }
        default: {
            const incoming = name === 'pill' && !isBusyState(this._id()) ? null : this._steady(name, now)[0];
            const layers = [];
            let inDots = [];
            for (const l of from) {
                const r = through(l.dots, incoming ? incoming.dots : [], ms, {gatherMs: tr.gather, bloomStartMs: tr.bloom, totalMs: tr.ms});
                layers.push(layerOf(r.out, l.ink));
                inDots = r.in;
            }
            if (incoming)
                layers.push(layerOf(inDots, incoming.ink));
            return layers.filter(l => l.dots.length > 0);
        }
        }
    }

    // One step of the preview: the tour, the voice, the transition and every tween, then a repaint.
    _frame(now) {
        const animated = this._animated();
        const dt = clamp(now - this._lastMs, 0, 100);
        this._lastMs = now;

        if (this._tourRunning() && now - this._dwellAt >= STATES[this._state].dwell)
            this._select((this._state + 1) % STATES.length, now);

        const id = this._id();
        if (id === 'transcribing')
            this._orbMs = now - this._stateAt;
        if (id === 'recording' || id === 'quiet') {
            const voice = this._voice(now);
            this._traceDots = animated ? this._trace.frame(dt, voice) : this._trace.still({...voice, gate: id === 'recording'});
        }

        const tr = this._tr;
        if (tr) {
            tr.start ??= now;
            if (now - tr.start >= tr.ms + tr.extra)
                this._tr = null;
        }

        // The receipt hold ends by the clock alone: the pill's target is the one thing that can change between frames.
        if (this._pillWanted(now) !== this._pillOn)
            this._retarget(now, false);

        this._layers = {
            bar: this._layersFor('bar', now),
            pill: this._alpha.value(now) > 0 || this._pillOn ? this._layersFor('pill', now) : [],
        };
        if (!this._pillOn && this._alpha.value(now) <= 0)
            this._layers.pill = [];

        this._stepCaption(now);
        this._stepHair(now);
        this._area.queue_draw();
    }

    _stepCaption(now) {
        const cap = this._cap;
        if (cap.next === null)
            return;
        const t = now - cap.start;
        if (t < CAPTION_OUT_MS) {
            this._caption.set_opacity(1 - easeOutQuad(t / CAPTION_OUT_MS));
            return;
        }
        if (!cap.swapped) {
            cap.swapped = true;
            this._caption.set_label(cap.next);
        }
        const f = easeOutQuad((t - CAPTION_OUT_MS) / CAPTION_IN_MS);
        this._caption.set_opacity(f);
        if (f >= 1) {
            this._cap = {text: cap.next, next: null, start: 0, swapped: true};
            this._caption.set_opacity(1);
        }
    }

    _stepHair(now) {
        const running = this._tourRunning();
        this._hairs.forEach((hair, i) => {
            const on = running && i === this._state;
            hair.set_fraction(on ? clamp((now - this._dwellAt) / STATES[i].dwell, 0, 1) : 0);
            hair.set_opacity(on ? 1 : 0);
        });
    }

    _syncChips() {
        this._chips.forEach((chip, i) => {
            if (chip.get_active() !== (i === this._state))
                chip.set_active(i === this._state);
        });
    }

    _syncPlay() {
        const animated = this._animated();
        this._play.set_sensitive(animated);
        const running = this._tourRunning();
        this._play.set_icon_name(running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');
        this._play.set_tooltip_text(running ? 'Pause the tour' : 'Play the tour');
    }

    // --- the clock --------------------------------------------------------------------------------------

    // The tick runs only while the preview is on screen and something moves: the tour, an animated state, a
    // transition, a tween or the caption cross-fade. Paused on a still state it stops.
    _wantTick() {
        if (!this._area.get_mapped() || !this._animated())
            return false;
        const now = this._now();
        const id = this._id();
        return this._playing || isBusyState(id) || this._tr !== null || this._cap.next !== null
            || this._alpha.running(now) || this._rise.running(now) || this._width.running(now)
            || now - this._label.start < LABEL_OUT_MS + LABEL_IN_MS;
    }

    _wake() {
        if (this._tickId || !this._wantTick())
            return;
        this._lastMs = this._now();
        this._tickId = this._area.add_tick_callback((_w, clock) => {
            this._frame(clock.get_frame_time() / 1000);
            if (this._wantTick())
                return GLib.SOURCE_CONTINUE;
            this._tickId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _sleep() {
        if (!this._tickId)
            return;
        this._area.remove_tick_callback(this._tickId);
        this._tickId = 0;
    }

    // --- drawing ----------------------------------------------------------------------------------------

    _text(cr, str, x, cy, px, bold, alpha, center = false) {
        const layout = this._area.create_pango_layout(str);
        layout.set_font_description(this._font(px, bold));
        const [w, h] = layout.get_pixel_size();
        cr.setSourceRGBA(1, 1, 1, alpha);
        cr.moveTo(center ? x - w / 2 : x, cy - h / 2);
        PangoCairo.show_layout(cr, layout);
        return w;
    }

    _orb(cr, x, y, px, layers, alpha = 1) {
        cr.save();
        cr.translate(x, y);
        cr.scale(px / ORB_SIZE, px / ORB_SIZE);
        for (const {dots, ink: [red, green, blue]} of layers) {
            for (const dot of dots) {
                cr.setSourceRGBA(red, green, blue, dot.a * alpha);
                cr.arc(dot.x, dot.y, dot.r, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        cr.restore();
    }

    _roundRect(cr, x, y, w, h, r) {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
    }

    draw(cr, width, height) {
        const now = this._lastMs;
        cr.save();
        this._roundRect(cr, 0, 0, width, height, 10);
        cr.clip();
        // The wallpaper, with three faint lines of a window behind the pill.
        cr.setSourceRGBA(0.075, 0.09, 0.087, 1);
        cr.paint();
        cr.setSourceRGBA(1, 1, 1, 0.055);
        for (const [x, y, w] of [[0.12, 0.45, 0.58], [0.12, 0.62, 0.32], [0.12, 0.79, 0.58]]) {
            this._roundRect(cr, width * x, height * y, width * w, 6, 3);
            cr.fill();
        }
        // The panel.
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.rectangle(0, 0, width, BAR_PX);
        cr.fill();
        this._text(cr, 'Activities', 12, BAR_PX / 2, 11, true, 0.92);
        this._text(cr, 'Tue 3 Nov', width / 2, BAR_PX / 2, 11, true, 0.92, true);
        cr.newPath();
        cr.setSourceRGBA(1, 1, 1, 0.8);
        cr.setLineWidth(1.4);
        cr.arc(width - 17, BAR_PX / 2, 5.2, 0, 2 * Math.PI);
        cr.stroke();
        if (buttonShown(this._panelOrb, modeOf(this._id())))
            this._orb(cr, width - 17 - 6 - 10 - ORB_PX, (BAR_PX - ORB_PX) / 2, ORB_PX, this._layers.bar);
        this._pill(cr, width, now);
        cr.restore();
    }

    _pill(cr, width, now) {
        const alpha = clamp(this._alpha.value(now), 0, 1);
        if (alpha <= 0)
            return;
        const labelW = this._width.value(now);
        const w = 11 + ORB_PX + 9 + labelW + 14;
        const x = Math.round((width - w) / 2);
        const y = BAR_PX + PILL_GAP + this._rise.value(now);
        this._roundRect(cr, x + 0.5, y + 0.5, w - 1, PILL_PX - 1, (PILL_PX - 1) / 2);
        cr.setSourceRGBA(0.067, 0.078, 0.071, 0.95 * alpha);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 0.1 * alpha);
        cr.setLineWidth(1);
        cr.stroke();
        this._orb(cr, x + 11, y + (PILL_PX - ORB_PX) / 2, ORB_PX, this._layers.pill, alpha);
        const t = now - this._label.start;
        let text = this._label.cur;
        let la = 1;
        if (t < LABEL_OUT_MS) {
            text = this._label.prev;
            la = 1 - easeOutQuad(t / LABEL_OUT_MS);
        } else if (t < LABEL_OUT_MS + LABEL_IN_MS) {
            la = easeOutQuad((t - LABEL_OUT_MS) / LABEL_IN_MS);
        }
        this._text(cr, text, x + 11 + ORB_PX + 9, y + PILL_PX / 2, 14, false, la * alpha);
    }
}

// --- the Voxtype rows ------------------------------------------------------------------------------------

// One async subprocess, no shell. Null when it cannot start or fails; a cancelled run is killed, so a window
// closed mid-read leaves no process behind.
async function runRead(argv, cancellable) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (_e) {
        return null;
    }
    try {
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        return proc.get_successful() ? (stdout ?? '').trim() : null;
    } catch (e) {
        proc.force_exit();
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.warn(`${LOG} ${argv[0]}: ${e.message}`);
        return null;
    }
}

const stripQuotes = text => text.replace(/^"(.*)"$/, '$1');

// `1.2000000476837158` (an f32 printed as an f64) -> `1.2 s`; null or unset -> `Off`.
function silenceLabel(text) {
    if (text === null)
        return null;
    if (text === '' || text === 'null')
        return 'Off';
    const secs = Number(text);
    return Number.isFinite(secs) ? `${Math.round(secs * 10) / 10} s` : null;
}

const CSS = `
.vx-chip { padding: 3px 11px; min-height: 26px; border-radius: 999px; font-size: 0.92em; font-weight: 400; background: none; box-shadow: none; }
.vx-chip:hover { background-color: alpha(currentColor, 0.06); }
.vx-chip:checked { background-color: alpha(currentColor, 0.1); font-weight: 700; }
progressbar.vx-hair { margin: 2px 12px 0 12px; }
progressbar.vx-hair trough { min-height: 2px; background-color: alpha(currentColor, 0.1); border: none; }
progressbar.vx-hair progress { min-height: 2px; background-color: @accent_bg_color; border-radius: 2px; }
.vx-dot { min-width: 8px; min-height: 8px; border-radius: 999px; }
.vx-dot.ok { background-color: @success_color; }
.vx-dot.warn { background-color: @warning_color; }
.vx-dot.mute { background-color: alpha(currentColor, 0.35); }
.vx-cap { font-size: 0.8em; min-width: 1.4em; padding: 1px 7px; border-radius: 5px; border: 1px solid alpha(currentColor, 0.28); }
.vx-mono { font-family: monospace; }
.vx-capture-caps { margin: 6px 0 2px 0; }
.vx-capture-caps .vx-cap { font-size: 1.05em; padding: 3px 11px; opacity: 1; }
.vx-caption { margin: 2px 14px 12px 14px; }
`;

function status(text, kind) {
    const box = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
    const dot = new Gtk.Box({valign: Gtk.Align.CENTER, css_classes: ['vx-dot', kind]});
    const label = new Gtk.Label({label: text, css_classes: ['dim-label']});
    box.append(dot);
    box.append(label);
    box.set = (newText, newKind, mono = false) => {
        label.set_label(newText);
        dot.set_css_classes(['vx-dot', newKind]);
        dot.set_visible(newKind !== 'none');
        label.set_css_classes(mono ? ['dim-label', 'vx-mono'] : ['dim-label']);
    };
    return box;
}

function capsBox(caps) {
    const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
    if (!caps) {
        box.append(new Gtk.Label({label: 'Not set', css_classes: ['dim-label']}));
        return box;
    }
    for (const cap of caps)
        box.append(new Gtk.Label({label: cap, css_classes: ['vx-cap', 'dim-label']}));
    box.update_property([Gtk.AccessibleProperty.LABEL], [caps.join(' ')]);
    return box;
}

// Swaps the caps inside `holder` for the caps of `caps` (null shows `Not set`).
function setCaps(holder, caps) {
    for (let child = holder.get_first_child(); child; child = holder.get_first_child())
        holder.remove(child);
    holder.append(capsBox(caps));
}

// The shortcut capture dialog. `onSaved` runs after the shortcut was written, `onClosed` when it is gone.
// Returns {dialog, close}.
function captureDialog(window, {verb, title, onSaved, onClosed}) {
    const dialog = new Adw.Dialog({title, content_width: 380});
    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 18, margin_bottom: 22, margin_start: 24, margin_end: 24});
    body.append(new Gtk.Label({
        label: 'Press the new shortcut. Esc cancels, Backspace turns it off.',
        wrap: true, justify: Gtk.Justification.CENTER,
    }));
    const capsHolder = new Gtk.Box({halign: Gtk.Align.CENTER, css_classes: ['vx-capture-caps']});
    const statusLabel = new Gtk.Label({wrap: true, justify: Gtk.Justification.CENTER, height_request: 44, valign: Gtk.Align.START, css_classes: ['dim-label']});
    body.append(capsHolder);
    body.append(statusLabel);
    const toolbar = new Adw.ToolbarView({content: body});
    toolbar.add_top_bar(new Adw.HeaderBar());
    dialog.set_child(toolbar);

    setCaps(capsHolder, readShortcuts()[verb]);
    let surface = null;
    let inhibitedId = 0;
    let done = false;
    let holdId = 0;
    let note = null;
    const say = (text, kind) => {
        statusLabel.set_label(text);
        statusLabel.set_css_classes(kind ? [kind] : ['dim-label']);
    };
    // The warning shows only while the compositor has not (yet) granted the pause.
    const syncPause = () => {
        if (note === null)
            say(surface?.shortcuts_inhibited ? '' : MSG_NOT_PAUSED, 'dim-label');
    };
    const message = (text, kind) => {
        note = text;
        say(text, kind);
    };
    const finish = () => {
        if (holdId) {
            GLib.source_remove(holdId);
            holdId = 0;
        }
        dialog.close();
    };

    const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
    keys.connect('key-pressed', (controller, keyval, _keycode, state) => {
        if (done || keyClass(keyval) === 'modifier')
            return true;
        // The event's own match gives the key without the Shift it consumed (Shift+1 is `1`, not `!`).
        let key = keyval;
        let mods = state;
        try {
            const [ok, matchKey, matchMods] = controller.get_current_event().get_match();
            if (ok) {
                key = matchKey;
                mods = matchMods;
            }
        } catch (_e) { /* the plain keyval and state do */ }
        const verdict = evaluateKey(key, mods);
        if (verdict.action === 'wait')
            return true;
        if (verdict.action === 'cancel') {
            done = true;
            finish();
            return true;
        }
        const accel = verdict.action === 'off' ? '' : pressedAccel(key, mods);
        if (verdict.action === 'refuse') {
            setCaps(capsHolder, capsFor(accel));
            message(verdict.message, 'warning');
            return true;
        }
        if (verdict.action === 'accept') {
            const conflict = findConflict(accel, {skipPath: entryFor(verb)?.path ?? null});
            if (conflict !== null) {
                setCaps(capsHolder, capsFor(accel));
                message(conflictMessage(conflict), 'error');
                return true;
            }
        }
        try {
            writeShortcut(verb, accel);
        } catch (e) {
            message(`Could not save: ${e.message}`, 'error');
            return true;
        }
        done = true;
        setCaps(capsHolder, accel === '' ? null : capsFor(accel));
        onSaved();
        // A beat to see what was captured, then the dialog goes.
        holdId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            holdId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    });
    dialog.add_controller(keys);

    dialog.connect('closed', () => {
        if (holdId) {
            GLib.source_remove(holdId);
            holdId = 0;
        }
        if (surface) {
            if (inhibitedId)
                surface.disconnect(inhibitedId);
            try {
                surface.restore_system_shortcuts();
            } catch (e) {
                console.warn(`${LOG} could not restore the system shortcuts: ${e.message}`);
            }
            surface = null;
        }
        onClosed();
    });

    dialog.present(window);
    // The toplevel that holds the dialog, asked once the dialog has a root. Without the pause, pressing the
    // current shortcut would run it instead of reaching the dialog.
    const native = dialog.get_root();
    surface = native?.get_surface?.() ?? null;
    if (surface) {
        try {
            surface.inhibit_system_shortcuts(null);
            inhibitedId = surface.connect('notify::shortcuts-inhibited', syncPause);
        } catch (e) {
            console.warn(`${LOG} could not pause the system shortcuts: ${e.message}`);
        }
    }
    syncPause();
    return {dialog, close: () => finish()};
}

// A combo row over an enum key: the nick is the stored value.
function enumRow(settings, key, title, subtitle, items, onChange) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(items.map(([, label]) => label))});
    const nicks = items.map(([nick]) => nick);
    const sync = () => {
        const index = nicks.indexOf(settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    sync();
    const selectedId = row.connect('notify::selected', () => {
        const nick = nicks[row.selected];
        if (nick && settings.get_string(key) !== nick) {
            settings.set_string(key, nick);
            onChange?.(nick);
        }
    });
    const changedId = settings.connect(`changed::${key}`, sync);
    row.dispose_ = () => {
        row.disconnect(selectedId);
        settings.disconnect(changedId);
    };
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class VoxtypePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const cancellable = new Gio.Cancellable();
        const cleanups = [];

        const css = new Gtk.CssProvider();
        if (typeof css.load_from_string === 'function')
            css.load_from_string(CSS);
        else
            css.load_from_data(CSS, -1);
        const display = Gdk.Display.get_default();
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        cleanups.push(() => Gtk.StyleContext.remove_provider_for_display(display, css));

        window.set_default_size(640, 860);
        window.set_search_enabled(false);
        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- Preview ------------------------------------------------------------------------------------
        const preview = new Adw.PreferencesGroup({title: 'Preview'});
        const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['card']});
        const area = new Gtk.DrawingArea({accessible_role: Gtk.AccessibleRole.IMG, content_height: SCREEN_PX, hexpand: true, margin_top: 10, margin_start: 10, margin_end: 10});
        card.append(area);
        const controls = new Gtk.Box({spacing: 4, margin_top: 8, margin_start: 6, margin_end: 8});
        const chipsBox = new Gtk.Box({spacing: 2, hexpand: true});
        const chips = [];
        const hairs = [];
        STATES.forEach(({chip}, i) => {
            const column = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
            const button = new Gtk.ToggleButton({label: chip, css_classes: ['vx-chip', 'flat']});
            if (i > 0)
                button.set_group(chips[0]);
            const hair = new Gtk.ProgressBar({css_classes: ['vx-hair'], opacity: 0});
            column.append(button);
            column.append(hair);
            chipsBox.append(column);
            chips.push(button);
            hairs.push(hair);
        });
        const play = new Gtk.Button({icon_name: 'media-playback-pause-symbolic', css_classes: ['circular', 'flat'], valign: Gtk.Align.START});
        controls.append(chipsBox);
        controls.append(play);
        card.append(controls);
        const caption = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['dim-label', 'vx-caption'], label: ''});
        card.append(caption);
        preview.add(card);
        page.add(preview);

        const tour = new Preview({area, chips, hairs, play, caption, settings, settingsGtk: Gtk.Settings.get_default()});
        area.update_property([Gtk.AccessibleProperty.LABEL], ['Preview of the top-bar orb and the pill']);
        area.set_draw_func((_a, cr, width, height) => tour.draw(cr, width, height));
        tour.connect();
        this._tour = tour;
        cleanups.push(() => tour.destroy());

        // --- Top bar and pill -----------------------------------------------------------------------------
        const bar = new Adw.PreferencesGroup({title: 'Top bar and pill'});
        const pillRow = switchRow(settings, 'show-pill', 'Pill', 'The status pill at the top of the screen. It never takes focus.');
        const monitorRow = enumRow(settings, 'pill-monitor', 'Show the pill on', null,
            [['focused', 'Focused window'], ['primary', 'Primary monitor']]);
        // `never` with the pill off would hide the extension: choosing it turns the pill on and locks its switch.
        const syncHiding = () => {
            const never = settings.get_string('panel-orb') === 'never';
            if (never && !settings.get_boolean('show-pill'))
                settings.set_boolean('show-pill', true);
            pillRow.set_sensitive(!never);
            pillRow.set_subtitle(never
                ? 'The pill stays on while the top-bar orb is never shown.'
                : 'The status pill at the top of the screen. It never takes focus.');
            monitorRow.set_sensitive(never || settings.get_boolean('show-pill'));
        };
        const orbRow = enumRow(settings, 'panel-orb', 'Top-bar orb', 'Where the orb shows in the top bar.',
            [['always', 'Always'], ['busy', 'Only while busy'], ['never', 'Never']], syncHiding);
        const motionRow = enumRow(settings, 'motion', 'Orb motion', 'Follow GNOME’s animation setting, or hold one still frame.',
            [['follow', 'Follow GNOME'], ['still', 'Always still']]);
        for (const row of [orbRow, pillRow, monitorRow, motionRow])
            bar.add(row);
        page.add(bar);
        const hidingIds = ['panel-orb', 'show-pill'].map(key => settings.connect(`changed::${key}`, syncHiding));
        syncHiding();
        cleanups.push(() => {
            hidingIds.forEach(id => settings.disconnect(id));
            for (const row of [orbRow, monitorRow, motionRow])
                row.dispose_();
        });

        // --- Messages -------------------------------------------------------------------------------------
        const messages = new Adw.PreferencesGroup({title: 'Messages'});
        messages.add(switchRow(settings, 'mic-hints', 'Warn about the microphone',
            'Say “Can’t hear you” or “No signal” when there is evidence.'));
        messages.add(switchRow(settings, 'receipt', 'Receipt when done', 'Show “Done” for half a second after transcribing.'));
        const stillRow = new Adw.SpinRow({
            title: '“Still transcribing…” after',
            subtitle: 'Seconds of transcribing before the pill says so.',
            adjustment: new Gtk.Adjustment({lower: 3, upper: 60, step_increment: 1, page_increment: 5, value: 8}),
        });
        settings.bind('still-seconds', stillRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        messages.add(stillRow);
        page.add(messages);

        // --- Controls -------------------------------------------------------------------------------------
        const controlsGroup = new Adw.PreferencesGroup({
            title: 'Controls',
            description: 'The extension never records by itself. These start only when you choose them.',
        });
        controlsGroup.add(switchRow(settings, 'menu-controls', 'Start, stop and cancel from the menu',
            'Runs <tt>voxtype record …</tt> when you choose an item.'));
        const shortcutsOk = shortcutsAvailable();
        const holders = {};
        let capture = null;
        const refreshCaps = () => {
            const caps = readShortcuts();
            for (const verb of Object.keys(holders))
                setCaps(holders[verb], caps[verb]);
        };
        for (const [verb, title] of [['toggle', 'Toggle dictation'], ['cancel', 'Cancel dictation']]) {
            const row = new Adw.ActionRow({title, subtitle: 'Also in GNOME Settings › Keyboard › Custom Shortcuts', activatable: shortcutsOk});
            const holder = new Gtk.Box({valign: Gtk.Align.CENTER});
            const change = new Gtk.Button({label: 'Change…', valign: Gtk.Align.CENTER, css_classes: ['flat'], sensitive: shortcutsOk});
            change.update_property([Gtk.AccessibleProperty.LABEL], [`Change the ${title.toLowerCase()} shortcut`]);
            if (!shortcutsOk) {
                change.set_tooltip_text(MSG_UNAVAILABLE);
                row.set_tooltip_text(MSG_UNAVAILABLE);
            }
            holders[verb] = holder;
            row.add_suffix(holder);
            row.add_suffix(change);
            const open = () => {
                capture?.close();
                const mine = captureDialog(window, {
                    verb, title, onSaved: refreshCaps,
                    onClosed: () => {
                        if (capture === mine)
                            capture = null;
                    },
                });
                capture = mine;
            };
            change.connect('clicked', open);
            row.connect('activated', open);
            controlsGroup.add(row);
        }
        refreshCaps();
        this._capture = () => capture;
        cleanups.push(() => capture?.close());
        page.add(controlsGroup);

        // --- Voxtype --------------------------------------------------------------------------------------
        const voxtype = new Adw.PreferencesGroup({
            title: 'Voxtype',
            description: 'What the extension sees right now. Nothing here is a setting.',
        });
        const rows = {};
        for (const [key, title] of [['daemon', 'Daemon'], ['feed', 'Voice feed'],
            ['model', 'Model'], ['silence', 'Auto-stop on silence']]) {
            const row = new Adw.ActionRow({title});
            const suffix = status('Checking…', 'mute');
            row.add_suffix(suffix);
            voxtype.add(row);
            rows[key] = {row, suffix};
        }
        rows.model.row.set_subtitle('From Voxtype’s own config.');
        rows.silence.row.set_subtitle('From Voxtype’s own config.');
        page.add(voxtype);
        this._fillVoxtype(rows, cancellable, cleanups);

        // --- About ----------------------------------------------------------------------------------------
        const about = new Adw.PreferencesGroup({title: 'About'});
        const version = new Adw.ActionRow({title: 'Dictation Indicator for Voxtype', subtitle: 'A quiet status orb for Voxtype. GPL-2.0-or-later.'});
        version.add_suffix(new Gtk.Label({label: this.metadata['version-name'] ?? '', css_classes: ['dim-label']}));
        about.add(version);
        const url = this.metadata.url;
        for (const [title, uri] of [['Source code', url], ['Report an issue', `${url}/issues`]]) {
            const row = new Adw.ActionRow({title, activatable: true, tooltip_text: uri});
            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
            row.connect('activated', () => this._open(window, uri));
            about.add(row);
        }
        about.add(new Adw.ActionRow({title: 'Credits', subtitle: 'Thinking orbs by Jakub Antalík (MIT).'}));
        page.add(about);

        window.connect('close-request', () => {
            cancellable.cancel();
            for (const cleanup of cleanups.splice(0))
                cleanup();
            return false;
        });
    }

    async _open(window, uri) {
        try {
            await new Gtk.UriLauncher({uri}).launch(window, null);
        } catch (e) {
            console.warn(`${LOG} could not open ${uri}: ${e.message}`);
            window.add_toast(new Adw.Toast({title: 'Could not open the link'}));
        }
    }

    // Each row is read once when the window opens, asynchronously. One cancellable ends every read on close.
    _fillVoxtype(rows, cancellable, cleanups) {
        const alive = () => !cancellable.is_cancelled();

        const runtimeDir = GLib.get_user_runtime_dir();
        let source = null;
        source = new VoxtypeStateSource({
            runtimeDir,
            onView: view => {
                source?.stop();
                source = null;
                if (!alive() || view.mode === MODE_KEEP)
                    return;
                if (view.mode === MODE_OFFLINE) {
                    rows.daemon.suffix.set('Not running', 'warn');
                    rows.daemon.row.set_subtitle('Start it with <tt>systemctl --user start voxtype</tt>');
                } else {
                    const word = view.mode === MODE_RECORDING ? 'recording' : view.mode === MODE_TRANSCRIBING ? 'transcribing' : 'idle';
                    rows.daemon.suffix.set(`Running · ${word}`, 'ok');
                }
            },
        });
        source.start();
        cleanups.push(() => {
            source?.stop();
            source = null;
        });

        const socket = Gio.File.new_for_path(`${stateDirPath(runtimeDir)}/audio.sock`);
        socket.query_info_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable).then(() => {
            if (!alive())
                return;
            rows.feed.suffix.set('Available', 'ok');
            rows.feed.row.set_subtitle('The orb follows your voice from Voxtype’s level socket.');
        }).catch(e => {
            if (!alive())
                return;
            rows.feed.suffix.set('Not available', 'mute');
            rows.feed.row.set_subtitle('The orb swells on its own and the pill says “Listening…”.');
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.debug(`${LOG} audio.sock: ${e.message}`);
        });

        const failed = what => e => console.warn(`${LOG} preferences: ${what}: ${e.message}`);

        runRead(['voxtype', 'config', 'get', 'whisper.model'], cancellable).then(out => {
            if (!alive())
                return;
            const model = out === null ? '' : stripQuotes(out);
            if (model)
                rows.model.suffix.set(model, 'none', true);
            else
                rows.model.suffix.set('Unknown', 'mute');
        }).catch(failed('model'));

        runRead(['voxtype', 'config', 'get', 'audio.external_trigger_silence_timeout_secs'], cancellable).then(out => {
            if (!alive())
                return;
            const label = silenceLabel(out);
            rows.silence.suffix.set(label ?? 'Unknown', label === null ? 'mute' : 'none');
        }).catch(failed('auto-stop'));
    }
}
