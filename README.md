# dsh-apk — DeepSeek Harness in a self-contained Android APK

Runs DSH inside a WebView with **every runtime baked into the APK**: no Termux,
no root, no network install. First launch unpacks ~487 MB into the app's private
directory and then forks the bundled node.

## Requirements

- **Android 11+ (API 30), arm64.** The bundled `node`, `bash` and every binary in
  the prefix are aarch64 shared objects, so 32-bit and x86 devices cannot run it
  even though the APK will install on them.
- **~1.5 GB free** before the first launch; a C/C++ toolchain adds ~680 MB.
- No root. No Termux. No external files.

## What's inside

| Asset | Role |
|---|---|
| `runtime/bin/node`, `runtime/lib/*.so` | Node 26 for aarch64 plus its transitive shared-library closure |
| `runtime/bin/bash`, `runtime/bin/rg` | Android ships neither; DSH's `bash` tool hardcodes `bash -c` and its file search falls back to `rg` on `PATH` |
| `usr/` | A relocated Termux prefix (~2320 files): apt, dpkg, python 3.14, coreutils, bash, openssl… |
| `usr-links.txt` | The 1009 symlinks the prefix needs — APK assets cannot carry symlinks, so they are recreated at first launch |
| `setup-prefix.sh` | Rebuilds those symlinks plus the two symlink farms below |
| `dsh-adb/` + `setup-plugin.sh` | The `android_*` device-control plugin, installed into the dsh profile |

## The two shim trees

The prefix was built for `/data/data/com.termux/files/usr`, another app's private
directory that is unreadable here. Two things make it work in place:

**`dpk/`** — every relocated ELF has that old path rewritten in its `DT_RUNPATH`.
The replacement, `/data/data/com.dsh.launcher/dpk`, is *exactly 31 bytes* like the
original, so the substitution is length-preserving and happens directly inside
`.dynstr` with no ELF restructuring. `dpk/{bin,lib,etc,var}` are symlinks back
into the real prefix.

**`.termux-root/`** — `.deb` payloads are rooted at the build-time path, so dpkg
installs through a shadow tree that maps `./data/data/com.termux/files/usr` (and
the relocated equivalent) back onto the prefix. Only needed because dpkg always
runs with `--root`.

## Four bugs worth knowing about

1. **`targetSdk 28`, not 35.** Android 10+ refuses to `exec()` anything in an
   app's writable home directory when `targetSdk >= 29` (`EACCES`, error 13).
   Termux ships 28 for the same reason; `lint` must be told to stop complaining.
2. **`aapt2` drops dotfiles.** Its default `ignoreAssetsPattern` silently deleted
   70 files, including `pi-ai/dist/providers/data/.manifest.json`, which the
   plugin loader needs. Fixed by overriding the pattern.
3. **`OPENSSL_CONF=/dev/null`.** The bundled node's `OPENSSLDIR` is compiled to
   the Termux prefix, which this app cannot read — node dies at startup with
   `BIO_new_file: Permission denied`. Every launcher that runs it needs the
   override, including the relocation helpers in `usr/var/lib/dsh-apt/bin/`.
4. **dpkg's `chroot` is killed by Android seccomp.** Maintainer scripts die with
   `SIGSYS`; `--force-script-chrootless` is mandatory.

## Installing packages

```sh
apt-get-dsh install <pkg>   # single package, fast
dsh-pkg install <pkg>       # reinstalls the whole dependency closure
```

Use `dsh-pkg` when dpkg claims a package is installed but its files are missing:
the inherited database has ~120 entries of which only ~20 ever had files
extracted. The dpkg wrapper pipes the transaction's changed files (by mtime) to
the relocation helpers, so a normal install is one second rather than a
full-prefix sweep of 5800 files per package.

## Motion

The overlay ships two animations and scales both by Android's animator duration
scale (Developer options), read natively via `ANIMATOR_DURATION_SCALE` and pushed
to the page as `window.__dshAnimScale` — 1 is normal, 0.5 halves, 0 disables.
`animMs()` returns 0 below 8ms, so "animations off" really is instant.

- **Terminal panel.** Slides 14px up and fades in. It stays mounted and animates
  only `transform`/`opacity`, because the keyboard handler rewrites `bottom` and
  `height` on every tick and transitioning those would make it lurch.
