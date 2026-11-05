// SPDX-License-Identifier: GPL-2.0-or-later
// Tests for VoxtypeUnitWatch against a fake org.freedesktop.systemd1 on a private bus.
// Run from the repository root: gjs -m tests/test-unit.js
//
// The bus is a dbus-daemon of its own with a minimal config (no service directories, so nothing can be
// activated): the real session bus, and the real voxtype.service, are never reached. It is started with
// Gio.Subprocess, not Gio.TestDBus: under gjs, TestDBus.up() forks without exec, the child can deadlock on a
// futex, and every run leaves a stuck `gjs` process holding the stdout pipe (seen: the run hung, and eight
// orphans were left behind).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {VoxtypeUnitWatch} from '../source.js';

const NAME = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const UNIT_PATH = '/org/freedesktop/systemd1/unit/voxtype_2eservice';
const CONNECTION_FLAGS = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION;

const MANAGER_XML = `<node><interface name="org.freedesktop.systemd1.Manager">
    <method name="LoadUnit"><arg type="s" direction="in" name="name"/><arg type="o" direction="out" name="unit"/></method>
    <method name="Subscribe"/>
    <method name="Unsubscribe"/>
</interface></node>`;
const UNIT_XML = `<node><interface name="org.freedesktop.systemd1.Unit">
    <property name="ActiveState" type="s" access="read"/>
    <property name="LoadState" type="s" access="read"/>
</interface></node>`;

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

const later = (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    fn();
    return GLib.SOURCE_REMOVE;
});

// A fake systemd user manager with one unit. It counts what it is asked, and can be slow or failing.
class FakeSystemd {
    constructor(address, {loadDelayMs = 0, subscribeDelayMs = 0, loadError = null, state = 'active', loadState = 'loaded'} = {}) {
        this.counts = {loadUnit: 0, subscribe: 0, unsubscribe: 0};
        this.activeState = state;
        this.loadState = loadState;
        const delayed = (ms, fn) => ms > 0 ? later(ms, fn) : fn();
        const done = invocation => invocation.return_value(new GLib.Variant('()', []));

        this.connection = Gio.DBusConnection.new_for_address_sync(address, CONNECTION_FLAGS, null, null);
        this._manager = Gio.DBusExportedObject.wrapJSObject(MANAGER_XML, {
            LoadUnitAsync: (_params, invocation) => {
                this.counts.loadUnit++;
                delayed(loadDelayMs, () => {
                    if (loadError)
                        invocation.return_dbus_error(loadError, 'No unit for voxtype.service');
                    else
                        invocation.return_value(new GLib.Variant('(o)', [UNIT_PATH]));
                });
            },
            SubscribeAsync: (_params, invocation) => {
                this.counts.subscribe++;
                delayed(subscribeDelayMs, () => done(invocation));
            },
            UnsubscribeAsync: (_params, invocation) => {
                this.counts.unsubscribe++;
                done(invocation);
            },
        });
        const fake = this;
        this._unit = Gio.DBusExportedObject.wrapJSObject(UNIT_XML, {
            get ActiveState() {
                return fake.activeState;
            },
            get LoadState() {
                return fake.loadState;
            },
        });
        this._manager.export(this.connection, MANAGER_PATH);
        this._unit.export(this.connection, UNIT_PATH);
        this._owner = Gio.bus_own_name_on_connection(this.connection, NAME, Gio.BusNameOwnerFlags.NONE,
            () => { this.named = true; }, null);
    }

    ready() {
        return waitFor(() => this.named, 'the fake systemd1 name');
    }

    // systemd sends the changed properties; the watch only needs ActiveState. GJS batches property
    // changes made in one main-loop turn into one signal, so a step needs its own turn (as in systemd).
    async emit(state) {
        this.activeState = state;
        this._unit.emit_property_changed('ActiveState', new GLib.Variant('s', state));
        await sleep(40);
    }

    close() {
        Gio.bus_unown_name(this._owner);
        this._manager.unexport();
        this._unit.unexport();
        this.connection.close_sync(null);
    }
}

// A watch that is not given a bus must never reach the real one: every case that wants the null path
// overrides `_getBus` on the instance.
VoxtypeUnitWatch.prototype._getBus = () => {
    throw new Error('test would have used the real session bus');
};

const BUS_CONFIG = `<busconfig>
    <type>session</type>
    <listen>unix:tmpdir=/tmp</listen>
    <auth>EXTERNAL</auth>
    <policy context="default">
        <allow send_destination="*" eavesdrop="true"/>
        <allow eavesdrop="true"/>
        <allow own="*"/>
    </policy>
</busconfig>`;

let ADDRESS = null;
let busDaemon = null;
let busDir = null;

