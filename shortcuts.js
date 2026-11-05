// SPDX-License-Identifier: GPL-2.0-or-later
// Setting the dictation shortcuts. Runs in the preferences process only, never in the Shell: it may use
// Gtk and Gdk but never the Shell's own modules. It reads the user's GNOME custom keybindings (the entries the menu
// and Settings already read) and, when the user confirms the capture dialog, writes the `binding` of one of them.
// The pure parts (key classes, path picker, command) live in common.js.

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {SHORTCUT_ROOT, capsFor, keyClass, pickShortcutPath, shortcutBindings, shortcutCommand, voxtypeVerbOf} from './common.js';

export const ROOT = SHORTCUT_ROOT;
export const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys';
export const CUSTOM_KEY = `${MEDIA_KEYS}.custom-keybinding`;

export const MSG_ADD_MODIFIER = 'Add Ctrl, Alt or Super';
export const MSG_NOT_PAUSED = 'Shortcuts are not paused: a combination already in use runs instead.';
export const MSG_UNAVAILABLE = 'GNOME’s custom shortcuts are not available';
export const conflictMessage = name => `Already used by “${name}”`;

// Where a built-in shortcut can live; only the schemas that are installed are searched.
const BUILTIN_SCHEMAS = Object.freeze([
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    MEDIA_KEYS,
]);

const SHORTCUT_NAME = Object.freeze({
    toggle: 'Voxtype dictation (toggle)',
    cancel: 'Voxtype dictation (cancel)',
});

const SHIFT = Gdk.ModifierType.SHIFT_MASK;
const NEEDS_ONE_OF = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK;
const XF86_FIRST = 0x1008fe00;

// --- key rules -----------------------------------------------------------------------------------------------

// One key press -> what the dialog does. GNOME Settings' normalisation: lower the keyval (keeping Shift when that
// changed it), ISO_Left_Tab is Tab, then mask with GTK's default modifier mask.
//   {action: 'wait'}                    a modifier key alone: keep listening
//   {action: 'cancel'} / {action: 'off'} Escape, BackSpace with no modifier
//   {action: 'refuse', message}          keep listening and say why
//   {action: 'accept', accel}            the string to store, for example `<Alt>space`
export function evaluateKey(keyval, state) {
    const cls = keyClass(keyval);
    if (cls === 'modifier')
        return {action: 'wait'};
    const {key, mods} = normalise(keyval, state);
    if (mods === 0 && key === Gdk.KEY_Escape)
        return {action: 'cancel'};
    if (mods === 0 && key === Gdk.KEY_BackSpace)
        return {action: 'off'};
    if (cls === 'key' && (mods & NEEDS_ONE_OF) === 0)
        return {action: 'refuse', message: MSG_ADD_MODIFIER};
    return {action: 'accept', accel: accelName(key, mods)};
}

// The pressed combination as an accelerator string, whatever the rules say about it (the dialog shows it).
export function pressedAccel(keyval, state) {
    const {key, mods} = normalise(keyval, state);
    return accelName(key, mods);
}

function normalise(keyval, state) {
    let key = keyval === Gdk.KEY_ISO_Left_Tab ? Gdk.KEY_Tab : keyval;
    let mods = state & Gtk.accelerator_get_default_mod_mask();
    const lower = Gdk.keyval_to_lower(key);
    if (lower !== key) {
        key = lower;
        mods |= SHIFT;
    }
    return {key, mods};
}

// Gtk names XF86AudioMicMute `AudioMicMute`; mutter and gsd parse the X11 name, so the prefix goes back.
function accelName(key, mods) {
    const name = Gtk.accelerator_name(key, mods);
    const keyName = Gdk.keyval_name(key);
    if (key >= XF86_FIRST && keyName && !keyName.startsWith('XF86') && name.endsWith(keyName))
        return `${name.slice(0, name.length - keyName.length)}XF86${keyName}`;
    return name;
}

// `<Primary>a`, `<Alt>Space`, `F9` -> {key, mods} in the same normal form as evaluateKey, or null. GTK 4 refuses
// `<Alt>Space` (key names are case-sensitive), which GNOME's own entries may carry, so the key name is retried in
// the other usual cases.
function parseAccel(text) {
    if (typeof text !== 'string' || text.trim() === '')
        return null;
    const raw = text.trim();
    const cut = raw.lastIndexOf('>') + 1;
    const head = raw.slice(0, cut);
    const name = raw.slice(cut);
    for (const candidate of new Set([name, name.toLowerCase(), name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()])) {
        let [ok, key, mods] = Gtk.accelerator_parse(head + candidate);
        if (!ok || key === 0)
            continue;
        if (key === Gdk.KEY_ISO_Left_Tab)
            key = Gdk.KEY_Tab;
        const lower = Gdk.keyval_to_lower(key);
        if (lower !== key) {
            key = lower;
            mods |= SHIFT;
        }
        return {key, mods: mods & Gtk.accelerator_get_default_mod_mask()};
    }
    return null;
}

// --- reading -------------------------------------------------------------------------------------------------

export function shortcutsAvailable() {
    const source = Gio.SettingsSchemaSource.get_default();
    return Boolean(source?.lookup(MEDIA_KEYS, true) && source.lookup(CUSTOM_KEY, true));
}

