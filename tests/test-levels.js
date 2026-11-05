// SPDX-License-Identifier: GPL-2.0-or-later
// Tests for VoxtypeLevelSource: a Gio.SocketService on a temp Unix socket, never the real runtime dir.
// Run from the repository root: gjs -m tests/test-levels.js
//
// Some cases read the source's private fields (_retryId, _connection): "no live GLib source" and
// "the connection is closed" cannot be seen from the callbacks.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {VoiceTracker} from '../common.js';
import {VoxtypeLevelSource} from '../levels.js';

const failures = [];
let checks = 0;
let current = '';

function check(actual, expected, label) {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        failures.push(`[${current}] ${label}: expected ${e}, got ${a}`);
}

// console.warn and console.error are read-only in gjs: count what reaches the GLib log instead.
const logged = [];
GLib.log_set_writer_func((level, fields) => {
    const text = fields.MESSAGE instanceof Uint8Array ? new TextDecoder().decode(fields.MESSAGE) : String(fields.MESSAGE);
    logged.push({level, text});
    return GLib.LogWriterOutput.HANDLED;
});
const problems = () => logged.filter(l => l.level & (GLib.LogLevelFlags.LEVEL_WARNING
    | GLib.LogLevelFlags.LEVEL_CRITICAL | GLib.LogLevelFlags.LEVEL_ERROR));
const debugLines = () => logged.filter(l => l.level & GLib.LogLevelFlags.LEVEL_DEBUG
    && l.text.includes('[Dictation Indicator]'));

const nowMs = () => GLib.get_monotonic_time() / 1000;

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// Rejects after `ms`: a hung case fails instead of hanging the run.
function waitFor(cond, label, ms = 3000) {
    return new Promise((resolve, reject) => {
        const t0 = nowMs();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
            if (cond()) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            if (nowMs() - t0 > ms) {
                reject(new Error(`timeout waiting for ${label}`));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
}

function rmrf(path) {
    const file = Gio.File.new_for_path(path);
    const flags = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;
    let info;
    try {
        info = file.query_info('standard::type', flags, null);
    } catch (_e) {
        return;
    }
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name', flags, null);
        let child;
        while ((child = children.next_file(null)))
            rmrf(GLib.build_filenamev([path, child.get_name()]));
        children.close(null);
    }
    file.delete(null);
}

const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function frameBytes(seq, peak) {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, seq, LE);
    view.setFloat32(4, -60, LE);
    view.setFloat32(8, -20, LE);
    view.setFloat32(12, peak, LE);
    return bytes;
}

const concat = list => {
    const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of list) {
        out.set(b, at);
        at += b.length;
    }
    return out;
};

// A fake Voxtype: accepts connections on voxtype/audio.sock and remembers them.
class FakeDaemon {
    constructor(env) {
        this._env = env;
        this.connections = [];
        this.closedByClient = 0;
        this.service = null;
    }

    listen() {
        GLib.mkdir_with_parents(this._env.dir, 0o700);
        this.service = new Gio.SocketService();
        this.service.add_address(new Gio.UnixSocketAddress({path: this._env.sock}),
            Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
        this.service.connect('incoming', (_s, connection) => {
            this.connections.push(connection);
            // A read that ends at 0 bytes is the client closing its end.
            connection.get_input_stream().read_bytes_async(1, GLib.PRIORITY_DEFAULT, null, (stream, res) => {
                try {
                    if (stream.read_bytes_finish(res).get_size() === 0)
                        this.closedByClient++;
                } catch (_e) {
                    this.closedByClient++;
                }
            });
            return true;
        });
        this.service.start();
    }

    write(bytes, index = this.connections.length - 1) {
        this.connections[index].get_output_stream().write_all(bytes, null);
    }

    // What a restarting daemon does to its clients: EOF, then the socket file goes away.
    die() {
        for (const connection of this.connections)
            connection.close(null);
        this.connections = [];
        this.service?.stop();
        this.service?.close();
        this.service = null;
        try {
            Gio.File.new_for_path(this._env.sock).delete(null);
        } catch (_e) {
            // already gone
        }
    }
}

function makeEnv() {
    const root = GLib.Dir.make_tmp('vtlev-XXXXXX');
    const env = {root, rt: GLib.build_filenamev([root, 'run']), calls: [], source: null};
    env.dir = GLib.build_filenamev([env.rt, 'voxtype']);
    env.sock = GLib.build_filenamev([env.dir, 'audio.sock']);
    GLib.mkdir_with_parents(env.rt, 0o700);
    env.daemon = new FakeDaemon(env);
    env.make = (extra = {}) => {
        env.source = new VoxtypeLevelSource({
            runtimeDir: env.rt,
            onFrames: (frames, arrivalUs) => env.calls.push({type: 'frames', frames, arrivalUs, at: nowMs()}),
            onConnected: connected => env.calls.push({type: 'connected', connected, at: nowMs()}),
            ...extra,
        });
        return env.source;
    };
    return env;
}

// Wraps GLib timers and remembers every id the source asks for.
function recordingTimers() {
    const ids = [];
    return {
        ids,
        add: (ms, fn) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, fn);
            ids.push(id);
            return id;
        },
        remove: id => GLib.source_remove(id),
    };
}

