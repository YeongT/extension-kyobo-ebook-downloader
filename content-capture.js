(function (C) {
  'use strict';

  // ── Page verification (read viewer's page indicator) ──
  C.verifyPageNum = async function (expected, timeout) {
    var deadline = Date.now() + (timeout || 15000);
    while (Date.now() < deadline) {
      try {
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

    // 3. Navigate based on actual viewer position
    if (curPage === targetPage) {
      // Already on the right page — skip navigation
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
        // Wait longer for jump navigation to settle (especially for large jumps)
        await C.delay(800 + Math.min(Math.abs(targetPage - curPage), 50) * 10);
        var afterJump = 0;
        try { afterJump = await C.callInject('getViewerPageNum'); } catch (e2) {}
        if (afterJump === targetPage) break;
        // Sequential fallback for small remaining gaps
        if (afterJump > 0 && afterJump !== targetPage) {
          var gap = targetPage - afterJump;
          if (Math.abs(gap) <= 15) {
            var step = gap > 0 ? 'nextPage' : 'prevPage';
            for (var s = 0; s < Math.abs(gap); s++) {
              await C.callInject(step);
              await C.delay(350);
            }
            break;
          }
        }
      }
    }

    // 4. Wait for page indicator to update
    await C.delay(600);

    // 5. Verify the viewer's page indicator matches
    var verified = await C.verifyPageNum(targetPage, 8000);
    if (!verified) {
      // Final attempt: goToPage + sequential
      try { await C.callInject('goToPage', { pageNum: targetPage }); } catch (e) {}
      await C.delay(1000);
      var cur2 = 0;
      try { cur2 = await C.callInject('getViewerPageNum'); } catch (e) {}
      if (cur2 > 0 && cur2 !== targetPage && Math.abs(targetPage - cur2) <= 15) {
        var step2 = targetPage > cur2 ? 'nextPage' : 'prevPage';
        for (var s2 = 0; s2 < Math.abs(targetPage - cur2); s2++) {
          await C.callInject(step2);
          await C.delay(350);
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

    // 10. Final verification: confirm viewer still shows the right page
    try {
      var finalPage = await C.callInject('getViewerPageNum');
      if (finalPage !== targetPage) {
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

      var captured = 0, skipped = 0, consErr = 0;
      var scanTotal = endPage - startPage + 1;
      var scanDone = 0;

      for (var page = startPage; page <= endPage; page++) {
        if (C.shouldStop) { C.notifyPopup('captureStopped', { capturedCount: totalCached }); break; }
        while (C.isPaused && !C.shouldStop) await C.delay(500);

        C.captureSession._currentPage = page;

        // Ensure viewer is in foreground
        if (document.hidden) {
          await C.focusViewerTab();
          await C.delay(400);
        }

        // ALWAYS skip cached pages (not just in resume mode)
        if (cached[page]) {
          skipped++;
          consErr = 0;
          scanDone++;
          C.updateO(totalCached, total, page, scanDone, scanTotal);
          C.notifyPopup('captureProgress', { current: totalCached, total: total, scanCurrent: scanDone, scanTotal: scanTotal, page: page, message: page + 'p 캐시 건너뜀' });
          continue;
        }

        // Show navigation status
        var navLabel = C._scanRange ? C._scanRange.start + '-' + C._scanRange.end + 'p' : '';
        C.setOText(navLabel ? navLabel + ' 이동 중... p' + page : page + 'p 이동 중...');

        // Navigate to target page
        var result = await C.navigateAndCapture(page);

        if (result && result.ok) {
          captured++; totalCached++; consErr = 0;
          scanDone++;
          cached[page] = true;
          if (result.dataURL) {
            await C.cachePageAsync(result.bookId, result.pageNum, result.dataURL, result.width, result.height);
            result.dataURL = null;
          }
          C.updateO(totalCached, total, page, scanDone, scanTotal);
          C.notifyPopup('captureProgress', { current: totalCached, total: total, scanCurrent: scanDone, scanTotal: scanTotal, page: page, message: totalCached + '/' + total + ' 캡처 완료' });

          // Bonus: capture pre-loaded adjacent pages
          try {
            var preloaded = await C.callInject('captureBothPages');
            if (preloaded && preloaded.length > 0) {
              for (var pi = 0; pi < preloaded.length; pi++) {
                var pp = preloaded[pi];
                if (!pp || !pp.ok || !pp.pageNum) continue;
                if (cached[pp.pageNum]) continue;
                if (pp.pageNum < startPage || pp.pageNum > endPage) continue;
                cached[pp.pageNum] = true;
                captured++; totalCached++;
                if (pp.dataURL) {
                  await C.cachePageAsync(pp.bookId, pp.pageNum, pp.dataURL, pp.width, pp.height);
                  pp.dataURL = null;
                }
              }
              C.updateO(totalCached, total, page, scanDone, scanTotal);
            }
          } catch (e) {}
        } else {
          // Page failed - retry up to 3 times before giving up
          var retried = false;
          var errReason = (result && result.error) ? result.error : 'unknown';
          for (var retryN = 1; retryN <= 3 && !C.shouldStop; retryN++) {
            C.notifyPopup('captureProgress', { current: totalCached, total: total, scanCurrent: scanDone, scanTotal: scanTotal, page: page, message: page + 'p 재시도 ' + retryN + '/3...' });
            C.updateO(totalCached, total, page, scanDone, scanTotal);
            await C.delay(C.liveSettings.dMin * 2);

            if (document.hidden) { await C.focusViewerTab(); await C.delay(400); }
            result = await C.navigateAndCapture(page);
            if (result && result.ok) {
              retried = true;
              captured++; totalCached++; consErr = 0;
              scanDone++;
              cached[page] = true;
              if (result.dataURL) {
                await C.cachePageAsync(result.bookId, result.pageNum, result.dataURL, result.width, result.height);
                result.dataURL = null;
              }
              C.updateO(totalCached, total, page, scanDone, scanTotal);
              C.notifyPopup('captureProgress', { current: totalCached, total: total, scanCurrent: scanDone, scanTotal: scanTotal, page: page, message: page + 'p 재시도 성공' });
              break;
            }
          }

          if (!retried) {
            consErr++;
            scanDone++;
            C.missingPages.push(page);
            C.notifyPopup('captureProgress', { current: totalCached, total: total, scanCurrent: scanDone, scanTotal: scanTotal, page: page, message: page + 'p 실패 (3회 재시도 후): ' + errReason });
            C.showToast(page + 'p 캡처 실패', 3000);

            if (consErr >= 3) {
              C.shouldStop = true;
              var failMsg = '연속 ' + consErr + '회 캡처 실패 - 자동 중지됨';
              C.notifyPopup('captureError', { message: failMsg });
              C.showToast(failMsg, 5000);
              C.playBeep('error');
              // Send persistent notification via background
              C.forwardToBackground('showNotification', {
                title: '캡처 자동 중지',
                message: failMsg + ' (' + page + '페이지)',
                requireInteraction: true
              });
              break;
            }
          }
        }

        // Keep viewer in foreground
        if (document.hidden) {
          await C.focusViewerTab();
          await C.delay(300);
        }

        // Delay between pages
        if (page < endPage && !C.shouldStop) {
          await C.randomDelay(C.liveSettings.dMin, C.liveSettings.dMax, C.liveSettings.stealth);
        }
      }

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

      if (captured > 0 && !C.shouldStop) {
        var isComplete = C.missingPages.length === 0 && totalCached >= total;
        var isPartialRescan = startPage > 1 || endPage < total;
        var msg = totalCached + '/' + total + '페이지 캡처 완료';
        if (C.missingPages.length > 0) msg += ' (' + C.missingPages.length + '개 누락)';
        C.showToast(msg, 5000);
        C.playBeep(C.missingPages.length > 0 ? 'error' : 'success');
        C.setOState('idle');
        C.notifyPopup('captureComplete', {
          capturedCount: totalCached, title: title, partial: isPartialRescan,
          missing: C.missingPages.length, missingPages: C.missingPages
        });
        // Full scan to end of book → close viewer + open sessions
        // Partial/mid-range → just switch to sessions tab, keep viewer open
        if (endPage >= total && startPage <= 1) {
          setTimeout(function () {
            chrome.runtime.sendMessage({
              target: 'background', action: 'openSessions',
              title: title
            }, function () {
              void chrome.runtime.lastError;
              setTimeout(function () { window.close(); }, 500);
            });
          }, 2000);
        }
      } else if (C.shouldStop) {
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

    for (var i = 0; i < total; i++) {
      if (C.shouldStop) break;
      while (C.isPaused && !C.shouldStop) await C.delay(500);

      var pn = pageList[i];
      C.updateO(i + 1, total, pn);

      if (document.hidden) {
        await C.focusViewerTab();
        await C.delay(400);
      }

      var result = await C.navigateAndCapture(pn);

      if (result && result.ok) {
        rescanned++;
        if (result.dataURL) {
          C.forwardToBackground('cachePage', { bookId: result.bookId, pageNum: result.pageNum, dataURL: result.dataURL, width: result.width, height: result.height });
        }
      } else {
        stillMissing.push(pn);
      }

      if (i < total - 1 && !C.shouldStop) {
        await C.randomDelay(C.liveSettings.dMin, C.liveSettings.dMax, C.liveSettings.stealth);
      }
    }

    C.missingPages = stillMissing;
    C.showMissingPages(C.missingPages);
    C.isCapturing = false; C.shouldStop = false;
    C.setOState('idle');
    C.showToast(rescanned + '페이지 재스캔 완료' + (stillMissing.length > 0 ? ' (' + stillMissing.length + '개 여전히 누락)' : ''), 4000);
  };

})(window._C = window._C || {});