// Every custom shortcut, in the order of the list: {path, name, command, binding, verb}.
export function listEntries() {
    if (!shortcutsAvailable())
        return [];
    const paths = new Gio.Settings({schema_id: MEDIA_KEYS}).get_strv('custom-keybindings');
    return paths.map(path => {
        const custom = Gio.Settings.new_with_path(CUSTOM_KEY, path);
        const command = custom.get_string('command');
        return {path, name: custom.get_string('name'), command, binding: custom.get_string('binding'), verb: voxtypeVerbOf(command)};
    });
}

// The row a verb shows: the first entry whose command is `voxtype record <verb>`.
export const entryFor = (verb, entries = listEntries()) => entries.find(e => e.verb === verb) ?? null;

// The caps of the user's two shortcuts, or null (Not set). The same first-match rule as the menu (shortcutBindings).
export function readShortcuts() {
    const found = {toggle: null, cancel: null};
    try {
        const bindings = shortcutBindings(listEntries());
        for (const verb of Object.keys(found))
            found[verb] = capsFor(bindings[verb] ?? '');
    } catch (e) {
        console.warn(`[Dictation Indicator] could not read the shortcuts: ${e.message}`);
    }
    return found;
}

// --- conflicts -----------------------------------------------------------------------------------------------

// The name of what already uses `accel`, or null. Custom shortcuts first (by their name), then the built-in keys
// (by their schema summary, else the key id). The entry at `skipPath` is the one being edited.
export function findConflict(accel, {skipPath = null} = {}) {
    const want = parseAccel(accel);
    if (want === null)
        return null;
    const same = other => {
        const p = parseAccel(other);
        return p !== null && p.key === want.key && p.mods === want.mods;
    };
    for (const entry of listEntries()) {
        if (entry.path !== skipPath && same(entry.binding))
            return entry.name || entry.path.slice(ROOT.length).replace(/\/$/, '');
    }
    const source = Gio.SettingsSchemaSource.get_default();
    for (const id of BUILTIN_SCHEMAS) {
        const schema = source?.lookup(id, true);
        if (!schema)
            continue;
        let settings;
        try {
            settings = new Gio.Settings({settings_schema: schema});
        } catch (_e) {
            continue;
        }
        for (const keyId of schema.list_keys()) {
            if (keyId === 'custom-keybindings')
                continue;
            const key = schema.get_key(keyId);
            const type = key.get_value_type().dup_string();
            if (type !== 'as' && type !== 's')
                continue;
            const values = type === 'as' ? settings.get_strv(keyId) : [settings.get_string(keyId)];
            if (values.some(same))
                return key.get_summary() || keyId;
        }
    }
    return null;
}

// --- writing -------------------------------------------------------------------------------------------------

function put(settings, key, value) {
    if (!settings.is_writable(key) || !settings.set_string(key, value))
        throw new Error(`${key} is not writable`);
}

const ENTRY_KEYS = Object.freeze(['name', 'command', 'binding']);
const openSettings = (schemaId, path) => path ? Gio.Settings.new_with_path(schemaId, path) : new Gio.Settings({schema_id: schemaId});

// Sets the binding of the entry the row shows, or creates the entry. Throws before anything is written when the
// verb or the binding is invalid, and leaves nothing behind when a write is refused; returns the entry's path.
// `binding` '' turns the shortcut off. The tests pass `open` (a settings factory, to lock a key) and `beforeList`
// (called after the entry is written, before the list is read again).
export function writeShortcut(verb, binding, {open = openSettings, beforeList = null} = {}) {
    if (!(verb in SHORTCUT_NAME))
        throw new Error(`unknown verb ${verb}`);
    if (binding !== '' && parseAccel(binding) === null)
        throw new Error(`not an accelerator: ${binding}`);
    if (!shortcutsAvailable())
        throw new Error(MSG_UNAVAILABLE);
    const media = open(MEDIA_KEYS);
    if (!media.is_writable('custom-keybindings'))
        throw new Error('custom-keybindings is not writable');

    // An edit only sets `binding`: a refusal leaves the entry as it was, so there is nothing to undo.
    const existing = entryFor(verb);
    if (existing) {
        put(open(CUSTOM_KEY, existing.path), 'binding', binding);
        Gio.Settings.sync();
        return existing.path;
    }

    // A path is taken when it is listed or its entry already holds a name or a command: another process may have
    // written an entry and not appended its path yet.
    const written = candidate => ['name', 'command'].some(key => open(CUSTOM_KEY, candidate).get_user_value(key) !== null);
    const path = pickShortcutPath(media.get_strv('custom-keybindings'), verb, written);
    const custom = open(CUSTOM_KEY, path);
    for (const key of ENTRY_KEYS) {
        if (!custom.is_writable(key))
            throw new Error(`${key} is not writable`);
    }
    try {
        put(custom, 'name', SHORTCUT_NAME[verb]);
        put(custom, 'command', shortcutCommand(GLib.find_program_in_path('voxtype') ?? 'voxtype', verb));
        put(custom, 'binding', binding);
        beforeList?.(path);
        // Read the list again: another writer may have added a path since, and none may be reordered or dropped.
        const latest = media.get_strv('custom-keybindings');
        if (!latest.includes(path) && !media.set_strv('custom-keybindings', [...latest, path]))
            throw new Error('custom-keybindings could not be written');
    } catch (e) {
        // The path never reached the list, so no one reads this entry: drop what this call wrote.
        for (const key of ENTRY_KEYS)
            custom.reset(key);
        Gio.Settings.sync();
        throw e;
    }
    Gio.Settings.sync();
    return path;
}