function startBus() {
    busDir = GLib.Dir.make_tmp('vtunit-XXXXXX');
    const config = GLib.build_filenamev([busDir, 'bus.conf']);
    GLib.file_set_contents(config, BUS_CONFIG);
    busDaemon = Gio.Subprocess.new(['dbus-daemon', `--config-file=${config}`, '--nofork', '--print-address=1'],
        Gio.SubprocessFlags.STDOUT_PIPE);
    const [line] = Gio.DataInputStream.new(busDaemon.get_stdout_pipe()).read_line_utf8(null);
    if (!line)
        throw new Error('dbus-daemon printed no address');
    ADDRESS = line;
}

function stopBus() {
    busDaemon?.force_exit();
    busDaemon = null;
    if (busDir) {
        for (const name of ['bus.conf'])
            GLib.unlink(GLib.build_filenamev([busDir, name]));
        GLib.rmdir(busDir);
        busDir = null;
    }
}

const clients = [];
function clientConnection() {
    const connection = Gio.DBusConnection.new_for_address_sync(ADDRESS, CONNECTION_FLAGS, null, null);
    clients.push(connection);
    return connection;
}

async function setup(options) {
    const fake = new FakeSystemd(ADDRESS, options);
    await fake.ready();
    const states = [];
    const watch = new VoxtypeUnitWatch({connection: clientConnection(), onActiveState: s => states.push(s)});
    return {fake, watch, states};
}

const cases = [];
const testCase = (name, fn) => cases.push([name, fn]);

testCase('1 start() subscribes once, reports the initial state, then the emitted steps in order', async () => {
    const {fake, watch, states} = await setup({state: 'active'});
    try {
        watch.start();
        await waitFor(() => states.length >= 1, 'the initial ActiveState');
        check(states, ['active'], 'initial state');
        check(fake.counts, {loadUnit: 1, subscribe: 1, unsubscribe: 0}, 'one LoadUnit, one Subscribe');
        for (const step of ['activating', 'failed', 'active'])
            await fake.emit(step);
        await waitFor(() => states.length >= 4, 'the three emitted states');
        await sleep(100);
        check(states, ['active', 'activating', 'failed', 'active'], 'states in order');
        check(fake.counts.subscribe, 1, 'still one Subscribe');
    } finally {
        watch.stop();
        fake.close();
    }
});

testCase('2 stop() unsubscribes, and a later emission gives no callback', async () => {
    const {fake, watch, states} = await setup({state: 'inactive'});
    try {
        watch.start();
        await waitFor(() => states.length >= 1, 'the initial ActiveState');
        check(states, ['inactive'], 'initial state');
        watch.stop();
        await waitFor(() => fake.counts.unsubscribe >= 1, 'Unsubscribe');
        check(fake.counts, {loadUnit: 1, subscribe: 1, unsubscribe: 1}, 'Subscribe and Unsubscribe balance');
        await fake.emit('active');
        await fake.emit('failed');
        await sleep(200);
        check(states, ['inactive'], 'no callback after stop()');
        watch.stop();
        await sleep(50);
        check(fake.counts.unsubscribe, 1, 'a second stop() sends nothing');
    } finally {
        watch.stop();
        fake.close();
    }
});

testCase('3 NoSuchUnit: no callback, no warning, at most one debug line', async () => {
    const warnings = problems().length;
    const debugs = debugLines().length;
    const {fake, watch, states} = await setup({loadError: 'org.freedesktop.systemd1.NoSuchUnit'});
    try {
        watch.start();
        await waitFor(() => fake.counts.loadUnit >= 1, 'LoadUnit');
        await sleep(300);
        check(states, [], 'no callback');
        check(fake.counts, {loadUnit: 1, subscribe: 0, unsubscribe: 0}, 'no Subscribe after a failed LoadUnit');
        check(problems().length - warnings, 0, 'no warning or critical');
        check(debugLines().length - debugs <= 1, true, 'at most one console.debug');
        watch.stop();
        await sleep(100);
        check(fake.counts.unsubscribe, 0, 'stop() sends no Unsubscribe for a Subscribe never sent');
    } finally {
        watch.stop();
        fake.close();
    }
});

testCase('4 stop() before LoadUnit returns: no callback, no Subscribe, ever', async () => {
    const {fake, watch, states} = await setup({loadDelayMs: 250});
    try {
        watch.start();
        await waitFor(() => fake.counts.loadUnit >= 1, 'LoadUnit received');
        watch.stop();
        await sleep(600);
        check(states, [], 'no callback');
        check(fake.counts, {loadUnit: 1, subscribe: 0, unsubscribe: 0}, 'no Subscribe, no Unsubscribe');
        await fake.emit('failed');
        await sleep(100);
        check(states, [], 'no callback for a later emission');
    } finally {
        watch.stop();
        fake.close();
    }
});

testCase('5 stop() while Subscribe is unanswered: Unsubscribe still balances it', async () => {
    const {fake, watch, states} = await setup({subscribeDelayMs: 300});
    try {
        watch.start();
        await waitFor(() => fake.counts.subscribe >= 1, 'Subscribe received');
        watch.stop();
        await sleep(700);
        check(fake.counts, {loadUnit: 1, subscribe: 1, unsubscribe: 1}, 'Unsubscribe count equals Subscribe count');
        check(states, [], 'no callback');
        await fake.emit('active');
        await sleep(100);
        check(states, [], 'no callback for a later emission');
    } finally {
        watch.stop();
        fake.close();
    }
});

