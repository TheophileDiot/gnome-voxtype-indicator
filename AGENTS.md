# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## What this is

A GNOME Shell extension (GJS/ESM, no build step, no npm, no gettext) that shows Voxtype's state: a
top-bar orb (a still Seed when Voxtype is idle, a Seed ring when it is not running) and a pill at the top centre of
the screen while Voxtype records (a red trace that follows the voice) or transcribes (amber `composing` orb). The
button's menu runs `voxtype record <verb>`, and an Adw window (`prefs.js`) edits eight GSettings keys. UUID: `voxtype-indicator@theophilediot.github.io`. The design lives in
`docs/superpowers/specs/2026-11-02-voxtype-indicator-design.md`; it is the contract. That folder is not in the public
repository. On the maintainer's machine it is a git-excluded symlink to private design notes. Its sections 7 and 8 (orbs,
high contrast, pill alpha, light-panel inks) supersede the earlier values, and section 9 (the voice-reactive
recording orb, labels, receipt, panel tone) supersedes the recording parts of 7 and 8. Section 10 (the Seed idle
orb, the menu and controls, the preferences, internal build 0.2.0) supersedes "no settings", "hidden while idle" and "spawns
nothing". Section 10.8 (setting the dictation shortcuts from Settings, internal build 0.3.0, first public release 0.1.0) supersedes "reads only" for the
shortcut rows.

## Commands

```bash
make install        # make pack, then gnome-extensions install --force (compiles the schema)
make test           # == release-check: static-check + tests + pack + package-content-check
make static-check   # metadata/schema/import-boundary assertions, no packaging
make tests          # glib-compile-schemas --strict --dry-run schemas, then gjs -m tests/test-common.js, test-source.js,
                    # test-unit.js, test-levels.js, test-trace.js, test-orb.js, test-morph.js and (under GSETTINGS_BACKEND=memory)
                    # test-shortcuts.js
make pack           # build dist/<UUID>.shell-extension.zip (gnome-extensions pack --schema=...)
make clean
```

There is no linter or formatter. The tests are plain `gjs -m tests/<file>.js` scripts (assert, exit
non-zero on failure). `make test` is the whole gate; run it after touching runtime files,
`metadata.json` or packaging.

Reload after `make install`: X11 `Alt+F2` → `r`; Wayland requires log out/in.
Logs: `journalctl -f -o cat /usr/bin/gnome-shell` (extension logs are prefixed `[Dictation Indicator]`).
Enable with `gnome-extensions enable voxtype-indicator@theophilediot.github.io`.

## Architecture

Nine runtime files plus the stylesheet and the schema. All but `prefs.js` and `shortcuts.js` run inside the gnome-shell
process; those two run in the preferences process:

| File | May import | Owns |
| --- | --- | --- |
| `extension.js` | Shell, St, Clutter, Cairo, Gio, GLib (never Gtk/Gdk/Adw) | UI only: wires the settings, the sources, the tracker and the orbs to the button, its menu and the pill; labels, receipt, hand-off, panel tone, the `voxtype record <verb>` spawns |
| `prefs.js` | Adw, Gtk, Gdk, Gio, GLib, Cairo, the extension's own modules (never `resource:///org/gnome/shell/`) | the preferences window: a live preview and the eight keys; runs in the preferences process |
| `source.js` | `gi://Gio`, `gi://GLib`, `./common.js` | `VoxtypeStateSource`: the state-file monitors, coalesced reads, liveness, the 2 s watchdog, the cancel watch; `VoxtypeUnitWatch`: the systemd unit watch |
| `levels.js` | `gi://Gio`, `gi://GLib`, `./common.js` | `VoxtypeLevelSource`: the level-socket lifecycle, retries, frame parsing |
| `common.js` | `gi://GLib`, `gi://Gio` | pure logic: state parsing, `viewFor`, `menuFor`, `unitEffect`, `displayFor`, frame decoding, `VoiceTracker`, `receiptFor` |
| `shortcuts.js` | Gtk, Gdk, Gio, GLib, `./common.js` (never Shell modules, never imported by the Shell-side files) | the shortcut rows' logic in the preferences process (spec 10.8): `evaluateKey`, `findConflict`, `listEntries`, `readShortcuts`, `writeShortcut` |
| `trace.js` | nothing | Trace · Pulse geometry of the recording orb |
| `orb.js` | nothing | the thinking-orbs `composing` geometry (transcribing) and the Seed dots (idle, not running; `seedIdle(o)` and `seedOffline(o)` open with the pointer) |
| `morph.js` | nothing | the choreography geometry of every orb transition: `through`, `unfold`, `breakDots`, the receipt glyphs, `primeTrace` (spec 10.7); takes elapsed milliseconds, owns no clock |
| `stylesheet.css` | | inks, pill shape, high-contrast pill |
| `schemas/org.gnome.shell.extensions.voxtype-indicator.gschema.xml` | | the eight keys and the three enums |

