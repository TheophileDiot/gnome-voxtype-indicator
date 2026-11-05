# Release Process

`extensions.gnome.org` owns the extension version number shown on the GNOME website. Do not add a `version` key to `metadata.json`.

This repository tracks source releases with `VERSION` and matching Git tags such as `v0.1.0`.

## Branches

- `dev` is the integration branch for feature work, fixes, and Dependabot updates.
- `master` is the release branch.
- Open release PRs from `dev` to `master`, then tag the merged `master` commit.

## Prepare a Release

1. Start from `dev` and update `VERSION`, then set `version-name` in `metadata.json` to the
   same string. `make static-check` fails if the two disagree.
2. Keep `metadata.json` minimal:
   - no `version` key (`version-name` is a different key and is allowed)
   - `settings-schema` equals `org.gnome.shell.extensions.voxtype-indicator`, the id in
     `schemas/org.gnome.shell.extensions.voxtype-indicator.gschema.xml`
   - `shell-version` may declare GNOME Shell releases ahead of the one used for testing,
     so the extension stays installable on newer Shells. Anything newer than the maintainer's
     own Shell is declared, not verified; drop a release from the list as soon as a report
     shows it is actually broken.
   - `uuid` remains `voxtype-indicator@theophilediot.github.io`
3. Run:

```bash
make release-check
```

4. Review the ZIP contents. It should contain only:
   - `metadata.json`
   - `extension.js`
   - `prefs.js`
   - `common.js`
   - `source.js`
   - `levels.js`
   - `trace.js`
   - `orb.js`
   - `morph.js`
   - `shortcuts.js`
   - `stylesheet.css`
   - `schemas/org.gnome.shell.extensions.voxtype-indicator.gschema.xml` (and the bare `schemas/` entry
     that `gnome-extensions pack` adds; it emits no `schemas/gschemas.compiled`, the Shell compiles the
     schema on install)
5. Commit the release changes.
6. Merge `dev` into `master`.
7. Tag the merged `master` commit:

```bash
git tag v$(cat VERSION)
git push origin master v$(cat VERSION)
```

## Manual GNOME Upload

Build the reviewed ZIP:

```bash
make release-check
```

Sign in at:

```text
https://extensions.gnome.org/upload/
```

Upload:

```text
dist/voxtype-indicator@theophilediot.github.io.shell-extension.zip
```

GNOME will review the submitted version before publishing it.

## Review Notes

- `make release-check` runs `make tests`, which first dry-runs `glib-compile-schemas --strict` over `schemas/`,
  then unit-tests `common.js` (the state → view table, `parseState`, `parsePid`, `menuFor`), `source.js` (real
  file monitors on a temp runtime dir) and its systemd unit watch (`tests/test-unit.js`, a fake
  `org.freedesktop.systemd1` on a private test bus), `levels.js`, `trace.js` and `orb.js` (against the golden values
  that thinking-orbs publishes, and the Seed dots).
- `dist/` and local-only files stay out of source control; screenshots and docs stay out of the release ZIP.
- GNOME review guidelines require cleanup of all Shell-side state in `disable()`.
- Do not import GTK, Gdk, or Adwaita in `extension.js`; it runs inside the GNOME Shell process. `prefs.js` runs in
  the preferences process and must not import `resource:///org/gnome/shell/`.
- The extension spawns `voxtype record <verb>` only when the user picks a menu item, and its preferences may run
  `voxtype config get …` and `systemctl --user show …` in the preferences process. It never writes Voxtype's config. The preferences write the GNOME custom shortcuts (`org.gnome.settings-daemon.plugins.media-keys`) only when the user saves a new combination in the capture dialog.
- Before tagging, review the full diff for secrets, generated files, unpinned Actions, unexpected workflow permissions, and unexpected network endpoints. The extension makes no network requests.
