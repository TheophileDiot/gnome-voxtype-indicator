// SPDX-License-Identifier: GPL-2.0-or-later
// Voxtype state source: watches the daemon's state file and reports view changes, and
// VoxtypeUnitWatch: the systemd user manager's word on voxtype.service.
// Gio and GLib only, so tests/test-source.js and tests/test-unit.js can run it under plain `gjs -m`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    MODE_KEEP, MODE_OFFLINE, VIEW_IDLE_INFERRED, VIEW_OFFLINE,
    cancelFilePath, isBusy, isVoxtypeComm, lockFilePath, parsePid, parseState, stateDirPath, stateFilePath,
    unitEffect, viewFor,
} from './common.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Gio, 'bus_get', 'bus_get_finish');

const LOG = '[Dictation Indicator]';

// Text of the file, or null when it does not exist (daemon stopped).
async function readText(file, cancellable) {
    try {
        const [bytes] = await file.load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw e;
    }
}

export class VoxtypeStateSource {
    constructor({runtimeDir, procDir = '/proc', watchdogMs = 2000, onView, onCancel = () => {}}) {
        this._runtimeDir = Gio.File.new_for_path(runtimeDir);
        this._stateDir = Gio.File.new_for_path(stateDirPath(runtimeDir));
        this._stateFile = Gio.File.new_for_path(stateFilePath(runtimeDir));
        this._lockFile = Gio.File.new_for_path(lockFilePath(runtimeDir));
        this._cancelFile = Gio.File.new_for_path(cancelFilePath(runtimeDir));
        this._procDir = procDir;
        this._watchdogMs = watchdogMs;
        this._onView = onView;
        this._onCancel = onCancel;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        // null, not a mode: the first view is always delivered.
        this._mode = null;
        this._seq = 0;
        this._idleId = 0;
        this._watchdogId = 0;
        this._stateWatch = this._dirWatch = this._cancelWatch = null;
        this._warned = new Set();
        this._watchDirOrState();
        this._scheduleRead();
    }

    stop() {
        this._cancellable?.cancel();
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._disarmWatchdog();
        this._unwatch(this._stateWatch);
        this._unwatch(this._dirWatch);
        this._unwatch(this._cancelWatch);
        this._idleId = 0;
        this._stateWatch = this._dirWatch = this._cancelWatch = null;
    }

    // One more read, e.g. when the menu opens. A no-op before start() and after stop().
    refresh() {
        if (this._cancellable && !this._cancellable.is_cancelled())
            this._scheduleRead();
    }

    // systemd's ActiveState of voxtype.service. `offline` is final for any read already in flight
    // (it bumps the sequence number); `active` asks the state file what the daemon is doing.
    noteUnitState(activeState) {
        if (!this._cancellable || this._cancellable.is_cancelled())
            return;
        switch (unitEffect(activeState)) {
        case 'offline':
            this._seq++;
            this._deliver(VIEW_OFFLINE);
            break;
        case 'read':
            this._scheduleRead();
            break;
        }
    }

    // A watch on a file whose parent dir is missing makes GLib poll every 4 s and can miss the
    // CREATED event when the daemon makes the dir and writes the file at once. Until the dir
    // exists, watch the runtime dir for it instead.
    _watchDirOrState() {
        if (this._stateDir.query_exists(null)) {
            this._watchState();
            return;
        }
        this._dirWatch = this._watch(this._runtimeDir, file => {
            if (file.get_basename() === this._stateDir.get_basename())
                this._switchToStateWatch();
        }, {directory: true});
        // The dir may have appeared between the check and the watch.
        if (this._stateDir.query_exists(null))
            this._switchToStateWatch();
    }

    _switchToStateWatch() {
        if (!this._dirWatch)
            return;
        this._unwatch(this._dirWatch);
        this._dirWatch = null;
        this._watchState();
        this._scheduleRead();
    }

