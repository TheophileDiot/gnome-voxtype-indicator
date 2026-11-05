---
name: Dictation Indicator for Voxtype
description: A quiet status pill with a red trace that follows your voice and an amber thinking orb, built from the Shell's own pill, hairline and icon size.
colors:
  recording: "#ff6267"
  transcribing: "#ffad42"
  recording-on-light-panel: "#c8323a"
  transcribing-on-light-panel: "#9a5c12"
  pill-surface: "#111412"
  label: "#ffffff"
  hairline: "rgba(255, 255, 255, 0.1)"
  pill-surface-high-contrast: "#000000"
  hairline-high-contrast: "rgba(255, 255, 255, 0.4)"
typography:
  label:
    fontFamily: "theme font (stage)"
    fontSize: "1em"
    fontWeight: 400
rounded:
  pill: "999px"
spacing:
  pill-padding-block: "0.3em"
  pill-padding-start: "0.7em"
  pill-padding-end: "0.9em"
  gap: "0.5455em"
  orb: "1.0909em"
components:
  pill:
    backgroundColor: "{colors.pill-surface}"
    textColor: "{colors.label}"
    rounded: "{rounded.pill}"
    padding: "0.3em 0.9em 0.3em 0.7em"
  orb-recording:
    textColor: "{colors.recording}"
    size: "1.0909em"
  orb-transcribing:
    textColor: "{colors.transcribing}"
    size: "1.0909em"
---

# Design System: Dictation Indicator for Voxtype

## Overview

**Creative North Star: "The Shell's Own Pill"**

The indicator is a guest that dresses like its host. Its pill takes the shape and hairline the Shell already uses for `.dash-label` and `.window-caption`, and its orbs the size of the Shell's status icon, so it reads as a native element, not an overlay. The only things that are its own are the two state colours and the near-black surface it shares with the usage trackers.

It is built to be seen in the corner of an eye and then ignored. The pill takes no focus and asks for no input; the top-bar button owns a small menu that opens only when the user clicks it. State is told three ways at once (hue, motion, text) so no single channel carries it. The one thing that keeps moving is the orb, and only for as long as Voxtype records or transcribes. When Voxtype is idle or not running, the top-bar orb is a still Seed in the panel's own foreground colour.

**Key Characteristics:**
- Pill shape and 1px hairline copied from the Shell, in `em` so they follow text scaling.
- Recording is Trace · Pulse, our own dotted trace drawn with Cairo (`trace.js`); transcribing is `composing` from thinking-orbs at its 20 px preset (an undulating sash).
- Brand colours stay on a dark panel; light panels get darker variants chosen by a 3:1 rule.

## Colors

Two state hues on a near-black pill, white text, nothing else.

