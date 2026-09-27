# Building the APK

Everything needed is in this tree, including the ~512 MB of assets that make the
app self-contained (a node runtime, a sh/bash/rg closure, and a Termux prefix
with apt, dpkg, python and coreutils).

## Requirements

| | |
|---|---|
| JDK | 21 (17 should also work; `compileOptions` targets 17) |
| Android SDK | platform **35**, build-tools matching it |
| Gradle | 8.13 (AGP 8.9.1) |
| Disk | ~2 GB free — the assets are copied into `app/build/` during a build |

This project was built on Termux/aarch64 with:

```sh
export JAVA_HOME=$PREFIX/lib/jvm/java-21-openjdk
export ANDROID_HOME=$HOME/android-sdk
gradle assembleRelease
```

## Point the build at your SDK

`local.properties`:

```properties
sdk.dir=/path/to/android-sdk
```

## Signing

`app/build.gradle` reads the keystore from the project root and the passwords
from Gradle properties:

```properties
# gradle.properties
RELEASE_STORE_PASSWORD=...
RELEASE_KEY_ALIAS=dsh
RELEASE_KEY_PASSWORD=...
```

Put `release.keystore` next to `build.gradle`. **It is deliberately not in this
archive** — get it from `dsh-keystore.zip`, or generate your own with `keytool`;
but note that Android only accepts an update signed by the same key, so an
existing install cannot be upgraded by a differently-signed APK.

## The ABI marker

`app/src/main/jniLibs/arm64-v8a/libdshabi.so` is a 3.8 KB stub that nothing links
against or loads. It exists so the APK declares `native-code: 'arm64-v8a'`.

Every binary this app ships — the node runtime, bash, and the whole Termux
prefix — is an aarch64 shared object executed from the app's private directory.
Without anything under `lib/`, the APK carries **no** ABI declaration, so a
32-bit or x86 device could install all 160 MB of it and only discover the
mismatch by failing to start. With the marker, the installer filters it out.

Source: `tools/abi-marker/libdshabi.c`. Rebuild with:

```sh
clang -shared -fPIC -O2 -s --target=aarch64-linux-android30 \
  -o app/src/main/jniLibs/arm64-v8a/libdshabi.so tools/abi-marker/libdshabi.c
```

Keep the `.so` committed — regenerating it needs an NDK, and it is not built by
Gradle.

## Debug and release variants

Both exist; they are the Gradle defaults, with no flavour split.

| | `assembleDebug` | `assembleRelease` |
|---|---|---|
| Output | `app/build/outputs/apk/debug/app-debug.apk` | `app/build/outputs/apk/release/app-release.apk` |
| Signing | the auto-generated `~/.android/debug.keystore` | `release.keystore` (see Signing) |
| `android:debuggable` | true, so `adb run-as com.dsh.launcher` works | false |
| Shrinking | none | none (`minifyEnabled false`) |

Two consequences worth knowing:

- **The applicationId is the same in both** (`com.dsh.launcher`) while the signing
  keys differ, so installing one over the other fails with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Uninstall first, or add an
  `applicationIdSuffix ".debug"` to the debug build type if you want them side by
  side.
- **Only the release build can be updated by a later release build.** The debug
  keystore is machine-local, so a debug APK built elsewhere cannot update yours.

`run-as` being unavailable on a release install is why debugging a shipped build
on a device without root cannot inspect the app's private directory.

## Build


```sh
gradle assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

A clean build takes a few minutes; most of it is aapt2 compressing the assets.
The result is ~168 MB.

## Installing

```sh
adb install -r app/build/outputs/apk/release/app-release.apk
# MIUI/EMUI block shell installs — install as root instead:
adb push app-release.apk /data/local/tmp/d.apk
adb shell su -c 'pm install -r /data/local/tmp/d.apk'
```

First launch unpacks 512 MB into the app's private directory and runs the setup
scripts; expect **60–90 s** on a mid-range phone before the UI appears. The app
holds the screen on while that runs, and the copy is resumable, so a
backgrounded app finishes on return rather than starting over.

If a change touches anything under `assets/usr/`, bump the marker in
`MainActivity` (`extracted-vN`) — otherwise an existing install keeps its
already-extracted copy and never sees the change.

## What is where

```
app/src/main/assets/
  runtime/          node + its .so closure, bash, rg, dsh-termux
  usr/              Termux prefix, regular files only
  usr-links.txt     the 1010 symlinks aapt2 cannot carry
  usr-dirs.txt      the 344 directories, because aapt2 drops empty ones
  std-bin/          apt/dpkg dispatcher + the `pkg` front end
  dsh-adb/          the android_* device-control plugin
  terminal.js       the in-app terminal overlay
  setup-*.sh        first-launch fixups
app/src/main/java/com/dsh/launcher/MainActivity.java
                    WebView shell: boot, extract, terminal bridge, keyboard
patches/            front-end UI patch (see patches/README.md)
tools/closure-audit.sh
                    shared-library + asset sanity check; run it after changing
                    anything under assets/
```

`README.md` explains the design and the Android-specific traps (targetSdk 28 for
`exec()`, the aapt2 asset rules, `OPENSSL_CONF`, dpkg's seccomp'd `chroot`,
bionic's `dlopen` symbol scoping, and the relocation pipeline).
