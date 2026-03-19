(function () {
  'use strict';

  var isCapturing = false;
  var shouldStop = false;
  var isPaused = false;
  var pendingCallbacks = {};
  var sessionId = Math.random().toString(36).slice(2, 10);
  var callbackSeq = 0;
  var captureSession = null;
  var missingPages = [];
  var resolvedBookId = null;

  // ── Live settings ──
  var MODES = {
    turbo:   { min: 100,  max: 250 },
    fast:    { min: 300,  max: 600 },
    normal:  { min: 800,  max: 1500 },
    careful: { min: 1500, max: 3000 },
    stealth: { min: 2500, max: 5000 }
  };
  var liveSettings = { dMin: 800, dMax: 1500, stealth: false, mode: 'normal', capDelay: 500 };

  function applyMode(mode) {
    liveSettings.mode = mode;
    liveSettings.stealth = (mode === 'stealth' || mode === 'careful');
    if (MODES[mode]) {
      liveSettings.dMin = MODES[mode].min;
      liveSettings.dMax = MODES[mode].max;
    }
    updateOModeHighlight();
  }

  // ── 1. Inject.js communication ──
  function callInject(action, extra) {
    return new Promise(function (resolve, reject) {
      var id = sessionId + '_' + (++callbackSeq);
      var timeout = setTimeout(function () { delete pendingCallbacks[id]; reject(new Error('Timeout: ' + action)); }, 30000);
      pendingCallbacks[id] = function (r) { clearTimeout(timeout); r.error ? reject(new Error(r.error)) : resolve(r.data); };
      window.postMessage(Object.assign({ source: 'KYOBO_CONTENT', id: id, action: action }, extra || {}), location.origin);
    });
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== window) return;
    if (!e.data || e.data.source !== 'KYOBO_INJECT') return;
    if (e.data.type === 'INJECTED') return;
    if (e.data.type === 'ABNORMAL_BLOCKED') { handleAbnormal(); return; }
    var id = e.data.id;
    if (id && pendingCallbacks[id]) { pendingCallbacks[id](e.data); delete pendingCallbacks[id]; }
  });

  // ── 2. Chrome message handler ──
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'ping') { sendResponse({ status: 'ready', isCapturing: isCapturing }); return true; }
    if (msg.action === 'getPageInfo') { callInject('getPageInfo').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'getTOC') { callInject('getTOC').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'startCapture') { if (isCapturing) { sendResponse({ success: false, error: '이미 캡처 중' }); return true; } startCapture(msg.options || {}); sendResponse({ success: true }); return true; }
    if (msg.action === 'stopCapture') { shouldStop = true; isPaused = false; sendResponse({ success: true }); return true; }
    if (msg.action === 'getStatus') { sendResponse({ isCapturing: isCapturing, shouldStop: shouldStop }); return true; }
    if (msg.action === 'getProgress') { callInject('getCapturedCount').then(function (c) { sendResponse({ capturedCount: c, isCapturing: isCapturing }); }).catch(function () { sendResponse({ capturedCount: 0, isCapturing: isCapturing }); }); return true; }
    if (msg.action === 'getCacheInfo') { callInject('getCacheInfo').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'buildPDFFromCache') { callInject('buildPDFFromCache', { extensionBaseURL: chrome.runtime.getURL(''), title: msg.title || 'ebook', toc: msg.toc || [], targetSize: msg.targetSize || null }).then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'clearCache') { callInject('clearCache').then(function () { sendResponse({ success: true }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'goToPage') { callInject('goToPage', { pageNum: msg.pageNum }).then(function (r) { sendResponse({ success: !!r }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'changeMode') { applyMode(msg.mode || 'normal'); sendResponse({ success: true }); return true; }
    if (msg.action === 'pauseCapture') { isPaused = true; sendResponse({ success: true }); return true; }
    if (msg.action === 'resumeCapture') { isPaused = false; sendResponse({ success: true }); return true; }
    return false;
  });

  // ── 3. Helpers ──
  function notifyPopup(type, data) {
    try { chrome.runtime.sendMessage({ source: 'KYOBO_CONTENT', type: type, data: data }); } catch (e) {}
  }

  function focusViewerTab() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ target: 'background', action: 'focusTab' }, function (r) {
          void chrome.runtime.lastError;
          resolve(r && r.success);
        });
      } catch (e) { resolve(false); }
    });
  }

  function forwardToBackground(action, data) {
    try {
      chrome.runtime.sendMessage(Object.assign({ target: 'background', action: action }, data || {}), function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  function getBookId() { return resolvedBookId || location.pathname + location.search; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function randomInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function randomDelay(lo, hi, stealth) {
    var d = randomInt(lo, hi);
    if (stealth) { if (Math.random() < 0.15) d += randomInt(2000, 6000); if (Math.random() < 0.05) d += randomInt(5000, 15000); }
    return delay(d);
  }

  // ── 4. Page verification (read viewer's page indicator) ──
  async function verifyPageNum(expected, timeout) {
    var deadline = Date.now() + (timeout || 15000);
    while (Date.now() < deadline) {
      try {
        var viewerPage = await callInject('getViewerPageNum');
        if (viewerPage === expected) return true;
      } catch (e) {}
      await delay(300);
    }
    return false;
  }

  async function waitCanvasReady(maxWait) {
    var attempts = Math.ceil((maxWait || 10000) / 500);
    for (var i = 0; i < attempts; i++) {
      try {
        var ready = await callInject('canvasReady');
        if (ready) return true;
      } catch (e) {}
      await delay(500);
    }
    return false;
  }

  async function waitCanvasChange(prevFingerprint, maxWait) {
    if (!prevFingerprint) return true;
    var attempts = Math.ceil((maxWait || 10000) / 250);
    for (var i = 0; i < attempts; i++) {
      try {
        var fp = await callInject('getCanvasFingerprint');
        if (fp && fp !== prevFingerprint) return true;
      } catch (e) {}
      await delay(250);
    }
    return false;
  }

  // ── 5. Navigate to page and capture (core reliable method) ──
  async function navigateAndCapture(targetPage) {
    // 1. Read ACTUAL viewer position (don't trust any tracking variable)
    var curPage = 0;
    try { curPage = await callInject('getViewerPageNum'); } catch (e) {}

    // 2. Get fingerprint before navigation
    var fpBefore = '';
    try { fpBefore = await callInject('getCanvasFingerprint'); } catch (e) {}

    // 3. Navigate based on actual viewer position
    if (curPage === targetPage) {
      // Already on the right page — skip navigation
    } else if (curPage > 0 && targetPage === curPage + 1) {
      await callInject('nextPage');
    } else if (curPage > 0 && targetPage === curPage - 1) {
      await callInject('prevPage');
    } else {
      // Need a jump — try goToPage with longer wait
      for (var jumpAttempt = 0; jumpAttempt < 2; jumpAttempt++) {
        try {
          await callInject('goToPage', { pageNum: targetPage });
        } catch (e) {}
        // Wait longer for jump navigation to settle (especially for large jumps)
        await delay(800 + Math.min(Math.abs(targetPage - curPage), 50) * 10);
        var afterJump = 0;
        try { afterJump = await callInject('getViewerPageNum'); } catch (e2) {}
        if (afterJump === targetPage) break;
        // Sequential fallback for small remaining gaps
        if (afterJump > 0 && afterJump !== targetPage) {
          var gap = targetPage - afterJump;
          if (Math.abs(gap) <= 15) {
            var step = gap > 0 ? 'nextPage' : 'prevPage';
            for (var s = 0; s < Math.abs(gap); s++) {
              await callInject(step);
              await delay(350);
            }
            break;
          }
        }
      }
    }

    // 4. Wait for page indicator to update
    await delay(600);

    // 5. Verify the viewer's page indicator matches
    var verified = await verifyPageNum(targetPage, 8000);
    if (!verified) {
      // Final attempt: goToPage + sequential
      try { await callInject('goToPage', { pageNum: targetPage }); } catch (e) {}
      await delay(1000);
      var cur2 = 0;
      try { cur2 = await callInject('getViewerPageNum'); } catch (e) {}
      if (cur2 > 0 && cur2 !== targetPage && Math.abs(targetPage - cur2) <= 15) {
        var step2 = targetPage > cur2 ? 'nextPage' : 'prevPage';
        for (var s2 = 0; s2 < Math.abs(targetPage - cur2); s2++) {
          await callInject(step2);
          await delay(350);
        }
      }
      verified = await verifyPageNum(targetPage, 4000);
      if (!verified) return { ok: false, error: 'navigation_failed_page_' + targetPage };
    }

    // 6. Wait for canvas content to change
    if (fpBefore) {
      await waitCanvasChange(fpBefore, 5000);
    }

    // 7. Wait for canvas ready
    await waitCanvasReady(5000);

    // 8. Extra settle time for rendering
    await delay(Math.max(200, liveSettings.capDelay));

    // 9. Capture with retries
    var result = null;
    for (var att = 0; att < 3; att++) {
      if (att > 0) await delay(liveSettings.capDelay);
      result = await callInject('capturePageOnly', { pageNum: targetPage });
      if (result && result.ok) break;
    }

    // 10. Final verification: confirm viewer still shows the right page
    try {
      var finalPage = await callInject('getViewerPageNum');
      if (finalPage !== targetPage) {
        return { ok: false, error: 'page_shifted_to_' + finalPage };
      }
    } catch (e) {}

    return result || { ok: false, error: 'capture_returned_null' };
  }

  // ── 6. Floating control banner ──
  var overlay = null, overlayRoot = null;
  var overlayPanelOpen = false;
  var pageInfoInterval = null;
  var oPageInputFocused = false;
  var oRangeStartFocused = false;
  var oRangeEndFocused = false;
  var isNavigating = false;

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'kyobo-ext-fab';
    var shadow = overlay.attachShadow({ mode: 'closed' });
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
      '</style>' +
      '<div id="toast"></div>' +
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
              '<button class="cbtn cbtn-start" id="oStart">범위 캡처 시작</button>' +
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
    overlayRoot = shadow;
    document.body.appendChild(overlay);

    // Block events from leaking to viewer (bubbling phase so shadow DOM handlers fire first)
    ['mousedown','mouseup','mousemove','mouseover','mouseout','mouseenter','mouseleave',
     'click','dblclick','contextmenu','wheel',
     'pointerdown','pointerup','pointermove','pointerover','pointerout','pointerenter','pointerleave',
     'touchstart','touchmove','touchend','touchcancel',
     'keydown','keyup','keypress'].forEach(function (type) {
      overlay.addEventListener(type, function (ev) { ev.stopPropagation(); });
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
        if (path[i] === overlay) return;
      }
      overlayPanelOpen = false;
      if (overlayRoot) overlayRoot.getElementById('panel').classList.remove('open');
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
        await callInject(action, extra);
        await delay(1000);
      } catch (e) {}
      try {
        var p = await callInject('getViewerPageNum');
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
    oRS.addEventListener('focus', function () { oRangeStartFocused = true; });
    oRS.addEventListener('blur', function () { oRangeStartFocused = false; });
    oRE.addEventListener('focus', function () { oRangeEndFocused = true; });
    oRE.addEventListener('blur', function () { oRangeEndFocused = false; });

    // Capture start (range)
    shadow.getElementById('oStart').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (isCapturing) return;
      var sp = parseInt(oRS.value, 10) || 1;
      var ep = parseInt(oRE.value, 10) || 0;
      chrome.storage.local.get({ autoRetry: true, captureDelay: 500 }, function (settings) {
        var mp = MODES[liveSettings.mode] || MODES.normal;
        startCapture({
          startPage: sp, endPage: ep,
          mode: liveSettings.mode, autoRetry: settings.autoRetry !== false,
          captureDelay: settings.captureDelay || mp.cap || 500,
          pageDelayMin: mp.min, pageDelayMax: mp.max,
          resume: false
        });
      });
    });

    // Pause/Resume
    shadow.getElementById('oPause').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (isCapturing) {
        isPaused = !isPaused;
        this.textContent = isPaused ? '계속' : '일시정지';
        this.className = isPaused ? 'cbtn cbtn-start' : 'cbtn cbtn-pause';
        setOState(isPaused ? 'paused' : 'active');
      }
    });

    // Stop
    shadow.getElementById('oStop').addEventListener('click', function (ev) {
      ev.stopPropagation();
      shouldStop = true;
      isPaused = false;
    });

    // Mode buttons
    shadow.querySelectorAll('.mbtn').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        applyMode(this.dataset.m);
      });
    });

    // Rescan missing pages
    shadow.getElementById('oRescanMissing').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (isCapturing || missingPages.length === 0) return;
      var mp = MODES[liveSettings.mode] || MODES.normal;
      chrome.storage.local.get({ autoRetry: true, captureDelay: 500 }, function (settings) {
        startRescanMissing(missingPages.slice(), {
          mode: liveSettings.mode,
          autoRetry: settings.autoRetry !== false,
          captureDelay: settings.captureDelay || mp.cap || 500,
          pageDelayMin: mp.min, pageDelayMax: mp.max
        });
      });
    });

    // Open session manager
    shadow.getElementById('oOpenSession').addEventListener('click', function (ev) {
      ev.stopPropagation();
      var title = getBookTitle();
      chrome.runtime.sendMessage({
        target: 'background', action: 'openSessions',
        title: title || undefined,
        bookId: title ? undefined : getBookId()
      }, function () { void chrome.runtime.lastError; });
    });

    startPageInfoPoll();
  }

  function startPageInfoPoll() {
    if (pageInfoInterval) clearInterval(pageInfoInterval);
    pageInfoInterval = setInterval(function () {
      if (!overlayRoot) return;
      callInject('getPageInfo').then(function (info) {
        if (!info) return;
        var pill = overlayRoot.getElementById('oPillPage');
        var inp = overlayRoot.getElementById('oPageInput');
        var tot = overlayRoot.getElementById('oPageTotal');
        var re = overlayRoot.getElementById('oRangeEnd');
        if (pill) pill.textContent = (info.current || '-') + '/' + (info.total || '-');
        if (tot) tot.textContent = '/ ' + (info.total || '-');
        if (inp && !oPageInputFocused) inp.value = info.current || 1;
        // Auto-fill range with smart defaults on first load
        if (re && !oRangeEndFocused && re.value === '1' && info.total > 1) {
          re.value = info.total;
          // Set start to first uncached page
          autoFillRangeStart(info.total);
        }
      }).catch(function () {});
    }, 2000);
  }

  function autoFillRangeStart(total) {
    if (!overlayRoot) return;
    var rs = overlayRoot.getElementById('oRangeStart');
    if (!rs || oRangeStartFocused) return;

    // Get bookId - try resolved, then title-based
    var bid = getBookId();
    var title = getBookTitle();
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
      callInject('getCacheInfo').then(function (ci) {
        if (ci && ci.cachedPageNums) ci.cachedPageNums.forEach(function (p) { cachedSet[p] = true; });
      }).catch(function () {}).then(function () {
        if (Object.keys(cachedSet).length === 0) return;

        // Find first missing page
        for (var p = 1; p <= total; p++) {
          if (!cachedSet[p]) {
            rs.value = p;
            return;
          }
        }
        rs.value = 1;
      });
    });
  }

  function showToast(msg, duration) {
    if (!overlayRoot) return;
    var t = overlayRoot.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, duration || 3000);
  }

  function updateOModeHighlight() {
    if (!overlayRoot) return;
    overlayRoot.querySelectorAll('.mbtn').forEach(function (btn) {
      btn.classList.toggle('on', btn.dataset.m === liveSettings.mode);
    });
  }

  function setOState(s) {
    if (!overlayRoot) return;
    var dot = overlayRoot.getElementById('oDot');
    var text = overlayRoot.getElementById('oText');
    var idleRow = overlayRoot.getElementById('oIdleRow');
    var capRow = overlayRoot.getElementById('oCapRow');
    var prog = overlayRoot.getElementById('oProg');

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
      var pauseBtn = overlayRoot.getElementById('oPause');
      if (pauseBtn) { pauseBtn.textContent = '일시정지'; pauseBtn.className = 'cbtn cbtn-pause'; }
    } else if (s === 'paused') {
      if (text) text.textContent = '일시정지';
    } else if (s === 'error') {
      if (text) text.textContent = '오류';
      if (idleRow) idleRow.style.display = '';
      if (capRow) capRow.style.display = 'none';
      if (prog) prog.classList.remove('on');
    }
  }

  // bookTotal: absolute total pages of the book (for progress bar)
  // capturedSoFar: total cached pages including previously cached ones
  var _bookTotal = 0;

  function updateO(capturedSoFar, bookTotal, page) {
    if (!overlayRoot) return;
    var text = overlayRoot.getElementById('oText');
    var pr = overlayRoot.getElementById('oPr');
    var bar = overlayRoot.getElementById('oBar');
    if (bookTotal > 0) _bookTotal = bookTotal;
    var bt = _bookTotal || bookTotal;
    var pct = bt > 0 ? Math.round(capturedSoFar / bt * 100) : 0;
    if (text && !isPaused) text.textContent = '캡처 진행중...';
    if (pr) pr.textContent = capturedSoFar + '/' + bt + ' (' + pct + '%)' + (page ? '  p' + page : '');
    if (bar) bar.style.width = pct + '%';
  }

  function showMissingPages(missing) {
    if (!overlayRoot) return;
    var el = overlayRoot.getElementById('oMiss');
    var txt = overlayRoot.getElementById('oMissText');
    var lst = overlayRoot.getElementById('oMissList');
    if (!el) return;
    if (!missing || missing.length === 0) {
      el.classList.remove('on');
      return;
    }
    el.classList.add('on');
    txt.textContent = missing.length + '개 페이지 누락';
    lst.textContent = missing.join(', ');
  }

  // ── 7. Recovery ──
  function getBookTitle() {
    try { return document.querySelector('[data-layout="title"]').textContent.trim(); } catch (e) { return ''; }
  }

  function saveSession(opts, page, callback) {
    chrome.storage.local.set({ pendingSession: {
      url: location.href, pathname: location.pathname,
      bookTitle: getBookTitle(), options: Object.assign({}, opts), lastPage: page, timestamp: Date.now()
    } }, callback || function () {});
  }
  function clearSession() { chrome.storage.local.remove('pendingSession'); }

  var recoveryInFlight = false;

  function triggerRecovery(resumePage) {
    recoveryInFlight = true;
    var title = getBookTitle();
    var opts = Object.assign({}, captureSession || {}, { resume: true });
    saveSession(opts, resumePage, function () {
      notifyPopup('autoRetrying', { bookTitle: title, lastPage: resumePage });
      isCapturing = false; shouldStop = true;
      chrome.runtime.sendMessage({
        target: 'background', action: 'recovery',
        bookTitle: title
      }, function () { void chrome.runtime.lastError; });
    });
  }

  function handleAbnormal() {
    var resumePage = (captureSession && captureSession._currentPage) || (captureSession && captureSession.startPage) || 1;
    if (captureSession) {
      triggerRecovery(resumePage);
    } else {
      var title = getBookTitle();
      if (title) {
        chrome.runtime.sendMessage({
          target: 'background', action: 'recovery',
          bookTitle: title
        }, function () { void chrome.runtime.lastError; });
      }
    }
  }

  function checkPendingSession() {
    chrome.storage.local.get('pendingSession', function (data) {
      var s = data.pendingSession;
      if (!s || Date.now() - s.timestamp > 600000) { clearSession(); return; }
      var match = false;
      if (s.url === location.href) { match = true; }
      else if (s.pathname && s.pathname === location.pathname) { match = true; }
      else { try { match = new URL(s.url).pathname === location.pathname; } catch (e) {} }
      // Recovery reopens the same book on the viewer domain — always match
      if (!match && location.hostname === 'wviewer.kyobobook.co.kr') { match = true; }
      if (!match) { clearSession(); return; }
      clearSession();

      if (!s.options || s.options.autoRetry === false) return;

      setTimeout(function () {
        var opts = Object.assign({}, s.options, {
          startPage: s.lastPage || s.options.startPage,
          resume: true
        });
        startCapture(opts);
        notifyPopup('captureStarted', {});
      }, 5000);
    });
  }

  // ── 8. Main capture (goToPage-based, with verification) ──
  async function startCapture(options) {
    isCapturing = true; shouldStop = false; isPaused = false;
    captureSession = Object.assign({}, options, { _currentPage: options.startPage || 1 });
    missingPages = [];

    var startPage = options.startPage || 1;
    var endPage = options.endPage || 0;
    var capDelay = Math.max(100, Math.min(5000, options.captureDelay || 500));
    var resume = options.resume || false;
    var autoRetry = options.autoRetry !== false;

    liveSettings.dMin = Math.max(100, Math.min(30000, options.pageDelayMin || 800));
    liveSettings.dMax = Math.max(liveSettings.dMin, Math.min(30000, options.pageDelayMax || 1500));
    liveSettings.mode = options.mode || 'normal';
    liveSettings.stealth = (liveSettings.mode === 'stealth' || liveSettings.mode === 'careful');
    liveSettings.capDelay = capDelay;

    createOverlay(); setOState('active'); updateOModeHighlight();
    showMissingPages([]);
    notifyPopup('captureStarted', {});

    try {
      await callInject('clearState');
      var pi = await callInject('getPageInfo');
      var total = pi.total || 0;
      var title = pi.title || 'ebook';
      if (endPage <= 0 || endPage > total) endPage = total;
      if (total === 0) { notifyPopup('captureError', { message: '페이지 정보 없음' }); isCapturing = false; setOState('error'); return; }

      // Save session early so /invalidUse redirect can recover
      saveSession(Object.assign({}, options, { resume: true }), startPage);

      // Resolve stable book ID (title-based, survives URL changes)
      // Check BOTH inject.js (MAIN world) DB and extension DB for existing cache
      try {
        resolvedBookId = await callInject('resolveBookId', { title: title });
      } catch (e) {
        resolvedBookId = null;
      }
      // Also check extension-level DB (more persistent, survives site data clears)
      if (!resolvedBookId || resolvedBookId === 'title:' + title) {
        try {
          var bgLookup = await new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              target: 'background', action: 'findBookByTitle', title: title
            }, function (r) { void chrome.runtime.lastError; resolve(r); });
          });
          if (bgLookup && bgLookup.bookId && bgLookup.bookId !== resolvedBookId) {
            // Extension DB has data under a different ID - adopt it for consistency
            resolvedBookId = bgLookup.bookId;
          }
        } catch (e) {}
      }
      if (!resolvedBookId) resolvedBookId = 'title:' + title;

      // Migrate extension-level cache FIRST (before writing new metadata)
      var urlId = location.pathname + location.search;
      if (resolvedBookId !== urlId) {
        try {
          await new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              target: 'background', action: 'migrateBookCache',
              oldBookId: urlId, newBookId: resolvedBookId, title: title
            }, function (r) { void chrome.runtime.lastError; resolve(r); });
          });
        } catch (e) {}
      }

      var cached = {};
      // Only skip cached pages in resume mode - new scan overwrites everything
      if (resume) {
        try {
          var ci = await callInject('getCacheInfo');
          if (ci && ci.cachedPageNums) ci.cachedPageNums.forEach(function (p) { cached[p] = true; });
        } catch (e) {}
        try {
          var extPages = await new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              target: 'background', action: 'getPagesInfo', bookId: getBookId()
            }, function (r) { void chrome.runtime.lastError; resolve(r); });
          });
          if (extPages && extPages.pages) {
            var extSet = {};
            extPages.pages.forEach(function (p) { extSet[p] = true; });
            for (var cp in cached) {
              if (!extSet[cp]) delete cached[cp];
            }
            extPages.pages.forEach(function (p) { cached[p] = true; });
          }
        } catch (e) {}
      }

      // Count total cached pages across the whole book (for absolute progress)
      var totalCached = Object.keys(cached).length;
      _bookTotal = total;

      notifyPopup('captureProgress', { current: totalCached, total: total, message: '준비 중...' });
      var dims = await callInject('getCanvasDimensions');
      if (!dims) { notifyPopup('captureError', { message: '캔버스 없음' }); isCapturing = false; setOState('error'); return; }

      var toc = []; try { toc = await callInject('getTOC'); } catch (e) {}
      // Write fresh metadata AFTER migration (overwrites any stale migrated data)
      forwardToBackground('cacheBookMeta', { bookId: getBookId(), title: title, totalPages: total, toc: toc });

      // Focus viewer tab for canvas rendering
      await focusViewerTab();
      await delay(500);

      // Wait for initial canvas ready
      var stableCount = 0;
      for (var sw = 0; sw < 20 && stableCount < 2 && !shouldStop; sw++) {
        var ready = await callInject('canvasReady');
        if (ready) stableCount++;
        else stableCount = 0;
        await delay(500);
      }

      var captured = 0, skipped = 0, consErr = 0;

      for (var page = startPage; page <= endPage; page++) {
        if (shouldStop) { notifyPopup('captureStopped', { capturedCount: totalCached }); break; }
        while (isPaused && !shouldStop) await delay(500);

        captureSession._currentPage = page;

        // Ensure viewer is in foreground
        if (document.hidden) {
          await focusViewerTab();
          await delay(400);
        }

        // ALWAYS skip cached pages (not just in resume mode)
        if (cached[page]) {
          skipped++;
          consErr = 0;
          updateO(totalCached, total, page);
          notifyPopup('captureProgress', { current: totalCached, total: total, page: page, message: page + 'p 캐시 건너뜀' });
          continue;
        }

        // Navigate to page and capture (reads actual viewer position each time)
        var result = await navigateAndCapture(page);

        if (result && result.ok) {
          captured++; totalCached++; consErr = 0;
          // Mark as cached so re-runs skip this page
          cached[page] = true;
          if (result.dataURL) {
            forwardToBackground('cachePage', { bookId: result.bookId, pageNum: result.pageNum, dataURL: result.dataURL, width: result.width, height: result.height });
          }
          // Warn if MAIN world cache write failed (data still sent to background cache)
          if (result.cached === false) {
            notifyPopup('captureProgress', { current: totalCached, total: total, page: page, message: page + 'p 캐시 쓰기 실패 (백업 저장됨)' });
          }
          updateO(totalCached, total, page);
          notifyPopup('captureProgress', { current: totalCached, total: total, page: page, message: totalCached + '/' + total + ' 캡처 완료' });
        } else {
          // Page failed - retry up to 3 times before giving up
          var retried = false;
          var errReason = (result && result.error) ? result.error : 'unknown';
          for (var retryN = 1; retryN <= 3 && !shouldStop; retryN++) {
            notifyPopup('captureProgress', { current: totalCached, total: total, page: page, message: page + 'p 재시도 ' + retryN + '/3...' });
            updateO(totalCached, total, page);
            await delay(liveSettings.dMin * 2);

            if (document.hidden) { await focusViewerTab(); await delay(400); }
            result = await navigateAndCapture(page);
            if (result && result.ok) {
              retried = true;
              captured++; totalCached++; consErr = 0;
              cached[page] = true;
              if (result.dataURL) {
                forwardToBackground('cachePage', { bookId: result.bookId, pageNum: result.pageNum, dataURL: result.dataURL, width: result.width, height: result.height });
              }
              updateO(totalCached, total, page);
              notifyPopup('captureProgress', { current: totalCached, total: total, page: page, message: page + 'p 재시도 성공' });
              break;
            }
          }

          if (!retried) {
            consErr++;
            missingPages.push(page);
            notifyPopup('captureProgress', { current: totalCached, total: total, page: page, message: page + 'p 실패 (3회 재시도 후): ' + errReason });
            showToast(page + 'p 캡처 실패', 3000);

            if (consErr >= 3) {
              if (autoRetry) { triggerRecovery(page); return; }
              notifyPopup('captureError', { message: '연속 ' + consErr + '회 실패: ' + errReason }); break;
            }
          }
        }

        // Delay between pages
        if (page < endPage && !shouldStop) {
          await randomDelay(liveSettings.dMin, liveSettings.dMax, liveSettings.stealth);
        }
      }

      try { await callInject('updateBookMeta', { title: title, totalPages: total, toc: toc }); } catch (e) {}

      // ── Post-capture verification: find all missing pages ──
      if (!shouldStop) {
        try {
          var cacheInfo = await callInject('getCacheInfo');
          var cachedNums = (cacheInfo && cacheInfo.cachedPageNums) || [];
          var cachedSet = {};
          cachedNums.forEach(function (n) { cachedSet[n] = true; });
          var allMissing = [];
          for (var p = startPage; p <= endPage; p++) {
            if (!cachedSet[p]) allMissing.push(p);
          }
          missingPages = allMissing;
        } catch (e) {}
      }

      showMissingPages(missingPages);

      // ── Auto-retry blank pages ──
      if (!shouldStop && captured > 0) {
        var doBlankRetry = false;
        try {
          var blankSettings = await new Promise(function (resolve) {
            chrome.storage.local.get({ autoRetryBlank: false }, function (d) { resolve(d); });
          });
          doBlankRetry = !!blankSettings.autoRetryBlank;
        } catch (e) {}

        if (doBlankRetry) {
          var blankPages = [];
          try {
            var checkResult = await callInject('findBlankPages', { startPage: startPage, endPage: endPage });
            if (checkResult && checkResult.length > 0) blankPages = checkResult;
          } catch (e) {}

          if (blankPages.length > 0) {
            showToast(blankPages.length + '개 빈 페이지 감지 - 자동 재시도...', 4000);
            notifyPopup('captureProgress', { current: totalCached, total: total, message: blankPages.length + '개 빈 페이지 재시도 중...' });

            for (var bi = 0; bi < blankPages.length && !shouldStop; bi++) {
              var bp = blankPages[bi];
              await delay(liveSettings.dMin);
              if (document.hidden) { await focusViewerTab(); await delay(400); }
              var bResult = await navigateAndCapture(bp);
              if (bResult && bResult.ok) {
                if (bResult.dataURL) {
                  forwardToBackground('cachePage', { bookId: bResult.bookId, pageNum: bResult.pageNum, dataURL: bResult.dataURL, width: bResult.width, height: bResult.height });
                }
                updateO(totalCached, total, bp);
              }
            }
          }
        }
      }

      if (captured > 0 && !shouldStop) {
        var isComplete = missingPages.length === 0 && totalCached >= total;
        var msg = totalCached + '/' + total + '페이지 캡처 완료';
        if (missingPages.length > 0) msg += ' (' + missingPages.length + '개 누락)';
        showToast(msg, 5000);
        setOState('idle');
        notifyPopup('captureComplete', {
          capturedCount: totalCached, title: title, partial: shouldStop,
          missing: missingPages.length, missingPages: missingPages
        });
        // Open sessions tab and close viewer
        setTimeout(function () {
          chrome.runtime.sendMessage({
            target: 'background', action: 'openSessions',
            title: title
          }, function () {
            void chrome.runtime.lastError;
            setTimeout(function () { window.close(); }, 500);
          });
        }, 2000);
      } else if (shouldStop) {
        setOState('idle');
      }
      clearSession();
    } catch (err) {
      notifyPopup('captureError', { message: err.message }); setOState('error');
      if (captureSession && captureSession.autoRetry) { triggerRecovery(captureSession._currentPage || startPage); return; }
    } finally {
      if (!recoveryInFlight) {
        isCapturing = false; shouldStop = false; captureSession = null;
      }
    }
  }

  // ── 9. Rescan missing pages ──
  async function startRescanMissing(pageList, opts) {
    if (isCapturing || !pageList || pageList.length === 0) return;
    isCapturing = true; shouldStop = false; isPaused = false;

    liveSettings.dMin = Math.max(100, opts.pageDelayMin || 800);
    liveSettings.dMax = Math.max(liveSettings.dMin, opts.pageDelayMax || 1500);
    liveSettings.capDelay = opts.captureDelay || 500;

    setOState('active');
    var total = pageList.length;
    var rescanned = 0;
    var stillMissing = [];

    for (var i = 0; i < total; i++) {
      if (shouldStop) break;
      while (isPaused && !shouldStop) await delay(500);

      var pn = pageList[i];
      updateO(i + 1, total, pn);

      if (document.hidden) {
        await focusViewerTab();
        await delay(400);
      }

      var result = await navigateAndCapture(pn);

      if (result && result.ok) {
        rescanned++;
        if (result.dataURL) {
          forwardToBackground('cachePage', { bookId: result.bookId, pageNum: result.pageNum, dataURL: result.dataURL, width: result.width, height: result.height });
        }
      } else {
        stillMissing.push(pn);
      }

      if (i < total - 1 && !shouldStop) {
        await randomDelay(liveSettings.dMin, liveSettings.dMax, liveSettings.stealth);
      }
    }

    missingPages = stillMissing;
    showMissingPages(missingPages);
    isCapturing = false; shouldStop = false;
    setOState('idle');
    showToast(rescanned + '페이지 재스캔 완료' + (stillMissing.length > 0 ? ' (' + stillMissing.length + '개 여전히 누락)' : ''), 4000);
  }

  // ── 10. Pending capture from library ──
  function checkPendingCapture() {
    chrome.storage.local.get('pendingCapture', function (data) {
      var pc = data.pendingCapture;
      if (!pc || Date.now() - pc.timestamp > 300000) {
        chrome.storage.local.remove('pendingCapture');
        return;
      }
      chrome.storage.local.remove('pendingCapture');
      if (pc.action !== 'resume') return;

      setTimeout(function () {
        chrome.storage.local.get({ autoRetry: true, captureDelay: 500 }, function (settings) {
          startCapture({
            startPage: 1, endPage: 0,
            mode: 'normal', autoRetry: settings.autoRetry !== false,
            captureDelay: settings.captureDelay || 500,
            pageDelayMin: 800, pageDelayMax: 1500,
            resume: true
          });
          notifyPopup('captureStarted', {});
        });
      }, 5000);
    });
  }

  // ── 11. Auto-cache book metadata on viewer load ──
  async function cacheBookMetaOnLoad() {
    if (isCapturing) return;

    // Retry up to 5 times - viewer may not be ready yet
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        var pi = await callInject('getPageInfo');
        if (pi && pi.title && pi.total) {
          var title = pi.title;
          var total = pi.total;

          // Resolve stable book ID
          var bookId = 'title:' + title;
          try {
            var resolved = await callInject('resolveBookId', { title: title });
            if (resolved) bookId = resolved;
          } catch (e) {}
          resolvedBookId = bookId;

          // Get TOC
          var toc = [];
          try { toc = await callInject('getTOC'); } catch (e) {}

          // Cache to extension DB via background
          chrome.runtime.sendMessage({
            target: 'background', action: 'cacheBookMeta',
            bookId: bookId, title: title, totalPages: total, toc: toc
          }, function (r) {
            void chrome.runtime.lastError;
            if (r && r.success) {
              notifyPopup('bookMetaCached', { bookId: bookId, title: title, totalPages: total });
            }
          });
          return;
        }
      } catch (e) {}
      await delay(2000);
    }
  }

  // ── 12. Detect /invalidUse redirect ──
  function checkInvalidUse() {
    var isInvalid = location.pathname.indexOf('invalidUse') !== -1 ||
        location.href.indexOf('invalidUse') !== -1 ||
        document.title.indexOf('비정상') !== -1;

    if (!isInvalid) {
      // Also check page content after a short delay
      setTimeout(function () {
        if (document.title.indexOf('비정상') !== -1 ||
            (document.body && document.body.textContent.indexOf('정상적인 접근이 아니므로') !== -1)) {
          handleInvalidUse();
        }
      }, 1000);
      return false;
    }

    handleInvalidUse();
    return true;
  }

  function handleInvalidUse() {
    notifyPopup('captureError', { message: '비정상 접근으로 뷰어가 차단되었습니다' });

    chrome.storage.local.get(['autoRetry', 'pendingSession', 'pendingCapture'], function (data) {
      var autoRetry = data.autoRetry !== false;
      var bookTitle = '';

      // Try all sources for book title
      if (data.pendingSession && data.pendingSession.bookTitle) {
        bookTitle = data.pendingSession.bookTitle;
      } else if (data.pendingCapture && data.pendingCapture.bookTitle) {
        bookTitle = data.pendingCapture.bookTitle;
      }

      // Last resort: ask background for most recent book
      if (!bookTitle) {
        chrome.runtime.sendMessage({
          target: 'background', action: 'getRecentBookTitle'
        }, function (r) {
          void chrome.runtime.lastError;
          if (r && r.title) {
            triggerInvalidRecovery(autoRetry, r.title);
          } else {
            triggerInvalidRecovery(false, '');
          }
        });
        return;
      }

      triggerInvalidRecovery(autoRetry, bookTitle);
    });
  }

  function triggerInvalidRecovery(autoRetry, bookTitle) {
    if (autoRetry && bookTitle) {
      notifyPopup('autoRetrying', { bookTitle: bookTitle });
      chrome.runtime.sendMessage({
        target: 'background', action: 'recovery',
        bookTitle: bookTitle
      }, function () { void chrome.runtime.lastError; });
    } else {
      notifyPopup('captureError', {
        message: '비정상 접근 차단됨' + (bookTitle ? ' (' + bookTitle + ')' : '') + ' - 수동으로 뷰어를 다시 열어주세요'
      });
    }
  }

  // ── Init ──
  if (checkInvalidUse()) {
    // On /invalidUse page - skip normal init, just handle recovery
  } else {
    createOverlay();
    checkPendingSession();
    setTimeout(function () {
      if (!isCapturing) checkPendingCapture();
    }, 6000);
    setTimeout(function () {
      if (!isCapturing) cacheBookMetaOnLoad();
    }, 4000);
  }
})();
