// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the prefs-only shortcut logic: the key rules, the conflict check, the path picker and
// the writer. The writer changes GSettings, so this file runs only under GSETTINGS_BACKEND=memory and aborts
// otherwise: it must never reach the user's dconf.
// Run from the repository root: GSETTINGS_BACKEND=memory gjs -m tests/test-shortcuts.js

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') {
    printerr('refusing to run: GSETTINGS_BACKEND is not "memory", the writer would touch the real dconf');
    System.exit(2);
}

import {keyClass, pickShortcutPath, shortcutCommand, voxtypeVerbOf} from '../common.js';
import {
    MSG_ADD_MODIFIER, ROOT, entryFor, evaluateKey, findConflict, listEntries, readShortcuts, writeShortcut,
} from '../shortcuts.js';

const failures = [];
let checks = 0;

function eq(actual, expected, label) {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        failures.push(`${label}: expected ${e}, got ${a}`);
}

const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_KEY = `${MEDIA_KEYS}.custom-keybinding`;
const pathOf = leaf => `${ROOT}${leaf}/`;
const mask = Gdk.ModifierType;
const keys = Gdk;

// --- the key rules -------------------------------------------------------------------------------------

for (const [name, keyval] of [['Shift_L', keys.KEY_Shift_L], ['Control_R', keys.KEY_Control_R], ['Alt_L', keys.KEY_Alt_L],
    ['Super_L', keys.KEY_Super_L], ['Meta_L', keys.KEY_Meta_L], ['Hyper_L', keys.KEY_Hyper_L],
    ['ISO_Level3_Shift', keys.KEY_ISO_Level3_Shift]])
    eq(evaluateKey(keyval, mask.ALT_MASK), {action: 'wait'}, `a modifier key alone waits: ${name}`);

eq(evaluateKey(keys.KEY_Escape, 0), {action: 'cancel'}, 'Escape with no modifier cancels');
eq(evaluateKey(keys.KEY_BackSpace, 0), {action: 'off'}, 'BackSpace with no modifier turns the shortcut off');
eq(evaluateKey(keys.KEY_a, 0), {action: 'refuse', message: MSG_ADD_MODIFIER}, 'a alone is refused');
eq(evaluateKey(keys.KEY_A, mask.SHIFT_MASK), {action: 'refuse', message: MSG_ADD_MODIFIER}, 'Shift+a is refused');
eq(evaluateKey(keys.KEY_space, 0), {action: 'refuse', message: MSG_ADD_MODIFIER}, 'space alone is refused');
eq(evaluateKey(keys.KEY_Tab, 0).action, 'refuse', 'Tab alone is refused');
eq(evaluateKey(keys.KEY_Escape, mask.SHIFT_MASK).action, 'refuse', 'Shift+Escape is not the cancel key');
eq(MSG_ADD_MODIFIER, 'Add Ctrl, Alt or Super', 'the refusal text');

eq(evaluateKey(keys.KEY_space, mask.ALT_MASK), {action: 'accept', accel: '<Alt>space'}, '<Alt>space is accepted');
eq(evaluateKey(keys.KEY_F9, mask.SUPER_MASK), {action: 'accept', accel: '<Super>F9'}, '<Super>F9 is accepted');
eq(evaluateKey(keys.KEY_F9, 0), {action: 'accept', accel: 'F9'}, 'F9 alone is accepted');
eq(evaluateKey(keys.KEY_F24, 0), {action: 'accept', accel: 'F24'}, 'F24 alone is accepted');
eq(evaluateKey(keys.KEY_XF86AudioMicMute ?? 269025202, 0), {action: 'accept', accel: 'XF86AudioMicMute'},
    'XF86AudioMicMute alone is accepted and keeps the XF86 prefix mutter parses');
eq(evaluateKey(keys.KEY_ISO_Left_Tab, mask.SHIFT_MASK | mask.CONTROL_MASK),
    {action: 'accept', accel: '<Shift><Control>Tab'}, 'ISO_Left_Tab becomes Tab');
eq(evaluateKey(keys.KEY_A, mask.ALT_MASK), {action: 'accept', accel: '<Shift><Alt>a'},
    'Shift is kept when lowering the keyval changed it');
