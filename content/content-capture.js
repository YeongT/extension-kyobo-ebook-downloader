(function (C) {
  'use strict';

  // ── Page verification (check rendered canvases, not just indicator) ──
  // In 2-page spread view, the indicator only shows even pages (e.g. spread 5-6 → "6").
  // So we check if the target page is among the actually rendered canvas page numbers.
  C.verifyPageNum = async function (expected, timeout) {
    var deadline = Date.now() + (timeout || 15000);
    while (Date.now() < deadline) {
      try {
        // Primary: check rendered canvas page numbers (handles 2-page view)
        var rendered = await C.callInject('getRenderedPageNums');
        if (rendered && rendered.indexOf(expected) !== -1) return true;
        // Fallback: check page indicator (1-page view)
        var viewerPage = await C.callInject('getViewerPageNum');
        if (viewerPage === expected) return true;
      } catch (e) {}
      await C.delay(300);
    }
    return false;
  };

  C.waitCanvasReady = async function (maxWait) {
    var attempts = Math.ceil((maxWait || 10000) / 500);
    for (var i = 0; i < attempts; i++) {
      try {
        var ready = await C.callInject('canvasReady');
        if (ready) return true;
      } catch (e) {}
      await C.delay(500);
    }
    return false;
  };

  C.waitCanvasChange = async function (prevFingerprint, maxWait) {
    if (!prevFingerprint) return true;
    var attempts = Math.ceil((maxWait || 10000) / 250);
    for (var i = 0; i < attempts; i++) {
      try {
        var fp = await C.callInject('getCanvasFingerprint');
        if (fp && fp !== prevFingerprint) return true;
      } catch (e) {}
      await C.delay(250);
    }
    return false;
  };

  // ── Navigate to page and capture (core reliable method) ──
  C.navigateAndCapture = async function (targetPage) {
    // 1. Read ACTUAL viewer position (don't trust any tracking variable)
    var curPage = 0;
    try { curPage = await C.callInject('getViewerPageNum'); } catch (e) {}

    // 2. Get fingerprint before navigation
    var fpBefore = '';
    try { fpBefore = await C.callInject('getCanvasFingerprint'); } catch (e) {}

    // Helper: check if target page is visible (rendered canvas or indicator match)
    var isTargetVisible = async function () {
      try {
        var rendered = await C.callInject('getRenderedPageNums');
        if (rendered && rendered.indexOf(targetPage) !== -1) return true;
      } catch (e) {}
      try {
        var vp = await C.callInject('getViewerPageNum');
        if (vp === targetPage) return true;
      } catch (e) {}
      return false;
    };

    // 3. Navigate based on actual viewer position
    if (curPage === targetPage || (await isTargetVisible())) {
      // Already on the right page or visible in spread — skip navigation
    } else if (curPage > 0 && targetPage === curPage + 1) {
      await C.callInject('nextPage');
    } else if (curPage > 0 && targetPage === curPage - 1) {
      await C.callInject('prevPage');
    } else {
      // Need a jump — try goToPage with longer wait
      for (var jumpAttempt = 0; jumpAttempt < 2; jumpAttempt++) {
        try {
          await C.callInject('goToPage', { pageNum: targetPage });
        } catch (e) {}
        await C.delay(800 + Math.min(Math.abs(targetPage - curPage), 50) * 10);
        // In 2-page view, target may already be rendered even if indicator differs
        if (await isTargetVisible()) break;
        // Sequential fallback for small remaining gaps (1-page view only)
        var afterJump = 0;
        try { afterJump = await C.callInject('getViewerPageNum'); } catch (e2) {}
        if (afterJump > 0 && afterJump !== targetPage) {
          var gap = targetPage - afterJump;
          if (Math.abs(gap) <= 15) {
            var step = gap > 0 ? 'nextPage' : 'prevPage';
            for (var s = 0; s < Math.abs(gap); s++) {
              await C.callInject(step);
              await C.delay(350);
              if (await isTargetVisible()) break;
            }
            break;
          }
        }
      }
    }

    // 4. Wait for page indicator to update
    await C.delay(600);

    // 5. Verify the target page is visible (indicator or rendered canvas)
    var verified = await C.verifyPageNum(targetPage, 8000);
    if (!verified) {
      // Final attempt: goToPage + check rendered pages
      try { await C.callInject('goToPage', { pageNum: targetPage }); } catch (e) {}
      await C.delay(1000);
      if (!(await isTargetVisible())) {
        var cur2 = 0;
        try { cur2 = await C.callInject('getViewerPageNum'); } catch (e) {}
        if (cur2 > 0 && cur2 !== targetPage && Math.abs(targetPage - cur2) <= 15) {
          var step2 = targetPage > cur2 ? 'nextPage' : 'prevPage';
          for (var s2 = 0; s2 < Math.abs(targetPage - cur2); s2++) {
            await C.callInject(step2);
            await C.delay(350);
            if (await isTargetVisible()) break;
          }
        }
      }
      verified = await C.verifyPageNum(targetPage, 4000);
      if (!verified) return { ok: false, error: 'navigation_failed_page_' + targetPage };
    }

    // 6. Wait for canvas content to change
    if (fpBefore) {
      await C.waitCanvasChange(fpBefore, 5000);
    }

    // 7. Wait for canvas ready
    await C.waitCanvasReady(5000);

    // 8. Extra settle time for rendering
    await C.delay(Math.max(200, C.liveSettings.capDelay));

    // 9. Capture with retries
    var result = null;
    for (var att = 0; att < 3; att++) {
      if (att > 0) await C.delay(C.liveSettings.capDelay);
      result = await C.callInject('capturePageOnly', { pageNum: targetPage });
      if (result && result.ok) break;
    }

    // 10. Final verification: confirm target page is still visible
    try {
      var rendered = await C.callInject('getRenderedPageNums');
      var finalPage = await C.callInject('getViewerPageNum');
      var stillVisible = (rendered && rendered.indexOf(targetPage) !== -1) || finalPage === targetPage;
      if (!stillVisible) {
        return { ok: false, error: 'page_shifted_to_' + finalPage };
      }
    } catch (e) {}

    return result || { ok: false, error: 'capture_returned_null' };
  };

  // ── Main capture (goToPage-based, with verification) ──
  C.startCapture = async function (options) {
    C.isCapturing = true; C.shouldStop = false; C.isPaused = false;
    C.captureSession = Object.assign({}, options, { _currentPage: options.startPage || 1 });
    C.missingPages = [];

    var startPage = options.startPage || 1;
    var endPage = options.endPage || 0;
    var capDelay = Math.max(100, Math.min(5000, options.captureDelay || 500));
    var resume = options.resume || false;
    var autoRetry = options.autoRetry !== false;

    C.liveSettings.dMin = Math.max(100, Math.min(30000, options.pageDelayMin || 800));
    C.liveSettings.dMax = Math.max(C.liveSettings.dMin, Math.min(30000, options.pageDelayMax || 1500));
    C.liveSettings.mode = options.mode || 'normal';
    C.liveSettings.stealth = (C.liveSettings.mode === 'stealth' || C.liveSettings.mode === 'careful');
    C.liveSettings.capDelay = capDelay;

    C.createOverlay(); C.setOState('active'); C.updateOModeHighlight();
    C.showMissingPages([]);
    C.notifyPopup('captureStarted', {});

    // Update overlay range inputs to reflect actual capture range
    if (C.overlayRoot) {
      var oRS = C.overlayRoot.getElementById('oRangeStart');
      var oRE = C.overlayRoot.getElementById('oRangeEnd');
      if (oRS && startPage > 0) oRS.value = startPage;
      if (oRE && endPage > 0) oRE.value = endPage;
    }

    try {
      await C.callInject('clearState');
      var pi = await C.callInject('getPageInfo');
      var total = pi.total || 0;
      var title = pi.title || 'ebook';
      if (endPage <= 0 || endPage > total) endPage = total;
      if (total === 0) { C.notifyPopup('captureError', { message: '페이지 정보 없음' }); C.isCapturing = false; C.setOState('error'); return; }

      // Set scan range for partial rescan display
      var isPartial = startPage > 1 || endPage < total;
      C._scanRange = isPartial ? { start: startPage, end: endPage, total: endPage - startPage + 1 } : null;

      // Save session early so /invalidUse redirect can recover
      C.saveSession(Object.assign({}, options, { resume: true }), startPage);

      // Resolve stable book ID (title-based, survives URL changes)
      // Check BOTH inject.js (MAIN world) DB and extension DB for existing cache
      try {
        C.resolvedBookId = await C.callInject('resolveBookId', { title: title });
      } catch (e) {
        C.resolvedBookId = null;
      }
      // Also check extension-level DB (more persistent, survives site data clears)
      if (!C.resolvedBookId || C.resolvedBookId === 'title:' + title) {
        try {
          var bgLookup = await new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              target: 'background', action: 'findBookByTitle', title: title
            }, function (r) { void chrome.runtime.lastError; resolve(r); });
          });
          if (bgLookup && bgLookup.bookId && bgLookup.bookId !== C.resolvedBookId) {
            // Extension DB has data under a different ID - adopt it for consistency
            C.resolvedBookId = bgLookup.bookId;
          }
        } catch (e) {}
      }
      if (!C.resolvedBookId) C.resolvedBookId = 'title:' + title;

      // Migrate extension-level cache FIRST (before writing new metadata)
      var urlId = location.pathname + location.search;
      if (C.resolvedBookId !== urlId) {
        try {
          await new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              target: 'background', action: 'migrateBookCache',
              oldBookId: urlId, newBookId: C.resolvedBookId, title: title
            }, function (r) { void chrome.runtime.lastError; resolve(r); });
          });
        } catch (e) {}
      }

      var cached = {};
      // Only skip cached pages in resume mode - new scan overwrites everything
      if (resume) {
        try {
          var ci = await C.callInject('getCacheInfo');
          if (ci && ci.cachedPageNums) ci.cachedPageNums.forEach(function (p) { cached[p] = true; });
        } catch (e) {}
        try {
          var extPages = await new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              target: 'background', action: 'getPagesInfo', bookId: C.getBookId()
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
      C._bookTotal = total;

      C.notifyPopup('captureProgress', { current: totalCached, total: total, scanCurrent: 0, scanTotal: endPage - startPage + 1, message: '준비 중...' });
      var dims = await C.callInject('getCanvasDimensions');
      if (!dims) { C.notifyPopup('captureError', { message: '캔버스 없음' }); C.isCapturing = false; C.setOState('error'); return; }

      var toc = []; try { toc = await C.callInject('getTOC'); } catch (e) {}
      // Write fresh metadata AFTER migration (overwrites any stale migrated data)
      C.forwardToBackground('cacheBookMeta', { bookId: C.getBookId(), title: title, totalPages: total, toc: toc });

      // Focus viewer tab for canvas rendering
      await C.focusViewerTab();
      await C.delay(500);

      // Wait for initial canvas ready
      var stableCount = 0;
      for (var sw = 0; sw < 20 && stableCount < 2 && !C.shouldStop; sw++) {
        var ready = await C.callInject('canvasReady');
        if (ready) stableCount++;
        else stableCount = 0;
        await C.delay(500);
      }

      var captured = 0;
      var scanTotal = endPage - startPage + 1;

      // ── Fast capture: flip through pages like a human ──
      // 1. Jump to startPage (slider, once)
      // 2. Capture all visible canvases (captureBothPages)
      // 3. nextPage() to flip forward
      // 4. Stop when viewer passes endPage
      // 5. Then sweep back for any missed pages

      try { await C.callInject('goToPage', { pageNum: startPage }); } catch (e) {}
      await C.delay(500);
      await C.waitCanvasReady(5000);

      // ── Phase 1: Forward sweep — flip through startPage to endPage ──
      var viewerPos = startPage;
      var emptyFlips = 0;

      while (!C.shouldStop && viewerPos <= endPage) {
        while (C.isPaused && !C.shouldStop) await C.delay(500);
        if (document.hidden) { await C.focusViewerTab(); await C.delay(300); }

        // Capture all visible canvases (retry if blank — canvas may still be rendering)
        var newCaptures = 0;
        var renderedPages = [];
        for (var captureAttempt = 0; captureAttempt < 3; captureAttempt++) {
          if (captureAttempt > 0) await C.delay(300);
          var results = null;
          try { results = await C.callInject('captureBothPages'); } catch (e) {}

          if (results && results.length > 0) {
            for (var ri = 0; ri < results.length; ri++) {
              var r = results[ri];
              if (!r || !r.pageNum) continue;
              if (renderedPages.indexOf(r.pageNum) === -1) renderedPages.push(r.pageNum);
              if (!r.ok || r.pageNum < startPage || r.pageNum > endPage) continue;
              if (cached[r.pageNum]) continue;
              cached[r.pageNum] = true;
              captured++; totalCached++; newCaptures++;
              if (r.dataURL) {
                await C.cachePageAsync(r.bookId, r.pageNum, r.dataURL, r.width, r.height);
                r.dataURL = null;
              }
            }
          }
          // Got new captures → move on. No captures but pages are all cached → move on too.
          if (newCaptures > 0) break;
          // Check if current pages are already cached (no retry needed)
          var allCached = true;
          try {
            var curRendered = await C.callInject('getRenderedPageNums');
            for (var ci = 0; ci < curRendered.length; ci++) {
              if (curRendered[ci] >= startPage && curRendered[ci] <= endPage && !cached[curRendered[ci]]) { allCached = false; break; }
            }
          } catch (e) { allCached = false; }
          if (allCached) break;
        }

        // Update viewer position from what we actually see
        if (renderedPages.length > 0) {
          viewerPos = Math.max.apply(null, renderedPages);
        }

        // Progress update
        var scanDone = 0;
        for (var sc = startPage; sc <= endPage; sc++) { if (cached[sc]) scanDone++; }
        C.updateO(totalCached, total, viewerPos, scanDone, scanTotal);
        if (newCaptures > 0) {
          emptyFlips = 0;
          C.notifyPopup('captureProgress', { current: totalCached, total: total, scanCurrent: scanDone, scanTotal: scanTotal, page: viewerPos, message: totalCached + '/' + total });
        } else {
          emptyFlips++;
        }

        // Stop condition: viewer passed the end
        if (viewerPos >= endPage) break;

        // Stuck detection: 20 flips with no new captures
        if (emptyFlips >= 20) {
          C.showToast('캡처 진행 불가 - 중지됨', 5000);
          C.playBeep('error');
          break;
        }

        // Remember current page numbers before flipping
        var prevPages = [];
        try { prevPages = await C.callInject('getRenderedPageNums'); } catch (e) {}

        // Flip to next page
        try { await C.callInject('nextPage'); } catch (e) {}

        // Wait until rendered pages actually change (not just canvas exists)
        var flipDeadline = Date.now() + 5000;
        var pageChanged = false;
        while (Date.now() < flipDeadline) {
          try {
            var nowPages = await C.callInject('getRenderedPageNums');
            if (nowPages && nowPages.length > 0 && JSON.stringify(nowPages) !== JSON.stringify(prevPages)) {
              pageChanged = true;
              break;
            }
          } catch (e) {}
          await C.delay(150);
        }
        // Extra settle time for canvas rendering after page change
        if (pageChanged) await C.delay(200);

        if (C.liveSettings.stealth) {
          await C.randomDelay(C.liveSettings.dMin, C.liveSettings.dMax, true);
        }
      }

      // ── Phase 2: Fill missed pages (jump to each uncaptured page) ──
      if (!C.shouldStop) {
        var missed = [];
        for (var m = startPage; m <= endPage; m++) {
          if (!cached[m]) missed.push(m);
        }

        if (missed.length > 0 && missed.length <= scanTotal * 0.5) {
          C.setOText('누락 ' + missed.length + '페이지 보충 중...');
          for (var mi = 0; mi < missed.length && !C.shouldStop; mi++) {
            var mp = missed[mi];
            try { await C.callInject('goToPage', { pageNum: mp }); } catch (e) {}
            await C.delay(400);
            await C.waitCanvasReady(3000);
            await C.delay(150);

            var mResults = null;
            try { mResults = await C.callInject('captureBothPages'); } catch (e) {}
            if (mResults && mResults.length > 0) {
              for (var mri = 0; mri < mResults.length; mri++) {
                var mr = mResults[mri];
                if (!mr || !mr.ok || !mr.pageNum) continue;
                if (mr.pageNum < startPage || mr.pageNum > endPage) continue;
                if (cached[mr.pageNum]) continue;
                cached[mr.pageNum] = true;
                captured++; totalCached++;
                if (mr.dataURL) {
                  await C.cachePageAsync(mr.bookId, mr.pageNum, mr.dataURL, mr.width, mr.height);
                  mr.dataURL = null;
                }
              }
            }
            C.updateO(totalCached, total, mp, null, null);

            if (C.liveSettings.stealth) {
              await C.randomDelay(C.liveSettings.dMin, C.liveSettings.dMax, true);
            }
          }
        }
      }

      if (C.shouldStop) { C.notifyPopup('captureStopped', { capturedCount: totalCached }); }

      try { await C.callInject('updateBookMeta', { title: title, totalPages: total, toc: toc }); } catch (e) {}

      // ── Post-capture verification: find all missing pages ──
      if (!C.shouldStop) {
        try {
          var cacheInfo = await C.callInject('getCacheInfo');
          var cachedNums = (cacheInfo && cacheInfo.cachedPageNums) || [];
          var cachedSet = {};
          cachedNums.forEach(function (n) { cachedSet[n] = true; });
          var allMissing = [];
          for (var p = startPage; p <= endPage; p++) {
            if (!cachedSet[p]) allMissing.push(p);
          }
          C.missingPages = allMissing;
        } catch (e) {}
      }

      C.showMissingPages(C.missingPages);

      // ── Auto-retry blank pages ──
      if (!C.shouldStop && captured > 0) {
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
            var checkResult = await C.callInject('findBlankPages', { startPage: startPage, endPage: endPage });
            if (checkResult && checkResult.length > 0) blankPages = checkResult;
          } catch (e) {}

          if (blankPages.length > 0) {
            C.showToast(blankPages.length + '개 빈 페이지 감지 - 자동 재시도...', 4000);
            C.notifyPopup('captureProgress', { current: totalCached, total: total, message: blankPages.length + '개 빈 페이지 재시도 중...' });

            for (var bi = 0; bi < blankPages.length && !C.shouldStop; bi++) {
              var bp = blankPages[bi];
              await C.delay(C.liveSettings.dMin);
              if (document.hidden) { await C.focusViewerTab(); await C.delay(400); }
              var bResult = await C.navigateAndCapture(bp);
              if (bResult && bResult.ok) {
                if (bResult.dataURL) {
                  C.forwardToBackground('cachePage', { bookId: bResult.bookId, pageNum: bResult.pageNum, dataURL: bResult.dataURL, width: bResult.width, height: bResult.height });
                }
                C.updateO(totalCached, total, bp);
              }
            }
          }
        }
      }

      if (captured > 0) {
        var isPartialRescan = startPage > 1 || endPage < total;
        var msg = totalCached + '/' + total + '페이지 캡처';
        if (C.shouldStop) msg += ' (중지됨)';
        else msg += ' 완료';
        if (C.missingPages.length > 0) msg += ' (' + C.missingPages.length + '개 누락)';
        C.showToast(msg, 5000);
        C.playBeep(C.shouldStop ? 'error' : (C.missingPages.length > 0 ? 'error' : 'success'));
        C.setOState('idle');
        C.notifyPopup(C.shouldStop ? 'captureStopped' : 'captureComplete', {
          capturedCount: totalCached, title: title, partial: isPartialRescan,
          missing: C.missingPages.length, missingPages: C.missingPages
        });
        // Always open sessions manager after capture (stop or complete)
        setTimeout(function () {
          chrome.runtime.sendMessage({
            target: 'background', action: 'openSessions',
            title: title
          }, function () { void chrome.runtime.lastError; });
        }, 1000);
      } else {
        C.setOState('idle');
      }
      C.clearSession();
    } catch (err) {
      C.notifyPopup('captureError', { message: err.message }); C.setOState('error'); C.playBeep('error');
      if (C.captureSession && C.captureSession.autoRetry) { C.triggerRecovery(C.captureSession._currentPage || startPage); return; }
    } finally {
      if (!C._recoveryInFlight) {
        C.isCapturing = false; C.shouldStop = false; C.captureSession = null;
      }
    }
  };

  // ── Rescan missing pages ──
  C.startRescanMissing = async function (pageList, opts) {
    if (C.isCapturing || !pageList || pageList.length === 0) return;
    C.isCapturing = true; C.shouldStop = false; C.isPaused = false;

    C.liveSettings.dMin = Math.max(100, opts.pageDelayMin || 800);
    C.liveSettings.dMax = Math.max(C.liveSettings.dMin, opts.pageDelayMax || 1500);
    C.liveSettings.capDelay = opts.captureDelay || 500;

    C.setOState('active');
    var total = pageList.length;
    var rescanned = 0;
    var stillMissing = [];

    // Build set of target pages for quick lookup
    var targetSet = {};
    pageList.forEach(function (p) { targetSet[p] = true; });

    for (var i = 0; i < total; i++) {
      if (C.shouldStop) break;
      while (C.isPaused && !C.shouldStop) await C.delay(500);

      var pn = pageList[i];
      if (!targetSet[pn]) { rescanned++; continue; } // already captured by a previous spread
      C.updateO(i + 1, total, pn);

      if (document.hidden) { await C.focusViewerTab(); await C.delay(300); }

      // Fast: goToPage + captureBothPages (captures both pages in 2-view spread)
      try { await C.callInject('goToPage', { pageNum: pn }); } catch (e) {}
      await C.delay(400);
      await C.waitCanvasReady(3000);
      await C.delay(150);

      var results = null;
      try { results = await C.callInject('captureBothPages'); } catch (e) {}

      var gotTarget = false;
      if (results && results.length > 0) {
        for (var ri = 0; ri < results.length; ri++) {
          var r = results[ri];
          if (!r || !r.ok || !r.pageNum) continue;
          if (r.dataURL) {
            await C.cachePageAsync(C.getBookId(), r.pageNum, r.dataURL, r.width, r.height);
            r.dataURL = null;
          }
          if (targetSet[r.pageNum]) {
            delete targetSet[r.pageNum]; // mark as done so we skip if it appears again
            rescanned++;
            gotTarget = true;
          }
        }
      }

      if (!gotTarget) {
        // Fallback: slow single-page capture
        var result = await C.navigateAndCapture(pn);
        if (result && result.ok) {
          rescanned++;
          delete targetSet[pn];
          if (result.dataURL) {
            await C.cachePageAsync(C.getBookId(), result.pageNum, result.dataURL, result.width, result.height);
          }
        } else {
          stillMissing.push(pn);
        }
      }

      if (i < total - 1 && !C.shouldStop) {
        await C.delay(300 + Math.random() * 200);
      }
    }

    C.missingPages = stillMissing;
    C.showMissingPages(C.missingPages);
    C.isCapturing = false; C.shouldStop = false;
    C.setOState('idle');
    C.showToast(rescanned + '페이지 재스캔 완료' + (stillMissing.length > 0 ? ' (' + stillMissing.length + '개 여전히 누락)' : ''), 4000);
    C.playBeep(stillMissing.length > 0 ? 'error' : 'success');
    // Switch to sessions manager
    try {
      var pi = await C.callInject('getPageInfo');
      setTimeout(function () {
        chrome.runtime.sendMessage({
          target: 'background', action: 'openSessions',
          title: (pi && pi.title) || ''
        }, function () { void chrome.runtime.lastError; });
      }, 1000);
    } catch (e) {}
  };

})(window._C = window._C || {});
