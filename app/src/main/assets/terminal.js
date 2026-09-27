/* Embedded terminal overlay for the DSH WebView shell.
 *
 * Injected by MainActivity after the page loads. It lives entirely outside the
 * React root (appended to <body>, position: fixed), so no SPA re-render can
 * remove it and no dsh internals are patched.
 *
 * Commands are handed to the native bridge (window.DSHTermNative), which runs
 * them with the same environment the dsh server itself gets — so the whole
 * bundled Termux prefix is on PATH: bash, coreutils, apt, dpkg, python, curl.
 */
(function () {
  if (window.__dshTermInstalled) return;
  window.__dshTermInstalled = true;

  var seq = 0;

  /* ---- styles -------------------------------------------------------- */
  var css = [
    // Placement is set at runtime (see place()) so the button sits above the
    // sidebar's own bottom seat instead of on top of it.
    // Flat: no fill, no shadow, no press highlight. The sidebar's own icons are
    // bare glyphs, and a filled, shadowed chip next to them reads as a bug.
    '#dsh-term-btn{position:fixed;left:12px;bottom:64px;z-index:2147483000;',
    'border:0;outline:0;cursor:pointer;padding:0;-webkit-tap-highlight-color:transparent;',
    'background:transparent;box-shadow:none;',
    'color:var(--dsw-alias-label-primary,currentColor);',
    'display:flex;align-items:center;justify-content:center;font-family:ui-monospace,monospace;',
    'font-size:16px;font-weight:700;line-height:1;letter-spacing:-.5px}',
    '#dsh-term-btn:active{opacity:.55}',
    '#dsh-term{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;height:46vh;min-height:180px;',
    'max-height:440px;background:#111114;color:#d8d8d8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
    'font-size:12.5px;line-height:1.45;display:flex;flex-direction:column;',
    'border-top:1px solid #33333a;box-shadow:0 -6px 24px rgba(0,0,0,.45);',
    // Kept mounted (not display:none) so it can slide: transform and opacity are
    // the only animated properties, because applyKeyboard() rewrites bottom and
    // height on every keyboard tick and animating those would make it lurch.
    'visibility:hidden;opacity:0;transform:translateY(14px);',
    'transition:transform var(--dsh-anim,200ms) cubic-bezier(.4,0,.2,1),',
    'opacity var(--dsh-anim,200ms) linear,visibility 0s linear var(--dsh-anim,200ms)}',
    '#dsh-term.open{visibility:visible;opacity:1;transform:translateY(0);',
    'transition:transform var(--dsh-anim,200ms) cubic-bezier(.4,0,.2,1),opacity var(--dsh-anim,200ms) linear}',
    // Landscape / split-screen: the viewport is only ~350px tall, so a 180px
    // floor would eat most of it and the soft keyboard finishing the job.
    // Take a larger share of a short viewport instead, with no floor.
    '@media (max-height:520px){#dsh-term{height:68vh;min-height:0;max-height:none}}',

    // While typing on a short viewport the keyboard leaves ~57px: show only the
    // prompt line, nothing else.
    '#dsh-term.typing #dsh-term-head,#dsh-term.typing #dsh-term-out{display:none}',
    '#dsh-term-head{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#191920;',
    'border-bottom:1px solid #2a2a33;flex:none}',
    '#dsh-term-head .t{font-weight:600;letter-spacing:.3px;color:#bfbfc7}',
    '#dsh-term-head .sp{flex:1}',
    '#dsh-term-head button{background:#26262e;color:#c9c9d2;border:1px solid #34343d;border-radius:7px;',
    'padding:3px 9px;font-size:11.5px;font-family:inherit;cursor:pointer}',
    '#dsh-term-head button:active{background:#32323c}',
    '#dsh-term-out{flex:1;overflow-y:auto;padding:8px 10px;white-space:pre-wrap;word-break:break-word;',
    '-webkit-overflow-scrolling:touch}',
    '#dsh-term-out .cmd{color:#7fd1ff}',
    '#dsh-term-out .err{color:#ff9d9d}',
    '#dsh-term-out .dim{color:#7d7d88}',
    '#dsh-term-in{display:flex;align-items:center;gap:6px;padding:7px 10px;border-top:1px solid #2a2a33;',
    'background:#17171d;flex:none}',
    '#dsh-term-in .p{color:#5fd07f;flex:none}',
    '#dsh-term-in input{flex:1;background:transparent;border:none;outline:none;color:#e8e8ea;',
    'font-family:inherit;font-size:12.5px;padding:2px 0}',
    '#dsh-term-in button{background:#2f6fd0;border:none;color:#fff;border-radius:7px;padding:4px 10px;',
    'font-size:11.5px;font-family:inherit;cursor:pointer;flex:none}',
    '#dsh-term-in button.stop{background:#a33}'
  ].join('');

  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  /* ---- dom ----------------------------------------------------------- */
  var btn = document.createElement('button');
  btn.id = 'dsh-term-btn';
  btn.title = '终端 / Terminal';
  btn.textContent = '>_';

  var panel = document.createElement('div');
  panel.id = 'dsh-term';
  panel.innerHTML =
    '<div id="dsh-term-head"><span class="t">终端</span><span class="sp"></span>' +
    '<button data-a="clear">清屏</button><button data-a="close">关闭</button></div>' +
    '<div id="dsh-term-out"></div>' +
    '<div id="dsh-term-in"><span class="p">$</span>' +
    '<input id="dsh-term-cmd" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
    'placeholder="输入命令，回车执行（apt / python / ls …）">' +
    '<button data-a="run">运行</button></div>';

  var out = panel.querySelector('#dsh-term-out');
  var input = panel.querySelector('#dsh-term-cmd');
  var runBtn = panel.querySelector('[data-a=run]');

  function append(text, cls) {
    var span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
  }

  function line(text, cls) { append(text + '\n', cls); }

  /* ---- transcript ------------------------------------------------------
   * Everything run in this panel is appended to a JSONL file so the dsh agent
   * can read the same session with its ordinary file tools. Discovered through
   * AGENTS.local.md, which dsh's instruction loader picks up from the workspace
   * — no plugin needed, and nothing for the agent to poll. */
  var runCmd = '', runOut = '', runStart = 0;

  /** POSIX single-quote a string for the shell bridge. */
  function sq(v) { return "'" + String(v).replace(/'/g, "'\\''" ) + "'"; }

  function record(cmd, output, code) {
    if (!window.DSHTermNative || !window.DSHTermNative.run) return;
    var rec = JSON.stringify({
      at: new Date().toISOString(),
      cmd: cmd,
      code: code,
      ms: Date.now() - runStart,
      out: output.length > 8000 ? output.slice(-8000) : output
    });
    try {
      window.DSHTermNative.run("printf '%s\\n' " + sq(rec) + ' >> "$HOME/.dsh/terminal-panel.jsonl"');
    } catch (e) { /* never break the panel over logging */ }
  }

  /* ---- bridge -------------------------------------------------------- */
  var current = null;
  var historyList = [], histIdx = -1;

  window.__dshTerm = {
    onData: function (id, chunk) {
      if (id !== current) return;
      if (runOut.length < 64000) runOut += chunk;
      append(chunk);
    },
    onExit: function (id, code) {
      if (id !== current) return;
      current = null;
        record(runCmd, runOut, code);
        runCmd = ''; runOut = '';
      line(code === 0 ? '· 完成' : '· 退出码 ' + code, 'dim');
      setRunning(false);
    },
    onError: function (id, msg) {
      if (id !== current) return;
      current = null;
        record(runCmd, runOut + '\n' + msg, -1);
        runCmd = ''; runOut = '';
      line(msg, 'err');
      setRunning(false);
    }
  };

  function setRunning(on) {
    runBtn.textContent = on ? '停止' : '运行';
    runBtn.className = on ? 'stop' : '';
    runBtn.dataset.a = on ? 'stop' : 'run';
  }

  function send() {
    var cmd = input.value.trim();
    if (!cmd) return;

    if (/^(clear|cls)$/.test(cmd)) { out.textContent = ''; input.value = ''; return; }

    if (!window.DSHTermNative || !window.DSHTermNative.run) {
      line('原生桥不可用（DSHTermNative 缺失）', 'err');
      return;
    }
    historyList.push(cmd); histIdx = historyList.length;

    runCmd = cmd; runOut = ''; runStart = Date.now();
    line('$ ' + cmd, 'cmd');
    input.value = '';
    current = window.DSHTermNative.run(cmd);
    setRunning(true);
  }

  function stop() {
    if (current && window.DSHTermNative.kill) window.DSHTermNative.kill(current);
    current = null;
    setRunning(false);
  }

  /* ---- events -------------------------------------------------------- */
  btn.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      if (!out.childNodes.length) {
        line('嵌入式终端 — 使用 app 自带环境（bash / coreutils / apt / python / curl）', 'dim');
        line('命令在 $HOME 下执行；长命令可点「停止」。', 'dim');
        line('', null);
      }
      setTimeout(function () { input.focus(); }, 60);
    }
  });

  panel.querySelector('[data-a=close]').addEventListener('click', function () {
    panel.classList.remove('open');
  });
  panel.querySelector('[data-a=clear]').addEventListener('click', function () {
    out.textContent = '';
  });

  runBtn.addEventListener('click', function () {
    if (runBtn.dataset.a === 'stop') stop(); else send();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); send(); return; }
    if (e.key === 'ArrowUp') {
      if (histIdx > 0) { histIdx--; input.value = historyList[histIdx] || ''; }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (histIdx < historyList.length - 1) { histIdx++; input.value = historyList[histIdx] || ''; }
      else { histIdx = historyList.length; input.value = ''; }
      e.preventDefault();
    }
  });

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  /* ---- placement ------------------------------------------------------
   * The button lives in the sidebar, directly below the search (magnifier)
   * control, and copies that control's geometry so it reads as one of the rail.
   *
   * The Settings seat was the first anchor, but it carries neither text nor
   * aria-label (probed: class "VOzbGW_trigger VOzbGW_rail", 36x36 at the bottom
   * left), so it could only be found by class and a "bottom-most control"
   * fallback jittered whenever the composer's buttons appeared. The search
   * button is explicitly labelled and sits in a stable position, which is why it
   * is the anchor now. Settings stays as the fallback.
   *
   * Once an anchor is found we keep using the last one across transient misses;
   * falling back mid-re-render would teleport the button. */
  var lastSeat = null;

  function rectOf(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.left > 200) return null;
    return r;
  }

  function searchButton() {
    return document.querySelector('button[class*="searchButton"]')
        || document.querySelector('[class*="searchButton"]');
  }

  function settingsSeat() {
    return document.querySelector('button[class*="VOzbGW_trigger"]')
        || document.querySelector('[class*="VOzbGW_trigger"]');
  }

  function byLabel(re) {
    var nodes = document.querySelectorAll('button,[role="button"],a');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el === btn) continue;
      if (!rectOf(el)) continue;
      var label = ((el.getAttribute && (el.getAttribute('aria-label') || el.title)) || el.textContent || '').trim();
      if (re.test(label)) return el;
    }
    return null;
  }

  function dress(el) {
    var r = rectOf(el);
    if (!r) return null;
    var cs = window.getComputedStyle(el);
    btn.style.left = r.left + 'px';
    btn.style.width = r.width + 'px';
    btn.style.height = r.height + 'px';
    btn.style.borderRadius = cs.borderRadius && cs.borderRadius !== '0px' ? cs.borderRadius : '10px';
    return r;
  }

  /**
   * True when something is drawn on top of the sidebar.
   *
   * The button is fixed with a very high z-index so it survives dsh's React
   * re-renders. That also put it *over* full-screen pages: with Settings open it
   * floated across the "Enter key behaviour" row. Ask the document what is
   * actually topmost where the sidebar sits — if it is not the sidebar, hide.
   * Geometric, so it also does the right thing when a page is a centred panel
   * that leaves the sidebar uncovered.
   */
  function sidebarCovered() {
    var seat = settingsSeat() || byLabel(/设置|settings/i);
    if (!seat) return false;
    var r = seat.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var top = document.elementFromPoint(r.left + Math.min(r.width, 40) / 2, r.top + r.height / 2);
    // Our own overlay must not count as cover: the panel sits over the sidebar's
    // bottom, so without this test opening the terminal looked like the sidebar
    // being covered, and the next tick hid the button and closed the panel —
    // i.e. it collapsed by itself right after being tapped.
    if (!top || top === btn || (btn.contains && btn.contains(top))) return false;
    if (top === panel || (panel.contains && panel.contains(top))) return false;
    return !(top === seat || seat.contains(top) || top.contains(seat));
  }

  function place() {
    // Only the collapsed rail shows it. In the expanded sidebar the icons move
    // into headers, and on a full-screen page (Settings) a fixed high-z-index
    // chip floats over the content — both looked wrong, so hide instead of
    // trying to find a second home for it.
    var search = searchButton();
    var sr = rectOf(search);
    var inRail = sr && sr.left < 60 && sr.width < 60;
    var show = inRail && !sidebarCovered();

    if (show !== (btn.style.display !== 'none')) {
      btn.style.display = show ? '' : 'none';
      if (!show && panel.classList.contains('open')) panel.classList.remove('open');
    }
    if (!show) return;

    var r = dress(search);
    if (r) {
      btn.style.top = Math.round(r.bottom + 6) + 'px';
      btn.style.bottom = 'auto';        // clear the other edge, or both apply
      lastSeat = search;
      return;
    }

    // No rail (still booting, or a layout we do not know): keep it out of the way.
    btn.style.left = '10px';
    btn.style.width = '36px';
    btn.style.height = '36px';
    btn.style.borderRadius = '10px';
    btn.style.top = Math.round(window.innerHeight * 0.10) + 'px';
    btn.style.bottom = 'auto';
  }

  place();
  setInterval(place, 700);
  setInterval(function () {                 // safety net if a tween gets cut off
    if (!tweening && performance.now() > suppressUntil) lastColW = colWidth();
  }, 1500);
  window.addEventListener('resize', place);
  window.addEventListener('orientationchange', place);

  /* ---- animation --------------------------------------------------------
   * Android's animator duration scale is published by MainActivity as
   * __dshAnimScale: 1 is normal, 0.5 halves, 0 disables. Everything here is
   * scaled by it so the app matches whatever the system is set to. */
  function animMs(base) {
    var s = typeof window.__dshAnimScale === 'number' ? window.__dshAnimScale : 1;
    var ms = Math.round(base * s);
    return ms < 8 ? 0 : ms;             // treat "essentially off" as off
  }

  function applyAnimVars() {
    document.documentElement.style.setProperty('--dsh-anim', animMs(200) + 'ms');
  }
  applyAnimVars();

  /* The sidebar is a CSS grid whose first column is set inline by the app, with
   * a `transition: grid-template-columns .3s` declared — but the width jumps in
   * one frame (measured: 56 -> 280 at t=0ms), so nothing animates. Chromium 151
   * does interpolate that property, so the app itself must be defeating it.
   * Rather than patch the bundle, tween the column ourselves on every change and
   * then hand the property back to React. */
  var lastColW = 0, animating = false;
  function colWidth() {
    var c = document.querySelector('[class*="sidebarCol"]');
    return c ? c.getBoundingClientRect().width : 0;
  }

  /* Animate the sidebar's appearance, not its layout.
   *
   * The app lays the shell out as a CSS grid and writes the column widths inline
   * ("56px minmax(0px, 1fr) 0px") with a 0.3s transition declared — but the width
   * jumps in a single frame (measured). Writing intermediate grid values from a
   * rAF loop had no effect either: the property was set and read back unchanged,
   * so React must be re-committing it. Fighting that is a losing game.
   *
   * Instead, transform and opacity — which React does not write — animate the
   * sidebar sliding in and the content area following it. The layout still snaps
   * underneath, but the motion reads correctly and nothing can overwrite it. */
  function slideIn(dx) {
    var ms = animMs(200);
    if (!ms) return;                       // animations disabled system-wide
    var els = [
      [document.querySelector('[class*="sidebarCol"]'), -Math.abs(dx) * 0.5, 0.35],
      [document.querySelector('[class*="centerCol"]'), Math.abs(dx) * 0.5, 0.0]
    ];
    for (var i = 0; i < els.length; i++) {
      var el = els[i][0];
      if (!el || !el.animate) continue;
      try {
        el.animate(
          [{ transform: 'translateX(' + els[i][1].toFixed(1) + 'px)', opacity: 1 - els[i][2] },
           { transform: 'translateX(0)', opacity: 1 }],
          { duration: ms, easing: 'cubic-bezier(.4,0,.2,1)' });
      } catch (e) { /* older engines: no animation, layout still correct */ }
    }
  }

  /* 50ms poll: the sidebar's width is the single source of truth for "expanded",
   * and polling survives the element remounts that killed an observer. */
  setInterval(function () {
    if (animating) return;
    var w = colWidth();
    if (!w) return;
    if (!lastColW) { lastColW = w; return; }
    var d = w - lastColW;
    if (Math.abs(d) < 4) { lastColW = w; return; }
    lastColW = w;
    animating = true;
    slideIn(d);
    setTimeout(function () { animating = false; lastColW = colWidth(); }, animMs(200) + 60);
  }, 50);

  /* ---- keyboard -------------------------------------------------------
   * The panel is anchored to the bottom of the layout viewport, so a soft
   * keyboard covered it (seen in a landscape screenshot: only the header stayed
   * visible). Neither the layout viewport nor visualViewport reports the
   * keyboard in this WebView, so the native side measures it with
   * getWindowVisibleDisplayFrame and calls __dshTermKb(coveredCssPx).
   * The visualViewport path is kept as a fallback for other embeddings. */
  var kbCss = 0;

  /* Tallest viewport seen with the keyboard hidden, i.e. the real content area. */
  var fullH = window.innerHeight;

  function applyKeyboard() {
    var kbUp = kbCss > 40;
    if (!kbUp) fullH = window.innerHeight;

    // adjustResize already shrinks the layout viewport on this device (350 ->
    // 77 css px in landscape), so the panel's bottom is only offset when the
    // viewport did NOT shrink. Offsetting in both cases pushed the panel 255px
    // above the screen, which is exactly what happened first.
    var shrunk = window.innerHeight < fullH - 20;
    var needOffset = kbUp && !shrunk;
    panel.style.bottom = needOffset ? kbCss + 'px' : '0px';
    var avail = needOffset ? Math.max(0, fullH - kbCss) : window.innerHeight;

    if (avail < 170) {
      // Landscape with the keyboard up leaves ~77px: that fits the prompt line
      // and nothing else, which is all that is needed while typing.
      panel.classList.add('typing');
      panel.style.height = 'auto';
    } else {
      panel.classList.remove('typing');
      panel.style.height = kbUp ? Math.round(avail * 0.92) + 'px' : '';
    }
    if (panel.classList.contains('open')) out.scrollTop = out.scrollHeight;
  }

  window.__dshTermKb = function (css) {
    window.__dshKb = css;                 // visible to the probe
    if (css === kbCss) return;
    kbCss = css || 0;
    applyKeyboard();
  };

  var vv = window.visualViewport;
  function syncFromVisualViewport() {
    if (!vv || kbCss) return;             // native measurement wins when present
    var covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    if (covered === kbCss) return;
    kbCss = covered;
    applyKeyboard();
  }
  if (vv) {
    vv.addEventListener('resize', syncFromVisualViewport);
    vv.addEventListener('scroll', syncFromVisualViewport);
  }
  window.addEventListener('resize', function () { setTimeout(applyKeyboard, 80); });
  input.addEventListener('focus', function () { setTimeout(applyKeyboard, 250); });
  input.addEventListener('blur', function () { setTimeout(applyKeyboard, 250); });
})();
