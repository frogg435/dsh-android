#!/system/bin/sh
# Install the bundled dsh plugins into the dsh profile.
#
# They ship as APK assets (assets/dsh-*) because they have to be present before
# the profile's config is read: each registers itself through
# dsh.profile.bundles in package.json, and dsh loads bundles at boot. So this
# runs during first-launch setup, before node is started.
#
# Usage: setup-plugin.sh <filesDir> <homeDir>
set -eu

FILES="$1"                  # .../files
HOME_DIR="$2"               # .../files/home
PROFILE="$HOME_DIR/.dsh/profiles/web"
PKG="$PROFILE/package.json"

# Space-separated. Adding one means dropping its directory into assets/ and
# extracting it in MainActivity alongside the others.
PLUGINS="dsh-adb dsh-balance"

# Insert a bundle id into the profile's JSON. A hand-rolled edit keeps this to a
# plain shell script with no node process; the shape is a fixed list of strings.
# Rewrite the profile manifest from scratch.
#
# Patching this JSON in place is not worth it: Android's toybox sed has no \?
# (a GNU extension), so an optional trailing comma cannot be matched, and any
# hand edit that removes a bundle line leaves one behind — which makes the whole
# profile unreadable and dsh refuses to start. The file is fifteen lines that
# belong to this app, so regenerate it instead of editing it: always valid,
# always idempotent, no anchoring to get wrong.
write_profile() {
	# Discovered entries first, then ours. Dedupe the COMBINED list: anything
	# already registered would otherwise be mounted a second time.
	{
		sed -n '/"bundles"/,/]/p' "$PKG" 2>/dev/null \
			| grep -o '"[^"]*"' | tr -d '"' | grep -v '^bundles$' || true
		printf '%s\n' $PLUGINS
	} | awk 'NF && !seen[$0]++' > "$PKG.ids"

	{
		printf '{\n'
		printf '  "name": "dsh-profile-web",\n'
		printf '  "private": true,\n'
		printf '  "dependencies": {},\n'
		printf '  "dsh": {\n'
		printf '    "profile": {\n'
		printf '      "bundles": [\n'
		first=1
		while IFS= read -r one; do
			[ "$first" = 1 ] || printf ',\n'
			printf '        "%s"' "$one"
			first=0
		done < "$PKG.ids"
		printf '\n      ],\n'
		printf '      "patchReload": "live"\n'
		printf '    }\n'
		printf '  }\n'
		printf '}\n'
	} > "$PKG.tmp" && mv "$PKG.tmp" "$PKG"
	rm -f "$PKG.ids"
}

# The profile directory only exists after dsh's first boot; the boot code
# creates it via its own defaults, so tolerate its absence and let a later
# launch pick the plugins up.
mkdir -p "$PROFILE/node_modules"

for plugin in $PLUGINS; do
	src="$FILES/$plugin"
	dest="$PROFILE/node_modules/$plugin"

	if [ ! -d "$src" ]; then
		echo "setup-plugin: missing $src" >&2
		continue
	fi

	# Refresh on every launch so a fix in the APK actually lands. Each plugin is
	# a few tens of KB.
	rm -rf "$dest"
	cp -r "$src" "$dest"
	chmod -R u+rwX "$dest"

	if [ ! -f "$PKG" ]; then
		cat > "$PKG" <<'JSON'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ],
      "patchReload": "live"
    }
  }
}
JSON
	fi
done

write_profile

echo "setup-plugin: installed $PLUGINS"