    // One monitor per path. A failure is logged once and leaves the source inert (no polling).
    _watch(file, onChange, {directory = false, moves = true} = {}) {
        const flags = moves ? Gio.FileMonitorFlags.WATCH_MOVES : Gio.FileMonitorFlags.NONE;
        try {
            const monitor = directory
                ? file.monitor_directory(flags, this._cancellable)
                : file.monitor_file(flags, this._cancellable);
            const id = monitor.connect('changed', (_m, changed, _other, eventType) => onChange(changed, eventType));
            return {monitor, id};
        } catch (e) {
            this._warnOnce(`watch:${file.get_path()}`, `cannot watch ${file.get_path()}: ${e.message}`);
            return null;
        }
    }

    _unwatch(watch) {
        watch?.monitor.disconnect(watch.id);
        watch?.monitor.cancel();
    }

    _watchState() {
        this._unwatch(this._stateWatch);
        this._stateWatch = this._watch(this._stateFile, () => this._scheduleRead());
    }

    _warnOnce(key, message) {
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        console.warn(`${LOG} ${message}`);
    }

    // A truncate + write pair raises several events: one idle callback, one read.
    _scheduleRead() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._read();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _read() {
        const cancellable = this._cancellable;
        const seq = ++this._seq;
        // null: no state file (or an unreadable one). The lock PID then says whether Voxtype runs.
        let state = null;
        try {
            const text = await readText(this._stateFile, cancellable);
            if (text !== null)
                state = parseState(text);
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            this._warnOnce('read', `cannot read ${this._stateFile.get_path()}: ${e.message}`);
        }
        if (cancellable.is_cancelled() || seq !== this._seq)
            return;

        let view = state === null ? null : viewFor(state);
        if (view && !view.known)
            this._warnOnce(`unknown:${state}`, `unknown state "${state.slice(0, 32)}", showing the idle orb`);
        if (!view || (view.mode !== MODE_OFFLINE && view.mode !== MODE_KEEP)) {
            const alive = await this._daemonAlive(cancellable);
            if (cancellable.is_cancelled() || seq !== this._seq)
                return;
            // A state file written by a custom `state_file` setting is not ours to find: a live
            // daemon with no file is idle.
            view = !alive ? VIEW_OFFLINE : view ?? VIEW_IDLE_INFERRED;
        }
        this._deliver(view);
    }

    // voxtype.lock holds the daemon PID; a crash leaves both the file and the lock behind, and a
    // recycled PID belongs to another program, so the process name must match too.
    async _daemonAlive(cancellable) {
        try {
            const pid = parsePid(await readText(this._lockFile, cancellable));
            if (pid === null)
                return false;
            const comm = Gio.File.new_for_path(GLib.build_filenamev([this._procDir, String(pid), 'comm']));
            return isVoxtypeComm(await readText(comm, cancellable));
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._warnOnce('lock', `cannot check the daemon via ${this._lockFile.get_path()}: ${e.message}`);
            return false;
        }
    }

    _deliver(view) {
        if (view.mode === MODE_KEEP || view.mode === this._mode)
            return;
        this._mode = view.mode;
        if (isBusy(view.mode)) {
            this._armWatchdog();
            this._watchCancel();
        } else {
            this._disarmWatchdog();
            this._unwatchCancel();
        }
        this._onView(view);
    }