- `extension.js` — `enable()` builds one reactive `PanelMenu.Button` (an orb and a `PopupMenu`), one pill
  (`St.BoxLayout`: orb, label) in `Main.layoutManager.uiGroup`, the extension's `Gio.Settings` with one `changed::`
  handler per key, one `VoxtypeStateSource` whose `onView` calls `_render` and whose `onCancel` sets the cancel
  flag, one `VoxtypeUnitWatch` that feeds `noteUnitState`, and one idle `VoxtypeLevelSource` and `VoiceTracker`.
  The orbs are `St.DrawingArea`s drawn with Cairo. The menu is built from `menuFor` at `enable()` and rebuilt on
  every view, hint or `menu-controls` change, open or not: `PopupMenu.open()` ignores an empty menu, so the items
  must exist before the first click. `disable()` stops the unit watch and both sources, cancels the extension's
  `Gio.Cancellable`, `force_exit()`s a running `voxtype record` child, stops the clock and the still and receipt
  timeouts, disconnects the settings, high-contrast, animations and panel-style handlers and tears the UI down.
- `source.js` — `VoxtypeStateSource`: the monitors, the runtime-dir fallback, coalesced reads, the read
  sequence number, liveness and the 2 s watchdog (busy modes only). It delivers distinct idle and offline views,
  watches `voxtype/cancel` only while busy (`onCancel` fires on the creation event itself, never on an existence
  check), and takes `refresh()` (menu open) and `noteUnitState()` (systemd). `VoxtypeUnitWatch` asks the user manager
  on the session bus for `voxtype.service` (`LoadUnit`), calls `Subscribe`, listens for `PropertiesChanged` on that
  one path, reads `ActiveState` once, and sends `Unsubscribe` on `stop()` even before `Subscribe` has replied. Errors
  (no unit, no systemd) give at most one `console.debug`. `tests/test-source.js` runs the source under plain
  `gjs -m` with a temp runtime dir and a fake `/proc`; `tests/test-unit.js` starts a private `dbus-daemon`
  through `Gio.Subprocess` (not `Gio.TestDBus`, which leaks stuck forks) and runs the watch against a fake
  `org.freedesktop.systemd1` on it. A unit whose `LoadState` is `not-found` (systemd answers `LoadUnit` with a stub for a
  unit that does not exist) is no watch: no `Subscribe`, no callback, so a Voxtype started by hand never shows offline.
- `levels.js` — `VoxtypeLevelSource`: connects to `$XDG_RUNTIME_DIR/voxtype/audio.sock` only while Voxtype
  records, one outstanding `read_bytes_async`, three retries (250 ms, 1 s, 2 s), gives up after 30 invalid frames
  in a row. `stop()` guarantees no callback afterwards. `tests/test-levels.js` runs it against a
  `Gio.SocketService`.
- `common.js` — Shell-free: `parseState`, `viewFor` (the state → view table), `parsePid`, `isVoxtypeComm`, path
  helpers, plus `decodeFrames` (16-byte level frames), `VoiceTracker` (frames and time → the voice snapshot:
  `feed`, `level`, `peak`, `fast`, `gate`, `onsets`, `hint`, `heard`, `feedSeenMs`), `receiptFor` (`null` after a
  cancel), `menuFor` (the menu items per view), `unitEffect` (`ActiveState` → `read`, `offline` or `none`),
  `displayFor` and `buttonShown` (the `panel-orb` and `show-pill` rules). Pure logic goes here so
  `tests/test-common.js` can cover it.
