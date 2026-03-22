(function (S) {
  'use strict';

  // ── State ──
  S.inspectionData = null; // { count, suspectPages, thumbs }
  S.thumbCache = {};
  S.gridLoadAbort = false;
  S.blankSettings = { threshold: 245, ratio: 0.98 };
  S._inspectionRunning = false;
  S.confirmedPages = {};

  // ── Inspection key ──
  function getInspectionKey() { return 'inspection_' + S.selectedBookId; }
  S.getInspectionKey = getInspectionKey;

  // ── Load / Save / Clear ──
  S.loadInspection = function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(getInspectionKey(), function (d) {
        resolve(d[getInspectionKey()] || null);
      });
    });
  };

  S.saveInspection = function (suspectPages, thumbs, pageSet) {
    var obj = {};
    obj[getInspectionKey()] = {
      count: S.capturedPageNums.length,
      pageSet: pageSet || null,
      suspectPages: suspectPages,
      thumbs: thumbs,
      timestamp: Date.now()
    };
    chrome.storage.local.set(obj);
  };

  S.clearInspection = function () {
    chrome.storage.local.remove(getInspectionKey());
    S.inspectionData = null;
    S.thumbCache = {};
  };

  // ── Thumbnail creation ──
  S.createThumbnail = function (dataURL, maxW) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(maxW / img.width, 1);
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.5));
      };
      img.onerror = function () { resolve(dataURL); };
      img.src = dataURL;
    });
  };

  // ── Blank detection ──
  S.checkBlankFromData = function (dataURL) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          var size = 32;
          c.width = size; c.height = size;
          c.getContext('2d').drawImage(img, 0, 0, size, size);
          var data = c.getContext('2d').getImageData(0, 0, size, size).data;
          var thr = S.blankSettings.threshold;
          var whiteCount = 0;
          for (var i = 0; i < data.length; i += 4) {
            if (data[i] > thr && data[i + 1] > thr && data[i + 2] > thr) whiteCount++;
          }
          resolve(whiteCount / (size * size) > S.blankSettings.ratio);
        } catch (e) { resolve(false); }
      };
      img.onerror = function () { resolve(false); };
      img.src = dataURL;
    });
  };

  // ── Blank settings ──
  S.loadBlankSettings = function () {
    chrome.storage.local.get({ blankThreshold: 245, blankRatio: 98 }, function (d) {
      S.blankSettings.threshold = d.blankThreshold;
      S.blankSettings.ratio = d.blankRatio / 100;
    });
  };
  S.loadBlankSettings();

  S.forceFullInspection = function () {
    S.clearInspection();
    S.renderDetail();
    S.showToast('검사 기준 변경됨 - 전체 재검사 중...');
  };

  // Auto re-inspect when blank detection settings change
  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.blankThreshold || changes.blankRatio) {
      S.loadBlankSettings();
      if (S.selectedBookId) {
        S.forceFullInspection();
      }
    }
  });

  // ── Confirmed pages ──
  S.loadConfirmedPages = function () {
    if (!S.selectedBookId) return;
    var key = 'confirmed_' + S.selectedBookId;
    chrome.storage.local.get(key, function (d) {
      var arr = d[key] || [];
      S.confirmedPages = {};
      arr.forEach(function (p) { S.confirmedPages[p] = true; });
    });
  };

  S.saveConfirmedPages = function () {
    if (!S.selectedBookId) return;
    var key = 'confirmed_' + S.selectedBookId;
    var obj = {};
    obj[key] = Object.keys(S.confirmedPages).map(Number);
    chrome.storage.local.set(obj);
  };

  // ── Apply stored inspection to grid ──
  S.applyStoredInspection = function (stored) {
    var grid = S.$('pageGrid');
    if (stored.thumbs) {
      Object.keys(stored.thumbs).forEach(function (pn) {
        var tile = grid.querySelector('[data-page="' + pn + '"]');
        if (!tile || tile.dataset.loaded === 'true') return;
        S.thumbCache[pn] = stored.thumbs[pn];
        var img = document.createElement('img');
        img.className = 'tile-thumb';
        img.src = stored.thumbs[pn];
        tile.insertBefore(img, tile.firstChild);
        tile.dataset.loaded = 'true';
      });
    }
    if (stored.suspectPages) {
      stored.suspectPages.forEach(function (pn) {
        if (S.confirmedPages[pn]) return;
        var tile = grid.querySelector('[data-page="' + pn + '"]');
        if (tile) {
          tile.classList.remove('captured');
          tile.classList.add('suspect');
          tile.title = pn + '페이지 (빈 페이지 의심)';
        }
      });
    }
  };

  // ── Main thumbnail + inspection loader ──
  S.loadAllThumbnails = async function () {
    if (S._inspectionRunning) return;
    var captured = S.capturedPageNums.slice();
    if (captured.length === 0) return;
    S._inspectionRunning = true;

    var stored = await S.loadInspection();
    if (stored && stored.count === captured.length) {
      S.inspectionData = stored;
      S.applyStoredInspection(stored);
      S.updateFilterCounts();
      S.refreshDetailHeader();
      S.renderMissingRanges();
      S._inspectionRunning = false;
      return;
    }

    var prevSet = {};
    if (stored && stored.pageSet) {
      stored.pageSet.forEach(function (p) { prevSet[p] = true; });
    }
    var newPages = [];
    for (var ni = 0; ni < captured.length; ni++) {
      if (!prevSet[captured[ni]]) newPages.push(captured[ni]);
    }

    var suspectPages = [];
    var thumbs = {};
    if (stored) {
      if (stored.thumbs) {
        Object.keys(stored.thumbs).forEach(function (k) {
          var pk = parseInt(k, 10);
          if (captured.indexOf(pk) !== -1) thumbs[pk] = stored.thumbs[k];
        });
      }
      if (stored.suspectPages) {
        stored.suspectPages.forEach(function (p) {
          if (captured.indexOf(p) !== -1) suspectPages.push(p);
        });
      }
    }

    S.applyStoredInspection({ thumbs: thumbs, suspectPages: suspectPages });

    var toInspect = newPages.length > 0 ? newPages : captured;
    if (stored && newPages.length === 0) {
      S.inspectionData = { count: captured.length, pageSet: captured.slice(), suspectPages: suspectPages, thumbs: thumbs, timestamp: Date.now() };
      S.saveInspection(suspectPages, thumbs, captured);
      S.updateFilterCounts();
      S.refreshDetailHeader();
      S.renderMissingRanges();
      S._inspectionRunning = false;
      return;
    }

    S.gridLoadAbort = false;
    if (toInspect.length > 20) S.showProgress('페이지 검사 중...', 0);
    var newSuspect = 0;

    var pageDims = {};
    var dimCounts = {};

    for (var i = 0; i < toInspect.length; i++) {
      if (S.gridLoadAbort) break;
      var pn = toInspect[i];
      var tile = S.$('pageGrid').querySelector('[data-page="' + pn + '"]');
      if (!tile) continue;

      if (toInspect.length > 20) {
        S.updateProgress(Math.round((i / toInspect.length) * 100), (i + 1) + '/' + toInspect.length + ' 검사 중...');
      }

      try {
        var pg = await extGetPage(S.selectedBookId, pn);
        if (!pg || !pg.dataURL) continue;

        if (pg.width && pg.height) {
          pageDims[pn] = { w: pg.width, h: pg.height };
          var dimKey = pg.width + 'x' + pg.height;
          dimCounts[dimKey] = (dimCounts[dimKey] || 0) + 1;
        }

        var thumbURL = await S.createThumbnail(pg.dataURL, 160);
        S.thumbCache[pn] = thumbURL;
        thumbs[pn] = thumbURL;

        var img = document.createElement('img');
        img.className = 'tile-thumb';
        img.src = thumbURL;
        tile.insertBefore(img, tile.firstChild);
        tile.dataset.loaded = 'true';

        if (!S.confirmedPages[pn]) {
          var isBlank = await S.checkBlankFromData(pg.dataURL);
          if (isBlank) {
            tile.classList.remove('captured');
            tile.classList.add('suspect');
            tile.title = pn + '페이지 (빈 페이지 의심)';
            if (suspectPages.indexOf(pn) === -1) suspectPages.push(pn);
            newSuspect++;
          }
        }
      } catch (e) {}
    }

    try {
      var allPagesInfo = await extGetPagesInfo(S.selectedBookId);
      allPagesInfo.forEach(function (pi) {
        if (!pageDims[pi.pageNum] && pi.width && pi.height) {
          pageDims[pi.pageNum] = { w: pi.width, h: pi.height };
          var pk = pi.width + 'x' + pi.height;
          dimCounts[pk] = (dimCounts[pk] || 0) + 1;
        }
      });
    } catch (e) {}

    var majorityDim = null;
    var majorityCount = 0;
    Object.keys(dimCounts).forEach(function (k) {
      if (dimCounts[k] > majorityCount) { majorityCount = dimCounts[k]; majorityDim = k; }
    });

    var dimSuspectCount = 0;
    if (majorityDim && Object.keys(dimCounts).length > 1) {
      Object.keys(pageDims).forEach(function (pnStr) {
        var ppn = parseInt(pnStr, 10);
        var dk = pageDims[ppn].w + 'x' + pageDims[ppn].h;
        if (dk !== majorityDim && !S.confirmedPages[ppn]) {
          var dtile = S.$('pageGrid').querySelector('[data-page="' + ppn + '"]');
          if (dtile && !dtile.classList.contains('suspect')) {
            dtile.classList.remove('captured');
            dtile.classList.add('suspect');
            dtile.title = ppn + '페이지 (크기 불일치: ' + pageDims[ppn].w + 'x' + pageDims[ppn].h + ')';
            if (suspectPages.indexOf(ppn) === -1) { suspectPages.push(ppn); dimSuspectCount++; }
          }
        }
      });
    }

    S.hideProgress();
    S._inspectionRunning = false;
    if (!S.gridLoadAbort) {
      S.saveInspection(suspectPages, thumbs, captured);
      S.inspectionData = { count: captured.length, pageSet: captured.slice(), suspectPages: suspectPages, thumbs: thumbs, timestamp: Date.now() };
      S.updateFilterCounts();
      S.refreshDetailHeader();
      S.renderMissingRanges();
      var msgs = [];
      if (newSuspect > 0) msgs.push(newSuspect + '개 빈 페이지');
      if (dimSuspectCount > 0) msgs.push(dimSuspectCount + '개 크기 불일치');
      if (msgs.length > 0) S.showToast(msgs.join(', ') + ' 의심 감지됨');
    }
  };

  // ── Update inspection after page deletion ──
  S.updateInspectionAfterDelete = function (deletedPages) {
    var key = getInspectionKey();
    chrome.storage.local.get(key, function (d) {
      var stored = d[key];
      if (!stored) return;
      var delSet = {};
      deletedPages.forEach(function (p) { delSet[p] = true; });
      stored.count = S.capturedPageNums.length;
      stored.suspectPages = (stored.suspectPages || []).filter(function (p) { return !delSet[p]; });
      if (stored.thumbs) {
        deletedPages.forEach(function (p) { delete stored.thumbs[p]; });
      }
      var obj = {};
      obj[key] = stored;
      chrome.storage.local.set(obj);
    });
  };

})(window._S = window._S || {});