### Primary
- **Record Coral** (#ff6267): the ink of the recording trace. The colour is 7.2:1 on the black panel and 6.3:1 on the pill; the trace is built from small dots, so the brightest pixel of its weakest frame (the muted straight line) measured 5.6:1 on the black panel and 5.1:1 on the pill over about 700 painted frames.
- **Transcribe Amber** (#ffad42): the ink of the transcribing orb. The colour is 11.3:1 on the black panel and 8.1:1 on the pill; the brightest pixel of its weakest frame measured 7.1:1 on the black panel and 6.3:1 on the pill, and most of the orb is dimmer.

### Neutral
- **Pill Ink** (#111412 at 95%): the pill surface, shared with the usage trackers. It was 92%, and text from light windows ghosted through.
- **Label White** (#ffffff): the label; 15:1 or more over any content behind the pill.
- **Hairline** (rgba(255,255,255,0.1)): the pill edge, the Shell's own border value; it is what keeps the pill visible on a dark window.

### High contrast
- **Pill Black** (#000000) and **High-Contrast Edge** (rgba(255,255,255,0.4)): the pill surface and border while GNOME's high-contrast setting is on, the values the Shell's own pill uses. Applied by the `.high-contrast` class that `extension.js` toggles from `St.Settings`.

### Light-panel variants
- **Record Coral, light panel** (#c8323a) and **Transcribe Amber, light panel** (#9a5c12): 5.1:1 on the stock light panel (#fafafb) at full ink. The dots stay a little under full ink at 16 px, so the inks are darker than the 3:1 rule alone would ask. Measured over every painted frame of the top-bar orb on a #fafafb panel (about 700 recording and 180 transcribing frames), the brightest pixel of the weakest frame reached 4.3:1 (recording, the muted line) and 4.8:1 (transcribing). Applied by the `.light-panel` class that `extension.js` sets from the panel's background; the pill orbs stay on the dark pill and never take it.

### Seed ink
- **Panel foreground:** the idle and not-running Seed takes the panel's own foreground: `#ffffff` on the dark panel, `#2e3436` under `.light-panel`, and white in high contrast. It is never the red or the amber, because those mean busy. Measured on lossless 16 px screenshot crops in the nested shell (best pixel): idle 10.5:1 and not running 14.9:1 on the black panel and under high contrast; idle 5.1:1 and not running 7.7:1 on the light `#fafafb` panel.

### Named Rules
**The Dark-Panel Brand Rule.** Brand colours are used as they are wherever the panel is dark (Yaru, stock dark). A variant exists only where a measured contrast number fails.
**The Three-Channel Rule.** A state is never told by hue alone: hue, shape and motion (a trace that follows the voice against a sash that undulates), and label text always agree.
**The Say-Only-What-You-Know Rule.** A hint needs evidence. `No signal` needs exact digital silence, `Can't hear you` needs a live feed with no speech, and a missing feed says `Listening…` and nothing else.

## Typography

**Font:** the theme font, inherited from the stage. No bundled fonts.

**Character:** the same voice as the Shell's tooltips; short words, regular weight.

### Hierarchy
- **Label** (400, 1em = the theme size, 11pt by default): `Listening…`, `Can't hear you`, `No signal`, `Transcribing…`, `Still transcribing…`, `Done`, `Nothing heard`. All sizes are `em` or `pt`; a fixed `px` size ignores GNOME's text scaling.

### Named Rules
**The Scale-With-The-Shell Rule.** Every length in the stylesheet is in `em`. At text scaling 1.5 the pill grows with the panel (28 px to 43 px).

## Layout

One pill, centred horizontally on the monitor of the focused window (or the primary monitor, by the `pill-monitor` setting), 12 px below the top bar. The orb sits 0.7em plus the 1px hairline, about 11 px, from the left end cap, centred vertically. It is 1.0909em, the Shell's status icon size. The pill reserves the width of the widest label of the state it shows (`Can't hear you` while recording, `Still transcribing…` while transcribing and on the receipt), so a hint never re-centres it. It is placed once per show, then glided once at the hand-off, so it is a little wider while transcribing. The gap between orb and text is 0.5455em (8 px).

## Elevation & Depth

Flat. The pill is a near-opaque surface (95%) with a hairline edge and no shadow; the Shell's own pill has none either. Depth over light content comes from the surface alone; over dark content, from the hairline.

## Shapes

Full pill (999px) for the surface. All the marks are orbs drawn in a 20 px frame and scaled to 1.0909em. The recording trace is at most 42 dots: six visible columns of one centre bead and up to three beads above and below. The transcribing orb is about two hundred dots on a tilted band, so it reads as a moving sash.

## Components

### Pill
- **Shape:** fully rounded (999px), 1px hairline.
- **Surface:** #111412 at 95%; label #ffffff. Under high contrast: #000000 with a rgba(255,255,255,0.4) hairline.
- **States:** recording and transcribing differ only in the orb and the label text. After transcribing the pill draws a check (`Done`) or a flat line (`Nothing heard`) over the fading amber sash for a receipt, then holds the label for 0.5 s or 1.5 s from 400 ms after the receipt start, and leaves with a 0.2em lift. The extension still never says `Pasted`: the check marks the end of the transcription, and the label says what happened.
- **Motion**, all `EASE_OUT_QUAD`, the Shell OSD's curve: it arrives with opacity over 150 ms and a 0.4em rise over 180 ms; it leaves with opacity only over 100 ms (a receipt exit adds a 0.2em lift); a label change cross-fades, out over 60 ms and in over 90 ms, inside the reserved width. At the hand-off the pill's width and x ease together over 200 ms, so it widens and stays centred: the only time it moves. A hint change never moves it. It stays `reactive: false` and `can_focus: false` through every `ease()`. Instant when animations are off or `motion` is `still`.

### Orbs
- **Recording: Trace · Pulse** (`trace.js`, ours), ink #ff6267, #c8323a on a light panel. A row of dotted columns scrolls left, one column every 130 ms and 3.2 units apart, at most 8 kept and about 6 visible, born at x = 17.8 and tapering to nothing at the left edge. A column holds the highest level of its 130 ms slot as a centre bead (radius 1.3) and up to three beads above and below (pitch 2.5), so a loud word makes a tall bar. A new word, or the voice gate opening, pops the newest beads by up to 0.45 and the pop decays over 130 ms.
  - **Live silence:** a slow wave, `1.5 sin(2π t / 2.2 s − 0.5 x)`, damped to nothing as a column's value grows.
  - **Muted (exact digital silence):** every column flattens at once and the row keeps scrolling, so the user still sees that the recording runs. The wave fades back over 200 ms.
  - **No feed:** an autonomous swell scaled by 0.6, so its motion sits between live silence and speech (measured per 100 ms in a 16 px raster: speech 41.5, no feed 21.4, live silence 10.0).
  - **Radii are final**, there is no gain. Reduced motion draws one still frame per coarse state: wave, bars, swell or a straight row.
- **Voice mapping** (`common.js`): level is `clamp((dBFS + 48) / 28, 0, 1)`; `fast` and `slow` are one-pole followers (25 ms / 140 ms and 120 ms / 400 ms) advanced per 10 ms frame, so the orb behaves the same at any refresh rate; the gate opens at level 0.25 held 60 ms and closes below 0.12 held 700 ms.
- **Transcribing:** the `composing` orb at the 20 px preset of thinking-orbs (MIT, Jakub Antalík), ink #ffad42, #9a5c12 on a light panel, about 20 s per loop. Geometry in `orb.js`, checked against upstream's golden values. Its dots are drawn at 1.5 times upstream's radius (`DOT_GAIN`; upstream tunes the 20 px preset for a 2x canvas, and at 16 device pixels most dots would cover less than a pixel).
- **Transitions** (at most 260 ms, one curve, only on a state change; each surface paints a list of layers, each in its own ink, so two inks never blend into one dot, and the first frame of a new transition equals the last one painted, also after an interruption):
  - **Unfold** (idle to recording, 240 ms): the Seed's centre row becomes the trace's first columns, the other beads slide onto the centre line and shrink away, and the seed layer's ink slides from the panel foreground to the red over 150 ms. The trace is live from the first frame after a 650 ms quiet warm-up, so it already has six columns.
  - **Hand-off** (recording to transcribing, 240 ms): the red trace gathers to the centre over 120 ms and the amber sash blooms out of it from 50 ms. The pill glides to its new width and the label dips. This replaces the 150 ms ink slide.
  - **Receipt** (transcribing to idle, option B): the button switches to the Seed at once; the pill's sash fades over 140 ms while amber beads grow into a check (8 beads) or a flat line (6 beads), 200 ms a bead with a 26 ms stagger, complete at about 442 ms or 390 ms on its own one-shot clock.
  - **Withdraw** (a cancelled period, 220 ms): whatever is on screen draws in to the centre over 120 ms in its own ink and the Seed blooms from 80 ms. No receipt, and the pill only fades.
  - **Break** (idle to not running 260 ms, and back 200 ms): the Seed's rim stretches onto the ring, the two gap beads shrink first, the seven inner beads next. After a crash mid-dictation the busy shape gathers over 140 ms and the ring blooms from 60 ms.
  - **Opening Seed** (the button, 150 ms open, 120 ms close): hover or focus opens it to 0.5, menu open or press to 1: spacing 2.7 + 0.2·o, bead radius 1.2 + 0.12·o, rim alpha slope 0.38 − 0.18·o (the ring: radius 1.25 + 0.13·o, alpha 0.85 + 0.15·o).
  - **Still:** with animations off or `motion` `still` every transition paints its final frame on the first paint, and nothing translates.
  - **Two flagged exceptions** to the rules below, accepted as deliberate: the transcribing orb is not scaled "by hand" except for the 240 ms of the hand-off, where the bloom moves its dots toward the centre and the settled frame is upstream's exactly; and the receipt glyph's one-shot clock runs about 442 ms, the only clock allowed past 260 ms.
- **Idle: Seed** (`orb.js`, `SEED_IDLE`), the panel foreground. Static, dots only, in the 20-unit frame: 19 beads, hex-packed. For `p, q` in −2..2 with `|p + q| ≤ 2`, `x = 10 + 2.7·(p + q/2)`, `y = 10 + 2.7·q·√3/2`, `r = 1.2`, and `a = 1 − 0.38·d`, where `d` is the distance from the centre divided by 5.4. Painted once per state change, with no clock.
- **Not running: the Seed ring** (`orb.js`, `SEED_OFFLINE`), the panel foreground. 10 beads on a ring of radius 6.2: positions `i = 0..11` at angle `i/12·2π − π/2`, with `i = 1, 2` skipped (a gap at the top right), `r = 1.25`, `a = 0.85`.
- **Both:** drawn by an `St.DrawingArea` with Cairo, the colour read from the theme node of the state's class. One clock runs only while recording or transcribing. Measured in the nested shell, the trace draws in 0.10 ms on average (p95 0.17 ms, worst 0.21 ms over 480 draws, both orbs) and a whole repaint, theme node included, takes 0.13 ms (p95 0.23 ms); the composing orb was measured earlier at 0.41 ms (1.05 ms worst). With animations off each orb draws its own fixed frame and the trace repaints only when `feed`, `gate` or the hint changes.
- **Where:** the top bar and the pill. The pill is not reactive and has no hover or focus ring. The top-bar button is reactive and carries the menu.

### Menu
- A standard Shell `PopupMenu` under the top-bar button, in the Shell's own style with one family of details: width 22em, radius 1em, action rows 2.35em high with radius 0.6em. No custom colours.
- **Header** (not reactive): the live orb at 1.8182em, drawn by the same code as the bar, and the title in bold: `Voxtype: idle`, `Voxtype: listening`, `Voxtype: transcribing` or `Voxtype is not running`. The hint suffix (` · can't hear you`, ` · no signal`) is at weight 400 and 60% alpha, set in markup so the text stays exact. A second line at 90% size and 62% opacity says `Ready` while idle and the elapsed `m:ss` while busy, from one 1 s timeout that runs only while the menu is open and busy.
- **Offline:** the exact command `systemctl --user start voxtype` is a chip (monospace, hairline, a copy glyph) that copies itself to the clipboard; the glyph is a check for 1.2 s. It is the only actionable item and never spawns.
- **Key caps:** the user's own GNOME custom shortcuts that run `voxtype record toggle` or `record cancel`, read once on every open, shown as hairline caps on the action rows (`Alt Space` on Start and Stop, `Alt Shift Space` on Cancel). No match, no caps; nothing is invented. The menu only reads them: they are changed from the `Change…` button on the Controls rows in Settings.
- **Actions** (when `menu-controls` is on): `Start dictation` when idle; `Stop and transcribe` and `Cancel` while recording; `Cancel` while transcribing; none when Voxtype is not running.
- **Always last:** a separator, a `Show pill` switch and `Settings…`.
- The menu closes before an action spawns anything, and closes at once when the mode turns to transcribing or idle, so it never holds a grab while Voxtype pastes. A change that leaves it open (idle to recording, offline and back) first makes the outgoing action rows insensitive, fades the text and rows out over 90 ms, swaps them, fades in over 150 ms and eases the height; a click during the fade spawns nothing.

## Do's and Don'ts

### Do:
- **Do** size every length in `em` so the indicator follows GNOME text scaling.
- **Do** keep a non-colour cue for each state: the orb's shape and motion, and the label text.
- **Do** end motion with `EASE_OUT_QUAD`, and make exits no slower than entrances.
- **Do** check a new colour against the black panel and the stock light panel, with WCAG and APCA numbers.

### Don't:
- **Don't** use `px` for font size or padding; it ignores text scaling.
- **Don't** use `EASE_IN_*` on a fade; it starts slow exactly when the user is watching.
- **Don't** add a shadow, a gradient or a second accent colour.
- **Don't** scale the transcribing orb or redraw it by hand (the one exception is the 240 ms bloom of the hand-off, see Transitions): the 20 px preset is a separate tuning in thinking-orbs, and `orb.js` stays a port that the golden test pins. The trace has its own tests (`tests/test-trace.js`); re-tune it only with its checks.
- **Don't** give the pill input, focus or a position through `addChrome`; Voxtype pastes into the focused window.
- **Don't** let the pill vanish over a maximised window on a monitor without a top bar: while it is shown it inhibits unredirect, as the Shell's OSD does, and releases it once it is hidden (never at idle).
- **Don't** paint the idle or not-running Seed in the red or amber ink, and don't run a clock while it rests: those mean busy. Only a state change or the pointer moves it, for at most 260 ms.
- **Don't** change `#ff6267` or `#ffad42` on a dark panel; the README banner and demo are built on them.
