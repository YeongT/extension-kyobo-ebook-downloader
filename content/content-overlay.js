(function (C) {
  'use strict';

  // ── Overlay state (local to this module) ──
  var overlayPanelOpen = false;
  var pageInfoInterval = null;
  var oPageInputFocused = false;
  var isNavigating = false;

  // ── Floating control banner ──
  C.createOverlay = function () {
    if (C.overlay) return;
    C.overlay = document.createElement('div');
    C.overlay.id = 'kyobo-ext-fab';
    var shadow = C.overlay.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' +
      ':host{all:initial}' +
      '#rc{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
      /* pill */
      '#pill{display:flex;align-items:center;gap:8px;padding:8px 16px;' +
        'background:rgba(20,20,36,.92);color:#fff;border-radius:22px;cursor:pointer;' +
        'font-size:13px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.35);' +
        'backdrop-filter:blur(12px);user-select:none;border:1px solid rgba(255,255,255,.08);transition:all .15s}' +
      '#pill:active{background:rgba(20,20,36,.98)}' +
      '.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}' +
      '.d-idle{background:#6b7280}.d-active{background:#10b981;animation:pulse 1.5s infinite}' +
      '.d-paused{background:#f59e0b}.d-error{background:#ef4444}' +
      '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}' +
      '.pill-page{color:rgba(255,255,255,.7);font-weight:500;font-size:12px}' +
      '.pill-sep{color:rgba(255,255,255,.2)}' +
      /* panel */
      '#panel{display:none;position:absolute;bottom:calc(100% + 8px);right:0;' +
        'background:rgba(20,20,36,.96);border-radius:14px;padding:0;width:300px;max-height:520px;' +
        'backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,.5);' +
        'border:1px solid rgba(255,255,255,.06);overflow-y:auto;overflow-x:hidden;box-sizing:border-box}' +
      '#panel.open{display:block}' +
      '#panel *{box-sizing:border-box}' +
      '#panel::-webkit-scrollbar{width:4px}' +
      '#panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:2px}' +
      '.sec-wrap{padding:12px 14px}' +
      /* hide number input spinners */
      'input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}' +
      'input[type=number]{-moz-appearance:textfield}' +
      /* page nav */
      '.nav-row{display:flex;align-items:center;gap:6px;max-width:100%}' +
      '.nav-btn{width:32px;height:32px;border:none;border-radius:8px;' +
        'background:rgba(255,255,255,.08);color:#fff;font-size:16px;cursor:pointer;' +
        'display:flex;align-items:center;justify-content:center;transition:all .12s;flex-shrink:0}' +
      '.nav-btn:active{background:rgba(255,255,255,.16)}' +
      '.nav-btn:active{transform:scale(.92)}' +
      '.nav-btn:disabled{opacity:.3;cursor:not-allowed;pointer-events:none}' +
      '.pg-input{flex:1;min-width:0;height:32px;border:1px solid rgba(255,255,255,.12);border-radius:8px;' +
        'background:rgba(255,255,255,.06);color:#fff;font-size:13px;font-weight:600;' +
        'text-align:center;outline:none;padding:0 8px}' +
      '.pg-input:focus{border-color:#e94560}' +
      '.pg-input:disabled{opacity:.5;cursor:not-allowed}' +
      '.pg-total{color:rgba(255,255,255,.4);font-size:12px;font-weight:600;flex-shrink:0}' +
      /* divider */
      '.div{height:1px;background:rgba(255,255,255,.06)}' +
      /* section label */
      '.sec{font-size:10px;color:rgba(255,255,255,.3);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}' +
      /* range inputs */
      '.range-row{display:flex;align-items:center;gap:6px;margin-bottom:8px}' +
      '.range-in{flex:1;min-width:0;height:30px;border:1px solid rgba(255,255,255,.12);border-radius:7px;' +
        'background:rgba(255,255,255,.06);color:#fff;font-size:12px;font-weight:600;' +
        'text-align:center;outline:none;padding:0 6px}' +
      '.range-in:focus{border-color:#e94560}' +
      '.range-sep{color:rgba(255,255,255,.25);font-size:12px}' +
      /* buttons */
      '.cbtn{width:100%;padding:8px 4px;border:none;border-radius:8px;font-size:11px;font-weight:700;' +
        'cursor:pointer;text-align:center;transition:all .12s;margin-bottom:4px}' +
      '.cbtn:disabled{opacity:.3;cursor:not-allowed;pointer-events:none}' +
      '.cbtn:last-child{margin-bottom:0}' +
      '.cbtn-start{background:#e94560;color:#fff}' +
      '.cbtn-start:active:not(:disabled){background:#d63d56}' +
      '.cbtn-pause{background:#f59e0b;color:#fff}' +
      '.cbtn-pause:active:not(:disabled){background:#e68a00}' +
      '.cbtn-stop{background:rgba(239,68,68,.15);color:#ff6b6b}' +
      '.cbtn-stop:active:not(:disabled){background:rgba(239,68,68,.25)}' +
      '.cbtn-dl{background:rgba(99,102,241,.15);color:#818cf8}' +
      '.cbtn-dl:active:not(:disabled){background:rgba(99,102,241,.25)}' +
      '.cbtn-row{display:flex;gap:6px}' +
      '.cbtn-row .cbtn{flex:1;margin-bottom:0}' +
      /* progress */
      '.prog{display:none;margin-top:10px;margin-bottom:4px}' +
      '.prog.on{display:block}' +
      '.bar{height:6px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden}' +
      '.bf{height:100%;background:linear-gradient(90deg,#e94560,#f06292);border-radius:3px;transition:width .3s;width:0%}' +
      '.prog-text{font-size:11px;color:rgba(255,255,255,.5);margin-top:6px;text-align:center}' +
      /* modes */
      '.modes{display:flex;gap:5px}' +
      '.mbtn{flex:1;padding:6px 4px;border:none;border-radius:7px;background:rgba(255,255,255,.06);' +
        'color:rgba(255,255,255,.45);font-size:10px;font-weight:700;text-align:center;cursor:pointer;transition:all .12s}' +
      '.mbtn:active{background:rgba(255,255,255,.12);color:rgba(255,255,255,.8)}' +
      '.mbtn.on{background:#e94560;color:#fff}' +
      /* missing pages */
      '.miss{display:none;padding:8px 10px;border-radius:8px;background:rgba(239,68,68,.1);margin-bottom:8px}' +
      '.miss.on{display:block}' +
      '.miss-text{font-size:11px;color:#ff6b6b;margin-bottom:6px}' +
      '.miss-list{font-size:10px;color:rgba(255,255,255,.4);margin-bottom:6px;word-break:break-all;max-height:60px;overflow-y:auto}' +
      /* download */
      '.dl-sel{width:100%;max-width:100%;height:30px;border:1px solid rgba(255,255,255,.12);border-radius:7px;' +
        'background:rgba(255,255,255,.06);color:#fff;font-size:11px;outline:none;padding:0 8px;margin-bottom:6px;cursor:pointer}' +
      '.dl-sel option{background:#1a1a2e;color:#fff}' +
      /* toast */
      '#toast{position:fixed;top:20px;right:20px;padding:10px 18px;border-radius:10px;' +
        'background:rgba(20,20,36,.94);color:#fff;font-size:12px;font-weight:600;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.3);backdrop-filter:blur(8px);' +
        'opacity:0;transform:translateY(-8px);transition:all .2s;pointer-events:none;z-index:999999}' +
      '#toast.show{opacity:1;transform:translateY(0)}' +
      /* stacking toasts */
      '#toastStack{position:fixed;top:60px;right:20px;display:flex;flex-direction:column;gap:6px;z-index:999998;pointer-events:none}' +
      '.stack-toast{padding:7px 14px;border-radius:8px;background:rgba(20,20,36,.88);color:#fff;' +
        'font-size:11px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.25);backdrop-filter:blur(6px);' +
        'opacity:0;transform:translateY(8px);transition:all .25s;white-space:nowrap}' +
      '.stack-toast.show{opacity:1;transform:translateY(0)}' +
      '.stack-toast.fade{opacity:0;transform:translateY(-4px)}' +
      '</style>' +
      '<div id="toast"></div>' +
      '<div id="toastStack"></div>' +
      '<div id="rc">' +
        '<div id="pill">' +
          '<span class="dot d-idle" id="oDot"></span>' +
          '<span id="oText">대기</span>' +
          '<span class="pill-sep">|</span>' +
          '<span class="pill-page" id="oPillPage">-/-</span>' +
        '</div>' +
        '<div id="panel">' +
          /* Page navigation */
          '<div class="sec-wrap">' +
            '<div class="nav-row">' +
              '<button class="nav-btn" id="oPrev">&#8249;</button>' +
              '<input type="number" class="pg-input" id="oPageInput" value="1" min="1">' +
              '<span class="pg-total" id="oPageTotal">/ -</span>' +
              '<button class="nav-btn" id="oNext">&#8250;</button>' +
            '</div>' +
          '</div>' +
          '<div class="div"></div>' +
          /* Capture section */
          '<div class="sec-wrap">' +
            '<div class="sec">캡처 범위</div>' +
            '<div class="range-row">' +
              '<input type="number" class="range-in" id="oRangeStart" value="1" min="1">' +
              '<span class="range-sep">~</span>' +
              '<input type="number" class="range-in" id="oRangeEnd" value="1" min="1">' +
            '</div>' +
            '<div id="oIdleRow">' +
              '<button class="cbtn cbtn-start" id="oStart" disabled>로딩 중...</button>' +
            '</div>' +
            '<div id="oCapRow" style="display:none">' +
              '<div class="cbtn-row">' +
                '<button class="cbtn cbtn-pause" id="oPause">일시정지</button>' +
                '<button class="cbtn cbtn-stop" id="oStop">중지</button>' +
              '</div>' +
            '</div>' +
            '<div class="prog" id="oProg">' +
              '<div class="bar"><div class="bf" id="oBar"></div></div>' +
              '<div class="prog-text" id="oPr">0/0</div>' +
            '</div>' +
          '</div>' +
          '<div class="div"></div>' +
          /* Mode */
          '<div class="sec-wrap">' +
            '<div class="sec">캡처 모드</div>' +
            '<div class="modes">' +
              '<div class="mbtn" data-m="turbo">터보</div>' +
              '<div class="mbtn" data-m="fast">빠름</div>' +
              '<div class="mbtn on" data-m="normal">일반</div>' +
              '<div class="mbtn" data-m="careful">신중</div>' +
              '<div class="mbtn" data-m="stealth">스텔스</div>' +
            '</div>' +
          '</div>' +
          '<div class="div"></div>' +
          /* Missing pages + Session link */
          '<div class="sec-wrap">' +
            '<div class="miss" id="oMiss">' +
              '<div class="miss-text" id="oMissText">누락 페이지 없음</div>' +
              '<div class="miss-list" id="oMissList"></div>' +
              '<button class="cbtn cbtn-pause" id="oRescanMissing">누락 페이지 재스캔</button>' +
            '</div>' +
            '<button class="cbtn cbtn-dl" id="oOpenSession" style="width:100%;margin-top:8px">세션 관리자에서 다운로드 / 관리</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    C.overlayRoot = shadow;
    document.body.appendChild(C.overlay);

    // Block events from leaking to viewer (bubbling phase so shadow DOM handlers fire first)
    ['mousedown','mouseup','mousemove','mouseover','mouseout','mouseenter','mouseleave',
     'click','dblclick','contextmenu','wheel',
     'pointerdown','pointerup','pointermove','pointerover','pointerout','pointerenter','pointerleave',
     'touchstart','touchmove','touchend','touchcancel',
     'keydown','keyup','keypress'].forEach(function (type) {
      C.overlay.addEventListener(type, function (ev) { ev.stopPropagation(); });
    });

    // Pill toggle
    shadow.getElementById('pill').addEventListener('click', function (ev) {
      ev.stopPropagation();
      overlayPanelOpen = !overlayPanelOpen;
      shadow.getElementById('panel').classList.toggle('open', overlayPanelOpen);
    });

    document.addEventListener('click', function (ev) {
      if (!overlayPanelOpen) return;
      // Don't close panel if click originated from inside overlay (shadow DOM)
      var path = ev.composedPath ? ev.composedPath() : [ev.target];
      for (var i = 0; i < path.length; i++) {
        if (path[i] === C.overlay) return;
      }
      overlayPanelOpen = false;
      if (C.overlayRoot) C.overlayRoot.getElementById('panel').classList.remove('open');
    });

    // Page navigation with disable-during-move
    var oPrevBtn = shadow.getElementById('oPrev');
    var oNextBtn = shadow.getElementById('oNext');
    var oPageInp = shadow.getElementById('oPageInput');

    function setNavDisabled(disabled) {
      oPrevBtn.disabled = disabled;
      oNextBtn.disabled = disabled;
      oPageInp.disabled = disabled;
      oPrevBtn.style.opacity = disabled ? '.3' : '';
      oNextBtn.style.opacity = disabled ? '.3' : '';
      oPageInp.style.opacity = disabled ? '.5' : '';
    }

    async function doNav(action, extra) {
      if (isNavigating) return;
      isNavigating = true;
      setNavDisabled(true);
      try {
        await C.callInject(action, extra);
        await C.delay(1000);
      } catch (e) {}
      try {
        var p = await C.callInject('getViewerPageNum');
        if (p > 0) oPageInp.value = p;
      } catch (e) {}
      isNavigating = false;
      setNavDisabled(false);
    }

    oPrevBtn.addEventListener('click', function () {
      doNav('prevPage');
    });
    oNextBtn.addEventListener('click', function () {
      doNav('nextPage');
    });
    oPageInp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        var pg = parseInt(this.value, 10);
        if (pg > 0) doNav('goToPage', { pageNum: pg });
        this.blur();
      }
    });
    oPageInp.addEventListener('focus', function () { oPageInputFocused = true; });
    oPageInp.addEventListener('blur', function () { oPageInputFocused = false; });

    // Range inputs focus tracking
    var oRS = shadow.getElementById('oRangeStart');
    var oRE = shadow.getElementById('oRangeEnd');
    oRS.addEventListener('focus', function () { C.oRangeStartFocused = true; });
    oRS.addEventListener('blur', function () { C.oRangeStartFocused = false; });
    oRE.addEventListener('focus', function () { C.oRangeEndFocused = true; });
    oRE.addEventListener('blur', function () { C.oRangeEndFocused = false; });

    // Capture start (range)
    shadow.getElementById('oStart').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (C.isCapturing) return;
      var sp = parseInt(oRS.value, 10) || 1;
      var ep = parseInt(oRE.value, 10) || 0;
      chrome.storage.local.get({ autoRetry: true, captureDelay: 500 }, function (settings) {
        var mp = C.MODES[C.liveSettings.mode] || C.MODES.normal;
        C.startCapture({
          startPage: sp, endPage: ep,
          mode: C.liveSettings.mode, autoRetry: settings.autoRetry !== false,
          captureDelay: settings.captureDelay || mp.cap || 500,
          pageDelayMin: mp.min, pageDelayMax: mp.max,
          resume: false
        });
      });
    });

    // Pause/Resume
    shadow.getElementById('oPause').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (C.isCapturing) {
        C.isPaused = !C.isPaused;
        this.textContent = C.isPaused ? '계속' : '일시정지';
        this.className = C.isPaused ? 'cbtn cbtn-start' : 'cbtn cbtn-pause';
        C.setOState(C.isPaused ? 'paused' : 'active');
      }
    });

    // Stop
    shadow.getElementById('oStop').addEventListener('click', function (ev) {
      ev.stopPropagation();
      C.shouldStop = true;
      C.isPaused = false;
    });

    // Mode buttons
    shadow.querySelectorAll('.mbtn').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        C.applyMode(this.dataset.m);
      });
    });

    // Rescan missing pages
    shadow.getElementById('oRescanMissing').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (C.isCapturing || C.missingPages.length === 0) return;
      var mp = C.MODES[C.liveSettings.mode] || C.MODES.normal;
      chrome.storage.local.get({ autoRetry: true, captureDelay: 500 }, function (settings) {
        C.startRescanMissing(C.missingPages.slice(), {
          mode: C.liveSettings.mode,
          autoRetry: settings.autoRetry !== false,
          captureDelay: settings.captureDelay || mp.cap || 500,
          pageDelayMin: mp.min, pageDelayMax: mp.max
        });
      });
    });

    // Open session manager
    shadow.getElementById('oOpenSession').addEventListener('click', function (ev) {
      ev.stopPropagation();
      var title = C.getBookTitle();
      chrome.runtime.sendMessage({
        target: 'background', action: 'openSessions',
        title: title || undefined,
        bookId: title ? undefined : C.getBookId()
      }, function () { void chrome.runtime.lastError; });
    });

    C.startPageInfoPoll();
  };

  C.startPageInfoPoll = function () {
    if (pageInfoInterval) clearInterval(pageInfoInterval);
    pageInfoInterval = setInterval(function () {
      if (!C.overlayRoot) return;
      Promise.all([
        C.callInject('getPageInfo'),
        C.callInject('getRenderedPageNums')
      ]).then(function (results) {
        var info = results[0];
        var rendered = results[1];
        if (!info) return;
        var pill = C.overlayRoot.getElementById('oPillPage');
        var inp = C.overlayRoot.getElementById('oPageInput');
        var tot = C.overlayRoot.getElementById('oPageTotal');
        var re = C.overlayRoot.getElementById('oRangeEnd');
        // Show rendered pages in pill (e.g. "5,6/306" in 2-page view)
        var pageLabel = (info.current || '-');
        if (rendered && rendered.length > 1) {
          pageLabel = rendered.join(',');
        }
        if (pill) pill.textContent = pageLabel + '/' + (info.total || '-');
        if (tot) tot.textContent = '/ ' + (info.total || '-');
        if (inp && !oPageInputFocused) inp.value = (rendered && rendered.length > 0) ? rendered[0] : (info.current || 1);
        // Auto-fill range with smart defaults on first load
        if (re && !C.oRangeEndFocused && re.value === '1' && info.total > 1) {
          re.value = info.total;
          C.autoFillRangeStart(info.total);
        }
        // Enable capture button once page info is available
        var startBtn = C.overlayRoot.getElementById('oStart');
        if (startBtn && info.total > 0 && startBtn.disabled) {
          startBtn.disabled = false;
          startBtn.textContent = '범위 캡처 시작';
        }
      }).catch(function () {});
    }, 2000);
  };

  C.autoFillRangeStart = function (total) {
    if (!C.overlayRoot) return;
    var rs = C.overlayRoot.getElementById('oRangeStart');
    if (!rs || C.oRangeStartFocused) return;

    // Get bookId - try resolved, then title-based
    var bid = C.getBookId();
    var title = C.getBookTitle();
    if (bid === location.pathname + location.search && title) {
      bid = 'title:' + title;
    }

    // Check extension DB (reliable, survives tab close)
    chrome.runtime.sendMessage({
      target: 'background', action: 'getPagesInfo', bookId: bid
    }, function (r) {
      void chrome.runtime.lastError;
      var cachedSet = {};
      if (r && r.pages) r.pages.forEach(function (p) { cachedSet[p] = true; });

      // Also check MAIN world cache
      C.callInject('getCacheInfo').then(function (ci) {
        if (ci && ci.cachedPageNums) ci.cachedPageNums.forEach(function (p) { cachedSet[p] = true; });
      }).catch(function () {}).then(function () {
        var keys = Object.keys(cachedSet);
        if (keys.length === 0) return;

        // Set start to last captured page + 1 (resume from where left off)
        var maxCaptured = 0;
        keys.forEach(function (k) {
          var n = parseInt(k, 10);
          if (n > maxCaptured) maxCaptured = n;
        });
        var resumeFrom = maxCaptured < total ? maxCaptured + 1 : 1;
        rs.value = resumeFrom;
      });
    });
  };

  // ── Sound notifications via Web Audio API ──
  C.playBeep = function (type) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.value = 0.3;

      if (type === 'success') {
        // Two-tone ascending chime
        osc.frequency.value = 660;
        osc.type = 'sine';
        osc.start();
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.3, ctx.currentTime + 0.2);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.stop(ctx.currentTime + 0.5);
      } else if (type === 'error') {
        // Low buzz
        osc.frequency.value = 280;
        osc.type = 'square';
        gain.gain.value = 0.2;
        osc.start();
        gain.gain.setValueAtTime(0.2, ctx.currentTime + 0.3);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        osc.stop(ctx.currentTime + 0.6);
      } else {
        // Single ping
        osc.frequency.value = 520;
        osc.type = 'sine';
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.3);
      }
      setTimeout(function () { ctx.close(); }, 1000);
    } catch (e) {}
  };

  C.showToast = function (msg, duration) {
    if (!C.overlayRoot) return;
    var t = C.overlayRoot.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, duration || 3000);
  };

  C.showStackToast = function (msg, duration) {
    if (!C.overlayRoot) return;
    var stack = C.overlayRoot.getElementById('toastStack');
    if (!stack) return;
    var el = document.createElement('div');
    el.className = 'stack-toast';
    el.textContent = msg;
    stack.appendChild(el);
    while (stack.children.length > 10) stack.removeChild(stack.firstChild);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      el.classList.add('fade');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, duration || 2000);
  };

  C.updateOModeHighlight = function () {
    if (!C.overlayRoot) return;
    C.overlayRoot.querySelectorAll('.mbtn').forEach(function (btn) {
      btn.classList.toggle('on', btn.dataset.m === C.liveSettings.mode);
    });
  };

  C.setOState = function (s) {
    if (!C.overlayRoot) return;
    var dot = C.overlayRoot.getElementById('oDot');
    var text = C.overlayRoot.getElementById('oText');
    var idleRow = C.overlayRoot.getElementById('oIdleRow');
    var capRow = C.overlayRoot.getElementById('oCapRow');
    var prog = C.overlayRoot.getElementById('oProg');

    if (dot) dot.className = 'dot d-' + s;

    if (s === 'idle') {
      if (text) text.textContent = '대기';
      if (idleRow) idleRow.style.display = '';
      if (capRow) capRow.style.display = 'none';
      if (prog) prog.classList.remove('on');
    } else if (s === 'active') {
      if (text) text.textContent = '캡처 진행중...';
      if (idleRow) idleRow.style.display = 'none';
      if (capRow) capRow.style.display = '';
      if (prog) prog.classList.add('on');
      // Reset pause button state
      var pauseBtn = C.overlayRoot.getElementById('oPause');
      if (pauseBtn) { pauseBtn.textContent = '일시정지'; pauseBtn.className = 'cbtn cbtn-pause'; }
    } else if (s === 'paused') {
      if (text) text.textContent = '일시정지';
    } else if (s === 'error') {
      if (text) text.textContent = '오류';
      if (idleRow) idleRow.style.display = '';
      if (capRow) capRow.style.display = 'none';
      if (prog) prog.classList.remove('on');
    }
  };

  C.setOText = function (msg) {
    if (!C.overlayRoot) return;
    var text = C.overlayRoot.getElementById('oText');
    if (text && !C.isPaused) text.textContent = msg;
  };

  C.updateO = function (capturedSoFar, bookTotal, page, scanDone, scanTotal) {
    if (!C.overlayRoot) return;
    var text = C.overlayRoot.getElementById('oText');
    var pr = C.overlayRoot.getElementById('oPr');
    var bar = C.overlayRoot.getElementById('oBar');
    if (bookTotal > 0) C._bookTotal = bookTotal;
    var bt = C._bookTotal || bookTotal;

    // page can be a number, array, or string (e.g. [1,2] → "p1,2")
    var pageLabel = '';
    if (page) {
      if (Array.isArray(page)) {
        pageLabel = page.length > 0 ? '  p' + page.join(',') : '';
      } else {
        pageLabel = '  p' + page;
      }
    }

    if (C._scanRange && scanTotal > 0 && scanTotal < bt) {
      var sPct = scanTotal > 0 ? Math.round(scanDone / scanTotal * 100) : 0;
      if (text && !C.isPaused) text.textContent = C._scanRange.start + '-' + C._scanRange.end + 'p 캡처 중...';
      if (pr) pr.textContent = scanDone + '/' + scanTotal + ' (' + sPct + '%)' + pageLabel;
      if (bar) bar.style.width = sPct + '%';
    } else {
      var pct = bt > 0 ? Math.round(capturedSoFar / bt * 100) : 0;
      if (text && !C.isPaused) text.textContent = '캡처 중...';
      if (pr) pr.textContent = capturedSoFar + '/' + bt + ' (' + pct + '%)' + pageLabel;
      if (bar) bar.style.width = pct + '%';
    }
  };

  C.showMissingPages = function (missing) {
    if (!C.overlayRoot) return;
    var el = C.overlayRoot.getElementById('oMiss');
    var txt = C.overlayRoot.getElementById('oMissText');
    var lst = C.overlayRoot.getElementById('oMissList');
    if (!el) return;
    if (!missing || missing.length === 0) {
      el.classList.remove('on');
      return;
    }
    el.classList.add('on');
    txt.textContent = missing.length + '개 페이지 누락';
    lst.textContent = missing.join(', ');
  };

})(window._C = window._C || {});