- `shortcuts.js` — preferences process only. The Controls rows of `prefs.js` show the caps and a `Change…` button; both
  open `captureDialog` (an `Adw.Dialog`, a capture-phase `Gtk.EventControllerKey`). While it is open the toplevel calls
  `inhibit_system_shortcuts()` (the Shell may ask once; `restore_system_shortcuts()` on every close path), or the
  current Alt+Space would run Voxtype instead of reaching the dialog. `evaluateKey` applies the key rules
  (modifiers wait, Esc cancels, BackSpace turns off, a plain key needs Ctrl, Alt or Super, F1-F24 and XF86 keys alone
  are fine); `findConflict` searches the custom shortcuts and the five built-in keybinding schemas (installed ones
  only) with GTK 4 equality; `writeShortcut` edits `binding` of the first `voxtype record <verb>` entry or creates
  one (`pickShortcutPath`, `shortcutCommand` in `common.js`), writing `name`, `command`, `binding` and then the list.
  A new entry's path is skipped when it is in the list or already holds a `name` or `command`. Every key is checked
  with `is_writable` first. On any failure the new entry's three keys are reset before the error is rethrown, so a
  half-written entry never stays behind. The list is read again just before the append; the `beforeList` seam tests
  that. Both sides pick the shortcut with `shortcutBindings` in `common.js`: the first entry whose command matches
  wins, even when it is disabled.
  `tests/test-shortcuts.js` runs only under `GSETTINGS_BACKEND=memory` and aborts otherwise: it must never reach the
  user's dconf. Never call `writeShortcut` from a test without that backend.
- `trace.js` — Shell-free, no imports: `createTrace()` returns `{frame(dtMs, v), still(v)}` and `TRACE_SIZE`.
  Radii are final, there is no gain. Our own code, no upstream. `tests/test-trace.js` covers it.
- `orb.js` — Shell-free geometry of the thinking-orbs `composing` orb at the 20 px preset, plus the frozen Seed dot
  arrays `SEED_IDLE` (19 beads) and `SEED_OFFLINE` (10 beads, spec 10.1), pinned by golden checks in
  `tests/test-orb.js`. `ORBS.composing` holds
  `frame(t)` (the dots x, y, z, r, white, alpha for one instant), `time(ms)` (wall time to upstream's clock),
  `stillT` (the reduced-motion instant) and `periodMs` (the loop). No imports at all. Ported from
  <https://github.com/Jakubantalik/thinking-orbs> (MIT; the commit SHA and the licence text are in the file
  header). `tests/test-orb.js` checks it against `tests/orb-golden-composing-20.json`, extracted from upstream's
  `spec/orbs-golden.json`. Keep it a port: change a constant and the golden test fails. The `listening` orb is gone:
  recording uses `trace.js`.
- `stylesheet.css` — the orb inks per state (`.voxtype-orb.recording` `#ff6267`, `.voxtype-orb.transcribing`
  `#ffad42`; `#c8323a` and `#9a5c12` under `.light-panel`), the Seed ink (`.voxtype-orb.idle` and `.offline`
  `#ffffff`, `#2e3436` under `.light-panel`), the pill shape (`#111412` at 95%) and the `.high-contrast` pill.

`prefs.js` and the schema are required: `make static-check` fails without them, and without `settings-schema` in
`metadata.json`. The keys are `panel-orb`, `show-pill`, `pill-monitor`, `mic-hints`, `receipt`, `still-seconds`
(3..60), `motion` and `menu-controls` (spec 10.3). Every key applies live: `extension.js` connects one `changed::`
handler per key in `enable()` and disconnects it in `disable()`. `panel-orb` `never` together with `show-pill` off
would hide the extension, so prefs make the second control insensitive and at runtime the pill wins.

### Orb

