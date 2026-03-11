(function () {
  'use strict';

  var isCapturing = false;
  var shouldStop = false;
  var isPaused = false;
  var pendingCallbacks = {};
  var sessionId = Math.random().toString(36).slice(2, 10);
  var callbackSeq = 0;
  var captureSession = null;

  // ── Live settings (modifiable during capture) ──
  var MODES = {
    fast:    { min: 300,  max: 600 },
    normal:  { min: 800,  max: 1500 },
    stealth: { min: 2000, max: 5000 }
  };
  var liveSettings = { dMin: 800, dMax: 1500, stealth: false, mode: 'normal', capDelay: 500 };

  function applyMode(mode) {
    liveSettings.mode = mode;
    liveSettings.stealth = (mode === 'stealth');
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

  // ── 2. Popup communication ──
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'ping') { sendResponse({ status: 'ready', isCapturing: isCapturing }); return true; }
    if (msg.action === 'getPageInfo') { callInject('getPageInfo').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'getTOC') { callInject('getTOC').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'startCapture') { if (isCapturing) { sendResponse({ success: false, error: '이미 캡처 중' }); return true; } startCapture(msg.options || {}); sendResponse({ success: true }); return true; }
    if (msg.action === 'stopCapture') { shouldStop = true; sendResponse({ success: true }); return true; }
    if (msg.action === 'getStatus') { sendResponse({ isCapturing: isCapturing, shouldStop: shouldStop }); return true; }
    if (msg.action === 'getProgress') { callInject('getCapturedCount').then(function (c) { sendResponse({ capturedCount: c, isCapturing: isCapturing }); }).catch(function () { sendResponse({ capturedCount: 0, isCapturing: isCapturing }); }); return true; }
    if (msg.action === 'getCacheInfo') { callInject('getCacheInfo').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'buildPDFFromCache') { callInject('buildPDFFromCache', { extensionBaseURL: chrome.runtime.getURL(''), title: msg.title || 'ebook', toc: msg.toc || [], targetSize: msg.targetSize || null }).then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'clearCache') { callInject('clearCache').then(function () { sendResponse({ success: true }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'changeMode') { applyMode(msg.mode || 'normal'); sendResponse({ success: true }); return true; }
    if (msg.action === 'pauseCapture') { isPaused = true; sendResponse({ success: true }); return true; }
    if (msg.action === 'resumeCapture') { isPaused = false; sendResponse({ success: true }); return true; }
    if (msg.action === 'recapturePage') {
      (async function () {
        try {
          if (isCapturing) { sendResponse({ success: false, error: 'Capture in progress' }); return; }
          await callInject('goToPage', { pageNum: msg.pageNum });
          await delay(1500);
          var rr = await callInject('capturePageOnly', { pageNum: msg.pageNum });
          if (rr && rr.ok) {
            forwardToBackground('cachePage', { bookId: rr.bookId, pageNum: rr.pageNum, dataURL: rr.dataURL, width: rr.width, height: rr.height });
            sendResponse({ success: true, data: rr });
          } else { sendResponse({ success: false, error: 'Capture failed' }); }
        } catch (e) { sendResponse({ success: false, error: e.message }); }
      })();
      return true;
    }
    return false;
  });

  // ── 3. Notify popup ──
  function notifyPopup(type, data) {
    try { chrome.runtime.sendMessage({ source: 'KYOBO_CONTENT', type: type, data: data }); } catch (e) {}
  }

  // ── 3a. Forward to background ──
  function forwardToBackground(action, data) {
    try {
      chrome.runtime.sendMessage(Object.assign({ target: 'background', action: action }, data || {}), function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  function getBookId() { return location.pathname + location.search; }

  // ── 4. Helpers ──
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function randomInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function randomDelay(lo, hi, stealth) {
    var d = randomInt(lo, hi);
    if (stealth) { if (Math.random() < 0.15) d += randomInt(2000, 6000); if (Math.random() < 0.05) d += randomInt(5000, 15000); }
    return delay(d);
  }
  function waitForPageChange(expected, timeout) {
    var deadline = Date.now() + (timeout || 10000);
    return new Promise(function (resolve) {
      (function check() {
        if (Date.now() > deadline) { resolve(false); return; }
        callInject('getPageInfo').then(function (i) { i.current === expected ? resolve(true) : setTimeout(check, 200); }).catch(function () { setTimeout(check, 200); });
      })();
    });
  }

  // ── 5. Floating overlay (redesigned) ──
  var overlay = null, overlayRoot = null;

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'kyobo-ext-fab';
    var shadow = overlay.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' +
      ':host{all:initial}' +
      '#fab{position:fixed;bottom:24px;right:24px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
      // Pill - bigger, click = pause/resume
      '#pill{display:flex;align-items:center;gap:9px;padding:10px 20px;background:rgba(26,26,46,.94);color:#fff;border-radius:26px;cursor:pointer;font-size:14px;font-weight:600;box-shadow:0 3px 18px rgba(0,0,0,.4);transition:all .2s;backdrop-filter:blur(10px);user-select:none}' +
      '#pill:hover{background:rgba(26,26,46,.98);transform:scale(1.04)}' +
      '#pill:active{transform:scale(.97)}' +
      '.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}' +
      '.idle{background:#6b7280}.active{background:#10b981;animation:pulse 1.5s infinite}.paused{background:#f59e0b}.error{background:#ef4444}' +
      '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}' +
      // Panel - appears on hover, bridge prevents disappear
      '#panel{display:none;position:absolute;bottom:calc(100% + 4px);right:0;background:rgba(26,26,46,.96);border-radius:14px;padding:16px;min-width:240px;backdrop-filter:blur(10px);box-shadow:0 6px 28px rgba(0,0,0,.5)}' +
      '#panel::after{content:"";position:absolute;top:100%;left:0;right:0;height:8px}' +
      '#fab:hover #panel{display:block}' +
      '.row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;color:rgba(255,255,255,.65)}.val{color:#fff;font-weight:600}' +
      '.bar{height:4px;background:rgba(255,255,255,.12);border-radius:2px;margin:8px 0;overflow:hidden}.bf{height:100%;background:linear-gradient(90deg,#e94560,#c23152);border-radius:2px;transition:width .3s;width:0%}' +
      // Mode buttons in panel
      '.modes{display:flex;gap:4px;margin:10px 0 8px}' +
      '.mbtn{flex:1;padding:5px 2px;border:1px solid rgba(255,255,255,.15);border-radius:7px;background:transparent;color:rgba(255,255,255,.6);font-size:11px;font-weight:600;text-align:center;cursor:pointer;transition:all .12s}' +
      '.mbtn:hover{background:rgba(255,255,255,.08);color:#fff}' +
      '.mbtn.on{border-color:#e94560;background:rgba(233,69,96,.18);color:#e94560}' +
      // Stop button
      '.stop-btn{width:100%;padding:7px;border:1px solid #ef4444;border-radius:8px;background:transparent;color:#ef4444;font-size:12px;font-weight:600;cursor:pointer;text-align:center;transition:all .12s}' +
      '.stop-btn:hover{background:rgba(239,68,68,.15)}' +
      '</style>' +
      '<div id="fab">' +
        '<div id="pill"><span class="dot idle" id="oDot"></span><span id="oText">PDF 대기</span></div>' +
        '<div id="panel">' +
          '<div class="row"><span>상태</span><span class="val" id="oSt">대기</span></div>' +
          '<div class="row"><span>진행</span><span class="val" id="oPr">0/0</span></div>' +
          '<div class="bar"><div class="bf" id="oBar"></div></div>' +
          '<div class="row" style="margin-bottom:2px"><span>모드 (실시간 변경)</span></div>' +
          '<div class="modes">' +
            '<div class="mbtn" data-m="fast">빠름</div>' +
            '<div class="mbtn on" data-m="normal">일반</div>' +
            '<div class="mbtn" data-m="stealth">스텔스</div>' +
          '</div>' +
          '<div class="stop-btn" id="oStop">&#9632; 캡처 중지</div>' +
        '</div>' +
      '</div>';
    overlayRoot = shadow;
    document.body.appendChild(overlay);

    // Pill click = toggle pause/resume
    shadow.getElementById('pill').addEventListener('click', function () {
      if (!isCapturing) return;
      isPaused = !isPaused;
      setOState(isPaused ? 'paused' : 'active');
    });

    // Stop button
    shadow.getElementById('oStop').addEventListener('click', function (ev) {
      ev.stopPropagation();
      shouldStop = true;
    });

    // Mode buttons
    shadow.querySelectorAll('.mbtn').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        applyMode(this.dataset.m);
      });
    });
  }

  function updateOModeHighlight() {
    if (!overlayRoot) return;
    overlayRoot.querySelectorAll('.mbtn').forEach(function (btn) {
      btn.classList.toggle('on', btn.dataset.m === liveSettings.mode);
    });
  }

  function setOState(s) {
    if (!overlayRoot) return;
    var d = overlayRoot.getElementById('oDot'), t = overlayRoot.getElementById('oText'), st = overlayRoot.getElementById('oSt');
    if (d) d.className = 'dot ' + s;
    if (s === 'idle') { if (t) t.textContent = 'PDF 대기'; if (st) st.textContent = '대기'; }
    if (s === 'paused') { if (t) t.textContent = '|| 일시정지 (클릭→계속)'; if (st) st.textContent = '일시정지'; }
    if (s === 'active') { if (st) st.textContent = '캡처중'; }
    if (s === 'error') { if (t) t.textContent = '오류'; if (st) st.textContent = '오류'; }
  }

  function updateO(cur, total, page, mode) {
    if (!overlayRoot) return;
    var t = overlayRoot.getElementById('oText'), pr = overlayRoot.getElementById('oPr'), bar = overlayRoot.getElementById('oBar');
    var pct = total > 0 ? Math.round(cur / total * 100) : 0;
    if (t && !isPaused) t.textContent = cur + '/' + total + ' (' + pct + '%) 캡처중';
    if (pr) pr.textContent = cur + '/' + total + (page ? '  p' + page : '');
    if (bar) bar.style.width = pct + '%';
    var st = overlayRoot.getElementById('oSt');
    if (st && !isPaused) st.textContent = '캡처중';
  }

  // ── 6. Auto-retry ──
  function saveSession(opts, page) {
    chrome.storage.local.set({ pendingSession: { url: location.href, options: opts, lastPage: page, timestamp: Date.now() } });
  }
  function clearSession() { chrome.storage.local.remove('pendingSession'); }

  function handleAbnormal() {
    if (!captureSession || !captureSession.autoRetry) return;
    saveSession(captureSession, captureSession._currentPage || captureSession.startPage);
    notifyPopup('autoRetrying', {});
    setTimeout(function () { location.reload(); }, randomInt(3000, 8000));
  }

  function checkPendingSession() {
    chrome.storage.local.get('pendingSession', function (data) {
      var s = data.pendingSession;
      if (!s || s.url !== location.href || Date.now() - s.timestamp > 300000) { clearSession(); return; }
      clearSession();
      setTimeout(function () {
        var opts = s.options;
        opts.startPage = s.lastPage || opts.startPage;
        opts.resume = true;
        startCapture(opts);
        notifyPopup('captureStarted', {});
      }, 3000);
    });
  }

  // ── 7. Main capture ──
  async function startCapture(options) {
    isCapturing = true; shouldStop = false; isPaused = false;
    captureSession = options;

    var startPage = options.startPage || 1;
    var endPage = options.endPage || 0;
    var capDelay = Math.max(100, Math.min(5000, options.captureDelay || 500));
    var resume = options.resume || false;
    var autoRetry = options.autoRetry !== false;
    var targetSize = options.targetSize || null;

    // Initialize live settings from options
    liveSettings.dMin = Math.max(300, Math.min(30000, options.pageDelayMin || 800));
    liveSettings.dMax = Math.max(liveSettings.dMin, Math.min(30000, options.pageDelayMax || 1500));
    liveSettings.mode = options.mode || 'normal';
    liveSettings.stealth = (liveSettings.mode === 'stealth');
    liveSettings.capDelay = capDelay;

    createOverlay(); setOState('active'); updateOModeHighlight();
    notifyPopup('captureStarted', {});

    try {
      await callInject('clearState');
      var pi = await callInject('getPageInfo');
      var total = pi.total || 0, title = pi.title || 'ebook';
      if (endPage <= 0 || endPage > total) endPage = total;
      if (total === 0) { notifyPopup('captureError', { message: '페이지 정보 없음' }); isCapturing = false; setOState('error'); return; }

      var toCapture = endPage - startPage + 1;
      var cached = {};
      if (resume) { try { var ci = await callInject('getCacheInfo'); if (ci && ci.cachedPageNums) ci.cachedPageNums.forEach(function (p) { cached[p] = true; }); } catch (e) {} }

      notifyPopup('captureProgress', { current: 0, total: toCapture, message: '준비 중...' });
      var dims = await callInject('getCanvasDimensions');
      if (!dims) { notifyPopup('captureError', { message: '캔버스 없음' }); isCapturing = false; setOState('error'); return; }

      var toc = []; try { toc = await callInject('getTOC'); } catch (e) {}
      await callInject('initPDF', { extensionBaseURL: chrome.runtime.getURL(''), targetSize: targetSize });

      // Forward book meta to extension cache for reader
      forwardToBackground('cacheBookMeta', { bookId: getBookId(), title: title, totalPages: total, toc: toc });

      if (pi.current !== startPage) {
        var jumped = await callInject('goToPage', { pageNum: startPage });
        if (jumped) { await waitForPageChange(startPage, 5000); await randomDelay(800, 1500, liveSettings.stealth); }
        else {
          var cur = (await callInject('getPageInfo')).current || 1;
          while (cur < startPage && !shouldStop) {
            await callInject('nextPage');
            await randomDelay(Math.min(liveSettings.dMin, 500), Math.min(liveSettings.dMax, 800), liveSettings.stealth);
            cur++;
          }
          await randomDelay(800, 1500, liveSettings.stealth);
        }
      }

      var captured = 0, skipped = 0, consErr = 0;
      for (var page = startPage; page <= endPage; page++) {
        if (shouldStop) { notifyPopup('captureStopped', { capturedCount: captured + skipped }); break; }
        while (isPaused && !shouldStop) await delay(500);

        captureSession._currentPage = page;
        var info = await callInject('getPageInfo');
        var cp = info.current || page;

        if (resume && cached[cp]) {
          skipped++;
          var t1 = captured + skipped;
          updateO(t1, toCapture, cp, liveSettings.mode);
          notifyPopup('captureProgress', { current: t1, total: toCapture, page: cp, message: cp + 'p 캐시 건너뜀' });
        } else {
          await randomDelay(Math.max(100, liveSettings.capDelay - 200), liveSettings.capDelay + 200, false);
          var result = false;
          for (var att = 0; att < 3 && !result; att++) { if (att > 0) await delay(liveSettings.capDelay); result = await callInject('captureAndAddToPDF', { pageNum: cp }); }
          if (result) {
            captured++; consErr = 0;
            if (result.ok && result.dataURL) {
              forwardToBackground('cachePage', { bookId: result.bookId, pageNum: result.pageNum, dataURL: result.dataURL, width: result.width, height: result.height });
            }
            var t2 = captured + skipped;
            updateO(t2, toCapture, cp, liveSettings.mode);
            notifyPopup('captureProgress', { current: t2, total: toCapture, page: cp, message: t2 + '/' + toCapture + ' 캡처 완료' });
          } else {
            consErr++;
            notifyPopup('captureProgress', { current: captured + skipped, total: toCapture, page: cp, message: cp + 'p 실패' });
            if (consErr >= 5) {
              if (autoRetry) { saveSession(options, cp); notifyPopup('autoRetrying', {}); await delay(randomInt(3000, 8000)); location.reload(); return; }
              notifyPopup('captureError', { message: '연속 5회 실패' }); break;
            }
          }
        }
        // Use liveSettings for page delay (allows real-time mode switch)
        if (page < endPage) {
          await callInject('nextPage');
          var changed = await waitForPageChange(cp + 1, liveSettings.dMax + 5000);
          if (!changed) await callInject('nextPage');
          await randomDelay(liveSettings.dMin, liveSettings.dMax, liveSettings.stealth);
        }
      }

      try { await callInject('updateBookMeta', { title: title, totalPages: total, toc: toc }); } catch (e) {}
      if (captured > 0 && !shouldStop) {
        notifyPopup('captureProgress', { current: captured + skipped, total: toCapture, message: 'PDF 저장 중...' });
        await callInject('finalizePDF', { title: title, toc: toc });
        var oText = overlayRoot && overlayRoot.getElementById('oText');
        if (oText) oText.textContent = (captured + skipped) + 'p 완료!';
        setOState('idle');
        notifyPopup('captureComplete', { capturedCount: captured + skipped, title: title, partial: shouldStop });
      }
      clearSession();
    } catch (err) {
      notifyPopup('captureError', { message: err.message }); setOState('error');
      if (captureSession && captureSession.autoRetry) { saveSession(captureSession, captureSession._currentPage || startPage); await delay(randomInt(3000, 8000)); location.reload(); return; }
    } finally {
      isCapturing = false; shouldStop = false; captureSession = null;
    }
  }

  createOverlay();
  checkPendingSession();
})();