    // The cancel trigger file is dropped by `voxtype record cancel` and deleted by the daemon once it has
    // acted, so the event is the only evidence: never ask whether the file exists. Watched only while busy.
    // Without WATCH_MOVES a file renamed into place is reported as CREATED, so both ways of writing it count.
    _watchCancel() {
        if (this._cancelWatch)
            return;
        this._cancelWatch = this._watch(this._cancelFile, (_file, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CREATED || eventType === Gio.FileMonitorEvent.MOVED_IN)
                this._onCancel();
        }, {moves: false});
    }

    _unwatchCancel() {
        this._unwatch(this._cancelWatch);
        this._cancelWatch = null;
    }

    // Only while busy: idle costs no timer.
    _armWatchdog() {
        if (this._watchdogId)
            return;
        this._watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._watchdogMs, () => {
            this._checkAlive();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _disarmWatchdog() {
        if (!this._watchdogId)
            return;
        GLib.source_remove(this._watchdogId);
        this._watchdogId = 0;
    }

    async _checkAlive() {
        const cancellable = this._cancellable;
        // A read that starts meanwhile runs its own liveness check: its result wins.
        const seq = this._seq;
        const alive = await this._daemonAlive(cancellable);
        if (!alive && !cancellable.is_cancelled() && seq === this._seq)
            this._deliver(VIEW_OFFLINE);
    }
}

const SYSTEMD = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

// The systemd user manager's word on voxtype.service. Passive: one `Subscribe`, one match on
// the unit's `PropertiesChanged`, one `Properties.Get`. No unit or no systemd is not an error worth a warning,
// it only means the state file is the one source of truth.
export class VoxtypeUnitWatch {
    constructor({connection = null, unit = 'voxtype.service', onActiveState}) {
        this._connection = connection;
        this._unit = unit;
        this._onActiveState = onActiveState;
        this._cancellable = null;
    }

    start() {
        if (this._cancellable)
            return;
        this._cancellable = new Gio.Cancellable();
        this._subscribeSent = false;
        this._subId = 0;
        this._bus = null;
        this._run(this._cancellable);
    }

    stop() {
        if (!this._cancellable)
            return;
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._subId)
            this._bus.signal_unsubscribe(this._subId);
        // The Subscribe may still be unanswered. D-Bus delivers messages in order on one connection, so
        // the manager handles this after it, and the two balance.
        if (this._subscribeSent)
            this._call(this._bus, MANAGER_PATH, MANAGER_IFACE, 'Unsubscribe', null, null).catch(() => {});
        this._subId = 0;
        this._subscribeSent = false;
        this._bus = null;
    }

    // A seam for tests/test-unit.js: Gio.bus_get(SESSION) reaches the real session bus even under a TestDBus.
    _getBus(cancellable) {
        return Gio.bus_get(Gio.BusType.SESSION, cancellable);
    }

    _call(bus, path, iface, method, params, cancellable) {
        return bus.call(SYSTEMD, path, iface, method, params, null, Gio.DBusCallFlags.NONE, -1, cancellable);
    }

    async _run(cancellable) {
        try {
            const bus = this._connection ?? await this._getBus(cancellable);
            if (cancellable.is_cancelled())
                return;
            this._bus = bus;

            const [unitPath] = (await this._call(bus, MANAGER_PATH, MANAGER_IFACE, 'LoadUnit',
                new GLib.Variant('(s)', [this._unit]), cancellable)).deepUnpack();
            if (cancellable.is_cancelled())
                return;

            // LoadUnit also answers for a unit that does not exist, as a stub whose ActiveState is `inactive`. That
            // would show a Voxtype started by hand as offline, so a not-found unit is no watch at all.
            const load = await this._call(bus, unitPath, PROPERTIES_IFACE, 'Get',
                new GLib.Variant('(ss)', [UNIT_IFACE, 'LoadState']), cancellable);
            if (cancellable.is_cancelled())
                return;
            if (load.get_child_value(0).get_variant().get_string()[0] === 'not-found') {
                console.debug(`${LOG} ${this._unit} is not loaded, the state file is the only source`);
                return;
            }

            // Before the call, not after the reply: a stop() in between must still send the Unsubscribe.
            this._subscribeSent = true;
            await this._call(bus, MANAGER_PATH, MANAGER_IFACE, 'Subscribe', null, cancellable);
            if (cancellable.is_cancelled())
                return;

            this._subId = bus.signal_subscribe(SYSTEMD, PROPERTIES_IFACE, 'PropertiesChanged', unitPath, UNIT_IFACE,
                Gio.DBusSignalFlags.NONE, (_c, _sender, _path, _iface, _signal, params) => {
                    const state = params.get_child_value(1).lookup_value('ActiveState', null);
                    if (state && !cancellable.is_cancelled())
                        this._onActiveState(state.get_string()[0]);
                });

            const reply = await this._call(bus, unitPath, PROPERTIES_IFACE, 'Get',
                new GLib.Variant('(ss)', [UNIT_IFACE, 'ActiveState']), cancellable);
            if (cancellable.is_cancelled())
                return;
            this._onActiveState(reply.get_child_value(0).get_variant().get_string()[0]);
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.debug(`${LOG} no systemd unit watch for ${this._unit}: ${e.message}`);
        }
    }
}
