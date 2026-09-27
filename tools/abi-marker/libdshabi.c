/*
 * ABI marker for the DSH Android launcher.
 *
 * Nothing links against or loads this library. It exists so the APK declares
 * `native-code: 'arm64-v8a'` in its manifest: every binary this app ships —
 * the node runtime, bash, and the whole Termux prefix — is an aarch64 shared
 * object executed from the app's private directory. Without a lib/ entry the
 * APK carries no ABI declaration, so a 32-bit or x86 device could install all
 * 160 MB of it and only discover the mismatch by failing to start.
 *
 * Keep it a real aarch64 shared object; that is the whole point.
 */
int dsh_abi_is_arm64(void) { return 1; }