const sourceAlive = id => GLib.MainContext.default().find_source_by_id(id) !== null;
const connectedCalls = env => env.calls.filter(c => c.type === 'connected');
const frameCalls = env => env.calls.filter(c => c.type === 'frames');

const cases = [];
const testCase = (name, fn) => cases.push([name, fn]);

testCase('1 connect, frames split across reads', async env => {
    env.daemon.listen();
    env.make().start();
    await waitFor(() => env.daemon.connections.length === 1, 'the connection');
    await waitFor(() => connectedCalls(env).length === 1, 'onConnected(true)');
    check(connectedCalls(env)[0].connected, true, 'onConnected on connect');

    const all = concat([frameBytes(10, -30), frameBytes(11, -20.5), frameBytes(12, -10.25)]);
    env.daemon.write(all.slice(0, 5));
    await sleep(60);
    check(frameCalls(env).length, 0, 'no frame from 5 bytes');
    env.daemon.write(all.slice(5));
    await waitFor(() => frameCalls(env).flatMap(c => c.frames).length === 3, 'three frames');
    const got = frameCalls(env).flatMap(c => c.frames);
    check(got, [{seq: 10, db: -30}, {seq: 11, db: -20.5}, {seq: 12, db: -10.25}], 'frames, in order');
    check(frameCalls(env).every(c => c.arrivalUs > 0), true, 'arrival time on every read');

    // Invalid frames are dropped, valid neighbours are kept, -Infinity becomes -120.
    env.daemon.write(concat([frameBytes(13, NaN), frameBytes(14, -Infinity), frameBytes(15, 4)]));
    await waitFor(() => frameCalls(env).flatMap(c => c.frames).length === 4, 'the mute frame');
    check(frameCalls(env).flatMap(c => c.frames).slice(3), [{seq: 14, db: -120}], 'only the valid frame of the read');
});

testCase('2 missing socket: three retries, then quiet', async env => {
    env.make().start();
    await waitFor(() => connectedCalls(env).length === 4, 'the first failure and three retries', 5000);
    const at = connectedCalls(env).map(c => c.at);
    const gaps = [at[1] - at[0], at[2] - at[1], at[3] - at[2]];
    check(connectedCalls(env).every(c => c.connected === false), true, 'every call is onConnected(false)');
    for (const [i, want] of [250, 1000, 2000].entries())
        check(Math.abs(gaps[i] - want) <= 150, true, `retry ${i + 1} after about ${want} ms (got ${Math.round(gaps[i])})`);
    await sleep(2300);
    check(connectedCalls(env).length, 4, 'nothing more for 2.3 s after the last retry');
    check(frameCalls(env).length, 0, 'no frames');
    check(problems().length, 0, 'no warning or error logged');
    check(debugLines().length, 1, 'one debug line for the whole failure episode');
});

testCase('3 daemon restart mid-recording', async env => {
    const tracker = new VoiceTracker();
    tracker.reset(GLib.get_monotonic_time());
    env.daemon.listen();
    env.make({
        onFrames: (frames, arrivalUs) => tracker.pushFrames(frames, arrivalUs),
        onConnected: connected => {
            env.calls.push({type: 'connected', connected});
            tracker.setConnected(connected);
        },
    }).start();
    await waitFor(() => env.daemon.connections.length === 1, 'the connection');
    const quiet = Array.from({length: 30}, (_, i) => frameBytes(i, -70));
    env.daemon.write(concat(quiet));
    await waitFor(() => tracker.snapshot(GLib.get_monotonic_time()).feed === 'live', 'a live feed');

    env.daemon.die();
    await waitFor(() => connectedCalls(env).some(c => c.connected === false), 'onConnected(false) on EOF');
    const lost = tracker.snapshot(GLib.get_monotonic_time());
    check([lost.feed, lost.hint], ['nofeed', 'listening'], 'after EOF: nofeed, Listening');

    // A new listener within the first retry (250 ms).
    await sleep(80);
    env.daemon.listen();
    await waitFor(() => env.daemon.connections.length === 1, 'the reconnection', 1000);
    await waitFor(() => connectedCalls(env).at(-1).connected === true, 'onConnected(true) again');
    env.daemon.write(concat(Array.from({length: 5}, (_, i) => frameBytes(i, -70))));
    await waitFor(() => tracker.snapshot(GLib.get_monotonic_time()).feed === 'live', 'live after the restart');
    const back = tracker.snapshot(GLib.get_monotonic_time());
    check([back.feed, back.hint], ['live', 'listening'], 'frames restarting at seq 0: live again');
    check(problems().length, 0, 'no warning or error logged');
});

