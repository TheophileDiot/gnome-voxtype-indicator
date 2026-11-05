// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    MODE_IDLE, MODE_OFFLINE, MODE_RECORDING, MODE_TRANSCRIBING, VIEW_IDLE, UnredirectHold, VoiceTracker,
    buttonShown, capsFor, displayFor, isBusy, menuFor, receiptAllowed, receiptFor, shortcutBindings,
} from './common.js';
import {VoxtypeLevelSource} from './levels.js';
import {MORPH_MS, breakDots, checkDots, easeOutQuad, primeTrace, sashFade, through, unfold} from './morph.js';
import {ORBS, ORB_SIZE, SEED_IDLE, SEED_OFFLINE, seedIdle, seedOffline} from './orb.js';
import {VoxtypeStateSource, VoxtypeUnitWatch} from './source.js';
import {createTrace} from './trace.js';

const LOG = '[Dictation Indicator]';
// The Shell's own OSD fades 100 ms with EASE_OUT_QUAD both ways; an exit is never slower than the entrance.
const FADE_IN_MS = 150;
const FADE_OUT_MS = 100;
const RISE_MS = 180;
const PILL_GAP = 12;
// The pill rises 0.4em as it arrives and a receipt exit lifts it 0.2em.
const RISE_EM = 0.4;
const LIFT_EM = 0.2;
// Upstream tunes the 20 px preset for a 2x canvas; here it is drawn into 16 device pixels, so most dots cover
// less than a pixel and the orb is faint. Growing every radius by 1.5 restores the contrast.
// shortcut: tuned at scale factor 1 only, re-check on a scale-2 display where the dots may merge.
// The composing orb only: the trace's radii are final.
const DOT_GAIN = 1.5;

// Recording is a frame-clock timeline; its length only bounds one Clutter loop, the trace keeps its own time.
const TRACE_LOOP_MS = 1000;
// With animations off the voice is read twice a second and the trace repaints only when it changes.
const STILL_TICK_MS = 500;
// The red-to-white ink slide of the unfold.
const INK_SLIDE_MS = 150;
const SEED_OPEN_MS = 150;
const SEED_CLOSE_MS = 120;
// The receipt hold starts here, measured from the receipt start.
const RECEIPT_HOLD_AT_MS = 400;
const RECEIPT_DONE_MS = 500;
const RECEIPT_NOTHING_MS = 1500;
// The receipt glyph is drawn complete this long before its clock is removed, so the last frame is the full glyph.
const RECEIPT_MARGIN_MS = 34;
const LABEL_OUT_MS = 60;
const LABEL_IN_MS = 90;
const GLIDE_MS = 200;
const MENU_OUT_MS = 90;
const MENU_IN_MS = 150;
const CHIP_CHECK_MS = 1200;

const LABEL_LISTENING = 'Listening…';
const LABEL_CANT_HEAR = 'Can\'t hear you';
const LABEL_NO_SIGNAL = 'No signal';
const LABEL_STILL_TRANSCRIBING = 'Still transcribing…';
const LABEL_DONE = 'Done';
const LABEL_NOTHING = 'Nothing heard';

// Hint from the voice tracker -> pill label and the suffix of the button's accessible name.
const HINTS = {
    'listening': {label: LABEL_LISTENING, suffix: ''},
    'cant-hear': {label: LABEL_CANT_HEAR, suffix: ': can\'t hear you'},
    'no-signal': {label: LABEL_NO_SIGNAL, suffix: ': no signal'},
};
// Every label a busy period can show: the pill reserves the widest, so it never re-centres per hint.
const LABELS_FOR_MODE = {
    [MODE_RECORDING]: [LABEL_LISTENING, LABEL_CANT_HEAR, LABEL_NO_SIGNAL],
    [MODE_TRANSCRIBING]: ['Transcribing…', LABEL_STILL_TRANSCRIBING, LABEL_DONE, LABEL_NOTHING],
};
// The menu header's hint suffixes (menuFor), shown at weight 400 and 60% alpha.
const HEADER_SUFFIXES = [' · can\'t hear you', ' · no signal'];
// Which shortcut a menu action teaches.
const CAP_VERB = {start: 'toggle', stop: 'toggle', cancel: 'cancel'};

// The peak-free voice a primed trace has heard: a live, quiet feed.
const QUIET = {feed: 'live', peak: 0, gate: false, onsets: 0};

const SURFACES = ['bar', 'pill', 'header'];

// The Shell's own OSD inhibits unredirect while it shows: GNOME 48 moved the call from Meta to the compositor.
// Feature-detected, so a shell with neither API still runs (the pill may then vanish over a maximised window on a
// monitor without a panel).
function unredirectCalls() {
    const compositor = global.compositor;
    if (typeof compositor?.disable_unredirect === 'function')
        return [() => compositor.disable_unredirect(), () => compositor.enable_unredirect()];
    if (typeof Meta.disable_unredirect_for_display === 'function') {
        return [() => Meta.disable_unredirect_for_display(global.display),
            () => Meta.enable_unredirect_for_display(global.display)];
    }
    return [null, null];
}

const lerpInk = (a, b, f) => a.map((c, i) => c + (b[i] - c) * f);
const escapeMarkup = text => GLib.markup_escape_text(text, -1);

