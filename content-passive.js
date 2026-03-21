(function (C) {
  'use strict';

  C._passiveLastPage = 0;
  C._passiveCapturing = false;
  C._passiveCachedSet = null;

  C.initPassiveCapture = async function () {
    // Build cached page set from extension DB
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

        if (C._passiveCachedSet[curPage]) return;

        // Uncached page detected — auto capture
        C._passiveCapturing = true;
        await C.delay(300); // let canvas settle
        await C.waitCanvasReady(3000);
        await C.delay(200);

        var result = await C.callInject('capturePageOnly', { pageNum: curPage });
        if (result && result.ok && result.dataURL) {
          C._passiveCachedSet[curPage] = true;
          C.forwardToBackground('cachePage', {
            bookId: C.getBookId(), pageNum: result.pageNum,
            dataURL: result.dataURL, width: result.width, height: result.height
          });
          // Notify sessions.js to update grid tile
          C.notifyPopup('passiveCapture', { page: curPage, bookId: C.getBookId() });
          C.showStackToast(curPage + 'p 자동 캡처됨', 2500);
        }
      } catch (e) {}
      C._passiveCapturing = false;
    }, 1000);
  };

})(window._C = window._C || {});
