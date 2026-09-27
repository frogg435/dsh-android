package com.dsh.launcher;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Self-contained WebView shell around an embedded `dsh web`.
 *
 * The runtime (node + dsh-termux + native deps) ships in assets and is
 * extracted once into the app's private files dir on first launch. We then
 * fork node directly — no Termux, no RUN_COMMAND, no sync.sh. The auth URL
 * carries a one-shot token that dsh prints to stdout; we capture it and load
 * the WebView at that URL, so the HMAC cookie never leaves the server.
 */
public class MainActivity extends Activity {
	// Own port: 3080 is Termux's dsh territory; never fight it for the binding.
	static final int PORT = 3090;
	static final String TARGET = "http://127.0.0.1:" + PORT + "/";
	static final String PREFS = "dsh";
	static final String KEY_TOKEN = "token";

	private static final int REQ_FILE_CHOOSER = 2;
	private static final Pattern TOKEN_URL = Pattern.compile("http://127\\.0\\.0\\.1:" + PORT + "/\\?token=[A-Za-z0-9_\\-]+");

	private WebView web;
	private ProgressBar spinner;
	private TextView status;
	private ValueCallback<Uri[]> fileChooser;
	private boolean pageLoaded;
	private boolean ready;

	private Process node;
	private Thread boot;
	/** Last keyboard height pushed to the page, in CSS px (0 = hidden). */
	private int lastKeyboardCss = -1;
	/** True while the boot thread runs; guards against re-entry from onResume. */
	private volatile boolean booting;
	private volatile boolean bootDone;