testCase('4 invalid frames: give up quietly', async env => {
    env.daemon.listen();
    env.make().start();
    await waitFor(() => env.daemon.connections.length === 1, 'the connection');
    env.daemon.write(concat(Array.from({length: 30}, (_, i) => frameBytes(i, NaN))));
    await waitFor(() => connectedCalls(env).some(c => !c.connected), 'onConnected(false)');
    const n = env.calls.length;
    check(env.calls.map(c => c.type === 'connected' ? c.connected : 'frames'), [true, false], 'calls so far');
    await waitFor(() => env.daemon.closedByClient === 1, 'the client closing the socket');
    await sleep(2800);
    check(env.calls.length, n, 'no further callback, no retry');
    check(env.daemon.connections.length, 1, 'the daemon saw a single connection');
    check(problems().length, 0, 'no warning or error logged');
});

testCase('4b invalid frames must be in a row', async env => {
    env.daemon.listen();
    env.make().start();
    await waitFor(() => env.daemon.connections.length === 1, 'the connection');
    const bad = n => Array.from({length: n}, () => frameBytes(0, NaN));
    env.daemon.write(concat([...bad(29), frameBytes(1, -30), ...bad(29), frameBytes(2, -30)]));
    await waitFor(() => frameCalls(env).flatMap(c => c.frames).length === 2, 'the two valid frames');
    await sleep(100);
    check(connectedCalls(env).map(c => c.connected), [true], 'a valid frame resets the count');
    // And one more run of invalid frames across two reads still counts.
    env.daemon.write(concat(bad(15)));
    await sleep(60);
    env.daemon.write(concat(bad(15)));
    await waitFor(() => connectedCalls(env).some(c => !c.connected), 'onConnected(false) after 30 in a row');
});

testCase('5a stop() during a pending read', async env => {
    const timers = recordingTimers();
    env.daemon.listen();
    env.make({timers}).start();
    await waitFor(() => env.daemon.connections.length === 1, 'the connection');
    await waitFor(() => connectedCalls(env).length === 1, 'onConnected(true)');
    env.source.stop();
    check(timers.ids.every(id => !sourceAlive(id)), true, 'no source created through the timers is alive');
    check(env.source._connection, null, 'connection forgotten');
    await waitFor(() => env.daemon.closedByClient === 1, 'the daemon seeing the close');
    const n = env.calls.length;
    try {
        env.daemon.write(concat([frameBytes(0, -30)]), 0);
    } catch (_e) {
        // the client is gone: a broken pipe is the expected answer
    }
    await sleep(3000);
    check(env.calls.length, n, 'no callback for 3 s after stop()');
    check(problems().length, 0, 'no warning or error logged');
});

testCase('5b stop() during a retry backoff', async env => {
    const timers = recordingTimers();
    env.make({timers}).start();
    await waitFor(() => connectedCalls(env).length === 1, 'the first failure');
    check(timers.ids.length, 1, 'a retry timer was created');
    check(sourceAlive(timers.ids[0]), true, 'and it is alive');
    env.source.stop();
    check(timers.ids.every(id => !sourceAlive(id)), true, 'stop() removed the retry timer');
    check(env.source._retryId, 0, 'retry id cleared');
    env.daemon.listen();
    await sleep(3000);
    check(env.calls.length, 1, 'no callback and no reconnect for 3 s after stop()');
    check(env.daemon.connections.length, 0, 'the daemon never saw a connection');
});

testCase('6 stop() while a connect is pending', async env => {
    env.daemon.listen();
    env.make().start();
    env.source.stop();
    await waitFor(() => env.daemon.connections.length === 1, 'the late connection');
    await waitFor(() => env.daemon.closedByClient === 1, 'the daemon seeing it close');
    await sleep(300);
    check(env.calls, [], 'no callback at all');
    check(env.source._connection, null, 'no connection kept');
});

testCase('7 start() again begins a fresh recording', async env => {
    env.daemon.listen();
    env.make().start();
    await waitFor(() => connectedCalls(env).length === 1, 'first connect');
    env.source.start();
    await waitFor(() => env.daemon.connections.length === 2, 'second connection');
    await waitFor(() => env.daemon.closedByClient === 1, 'the first connection closed');
    env.daemon.write(concat([frameBytes(0, -30)]), 1);
    await waitFor(() => frameCalls(env).length === 1, 'a frame on the new connection');
    check(frameCalls(env)[0].frames, [{seq: 0, db: -30}], 'frame from the new connection only');
});

const loop = new GLib.MainLoop(null, false);
// Hang guard for the whole run; every wait has its own, shorter timeout.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 120, () => {
    printerr('FAIL: test run hung');
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});

(async () => {
    for (const [name, fn] of cases) {
        current = name;
        const env = makeEnv();
        try {
            await fn(env);
        } catch (e) {
            failures.push(`[${name}] ${e.message}`);
        } finally {
            env.source?.stop();
            env.daemon.die();
            rmrf(env.root);
        }
    }
})().catch(e => failures.push(`runner: ${e.message}`)).finally(() => loop.quit());

loop.run();

if (failures.length > 0) {
    printerr(`FAIL (${failures.length} problems in ${checks} checks):`);
    for (const f of failures)
        printerr(`  - ${f}`);
    System.exit(1);
}
print(`ok: ${checks} checks, ${cases.length} cases`);