// Gio.bus_get(SESSION) reaches the real session bus, and with it the real systemd user manager, even with a
// test bus up (verified: another connection GUID). So the null-connection path is tested through the `_getBus`
// seam, and the real call is left to the nested-shell run, under dbus-run-session.
function slowBus(watch, connection, ms) {
    const asked = {count: 0};
    watch._getBus = async function (cancellable) {
        asked.count++;
        await sleep(ms);
        if (cancellable.is_cancelled())
            throw new Error('cancelled');
        return connection;
    };
    return asked;
}

testCase('6 a null connection is fetched asynchronously', async () => {
    const fake = new FakeSystemd(ADDRESS, {state: 'failed'});
    await fake.ready();
    const states = [];
    const watch = new VoxtypeUnitWatch({connection: null, onActiveState: s => states.push(s)});
    const asked = slowBus(watch, clientConnection(), 100);
    try {
        watch.start();
        check(states, [], 'nothing synchronously');
        await waitFor(() => states.length >= 1, 'the initial ActiveState over the fetched bus');
        check(states, ['failed'], 'initial state');
        await fake.emit('active');
        await waitFor(() => states.length >= 2, 'the emitted state');
        check(states, ['failed', 'active'], 'states');
        check([asked.count, fake.counts.subscribe], [1, 1], 'one bus fetch, one Subscribe');
    } finally {
        watch.stop();
        await sleep(100);
        fake.close();
    }
});

testCase('7 stop() before the bus answers: nothing is sent', async () => {
    const {fake} = await setup();
    const states = [];
    const watch = new VoxtypeUnitWatch({connection: null, onActiveState: s => states.push(s)});
    const asked = slowBus(watch, clientConnection(), 300);
    try {
        watch.start();
        watch.stop();
        await sleep(600);
        check(asked.count, 1, 'the bus was asked for');
        check(states, [], 'no callback');
        check(fake.counts, {loadUnit: 0, subscribe: 0, unsubscribe: 0}, 'the fake saw nothing');
    } finally {
        watch.stop();
        fake.close();
    }
});

testCase('8 start() again after stop() works, and one more start() is ignored', async () => {
    const {fake, watch, states} = await setup({state: 'active'});
    try {
        watch.start();
        watch.start();
        await waitFor(() => states.length >= 1, 'the initial ActiveState');
        await sleep(100);
        check(fake.counts.subscribe, 1, 'a second start() while running is ignored');
        watch.stop();
        await waitFor(() => fake.counts.unsubscribe >= 1, 'Unsubscribe');
        watch.start();
        await waitFor(() => states.length >= 2, 'the initial ActiveState again');
        check(fake.counts, {loadUnit: 2, subscribe: 2, unsubscribe: 1}, 'a clean second run');
    } finally {
        watch.stop();
        fake.close();
    }
});

// LoadUnit does not fail for a unit that does not exist: it returns a stub with LoadState not-found and ActiveState
// inactive. Reporting that would show a manually started Voxtype as offline.
testCase('9 a not-found unit: no callback, no Subscribe, no warning', async () => {
    const warnings = problems().length;
    const {fake, watch, states} = await setup({loadState: 'not-found', state: 'inactive'});
    try {
        watch.start();
        await waitFor(() => fake.counts.loadUnit >= 1, 'LoadUnit');
        await sleep(300);
        check(states, [], 'no callback within 300 ms');
        check(fake.counts, {loadUnit: 1, subscribe: 0, unsubscribe: 0}, 'no Subscribe for a not-found unit');
        check(problems().length - warnings, 0, 'no warning or critical');
        watch.stop();
        await sleep(100);
        check(fake.counts.unsubscribe, 0, 'stop() sends no Unsubscribe');
    } finally {
        watch.stop();
        fake.close();
    }
});

const loop = new GLib.MainLoop(null, false);
// Hang guard for the whole run; every wait has its own, shorter timeout.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
    printerr('FAIL: test run hung');
    stopBus();
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});

(async () => {
    startBus();
    for (const [name, fn] of cases) {
        current = name;
        try {
            await fn();
        } catch (e) {
            failures.push(`[${name}] ${e.message}`);
        }
    }
})().catch(e => failures.push(`runner: ${e.message}`)).finally(() => loop.quit());

loop.run();

for (const connection of clients)
    connection.close_sync(null);
stopBus();

if (failures.length > 0) {
    printerr(`FAIL (${failures.length} problems in ${checks} checks):`);
    for (const f of failures)
        printerr(`  - ${f}`);
    System.exit(1);
}
print(`ok: ${checks} checks, ${cases.length} cases`);