	@Override protected void onCreate(Bundle saved) {
		super.onCreate(saved);
		CookieManager.getInstance().setAcceptCookie(true);

		spinner = new ProgressBar(this);
		status = new TextView(this);
		status.setGravity(Gravity.CENTER);
		status.setPadding(48, 0, 48, 0);
		status.setTextSize(15);

		FrameLayout root = new FrameLayout(this);
		FrameLayout.LayoutParams center = new FrameLayout.LayoutParams(
			FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
		root.addView(spinner, center);

		FrameLayout.LayoutParams fill = new FrameLayout.LayoutParams(
			FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
		root.addView(status, fill);
		setContentView(root);

		boot();
	}

	@Override protected void onDestroy() {
		super.onDestroy();
		// Kill node on the way out so the port frees for the next launch.
		if (node != null) { node.destroy(); node = null; }
	}

	// --- Embedded runtime boot ---------------------------------------------

	/** Extract assets once, then fork node and capture the auth URL. */
	private void boot() {
		synchronized (this) {
			if (booting || bootDone) return;
			booting = true;
		}
		showStatus("Preparing runtime…");
		// First launch copies 487MB and runs the setup scripts, which takes
		// minutes. Android's cgroup freezer stops a backgrounded app mid-copy
		// (verified: the setup script sat in do_freezer_trap until the app was
		// foregrounded again), so hold the screen on while that runs. The copy
		// itself is resumable, and onResume() re-enters boot() if it died.
		getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
		boot = new Thread(() -> {
			try {
				android.util.Log.i("DSH", "boot: extract start");
				File runtime = extractRuntime();
				installAgentNote();
				android.util.Log.i("DSH", "boot: extract done -> " + runtime);
				String url = launchDsh(runtime);
				android.util.Log.i("DSH", "boot: launch ok -> " + url);
				runOnUiThread(() -> {
					ready = true;
					requestStoragePermissions();
					if (!pageLoaded) load(url);
				});
				bootDone = true;
			} catch (Throwable e) {
				android.util.Log.e("DSH", "boot failed", e);
				String msg = String.valueOf(e);
				runOnUiThread(() -> showStatus("Boot failed:\n" + msg));
			} finally {
				// Either the UI is up or the failure is on screen; the screen no
				// longer needs to be pinned. booting clears so a frozen-then-
				// killed attempt can be retried from onResume.
				booting = false;
				runOnUiThread(() -> getWindow().clearFlags(
						android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
			}
		}, "dsh-boot");
		boot.start();
	}

	/** A frozen or killed boot must restart when the user comes back. */
	@Override
	protected void onResume() {
		injectAnimScale();          // the scale can change while we are backgrounded
		super.onResume();
		if (!bootDone && !booting) boot();
	}

	/**
	 * Unpack assets/runtime into filesDir/runtime once. A marker file keeps
	 * repeat launches from re-copying 450MB every time.
	 *
	 * Since v3 the same pass also unpacks the baked-in Termux prefix
	 * (assets/usr) and restores its symlinks — assets cannot carry them, so
	 * usr-links.txt plus setup-prefix.sh recreate all 1009 after the copy.
	 */
	private File extractRuntime() throws IOException {
		File out = new File(getFilesDir(), "runtime");
		// v6: usr-dirs.txt restores the empty directories aapt2 drops from
		// assets (apt.conf.d, lib/apt/planners, var/lib/dpkg/updates…), without
		// which dpkg and apt fail on a fresh install.
		// v7: dpkg-wrapper calls dpkg.real — calling $PREFIX/bin/dpkg recursed
		// into the standard-name dispatcher forever (373 processes).
		// v8: prefix re-snapshotted with curl, python-pip and their shared
		// libraries, which the earlier snapshot predated.
		// v12: dsh-balance joins dsh-adb as a bundled plugin, and
		// setup-plugin.sh installs a list rather than one hardcoded package.
		// v11: setup-apt.sh refreshes the dispatcher on every run. It used to
		// skip when one already existed, so the dpkg --root fix stayed in the
		// APK while an already-set-up install kept the old dispatcher.
		// v10: the dpkg dispatcher passes --root/--force-script-chrootless
		// itself, so a direct `dpkg -i` installs into the prefix instead of
		// trying to unpack into / (apt got those from apt.conf; a bare dpkg
		// call got them from nobody).
		// v9: relocation now sweeps the whole prefix once per apt transaction
		// (the mtime filter matched nothing, because dpkg preserves the mtimes
		// from the .deb), and python's LDSHARED gains -lpython3.14 so C
		// extension builds can actually load on bionic.
		File marker = new File(out, ".extracted-v12");
		if (marker.exists()) return out;

		// NOTE: must NOT touch Views from this worker thread.
		byte[] buf = new byte[64 * 1024];
		String[] roots = getAssets().list("runtime");
		if (roots == null) throw new IOException("no runtime assets");
		android.util.Log.i("DSH", "extract roots: " + java.util.Arrays.toString(roots));
		for (String name : roots) extractAssetDir("runtime/" + name, new File(out, name), buf);

		android.util.Log.i("DSH", "extract prefix start");
		extractAssetDir("usr", new File(getFilesDir(), "usr"), buf);
		extractAssetDir("usr-links.txt", new File(getFilesDir(), "usr-links.txt"), buf);
		// aapt2 omits empty directories from assets, so the prefix's full
		// directory list ships as a manifest beside the symlink one and
		// setup-prefix.sh recreates them.
		extractAssetDir("usr-dirs.txt", new File(getFilesDir(), "usr-dirs.txt"), buf);
		File setup = new File(getFilesDir(), "setup-prefix.sh");
		extractAssetDir("setup-prefix.sh", setup, buf);
		setup.setExecutable(true);
		linkPrefix(setup);

		// Standard-shaped apt/dpkg: a dispatcher is installed under each real
		// command name (apt-get, dpkg, apt-cache…), with the ELF binaries kept
		// as <name>.real. Replaces the old non-standard *-dsh wrappers.
		extractAssetDir("std-bin", new File(getFilesDir(), "std-bin"), buf);
		File aptSetup = new File(getFilesDir(), "setup-apt.sh");
		extractAssetDir("setup-apt.sh", aptSetup, buf);
		aptSetup.setExecutable(true);
		runSetupScript(aptSetup, getFilesDir().getAbsolutePath());

		// The android_* device-control plugin ships as assets too: it must be
		// in the profile's node_modules before dsh reads dsh.profile.bundles.
		File home = new File(getFilesDir(), "home");
		extractAssetDir("dsh-adb", new File(getFilesDir(), "dsh-adb"), buf);
		// dsh-balance reads the DeepSeek account balance through a same-origin
		// route and renders it in the sidebar footer; the API key stays on the
		// host and is resolved through the credentials service.
		extractAssetDir("dsh-balance", new File(getFilesDir(), "dsh-balance"), buf);
		File plug = new File(getFilesDir(), "setup-plugin.sh");
		extractAssetDir("setup-plugin.sh", plug, buf);
		plug.setExecutable(true);
		installPlugin(plug, home);

		if (!marker.createNewFile() && !marker.exists()) throw new IOException("marker not written");
		android.util.Log.i("DSH", "extract complete");
		return out;
	}

	/**
	 * Recreate the prefix's symlink farms by running setup-prefix.sh with the
	 * already-extracted bundled bash (it needs no prefix of its own).
	 */
	private void linkPrefix(File setup) throws IOException {
		runSetupScript(setup, getFilesDir().getAbsolutePath(),
				getDataDir().getAbsolutePath());
	}

	/** Install the bundled dsh-adb plugin into the profile's node_modules. */
	private void installPlugin(File script, File home) throws IOException {
		runSetupScript(script, getFilesDir().getAbsolutePath(), home.getAbsolutePath());
	}

	/**
	 * Run one of the bundled setup scripts under the embedded bash and fail
	 * loudly with its output if it does not exit clean.
	 */
	private void runSetupScript(File script, String... args) throws IOException {
		List<String> cmd = new ArrayList<>();
		cmd.add(new File(getFilesDir(), "runtime/bin/bash").getAbsolutePath());
		cmd.add(script.getAbsolutePath());
		for (String a : args) cmd.add(a);
		ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
		pb.environment().put("PATH", "/system/bin");
		pb.environment().put("LD_LIBRARY_PATH", new File(getFilesDir(), "runtime/lib").getAbsolutePath());
		Process p = pb.start();
		StringBuilder log = new StringBuilder();
		try (java.io.BufferedReader r = new java.io.BufferedReader(
				new java.io.InputStreamReader(p.getInputStream()))) {
			String line;
			while ((line = r.readLine()) != null) log.append(line).append('\n');
		}
		int rc;
		try {
			rc = p.waitFor();
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new IOException(script.getName() + " interrupted");
		}
		android.util.Log.i("DSH", script.getName() + " rc=" + rc + " " + log);
		if (rc != 0) throw new IOException(script.getName() + " failed:\n" + log);
	}

	/** Recursively copy one asset directory into a file path. */
	private void extractAssetDir(String assetPath, File dest, byte[] buf) throws IOException {
		String[] children = getAssets().list(assetPath);
		if (children != null && children.length > 0) {
			dest.mkdirs();
			for (String child : children)
				extractAssetDir(assetPath + "/" + child, new File(dest, child), buf);
		} else {
			dest.getParentFile().mkdirs();
			// Resumable: the first run copies 487MB and takes minutes, long
			// enough for Android to freeze the app (or kill it) if the user
			// switches away. Re-running then starts over at file one, so skip
			// anything already the right size. openFd only works for stored
			// assets, hence the fallback to a plain copy.
			try (android.content.res.AssetFileDescriptor afd = getAssets().openFd(assetPath)) {
				if (dest.length() == afd.getLength()) {
					dest.setExecutable(true);
					return;
				}
			} catch (IOException notStored) {
				// compressed asset: fall through and re-copy
			}
			try (InputStream in = getAssets().open(assetPath);
			     OutputStream fos = new FileOutputStream(dest)) {
				int n;
				while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
			}
			// All files executable: bash/rg/spawn-helpers are exec'd, and mode
			// survives only if we set it here (assets lose permissions on copy).
			dest.setExecutable(true);
		}
	}

	/**
	 * Fork node at the embedded dsh web. LD_LIBRARY_PATH must point at the
	 * bundled .so closure: node's RUNPATH hardcodes Termux, and precedence
	 * lets LD_LIBRARY_PATH win.
	 */
	private String launchDsh(File runtime) throws IOException {
		// Only reuse an external server if we already hold a cached auth URL
		// from a previous launch — otherwise a foreign 401 would hang the shell.
		String cached = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TOKEN, null);
		if (isUp() && cached != null) return cached;

		File nodeBin = new File(runtime, "bin/node");
		File libDir = new File(runtime, "lib");
		File dsh = new File(runtime, "dsh-termux/lib/bin.js");
		File home = new File(getFilesDir(), "home");
		if (!home.exists()) home.mkdirs();
		new File(home, "tmp").mkdirs();   // spill plugin mkdtemp's here
		if (!nodeBin.exists()) throw new IOException("missing node: " + nodeBin);

		List<String> cmd = new ArrayList<>();
		cmd.add(nodeBin.getAbsolutePath());
		cmd.add("--expose-internals");
		cmd.add(dsh.getAbsolutePath());
		cmd.add("web");
		cmd.add("--port"); cmd.add(String.valueOf(PORT));
		cmd.add("--no-open");

		Map<String, String> env = childEnv();

		ProcessBuilder pb = new ProcessBuilder(cmd).directory(home).redirectErrorStream(true);
		pb.environment().putAll(env);
		showStatus("Starting dsh…");
		node = pb.start();

		// dsh prints the auth URL (with token) to stdout. readLine() blocks, so
		// bound the wait: if the token does not arrive in time we fall back to
		// plain TARGET rather than hang on "Starting dsh…" forever.
		String[] found = {null};
		StringBuilder log = new StringBuilder();
		Thread reader = new Thread(() -> {
			try (BufferedReader r = new BufferedReader(new InputStreamReader(node.getInputStream()))) {
				String line;
				while ((line = r.readLine()) != null) {
					Matcher m = TOKEN_URL.matcher(line);
					if (m.find()) { found[0] = m.group(); return; }
					if (log.length() < 4096) log.append(line).append('\n');
				}
			} catch (IOException ignored) {}
		}, "dsh-stdout");
		reader.setDaemon(true);
		reader.start();
		try { reader.join(60_000); } catch (InterruptedException ignored) {}

		if (found[0] != null) {
			getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_TOKEN, found[0]).apply();
			return found[0];
		}
		// Fallback: process may already have been up, or a tokenless accept.
		if (isUp()) return TARGET;
		throw new IOException("no token URL:\n" + log);
	}

	/** True when something answers on the local port. */
	private boolean isUp() {
		try (java.net.Socket s = new java.net.Socket()) {
			s.connect(new java.net.InetSocketAddress("127.0.0.1", PORT), 400);
			return true;
		} catch (IOException e) {
			return false;
		}
	}

	// --- WebView ------------------------------------------------------------

	@SuppressLint("SetJavaScriptEnabled")
	private void buildWeb() {
		if (web != null) return;
		web = new WebView(this);
		WebSettings s = web.getSettings();
		s.setJavaScriptEnabled(true);
		s.setDomStorageEnabled(true);
		s.setAllowFileAccess(true);
		s.setMediaPlaybackRequiresUserGesture(false);
		s.setCacheMode(WebSettings.LOAD_DEFAULT);

		web.setWebViewClient(new WebViewClient() {
			@Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
				return false;   // keep every in-app navigation inside the shell
			}
			@Override public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse resp) {
				if (req.isForMainFrame() && resp.getStatusCode() == 401) {
					pageLoaded = false;
					showStatus("Waiting for dsh…");
				}
			}
			@Override public void onPageFinished(WebView v, String url) {
				pageLoaded = true;
				hideStatus();
				// Re-injected per page load: the SPA can be reloaded by dsh
				// itself, and the overlay has to survive that.
				injectTerminal(v);
			}
		});

		// Only our own loopback server is ever loaded into this WebView, and the
		// interface is what the injected overlay calls. It runs with the app's
		// own uid, so it cannot do anything the app could not already do.
		web.addJavascriptInterface(new TermBridge(), "DSHTermNative");

		web.setWebChromeClient(new WebChromeClient() {
			@Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
				if (fileChooser != null) fileChooser.onReceiveValue(null);
				fileChooser = cb;
				Intent i = new Intent(Intent.ACTION_GET_CONTENT);
				i.addCategory(Intent.CATEGORY_OPENABLE);
				i.setType("*/*");
				i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
				try { startActivityForResult(i, REQ_FILE_CHOOSER); }
				catch (Exception e) { fileChooser = null; cb.onReceiveValue(null); }
				return true;
			}
		});

