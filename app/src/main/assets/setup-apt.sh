#!/system/bin/sh
# Make apt/dpkg in the embedded prefix usable under their standard names.
#
# The prefix ships apt and dpkg as ELF binaries whose compiled-in paths point at
# the Termux prefix this app cannot read. They therefore only work when
# LD_LIBRARY_PATH, APT_CONFIG and DPKG_ADMINDIR are set — which is what the
# *-dsh wrappers did, at the cost of non-standard names.
#
# Here each real binary is renamed to <name>.real and a dispatcher takes its
# place, so `apt-get install`, `apt-cache show` and `dpkg -l` behave normally.
# Idempotent, and a re-run refreshes the dispatcher so fixes in it take effect.
#
# Usage: setup-apt.sh <filesDir>
set -eu

FILES="$1"                  # .../files
PREFIX="$FILES/usr"
BIN="$PREFIX/bin"
SRC="$FILES/std-bin"        # staged by the APK

[ -d "$BIN" ] || { echo "setup-apt: missing $BIN" >&2; exit 1; }

# Names that must resolve to the dispatcher. dpkg's whole family routes through
# it because the wrapper also relocates what a transaction installed.
NAMES="apt apt-get apt-cache apt-config apt-mark apt-key \
       dpkg dpkg-deb dpkg-query dpkg-divert dpkg-split dpkg-trigger"

for name in $NAMES; do
	target="$BIN/$name"
	real="$BIN/$name.real"

	# First run: keep the shipped binary beside the dispatcher as <name>.real.
	if [ -f "$target" ] && [ ! -f "$real" ]; then
		mv -f "$target" "$real"
	fi
	[ -f "$real" ] || { echo "setup-apt: no $name to wrap" >&2; continue; }

	# Always (re)install the dispatcher. It used to skip when one was already
	# present, which meant a fix to the wrapper never reached an install that had
	# run setup once — the dpkg --root fix sat in the APK while the device kept
	# running the old dispatcher straight through a full re-extraction.
	cp -f "$SRC/apt-wrapper.sh" "$target"
	chmod 755 "$target" "$real"
done

# pkg — the familiar front end.
if [ -f "$SRC/pkg" ]; then
	cp -f "$SRC/pkg" "$BIN/pkg"
	chmod 755 "$BIN/pkg"
fi

# The prefix ships with Termux paths baked into ELF RUNPATHs, script shebangs
# and python's sysconfig; one sweep at setup makes everything usable before the
# first package is ever installed.
if [ -x "$PREFIX/var/lib/dsh-apt/bin/relocate-all" ]; then
	"$PREFIX/var/lib/dsh-apt/bin/relocate-all"
fi

count=$(ls "$BIN"/*.real 2>/dev/null | wc -l)
echo "setup-apt: $count binaries wrapped, pkg installed"