- **Sidebar.** The shell is a CSS grid whose column widths the app writes inline
  with `transition: grid-template-columns .3s` declared — but the width jumps in a
  single frame (measured 56 → 280 at t=0ms), so its own transition never runs.
  Writing intermediate grid values from a rAF loop did nothing either: the
  property was set and read straight back unchanged, so React re-commits it.
  Instead the sidebar and the content column are animated with the Web Animations
  API on `transform`, which React does not write — the layout still snaps
  underneath, but the motion reads correctly and nothing can overwrite it.

A 50ms poll detects the change, because the frame element is remounted on state
changes and an observer attached to one node stops firing.

## C and C++ toolchains

`pkg install clang llvm lld make ndk-sysroot libc++ libcompiler-rt` gives a
working toolchain: clang 21.1.8 compiles C++17 with the STL, `make` runs, and
the result executes. Two things were broken first, and both are now fixed by
`relocate-all`:

- **Python C extensions could not load.** Termux's `python3` is a 4 KB launcher
  that NEEDs `libpython3.14.so`, and CPython on Linux never links extensions
  against libpython — it relies on the interpreter exporting `Py*` symbols,
  which bionic does *not* expose to `dlopen`. Every pip build therefore died
  with `cannot locate symbol "PyModule_Create2"`. `fix-python-ldshared` appends
  `-lpython3.14` to `LDSHARED` in the sysconfig data, and reruns after a python
  upgrade replaces that file.
- **Freshly installed files were never relocated.** Change detection used
  mtimes, but dpkg preserves the mtimes stored inside the `.deb` (one clang
  wrapper kept `mtime=2026-07-01` months after install, with `ctime` at
  unpack). Nothing matched, so new binaries kept Termux shebangs and RUNPATHs —
  `aarch64-linux-android-clang` stayed a 201-byte script pointing at
  `/data/data/com.termux/...` and returned EACCES whenever pip ran it as
  `LDSHARED`. Now a **full sweep runs once per apt transaction** via
  `DPkg::Post-Invoke`; a direct `dpkg -i` still sweeps inline. A sweep is ~2.7 s
  over ~13000 files, which is why it is not run per package.

Still not possible:

- **Static linking.** `-static` fails because ndk-sysroot ships no
  `crtbegin_static.o`, `libc.a` or `libm.a`.
- **Portable binaries.** Output links against the prefix's `libc++_shared.so`,
  so it needs that library at runtime.
- **Baking the toolchain in.** `libLLVM.so` alone is 128 MB and the whole
  toolchain takes the prefix from 117 MB to 797 MB — install it on demand
  instead.

## Built-in terminal

The app injects `assets/terminal.js` into the WebView after each page load: a
`>_` button pinned above the sidebar's Settings seat, opening a panel that runs
shell commands with the same environment the dsh server gets. That means the
whole bundled prefix is available by hand — bash, coreutils, apt, dpkg, python,
curl — without spending conversation context on it.

It is deliberately native rather than a dsh client plugin (no front-end build
toolchain needed, no dsh internals patched). Commands stream back line by line
through a `@JavascriptInterface` bridge and run detached from the agent.

Three things had to be measured rather than assumed, because each was wrong on
the first try and a screenshot showed it:

- **The Settings seat has no label.** Probed: `aria='' txt=''`, only the
  CSS-module class `VOzbGW_trigger` identifies it. Anchoring on "bottom-most
  control" made the button jump whenever the composer's buttons appeared.
- **Landscape leaves almost nothing.** A 350 px-tall viewport minus a 293 px
  keyboard leaves 77 px. The panel collapses to the prompt line alone while
  typing; the header and output return when the keyboard closes.
- **The keyboard must not be compensated twice.** `adjustResize` really does
  shrink the layout viewport (350 → 77), so adding the native
  `getWindowVisibleDisplayFrame` offset on top pushed the panel 255 px above the
  screen. The native measurement is now only used when the viewport does *not*
  shrink.

`files/terminal.js` overrides the packaged copy when present, so a rooted device
can iterate on the overlay without rebuilding the APK.

Also note: `adb shell input tap` takes **physical** pixels while
`getBoundingClientRect()` returns **CSS** pixels — on a 2.625 dpr device the two
differ by that factor, which makes blind tapping silently miss.

