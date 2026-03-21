(function (C) {
  'use strict';

  C._passiveLastPage = 0;
  C._passiveCapturing = false;
  C._passiveCachedSet = null;

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
    setInterval(async function () {
      if (C.isCapturing || C._passiveCapturing) return;
      if (!C._passiveCachedSet) return;

      try {
        var curPage = await C.callInject('getViewerPageNum');
        if (!curPage || curPage === C._passiveLastPage) return;
        C._passiveLastPage = curPage;

        // Check if any visible page needs capture
        var hasUncached = !C._passiveCachedSet[curPage];
        // Also check adjacent page (2-page spread: curPage and curPage+1)
        var hasUncachedNext = !C._passiveCachedSet[curPage + 1];
        if (!hasUncached && !hasUncachedNext) return;

        C._passiveCapturing = true;
        await C.delay(400);
        await C.waitCanvasReady(3000);
        await C.delay(200);

        // Try capturing all visible canvases (works in both 1-page and 2-page view)
        var results = null;
        try { results = await C.callInject('captureBothPages'); } catch (e) {}

        if (results && results.length > 0) {
          var capturedAny = false;
          for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (!r || !r.ok || !r.pageNum) continue;
            if (C._passiveCachedSet[r.pageNum]) continue;
            C._passiveCachedSet[r.pageNum] = true;
            C.forwardToBackground('cachePage', {
              bookId: C.getBookId(), pageNum: r.pageNum,
              dataURL: r.dataURL, width: r.width, height: r.height
            });
            C.notifyPopup('passiveCapture', { page: r.pageNum, bookId: C.getBookId() });
            C.showStackToast(r.pageNum + 'p 자동 캡처됨', 2500);
            capturedAny = true;
          }
        } else {
          // Fallback: single page capture
          var result = await C.callInject('capturePageOnly', { pageNum: curPage });
          if (result && result.ok && result.dataURL) {
            C._passiveCachedSet[curPage] = true;
            C.forwardToBackground('cachePage', {
              bookId: C.getBookId(), pageNum: result.pageNum,
              dataURL: result.dataURL, width: result.width, height: result.height
            });
            C.notifyPopup('passiveCapture', { page: curPage, bookId: C.getBookId() });
            C.showStackToast(curPage + 'p 자동 캡처됨', 2500);
          }
        }
      } catch (e) {}
      C._passiveCapturing = false;
    }, 1000);
  };

})(window._C = window._C || {});
