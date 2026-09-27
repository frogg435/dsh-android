#!/system/bin/sh
# Standard-shaped apt/dpkg entry point for the relocated Termux prefix.
#
# Installed as every apt*/dpkg* name in bin/, with the real ELF binaries kept
# alongside as <name>.real. The reason is that the compiled-in paths all point
# at the Termux prefix, which this app cannot read, so each invocation needs:
#
#   LD_LIBRARY_PATH  the prefix's own lib dir (RPATH points at com.termux)
#   PATH             dpkg shells out to tar/gzip/xz; Android's toybox tar
#                    rejects the --warning=no-timestamp flag dpkg passes
#   APT_CONFIG       so apt reads the relocated apt.conf before its defaults
#   DPKG_ADMINDIR    dpkg's database location
#
# Dispatch is by basename so `apt-cache show` runs apt-cache, not apt-get.
set -eu

PREFIX="${DSH_PREFIX:-/data/user/0/com.dsh.launcher/files/usr}"
RUNTIME="${DSH_RUNTIME:-/data/user/0/com.dsh.launcher/files/runtime}"

export LD_LIBRARY_PATH="$PREFIX/lib:$RUNTIME/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PATH="$PREFIX/bin:/system/bin:$RUNTIME/bin"
export APT_CONFIG="$PREFIX/etc/apt/apt.conf"
export DPKG_ADMINDIR="$PREFIX/var/lib/dpkg"
export HOME="${HOME:-$PREFIX/../home}"

name="$(basename "$0")"
real="$PREFIX/bin/$name.real"

[ -x "$real" ] || { echo "$name: missing $real" >&2; exit 127; }

case "$name" in
	apt|apt-get)
		# -c pins the relocated config; the binary's compiled-in default is
		# the unreadable Termux path.
		exec "$real" -c "$APT_CONFIG" "$@"
		;;
	dpkg)
		# Every dpkg invocation goes through the wrapper that rewrites the
		# build-time prefix inside maintainer scripts and .deb payloads, then
		# relocates what the transaction installed.
		#
		# The --root options come from apt.conf's DPkg::Options when apt drives
		# dpkg, but a direct `dpkg -i` gets them from nobody — and without them
		# the payload paths (./data/data/com.termux/files/usr/...) are taken as
		# absolute, so dpkg tries to unpack into / and dies with EACCES.
		exec "$PREFIX/var/lib/dsh-apt/bin/dpkg-wrapper" \
			--root="$PREFIX/../.termux-root" \
			--force-script-chrootless --force-confold "$@"
		;;
	*)
		exec "$real" "$@"
		;;
esac
