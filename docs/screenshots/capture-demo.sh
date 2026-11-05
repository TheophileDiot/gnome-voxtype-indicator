#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Re-record docs/screenshots/demo.gif from a real nested GNOME Shell. Never touches the real session:
# private D-Bus session, private XDG_RUNTIME_DIR, private PipeWire, fake voxtype/state and voxtype.lock.
#
#   VT_EXT_DIR  extension folder to test (default: the installed copy)
#   VT_CSS      optional stylesheet that replaces the one in VT_EXT_DIR (to preview a restyle)
#   VT_OUT      output folder (default: the folder of this script)
#   VT_WORK     scratch folder, wiped on start (default: ~/.cache/voxtype-demo)
#
# Needs: gnome-shell 46+, dbus-run-session, pipewire, gdbus, ffmpeg, gjs.
# The recording trace is driven by feeder.js, a fake level feed on the private audio.sock: no microphone is opened.
set -euo pipefail

UUID=voxtype-indicator@theophilediot.github.io
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
EXT=${VT_EXT_DIR:-$HOME/.local/share/gnome-shell/extensions/$UUID}
OUT=${VT_OUT:-$HERE}
W=${VT_WORK:-$HOME/.cache/voxtype-demo}
CROP=(236 0 816 88)   # x y w h of the 1280x800 virtual monitor: centred on the pill, includes the top-bar orb, stops before the Shell's own recording dot
FPS=20

[ -f "$EXT/extension.js" ] || { echo "no extension.js in $EXT" >&2; exit 1; }
[ -z "${VT_CSS:-}" ] || [ -f "$VT_CSS" ] || { echo "VT_CSS not found: $VT_CSS" >&2; exit 1; }

rm -rf "$W"
mkdir -p "$W/data/gnome-shell/extensions/$UUID" "$W/config/wireplumber/wireplumber.conf.d" "$W/cache" "$OUT"
# the private WirePlumber links the screencast stream; every device monitor stays off so it never
# opens real audio, camera or Bluetooth hardware
cat > "$W/config/wireplumber/wireplumber.conf.d/90-demo.conf" <<'CONF'
wireplumber.profiles = {
  main = {
    monitor.alsa = disabled
    monitor.alsa-midi = disabled
    monitor.bluez = disabled
    monitor.bluez-midi = disabled
    monitor.v4l2 = disabled
    monitor.libcamera = disabled
  }
}
CONF
# short path: Wayland socket paths are limited to 107 bytes
RT=$(mktemp -d /run/user/"$(id -u)"/vtdemo.XXXXXX)
chmod 700 "$RT"

cleanup() {
    # everything started here carries the private runtime dir in its environment
    for p in $(pgrep -u "$(id -u)" .); do
        [ "$p" = "$$" ] && continue
        grep -a -q "XDG_RUNTIME_DIR=$RT" "/proc/$p/environ" 2>/dev/null && kill "$p" 2>/dev/null || true
    done
    [ -z "${FAKE_PID:-}" ] || kill "$FAKE_PID" 2>/dev/null || true
    [ -z "${FEED_PID:-}" ] || kill "$FEED_PID" 2>/dev/null || true
    sleep 2
    for m in gvfs doc; do fusermount3 -u "$RT/$m" 2>/dev/null || true; done
    rm -rf "$RT"
}
trap cleanup EXIT

