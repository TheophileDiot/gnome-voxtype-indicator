# Product

<!-- impeccable:product-schema 1 -->

## Platform

Native Linux desktop, GNOME Shell 46 through 50. Tested on GNOME Shell 50.1 (Yaru and the stock dark and light styles).

## Stack

GJS ES modules using GNOME Shell, St, Clutter, Cairo, Gio, and GLib; GSettings for eight keys; Adw and Gtk 4 in the preferences window only. No build step, no bundled runtime, no package-manager dependencies.

## Users

One local Voxtype user who dictates with a keyboard shortcut and needs to see, without looking away from the text window, that Voxtype heard the shortcut, is recording, hears their voice, and is transcribing.

## Product Purpose

Show what Voxtype is doing from inside GNOME Shell, where drawing on screen is allowed: a top-bar orb (a calm Seed when Voxtype is idle or not running) and a pill at the top centre of the screen while Voxtype records or transcribes, with a small menu to start, stop or cancel dictation. Success means the user never wonders whether the shortcut worked or whether the microphone hears them, and the dictated text still lands in the window they were typing in.

## Positioning

Status first, with a light hand on the controls. The extension reads Voxtype's state file and its level socket, and it never opens the microphone. It never starts, stops or restarts the daemon, and it never writes Voxtype's config. It spawns `voxtype record <verb>` (`start`, `stop` or `cancel`) only when the user picks a menu item, with the menu closed first. The pill takes no keyboard focus and no pointer input, because Voxtype pastes into the focused window right after transcription.

## Operating Context

Runs in the gnome-shell process. One file monitor on `$XDG_RUNTIME_DIR/voxtype/state`. While Voxtype records: the 2 s watchdog, one clock (a frame-clock timeline, or a 500 ms timeout with animations off) and one reader on `audio.sock`. While it transcribes: the watchdog, the orb's timeline and one 8 s one-shot. After it: one receipt timeout of at most 1.9 s from the receipt start. Transitions of at most 260 ms run only on a state change (the opening Seed, 150 ms, only when the pointer reaches the button), each on one non-repeating timeline that ends with it; the receipt glyph's own one-shot clock, about 442 ms, is the only one longer. While the menu is open and busy, one 1 s timeout updates the elapsed time. Nothing while it is idle or not running: only passive handlers remain (GSettings `changed::`, the file monitors and one systemd `PropertiesChanged` match on `voxtype.service`). The top-bar button shows the idle orb by default (`panel-orb`: always, only while busy, or never); the pill shows only while Voxtype records or transcribes.

## Capabilities and Constraints

- Four orbs: recording (a red trace of dotted columns that scroll left and rise with the voice), transcribing (an amber dotted orb, an undulating sash), idle (the Seed, 19 still beads) and not running (the Seed ring, 10 beads). The Seed takes the panel's foreground ink, never the red or the amber. The trace is original to this project (`trace.js`); the sash is the thinking-orbs `composing` state at its 20 px preset (`orb.js`). Both are drawn with Cairo.
- What the pill says while recording, from Voxtype's level feed:
  - `Listening…` by default, and whenever there is no feed at all (an old Voxtype, the socket missing): the orb then swells by itself and the extension claims nothing.
  - `No signal` after 2 s of exact digital silence (5 s once the user has been heard): the trace goes flat and keeps scrolling.
  - `Can't hear you` after 6 s of live feed with no speech: the microphone is on but very quiet.
  - The button's accessible name carries the same hint.
