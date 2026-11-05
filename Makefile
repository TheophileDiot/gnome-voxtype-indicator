UUID = voxtype-indicator@theophilediot.github.io
SCHEMA_ID = org.gnome.shell.extensions.voxtype-indicator
SCHEMA = schemas/$(SCHEMA_ID).gschema.xml
RUNTIME_FILES = extension.js prefs.js common.js source.js levels.js trace.js orb.js morph.js shortcuts.js stylesheet.css metadata.json
# gnome-extensions pack (50.1) adds extension.js, prefs.js, metadata.json and the schema itself, a bare
# "schemas/" directory entry included, and emits no schemas/gschemas.compiled.
ZIP_FILES = $(RUNTIME_FILES) schemas/ $(SCHEMA)

INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
DIST_DIR = dist
ZIP = $(DIST_DIR)/$(UUID).shell-extension.zip

.PHONY: all install uninstall pack zip static-check tests package-content-check release-check test clean

all: pack

pack:
	mkdir -p "$(DIST_DIR)"
	gnome-extensions pack --force --out-dir "$(DIST_DIR)" --schema="$(SCHEMA)" \
		--extra-source common.js --extra-source source.js --extra-source levels.js --extra-source trace.js \
		--extra-source orb.js --extra-source morph.js --extra-source shortcuts.js --extra-source stylesheet.css .

zip: pack

install: pack
	gnome-extensions install --force "$(ZIP)"
	@echo "Installed $(UUID)"
	@echo "Restart GNOME Shell to load changes (log out/in on Wayland)"

uninstall:
	@rm -rf $(INSTALL_DIR)
	@echo "Uninstalled $(UUID)"

static-check:
	test "$$(jq -r '.uuid' metadata.json)" = "$(UUID)"
	jq -e 'has("version") | not' metadata.json >/dev/null
	jq -e '."shell-version" | length > 0' metadata.json >/dev/null
	test "$$(jq -r '."settings-schema"' metadata.json)" = "$(SCHEMA_ID)"
	test -f "$(SCHEMA)"
	test -f prefs.js
	test -s VERSION
	test "$$(jq -r '."version-name"' metadata.json)" = "$$(cat VERSION)"
	@if grep -En "from 'gi://(Gtk|Gdk|Adw)" extension.js; then \
		echo "extension.js must not import GTK, Gdk, or Adwaita" >&2; \
		exit 1; \
	fi
	@if grep -En "from 'gi://(Gtk|Gdk|Adw|St|Clutter|Meta|Shell)|resource:///org/gnome/shell/" common.js; then \
		echo "common.js must stay shell-free: no GTK, Shell UI or runtime imports" >&2; \
		exit 1; \
	fi
	@if grep -En "from 'gi://(Gtk|Gdk|Adw|St|Clutter|Meta|Shell)|resource:///org/gnome/shell/" source.js; then \
		echo "source.js must stay shell-free: no GTK, Shell UI or runtime imports" >&2; \
		exit 1; \
	fi
	@if grep -En "from 'gi://(Gtk|Gdk|Adw|St|Clutter|Meta|Shell)|resource:///org/gnome/shell/" levels.js; then \
		echo "levels.js must stay shell-free: no GTK, Shell UI or runtime imports" >&2; \
		exit 1; \
	fi
	@if grep -En "from 'gi://(Gtk|Gdk|Adw|St|Clutter|Meta|Shell|cairo)|resource:///org/gnome/shell/" orb.js; then \
		echo "orb.js must stay shell-free: no GTK, Shell UI, Cairo or runtime imports" >&2; \
		exit 1; \
	fi
	@if grep -En "^import " trace.js; then \
		echo "trace.js must have no imports at all" >&2; \
		exit 1; \
	fi
	@if grep -En "^import " morph.js; then \
		echo "morph.js must have no imports at all" >&2; \
		exit 1; \
	fi
	@if grep -En "resource:///org/gnome/shell/" prefs.js; then \
		echo "prefs.js runs outside the Shell: it must not import the Shell's own UI modules" >&2; \
		exit 1; \
	fi
	@if grep -En "spawn_command_line" extension.js prefs.js common.js source.js levels.js trace.js orb.js morph.js shortcuts.js; then \
		echo "Use Gio.Subprocess argv APIs instead of shell command-line spawning" >&2; \
		exit 1; \
	fi

tests:
	glib-compile-schemas --strict --dry-run schemas
	gjs -m tests/test-common.js
	gjs -m tests/test-source.js
	gjs -m tests/test-unit.js
	gjs -m tests/test-levels.js
	gjs -m tests/test-trace.js
	gjs -m tests/test-orb.js
	gjs -m tests/test-morph.js
	GSETTINGS_BACKEND=memory gjs -m tests/test-shortcuts.js

package-content-check:
	unzip -l "$(ZIP)"
	@for file in $(ZIP_FILES); do \
		zipinfo -1 "$(ZIP)" | grep -Fxq -- "$$file" || { \
			echo "Missing expected file in $(ZIP): $$file" >&2; \
			exit 1; \
		}; \
	done
	@unexpected="$$(zipinfo -1 "$(ZIP)" | grep -Fvx $(foreach file,$(ZIP_FILES),-e '$(file)') || true)"; \
	if test -n "$$unexpected"; then \
		printf '%s\n' "$$unexpected"; \
		echo "Unexpected file in $(ZIP)" >&2; \
		exit 1; \
	fi

release-check: static-check tests
	$(MAKE) pack
	$(MAKE) package-content-check

test: release-check

clean:
	@rm -rf "$(DIST_DIR)"