D="$W/data/gnome-shell/extensions/$UUID"
cp "$EXT"/*.js "$EXT"/metadata.json "$EXT"/stylesheet.css "$D/"
[ -z "${VT_CSS:-}" ] || cp "$VT_CSS" "$D/stylesheet.css"

# unsafe mode is needed for Eval and the Screencast API
P="$W/data/gnome-shell/extensions/nested-probe@local"
mkdir -p "$P"
printf '%s\n' '{"uuid": "nested-probe@local", "name": "Nested probe", "description": "Test-only", "shell-version": ["46","47","48","49","50"]}' > "$P/metadata.json"
cat > "$P/extension.js" <<'JS'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class Probe extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
JS

export UUID W
export XDG_DATA_HOME="$W/data" XDG_CONFIG_HOME="$W/config" XDG_CACHE_HOME="$W/cache" XDG_RUNTIME_DIR="$RT"
unset WAYLAND_DISPLAY DISPLAY
# English clock and labels whatever the host locale is
export LC_ALL=en_US.UTF-8 LANGUAGE=en_US
setsid dbus-run-session -- bash -c '
  echo "$DBUS_SESSION_BUS_ADDRESS" > "$W/bus"
  pipewire >"$W/pipewire.log" 2>&1 &
  sleep 1
  wireplumber >"$W/wireplumber.log" 2>&1 &
  sleep 1
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions "[\"$UUID\", \"nested-probe@local\"]"
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
  gsettings set org.gnome.desktop.notifications show-banners false
  exec gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800
' > "$W/shell.log" 2>&1 &

for _ in $(seq 60); do [ -s "$W/bus" ] && break; sleep 0.5; done
DBUS_SESSION_BUS_ADDRESS=$(cat "$W/bus"); export DBUS_SESSION_BUS_ADDRESS
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
EXTOBJ="Main.extensionManager.lookup('$UUID').stateObj"
for _ in $(seq 60); do
    ev "Main.extensionManager.lookup('$UUID').state" 2>/dev/null | grep -q "'1'" && \
        ev 'global.context.unsafe_mode' 2>/dev/null | grep -q "'true'" && break
    sleep 0.5
done
ev "Main.extensionManager.lookup('$UUID').state" | grep -q "'1'" || { echo "extension not active, see $W/shell.log" >&2; exit 1; }

# Fake daemon: a process whose comm is `voxtype`, so a comm check in the lock test passes.
printf '%s\n' '#!/bin/sh' 'while :; do sleep 1; done' > "$W/voxtype"
chmod +x "$W/voxtype"
"$W/voxtype" & FAKE_PID=$!
mkdir -p "$RT/voxtype"
printf '%s' "$FAKE_PID" > "$RT/voxtype/voxtype.lock"
printf '%s' idle > "$RT/voxtype/state"
# Fake level feed. The socket must be bound before the state says `recording`, or the first connect fails and
# the extension retries 250 ms later.
printf '%s' speech > "$W/feed"
gjs -m "$HERE/feeder.js" "$RT" "$W/feed" >"$W/feeder.log" 2>&1 & FEED_PID=$!
feed() { printf '%s' "$1" > "$W/feed"; }
sleep 0.4

# GLib's inotify backend is missing on some machines (inotify instance limit): the extension's file
# monitor then cannot attach. Nudging the extension's own coalesced read keeps the same path from the
# read onward, so the clip is the same either way.
nudge() { ev "(function(o){var t=o._source||o;t._scheduleRead();})($EXTOBJ)" >/dev/null; }
set_state() { printf '%s' "$1" > "$RT/voxtype/state"; nudge; }
mode() { ev "(function(o){return o._mode;})($EXTOBJ)"; }

nudge; sleep 1

# The Shell stops a screencast when its D-Bus caller disconnects, so a one-shot gdbus call cannot own it:
# a gjs client keeps the connection open for the whole timeline, then stops it.
cat > "$W/rec.mjs" <<'JS'
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const [x, y, w, h, template, seconds, ready] = ARGV;
const call = (method, params) => Gio.DBus.session.call_sync(
    'org.gnome.Shell.Screencast', '/org/gnome/Shell/Screencast', 'org.gnome.Shell.Screencast',
    method, params, null, Gio.DBusCallFlags.NONE, 20000, null);
const opts = {framerate: new GLib.Variant('i', 30), 'draw-cursor': new GLib.Variant('b', false)};
const [ok, file] = call('ScreencastArea', new GLib.Variant('(iiiisa{sv})',
    [Number(x), Number(y), Number(w), Number(h), template, opts])).deepUnpack();
if (!ok) throw new Error('ScreencastArea refused');
GLib.file_set_contents(ready, file);
GLib.usleep(Number(seconds) * 1e6);
call('StopScreencast', null);
JS
gjs -m "$W/rec.mjs" "${CROP[@]}" "$W/rec" 8.5 "$W/rec.ready" & REC_PID=$!
for _ in $(seq 40); do [ -s "$W/rec.ready" ] && break; sleep 0.25; done
[ -s "$W/rec.ready" ] || { echo "screencast did not start, see $W/shell.log" >&2; exit 1; }
sleep 0.4;  set_state recording
sleep 1.5;  feed quiet
sleep 0.9;  feed speech
sleep 1.3;  echo "mode while recording: $(mode)"; set_state transcribing; feed none
sleep 2.0;  echo "mode while transcribing: $(mode)"; set_state idle
# The Shell sends screencast frames only on damage, and the `Done` receipt is a still pill for 0.5 s: flick the
# opacity (1/255, invisible) through it so the clip holds the receipt instead of skipping to the fade.
flick() { ev "Main.uiGroup.opacity = 254" >/dev/null; ev "Main.uiGroup.opacity = 255" >/dev/null; }
sleep 0.1;  flick
sleep 0.1;  flick
sleep 0.1;  flick
sleep 0.1;  flick
sleep 0.2;  echo "mode at idle: $(mode)"
# The Shell sends screencast frames only on damage: a 1/255 opacity flick forces a last frame of the idle
# screen, so the clip does not end on a stale mid-fade pill.
ev "Main.uiGroup.opacity = 254" >/dev/null; sleep 0.2; ev "Main.uiGroup.opacity = 255" >/dev/null; sleep 0.4
wait $REC_PID
REC=$(cat "$W/rec.ready")
# the encoder finishes the file after StopScreencast returns
for _ in $(seq 40); do ffprobe -v error "$REC" 2>/dev/null && break; sleep 0.5; done
# Encoder start-up adds idle frames before the first change: cut to 0.6 s before the pill appears.
FIRST=$(ffmpeg -v info -i "$REC" -vf "select='gt(scene,0.0005)',showinfo" -an -f null - 2>&1 \
    | { grep -o 'pts_time:[0-9.]*' || true; } | head -1 | cut -d: -f2)
START=$(awk -v t="${FIRST:-0.6}" 'BEGIN { s = t - 0.6; print (s < 0 ? 0 : s) }')
echo "first change at ${FIRST:-none}s, trimming to start at ${START}s"
# fps first (it repeats the idle frame through the damage-free stretch), then trim
CUT="fps=$FPS,trim=start=$START,setpts=PTS-STARTPTS"
ffmpeg -v error -y -i "$REC" -vf "$CUT,palettegen=stats_mode=diff:max_colors=96" "$W/palette.png"
ffmpeg -v error -y -i "$REC" -i "$W/palette.png" \
    -lavfi "[0:v]${CUT}[x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 "$OUT/demo.gif"
ls -l "$OUT/demo.gif"
