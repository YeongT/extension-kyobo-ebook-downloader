(function () {
  'use strict';

  var C = window._C;

  // ── Shared state ──
  C.isCapturing = false;
  C.shouldStop = false;
  C.isPaused = false;
  C.captureSession = null;
  C.missingPages = [];
  C.resolvedBookId = null;
  C.overlay = null;
  C.overlayRoot = null;
  C.oRangeStartFocused = false;
  C.oRangeEndFocused = false;
  C._bookTotal = 0;
  C._scanRange = null;

  // ── Mode definitions ──
  C.MODES = {
    turbo:   { min: 100,  max: 250 },
    fast:    { min: 300,  max: 600 },
    normal:  { min: 800,  max: 1500 },
    careful: { min: 1500, max: 3000 },
    stealth: { min: 2500, max: 5000 }
  };
  C.liveSettings = { dMin: 800, dMax: 1500, stealth: false, mode: 'normal', capDelay: 500 };

  C.applyMode = function (mode) {
    C.liveSettings.mode = mode;
    C.liveSettings.stealth = (mode === 'stealth' || mode === 'careful');
    if (C.MODES[mode]) {
      C.liveSettings.dMin = C.MODES[mode].min;
      C.liveSettings.dMax = C.MODES[mode].max;
    }
    C.updateOModeHighlight();
  };

  // ── Inject.js communication ──
  var pendingCallbacks = {};
  var sessionId = Math.random().toString(36).slice(2, 10);
  var callbackSeq = 0;

  C.callInject = function (action, extra) {
    return new Promise(function (resolve, reject) {
      var id = sessionId + '_' + (++callbackSeq);
      var timeout = setTimeout(function () { delete pendingCallbacks[id]; reject(new Error('Timeout: ' + action)); }, 30000);
      pendingCallbacks[id] = function (r) { clearTimeout(timeout); r.error ? reject(new Error(r.error)) : resolve(r.data); };
      window.postMessage(Object.assign({ source: 'KYOBO_CONTENT', id: id, action: action }, extra || {}), location.origin);
    });
  };

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== window) return;
    if (!e.data || e.data.source !== 'KYOBO_INJECT') return;
    if (e.data.type === 'INJECTED') return;
    if (e.data.type === 'ABNORMAL_BLOCKED') { C.handleAbnormal(); return; }
    var id = e.data.id;
    if (id && pendingCallbacks[id]) { pendingCallbacks[id](e.data); delete pendingCallbacks[id]; }
  });

  // ── Helpers ──
  C.delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  C.randomInt = function (a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; };
  C.randomDelay = function (lo, hi, stealth) {
    var d = C.randomInt(lo, hi);
    if (stealth) { if (Math.random() < 0.15) d += C.randomInt(2000, 6000); if (Math.random() < 0.05) d += C.randomInt(5000, 15000); }
    return C.delay(d);
  };

  C.notifyPopup = function (type, data) {
    try { chrome.runtime.sendMessage({ source: 'KYOBO_CONTENT', type: type, data: data }); } catch (e) {}
  };

  C.focusViewerTab = function () {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ target: 'background', action: 'focusTab' }, function (r) {
          void chrome.runtime.lastError;
          resolve(r && r.success);
        });
      } catch (e) { resolve(false); }
    });
  };

  C.forwardToBackground = function (action, data) {
    try {
      chrome.runtime.sendMessage(Object.assign({ target: 'background', action: action }, data || {}), function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  };

  C.getBookId = function () { return C.resolvedBookId || location.pathname + location.search; };
  C.getBookTitle = function () {
    try { return document.querySelector('[data-layout="title"]').textContent.trim(); } catch (e) { return ''; }
  };

  // ── Chrome message handler ──
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'ping') { sendResponse({ status: 'ready', isCapturing: C.isCapturing }); return true; }
    if (msg.action === 'getPageInfo') { C.callInject('getPageInfo').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'getTOC') { C.callInject('getTOC').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'startCapture') { if (C.isCapturing) { sendResponse({ success: false, error: '이미 캡처 중' }); return true; } C.startCapture(msg.options || {}); sendResponse({ success: true }); return true; }
    if (msg.action === 'stopCapture') { C.shouldStop = true; C.isPaused = false; sendResponse({ success: true }); return true; }
    if (msg.action === 'getStatus') { sendResponse({ isCapturing: C.isCapturing, shouldStop: C.shouldStop }); return true; }
    if (msg.action === 'getProgress') { C.callInject('getCapturedCount').then(function (c) { sendResponse({ capturedCount: c, isCapturing: C.isCapturing }); }).catch(function () { sendResponse({ capturedCount: 0, isCapturing: C.isCapturing }); }); return true; }
    if (msg.action === 'getCacheInfo') { C.callInject('getCacheInfo').then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'buildPDFFromCache') { C.callInject('buildPDFFromCache', { extensionBaseURL: chrome.runtime.getURL(''), title: msg.title || 'ebook', toc: msg.toc || [], targetSize: msg.targetSize || null }).then(function (d) { sendResponse({ success: true, data: d }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'clearCache') { C.callInject('clearCache').then(function () { sendResponse({ success: true }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'goToPage') { C.callInject('goToPage', { pageNum: msg.pageNum }).then(function (r) { sendResponse({ success: !!r }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); }); return true; }
    if (msg.action === 'changeMode') { C.applyMode(msg.mode || 'normal'); sendResponse({ success: true }); return true; }
    if (msg.action === 'pauseCapture') { C.isPaused = true; sendResponse({ success: true }); return true; }
    if (msg.action === 'resumeCapture') { C.isPaused = false; sendResponse({ success: true }); return true; }
    return false;
  });

  // ── Sync capture settings to localStorage (for inject.js on next load) ──
  function syncCaptureSettings() {
    chrome.storage.local.get({ captureFormat: 'png', captureQuality: 92 }, function (d) {
      try {
        localStorage.setItem('kyobo_ext_format', d.captureFormat || 'png');
        localStorage.setItem('kyobo_ext_quality', String((d.captureQuality || 92) / 100));
      } catch (e) {}
    });
  }

  // Re-sync when settings change + live-update the running viewer
  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.captureFormat || changes.captureQuality) {
      syncCaptureSettings();
      chrome.storage.local.get({ captureFormat: 'png', captureQuality: 92 }, function (d) {
        C.callInject('updateCaptureSettings', {
          format: d.captureFormat || 'png',
          quality: (d.captureQuality || 92) / 100
        }).then(function () {
          C.showToast('캡처 설정 적용됨', 3000);
        }).catch(function () {});
      });
    }
  });

  // ── Init ──
  if (C.checkInvalidUse()) {
    // On /invalidUse page - skip normal init, just handle recovery
  } else {
    syncCaptureSettings();
    C.createOverlay();
    C.checkPendingSession();
    setTimeout(function () {
      if (!C.isCapturing) C.checkPendingCapture();
    }, 6000);
    setTimeout(function () {
      if (!C.isCapturing) C.cacheBookMetaOnLoad();
    }, 4000);
    // Start passive capture after initial setup
    setTimeout(function () {
      C.initPassiveCapture().then(function () {
        C.startPassivePolling();
      });
    }, 8000);
  }
})();
