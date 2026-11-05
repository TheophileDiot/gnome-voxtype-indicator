// SPDX-License-Identifier: GPL-2.0-or-later
// Tests for VoxtypeStateSource: real file monitors, temp dirs only, a fake /proc.
// Run from the repository root: gjs -m tests/test-source.js
//
// A few cases read the source's private fields (_seq, _stateWatch, _dirWatch, _cancelWatch, _watchdogId, _idleId):
// "no monitor exists", "the watchdog is disarmed" and "no live GLib source" cannot be seen from onView.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {receiptAllowed} from '../common.js';
import {VoxtypeStateSource} from '../source.js';

const PID = 4242;
const WATCHDOG_MS = 100;
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

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// Rejects after `ms`: a hung case fails instead of hanging the run.
function waitFor(cond, label, ms = 3000) {
    return new Promise((resolve, reject) => {
        const t0 = GLib.get_monotonic_time();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
            if (cond()) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            if ((GLib.get_monotonic_time() - t0) / 1000 > ms) {
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

// Truncate, then write, like the daemon does: the empty state is visible in between.
function writeText(path, text) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) {
        GLib.file_set_contents(path, text);
        return;
    }
    const io = file.open_readwrite(null);
    io.truncate(0, null);
    io.get_output_stream().write_all(new TextEncoder().encode(text), null);
    io.close(null);
}

function makeEnv() {
    const root = GLib.Dir.make_tmp('vtsrc-XXXXXX');
    const env = {
        root,
        rt: GLib.build_filenamev([root, 'run']),
        proc: GLib.build_filenamev([root, 'proc']),
        views: [],
        viewObjs: [],
        cancels: 0,
        source: null,
    };
    env.dir = GLib.build_filenamev([env.rt, 'voxtype']);
    env.state = GLib.build_filenamev([env.dir, 'state']);
    env.lock = GLib.build_filenamev([env.dir, 'voxtype.lock']);
    env.comm = GLib.build_filenamev([env.proc, String(PID), 'comm']);
    GLib.mkdir_with_parents(env.rt, 0o700);
    GLib.mkdir_with_parents(env.proc, 0o700);
    env.source = new VoxtypeStateSource({
        runtimeDir: env.rt,
        procDir: env.proc,
        watchdogMs: WATCHDOG_MS,
        onView: view => {
            env.views.push(view.mode);
            env.viewObjs.push(view);
        },
        onCancel: () => env.cancels++,
    });
    env.cancel = GLib.build_filenamev([env.dir, 'cancel']);
    return env;
}

// A fake /proc entry for the daemon, and optionally its dir and lock file.
function fakeProc(env, comm) {
    GLib.mkdir_with_parents(GLib.build_filenamev([env.proc, String(PID)]), 0o700);
    GLib.file_set_contents(env.comm, comm);
}

function fakeDaemon(env, state, comm = 'voxtype\n') {
    fakeProc(env, comm);
    GLib.mkdir_with_parents(env.dir, 0o700);
    GLib.file_set_contents(env.lock, String(PID));
    GLib.file_set_contents(env.state, state);
}

const sourceAlive = id => GLib.MainContext.default().find_source_by_id(id) !== null;

const cases = [];
const testCase = (name, fn) => cases.push([name, fn]);

testCase('1 dir missing at start, then dir + lock + state back to back', async env => {
    fakeProc(env, 'voxtype\n');
    env.source.start();
    // Let the first read see the missing file, so only the watches can deliver what follows.
    await waitFor(() => env.source._seq >= 1, 'the first read');
    await sleep(50);
    GLib.mkdir_with_parents(env.dir, 0o700);
    GLib.file_set_contents(env.lock, String(PID));
    GLib.file_set_contents(env.state, 'recording');
    await waitFor(() => env.views.length > 1, 'the recording view');
    await sleep(100);
    // The first read saw no file and no daemon: that is offline, delivered like any first view.
    check(env.views, ['offline', 'recording'], 'views');
});

testCase('2 no state-file monitor while the dir is missing', async env => {
    env.source.start();
    check(env.source._stateWatch, null, 'state monitor right after start');
    check(env.source._dirWatch !== null, true, 'runtime dir monitor right after start');
    await sleep(150);
    check(env.source._stateWatch, null, 'state monitor after 150 ms');
    GLib.mkdir_with_parents(env.dir, 0o700);
    await waitFor(() => env.source._stateWatch !== null, 'the state monitor');
    check(env.source._dirWatch, null, 'runtime dir monitor once the dir exists');
});

testCase('3 empty write is not a state', async env => {
    fakeDaemon(env, 'recording');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the recording view');
    const seq = env.source._seq;
    writeText(env.state, '');
    await waitFor(() => env.source._seq > seq, 'a read of the empty file');
    await sleep(100);
    check(env.views, ['recording'], 'views after the empty write');
    writeText(env.state, 'transcribing');
    await waitFor(() => env.views.length === 2, 'the transcribing view');
    check(env.views, ['recording', 'transcribing'], 'views after the next real state');
});

testCase('4 unknown value shows the idle orb once', async env => {
    fakeDaemon(env, 'recording');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the recording view');
    writeText(env.state, 'shiny-new-state');
    await waitFor(() => env.views.length === 2, 'the idle view');
    const seq = env.source._seq;
    writeText(env.state, 'shiny-new-state');
    await waitFor(() => env.source._seq > seq, 'a second read');
    await sleep(100);
    check(env.views, ['recording', 'idle'], 'views');
    // console.warn is read-only in gjs; the warn-once set is what gates it.
    check([...env.source._warned], ['unknown:shiny-new-state'], 'warned once for the value');
    check(env.viewObjs.map(v => receiptAllowed('transcribing', v)), [false, false], 'an unknown word allows no receipt');
});

testCase('5 lock PID whose comm is not voxtype is not a daemon', async env => {
    fakeDaemon(env, 'recording', 'firefox\n');
    env.source.start();
    await waitFor(() => env.source._seq >= 1, 'the first read');
    await sleep(150);
    await waitFor(() => env.views.length === 1, 'the offline view');
    check(env.views, ['offline'], 'views with a foreign comm');
    check(env.source._watchdogId, 0, 'watchdog while offline');
    GLib.file_set_contents(env.comm, 'voxtype\n');
    writeText(env.state, 'recording');
    await waitFor(() => env.views.length === 2, 'the recording view');
    check(env.views, ['offline', 'recording'], 'views with a voxtype comm');
});

testCase('6 daemon dies while recording', async env => {
    fakeDaemon(env, 'recording');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the recording view');
    const watchdogId = env.source._watchdogId;
    check(watchdogId !== 0, true, 'watchdog armed while recording');
    rmrf(GLib.build_filenamev([env.proc, String(PID)]));
    const t0 = GLib.get_monotonic_time();
    await waitFor(() => env.views.length === 2, 'the offline view', WATCHDOG_MS + 500);
    check(env.views, ['recording', 'offline'], 'views');
    check((GLib.get_monotonic_time() - t0) / 1000 < WATCHDOG_MS + 500, true, 'offline within watchdogMs + margin');
    check(env.source._watchdogId, 0, 'watchdog disarmed after');
    check(sourceAlive(watchdogId), false, 'watchdog GLib source removed');
    await sleep(2 * WATCHDOG_MS);
    check(env.views, ['recording', 'offline'], 'views after two more watchdog periods');
});

testCase('7 rapid writes: no stale read wins', async env => {
    fakeDaemon(env, 'recording');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the recording view');
    // A slow liveness check keeps the transcribing read in flight while the idle write lands,
    // so the stale transcribing result arrives after the idle one unless the sequence guard drops it.
    const alive = env.source._daemonAlive;
    env.source._daemonAlive = async function (cancellable) {
        await sleep(100);
        return alive.call(this, cancellable);
    };
    for (let round = 0; round < 3; round++) {
        writeText(env.state, 'recording');
        await waitFor(() => env.views.at(-1) === 'recording', `recording, round ${round}`);
        const from = env.views.length;
        const seq = env.source._seq;
        writeText(env.state, 'transcribing');
        await waitFor(() => env.source._seq > seq, `the transcribing read, round ${round}`);
        await sleep(40);
        writeText(env.state, 'idle');
        await sleep(350);
        const arrived = env.views.slice(from);
        check(arrived, ['idle'], `views, round ${round}`);
    }
});

testCase('8 stop() leaves nothing behind', async env => {
    // A read in flight: stop() lands right after its first await begins.
    fakeDaemon(env, 'recording');
    const read = env.source._read;
    env.source._read = function () {
        const promise = read.call(this);
        this.stop();
        return promise;
    };
    env.source.start();
    await sleep(250);
    check(env.views, [], 'views after stop() during a pending read');

    // A pending idle read.
    const second = makeEnv();
    try {
        fakeDaemon(second, 'recording');
        second.source.start();
        const idleId = second.source._idleId;
        check(idleId !== 0, true, 'idle read scheduled by start()');
        second.source.stop();
        check(sourceAlive(idleId), false, 'idle GLib source removed');
        await sleep(150);
        check(second.views, [], 'views after stop() with an idle read pending');
    } finally {
        second.source.stop();
        rmrf(second.root);
    }

    // Watchdog and monitors, and writes after stop().
    const third = makeEnv();
    try {
        fakeDaemon(third, 'recording');
        third.source.start();
        await waitFor(() => third.views.length === 1, 'the recording view');
        const watchdogId = third.source._watchdogId;
        const monitor = third.source._stateWatch.monitor;
        third.source.stop();
        check(sourceAlive(watchdogId), false, 'watchdog GLib source removed');
        check(monitor.is_cancelled(), true, 'state monitor cancelled');
        check([third.source._idleId, third.source._watchdogId], [0, 0], 'idle and watchdog ids');
        check([third.source._stateWatch, third.source._dirWatch], [null, null], 'monitor fields');
        writeText(third.state, 'idle');
        rmrf(GLib.build_filenamev([third.proc, String(PID)]));
        await sleep(3 * WATCHDOG_MS);
        check(third.views, ['recording'], 'views after stop() and later writes');
    } finally {
        third.source.stop();
        rmrf(third.root);
    }
});

testCase('9 state file deleted while the daemon lives is idle', async env => {
    fakeDaemon(env, 'recording');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the recording view');
    rmrf(env.state);
    await waitFor(() => env.views.length === 2, 'the idle view');
    check(env.views, ['recording', 'idle'], 'views');
    check(env.source._watchdogId, 0, 'watchdog disarmed');
    check(receiptAllowed('transcribing', env.viewObjs[1]), false, 'an inferred idle allows no receipt');
});

testCase('10 the first read of idle is delivered', async env => {
    fakeDaemon(env, 'idle');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the idle view');
    await sleep(100);
    check(env.views, ['idle'], 'views');
    check(receiptAllowed('transcribing', env.viewObjs[0]), true, 'an idle the state file said allows a receipt');
    check(env.source._watchdogId, 0, 'no watchdog at idle');
    check(env.source._cancelWatch, null, 'no cancel watch at idle');
});

testCase('11 idle with a dead lock PID is offline', async env => {
    fakeDaemon(env, 'idle', 'firefox\n');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the offline view');
    await sleep(100);
    check(env.views, ['offline'], 'views with a foreign comm');

    const second = makeEnv();
    try {
        fakeDaemon(second, 'idle');
        rmrf(second.comm);
        second.source.start();
        await waitFor(() => second.views.length === 1, 'the offline view');
        check(second.views, ['offline'], 'views with no /proc entry');
    } finally {
        second.source.stop();
        rmrf(second.root);
    }
});

testCase('12 missing state file: the lock PID decides', async env => {
    // A custom state_file: no file, but a live voxtype lock. Idle.
    fakeDaemon(env, 'idle');
    rmrf(env.state);
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the first view');
    await sleep(100);
    check(env.views, ['idle'], 'live lock PID, no state file');

    // Dead PID, no lock, foreign comm: offline.
    for (const [name, setup] of [
        ['dead PID', e => rmrf(e.comm)],
        ['no lock', e => rmrf(e.lock)],
        ['foreign comm', e => GLib.file_set_contents(e.comm, 'firefox\n')],
    ]) {
        const other = makeEnv();
        try {
            fakeDaemon(other, 'idle');
            rmrf(other.state);
            setup(other);
            other.source.start();
            await waitFor(() => other.views.length === 1, `the first view, ${name}`);
            await sleep(50);
            check(other.views, ['offline'], `no state file, ${name}`);
        } finally {
            other.source.stop();
            rmrf(other.root);
        }
    }
});

testCase('13 refresh() reads again, and idle reads check liveness', async env => {
    fakeDaemon(env, 'idle');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the idle view');
    const seq = env.source._seq;
    // The daemon dies without touching the state file: only a read can tell.
    rmrf(GLib.build_filenamev([env.proc, String(PID)]));
    await sleep(3 * WATCHDOG_MS);
    check(env.views, ['idle'], 'idle has no watchdog, so nothing noticed yet');
    env.source.refresh();
    await waitFor(() => env.views.length === 2, 'the offline view');
    check(env.source._seq > seq, true, 'refresh() ran a read');
    check(env.views, ['idle', 'offline'], 'views');

    // Many refreshes in one go are one read.
    const before = env.source._seq;
    env.source.refresh();
    env.source.refresh();
    env.source.refresh();
    await waitFor(() => env.source._seq > before, 'the coalesced read');
    await sleep(100);
    check(env.source._seq, before + 1, 'three refresh() calls are one read');
});

testCase('14 noteUnitState offline is immediate and beats a read in flight', async env => {
    fakeDaemon(env, 'recording');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the recording view');
    const alive = env.source._daemonAlive;
    env.source._daemonAlive = async function (cancellable) {
        await sleep(150);
        return alive.call(this, cancellable);
    };
    const seq = env.source._seq;
    writeText(env.state, 'transcribing');
    await waitFor(() => env.source._seq > seq, 'the transcribing read');
    env.source.noteUnitState('failed');
    // No await in between: the view is already there.
    check(env.views, ['recording', 'offline'], 'offline delivered at once');
    check(env.source._watchdogId, 0, 'watchdog disarmed');
    check(env.source._cancelWatch, null, 'cancel watch detached');
    await sleep(400);
    check(env.views, ['recording', 'offline'], 'the stale transcribing read did not overwrite it');

    // The same for every state that means "not running".
    for (const state of ['inactive', 'activating', 'deactivating']) {
        const other = makeEnv();
        try {
            fakeDaemon(other, 'idle');
            other.source.start();
            await waitFor(() => other.views.length === 1, `the idle view, ${state}`);
            other.source.noteUnitState(state);
            check(other.views, ['idle', 'offline'], `${state} is offline`);
        } finally {
            other.source.stop();
            rmrf(other.root);
        }
    }
});

testCase('15 noteUnitState active reads, reloading and unknown do not', async env => {
    fakeDaemon(env, 'idle');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the idle view');
    await sleep(50);
    let seq = env.source._seq;
    env.source.noteUnitState('reloading');
    env.source.noteUnitState('weird');
    await sleep(100);
    check(env.source._seq, seq, 'reloading and unknown start no read');
    check(env.views, ['idle'], 'reloading and unknown change nothing');

    env.source.noteUnitState('failed');
    check(env.views, ['idle', 'offline'], 'failed is offline');
    // The daemon is back: systemd says active, the read finds the live daemon.
    seq = env.source._seq;
    env.source.noteUnitState('active');
    await waitFor(() => env.views.length === 3, 'the idle view again');
    check(env.source._seq > seq, true, 'active started a read');
    check(env.views, ['idle', 'offline', 'idle'], 'views');
});

testCase('16 onCancel fires only while busy, from the event alone', async env => {
    fakeDaemon(env, 'idle');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the idle view');
    check(env.source._cancelWatch, null, 'no cancel watch at idle');

    // A cancel file at idle is nobody's business.
    GLib.file_set_contents(env.cancel, '1');
    await sleep(150);
    rmrf(env.cancel);
    await sleep(100);
    check(env.cancels, 0, 'no cancel while idle');

    writeText(env.state, 'recording');
    await waitFor(() => env.views.length === 2, 'the recording view');
    check(env.source._cancelWatch !== null, true, 'cancel watch exists while recording');
    const type = env.source._cancelWatch.monitor.constructor.$gtype.name;
    print(`  cancel watch monitor type: ${type}`);
    check(type.includes('Poll'), false, `BLOCKER: the cancel watch got a ${type}, not an inotify monitor`);

    // Created and left behind.
    GLib.file_set_contents(env.cancel, '1');
    await waitFor(() => env.cancels >= 1, 'the cancel event');
    check(env.cancels, 1, 'one cancel for one file');
    rmrf(env.cancel);
    await sleep(100);
    check(env.cancels, 1, 'deleting it is not a cancel');

    // Created and deleted at once: the daemon may beat us to it, so the event alone counts.
    const was = env.cancels;
    GLib.file_set_contents(env.cancel, '1');
    rmrf(env.cancel);
    await waitFor(() => env.cancels > was, 'the cancel event of a file that is already gone');
    check(env.cancels > was, true, 'create + delete with no yield still cancels');
    check(Gio.File.new_for_path(env.cancel).query_exists(null), false, 'the file is really gone');

    // A plain create (O_CREAT), not a rename into place: the daemon's CLI may write it either way.
    const viaCreate = env.cancels;
    const stream = Gio.File.new_for_path(env.cancel).create(Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode('1'), null);
    stream.close(null);
    rmrf(env.cancel);
    await waitFor(() => env.cancels > viaCreate, 'the cancel event of a plain create');

    // Still watching after the step to transcribing.
    const watch = env.source._cancelWatch;
    writeText(env.state, 'transcribing');
    await waitFor(() => env.views.length === 3, 'the transcribing view');
    check(env.source._cancelWatch === watch, true, 'the same watch survives recording -> transcribing');
    const again = env.cancels;
    GLib.file_set_contents(env.cancel, '1');
    await waitFor(() => env.cancels > again, 'the cancel event while transcribing');
    rmrf(env.cancel);

    // And gone at idle.
    const monitor = env.source._cancelWatch.monitor;
    writeText(env.state, 'idle');
    await waitFor(() => env.views.length === 4, 'the idle view again');
    check(env.source._cancelWatch, null, 'cancel watch gone at idle');
    check(monitor.is_cancelled(), true, 'the cancel monitor is cancelled');
    const after = env.cancels;
    GLib.file_set_contents(env.cancel, '1');
    await sleep(150);
    check(env.cancels, after, 'no cancel after idle');
    check(env.views, ['idle', 'recording', 'transcribing', 'idle'], 'views');
});

testCase('17 stop() detaches the cancel watch', async env => {
    fakeDaemon(env, 'recording');
    env.source.start();
    await waitFor(() => env.views.length === 1, 'the recording view');
    const monitor = env.source._cancelWatch.monitor;
    env.source.stop();
    check(env.source._cancelWatch, null, 'cancel watch field cleared');
    check(monitor.is_cancelled(), true, 'cancel monitor cancelled');
    GLib.file_set_contents(env.cancel, '1');
    await sleep(150);
    check(env.cancels, 0, 'no cancel after stop()');

    // refresh() and noteUnitState() after stop() do nothing at all.
    const idleId = env.source._idleId;
    env.source.refresh();
    env.source.noteUnitState('active');
    env.source.noteUnitState('failed');
    check([env.source._idleId, idleId], [0, 0], 'no read scheduled after stop()');
    await sleep(100);
    check(env.views, ['recording'], 'no view after stop()');
});

const loop = new GLib.MainLoop(null, false);
// Hang guard for the whole run; every wait has its own, shorter timeout.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 90, () => {
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
            env.source.stop();
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
