# Security Policy

## Scope

Dictation Indicator for Voxtype is a local GNOME Shell extension. It makes no network requests. The Shell side writes only
the extension's own GSettings keys. The preferences window writes one more place, and only when the user asks: GNOME's
custom shortcuts (`org.gnome.settings-daemon.plugins.media-keys`). Saving a new combination in its dialog sets the
`binding` of the user's existing `voxtype record toggle` or `cancel` shortcut. If that shortcut does not exist, it
creates one: an entry with `name`, `command` and `binding`, added to the `custom-keybindings` list. The extension reads two files that Voxtype writes under `$XDG_RUNTIME_DIR/voxtype/`: `state` (one word) and
`voxtype.lock` (the daemon PID), and it checks that `/proc/<pid>` exists. While Voxtype records or transcribes it
also watches `voxtype/cancel` (a file the `voxtype record cancel` command creates) for its creation, without reading it.

**Subprocesses.**

- The extension spawns `voxtype record <verb>` with `Gio.Subprocess` and an argument vector, where `<verb>` is
  `start`, `stop` or `cancel`. It does this only when the user picks the matching menu item, never on its own,
  and never through a shell. One spawn runs at a time, and `disable()` kills a running child.
- The preferences window (`prefs.js`, its own process, not the Shell) may run `voxtype config get
  whisper.model` and `voxtype config get audio.external_trigger_silence_timeout_secs` once, to fill read-only
  status rows.
- The extension never writes Voxtype's `config.toml`, which can hold secrets and which Voxtype owns.

**D-Bus.** The extension talks to the systemd user manager on the session bus, and only with `LoadUnit` (for
`voxtype.service`), `Subscribe`, `Unsubscribe` and `Properties.Get`, plus a `PropertiesChanged` match on that one
unit path. It starts, stops and restarts nothing.

While Voxtype records, it also connects as a client to the local Unix socket
`$XDG_RUNTIME_DIR/voxtype/audio.sock` that the daemon serves, and reads its level frames: 16 bytes every
10 ms (a sequence number and three amplitude values, of which only the sequence number and the peak are used).
That is the same stream Voxtype's own overlay reads. The reader never opens the microphone, never writes to the
socket, and keeps nothing: levels live in memory for a few hundred milliseconds, are never stored, logged or
sent anywhere, and the socket is closed when recording ends. Frames are validated (a non-finite or positive peak is
dropped, and 30 invalid frames in a row end the reader for that recording) and a read is limited to 4096 bytes.
Normal development, validation, packaging, and release should not require
repository secrets, analytics, telemetry, or cloud build services.

The pill never takes keyboard focus or input: it is not reactive and cannot receive dictated text. A change that
makes the pill focusable or reactive is a security-relevant regression, because Voxtype pastes into the focused
window. The top-bar button is reactive because it owns the menu; the menu closes before any spawn and on every
change to transcribing or idle, so it never holds a grab while Voxtype pastes.

No project can make supply-chain compromise impossible. This repository keeps the release path small and auditable so a maintainer can detect and block risky changes before upload.

## Reporting Vulnerabilities

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not enabled, contact the maintainer privately before publishing details.

Do not open public issues containing exploit details, credentials, tokens, private logs, or unreleased vulnerability details.

## Secret Handling

- Do not commit credentials, tokens, cookies, private keys, API keys, or copied private logs.
- Do not configure repository or organization secrets for this project unless release automation is explicitly added.
- If GNOME upload automation is enabled, store `GNOME_EXTENSIONS_TOKEN` as an environment secret on a protected `gnome-extensions` environment, not as a broad repository or organization secret.
- Do not store a GNOME account password in GitHub. Use a short-lived GNOME Extensions API token and rotate it after release use or failed upload attempts.
- If a secret is committed or printed in logs, revoke and rotate it before continuing.
- Never log or screenshot dictated text. The extension does not read it, and bug reports must not include it.

## Supply-Chain Controls

- External GitHub Actions, if added, must be pinned to full 40-character commit SHAs with a version comment.
- Automation changes from fork pull requests should be rejected in CI. A maintainer should recreate reviewed workflow, Dependabot, or `Makefile` changes from a trusted branch.
- Release automation, if added, should use GitHub-owned Actions, the GitHub CLI, and direct API calls; do not use third-party release or GNOME upload Actions.
- GNOME upload automation must be opt-in and must use a protected environment with maintainer approval.
- The release ZIP is checked against an exact allowlist of runtime files.
- Generated files such as `dist/` and extension ZIPs must not be committed.

## Maintainer Repository Settings

Enable these GitHub repository protections before accepting outside contributions:

- Secret scanning and push protection.
- Dependabot alerts and Dependabot security updates.
- Branch protection for `dev` and `master`, including required pull request review.
- Code owner review for workflow, packaging, metadata, and runtime changes.
- Required status checks from the protected base branch before merging PRs.
- Restricted tag creation for release tags such as `v*`, if available for the repository.
- Read-only default workflow token permissions.

## Release Safety Checklist

Before tagging a release:

1. Review the full diff, including workflow, packaging, and metadata changes.
2. Treat green CI as insufficient if the PR changes automation files; review those files manually.
3. Run `make release-check`.
4. Confirm the ZIP contains only runtime files: `metadata.json`, `extension.js`, `prefs.js`, `common.js`, `source.js`, `levels.js`, `trace.js`, `orb.js`, `stylesheet.css` and `schemas/org.gnome.shell.extensions.voxtype-indicator.gschema.xml`.
5. Confirm `dist/`, screenshots, docs, and local-only files are not in the release ZIP.
6. Confirm the extension still makes no network requests and opens no microphone, that the only socket it connects to is Voxtype's `audio.sock`, that the only process it spawns from the Shell is `voxtype record <verb>` on a menu click, and that the only D-Bus calls are the four listed above.
7. Tag only the reviewed `master` commit.
8. Upload the reviewed release artifact to `extensions.gnome.org`.
