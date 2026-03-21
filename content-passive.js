(function (C) {
  'use strict';

  C._passiveCapturing = false;
  C._passiveCachedSet = null;
  var _lastDetectedPage = 0;
  var _pollTimer = null;

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
    } catch (e) {}
  };

  C.startPassivePolling = function () {
    // Use setTimeout chain instead of setInterval to prevent overlap
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

          // Check current and adjacent page
          var hasUncached = !C._passiveCachedSet[curPage];
          var hasUncachedNext = !C._passiveCachedSet[curPage + 1];
          if (!hasUncached && !hasUncachedNext) {
            poll();
            return;
          }

          C._passiveCapturing = true;
          await C.delay(400);
          await C.waitCanvasReady(3000);
          await C.delay(200);

          // Capture all visible rendered canvases
          var results = null;
          try { results = await C.callInject('captureBothPages'); } catch (e) {}

          if (results && results.length > 0) {
            for (var i = 0; i < results.length; i++) {
              var r = results[i];
              if (!r || !r.ok || !r.pageNum) continue;
              if (C._passiveCachedSet[r.pageNum]) continue;
              C._passiveCachedSet[r.pageNum] = true;
              if (r.dataURL) {
                await C.cachePageAsync(C.getBookId(), r.pageNum, r.dataURL, r.width, r.height);
                r.dataURL = null;
              }
              C.notifyPopup('passiveCapture', { page: r.pageNum, bookId: C.getBookId() });
              C.showStackToast(r.pageNum + 'p 자동 캡처됨', 2500);
            }
          } else {
            // Fallback: single page
            var result = await C.callInject('capturePageOnly', { pageNum: curPage });
            if (result && result.ok) {
              C._passiveCachedSet[curPage] = true;
              if (result.dataURL) {
                await C.cachePageAsync(C.getBookId(), result.pageNum, result.dataURL, result.width, result.height);
                result.dataURL = null;
              }
              C.notifyPopup('passiveCapture', { page: curPage, bookId: C.getBookId() });
              C.showStackToast(curPage + 'p 자동 캡처됨', 2500);
            }
          }
        } catch (e) {}

        C._passiveCapturing = false;
        poll(); // schedule next after current is fully done
      }, 1000);
    }
    poll();
  };

})(window._C = window._C || {});