		FrameLayout root = (FrameLayout) findViewById(android.R.id.content);
		root.addView(web, 0, new FrameLayout.LayoutParams(
			FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

		// targetSdk 35 draws edge-to-edge, so the status bar sits on top of us.
		// Chromium ignores padding on the WebView itself, so pad the parent —
		// that offsets the whole child during layout instead. buildWeb() runs
		// after the first layout pass, so re-ask for insets.
		root.setOnApplyWindowInsetsListener((v, insets) -> {
			v.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
			return insets;
		});
		root.requestApplyInsets();
		watchKeyboard();
	}

	/**
	 * Environment every child process gets: the dsh server and the terminal
	 * overlay's commands must see the same toolchain.
	 */
	private Map<String, String> childEnv() {
		File prefix = new File(getFilesDir(), "usr");
		File runtime = new File(getFilesDir(), "runtime");
		File home = new File(getFilesDir(), "home");
		File libDir = new File(runtime, "lib");
		Map<String, String> env = new HashMap<>();
		// runtime libs come first on purpose: node must not load the prefix's
		// libssl/libcrypto/libz. The apt/dpkg wrappers prepend the prefix's own
		// lib dir for their child processes themselves.
		env.put("LD_LIBRARY_PATH", libDir.getAbsolutePath() + ":" + new File(prefix, "lib"));
		env.put("HOME", home.getAbsolutePath());
		// runtime/bin first (node, bash, rg), then the baked-in Termux prefix so
		// the installed toolchain (apt, dpkg, python, coreutils…) is on PATH.
		env.put("PATH", new File(runtime, "bin").getAbsolutePath() + ":"
				+ new File(prefix, "bin").getAbsolutePath() + ":/system/bin");
		// Termux's node binary falls back to $PREFIX/tmp (foreign, EACCES) for
		// os.tmpdir(); the spill plugin mkdtemp's there. Own it instead.
		env.put("TMPDIR", new File(home, "tmp").getAbsolutePath());
		// OpenSSL's default OPENSSLDIR is baked to the Termux prefix at compile
		// time; reading it from this app is EACCES. /dev/null = empty config.
		env.put("OPENSSL_CONF", "/dev/null");
		env.put("OPENSSL_MODULES", libDir.getAbsolutePath());
		env.put("TERM", "xterm-256color");
		return env;
	}

	/**
	 * Runs shell commands for the terminal overlay injected by assets/terminal.js.
	 *
	 * The overlay is deliberately native rather than a dsh client plugin: it
	 * needs no front-end build toolchain, and it reuses the exact environment
	 * the app already gives the dsh server, so the whole bundled prefix (bash,
	 * coreutils, apt, python, curl) is available without touching dsh internals.
	 *
	 * Commands run detached from the agent: output is streamed back to the page
	 * as it arrives and the exit code follows. Nothing here is exposed to the
	 * model — this is a human-facing escape hatch.
	 */
	private class TermBridge {
		private final Map<String, Process> live = new java.util.concurrent.ConcurrentHashMap<>();
		private final java.util.concurrent.atomic.AtomicInteger seq = new java.util.concurrent.atomic.AtomicInteger();

		@android.webkit.JavascriptInterface
		public String run(final String command) {
			final String id = "t" + seq.incrementAndGet();
			Thread t = new Thread(() -> {
				Process p = null;
				try {
					List<String> cmd = new ArrayList<>();
					cmd.add(new File(getFilesDir(), "runtime/bin/bash").getAbsolutePath());
					cmd.add("-c");
					cmd.add(command);
					ProcessBuilder pb = new ProcessBuilder(cmd)
							.directory(new File(getFilesDir(), "home"))
							.redirectErrorStream(true);
					pb.environment().putAll(childEnv());
					p = pb.start();
					live.put(id, p);
					// Stream as it arrives: a terminal that only prints at exit is
					// useless for anything long-running, and apt installs are.
					try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
						char[] buf = new char[1024];
						int n;
						while ((n = r.read(buf)) > 0) emit(id, new String(buf, 0, n));
					}
					int rc = p.waitFor();
					evalTerm("window.__dshTerm && window.__dshTerm.onExit("
							+ JSONObject.quote(id) + "," + rc + ")");
				} catch (Throwable e) {
					android.util.Log.e("DSH", "term run failed", e);
					evalTerm("window.__dshTerm && window.__dshTerm.onError("
							+ JSONObject.quote(id) + "," + JSONObject.quote(String.valueOf(e)) + ")");
				} finally {
					live.remove(id);
					if (p != null) p.destroy();
				}
			}, "dsh-term");
			t.setDaemon(true);
			t.start();
			return id;
		}

		@android.webkit.JavascriptInterface
		public void kill(String id) {
			Process p = live.remove(id);
			if (p != null) p.destroy();
		}
	}