eq(evaluateKey(keys.KEY_a, mask.ALT_MASK | mask.LOCK_MASK), {action: 'accept', accel: '<Alt>a'},
    'Caps Lock is masked out');
eq(evaluateKey(keys.KEY_a, mask.CONTROL_MASK | mask.ALT_MASK), {action: 'accept', accel: '<Control><Alt>a'},
    'two modifiers keep the GTK order');

eq(keyClass(keys.KEY_a), 'key', 'keyClass: a letter');
eq(keyClass(keys.KEY_Caps_Lock), 'modifier', 'keyClass: Caps Lock');
eq(keyClass(keys.KEY_F1), 'function', 'keyClass: F1');
eq(keyClass(keys.KEY_F24), 'function', 'keyClass: F24');
eq(keyClass(keys.KEY_F25), 'key', 'keyClass: F25 is no function key here');
eq(keyClass(269025202), 'function', 'keyClass: XF86 keys count as function keys');

// --- shortcut paths and commands -------------------------------------------------------------------------------

eq(pickShortcutPath([], 'toggle'), pathOf('voxtype'), 'path: a free voxtype/');
eq(pickShortcutPath([pathOf('voxtype')], 'toggle'), pathOf('voxtype-2'), 'path: a taken one gives voxtype-2/');
eq(pickShortcutPath([pathOf('voxtype'), pathOf('voxtype-2')], 'toggle'), pathOf('voxtype-3'), 'path: then -3');
eq(pickShortcutPath([pathOf('voxtype')], 'cancel'), pathOf('voxtype-cancel'), 'path: cancel has its own leaf');
eq(pickShortcutPath([pathOf('voxtype-cancel')], 'cancel'), pathOf('voxtype-cancel-2'), 'path: cancel-2');
eq(shortcutCommand('/usr/bin/voxtype', 'toggle'), '/usr/bin/voxtype record toggle', 'command: toggle');
eq(voxtypeVerbOf(shortcutCommand('/opt/my bin/voxtype', 'cancel')), 'cancel', 'command: matches voxtypeVerbOf even with a space');

// --- memory-backed profile --------------------------------------------------------------------------------

const media = new Gio.Settings({schema_id: MEDIA_KEYS});
const entry = path => Gio.Settings.new_with_path(CUSTOM_KEY, path);
const FREE = '<Super><Alt>F10';
// Every seed starts from a blank profile: an entry another test left on a path would count as taken.
const LEAVES = ['custom0', 'custom1', 'voxtype', 'voxtype-2', 'voxtype-3', 'voxtype-cancel', 'voxtype-cancel-2', 'late-arrival'];
const seed = (paths, rows) => {
    for (const leaf of LEAVES) {
        for (const key of ['name', 'command', 'binding'])
            entry(pathOf(leaf)).reset(key);
    }
    media.set_strv('custom-keybindings', paths);
    for (const [leaf, name, command, binding] of rows) {
        const s = entry(pathOf(leaf));
        s.set_string('name', name);
        s.set_string('command', command);
        s.set_string('binding', binding);
    }
};
const profile = () => {
    seed([pathOf('custom0'), pathOf('voxtype'), pathOf('custom1'), pathOf('voxtype-cancel')], [
        ['custom0', 'Launcher', 'launcher', '<Control>F12'],
        ['voxtype', 'Voxtype dictation (toggle)', '/usr/bin/voxtype record toggle', '<Alt>space'],
        ['custom1', 'Other thing', 'other', '<Primary>a'],
        ['voxtype-cancel', 'Voxtype dictation (cancel)', '/usr/bin/voxtype record cancel', '<Shift><Alt>space'],
    ]);
};

profile();
eq(listEntries().map(e => [e.path, e.name, e.verb, e.binding]), [
    [pathOf('custom0'), 'Launcher', null, '<Control>F12'],
    [pathOf('voxtype'), 'Voxtype dictation (toggle)', 'toggle', '<Alt>space'],
    [pathOf('custom1'), 'Other thing', null, '<Primary>a'],
    [pathOf('voxtype-cancel'), 'Voxtype dictation (cancel)', 'cancel', '<Shift><Alt>space'],
], 'listEntries reads every entry in order');
eq(readShortcuts(), {toggle: ['Alt', 'Space'], cancel: ['Alt', 'Shift', 'Space']}, 'readShortcuts gives the caps');