The top bar, the pill and the menu header each hold one orb, an `St.DrawingArea` drawn with Cairo, and each surface
(`_surf.bar`, `.pill`, `.header`) remembers the layers `{dots, ink}` it last painted. Recording paints the trace dots
(Trace · Pulse: a row of dotted columns scrolling left, one every 130 ms, each holding the peak level of its slot),
transcribing paints the `composing` orb (an undulating sash). The top-bar orb and the header also paint the still
Seed: `SEED_IDLE` when Voxtype is idle, `SEED_OFFLINE` when it is not running, in the panel ink. The pill never paints a
Seed. `queue_repaint()` on a `St.DrawingArea` draws at once (the `repaint` signal is synchronous), so a surface keeps
the very same layers array when nothing changed and is not repainted.

**Transitions (spec 10.7).** `_render` snapshots what each surface painted last (`_snapshot`), then `_beginTransition`
sets one record `{kind, ms, from, startUs}`; `_layersFor(surface, ms)` composes the layers of the running transition
(`morph.js`) and `_advance` steps it. `startUs` is taken by the first frame, so that frame equals what was painted
before. Kinds: `unfold` (a settled Seed into the recording), `through` (gather and bloom: the hand-off, the withdraw,
a crash, any other change), `break` (the Seed and the ring) and `receipt` (the pill's glyph). A mode change
mid-transition takes the last painted layers as its outgoing side. Inks come from the stylesheet through a hidden probe
widget (`_ink`, cached, emptied when the theme changes), so a layer keeps its own ink. Busy-bound transitions ride the
clock that runs; the others get one non-repeating `Clutter.Timeline` (`_startOneShot`) that `_advance` ends and
`disable()` removes. With animations off or `motion` `still` no transition starts and the final frame is painted at once.

The clock exists only in the two busy states and in a transition; idle and not running paint once and have none:

- **Recording, animations on:** one `Clutter.Timeline` (frame-clock driven, looping, its length only bounds a loop).
  Each `new-frame` takes `tracker.snapshot()`, calls `trace.frame(dt, voice)` and repaints both orbs.
- **Recording, animations off:** one 500 ms `GLib.timeout_add`. It takes the snapshot, and repaints
  `trace.still(voice)` only when `feed`, `gate` or `hint` changed.
- **Transcribing:** the `composing` timeline (`periodMs` long, so the loop has no jump), or its `stillT` frame with
  no clock when animations are off.

`notify::enable-animations` swaps the clock of the running mode (`_syncClock`), keeping the tracker and the trace.
The `motion` key `still` makes `_animationsEnabled()` false and acts like GNOME animations off; it swaps the clock the
same way (`_syncClock`), ending a running transition at its final shape. The clock, the one-shot, the opening-Seed tween,
the level source, the still timeout, the receipt timeout, the elapsed timeout and the chip timeout are all removed on a
mode change or menu close, and in `disable()`. The `composing` dots are drawn at `DOT_GAIN` (1.5) times their upstream radius: upstream tunes the 20 px
preset for a 2x canvas and the extension draws it into 16 device pixels. The gain was tuned at scale factor 1 only;
re-check it on a scale-2 display. `orb.js` stays exactly upstream, and the trace has no gain. The orb colour is read
from the theme node of the state's class (`.voxtype-orb.recording`, `.transcribing`, `.idle`, `.offline`) on the probe,
so the stylesheet stays the one place for colours. The pill orbs never take `.light-panel`: the pill is dark. The top-bar
orb's tone follows the panel's background, read on every mode change and on `Main.panel`'s `style-changed`, so a
light/dark switch mid-recording recolours it, and the Seed with it. The header's tone follows the menu's foreground. The
idle and offline branch of `_render` leaves the pill's layers alone, so the pill does not change its mark while it fades
out. Do not use `run_dispose()` on the timeline.

**The opening Seed (spec 10.7.5).** Hover, key focus or press gives `o = 0.5` (press and an open menu `o = 1`) to the
button's Seed, tweened over 150 ms open and 120 ms close by one one-shot timeline that repaints only the button's orb
(`_pointer`, `_stopOpenTween`). `o` jumps with animations off.

### Voice, labels, hand-off, receipt

- **Voice:** `levels.js` pushes decoded frames into the `VoiceTracker` as they arrive. The extension reads it on its
  clock tick. A recording starts with `tracker.reset()` and `levelSource.start()`, and leaving it calls
  `levelSource.stop()` and keeps only `{heard, feedSeenMs}` for the receipt.
- **Labels:** the tracker's `hint` sets the pill label and the button's accessible name, only when it changes:
  `Listening…`, `Can't hear you` (6 s of live feed and no speech), `No signal` (2 s of exact digital silence, 5 s once
  the user has been heard). No socket means `Listening…` and no claim. `Still transcribing…` replaces
  `Transcribing…` after one one-shot timeout of `still-seconds` (re-armed from the start of transcribing when the key
  changes). The `mic-hints` key off keeps `Listening…` and the plain header and name. The pill reserves the width of the widest label of the busy mode,
  so a hint never re-centres it; it is placed once per show, and glided once at the hand-off (`_glidePill`: the label's
  width and the pill's x ease together over 200 ms). Label changes cross-fade (`_setLabel`: out 60 ms, in 90 ms).
- **Pill motion:** `_showPill` fades in over 150 ms and rises 0.4em over 180 ms; `_hidePill` fades over 100 ms (a receipt
  exit lifts 0.2em). The pill stays `reactive: false` and `can_focus: false` through every `ease()`.
- **Hand-off:** recording to transcribing is the `through` transition: the red trace gathers to the centre over 120 ms
  and the amber sash blooms from 50 ms, 240 ms in all, on the composing timeline. Instant with animations off.
- **Receipt:** only on transcribing to `idle` (`view === VIEW_IDLE`), with the `receipt` key on and the pill shown.
  At every transcribing to idle the button switches to the Seed at once (when `panel-orb` allows it). The pill fades
  the last painted sash over 140 ms and draws `CHECK` (`Done`) or `FLAT` (`Nothing heard`, when `receiptFor` says the
  recording had 2 s of feed and no speech) on a one-shot clock (about 442 ms or 390 ms, 34 ms longer so the finished
  glyph is painted before the clock goes). The hold starts at 400 ms and lasts 500 ms or 1.5 s, then the pill leaves. A busy view cancels it at once. `onCancel` (the `voxtype/cancel`
  watch) sets a flag that resets when a busy period starts from idle or offline (recording to transcribing is the
  same period); `receiptFor({…, cancelled})` then returns `null` and the pill hides with no receipt. A cancelled
  period, or a recording that ends in idle, is the `withdraw` transition (220 ms).
- **Menu and actions:** the header (a persistent, non-reactive item with the live orb, a markup title and a second line:
  `Ready` or the elapsed `m:ss`, from one 1 s timeout only while the menu is open and busy), the offline copy chip and
  the actions come from `menuFor(view, {controls, hint})`, then a separator, a `Show pill` switch bound to `show-pill`
  and `Settings…`. The rows are rebuilt on a view or setting change; the header is only updated. A hint change updates
  the header and nothing else. A mode change to transcribing or idle closes an open menu (paste safety); recording and
  offline leave it open: `_render` first marks every outgoing action row stale (its handler ignores calls), then
  `_swapMenu` fades the text and rows out over 90 ms, rebuilds, and fades in over 150 ms while the height eases.
  Opening it calls `source.refresh()`, and reads the GNOME custom shortcuts (`media-keys` `custom-keybindings`, matched
  by `voxtypeVerbOf`, shown by `capsFor`) for the key caps: reads only. Only Settings writes them (10.8, below). The chip copies the start command with
  `St.Clipboard` and shows a check for 1.2 s; it never spawns.
  `_runVerb` closes the menu first, then `Gio.Subprocess.new(['voxtype', 'record', verb], STDERR_SILENCE)`, one child
  in flight (`_child`); a spawn or exit failure is one `console.warn`.

### High contrast

`enable()` connects `St.Settings` `notify::high-contrast` and `_syncContrast` toggles `.high-contrast` on the
pill (opaque black, `rgba(255,255,255,0.4)` border). `disable()` disconnects it.

### Read path

State file event → one coalesced `GLib.idle_add` → `load_contents_async` → `parseState` → `viewFor` →
`onView` → `_render`. The source calls `onView` only when the mode changes. An empty read keeps the current
view (the writer truncates before it writes). Liveness is checked on every read that is neither `keep` nor
`offline` (idle reads included), and by one 2 s watchdog while the mode is busy: `voxtype.lock` holds the PID, and
`/proc/<pid>/comm` must start with `voxtype` (a recycled PID is another program). Idle and offline have no timer at
all. A missing state file with a live `voxtype` lock PID reads as idle; with a dead PID or no lock it reads as offline. A read or watchdog
result whose sequence number is stale on return is dropped.

`Gio.File.monitor_file` on a path whose parent dir does not exist yet loses the `CREATED` event when
the daemon makes the dir and the file back to back. So `start()` also watches the runtime dir for the
`voxtype` child, then re-creates the file monitor and re-reads. Do not remove that fallback.

### Teardown contract

GNOME review rejects leaks. `disable()` calls `source.stop()`, which cancels the `Gio.Cancellable`, removes
the idle source and the watchdog, and disconnects and cancels both monitors, then removes every
transition, destroys the button and the pill, and nulls every field. Every `await` captures the cancellable in a local first and re-checks it
(and the read sequence number) before touching an actor or a field. The cancellable is the single
teardown signal: do not add a `_destroyed` boolean (extensions.gnome.org review rejects it).

### Focus

The pill is `reactive: false`, `can_focus: false`, `track_hover: false` and is never added through
`addChrome`, so it changes no struts and no input region. Voxtype pastes into the focused window right
after transcription, so the pill may never take focus. The top-bar button is reactive and owns a `PopupMenu`: it
closes the menu before every spawn and on any change of mode to transcribing or idle, and never opens it on its own.

While the pill is shown it inhibits unredirect, as the Shell's OSD does (`UnredirectHold` in `common.js`, one flag apart from
`_pillOn`): on a monitor without a top bar a maximised window covers the whole monitor, Mutter scans it out directly, and a
Shell actor is not composited there. `global.compositor.disable_unredirect()` from GNOME 48, `Meta.disable_unredirect_for_display`
on 46-47 (feature-detected). Acquired in `_showPill` and `_showReceipt`, released once the pill is hidden (`_hidePill`'s two
paths, `_settleActors`, `disable()`), never at idle.

## Hard constraints (enforced by `make static-check` and CI)

- `extension.js` must not import `Gtk`/`Gdk`/`Adw`; `common.js`, `source.js` and `levels.js` must import neither
  those nor `St`/`Clutter`/`Meta`/`Shell` or `resource:///org/gnome/shell/`; `prefs.js` and `shortcuts.js` must never
  import `resource:///org/gnome/shell/` (`shortcuts.js` no `St`/`Clutter`/`Meta`/`Shell` either), and no Shell-side file
  imports `shortcuts.js`.
- The Shell side writes nothing outside its own schema. The only code that writes the user's GNOME shortcuts is
  `writeShortcut` in `shortcuts.js`, run from the preferences process when the user presses a combination in the dialog.
- No `spawn_command_line*` anywhere — use `Gio.Subprocess` with an argv array. The only spawn in the Shell is
  `['voxtype', 'record', verb]` with `verb` `start`, `stop` or `cancel`, on a menu activation, one in flight, closed
  menu first, cancelled and `force_exit()`ed in `disable()`. `prefs.js` may also run `voxtype config get …` in its
  own process. Voxtype's config is never written.
- The only D-Bus calls are `LoadUnit`, `Subscribe`, `Unsubscribe` and `Properties.Get` on the systemd user manager,
  plus one `PropertiesChanged` match on the `voxtype.service` unit path.
- `orb.js` must import nothing from Shell, GTK or Cairo, and `trace.js` and `morph.js` must have no `import` line at all
  (`make static-check` greps for both).
- The microphone is never opened: the level comes only from Voxtype's `audio.sock`, no second capture.
- `metadata.json` must have **no `version` key** (extensions.gnome.org assigns it) and `settings-schema` equal to
  `org.gnome.shell.extensions.voxtype-indicator`. Source version lives in `VERSION` + a `v<VERSION>` git tag, and
  `version-name` must equal `VERSION` (0.1.0).
- The release ZIP holds exactly `metadata.json`, `extension.js`, `prefs.js`, `common.js`, `source.js`, `levels.js`,
  `trace.js`, `orb.js`, `morph.js`, `shortcuts.js`, `stylesheet.css` and `schemas/org.gnome.shell.extensions.voxtype-indicator.gschema.xml`, plus
  the bare `schemas/` entry that `gnome-extensions pack` (50.1) adds. It emits no `schemas/gschemas.compiled`: the
  Shell compiles the schema on install. `gnome-extensions pack` also needs the `--out-dir` to exist (the Makefile
  runs `mkdir -p`), or it segfaults.
- Never commit `dist/` or a ZIP.
- No idle timers, sockets or subprocesses. Passive handlers are allowed while idle: GSettings `changed::`, the file
  monitors and one systemd `PropertiesChanged` match. While Voxtype records: the 2 s watchdog, one clock (the timeline, or a
  500 ms timeout with animations off) and one socket reader, plus a retry timeout between a failure and its retry.
  While it transcribes: the watchdog, the composing timeline and one 8 s one-shot (`still-seconds`). Busy modes also
  hold the `voxtype/cancel` watch. After it: one receipt timeout of at most 1.9 s from the receipt start.
  A state change starts at most one transition clock (a non-repeating timeline of at most 260 ms, or the receipt glyph's
  about 442 ms, or the 150 ms opening-Seed tween), removed when it ends; busy-bound transitions ride the clock that
  runs. While the menu is open and busy: one 1 s timeout for the elapsed line; the copy chip's 1.2 s timeout.

## Testing in a nested shell

Live checks run in an isolated nested GNOME Shell, never the real session. Run it under `dbus-run-session`, so the
systemd watch can never see the real `voxtype.service`: put a fake `org.freedesktop.systemd1` on that private bus
(see `tests/test-unit.js`) and a fake `voxtype` on the nested `PATH` that logs its argv. Use a private
`XDG_RUNTIME_DIR` (a short path: Wayland socket paths are limited to 107 bytes) and fake `voxtype/state`
and `voxtype/voxtype.lock` files inside it; never touch `/run/user/$UID/voxtype/`. The `--devkit` window
did not pump frames on this machine, so animations stood still; `gnome-shell --headless --virtual-monitor
1280x800` runs its own frame clock. Screenshots and `Eval` need unsafe mode, which a throwaway probe
extension in the nested `XDG_DATA_HOME` switches on. `docs/screenshots/feeder.js` is a fake Voxtype level feed:
it serves `voxtype/audio.sock` frames at 100 Hz from a control file (`speech`, `quiet`, `mute`, `none`, `absent`,
`drop`), so a run can show the trace reacting without a microphone. The extension needs the socket bound before the
state file says `recording`, or its first connect fails and it retries 250 ms later. `gdbus call` parses its string
argument as GVariant text, so an `Eval` snippet must not contain a backslash escape such as `\n`. Every nested
shell holds inotify instances: with a low `max_user_instances`, `make test` (`tests/test-source.js`) cannot attach
its file monitors while one runs, so stop the nested shell first.

## Workflow

PRs target `dev`; `master` is the release branch and carries the tags. See `RELEASE.md` for tagging and
the extensions.gnome.org upload, `CONTRIBUTING.md` for the security expectations around GitHub Actions
(pin third-party actions to a 40-char SHA; fork PRs may not touch workflows/Makefile).

## Coding Style & Naming Conventions

ES modules, four-space indentation, semicolons, single-quoted strings, braces on the same line.
`UPPER_SNAKE_CASE` for constants, `PascalCase` for classes, `camelCase` for variables and methods, and an
underscore prefix for private helpers. Comments say only the why the code cannot show. Log with the
`[Dictation Indicator]` prefix: `console.debug` for state changes, `console.warn` for read/monitor errors,
each warning once.
Every source file opens with `SPDX-License-Identifier: GPL-2.0-or-later` (`GPL-2.0-or-later AND MIT` in `orb.js`); the
schema and `metadata.json` take none. A shell script keeps its shebang first and takes the line second.

## Commit & Pull Request Guidelines

Concise imperative subjects, Conventional Commit prefixes such as `feat:` and `fix:`. Keep each commit
focused. Open pull requests against `dev` with a summary, change type and validation results. Add
screenshots for visible changes. Do not include generated artifacts or unrelated refactors. Preserve
least-privilege workflow permissions.