	private void emit(final String id, final String text) {
		evalTerm("window.__dshTerm && window.__dshTerm.onData("
				+ JSONObject.quote(id) + "," + JSONObject.quote(text) + ")");
	}

	/** evaluateJavascript only runs on the UI thread. */
	private void evalTerm(final String js) {
		runOnUiThread(() -> {
			if (web != null) web.evaluateJavascript(js, null);
		});
	}

	/**
	 * Report how much of the window the soft keyboard covers, in CSS pixels.
	 *
	 * The page cannot work this out reliably: its layout viewport does not
	 * shrink here (adjustResize is set, but the WebView keeps reporting the full
	 * height) and visualViewport does not change either, so the terminal panel
	 * stayed pinned to the bottom and the keyboard covered its input row.
	 * getWindowVisibleDisplayFrame is authoritative whatever the input mode.
	 */
	private void watchKeyboard() {
		final View root = getWindow().getDecorView();
		final float density = getResources().getDisplayMetrics().density;
		root.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
			android.graphics.Rect visible = new android.graphics.Rect();
			root.getWindowVisibleDisplayFrame(visible);
			int coveredPx = root.getRootView().getHeight() - visible.bottom;
			if (coveredPx < 0) coveredPx = 0;
			// Ignore the small chrome (nav bar) that is never the keyboard.
			if (coveredPx < (int) (60 * density)) coveredPx = 0;
			int coveredCss = Math.round(coveredPx / density);
			if (coveredCss == lastKeyboardCss) return;
			lastKeyboardCss = coveredCss;
			android.util.Log.i("DSH", "keyboard covers " + coveredCss + " css px");
			evalTerm("window.__dshTermKb && window.__dshTermKb(" + coveredCss + ")");
		});
	}

	/**
	 * Ask for shared-storage access once, on the first launch.
	 *
	 * A targetSdk-28 app requests these the old way and Android 11+ answers with
	 * the legacy storage model, which is broad access over /sdcard — it is what
	 * lets the terminal and the agent touch photos, downloads and documents
	 * rather than only the app's private directory. Both permission sets are
	 * requested because the system ignores whichever does not apply to its
	 * version; denial is not fatal, the app just keeps its private sandbox.
	 */
	private void requestStoragePermissions() {
		if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
				== android.content.pm.PackageManager.PERMISSION_GRANTED) {
			return;
		}
		requestPermissions(new String[] {
				android.Manifest.permission.READ_EXTERNAL_STORAGE,
				android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
				"android.permission.READ_MEDIA_IMAGES",
				"android.permission.READ_MEDIA_VIDEO",
				"android.permission.READ_MEDIA_AUDIO"
		}, 1);
	}

	/**
	 * Drop the terminal-panel note where dsh's AGENTS loader will find it.
	 *
	 * @deepseek-ai/dsh-agent-instructions reads AGENTS.md / AGENTS.local.md from
	 * the workspace, so a note there is how the agent learns that the built-in
	 * terminal exists and that its transcript is readable — no plugin, and
	 * nothing for the agent to poll. `.local` is the machine-local slot, so a
	 * user's own AGENTS.md is untouched; and an existing file is never
	 * overwritten, so edits survive an app update.
	 */
	private void installAgentNote() {
		File note = new File(getFilesDir(), "home/AGENTS.local.md");
		if (note.exists()) return;
		try {
			File dir = note.getParentFile();
			if (dir != null) dir.mkdirs();
			try (InputStream in = getAssets().open("AGENTS.local.md");
				 OutputStream out = new java.io.FileOutputStream(note)) {
				byte[] buf = new byte[8192];
				int n;
				while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
			}
			android.util.Log.i("DSH", "agent note installed");
		} catch (IOException e) {
			android.util.Log.w("DSH", "agent note not installed", e);
		}
	}

	/**
	 * Publish the system animation speed to the page.
	 *
	 * Android's animator duration scale (Developer options) multiplies every
	 * animation: 0 disables them, 0.5 halves them, 2 doubles them. Chromium
	 * honours it for CSS transitions, but the sidebar's grid transition does not
	 * run in this WebView at all, so the overlay animates the sidebar itself and
	 * needs the same factor to stay consistent with the rest of the system.
	 */
	private void injectAnimScale() {
		float scale = 1f;
		try {
			scale = android.provider.Settings.Global.getFloat(getContentResolver(),
					android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
		} catch (Throwable t) {
			// Setting missing on some builds; 1x is the right default.
		}
		if (scale < 0) scale = 0;
		evalTerm("window.__dshAnimScale=" + scale);
	}

	/** Inject the terminal overlay (assets/terminal.js) into the loaded page. */
	private void injectTerminal(WebView v) {
		try {
			// filesDir/terminal.js wins when present: a rooted device (or a
			// debug build pushed over adb) can iterate on the overlay without
			// rebuilding the APK. Falls back to the packaged copy.
			File override = new File(getFilesDir(), "terminal.js");
			String js;
			if (override.isFile()) {
				byte[] raw = new byte[(int) override.length()];
				try (InputStream in = new java.io.FileInputStream(override)) {
					int off = 0, n;
					while (off < raw.length && (n = in.read(raw, off, raw.length - off)) > 0) off += n;
				}
				js = new String(raw, "UTF-8");
			} else {
				try (InputStream in = getAssets().open("terminal.js")) {
					java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
					byte[] buf = new byte[8192];
					int n;
					while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
					js = bos.toString("UTF-8");
				}
			}
			injectAnimScale();
			v.evaluateJavascript(js, null);
		} catch (IOException e) {
			android.util.Log.e("DSH", "terminal.js not injected", e);
		}
	}

	private void load(String url) {
		if (web == null) buildWeb();
		web.loadUrl(url);
	}

	@Override protected void onActivityResult(int req, int res, Intent data) {
		if (req != REQ_FILE_CHOOSER) { super.onActivityResult(req, res, data); return; }
		Uri[] out = null;
		if (res == RESULT_OK && data != null) {
			if (data.getClipData() != null) {
				out = new Uri[data.getClipData().getItemCount()];
				for (int k = 0; k < out.length; k++) out[k] = data.getClipData().getItemAt(k).getUri();
			} else if (data.getData() != null) out = new Uri[]{data.getData()};
		}
		ValueCallback<Uri[]> cb = fileChooser;
		fileChooser = null;
		if (cb != null) cb.onReceiveValue(out);
	}

	@Override public void onBackPressed() {
		if (web != null && web.canGoBack()) web.goBack();
		else super.onBackPressed();
	}

	private void showStatus(String text) {
		status.setText(text);
		status.setVisibility(View.VISIBLE);
		spinner.setVisibility(View.VISIBLE);
	}
	private void hideStatus() {
		status.setVisibility(View.GONE);
		spinner.setVisibility(View.GONE);
	}
}