// two toggle entries: the first one is the row's entry, even when it is turned off
seed([pathOf('voxtype'), pathOf('voxtype-2'), pathOf('voxtype-cancel')], [
    ['voxtype', 'Voxtype dictation (toggle)', '/usr/bin/voxtype record toggle', ''],
    ['voxtype-2', 'Voxtype again', '/usr/bin/voxtype record toggle', '<Alt>F9'],
    ['voxtype-cancel', 'Voxtype dictation (cancel)', '/usr/bin/voxtype record cancel', '<Shift><Alt>space'],
]);
eq(readShortcuts().toggle, null, 'duplicates: a disabled first entry reads as Not set, not as the second');
eq(entryFor('toggle').path, pathOf('voxtype'), 'duplicates: the writer edits the first entry');
eq(findConflict('', {skipPath: pathOf('voxtype-2')}), null, 'duplicates: a disabled binding never conflicts with a disabled one');
eq(findConflict('<Alt>space', {skipPath: pathOf('voxtype-2')}) !== 'Voxtype dictation (toggle)', true,
    'duplicates: a disabled binding equals nothing');
profile();

// conflicts
eq(findConflict('<Control>a', {skipPath: pathOf('voxtype')}), 'Other thing', '<Control>a conflicts with <Primary>a by its name');
eq(findConflict('<Primary>F12', {skipPath: pathOf('voxtype')}), 'Launcher', '<Primary>F12 conflicts with <Control>F12');
eq(findConflict('<Alt>Space', {skipPath: pathOf('voxtype-cancel')}), 'Voxtype dictation (toggle)',
    '<Alt>Space equals <Alt>space');
eq(findConflict('<Control>A', {skipPath: pathOf('voxtype')}), 'Other thing', 'letter case does not matter: <Control>A equals <Primary>a');
eq(findConflict('<Shift><Alt>Space', {skipPath: pathOf('voxtype')}), 'Voxtype dictation (cancel)',
    'the other voxtype verb conflicts');
eq(findConflict('<Shift><Alt>space', {skipPath: pathOf('voxtype-cancel')}), null,
    'the entry being edited never conflicts with itself, and <Alt>space is a different mask');
eq(findConflict(FREE, {skipPath: pathOf('voxtype')}), null, 'a free combination has no conflict');
const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
const wmKey = wm.settings_schema.get_key('activate-window-menu');
eq(wm.get_default_value('activate-window-menu').deepUnpack(), ['<Alt>space'], 'fixture: the window menu default is <Alt>space');
eq(findConflict('<Alt>Space', {skipPath: pathOf('voxtype')}), wmKey.get_summary(),
    'a built-in key is named by its schema summary: <Alt>Space equals <Alt>space');
eq(typeof wmKey.get_summary(), 'string', 'fixture: the schema summary exists');
eq(findConflict('<Alt>space', {skipPath: pathOf('voxtype')}) !== 'activate-window-menu', true, 'never the key id when a summary exists');
// every built-in keybinding schema that is installed is searched
eq(findConflict('<Super>l', {skipPath: pathOf('voxtype')}) !== null, true, 'a media-keys key (screensaver) is searched');
eq(findConflict('', {skipPath: pathOf('voxtype')}), null, 'a disabled binding never conflicts');

// writer: an edit
profile();
const before = media.get_strv('custom-keybindings');
writeShortcut('toggle', FREE);
eq(media.get_strv('custom-keybindings'), before, 'an edit keeps every path, in order');
eq(entry(pathOf('voxtype')).get_string('binding'), FREE, 'an edit sets the binding');
eq(entry(pathOf('voxtype')).get_string('command'), '/usr/bin/voxtype record toggle', 'an edit leaves the command alone');
eq(entry(pathOf('voxtype')).get_string('name'), 'Voxtype dictation (toggle)', 'an edit leaves the name alone');
eq(entry(pathOf('voxtype-cancel')).get_string('binding'), '<Shift><Alt>space', 'an edit leaves the other verb alone');
eq(entry(pathOf('custom0')).get_string('binding'), '<Control>F12', 'an edit leaves every other entry alone');

