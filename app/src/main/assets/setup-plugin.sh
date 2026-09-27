#!/system/bin/sh
# Install the bundled dsh-adb plugin into the dsh profile.
#
# The plugin ships as APK assets (assets/dsh-adb) because it has to be present
# before the profile's config is read: it registers itself through
# dsh.profile.bundles in package.json, and dsh loads bundles at boot. So this
# runs during first-launch setup, before node is started.
#
# Usage: setup-plugin.sh <filesDir> <homeDir>
set -eu

FILES="$1"                  # .../files
HOME_DIR="$2"               # .../files/home
PROFILE="$HOME_DIR/.dsh/profiles/web"
DEST="$PROFILE/node_modules/dsh-adb"
SRC="$FILES/dsh-adb"

[ -d "$SRC" ] || { echo "setup-plugin: missing $SRC" >&2; exit 1; }

# The profile directory only exists after dsh's first boot; the boot code
# creates it via its own defaults, so tolerate its absence and let a later
# launch pick the plugin up.
mkdir -p "$PROFILE/node_modules"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"
chmod -R u+rwX "$DEST"

# Register the bundle idempotently. A hand-rolled JSON edit keeps this to one
# script with no node process; the shape is a fixed list of strings.
PKG="$PROFILE/package.json"
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
        "@deepseek-ai/dsh-web-app",
        "dsh-adb"
      ],
      "patchReload": "live"
    }
  }
}
JSON
elif ! grep -q '"dsh-adb"' "$PKG"; then
	# Insert the id after the last existing bundle entry. Anchored on the
	# literal last line of the array: Android's toybox sed has no \s, so the
	# pattern spells out the leading spaces.
	sed -i 's|^\( *\)"@deepseek-ai/dsh-web-app"[[:space:]]*$|\1"@deepseek-ai/dsh-web-app",\n\1"dsh-adb"|' "$PKG"
	if ! grep -q '"dsh-adb"' "$PKG"; then
		# Fall back to appending after whichever bundle line is last, so the
		# script still works if the upstream bundle list changes.
		sed -i 's|^\( *\)\("dsh-[a-z-]*"\)[[:space:]]*$|\1\2,\n\1"dsh-adb"|' "$PKG"
	fi
	if ! grep -q '"dsh-adb"' "$PKG"; then
		echo "setup-plugin: could not register dsh-adb in $PKG" >&2
		exit 1
	fi
fi

echo "setup-plugin: dsh-adb installed"
