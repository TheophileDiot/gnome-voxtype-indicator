# Contributing

Thanks for helping improve Dictation Indicator for Voxtype. Keep changes focused, reproducible, and easy to review.

## Branches

- Open normal pull requests against `dev`.
- Keep `master` for release-ready code and release tags.
- Release PRs should merge `dev` into `master`, then tag the merged `master` commit.

## Issues

A useful bug report includes:

- GNOME Shell version
- Wayland or X11 session type
- Linux distribution
- Voxtype version (`voxtype --version`) and whether `state_file` is the default
- extension version, release, or commit
- what `cat "$XDG_RUNTIME_DIR/voxtype/state"` shows while the problem happens
- exact reproduction steps
- relevant GNOME Shell logs (`journalctl -o cat /usr/bin/gnome-shell | grep 'Dictation Indicator'`) with private paths removed

Never paste dictated text.

## Pull Requests

Before opening a PR:

- keep the change scoped to the extension, metadata, packaging, docs, or release workflow
- avoid unrelated refactors
- do not commit generated artifacts such as files under `dist/`
- do not include credentials, tokens, cookies, private keys, or private logs
- run `make test` when the change touches runtime files, metadata, packaging, or release docs
- for a visible change, add a screenshot taken in an isolated nested shell (see `AGENTS.md`)

## Security Expectations

- Do not add repository or organization secrets. Release upload secrets must be environment-scoped and documented in `SECURITY.md`.
- Do not add third-party GitHub Actions unless a maintainer explicitly approves them. If an Action is necessary, pin it to a full 40-character commit SHA and include the upstream version as a comment.
- Keep workflow permissions least-privilege. Validation jobs should use read-only repository contents.
- Do not add `pull_request_target`, `workflow_run`, or `repository_dispatch` workflows for this project.
- Fork pull requests must not change workflow, Dependabot, CODEOWNERS, or `Makefile` automation directly. A maintainer must recreate reviewed automation changes from a trusted branch.
- Avoid vendored, minified, generated, or unreviewed binary blobs.

See `SECURITY.md` for the release security policy.

## Local Development

Install from source (builds the ZIP, then runs `gnome-extensions install --force`, which compiles the schema):

```bash
make install
```

Restart GNOME Shell:

- X11: press `Alt` + `F2`, type `r`, press `Enter`
- Wayland: log out and back in

Enable the extension:

```bash
gnome-extensions enable voxtype-indicator@theophilediot.github.io
```

## Validation

Run the local test target before release-facing changes:

```bash
make test
```

This validates metadata, the GSettings schema (`glib-compile-schemas --strict --dry-run schemas`), GNOME import
boundaries, the unit tests (`tests/`), packaging, and package contents.

The package should contain only:

- `extension.js`
- `prefs.js`
- `common.js`
- `source.js`
- `levels.js`
- `trace.js`
- `orb.js`
- `morph.js`
- `shortcuts.js`
- `metadata.json`
- `stylesheet.css`
- `schemas/org.gnome.shell.extensions.voxtype-indicator.gschema.xml`, with the bare `schemas/` entry that
  `gnome-extensions pack` adds (it emits no `schemas/gschemas.compiled`)

## GNOME Shell Extension Rules

- Keep `metadata.json` minimal and do not add a manual `version` key.
- Use stable GNOME Shell versions only in `shell-version`.
- Create Shell-side state from `enable()` and clean it up in `disable()`.
- Do not import GTK, Gdk, or Adwaita in `extension.js`. `prefs.js` is the only file that uses Adw and Gtk, and it must never import `resource:///org/gnome/shell/`.
- Keep `common.js`, `source.js`, `levels.js`, `trace.js` and `orb.js` Shell-free: they load under `gjs -m` in the tests. `common.js`, `source.js` and `levels.js` import only `gi://GLib`, `gi://Gio` and `./common.js`; `trace.js` and `orb.js` import nothing. `orb.js` keeps the thinking-orbs MIT notice in its header.
- The pill must never take keyboard focus or input. The top-bar button is reactive (it owns the menu) and closes the menu before it spawns anything.
- No idle timers, sockets or subprocesses: the timers and the level socket exist only while Voxtype records or transcribes (the 2 s liveness watchdog, the orb's clock, the level reader, the 8 s one-shot for `Still transcribing…`), plus one receipt timeout of at most 1.5 s afterwards. While idle only passive handlers remain: GSettings `changed::` handlers, file monitors and one systemd `PropertiesChanged` match.
- Never open the microphone and never store or log a level: the only signal is Voxtype's `audio.sock`.
- Use `Gio.Subprocess` with an argument vector for local commands; do not use shell command-line spawning. The extension spawns `voxtype record <verb>` only on a menu click, and never writes Voxtype's config.
- Test nested shells under `dbus-run-session`, so the systemd watch never sees the real `voxtype.service`.

## Releases

Source releases are tracked with `VERSION` and tags such as `v0.1.0`.
The GNOME Extensions website assigns its own version after upload, so `metadata.json` intentionally has no `version` key.

See `RELEASE.md` for the maintainer release flow.