// writer: turning off
writeShortcut('toggle', '');
eq(entry(pathOf('voxtype')).get_string('binding'), '', 'turning off writes an empty binding');
eq(media.get_strv('custom-keybindings'), before, 'turning off keeps the entry in the list');
eq(readShortcuts().toggle, null, 'a turned-off shortcut reads as Not set');
eq(readShortcuts().cancel, ['Alt', 'Shift', 'Space'], 'the other verb still reads');

// writer: a create
seed([pathOf('custom0')], [['custom0', 'Launcher', 'launcher', '<Control>F12']]);
const created = writeShortcut('toggle', FREE);
eq(created, pathOf('voxtype'), 'a create returns its path');
eq(media.get_strv('custom-keybindings'), [pathOf('custom0'), pathOf('voxtype')], 'a create appends the path last');
eq(entry(pathOf('voxtype')).get_string('name'), 'Voxtype dictation (toggle)', 'a create writes the name');
eq(entry(pathOf('voxtype')).get_string('binding'), FREE, 'a create writes the binding');
eq(voxtypeVerbOf(entry(pathOf('voxtype')).get_string('command')), 'toggle', 'a create writes a command voxtypeVerbOf accepts');
eq(/(^|\/)voxtype record toggle$/.test(entry(pathOf('voxtype')).get_string('command')), true, 'the command ends in `voxtype record toggle`');
eq(entry(pathOf('custom0')).get_string('binding'), '<Control>F12', 'a create leaves other entries alone');

// writer: a create with a taken path, and the cancel verb
seed([pathOf('voxtype')], [['voxtype', 'My own', 'something else', '<Control>F8']]);
eq(writeShortcut('cancel', FREE), pathOf('voxtype-cancel'), 'cancel gets its own path');
eq(writeShortcut('toggle', FREE), pathOf('voxtype-2'), 'a taken voxtype/ gives voxtype-2/');
eq(media.get_strv('custom-keybindings'), [pathOf('voxtype'), pathOf('voxtype-cancel'), pathOf('voxtype-2')],
    'both appended after the existing path, nothing reordered');
eq(entry(pathOf('voxtype')).get_string('command'), 'something else', 'an unrelated entry on voxtype/ is untouched');

// writer: the list is read again just before the write. The competitor lands after the writer chose its path and
// wrote the entry, before it appends: only a re-read keeps it.
seed([pathOf('custom0')], [['custom0', 'Launcher', 'launcher', '<Control>F12']]);
writeShortcut('toggle', FREE, {
    beforeList: () => media.set_strv('custom-keybindings', [pathOf('custom0'), pathOf('late-arrival')]),
});
eq(media.get_strv('custom-keybindings'), [pathOf('custom0'), pathOf('late-arrival'), pathOf('voxtype')],
    'a path added elsewhere is kept: the list is read again right before the write');

// writer: another process wrote an entry on the path but has not appended it yet
seed([pathOf('custom0')], [['custom0', 'Launcher', 'launcher', '<Control>F12']]);
entry(pathOf('voxtype')).set_string('name', 'Someone else');
eq(writeShortcut('toggle', FREE), pathOf('voxtype-2'), 'a path whose entry already has a name is taken');
eq(entry(pathOf('voxtype')).get_string('name'), 'Someone else', 'that entry is left alone');
seed([pathOf('custom0')], [['custom0', 'Launcher', 'launcher', '<Control>F12']]);
entry(pathOf('voxtype')).set_string('command', 'something');
eq(writeShortcut('toggle', FREE), pathOf('voxtype-2'), 'a path whose entry already has a command is taken');

// writer: a refused write leaves nothing behind. `open` hands the writer an entry whose keys can be locked.
const KEYS = ['name', 'command', 'binding'];
const userValues = path => Object.fromEntries(KEYS.map(k => [k, entry(path).get_user_value(k)?.deepUnpack() ?? null]));
const wrap = (target, {locked = [], refuse = []}) => new Proxy(target, {
    get(t, prop) {
        const value = t[prop];
        if (typeof value !== 'function')
            return value;
        if (prop === 'is_writable')
            return key => !locked.includes(key) && t.is_writable(key);
        if (prop === 'set_string' || prop === 'set_strv')
            return (key, v) => !refuse.includes(key) && t[prop](key, v);
        return value.bind(t);
    },
});
const lockedOpen = opts => (schema, path) => wrap(path ? Gio.Settings.new_with_path(schema, path) : new Gio.Settings({schema_id: schema}), opts);
const failsWith = (fn) => {
    try {
        fn();
    } catch (e) {
        return e.message;
    }
    return null;
};
const NOTHING = {name: null, command: null, binding: null};

