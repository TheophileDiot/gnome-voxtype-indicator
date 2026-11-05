// SPDX-License-Identifier: GPL-2.0-or-later
// Fake Voxtype level feed for the nested-shell runs and capture-demo.sh. Never used against the real daemon.
//
//   gjs -m feeder.js <runtime dir> <control file> [log file]
//
// Serves 16-byte frames (seq u32, min f32, max f32, peak_dbfs f32, native order) at 100 Hz on
// <runtime dir>/voxtype/audio.sock. The control file holds one word, re-read every 20 ms:
//   speech  syllable bursts around -20 dBFS with short pauses
//   quiet   a live microphone in a silent room, about -70 dBFS
//   mute    exactly -Infinity, which the extension reads as a muted source
//   none    socket bound, nothing sent
//   absent  no socket at all (an old Voxtype, or the daemon down)
//   drop    close every client once, then behave as `none`
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [runtimeDir, controlFile, logFile] = ARGV;
const dir = GLib.build_filenamev([runtimeDir, 'voxtype']);
const sockPath = GLib.build_filenamev([dir, 'audio.sock']);
GLib.mkdir_with_parents(dir, 0o700);

const log = line => {
    if (!logFile)
        return;
    const out = Gio.File.new_for_path(logFile).append_to(Gio.FileCreateFlags.NONE, null);
    out.write_all(new TextEncoder().encode(`${(GLib.get_monotonic_time() / 1000).toFixed(1)} ${line}\n`), null);
    out.close(null);
};

let service = null;
const clients = new Set();

function bind() {
    GLib.unlink(sockPath);
    service = new Gio.SocketService();
    service.add_address(new Gio.UnixSocketAddress({path: sockPath}), Gio.SocketType.STREAM,
        Gio.SocketProtocol.DEFAULT, null);
    service.connect('incoming', (_s, connection) => {
        clients.add(connection);
        log(`client connected (${clients.size})`);
        return false;
    });
    service.start();
}

function unbind() {
    for (const c of clients)
        try { c.close(null); } catch (_e) { /* gone */ }
    clients.clear();
    service?.stop();
    service?.close();
    service = null;
    GLib.unlink(sockPath);
}

let mode = 'absent';
let seq = 0;
let tick = 0;
let rng = 7;
const rand = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
};

function peakDb() {
    switch (mode) {
    case 'speech': {
        // 90 ticks of speech split into syllables: 25 ticks voiced, 8 ticks gap, with some jitter
        const t = tick % 330;
        const inSyllable = (t % 110) < 80;
        return inSyllable ? -26 + 12 * Math.sin((t % 110) / 80 * Math.PI) + (rand() - 0.5) * 6 : -55 - rand() * 8;
    }
    case 'quiet':
        return -70 + (rand() - 0.5) * 4;
    case 'mute':
        return -Infinity;
    default:
        return null;
    }
}

function frameBytes(db) {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    const lin = db === -Infinity ? 0 : 10 ** (db / 20);
    view.setUint32(0, seq >>> 0, little);
    view.setFloat32(4, -lin, little);
    view.setFloat32(8, lin, little);
    view.setFloat32(12, db, little);
    return new Uint8Array(buf);
}

function readMode() {
    try {
        const [ok, bytes] = GLib.file_get_contents(controlFile);
        return ok ? new TextDecoder().decode(bytes).trim() : mode;
    } catch (_e) {
        return mode;
    }
}

function dropClients() {
    for (const c of clients)
        try { c.close(null); } catch (_e) { /* gone */ }
    clients.clear();
}

// `drop` closes every client once and then behaves as `none`; the others are plain modes.
function applyMode(next) {
    log(`mode ${mode} -> ${next}`);
    const was = mode;
    if (next === 'absent') {
        unbind();
        mode = 'absent';
        return;
    }
    if (was === 'absent')
        bind();
    if (next === 'drop') {
        dropClients();
        log('dropped every client');
        mode = 'none';
    } else {
        mode = next;
    }
}

let wantedBefore = '';
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
    const wanted = readMode();
    if (wanted !== wantedBefore) {
        wantedBefore = wanted;
        applyMode(wanted);
    }
    return GLib.SOURCE_CONTINUE;
});

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
    tick++;
    const db = peakDb();
    if (db === null || clients.size === 0)
        return GLib.SOURCE_CONTINUE;
    const bytes = frameBytes(db);
    seq++;
    for (const c of [...clients]) {
        try {
            c.get_output_stream().write_all(bytes, null);
        } catch (_e) {
            clients.delete(c);
            log(`client gone (${clients.size})`);
        }
    }
    return GLib.SOURCE_CONTINUE;
});

log('feeder up');
GLib.MainLoop.new(null, false).run();