- What it says after: `Still transcribing…` after 8 s of transcribing; then, on the `transcribing` to `idle` transition only, a receipt for 0.5 s (`Done`) or 1.5 s (`Nothing heard`, only when the recording had at least 2 s of feed and the user never spoke). It never says `Pasted`: the state file cannot prove the paste.
- A top-bar menu: a header with the state, the dictation actions (`Start dictation`, `Stop and transcribe`, `Cancel`) when `menu-controls` is on, a `Show pill` switch and `Settings…`. A cancel leaves no receipt.
- Eight settings in an Adw window (`prefs.js`): top-bar orb, pill, pill monitor, mic hints, receipt, the `Still transcribing…` delay, motion and menu controls. The same window sets the two dictation shortcuts: `Change…` opens a capture dialog and writes the user's own GNOME custom shortcut (`shortcuts.js`). No translations, no transcript display.
- The pill is `reactive: false`, `can_focus: false`, and is never added through `addChrome`, so it changes no struts and no input region. The top-bar button is reactive because it owns the menu; the menu never opens on its own and closes before any spawn.
- Colours and shapes live in `stylesheet.css`; motion and timing live in `extension.js`; the geometry lives in `trace.js` (recording) and `orb.js` (transcribing); the voice logic (frame decoding, the voice snapshot, the receipt choice, the menu items, the key classes and the shortcut path) lives in `common.js`, the state file and the systemd watch in `source.js`, and the socket in `levels.js`.
- St CSS is a subset of web CSS: no media queries, no custom properties. A rule that must differ per Shell style needs a class set from code.

## Brand Commitments

Keep recording `#ff6267` and transcribing `#ffad42`, shared with the Claude and Codex usage trackers (and the README banner and demo). Near-black `#111412` surface, at 95%, shared with the same trackers. The orbs credit thinking-orbs (MIT) by Jakub Antalík. On a light panel the inks darken to red `#c8323a` and amber `#9a5c12`.

## Product Principles

- Never take focus, never move the user's attention for longer than it takes to read one word.
- State is told by hue, motion and text together, never by hue alone: recording is a trace that follows the voice, transcribing is a sash that undulates.
- Say only what is known: a hint needs evidence (digital silence, or live feed with no speech), a missing feed claims nothing, and a receipt never claims the paste.
- GNOME owns typography, scaling, and accessibility behaviour: inherit the theme font, size in `em`, honour `enable_animations` and the high-contrast setting.
- Look like a part of the Shell: reuse its pill shape, hairline, status icon size and fade timing before inventing any.

## Accessibility & Inclusion

Text scales with GNOME's text size (all lengths in `em`). Label contrast is 15:1 or more on every surface. The two states differ by shape and motion (a trace against a sash), by the label text and by hue, not by hue alone, which red and amber blur for some deuteranopes. Measured in the nested shell on a 14 s run (speech, a quiet room, a muted source, speech again, then transcribing) over every painted frame of every 16 px orb, about 1,790 draws, the brightest pixel of the weakest frame reaches:

| Panel | Recording trace | Transcribing orb |
| --- | --- | --- |
| Black top bar, `#ff6267` and `#ffad42` | 5.6:1 | 7.1:1 |
| Dark pill | 5.1:1 | 6.3:1 |
| Light top bar `#fafafb`, `#c8323a` and `#9a5c12` | 4.3:1 | 4.8:1 |
| High-contrast pill and bar (black) | 5.6:1 | 7.2:1 |

The muted straight line is the weakest recording frame. A second measure on 17 lossless screenshot crops per panel agrees (weakest 4.4:1 to 5.8:1 for the top-bar orb). The composing dots are drawn at 1.5 times their upstream radius to get there; the trace dots are not scaled. Animations off gives a static, fully legible indicator: each orb stays on one frame, and the trace is redrawn only when the microphone's state changes. With GNOME's high-contrast setting on, the pill turns opaque black with a stronger edge. The Seed orbs, measured on lossless 16 px screenshot crops in the nested shell (best pixel): idle 10.5:1 and not running 14.9:1 on the black top bar and under high contrast, idle 5.1:1 and not running 7.7:1 on the light `#fafafb` bar. The button reports a status-bar role and the accessible names `Voxtype: listening`, `Voxtype: listening: can't hear you`, `Voxtype: listening: no signal`, `Voxtype: transcribing`, `Voxtype: idle` and `Voxtype: not running`. The hints are text, not colour: the label changes with them.
