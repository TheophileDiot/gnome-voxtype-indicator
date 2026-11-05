// SPDX-License-Identifier: GPL-2.0-or-later
// Voxtype level source: reads the daemon's level socket while it records.
// Gio and GLib only (plus ./common.js), so tests/test-levels.js can run it under plain `gjs -m`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {decodeFrames, stateDirPath} from './common.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async', 'connect_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

const LOG = '[Dictation Indicator]';

const GLIB_TIMERS = {
    add: (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, fn),
    remove: id => GLib.source_remove(id),
};

// Frames from $XDG_RUNTIME_DIR/voxtype/audio.sock, 16 bytes each at 100 Hz while Voxtype records.
// start() on entering recording, stop() on leaving it: nothing exists in between, and no callback
// runs after stop(). It parses only; it never reads the microphone and never stores or logs a level.
export class VoxtypeLevelSource {
    // onFrames(frames: [{seq, db}], arrivalUs) gets the valid frames of one read.
    // onConnected(connected) is called on every connect and every loss, so it may repeat.
    constructor({
        runtimeDir, onFrames, onConnected, retryDelaysMs = [250, 1000, 2000], maxInvalid = 30,
        timers = GLIB_TIMERS,
    }) {
        this._path = GLib.build_filenamev([stateDirPath(runtimeDir), 'audio.sock']);
        this._onFrames = onFrames;
        this._onConnected = onConnected;
        this._delays = retryDelaysMs;
        this._maxInvalid = maxInvalid;
        this._timers = timers;
        this._cancellable = null;
        this._connection = null;
        this._retryId = 0;
    }

    start() {
        this.stop();
        this._cancellable = new Gio.Cancellable();
        this._retries = 0;
        this._logged = false;
        this._connect();
    }

    stop() {
        this._cancellable?.cancel();
        if (this._retryId) {
            this._timers.remove(this._retryId);
            this._retryId = 0;
        }
        this._closeConnection();
    }

    _closeConnection() {
        const connection = this._connection;
        this._connection = null;
        closeQuietly(connection);
    }

    // The connect is not tied to the cancellable on purpose: a unix connect is immediate, and a
    // late completion after stop() must close its connection rather than leave it to the GC.
    async _connect() {
        const cancellable = this._cancellable;
        let connection;
        try {
            connection = await new Gio.SocketClient().connect_async(
                new Gio.UnixSocketAddress({path: this._path}), null);
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._lost(e.message);
            return;
        }
        if (cancellable.is_cancelled()) {
            closeQuietly(connection);
            return;
        }
        this._connection = connection;
        this._logged = false;
        this._onConnected(true);
        await this._readLoop(connection, cancellable);
    }

    // One outstanding read at a time. A read can end mid-frame: decodeFrames keeps the tail.
    async _readLoop(connection, cancellable) {
        const input = connection.get_input_stream();
        let carry = new Uint8Array(0);
        let invalidRun = 0;
        for (;;) {
            let bytes;
            try {
                bytes = await input.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable);
            } catch (e) {
                if (!cancellable.is_cancelled())
                    this._lost(e.message);
                return;
            }
            if (cancellable.is_cancelled())
                return;
            const arrivalUs = GLib.get_monotonic_time();
            if (bytes.get_size() === 0) {
                this._lost('closed by the daemon');
                return;
            }

            const decoded = decodeFrames(carry, bytes.toArray());
            carry = decoded.carry;
            const valid = [];
            let gaveUp = false;
            for (const frame of decoded.frames) {
                if (frame.valid) {
                    invalidRun = 0;
                    valid.push({seq: frame.seq, db: frame.db});
                } else if (++invalidRun >= this._maxInvalid) {
                    gaveUp = true;
                    break;
                }
            }
            if (valid.length > 0)
                this._onFrames(valid, arrivalUs);
            if (cancellable.is_cancelled())
                return;
            if (gaveUp) {
                // A future Voxtype may change the struct: stop for this recording, no retry.
                this._closeConnection();
                this._logOnce('level frames are not valid, giving up for this recording');
                this._onConnected(false);
                return;
            }
        }
    }

    _lost(message) {
        const cancellable = this._cancellable;
        this._closeConnection();
        this._logOnce(message);
        this._onConnected(false);
        if (cancellable.is_cancelled() || this._retries >= this._delays.length)
            return;
        this._retryId = this._timers.add(this._delays[this._retries++], () => {
            this._retryId = 0;
            this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    // One debug line per failure episode, from a failure to the next successful connect.
    _logOnce(message) {
        if (this._logged)
            return;
        this._logged = true;
        console.debug(`${LOG} level socket: ${message}`);
    }
}

function closeQuietly(connection) {
    try {
        connection?.close(null);
    } catch (_e) {
        // already closed
    }
}