export default class VoxtypeIndicatorExtension extends Extension {
    enable() {
        this._mode = null;
        this._view = VIEW_IDLE;
        this._orbTimeline = null;
        this._orbFrameId = 0;
        this._tickId = 0;
        this._stillId = 0;
        this._receiptId = 0;
        this._elapsedId = 0;
        this._chipId = 0;
        this._orbT = 0;
        this._sashFrame = null;
        this._traceDots = [];
        this._trace = null;
        this._hint = 'listening';
        this._voiceHint = 'listening';
        this._viewName = '';
        this._lastTickUs = 0;
        this._transcribeUs = 0;
        this._busyStartUs = 0;
        this._stillKey = null;
        this._heardFeed = null;
        this._cancelled = false;
        this._pillOn = false;
        // Owned apart from `_pillOn`, which turns false before the exit fade ends: held from the pill's show to its hide.
        this._unredirect = new UnredirectHold(...unredirectCalls());
        this._child = null;
        this._pillSwitch = null;
        this._rows = [];
        this._caps = {};
        this._menuLight = false;
        this._menuFade = false;
        this._chipIcon = null;
        this._tr = null;
        this._oneShot = null;
        this._oneShotIds = [];
        this._open = 0;
        this._openTarget = 0;
        this._openFrom = 0;
        this._openStartUs = 0;
        this._openDurationMs = 0;
        this._openTimeline = null;
        this._openIds = [];
        this._hover = this._focused = this._pressed = this._menuOpen = false;
        this._labelWant = '';
        this._labelFading = false;
        this._glide = null;
        this._menuId = 0;
        this._inkCache = new Map();
        this._tracker = new VoiceTracker();
        this._cancellable = new Gio.Cancellable();
        this._settings = this.getSettings();

        // Each surface remembers the layers {dots, ink} it last painted, so a transition can start from them.
        this._surf = {
            bar: {area: null, layers: [], light: false, gain: DOT_GAIN},
            pill: {area: null, layers: [], light: false, gain: DOT_GAIN},
            header: {area: null, layers: [], light: false, gain: 1},
        };
        this._surf.bar.area = this._newOrb('bar');
        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._button.add_child(this._surf.bar.area);
        this._button.hide();
        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._button);
        this._menuId = this._button.menu.connect('open-state-changed', (_menu, open) => this._onMenuOpen(open));
        this._buttonIds = [
            this._button.connect('notify::hover', () => this._pointer('_hover', this._button.hover)),
            this._button.connect('key-focus-in', () => this._pointer('_focused', true)),
            this._button.connect('key-focus-out', () => this._pointer('_focused', false)),
            this._button.connect('button-press-event', () => {
                this._pointer('_pressed', true);
                return Clutter.EVENT_PROPAGATE;
            }),
            this._button.connect('button-release-event', () => {
                this._pointer('_pressed', false);
                return Clutter.EVENT_PROPAGATE;
            }),
        ];
        this._rebuildMenu();

        // Never added through addChrome and never reactive: no struts, no input region, no focus.
        this._surf.pill.area = this._newOrb('pill');
        this._label = new St.Label({style_class: 'voxtype-label', y_align: Clutter.ActorAlign.CENTER});
        // Reads the ink of each state class from the stylesheet; it is never shown.
        this._probe = new St.Widget({style_class: 'voxtype-orb', visible: false});
        this._pill = new St.BoxLayout({
            style_class: 'voxtype-pill',
            reactive: false,
            can_focus: false,
            track_hover: false,
            visible: false,
            opacity: 0,
        });
        this._pill.add_child(this._surf.pill.area);
        this._pill.add_child(this._label);
        this._pill.add_child(this._probe);
        Main.layoutManager.uiGroup.add_child(this._pill);

        const settings = St.Settings.get();
        this._contrastId = settings.connect('notify::high-contrast', () => this._syncContrast());
        this._animationsId = settings.connect('notify::enable-animations', () => this._syncClock());
        // A light/dark switch while recording must recolour the orb too, not only a mode change.
        this._panelStyleId = Main.panel.connect('style-changed', () => this._setPanelTone());
        // The inks are read from the stylesheet and cached; a new theme empties the cache.
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._themeId = this._themeContext.connect('changed', () => {
            this._inkCache.clear();
            this._setPanelTone(true);
        });
        this._syncContrast();

        // Every key applies live; one handler per key, all disconnected in disable().
        const handlers = {
            'panel-orb': () => {
                this._syncButton();
                this._syncPill();
            },
            'show-pill': () => {
                this._pillSwitch?.setToggleState(this._settings.get_boolean('show-pill'));
                this._syncPill();
            },
            'pill-monitor': () => {
                if (this._pillOn)
                    this._placePill();
            },
            'mic-hints': () => {
                if (this._mode === MODE_RECORDING)
                    this._applyHint(this._voiceHint);
            },
            'receipt': () => {
                if (this._receiptId && !this._settings.get_boolean('receipt')) {
                    this._clearReceipt();
                    this._hidePill();
                }
            },
            'still-seconds': () => this._armStill(),
            'motion': () => this._syncClock(),
            'menu-controls': () => this._rebuildMenu(),
        };
        this._settingIds = Object.entries(handlers).map(([key, fn]) => this._settings.connect(`changed::${key}`, fn));

