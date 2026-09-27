#!/system/bin/sh
# Post-extraction setup for the baked-in Termux prefix (files/usr).
#
# Assets cannot carry symlinks, so the APK ships three things instead:
#   usr/            regular files only
#   usr-links.txt   "<relative path>\t<target>" for every symlink the prefix needs
#   usr-dirs.txt    every directory, because aapt2 drops the empty ones
#   this script     recreates both plus the symlink farms the prefix depends on
#
# Usage: setup-prefix.sh <filesDir> <dataDir>
set -eu

FILES="$1"                  # .../files
DATA="$2"                   # .../com.dsh.launcher
PREFIX="$FILES/usr"
MANIFEST="$FILES/usr-links.txt"
DIRS="$FILES/usr-dirs.txt"

[ -d "$PREFIX" ] || { echo "setup-prefix: missing $PREFIX" >&2; exit 1; }

# 0. Recreate every directory the prefix needs. aapt2 silently omits empty
#    directories from the APK, so ~21 of them never reach the device — among
#    them ones apt and dpkg cannot run without: etc/apt/apt.conf.d,
#    lib/apt/planners, lib/apt/solvers, var/cache/apt/archives/partial and
#    var/lib/dpkg/updates.
if [ -f "$DIRS" ]; then
	ensured=0
	while read -r d; do
		[ -n "$d" ] || continue
		mkdir -p "$PREFIX/$d"
		ensured=$((ensured + 1))
	done < "$DIRS"
	echo "setup-prefix: $ensured directories ensured"
fi

# 1. The dpk farm: '/data/data/com.dsh.launcher/dpk' is the 31-character
#    equal-length stand-in every relocated ELF has baked into its RUNPATH
#    (Termux's '/data/data/com.termux/files/usr' is also 31). Symlinks map it
#    back onto the real prefix.
DPK="$DATA/dpk"
mkdir -p "$DPK/tmp"
for d in bin etc lib var; do ln -sfn "$PREFIX/$d" "$DPK/$d"; done

# 2. The dpkg --root shadow tree: .deb payloads are rooted at
#    ./data/data/com.termux/files/usr (original bootstrap) or
#    ./data/user/0/com.dsh.launcher/files/usr (relocated), so both paths have to
#    resolve back to this prefix or dpkg would unpack into a phantom tree.
R="$FILES/.termux-root"
mkdir -p "$R/tmp" "$R/data/data/com.termux/files" \
         "$R/data/user/0/com.dsh.launcher/files"
for d in bin etc lib var; do ln -sfn "$PREFIX/$d" "$R/$d"; done
ln -sfn "$DATA"   "$R/data/data/com.dsh.launcher"
ln -sfn "$PREFIX" "$R/data/data/com.termux/files/usr"
ln -sfn "$PREFIX" "$R/data/user/0/com.dsh.launcher/files/usr"

# 3. Every symlink inside the prefix, straight from the manifest.
#    ln -sfn so a re-run converges instead of failing on existing links.
count=0
while IFS="$(printf '\t')" read -r path target; do
	[ -n "$path" ] || continue
	case "$path" in \#*) continue ;; esac
	dir="${path%/*}"
	if [ "$dir" != "$path" ]; then mkdir -p "$PREFIX/$dir"; fi
	ln -sfn "$target" "$PREFIX/$path"
	count=$((count + 1))
done < "$MANIFEST"
echo "setup-prefix: $count links restored"
