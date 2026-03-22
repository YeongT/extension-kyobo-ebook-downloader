(function (C) {
  'use strict';

  C.saveSession = function (opts, page, callback) {
    chrome.storage.local.set({ pendingSession: {
      url: location.href, pathname: location.pathname,
      bookTitle: C.getBookTitle(), options: Object.assign({}, opts), lastPage: page, timestamp: Date.now()
    } }, callback || function () {});
  };

  C.clearSession = function () { chrome.storage.local.remove('pendingSession'); };

  C._recoveryInFlight = false;

  C.triggerRecovery = function (resumePage) {
    C._recoveryInFlight = true;
    var title = C.getBookTitle();
    var opts = Object.assign({}, C.captureSession || {}, { resume: true });
    C.saveSession(opts, resumePage, function () {
      C.notifyPopup('autoRetrying', { bookTitle: title, lastPage: resumePage });
      C.isCapturing = false; C.shouldStop = true;
      chrome.runtime.sendMessage({
        target: 'background', action: 'recovery',
        bookTitle: title
      }, function () { void chrome.runtime.lastError; });
    });
  };

  C.handleAbnormal = function () {
    var resumePage = (C.captureSession && C.captureSession._currentPage) || (C.captureSession && C.captureSession.startPage) || 1;
    if (C.captureSession) {
      C.triggerRecovery(resumePage);
    } else {
      var title = C.getBookTitle();
      if (title) {
        chrome.runtime.sendMessage({
          target: 'background', action: 'recovery',
          bookTitle: title
        }, function () { void chrome.runtime.lastError; });
      }
    }
  };

  C.checkPendingSession = function () {
    chrome.storage.local.get('pendingSession', function (data) {
      var s = data.pendingSession;
      if (!s || Date.now() - s.timestamp > 600000) { C.clearSession(); return; }
      var match = false;
      if (s.url === location.href) { match = true; }
      else if (s.pathname && s.pathname === location.pathname) { match = true; }
      else { try { match = new URL(s.url).pathname === location.pathname; } catch (e) {} }
      // Recovery reopens the same book on the viewer domain — always match
      if (!match && location.hostname === 'wviewer.kyobobook.co.kr') { match = true; }
      if (!match) { C.clearSession(); return; }
      C.clearSession();

      if (!s.options || s.options.autoRetry === false) return;

      setTimeout(function () {
        var opts = Object.assign({}, s.options, {
          startPage: s.lastPage || s.options.startPage,
          resume: true
        });
        C.startCapture(opts);
        C.notifyPopup('captureStarted', {});
      }, 5000);
    });
  };

  // ── Pending capture from library ──
  C.checkPendingCapture = function () {
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
          C.startCapture({
            startPage: 1, endPage: 0,
            mode: 'normal', autoRetry: settings.autoRetry !== false,
            captureDelay: settings.captureDelay || 500,
            pageDelayMin: 800, pageDelayMax: 1500,
            resume: true
          });
          C.notifyPopup('captureStarted', {});
        });
      }, 5000);
    });
  };

  // ── Auto-cache book metadata on viewer load ──
  C.cacheBookMetaOnLoad = async function () {
    if (C.isCapturing) return;

    // Retry up to 5 times - viewer may not be ready yet
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        var pi = await C.callInject('getPageInfo');
        if (pi && pi.title && pi.total) {
          var title = pi.title;
          var total = pi.total;

          // Resolve stable book ID
          var bookId = 'title:' + title;
          try {
            var resolved = await C.callInject('resolveBookId', { title: title });
            if (resolved) bookId = resolved;
          } catch (e) {}
          C.resolvedBookId = bookId;

          // Get TOC
          var toc = [];
          try { toc = await C.callInject('getTOC'); } catch (e) {}

          // Cache to extension DB via background
          chrome.runtime.sendMessage({
            target: 'background', action: 'cacheBookMeta',
            bookId: bookId, title: title, totalPages: total, toc: toc
          }, function (r) {
            void chrome.runtime.lastError;
            if (r && r.success) {
              C.notifyPopup('bookMetaCached', { bookId: bookId, title: title, totalPages: total });
            }
          });
          return;
        }
      } catch (e) {}
      await C.delay(2000);
    }
  };

  // ── Detect /invalidUse redirect ──
  C.checkInvalidUse = function () {
    var isInvalid = location.pathname.indexOf('invalidUse') !== -1 ||
        location.href.indexOf('invalidUse') !== -1 ||
        document.title.indexOf('비정상') !== -1;

    if (!isInvalid) {
      // Also check page content after a short delay
      setTimeout(function () {
        if (document.title.indexOf('비정상') !== -1 ||
            (document.body && document.body.textContent.indexOf('정상적인 접근이 아니므로') !== -1)) {
          C.handleInvalidUse();
        }
      }, 1000);
      return false;
    }

    C.handleInvalidUse();
    return true;
  };

  C.handleInvalidUse = function () {
    C.notifyPopup('captureError', { message: '비정상 접근으로 뷰어가 차단되었습니다' });

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
            C.triggerInvalidRecovery(autoRetry, r.title);
          } else {
            C.triggerInvalidRecovery(false, '');
          }
        });
        return;
      }

      C.triggerInvalidRecovery(autoRetry, bookTitle);
    });
  };

  C.triggerInvalidRecovery = function (autoRetry, bookTitle) {
    if (autoRetry && bookTitle) {
      C.notifyPopup('autoRetrying', { bookTitle: bookTitle });
      chrome.runtime.sendMessage({
        target: 'background', action: 'recovery',
        bookTitle: bookTitle
      }, function () { void chrome.runtime.lastError; });
    } else {
      C.notifyPopup('captureError', {
        message: '비정상 접근 차단됨' + (bookTitle ? ' (' + bookTitle + ')' : '') + ' - 수동으로 뷰어를 다시 열어주세요'
      });
    }
  };

})(window._C = window._C || {});