seed([pathOf('custom0')], [['custom0', 'Launcher', 'launcher', '<Control>F12']]);
let msg = failsWith(() => writeShortcut('toggle', FREE, {open: lockedOpen({locked: ['binding']})}));
eq(typeof msg, 'string', 'a create with a locked binding throws');
eq(userValues(pathOf('voxtype')), NOTHING, 'a create with a locked binding writes no name and no command');
eq(media.get_strv('custom-keybindings'), [pathOf('custom0')], 'a create with a locked binding leaves the list alone');

msg = failsWith(() => writeShortcut('toggle', FREE, {open: lockedOpen({locked: ['name']})}));
eq(typeof msg, 'string', 'a create with a locked name throws');
eq(userValues(pathOf('voxtype')), NOTHING, 'a create with a locked name writes nothing');

msg = failsWith(() => writeShortcut('toggle', FREE, {open: lockedOpen({refuse: ['binding']})}));
eq(typeof msg, 'string', 'a create whose binding write is refused throws');
eq(userValues(pathOf('voxtype')), NOTHING, 'a refused binding write resets the name and command already written');
eq(media.get_strv('custom-keybindings'), [pathOf('custom0')], 'a refused binding write leaves the list alone');

msg = failsWith(() => writeShortcut('toggle', FREE, {open: lockedOpen({refuse: ['custom-keybindings']})}));
eq(typeof msg, 'string', 'a create whose list write is refused throws');
eq(userValues(pathOf('voxtype')), NOTHING, 'a refused list write discards the entry it wrote');
eq(media.get_strv('custom-keybindings'), [pathOf('custom0')], 'a refused list write leaves the list as it was');

msg = failsWith(() => writeShortcut('toggle', FREE, {open: lockedOpen({locked: ['custom-keybindings']})}));
eq(typeof msg, 'string', 'a create with a locked list throws');
eq(userValues(pathOf('voxtype')), NOTHING, 'a create with a locked list writes no entry');

profile();
msg = failsWith(() => writeShortcut('toggle', FREE, {open: lockedOpen({locked: ['binding']})}));
eq(typeof msg, 'string', 'an edit with a locked binding throws');
eq([entry(pathOf('voxtype')).get_string('binding'), entry(pathOf('voxtype')).get_string('name'),
    entry(pathOf('voxtype')).get_string('command')],
['<Alt>space', 'Voxtype dictation (toggle)', '/usr/bin/voxtype record toggle'], 'a refused edit changes nothing');
eq(media.get_strv('custom-keybindings').length, 4, 'a refused edit keeps the list');

// writer: a bad verb or binding is refused before anything is written
seed([pathOf('custom0')], [['custom0', 'Launcher', 'launcher', '<Control>F12']]);
let threw = false;
try {
    writeShortcut('record', FREE);
} catch (_e) {
    threw = true;
}
eq(threw, true, 'an unknown verb throws');
eq(media.get_strv('custom-keybindings'), [pathOf('custom0')], 'an unknown verb writes nothing');
threw = false;
try {
    writeShortcut('toggle', 'not an accelerator');
} catch (_e) {
    threw = true;
}
eq(threw, true, 'a binding that does not parse throws');
eq(media.get_strv('custom-keybindings'), [pathOf('custom0')], 'a bad binding writes nothing');

// the real profile is never reached: this run was memory-backed
eq(Gio.SettingsBackend.get_default().constructor.name.includes('Memory') || GLib.getenv('GSETTINGS_BACKEND') === 'memory', true,
    'the memory backend is in use');
eq(Gtk.accelerator_name(keys.KEY_space, mask.ALT_MASK), '<Alt>space', 'sanity: GTK names the accelerator');

if (failures.length > 0) {
    printerr(`FAIL (${failures.length} of ${checks} checks):`);
    for (const f of failures)
        printerr(`  - ${f}`);
    System.exit(1);
}
print(`ok: ${checks} checks`);