## Narrow-viewport UI patch

`patches/` carries the only front-end change made here: two CSS blocks that fix
the layout on phone-width viewports. The upstream packages ship compiled, so the
change is kept as a patch rather than a fork.

- **Sidebar becomes an overlay.** Below 1024px the sidebar used to occupy a grid
  column and squeeze the conversation column until its text was cut off at the
  right edge (~425px CSS viewport, measured). It now floats above the content
  with a `pointer-events:none` mask so taps still reach the page.
- **Settings becomes a full-screen page.** Below 700px the settings dialog was
  an 800px centred panel with 32px corners, leaving the phone viewport mostly
  empty. It now fills the screen with its navigation as a horizontal tab strip.

`patches/README.md` explains both blocks and how to re-apply them after a dsh
upgrade. Verified: applying `patches/narrow-viewport.patch` to the pristine
`0.1.2-rc.1` packages reproduces the shipped files byte-for-byte.

## Assembling the assets

This archive carries the glue, not the bulk: `assets/runtime/` (~400 MB) and
`assets/usr/` (~120 MB, ~4400 files) are too large to ship here and are
rebuildable. Everything else builds straight from the archive.

### 1. `assets/runtime/` — node, bash, rg and their shared-library closure

Copy the binaries out of a Termux install and add every library they need,
transitively:

```sh
cp $PREFIX/bin/node assets/runtime/bin/
cp $PREFIX/bin/bash assets/runtime/bin/     # DSH hardcodes `bash -c`
cp $PREFIX/bin/rg   assets/runtime/bin/     # the fs-search fallback scans PATH
```

Then walk `readelf -d <file> | grep NEEDED` to a fixed point, copying every
library that resolves under `$PREFIX/lib` into `assets/runtime/lib/`. Skipping
the transitive step fails at load time, not at build time — `libicudata.so.78`
was the one that bit here. **Do not copy libraries that also exist in
`assets/usr/lib/`**: `LD_LIBRARY_PATH` lists `runtime/lib` first so node never
picks up the prefix's `libssl`/`libcrypto`/`libz`.

### 2. `assets/runtime/dsh-termux/` — the harness itself

A normal install tree (`lib/`, `node_modules/`, `package.json`), for example
from `npm i dsh-termux` or `npm i @deepseek-ai/dsh`. It runs as
`node --expose-internals <dir>/lib/bin.js web`.

### 3. `assets/usr/` — the Termux prefix

Best produced on a device where the prefix already works: snapshot it, then
split the tree into files plus manifests, because **an APK cannot carry
symlinks and aapt2 silently drops empty directories**.

```sh
# on the device
tar --exclude='*.cursed' -cf /sdcard/usr.tar usr

# on the build host, after unpacking
A=app/src/main/assets
find usr -type f -exec cp -a {} $A/usr/{} \;            # regular files only
find usr -type l | while read -r l; do                   # symlinks -> manifest
  t=$(readlink "$l")
  t=${t//\/data\/data\/com.termux\/files\/usr//data\/data\/com.dsh.launcher\/dpk}
  printf '%s\t%s\n' "${l#./}" "$t"
done | sort > $A/usr-links.txt
find usr -type d | sed 's|^\./||' | sort > $A/usr-dirs.txt
```

The rewrite in step 2 is not optional: a prefix built by Termux has absolute
symlinks into `/data/data/com.termux/...`, which is another app's private
directory on a device without Termux. `setup-prefix.sh` recreates all of them
at first launch.

Run `tools/closure-audit.sh` afterwards — it checks the shared-library closure
of every ELF and flags the `x` / `x.gz` pairs that make aapt2 fail with
"Duplicate resources".

### 4. `assets/dsh-adb/` — the device-control plugin

Copy the package directory (`lib/`, `package.json`, `cordis.patch.yml`).
`setup-plugin.sh` installs it into the profile.

## Building

```sh
export JAVA_HOME=$PREFIX/lib/jvm/java-21-openjdk
export ANDROID_HOME=$HOME/android-sdk
gradle assembleRelease
```

Signing reads `RELEASE_STORE_PASSWORD` / `RELEASE_KEY_ALIAS` /
`RELEASE_KEY_PASSWORD` from gradle properties. **The keystore is not in this
archive** — generate your own before building a release.
