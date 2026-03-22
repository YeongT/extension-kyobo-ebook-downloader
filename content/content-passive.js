(function (C) {
  'use strict';

  C._passiveCapturing = false;
  C._passiveCachedSet = null;
  C._passiveSuspectSet = null;
  var _lastDetectedPage = 0;
  var _pollTimer = null;

  function loadSuspectSet(bookId, title) {
    return new Promise(function (resolve) {
      // Find inspection_ key matching this book
      chrome.storage.local.get(null, function (all) {
        var set = {};
        Object.keys(all).forEach(function (k) {
          if (k.indexOf('inspection_') !== 0) return;
          var keyId = k.substring('inspection_'.length);
          if (keyId === bookId ||
              (title && keyId === 'title:' + title) ||
              (title && keyId === title)) {
            var data = all[k];
            if (data && data.suspectPages) {
              data.suspectPages.forEach(function (p) { set[p] = true; });
            }
          }
        });
        resolve(set);
      });
    });
  }

  C.initPassiveCapture = async function () {
    try {
      var pi = await C.callInject('getPageInfo');
      if (!pi || !pi.title) return;
      var title = pi.title;
      var bookId = 'title:' + title;
      try {
        var bgLookup = await new Promise(function (resolve) {
          chrome.runtime.sendMessage({ target: 'background', action: 'findBookByTitle', title: title }, function (r) {
            void chrome.runtime.lastError; resolve(r);
          });
        });
        if (bgLookup && bgLookup.bookId) bookId = bgLookup.bookId;
      } catch (e) {}
      C.resolvedBookId = bookId;

      var extPages = await new Promise(function (resolve) {
        chrome.runtime.sendMessage({ target: 'background', action: 'getPagesInfo', bookId: bookId }, function (r) {
          void chrome.runtime.lastError; resolve(r);
        });
      });
      C._passiveCachedSet = {};
      if (extPages && extPages.pages) {
        extPages.pages.forEach(function (p) { C._passiveCachedSet[p] = true; });
      }

      // Load suspect pages from inspection results
      C._passiveSuspectSet = await loadSuspectSet(bookId, title);
    } catch (e) {}
  };

  C.startPassivePolling = function () {
    function poll() {
      _pollTimer = setTimeout(async function () {
        if (C.isCapturing || C._passiveCapturing || !C._passiveCachedSet) {
          poll();
          return;
        }

        try {
          var curPage = await C.callInject('getViewerPageNum');
          if (!curPage || curPage === _lastDetectedPage) {
            poll();
            return;
          }
          _lastDetectedPage = curPage;

          // Only capture if: uncached OR suspect
          var suspect = C._passiveSuspectSet || {};
          var needsCapture = !C._passiveCachedSet[curPage] || suspect[curPage];
          var needsCaptureNext = !C._passiveCachedSet[curPage + 1] || suspect[curPage + 1];
          if (!needsCapture && !needsCaptureNext) {
            poll();
            return;
          }

          C._passiveCapturing = true;
          await C.delay(400);
          await C.waitCanvasReady(3000);
          await C.delay(200);

          var results = null;
          try { results = await C.callInject('captureBothPages'); } catch (e) {}

          if (results && results.length > 0) {
            for (var i = 0; i < results.length; i++) {
              var r = results[i];
              if (!r || !r.ok || !r.pageNum) continue;
              // Skip pages that are already cached AND not suspect
              var isUncached = !C._passiveCachedSet[r.pageNum];
              var isSuspect = suspect[r.pageNum];
              if (!isUncached && !isSuspect) continue;
              C._passiveCachedSet[r.pageNum] = true;
              if (isSuspect) delete suspect[r.pageNum];
              if (r.dataURL) {
                await C.cachePageAsync(C.getBookId(), r.pageNum, r.dataURL, r.width, r.height);
                r.dataURL = null;
              }
              C.notifyPopup('passiveCapture', { page: r.pageNum, bookId: C.getBookId() });
              C.showStackToast(r.pageNum + 'p ' + (isSuspect ? '재캡처됨' : '캡처됨'), 2500);
            }
          } else {
            if (needsCapture) {
              var result = await C.callInject('capturePageOnly', { pageNum: curPage });
              if (result && result.ok) {
                var wasSuspect = suspect[curPage];
                C._passiveCachedSet[curPage] = true;
                if (wasSuspect) delete suspect[curPage];
                if (result.dataURL) {
                  await C.cachePageAsync(C.getBookId(), result.pageNum, result.dataURL, result.width, result.height);
                  result.dataURL = null;
                }
                C.notifyPopup('passiveCapture', { page: curPage, bookId: C.getBookId() });
                C.showStackToast(curPage + 'p ' + (wasSuspect ? '재캡처됨' : '캡처됨'), 2500);
              }
            }
          }
        } catch (e) {}

        C._passiveCapturing = false;
        poll();
      }, 1000);
    }
    poll();
  };

})(window._C = window._C || {});