        // Created now, connects only while recording: nothing runs while idle.
        this._levelSource = new VoxtypeLevelSource({
            runtimeDir: GLib.get_user_runtime_dir(),
            onFrames: (frames, arrivalUs) => this._tracker?.pushFrames(frames, arrivalUs),
            onConnected: connected => this._tracker?.setConnected(connected),
        });
        this._source = new VoxtypeStateSource({
            runtimeDir: GLib.get_user_runtime_dir(),
            onView: view => this._render(view),
            onCancel: () => {
                this._cancelled = true;
            },
        });
        this._source.start();
        this._unitWatch = new VoxtypeUnitWatch({onActiveState: state => this._source?.noteUnitState(state)});
        this._unitWatch.start();
    }

    disable() {
        // First: destroying an open menu closes it, and that callback would reach the torn-down fields.
        if (this._menuId)
            this._button?.menu.disconnect(this._menuId);
        this._menuId = 0;
        this._unitWatch?.stop();
        this._unitWatch = null;
        this._source?.stop();
        this._source = null;
        this._levelSource?.stop();
        this._levelSource = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._child?.force_exit();
        this._child = null;
        this._stopClock();
        this._stopOpenTween();
        this._tr = null;
        this._clearStillTimer();
        this._clearReceipt();
        this._clearElapsed();
        this._clearChipTimer();
        for (const id of this._settingIds ?? [])
            this._settings.disconnect(id);
        this._settingIds = [];
        this._settings = null;
        const settings = St.Settings.get();
        if (this._contrastId)
            settings.disconnect(this._contrastId);
        if (this._animationsId)
            settings.disconnect(this._animationsId);
        if (this._panelStyleId)
            Main.panel.disconnect(this._panelStyleId);
        if (this._themeId)
            this._themeContext.disconnect(this._themeId);
        this._contrastId = this._animationsId = this._panelStyleId = this._themeId = 0;
        this._themeContext = null;
        this._pill?.remove_all_transitions();
        // A fade cut short never reaches its onComplete, so the hold is lifted here.
        this._unredirect?.release();
        this._unredirect = null;
        this._label?.remove_all_transitions();
        for (const row of this._rows)
            row.remove_all_transitions?.();
        this._header?.remove_all_transitions();
        this._headerText?.remove_all_transitions();
        this._button?.menu.box.remove_all_transitions();
        for (const id of this._buttonIds ?? [])
            this._button?.disconnect(id);
        this._buttonIds = [];
        this._button?.destroy();
        this._pill?.destroy();
        this._label = this._button = this._pill = this._pillSwitch = this._probe = null;
        this._header = this._headerText = this._titleLabel = this._lineLabel = this._chipIcon = null;
        this._rows = [];
        this._surf = this._inkCache = null;
        this._tracker = this._trace = this._heardFeed = this._sashFrame = this._oneShot = null;
        this._traceDots = [];
        this._mode = null;
    }

    _display() {
        return displayFor({
            panelOrb: this._settings.get_string('panel-orb'),
            showPill: this._settings.get_boolean('show-pill'),
        });
    }

    // The source only reports mode changes, so every call here is a real transition.
    _render(view) {
        const prev = this._mode;
        console.debug(`${LOG} ${prev} -> ${view.mode}`);
        // Before anything else, so a click during the fade can spawn nothing.
        this._markStale();
        // What each surface painted last, and whether a transition was already running (a settled Seed unfolds).
        const settled = !this._tr;
        const from = this._snapshot();
        this._view = view;
        this._mode = view.mode;
        this._setPanelTone();
        // A new view ends everything the old one left running, a receipt included.
        this._cancelRunning(prev);

        if (isBusy(view.mode)) {
            // A cancel flag belongs to one busy period; recording -> transcribing is the same period.
            if (!isBusy(prev)) {
                this._cancelled = false;
                this._busyStartUs = GLib.get_monotonic_time();
            }
            this._enterBusy(view, prev, from, settled);
        } else {
            const idle = view.mode === MODE_IDLE;
            const allowed = receiptAllowed(prev, view);
            const receipt = allowed
                ? receiptFor({...(this._heardFeed ?? {heard: false, feedSeenMs: 0}), cancelled: this._cancelled})
                : null;
            const withdraw = isBusy(prev) && idle && (this._cancelled || prev === MODE_RECORDING || !allowed);
            this._heardFeed = null;
            const showReceipt = receipt && this._display().showPill && this._settings.get_boolean('receipt');
            this._enterRest(view, prev, from, settled, showReceipt ? receipt : null, withdraw);
            if (showReceipt)
                this._showReceipt(receipt);
            else
                this._hidePill();
        }
        this._followMode(view.mode, prev);
    }

    // Stops the clock, the still timeout and the receipt, and closes the level source on leaving recording.
    _cancelRunning(prev) {
        this._stopClock();
        this._stopOpenTween();
        this._clearStillTimer();
        this._clearReceipt();
        this._tr = null;
        if (prev === MODE_RECORDING) {
            this._levelSource.stop();
            // Only these two survive into transcribing, for the receipt.
            const {heard, feedSeenMs} = this._tracker.snapshot(GLib.get_monotonic_time());
            this._heardFeed = {heard, feedSeenMs};
        }
    }

    _enterBusy(view, prev, from, settled) {
        const wasShown = this._pillOn && this._pill.visible;
        this._viewName = view.name;
        this._hint = 'listening';
        this._voiceHint = 'listening';
        const animated = this._animationsEnabled();
        if (view.mode === MODE_RECORDING) {
            this._heardFeed = null;
            this._trace = createTrace();
            // A recording starts with a past: the trace already has six columns when the Seed unfolds into it.
            if (animated)
                primeTrace(this._trace, QUIET);
            this._traceDots = [];
            this._stillKey = null;
            this._tracker.reset(GLib.get_monotonic_time());
            this._levelSource.start();
        } else {
            this._setSashT(ORBS.composing.stillT);
            this._transcribeUs = GLib.get_monotonic_time();
            this._armStill();
        }
        if (prev !== null && animated) {
            if (view.mode === MODE_RECORDING && prev === MODE_IDLE && settled)
                this._beginTransition('unfold', MORPH_MS.unfold, from);
            else
                this._beginTransition('through', MORPH_MS.handoff, from, {gather: 120, bloom: 50});
        }
        // The first frame is composed before the pill or the button show, so nothing paints an empty orb.
        this._startClock();
        this._button.accessible_name = view.name;
        this._syncButton();
        this._setLabel(view.label, !wasShown);
        // The widest label of the mode; the pill glides to it once, at the hand-off, and never on a hint change.
        const oldWidth = this._label.width;
        const oldX = this._pill.x;
        this._reserveLabelWidth(view.mode);
        if (this._display().showPill) {
            this._showPill();
            if (animated && wasShown && prev === MODE_RECORDING && view.mode === MODE_TRANSCRIBING)
                this._glidePill(oldWidth, oldX);
        } else {
            this._hidePill();
        }
    }

    // Idle and not running: the top-bar orb paints a still Seed, with no clock when nothing moves.
    _enterRest(view, prev, from, settled, receipt, withdraw) {
        if (prev !== null && this._animationsEnabled()) {
            const idle = view.mode === MODE_IDLE;
            if (receipt) {
                this._beginTransition('receipt', receipt === 'nothing-heard' ? 60 + 26 * 5 + 200 : 60 + 26 * 7 + 200,
                    from, {receipt});
            } else if (withdraw) {
                this._beginTransition('through', MORPH_MS.withdraw, from, {gather: 120, bloom: 80});
            } else if (isBusy(prev) && !idle) {
                this._beginTransition('through', 220, from, {gather: 140, bloom: 60});
            } else if (!isBusy(prev) && prev !== view.mode) {
                if (settled)
                    this._beginTransition('break', idle ? MORPH_MS.breakBack : MORPH_MS.breakOut, from, {back: idle});
                else
                    this._beginTransition('through', MORPH_MS.handoff, from, {gather: 120, bloom: 50});
            }
        }
        this._button.accessible_name = view.name;
        this._syncButton();
        this._composeAll(0);
        if (this._tr)
            this._startOneShot();
    }

    // The pill draws a check (or a flat line) over the fading sash; the button already
    // shows the Seed. The hold starts at 400 ms, then the pill leaves with a 0.2em lift.
    _showReceipt(receipt) {
        const nothing = receipt === 'nothing-heard';
        if (!this._tr) {
            // Still: the finished glyph at once, and the same hold.
            this._surf.pill.layers = [{dots: nothing ? checkDots('nothing-heard', 1000) : checkDots('done', 1000),
                ink: this._ink(MODE_TRANSCRIBING, this._surf.pill)}];
            this._surf.pill.area.queue_repaint();
        }
        this._pillOn = true;
        this._pill.remove_all_transitions();
        this._setLabel(nothing ? LABEL_NOTHING : LABEL_DONE, false);
        this._unredirect.acquire();
        this._pill.show();
        this._pill.opacity = 255;
        this._pill.translation_y = 0;
        this._receiptId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, RECEIPT_HOLD_AT_MS + (nothing ? RECEIPT_NOTHING_MS : RECEIPT_DONE_MS), () => {
                this._receiptId = 0;
                this._hidePill({lift: true});
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearReceipt() {
        if (!this._receiptId)
            return;
        GLib.source_remove(this._receiptId);
        this._receiptId = 0;
    }

    // The "Still transcribing…" one-shot, measured from the start of transcribing so a changed
    // `still-seconds` applies to a period already running.
    _armStill() {
        this._clearStillTimer();
        if (this._mode !== MODE_TRANSCRIBING)
            return;
        const left = this._settings.get_int('still-seconds') * 1000 - (GLib.get_monotonic_time() - this._transcribeUs) / 1000;
        if (left <= 0) {
            this._setLabel(LABEL_STILL_TRANSCRIBING, false);
            return;
        }
        this._stillId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(left), () => {
            this._stillId = 0;
            this._setLabel(LABEL_STILL_TRANSCRIBING, false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearStillTimer() {
        if (!this._stillId)
            return;
        GLib.source_remove(this._stillId);
        this._stillId = 0;
    }

    // The top-bar button follows `panel-orb` and the mode; hiding it closes its menu.
    _syncButton() {
        if (!this._button)
            return;
        const shown = this._mode !== null && buttonShown(this._display().panelOrb, this._mode);
        if (shown) {
            this._button.show();
        } else {
            this._button.menu.close();
            this._button.hide();
        }
    }

    // `show-pill` / `panel-orb` changed: bring the pill in line with the current mode.
    _syncPill() {
        if (!this._pill)
            return;
        const {showPill} = this._display();
        if (isBusy(this._mode)) {
            if (showPill && !this._pillOn)
                this._showPill();
            else if (!showPill && this._pillOn)
                this._hidePill();
        } else if (!showPill && this._pillOn) {
            this._clearReceipt();
            this._hidePill();
        }
    }

    // The red and amber are tuned for a dark panel. Light shell styles paint the panel #fafafb, where they fall
    // under 3:1, so the stylesheet carries darker variants under .light-panel (the Seed's ink too). The tone is a
    // flag of the top-bar surface: its layers carry the ink, so a switch recomposes them.
    _setPanelTone(force = false) {
        if (!this._surf)
            return;
        const {red, green, blue} = Main.panel.get_theme_node().get_background_color();
        const light = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 > 0.5;
        if (light === this._surf.bar.light && !force)
            return;
        this._surf.bar.light = light;
        if (this._mode !== null && !this._tr && !isBusy(this._mode))
            this._composeAll(0);
    }

    // Same treatment as the Shell's own pill: an opaque surface and a stronger edge.
    _syncContrast() {
        if (St.Settings.get().high_contrast)
            this._pill.add_style_class_name('high-contrast');
        else
            this._pill.remove_style_class_name('high-contrast');
    }

    // --- menu and actions -----------------------------------------------------------------------

    _onMenuOpen(open) {
        this._pointer('_menuOpen', open);
        if (!open) {
            this._clearElapsed();
            this._clearChipTimer();
            return;
        }
        // One liveness read per open: the only check an idle daemon gets besides the systemd watch.
        this._source?.refresh();
        const caps = this._readShortcuts();
        const toneChanged = this._syncMenuTone();
        if (toneChanged || JSON.stringify(caps) !== JSON.stringify(this._caps)) {
            this._caps = caps;
            this._rebuildMenu();
        }
        this._composeAll(0);
        // The elapsed line is as old as the last tick: bring it up to date before the first one.
        this._updateHeader();
        this._syncElapsed();
    }

    // The header is built once and persists: its orb keeps painting through a state change.
    _buildMenu() {
        const menu = this._button.menu;
        menu.actor.add_style_class_name('voxtype-menu');
        menu.box.add_style_class_name('voxtype-menu-box');
        this._header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._header.add_style_class_name('voxtype-header');
        // A non-reactive item is styled insensitive (greyed); the header is the menu's title, not a disabled row.
        this._header.remove_style_pseudo_class('insensitive');
        this._surf.header.area = this._newOrb('header');
        this._header.add_child(this._surf.header.area);
        const text = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._titleLabel = new St.Label({style_class: 'voxtype-title'});
        this._lineLabel = new St.Label({style_class: 'voxtype-line', opacity: 158});
        text.add_child(this._titleLabel);
        text.add_child(this._lineLabel);
        this._headerText = text;
        this._header.add_child(text);
        menu.addMenuItem(this._header);
    }

    // Title with the hint suffix in markup only (the text stays the plain state string), and the second line:
    // `Ready` while idle, the elapsed time while busy.
    _updateHeader() {
        if (!this._titleLabel)
            return;
        const {header} = menuFor(this._view, {controls: true, hint: this._hint});
        const suffix = HEADER_SUFFIXES.find(s => header.endsWith(s)) ?? '';
        const title = header.slice(0, header.length - suffix.length);
        const markup = `<b>${escapeMarkup(title)}</b>` +
            (suffix ? `<span weight="normal" alpha="60%">${escapeMarkup(suffix)}</span>` : '');
        this._titleLabel.clutter_text.set_markup(markup);
        const mode = this._view.mode;
        const line = mode === MODE_IDLE ? 'Ready' : isBusy(mode) ? this._elapsedText() : '';
        this._lineLabel.text = line;
        this._lineLabel.visible = line !== '';
    }

    _elapsedText() {
        const seconds = Math.max(0, Math.floor((GLib.get_monotonic_time() - this._busyStartUs) / 1e6));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    // One 1 s timeout, only while the menu is open and busy.
    _syncElapsed() {
        this._clearElapsed();
        if (!this._button.menu.isOpen || !isBusy(this._mode))
            return;
        this._elapsedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._updateHeader();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearElapsed() {
        if (!this._elapsedId)
            return;
        GLib.source_remove(this._elapsedId);
        this._elapsedId = 0;
    }

    // The user's GNOME custom shortcuts that run `voxtype record toggle|cancel`, read once on
    // every open. A shortcut that is not found shows no caps; nothing is invented. Reads only.
    _readShortcuts() {
        const schemaId = 'org.gnome.settings-daemon.plugins.media-keys';
        const source = Gio.SettingsSchemaSource.get_default();
        const found = {};
        if (!source?.lookup(schemaId, true) || !source.lookup(`${schemaId}.custom-keybinding`, true))
            return found;
        try {
            const entries = new Gio.Settings({schema_id: schemaId}).get_strv('custom-keybindings').map(path => {
                const entry = Gio.Settings.new_with_path(`${schemaId}.custom-keybinding`, path);
                return {command: entry.get_string('command'), binding: entry.get_string('binding')};
            });
            const bindings = shortcutBindings(entries);
            for (const verb of Object.keys(bindings)) {
                const caps = capsFor(bindings[verb] ?? '');
                if (caps)
                    found[verb] = caps;
            }
        } catch (e) {
            console.debug(`${LOG} cannot read the custom shortcuts: ${e.message}`);
        }
        return found;
    }

    // Light or dark menu: the cap and chip hairlines follow the menu's foreground.
    _syncMenuTone() {
        const {red, green, blue} = this._button.menu.box.get_theme_node().get_foreground_color();
        const light = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 < 0.5;
        if (light === this._menuLight)
            return false;
        this._menuLight = light;
        this._surf.header.light = light;
        return true;
    }

    // The action rows, `Show pill` and `Settings…`: rebuilt whole on every view or setting change, so a stale
    // action never survives a state change. The header stays and is only updated.
    _rebuildMenu() {
        if (!this._header)
            return;
        const menu = this._button.menu;
        for (const row of this._rows)
            row.destroy();
        this._rows = [];
        this._chipIcon = null;
        this._clearChipTimer();
        const {subtitle, actions} = menuFor(this._view, {
            controls: this._settings.get_boolean('menu-controls'),
            hint: this._hint,
        });
        this._updateHeader();
        const add = item => {
            menu.addMenuItem(item);
            this._rows.push(item);
        };
        if (subtitle !== null)
            add(this._chipRow(subtitle));
        for (const {label, verb} of actions)
            add(this._actionRow(label, verb));
        add(new PopupMenu.PopupSeparatorMenuItem());
        this._pillSwitch = new PopupMenu.PopupSwitchMenuItem('Show pill', this._settings.get_boolean('show-pill'));
        this._pillSwitch.connect('toggled', (_item, state) => {
            if (state !== this._settings.get_boolean('show-pill'))
                this._settings.set_boolean('show-pill', state);
        });
        add(this._pillSwitch);
        const prefs = new PopupMenu.PopupMenuItem('Settings…');
        prefs.connect('activate', () => this.openPreferences());
        add(prefs);
    }

    // An action row with the key caps of the user's own shortcut on its right.
    _actionRow(label, verb) {
        const item = new PopupMenu.PopupBaseMenuItem();
        item.add_style_class_name('voxtype-action');
        item.label = new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        item.add_child(item.label);
        const caps = this._caps[CAP_VERB[verb]];
        if (caps) {
            const box = new St.BoxLayout({style_class: 'voxtype-caps', y_align: Clutter.ActorAlign.CENTER});
            for (const cap of caps) {
                const bin = new St.Bin({style_class: 'voxtype-cap', child: new St.Label({text: cap, opacity: 158})});
                if (this._menuLight)
                    bin.add_style_class_name('light');
                box.add_child(bin);
            }
            item.add_child(box);
        }
        item.connect('activate', () => {
            if (!item._stale)
                this._runVerb(verb);
        });
        return item;
    }

    // Offline: the exact start command as a chip that copies itself. It is the only actionable item and never spawns.
    _chipRow(command) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('voxtype-chip-row');
        const chip = new St.Button({style_class: 'voxtype-chip', can_focus: true, x_align: Clutter.ActorAlign.START});
        if (this._menuLight)
            chip.add_style_class_name('light');
        const box = new St.BoxLayout();
        box.add_child(new St.Label({text: command, style_class: 'voxtype-chip-text', y_align: Clutter.ActorAlign.CENTER}));
        this._chipIcon = new St.Icon({icon_name: 'edit-copy-symbolic', style_class: 'voxtype-chip-icon'});
        box.add_child(this._chipIcon);
        chip.set_child(box);
        chip.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command);
            this._chipIcon.icon_name = 'object-select-symbolic';
            this._clearChipTimer();
            this._chipId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHIP_CHECK_MS, () => {
                this._chipId = 0;
                if (this._chipIcon)
                    this._chipIcon.icon_name = 'edit-copy-symbolic';
                return GLib.SOURCE_REMOVE;
            });
        });
        item.add_child(chip);
        return item;
    }

    _clearChipTimer() {
        if (!this._chipId)
            return;
        GLib.source_remove(this._chipId);
        this._chipId = 0;
    }

    // At a state change every outgoing action row stops answering, before the fade starts: a click after a crash
    // or an offline flip must spawn nothing.
    _markStale() {
        for (const row of this._rows) {
            row._stale = true;
            row.setSensitive?.(false);
        }
    }

    // After a view change: an open menu closes for transcribing and idle (paste safety); otherwise the text and the
    // action list fade out, swap and fade in, and the height eases.
    _followMode(mode, prev) {
        const menu = this._button.menu;
        if (mode === MODE_TRANSCRIBING || mode === MODE_IDLE)
            menu.close();
        this._syncElapsed();
        if (!menu.isOpen || prev === null || !this._animationsEnabled()) {
            this._rebuildMenu();
            return;
        }
        this._swapMenu();
    }

    _swapMenu() {
        if (this._menuFade)
            return;
        this._menuFade = true;
        const box = this._button.menu.box;
        const height = box.height;
        const fading = [this._headerText, ...this._rows];
        const finish = () => {
            if (!this._button)
                return;
            this._rebuildMenu();
            box.set_height(-1);
            const [, natural] = box.get_preferred_height(-1);
            const incoming = [this._headerText, ...this._rows];
            for (const actor of incoming)
                actor.opacity = 0;
            box.set_height(height);
            box.ease({height: natural, duration: MENU_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._button?.menu.box.set_height(-1)});
            for (const actor of incoming)
                actor.ease({opacity: 255, duration: MENU_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._menuFade = false;
        };
        fading.forEach((actor, i) => actor.ease({
            opacity: 0, duration: MENU_OUT_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: i === 0 ? finish : null,
        }));
    }

    // `voxtype record <verb>`, no shell, only on a menu activation. The menu closes first so the typing
    // window has focus back before Voxtype records or pastes. One in flight; a failure warns once.
    _runVerb(verb) {
        this._button.menu.close();
        if (this._child)
            return;
        const cancellable = this._cancellable;
        let proc;
        try {
            proc = Gio.Subprocess.new(['voxtype', 'record', verb], Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`${LOG} cannot run voxtype record ${verb}: ${e.message}`);
            return;
        }
        this._child = proc;
        proc.wait_check_async(cancellable, (_proc, res) => {
            if (cancellable.is_cancelled())
                return;
            this._child = null;
            try {
                proc.wait_check_finish(res);
            } catch (e) {
                console.warn(`${LOG} voxtype record ${verb} failed: ${e.message}`);
            }
        });
    }

    // --- orbs: surfaces, layers, ink -----------------------------------------------------------------

    _newOrb(name) {
        const area = new St.DrawingArea({
            style_class: name === 'header' ? 'voxtype-orb voxtype-orb-header' : 'voxtype-orb',
            y_align: Clutter.ActorAlign.CENTER,
        });
        area.connect('repaint', () => this._paintSurface(this._surf?.[name]));
        return area;
    }

    _paintSurface(surface) {
        if (!surface || surface.layers.length === 0)
            return;
        const cr = surface.area.get_context();
        const [width, height] = surface.area.get_surface_size();
        this._drawLayers(cr, width, height, surface.layers);
        cr.$dispose();
    }

    // Both orbs are laid out on a 20 px frame; the surface is that frame times the theme scale factor.
    _drawLayers(cr, width, height, layers) {
        cr.scale(width / ORB_SIZE, height / ORB_SIZE);
        for (const {dots, ink: [red, green, blue]} of layers) {
            for (const dot of dots) {
                cr.setSourceRGBA(red, green, blue, dot.a);
                cr.arc(dot.x, dot.y, dot.r, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }

    // The theme colour of a state's class, read once from the stylesheet through the hidden probe. Light panels use
    // the darker variants; the pill is always dark.
    _ink(mode, surface) {
        const key = `${mode}|${surface.light}`;
        let ink = this._inkCache.get(key);
        if (!ink) {
            this._probe.style_class = `voxtype-orb ${mode}${surface.light ? ' light-panel' : ''}`;
            const {red, green, blue} = this._probe.get_theme_node().get_foreground_color();
            ink = [red / 255, green / 255, blue / 255];
            this._inkCache.set(key, ink);
        }
        return ink;
    }

    _setSashT(t) {
        this._orbT = t;
        this._sashFrame = null;
    }

    // The composing dots of this instant at this surface's gain.
    _sashDots(gain) {
        this._sashFrame ??= ORBS.composing.frame(this._orbT);
        return this._sashFrame.map(d => ({x: d.x, y: d.y, r: d.r * gain, a: d.a}));
    }

    // The layers a surface settles on in the current mode.
    _steady(name) {
        const surface = this._surf[name];
        switch (this._mode) {
        case MODE_RECORDING:
            return [{dots: this._traceDots, ink: this._ink(MODE_RECORDING, surface)}];
        case MODE_TRANSCRIBING:
            return [{dots: this._sashDots(surface.gain), ink: this._ink(MODE_TRANSCRIBING, surface)}];
        case MODE_IDLE:
            // The pill never paints a Seed: it keeps its last mark while it fades out.
            if (name === 'pill')
                return surface.layers;
            return [{dots: name === 'bar' && this._open > 0 ? seedIdle(this._open) : SEED_IDLE, ink: this._ink(MODE_IDLE, surface)}];
        case MODE_OFFLINE:
            if (name === 'pill')
                return surface.layers;
            return [{dots: name === 'bar' && this._open > 0 ? seedOffline(this._open) : SEED_OFFLINE, ink: this._ink(MODE_OFFLINE, surface)}];
        default:
            return surface.layers;
        }
    }

    // What a surface paints `ms` into the running transition: each outgoing layer gathers in its own ink and the
    // incoming shape comes out of the centre, so two inks never blend into one dot.
    _layersFor(name, ms) {
        const layers = this._layersRaw(name, ms);
        // Keeps the very array when nothing is spent, so a surface that did not change is not repainted.
        return layers.every(layer => layer.dots.length > 0) ? layers : layers.filter(layer => layer.dots.length > 0);
    }

    _layersRaw(name, ms) {
        const tr = this._tr;
        const from = tr?.from[name] ?? [];
        if (!tr || from.length === 0)
            return this._steady(name);
        const surface = this._surf[name];
        switch (tr.kind) {
        case 'unfold': {
            if (name === 'pill')
                return this._steady(name);
            const live = this._steady(name)[0];
            const {seed} = unfold(from[0].dots, live.dots, ms);
            return [{dots: seed, ink: lerpInk(from[0].ink, live.ink, Math.min(1, ms / INK_SLIDE_MS))}, live];
        }
        case 'break': {
            if (name === 'pill')
                return this._steady(name);
            const ink = this._ink(this._mode, surface);
            return [{dots: breakDots(ms, tr.back ? 'back' : 'out'), ink}];
        }
        case 'receipt': {
            if (name !== 'pill')
                return this._steady(name);
            const layers = [];
            if (ms < 140) {
                const factor = sashFade(ms);
                for (const l of from)
                    layers.push({dots: l.dots.map(d => ({x: d.x, y: d.y, r: d.r, a: d.a * factor})), ink: l.ink});
            }
            layers.push({dots: checkDots(tr.receipt, ms), ink: this._ink(MODE_TRANSCRIBING, surface)});
            return layers;
        }
        default: {
            const incoming = name === 'pill' && !isBusy(this._mode) ? null : this._steady(name)[0];
            const layers = [];
            let inDots = [];
            for (const l of from) {
                const r = through(l.dots, incoming ? incoming.dots : [], ms,
                    {gatherMs: tr.gather, bloomStartMs: tr.bloom, totalMs: tr.ms});
                layers.push({dots: r.out, ink: l.ink});
                inDots = r.in;
            }
            if (incoming)
                layers.push({dots: inDots, ink: incoming.ink});
            return layers;
        }
        }
    }

    // Recompute every surface and repaint. The header is drawn only while the menu is open.
    _composeAll(ms) {
        if (!this._surf)
            return;
        for (const name of SURFACES) {
            const surface = this._surf[name];
            if (name === 'header' && !this._button.menu.isOpen)
                continue;
            const layers = this._layersFor(name, ms);
            // A surface that keeps its layers (the pill at rest) has nothing new to paint.
            if (layers === surface.layers)
                continue;
            surface.layers = layers;
            surface.area.queue_repaint();
        }
    }

    // What each surface painted last. A hidden pill has nothing to continue from. A closed menu's header is not
    // drawn, so a menu opened mid-transition continues from the button's layers, which it mirrors.
    _snapshot() {
        const surfaces = this._surf;
        return {
            bar: surfaces.bar.layers,
            pill: this._pill.visible && this._pill.opacity > 0 ? surfaces.pill.layers : [],
            header: this._button.menu.isOpen ? surfaces.header.layers : surfaces.bar.layers,
        };
    }

    // --- transitions ---------------------------------------------------------------------------------

    // The record of the one running transition; a new mode replaces it, starting from what was last painted.
    _beginTransition(kind, ms, from, params = {}) {
        if (!SURFACES.some(name => from[name].length > 0))
            return;
        const extra = kind === 'receipt' ? RECEIPT_MARGIN_MS : 0;
        // startUs is taken by the first frame, so that frame is exactly t = 0: what was on screen, unchanged.
        this._tr = {kind, ms, extra, startUs: null, from, ...params};
    }

    // Busy-bound transitions ride the clock that already runs; the others get one non-repeating timeline.
    _startOneShot() {
        const tr = this._tr;
        // A few frames longer than the transition: _advance ends it at its own time, this only backstops it.
        this._oneShot = new Clutter.Timeline({actor: Main.layoutManager.uiGroup, duration: tr.ms + tr.extra + 100});
        this._oneShotIds = [
            this._oneShot.connect('new-frame', () => this._advance()),
            this._oneShot.connect('completed', () => this._advance(true)),
        ];
        this._oneShot.start();
    }

    _stopOneShot() {
        if (!this._oneShot)
            return;
        for (const id of this._oneShotIds)
            this._oneShot.disconnect(id);
        this._oneShot.stop();
        this._oneShot = null;
        this._oneShotIds = [];
    }

    // One step of the running transition (or the steady frame when there is none). The last frame is the final
    // shape; then the transition and its clock go.
    _advance(last = false) {
        const tr = this._tr;
        if (!tr) {
            this._composeAll(0);
            return;
        }
        tr.startUs ??= GLib.get_monotonic_time();
        const elapsed = (GLib.get_monotonic_time() - tr.startUs) / 1000;
        this._composeAll(Math.min(elapsed, tr.ms));
        if (elapsed >= tr.ms + tr.extra || last) {
            this._tr = null;
            this._stopOneShot();
            // The transition's own last frame carried its spent layers; what remains is the steady shape.
            this._composeAll(0);
        }
    }

    // --- the clock ----------------------------------------------------------------------------------

    // One clock per busy mode. Recording: the frame-clock timeline reads the voice and advances the trace, or,
    // with animations off, a 500 ms timeout reads it and repaints the still frame when it changed.
    // Transcribing: the composing timeline, or its still frame with no clock at all. Idle and offline: none,
    // except the one-shot of a transition.
    _startClock() {
        const animated = this._animationsEnabled();
        this._lastTickUs = GLib.get_monotonic_time();
        if (this._mode === MODE_RECORDING) {
            if (animated) {
                this._tickTrace();
                this._startTimeline(TRACE_LOOP_MS, () => this._tickTrace());
            } else {
                this._tickStill();
                this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STILL_TICK_MS, () => {
                    this._tickStill();
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else if (this._mode === MODE_TRANSCRIBING) {
            const orb = ORBS.composing;
            this._setSashT(orb.stillT);
            this._advance();
            if (animated)
                this._startTimeline(orb.periodMs, msecs => this._tickComposing(orb.time(msecs)));
        }
    }

    _startTimeline(durationMs, onFrame) {
        this._orbTimeline = new Clutter.Timeline({
            actor: Main.layoutManager.uiGroup,
            duration: durationMs,
            repeat_count: -1,
        });
        this._orbFrameId = this._orbTimeline.connect('new-frame', (_timeline, msecs) => onFrame(msecs));
        this._orbTimeline.start();
    }

    _stopClock() {
        this._stopOneShot();
        if (this._orbTimeline) {
            this._orbTimeline.disconnect(this._orbFrameId);
            this._orbTimeline.stop();
            this._orbTimeline = null;
            this._orbFrameId = 0;
        }
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    // The animations or motion setting changed. Without animation a running transition ends at its final shape;
    // the clock of a busy mode is swapped, keeping the tracker and the trace.
    _syncClock() {
        if (!this._surf)
            return;
        if (!this._animationsEnabled()) {
            // Without animation a running transition ends at its final shape.
            if (this._tr) {
                this._composeAll(this._tr.ms);
                this._tr = null;
            }
            this._stopOpenTween();
            this._settleActors();
        }
        if (isBusy(this._mode)) {
            this._stopClock();
            // The animated clock replaced the still dots, so the cached key no longer describes what is on screen.
            this._stillKey = null;
            this._startClock();
        } else {
            this._stopOneShot();
            if (this._mode !== null)
                this._composeAll(0);
        }
    }

    // Animations went off: every eased actor property lands on its final value at once, and what an onComplete
    // would have done (the label's text swap, the pill's hide, the menu rebuild) is done here, since removing a
    // transition never calls it.
    _settleActors() {
        const glide = this._glide;
        this._glide = null;
        const pill = this._pill;
        // A glide target counts only for a property still easing; a later placement already owns the rest.
        const glideWidth = glide && this._label.get_transition('width') ? glide.width : null;
        const glideX = glide && pill.get_transition('x') ? glide.x : null;
        pill.remove_all_transitions();
        this._label.remove_all_transitions();
        this._label.text = this._labelWant;
        this._label.opacity = 255;
        this._labelFading = false;
        if (glideWidth !== null)
            this._label.set_width(glideWidth);
        if (glideX !== null)
            pill.set_x(glideX);
        pill.translation_y = 0;
        if (this._pillOn) {
            pill.opacity = 255;
        } else if (pill.visible) {
            pill.opacity = 0;
            pill.hide();
            this._unredirect.release();
        }
        const box = this._button.menu.box;
        this._header.remove_all_transitions();
        this._headerText.remove_all_transitions();
        box.remove_all_transitions();
        for (const row of this._rows)
            row.remove_all_transitions();
        if (this._menuFade) {
            this._menuFade = false;
            this._rebuildMenu();
        }
        this._headerText.opacity = 255;
        for (const row of this._rows)
            row.opacity = 255;
        box.set_height(-1);
    }

    _tickTrace() {
        const nowUs = GLib.get_monotonic_time();
        const dtMs = (nowUs - this._lastTickUs) / 1000;
        this._lastTickUs = nowUs;
        const voice = this._tracker.snapshot(nowUs);
        this._applyHint(voice.hint);
        this._traceDots = this._trace.frame(dtMs, voice);
        this._advance();
    }

    _tickStill() {
        const voice = this._tracker.snapshot(GLib.get_monotonic_time());
        const key = `${voice.feed}|${voice.gate}|${voice.hint}`;
        this._applyHint(voice.hint);
        if (key === this._stillKey)
            return;
        this._stillKey = key;
        this._traceDots = this._trace.still(voice);
        this._advance();
    }

    _tickComposing(t) {
        this._setSashT(t);
        this._advance();
    }

    // --- the opening Seed ----------------------------------------------------------------

    // Hover, focus, press or an open menu changed: the Seed opens to 0.5 or 1, or closes.
    _pointer(field, value) {
        if (!this._surf || this[field] === value)
            return;
        this[field] = value;
        const target = this._menuOpen || this._pressed ? 1 : this._hover || this._focused ? 0.5 : 0;
        if (target === this._openTarget)
            return;
        this._openTarget = target;
        this._stopOpenTween();
        const rest = this._mode === MODE_IDLE || this._mode === MODE_OFFLINE;
        if (!rest || !this._animationsEnabled()) {
            this._open = target;
            if (rest && !this._tr)
                this._composeBar();
            return;
        }
        this._openFrom = this._open;
        this._openStartUs = GLib.get_monotonic_time();
        this._openDurationMs = target > this._open ? SEED_OPEN_MS : SEED_CLOSE_MS;
        this._openTimeline = new Clutter.Timeline({actor: Main.layoutManager.uiGroup, duration: this._openDurationMs});
        const frameId = this._openTimeline.connect('new-frame', () => {
            const f = easeOutQuad((GLib.get_monotonic_time() - this._openStartUs) / 1000 / this._openDurationMs);
            this._open = this._openFrom + (this._openTarget - this._openFrom) * f;
            if (!this._tr)
                this._composeBar();
        });
        const doneId = this._openTimeline.connect('completed', () => {
            this._open = this._openTarget;
            if (!this._tr)
                this._composeBar();
            this._stopOpenTween(true);
        });
        this._openIds = [frameId, doneId];
        this._openTimeline.start();
    }

    // Only the button's orb repaints during the tween.
    _composeBar() {
        const bar = this._surf.bar;
        bar.layers = this._steady('bar');
        bar.area.queue_repaint();
    }

    // A tween cut short settles on its target: the open amount only matters at rest.
    _stopOpenTween(done = false) {
        if (!this._openTimeline)
            return;
        for (const id of this._openIds)
            this._openTimeline.disconnect(id);
        this._openTimeline.stop();
        this._openTimeline = null;
        this._openIds = [];
        if (!done)
            this._open = this._openTarget;
    }

    // --- hints, the pill ---------------------------------------------------------------------------

    // Set only when the hint changes: the pill label, the button's accessible name and an open menu's header.
    // With `mic-hints` off the tracker's warnings are ignored and the hint stays `listening`.
    _applyHint(voiceHint) {
        this._voiceHint = voiceHint;
        const hint = this._settings.get_boolean('mic-hints') ? voiceHint : 'listening';
        if (hint === this._hint)
            return;
        this._hint = hint;
        const {label, suffix} = HINTS[hint];
        this._setLabel(label, false);
        this._button.accessible_name = this._viewName + suffix;
        this._updateHeader();
    }

    _animationsEnabled() {
        return St.Settings.get().enable_animations && this._settings.get_string('motion') === 'follow';
    }

    // The label changes by a cross-fade, out over 60 ms and in over 90 ms inside the reserved width. A swap
    // that nobody sees (the pill is hidden, or animations are off) is instant.
    _setLabel(text, instant) {
        this._labelWant = text;
        const visible = this._pillOn && this._pill.visible;
        if (instant || !visible || !this._animationsEnabled()) {
            this._label.remove_all_transitions();
            this._label.text = text;
            this._label.opacity = 255;
            this._labelFading = false;
            return;
        }
        if (this._labelFading || this._label.text === text)
            return;
        this._labelFading = true;
        this._label.ease({
            opacity: 0,
            duration: LABEL_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._label)
                    return;
                this._label.text = this._labelWant;
                this._label.ease({
                    opacity: 255,
                    duration: LABEL_IN_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._labelFading = false;
                        if (this._label && this._label.text !== this._labelWant)
                            this._setLabel(this._labelWant, false);
                    },
                });
            },
        });
    }

    // The pill keeps one width for the whole busy period, the widest label it can show, so it never
    // re-centres when the hint changes.
    _reserveLabelWidth(mode) {
        const shown = this._label.text;
        this._label.set_width(-1);
        let widest = 0;
        for (const text of LABELS_FOR_MODE[mode]) {
            this._label.text = text;
            widest = Math.max(widest, this._label.get_preferred_width(-1)[1]);
        }
        this._label.text = shown;
        this._label.set_width(widest);
    }

    // 1em in pixels, read from the label's font.
    _em() {
        return this._label.get_theme_node().get_font().get_size() / Pango.SCALE;
    }

    // Where the pill sits: centred on the monitor being dictated on (or the primary one) under the panel.
    _pillSpot() {
        const layout = Main.layoutManager;
        const focused = global.display.focus_window?.get_monitor() ?? layout.primaryIndex;
        const index = this._settings.get_string('pill-monitor') === 'primary' ? layout.primaryIndex : focused;
        const monitor = layout.monitors[index] ?? layout.primaryMonitor;
        const [, width] = this._pill.get_preferred_width(-1);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return [
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + Main.panel.height + PILL_GAP * scale),
        ];
    }

    _placePill() {
        this._pill.set_position(...this._pillSpot());
    }

    // The only time the pill moves: at the hand-off the label's width and the pill's x ease together over 200 ms,
    // so it widens and stays centred.
    _glidePill(oldWidth, oldX) {
        const width = this._label.width;
        const x = this._pill.x;
        if (width === oldWidth && x === oldX)
            return;
        this._label.set_width(oldWidth);
        this._pill.set_x(oldX);
        this._glide = {width, x};
        this._label.ease({width, duration: GLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._glide = null;
            }});
        this._pill.ease({x, duration: GLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // The entrance: opacity over 150 ms and a 0.4em rise over 180 ms. A pill already up only follows its monitor.
    _showPill() {
        this._pillOn = true;
        this._pill.remove_all_transitions();
        const fresh = !this._pill.visible;
        if (fresh) {
            this._label.remove_all_transitions();
            this._label.opacity = 255;
            this._labelFading = false;
            this._pill.opacity = 0;
            this._pill.translation_y = this._animationsEnabled() ? -RISE_EM * this._em() : 0;
        }
        this._unredirect.acquire();
        this._pill.show();
        this._placePill();
        if (this._animationsEnabled()) {
            this._pill.ease({opacity: 255, duration: FADE_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._pill.ease({translation_y: 0, duration: RISE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this._pill.opacity = 255;
            this._pill.translation_y = 0;
        }
    }

    // The exit is opacity only, over 100 ms; a receipt adds a 0.2em lift.
    _hidePill({lift = false} = {}) {
        if (!this._pillOn)
            return;
        this._pillOn = false;
        this._pill.remove_all_transitions();
        if (!this._animationsEnabled()) {
            this._pill.opacity = 0;
            this._pill.translation_y = 0;
            this._pill.hide();
            this._unredirect.release();
            return;
        }
        this._pill.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._pillOn || !this._pill)
                    return;
                this._pill.hide();
                this._unredirect.release();
                this._pill.translation_y = 0;
            },
        });
        if (lift)
            this._pill.ease({translation_y: -LIFT_EM * this._em(), duration: FADE_OUT_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
}
