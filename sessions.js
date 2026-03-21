(function () {
  'use strict';

  // ── Global error handler ──
  function formatErrorDetail(err, extra) {
    var parts = [];
    if (extra) parts.push(extra);
    if (err && err.stack) {
      parts.push(err.stack);
    } else if (err && err.message) {
      parts.push(err.message);
    } else if (err) {
      try { parts.push(JSON.stringify(err)); } catch (e2) { parts.push(String(err)); }
    }
    return parts.join('\n\n') || '(상세 정보 없음)';
  }

  function showGlobalError(titleText, msgText, err, extra) {
    console.error('[SessionManager]', titleText, err);
    var progressEl = document.getElementById('progressOverlay');
    if (progressEl && !progressEl.hidden) progressEl.hidden = true;

    var errorDialog = document.getElementById('errorDialog');
    if (!errorDialog) return;
    errorDialog.hidden = false;
    var t = document.getElementById('errorTitle');
    var m = document.getElementById('errorMessage');
    var d = document.getElementById('errorDetail');
    if (t) t.textContent = titleText;
    if (m) m.textContent = msgText;
    if (d) d.textContent = formatErrorDetail(err, extra);
  }

  window.addEventListener('error', function (e) {
    var loc = (e.filename ? e.filename.split('/').pop() : '') + (e.lineno ? ':' + e.lineno : '');
    showGlobalError(
      '예상치 못한 오류',
      e.message || '스크립트 실행 중 오류가 발생했습니다.',
      e.error,
      loc ? '위치: ' + loc : ''
    );
  });

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var msg = (reason && reason.message) ? reason.message
            : (typeof reason === 'string') ? reason
            : '비동기 작업에서 오류가 발생했습니다.';
    showGlobalError('처리 중 오류 발생', msg, reason);
  });

  // ── State ──
  var books = [];
  var selectedBookId = null;
  var selectedBook = null;
  var capturedPageNums = [];
  var previewPageNum = 0;
  var isScanning = false;
  var scanPollInterval = null;

  var $ = function (id) { return document.getElementById(id); };

  // ── Init ──
  async function init() {
    await loadBooks();
    setupEventListeners();
    setupScanListeners();

    var params = new URLSearchParams(location.search);
    var titleParam = params.get('title');
    var bookParam = params.get('book');

    if (titleParam) {
      await openByTitle(titleParam);
    } else if (bookParam) {
      selectBook(bookParam);
    }
  }

  // ── Open by title (from library click) ──
  async function openByTitle(title) {
    var bookId = null;
    try { bookId = await extFindBookByTitle(title); } catch (e) {}

    if (bookId) {
      selectBook(bookId);
      return;
    }

    // New book - not yet scanned. Create placeholder.
    selectedBookId = 'title:' + title;
    selectedBook = { bookId: selectedBookId, title: title, totalPages: 0, toc: [], cachedCount: 0 };
    capturedPageNums = [];

    // Try to get book info from library (stored temporarily)
    try {
      var stored = await new Promise(function (res) {
        chrome.storage.local.get('sessionManagerBook', function (d) { res(d.sessionManagerBook); });
      });
      if (stored && stored.title === title) {
        selectedBook.author = stored.author;
        selectedBook.coverUrl = stored.coverUrl;
        selectedBook.dueDate = stored.dueDate;
      }
    } catch (e) {}

    $('emptyState').hidden = true;
    $('bookDetail').hidden = false;
    renderBookList();
    renderDetail();
  }

  // ── Load books from IndexedDB ──
  async function loadBooks() {
    try {
      books = await extGetAllBooks();
      books.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
    } catch (e) {
      books = [];
    }
    renderBookList();
  }

  // ── Render sidebar book list ──
  function renderBookList() {
    var container = $('bookList');
    if (!books || books.length === 0) {
      container.innerHTML = '<div class="book-list-empty">캐시된 도서가 없습니다</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < books.length; i++) {
      var b = books[i];
      var pct = (b.totalPages > 0 && b.cachedCount > 0)
        ? Math.round(b.cachedCount / b.totalPages * 100)
        : 0;
      var isActive = b.bookId === selectedBookId;

      var r = 14, stroke = 3, circ = 2 * Math.PI * r;
      var dashOffset = circ - (pct / 100) * circ;
      var ringColor = pct >= 100 ? '#34c759' : '#e94560';
      var bgRing = isActive ? 'rgba(255,255,255,.15)' : '#f0f0f0';
      var ringSvg = '<svg width="36" height="36" viewBox="0 0 36 36">' +
        '<circle cx="18" cy="18" r="' + r + '" fill="none" stroke="' + bgRing + '" stroke-width="' + stroke + '"/>' +
        '<circle cx="18" cy="18" r="' + r + '" fill="none" stroke="' + ringColor + '" stroke-width="' + stroke + '" ' +
          'stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + dashOffset.toFixed(1) + '" ' +
          'stroke-linecap="round" transform="rotate(-90 18 18)"/>' +
        '<text x="18" y="19" text-anchor="middle" dominant-baseline="middle" ' +
          'font-size="10" font-weight="700" fill="' + (isActive ? '#e94560' : '#86868b') + '">' + pct + '</text>' +
      '</svg>';

      html += '<div class="book-item' + (isActive ? ' active' : '') + '" data-bookid="' + escAttr(b.bookId) + '">' +
        '<div class="book-item-icon">' + ringSvg + '</div>' +
        '<div class="book-item-info">' +
          '<div class="book-item-title" title="' + escAttr(b.title || '') + '">' + esc(b.title || '(제목 없음)') + '</div>' +
          '<div class="book-item-meta">' +
            '<span>' + (b.cachedCount || 0) + '/' + (b.totalPages || '?') + 'p</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }
    container.innerHTML = html;

    container.querySelectorAll('.book-item').forEach(function (el) {
      el.addEventListener('click', function () {
        selectBook(this.dataset.bookid);
      });
    });
  }

  // ── Select a book ──
  async function selectBook(bookId) {
    gridLoadAbort = true; // cancel any running thumbnail load
    thumbCache = {};
    selectedBookId = bookId;
    selectedBook = null;
    capturedPageNums = [];
    confirmedPages = {};

    $('emptyState').hidden = true;
    $('bookDetail').hidden = false;

    loadConfirmedPages();
    renderBookList();

    try {
      selectedBook = await extGetBookMeta(bookId);
      var pagesInfo = await extGetPagesInfo(bookId);
      capturedPageNums = pagesInfo.map(function (p) { return p.pageNum; }).sort(function (a, b) { return a - b; });
    } catch (e) {
      selectedBook = null;
      capturedPageNums = [];
    }

    if (!selectedBook) {
      selectedBook = findBookInList(bookId);
    }

    renderDetail();
  }

  function findBookInList(bookId) {
    for (var i = 0; i < books.length; i++) {
      if (books[i].bookId === bookId) return books[i];
    }
    return null;
  }

  // ── Render book detail ──
  function renderDetail() {
    if (!selectedBook) {
      $('bookDetail').hidden = true;
      $('emptyState').hidden = false;
      return;
    }

    var title = selectedBook.title || '(제목 없음)';
    var totalPages = selectedBook.totalPages || 0;
    var cachedCount = capturedPageNums.length;
    var suspectCount = inspectionData && inspectionData.suspectPages ? inspectionData.suspectPages.length : 0;
    var confirmedCount = cachedCount - suspectCount;
    var missingCount = totalPages > 0 ? totalPages - cachedCount : 0;
    var pct = totalPages > 0 ? Math.round(confirmedCount / totalPages * 100) : 0;
    var isComplete = totalPages > 0 && confirmedCount >= totalPages;
    var hasData = cachedCount > 0 || totalPages > 0;

    $('detailTitle').textContent = title;

    // Meta info
    if (hasData) {
      var metaHtml = '<span>' + esc(String(totalPages)) + ' 페이지</span>' +
        '<span>' + esc(String(cachedCount)) + ' 캡처됨</span>';
      if (suspectCount > 0) {
        metaHtml += '<span style="color:#e94560">' + esc(String(suspectCount)) + ' 의심</span>';
      }
      if (missingCount > 0) {
        metaHtml += '<span style="color:#ff9500">' + esc(String(missingCount)) + ' 누락</span>';
      }
      if (selectedBook.timestamp) {
        metaHtml += '<span>' + esc(timeAgo(selectedBook.timestamp)) + '</span>';
      }
      $('detailMeta').innerHTML = metaHtml;
      $('detailMeta').hidden = false;
    } else {
      $('detailMeta').innerHTML = '<span style="color:#aeaeb2">아직 스캔되지 않은 도서입니다. 스캔을 시작하세요.</span>';
      $('detailMeta').hidden = false;
    }

    // Progress bar — suspect pages excluded from completion
    var fill = $('detailFill');
    fill.style.width = pct + '%';
    fill.className = 'progress-fill' + (isComplete ? ' complete' : suspectCount > 0 ? ' has-suspect' : '');
    $('detailProgress').textContent = hasData ? pct + '%' : '';
    $('detailFill').parentElement.parentElement.hidden = !hasData;

    // Completion badge
    if (isComplete) {
      if (!$('completeBadge')) {
        var badge = document.createElement('div');
        badge.id = 'completeBadge';
        badge.className = 'complete-badge';
        badge.textContent = '스캔 완료 - 다운로드 가능';
        $('detailMeta').parentElement.appendChild(badge);
      }
      $('completeBadge').hidden = false;
    } else if ($('completeBadge')) {
      $('completeBadge').hidden = true;
    }

    // Hide scan card when complete + not scanning + no viewer
    $('scanCard').hidden = isComplete && !isScanning && !viewerTabId;

    // Show/hide sections based on data availability
    $('downloadToolbar').hidden = cachedCount === 0;
    $('gridSection').hidden = totalPages === 0;

    // TOC
    renderTOC();

    renderMissingRanges();
    renderPageGrid();
    renderScanControls();
  }

  // Lightweight header-only refresh (after inspection updates suspect data)
  function refreshDetailHeader() {
    if (!selectedBook) return;
    var totalPages = selectedBook.totalPages || 0;
    var cachedCount = capturedPageNums.length;
    var suspectCount = inspectionData && inspectionData.suspectPages ? inspectionData.suspectPages.length : 0;
    var confirmedCount = cachedCount - suspectCount;
    var missingCount = totalPages > 0 ? totalPages - cachedCount : 0;
    var pct = totalPages > 0 ? Math.round(confirmedCount / totalPages * 100) : 0;
    var isComplete = totalPages > 0 && confirmedCount >= totalPages;

    // Update meta
    var metaHtml = '<span>' + esc(String(totalPages)) + ' 페이지</span>' +
      '<span>' + esc(String(cachedCount)) + ' 캡처됨</span>';
    if (suspectCount > 0) {
      metaHtml += '<span style="color:#e94560">' + esc(String(suspectCount)) + ' 의심</span>';
    }
    if (missingCount > 0) {
      metaHtml += '<span style="color:#ff9500">' + esc(String(missingCount)) + ' 누락</span>';
    }
    if (selectedBook.timestamp) {
      metaHtml += '<span>' + esc(timeAgo(selectedBook.timestamp)) + '</span>';
    }
    $('detailMeta').innerHTML = metaHtml;

    // Update progress bar
    var fill = $('detailFill');
    fill.style.width = pct + '%';
    fill.className = 'progress-fill' + (isComplete ? ' complete' : suspectCount > 0 ? ' has-suspect' : '');
    $('detailProgress').textContent = pct + '%';

    // Update completion badge
    if (isComplete) {
      if ($('completeBadge')) $('completeBadge').hidden = false;
    } else {
      if ($('completeBadge')) $('completeBadge').hidden = true;
    }
  }

  // ── Render TOC ──
  function renderTOC() {
    var toc = (selectedBook && selectedBook.toc) || [];
    var section = $('tocSection');

    if (!toc || toc.length === 0) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    $('tocLabel').textContent = '목차 (' + toc.length + '항목)';

    var html = '';
    for (var i = 0; i < toc.length; i++) {
      var entry = toc[i];
      var depth = Math.min(entry.depth || 1, 3);
      var hasCaptured = capturedPageNums.indexOf(entry.page) !== -1;
      html += '<div class="toc-item depth-' + depth + '" data-page="' + entry.page + '">' +
        '<span class="toc-page">' + (entry.page || '') + '</span>' +
        '<span class="toc-title">' + esc(entry.title || '') + '</span>' +
      '</div>';
    }
    $('tocList').innerHTML = html;

    // Click TOC item → preview that page
    $('tocList').querySelectorAll('.toc-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var pg = parseInt(this.dataset.page, 10);
        if (pg && capturedPageNums.indexOf(pg) !== -1) {
          openPreview(pg);
        }
      });
    });
  }

  // ── Render page grid with thumbnails ──
  var thumbCache = {}; // pageNum → dataURL (small)
  var gridLoadAbort = false;

  function renderPageGrid() {
    var grid = $('pageGrid');
    var totalPages = (selectedBook && selectedBook.totalPages) || 0;

    if (totalPages === 0) {
      grid.innerHTML = '';
      return;
    }

    var capturedSet = {};
    capturedPageNums.forEach(function (n) { capturedSet[n] = true; });

    var html = '';
    for (var p = 1; p <= totalPages; p++) {
      var isCaptured = !!capturedSet[p];
      html += '<div class="page-tile ' + (isCaptured ? 'captured' : 'missing') + '" data-page="' + p + '" data-loaded="false" title="' + p + '페이지' + (isCaptured ? '' : ' (누락)') + '">' +
        '<input type="checkbox" class="tile-check" data-page="' + p + '">' +
        '<span class="tile-num">' + p + '</span>' +
      '</div>';
    }
    grid.innerHTML = html;

    grid.querySelectorAll('.page-tile.captured').forEach(function (tile) {
      tile.addEventListener('click', function (e) {
        if (e.target.classList.contains('tile-check')) return;
        openPreview(parseInt(this.dataset.page, 10));
      });
    });

    $('gridLabel').textContent = '페이지 맵 (' + capturedPageNums.length + '/' + totalPages + ')';
    updateFilterCounts();

    // Load thumbnails — skip full inspection if no changes
    loadAllThumbnails();
  }

  // ── Update filter count badges ──
  function updateFilterCounts() {
    var grid = $('pageGrid');
    if (!grid) return;
    var counts = {
      all: grid.querySelectorAll('.page-tile').length,
      captured: grid.querySelectorAll('.page-tile.captured').length,
      suspect: grid.querySelectorAll('.page-tile.suspect').length,
      missing: grid.querySelectorAll('.page-tile.missing').length,
      failed: grid.querySelectorAll('.page-tile.failed').length
    };
    $('gridFilters').querySelectorAll('.grid-filter').forEach(function (btn) {
      var filter = btn.dataset.filter;
      var count = counts[filter] || 0;
      var badge = btn.querySelector('.filter-count');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'filter-count';
        btn.appendChild(badge);
      }
      badge.textContent = count;
      badge.className = 'filter-count' + (count === 0 ? ' zero' : '');
    });
  }

  // Persisted inspection results
  var inspectionData = null; // { count, suspectPages, thumbs }

  function getInspectionKey() { return 'inspection_' + selectedBookId; }

  function loadInspection() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(getInspectionKey(), function (d) {
        resolve(d[getInspectionKey()] || null);
      });
    });
  }

  function saveInspection(suspectPages, thumbs) {
    var obj = {};
    obj[getInspectionKey()] = {
      count: capturedPageNums.length,
      suspectPages: suspectPages,
      thumbs: thumbs, // { pageNum: thumbDataURL }
      timestamp: Date.now()
    };
    chrome.storage.local.set(obj);
  }

  function clearInspection() {
    chrome.storage.local.remove(getInspectionKey());
    inspectionData = null;
    thumbCache = {};
  }

  async function loadAllThumbnails() {
    var captured = capturedPageNums.slice();
    if (captured.length === 0) return;

    // Check if we already have valid inspection data
    var stored = await loadInspection();
    if (stored && stored.count === captured.length) {
      // No changes — apply stored results without re-inspecting
      inspectionData = stored;
      applyStoredInspection(stored);
      updateFilterCounts();
      refreshDetailHeader();
      renderMissingRanges();
      return;
    }

    // Changes detected — run full inspection
    gridLoadAbort = false;
    showProgress('페이지 검사 중...', 0);
    var suspectPages = [];
    var thumbs = {};

    for (var i = 0; i < captured.length; i++) {
      if (gridLoadAbort) break;
      var pn = captured[i];
      var tile = $('pageGrid').querySelector('[data-page="' + pn + '"]');
      if (!tile) continue;

      updateProgress(Math.round((i / captured.length) * 100), (i + 1) + '/' + captured.length + ' 검사 중...');

      try {
        var pg = await extGetPage(selectedBookId, pn);
        if (!pg || !pg.dataURL) continue;

        var thumbURL = await createThumbnail(pg.dataURL, 160);
        thumbCache[pn] = thumbURL;
        thumbs[pn] = thumbURL;

        var img = document.createElement('img');
        img.className = 'tile-thumb';
        img.src = thumbURL;
        tile.insertBefore(img, tile.firstChild);
        tile.dataset.loaded = 'true';

        if (!confirmedPages[pn]) {
          var isBlank = await checkBlankFromData(pg.dataURL);
          if (isBlank) {
            tile.classList.remove('captured');
            tile.classList.add('suspect');
            tile.title = pn + '페이지 (빈 페이지 의심)';
            suspectPages.push(pn);
          }
        }
      } catch (e) {}
    }

    hideProgress();
    if (!gridLoadAbort) {
      saveInspection(suspectPages, thumbs);
      inspectionData = { count: capturedPageNums.length, suspectPages: suspectPages, thumbs: thumbs, timestamp: Date.now() };
      updateFilterCounts();
      refreshDetailHeader();
      renderMissingRanges();
      if (suspectPages.length > 0) {
        showToast(suspectPages.length + '개 빈 페이지 의심 감지됨');
      }
    }
  }

  function applyStoredInspection(stored) {
    var grid = $('pageGrid');
    // Apply thumbnails
    if (stored.thumbs) {
      Object.keys(stored.thumbs).forEach(function (pn) {
        var tile = grid.querySelector('[data-page="' + pn + '"]');
        if (!tile || tile.dataset.loaded === 'true') return;
        thumbCache[pn] = stored.thumbs[pn];
        var img = document.createElement('img');
        img.className = 'tile-thumb';
        img.src = stored.thumbs[pn];
        tile.insertBefore(img, tile.firstChild);
        tile.dataset.loaded = 'true';
      });
    }
    // Apply suspect status
    if (stored.suspectPages) {
      stored.suspectPages.forEach(function (pn) {
        if (confirmedPages[pn]) return;
        var tile = grid.querySelector('[data-page="' + pn + '"]');
        if (tile) {
          tile.classList.remove('captured');
          tile.classList.add('suspect');
          tile.title = pn + '페이지 (빈 페이지 의심)';
        }
      });
    }
  }

  function createThumbnail(dataURL, maxW) {
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
  }

  // Blank detection settings (loaded from chrome.storage)
  var blankSettings = { threshold: 245, ratio: 0.98 };

  function loadBlankSettings() {
    chrome.storage.local.get({ blankThreshold: 245, blankRatio: 98 }, function (d) {
      blankSettings.threshold = d.blankThreshold;
      blankSettings.ratio = d.blankRatio / 100;
    });
  }
  loadBlankSettings();

  function checkBlankFromData(dataURL) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          var size = 32;
          c.width = size; c.height = size;
          c.getContext('2d').drawImage(img, 0, 0, size, size);
          var data = c.getContext('2d').getImageData(0, 0, size, size).data;
          var thr = blankSettings.threshold;
          var whiteCount = 0;
          for (var i = 0; i < data.length; i += 4) {
            if (data[i] > thr && data[i + 1] > thr && data[i + 2] > thr) whiteCount++;
          }
          resolve(whiteCount / (size * size) > blankSettings.ratio);
        } catch (e) { resolve(false); }
      };
      img.onerror = function () { resolve(false); };
      img.src = dataURL;
    });
  }

  // ── Preview modal ──
  // Get the active filter from grid filter buttons
  function getActiveFilter() {
    var active = document.querySelector('.grid-filter.active');
    return active ? active.dataset.filter : 'all';
  }

  // Get page numbers matching the current filter
  function getFilteredPages() {
    var filter = getActiveFilter();
    if (filter === 'all') return capturedPageNums.slice();
    var grid = $('pageGrid');
    var result = [];
    grid.querySelectorAll('.page-tile.' + filter).forEach(function (tile) {
      result.push(parseInt(tile.dataset.page, 10));
    });
    return result.sort(function (a, b) { return a - b; });
  }

  async function openPreview(pageNum) {
    if (!selectedBookId) return;

    previewPageNum = pageNum;
    $('previewModal').hidden = false;
    $('previewImg').src = '';
    $('modalTitle').textContent = pageNum + '페이지';
    $('modalInfo').textContent = '로딩 중...';
    updateNavButtons();
    updatePreviewButtons();

    try {
      var page = await extGetPage(selectedBookId, pageNum);
      if (page && page.dataURL) {
        $('previewImg').src = page.dataURL;
        $('modalInfo').textContent = pageNum + '페이지 · ' + (page.width || '?') + ' x ' + (page.height || '?') + 'px';
      } else {
        $('previewImg').src = '';
        $('modalInfo').textContent = '이미지 데이터 없음';
      }
    } catch (e) {
      $('modalInfo').textContent = '로딩 실패';
      showError('페이지 로딩 실패', previewPageNum + '페이지를 불러올 수 없습니다.', formatErrorDetail(e));
    }
  }

  function closePreview() {
    $('previewModal').hidden = true;
    $('previewImg').src = '';
  }

  function updateNavButtons() {
    var filtered = getFilteredPages();
    var idx = filtered.indexOf(previewPageNum);
    $('prevPage').disabled = (idx <= 0);
    $('nextPage').disabled = (idx < 0 || idx >= filtered.length - 1);
  }

  function updatePreviewButtons() {
    var tile = $('pageGrid').querySelector('[data-page="' + previewPageNum + '"]');
    var isSuspect = tile && tile.classList.contains('suspect');
    var isFailed = tile && tile.classList.contains('failed');
    var needsAction = isSuspect || isFailed || (tile && !tile.classList.contains('captured'));
    $('markNormalBtn').disabled = !needsAction;
    $('markNormalBtn').textContent = needsAction ? '정상 확인' : '정상 확인됨';
  }

  function navigatePreview(direction) {
    var filtered = getFilteredPages();
    var idx = filtered.indexOf(previewPageNum);
    if (idx < 0) {
      // Current page not in filter — find nearest
      for (var i = 0; i < filtered.length; i++) {
        if (filtered[i] > previewPageNum) { idx = direction > 0 ? i : i - 1; break; }
      }
      if (idx < 0) idx = filtered.length - 1;
    } else {
      idx += direction;
    }
    if (idx >= 0 && idx < filtered.length) {
      openPreview(filtered[idx]);
    }
  }

  // ── Delete page ──
  async function deletePage(pageNum) {
    if (!selectedBookId || !pageNum) return;

    try {
      // Find next page in current filter BEFORE deleting
      var filtered = getFilteredPages();
      var idx = filtered.indexOf(pageNum);
      var nextInFilter = null;
      if (idx >= 0 && idx + 1 < filtered.length) nextInFilter = filtered[idx + 1];
      else if (idx > 0) nextInFilter = filtered[idx - 1];

      // Delete (no confirm — fast workflow)
      await extDeletePage(selectedBookId, pageNum);
      capturedPageNums = capturedPageNums.filter(function (n) { return n !== pageNum; });
      delete thumbCache[pageNum];
      updateInspectionAfterDelete([pageNum]);

      // Update tile immediately without full re-render
      var tile = $('pageGrid').querySelector('[data-page="' + pageNum + '"]');
      if (tile) {
        tile.className = 'page-tile missing';
        tile.dataset.loaded = 'false';
        var thumb = tile.querySelector('.tile-thumb');
        if (thumb) thumb.remove();
        tile.title = pageNum + '페이지 (누락)';
      }

      // Jump to next page in filter instantly
      if (nextInFilter) {
        openPreview(nextInFilter);
      } else {
        closePreview();
      }

      // Update counters in background
      var totalPages = (selectedBook && selectedBook.totalPages) || 0;
      if (totalPages > 0) {
        var pct = Math.round(capturedPageNums.length / totalPages * 100);
        $('detailFill').style.width = pct + '%';
        $('detailProgress').textContent = pct + '%';
        $('gridLabel').textContent = '페이지 맵 (' + capturedPageNums.length + '/' + totalPages + ')';
      }
      loadBooks().then(renderBookList);
    } catch (e) {
      showError('페이지 삭제 실패', pageNum + '페이지를 삭제하는 중 오류가 발생했습니다.', formatErrorDetail(e));
    }
  }

  // ── Delete book ──
  async function deleteBook() {
    if (!selectedBookId) return;
    var title = selectedBook ? selectedBook.title : selectedBookId;

    if (!confirm('"' + title + '" 도서의 모든 캐시 데이터를 삭제하시겠습니까?')) return;

    try {
      await extDeleteBook(selectedBookId);
      showToast('"' + title + '" 삭제됨');
      selectedBookId = null;
      selectedBook = null;
      $('bookDetail').hidden = true;
      $('emptyState').hidden = false;
      await loadBooks();
    } catch (e) {
      showError('도서 삭제 실패', '"' + title + '" 도서를 삭제하는 중 오류가 발생했습니다.', formatErrorDetail(e));
    }
  }

  // ── Viewer Live Connection ──

  var viewerTabId = null;
  var lastPageGridUpdate = 0;

  function renderScanControls() {
    // Initial check - polling handles the rest
  }

  // Always-on polling: runs entire time session manager is open
  function startLivePolling() {
    if (scanPollInterval) return;
    updateViewerStatus();
    scanPollInterval = setInterval(function () {
      updateViewerStatus();
      refreshPageDataIfNeeded();
    }, 2000);
  }

  function updateViewerStatus() {
    chrome.tabs.query({ url: 'https://wviewer.kyobobook.co.kr/*' }, function (tabs) {
      var hasViewer = tabs && tabs.length > 0;
      var prevTabId = viewerTabId;
      viewerTabId = hasViewer ? tabs[0].id : null;

      // Show/hide buttons
      $('switchToViewerBtn').hidden = !viewerTabId;
      $('openViewerBtn').hidden = !!viewerTabId;

      if (!hasViewer) {
        if (isScanning) {
          isScanning = false;
          refreshBookData();
        }
        setScanUI('disconnected', '뷰어 연결 안 됨');
        return;
      }

      // New viewer appeared - fetch book info and auto-select
      if (!prevTabId && viewerTabId) {
        syncViewerBook(tabs[0].id);
      }

      chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' }, function (r) {
        if (chrome.runtime.lastError || !r) {
          setScanUI('disconnected', '뷰어 응답 없음');
          return;
        }
        var wasScanning = isScanning;
        isScanning = !!r.isCapturing;

        if (isScanning) {
          setScanUI('active', '스캔 진행 중 - 뷰어에서 제어하세요');
        } else if (wasScanning) {
          setScanUI('connected', '뷰어 연결됨');
          refreshBookData();
        } else {
          setScanUI('connected', '뷰어 연결됨');
        }
      });
    });
  }

  // Viewer connected: get book info + TOC → auto-select in session manager
  function syncViewerBook(tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'getPageInfo' }, function (r) {
      if (chrome.runtime.lastError || !r || !r.success || !r.data) return;
      var title = r.data.title;
      var total = r.data.total;
      if (!title) return;

      var bookId = 'title:' + title;

      // Also fetch TOC from the viewer immediately
      chrome.tabs.sendMessage(tabId, { action: 'getTOC' }, function (tocR) {
        void chrome.runtime.lastError;
        var liveToc = (tocR && tocR.success && tocR.data) ? tocR.data : [];

        loadBooks().then(function () {
          var found = null;
          for (var i = 0; i < books.length; i++) {
            if (books[i].title === title) { found = books[i]; break; }
          }

          if (found) {
            // Update TOC if viewer has a better one
            if (liveToc.length > 0 && (!found.toc || found.toc.length === 0 || liveToc.length > found.toc.length)) {
              found.toc = liveToc;
              extStoreBookMeta(found.bookId, found.title, found.totalPages, liveToc).catch(function () {});
            }
            selectBook(found.bookId);
          } else {
            selectedBookId = bookId;
            selectedBook = { bookId: bookId, title: title, totalPages: total || 0, toc: liveToc, cachedCount: 0 };
            capturedPageNums = [];
            // Save metadata with TOC
            if (liveToc.length > 0) {
              extStoreBookMeta(bookId, title, total || 0, liveToc).catch(function () {});
            }
            $('emptyState').hidden = true;
            $('bookDetail').hidden = false;
            renderBookList();
            renderDetail();
          }
        });
      });
    });
  }

  function setScanUI(state, statusText) {
    var dot = $('scanDot');
    var text = $('scanStatusText');

    var totalPages = (selectedBook && selectedBook.totalPages) || 0;
    var cachedCount = capturedPageNums.length;
    var isComplete = totalPages > 0 && cachedCount >= totalPages;

    // Hide scan card when complete + disconnected (avoids duplicate with complete-badge)
    if (isComplete && state !== 'active' && state !== 'recovering' && state !== 'connected') {
      $('scanCard').hidden = true;
      return;
    }
    $('scanCard').hidden = false;

    if (isComplete && state !== 'active' && state !== 'recovering') {
      dot.className = 'scan-dot complete';
      text.textContent = '스캔 완료';
      $('scanLiveInfo').hidden = true;
    } else if (state === 'recovering') {
      dot.className = 'scan-dot active';
      text.textContent = statusText;
      $('scanLiveInfo').hidden = false;
    } else if (state === 'active') {
      dot.className = 'scan-dot active';
      text.textContent = statusText;
      $('scanLiveInfo').hidden = false;
    } else if (state === 'error') {
      dot.className = 'scan-dot idle';
      text.textContent = statusText;
      $('scanLiveInfo').hidden = true;
    } else if (state === 'connected') {
      dot.className = 'scan-dot complete';
      text.textContent = statusText;
      $('scanLiveInfo').hidden = true;
    } else {
      dot.className = 'scan-dot idle';
      text.textContent = statusText;
      $('scanLiveInfo').hidden = true;
    }
  }

  // Incremental page grid update: flip a single tile without full re-render
  function markPageCaptured(pageNum) {
    if (capturedPageNums.indexOf(pageNum) !== -1) return;
    capturedPageNums.push(pageNum);
    capturedPageNums.sort(function (a, b) { return a - b; });

    var grid = $('pageGrid');
    var tile = grid.querySelector('[data-page="' + pageNum + '"]');
    if (tile) {
      tile.className = 'page-tile captured';
      tile.dataset.loaded = 'false';
      tile.title = pageNum + '페이지';
      tile.addEventListener('click', function (e) {
        if (e.target.classList.contains('tile-check')) return;
        openPreview(parseInt(this.dataset.page, 10));
      });
    }

    // Update counters
    var totalPages = (selectedBook && selectedBook.totalPages) || 0;
    if (totalPages > 0) {
      var pct = Math.round(capturedPageNums.length / totalPages * 100);
      $('detailFill').style.width = pct + '%';
      $('detailProgress').textContent = pct + '%';
      $('gridLabel').textContent = '페이지 맵 (' + capturedPageNums.length + '/' + totalPages + ')';
    }
  }

  // Mark specific pages as failed (red) in the grid
  function markPagesFailed(failedPages) {
    var grid = $('pageGrid');
    if (!grid) return;
    for (var i = 0; i < failedPages.length; i++) {
      var tile = grid.querySelector('[data-page="' + failedPages[i] + '"]');
      if (tile) {
        tile.className = 'page-tile failed';
        tile.title = failedPages[i] + '페이지 (캡처 실패)';
      }
    }
  }

  // ── Missing ranges ──
  function renderMissingRanges() {
    var totalPages = (selectedBook && selectedBook.totalPages) || 0;
    var section = $('missingSection');
    if (totalPages === 0) { section.hidden = true; return; }

    var capturedSet = {};
    capturedPageNums.forEach(function (n) { capturedSet[n] = true; });

    // Find contiguous missing ranges
    var ranges = [];
    var rangeStart = 0;
    for (var p = 1; p <= totalPages; p++) {
      if (!capturedSet[p]) {
        if (rangeStart === 0) rangeStart = p;
      } else {
        if (rangeStart > 0) {
          ranges.push({ start: rangeStart, end: p - 1 });
          rangeStart = 0;
        }
      }
    }
    if (rangeStart > 0) ranges.push({ start: rangeStart, end: totalPages });

    // Find contiguous suspect ranges
    var suspectPages = inspectionData && inspectionData.suspectPages ? inspectionData.suspectPages : [];
    var suspectSet = {};
    suspectPages.forEach(function (n) { suspectSet[n] = true; });

    var suspectRanges = [];
    var sStart = 0;
    var sortedSuspect = suspectPages.slice().sort(function (a, b) { return a - b; });
    for (var si = 0; si < sortedSuspect.length; si++) {
      var sp = sortedSuspect[si];
      if (sStart === 0) {
        sStart = sp;
      } else if (sp !== sortedSuspect[si - 1] + 1) {
        suspectRanges.push({ start: sStart, end: sortedSuspect[si - 1] });
        sStart = sp;
      }
    }
    if (sStart > 0 && sortedSuspect.length > 0) {
      suspectRanges.push({ start: sStart, end: sortedSuspect[sortedSuspect.length - 1] });
    }

    var hasMissing = ranges.length > 0;
    var hasSuspect = suspectRanges.length > 0;

    if (!hasMissing && !hasSuspect) { section.hidden = true; return; }

    section.hidden = false;

    var html = '';

    // Missing ranges
    if (hasMissing) {
      var totalMissing = 0;
      ranges.forEach(function (r) { totalMissing += r.end - r.start + 1; });
      html += '<div class="range-section-label missing-label">누락 ' + totalMissing + '페이지 · ' + ranges.length + '구간</div>';
      for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        var count = r.end - r.start + 1;
        var label = r.start === r.end ? r.start + 'p' : r.start + '-' + r.end + 'p';
        html += '<div class="missing-range">' +
          '<span class="range-text">' + label + '</span>' +
          '<span class="range-count">' + count + '개</span>' +
          '<button class="range-rescan" data-start="' + r.start + '" data-end="' + r.end + '">재스캔</button>' +
        '</div>';
      }
    }

    // Suspect ranges
    if (hasSuspect) {
      html += '<div class="range-section-label suspect-label">의심 ' + suspectPages.length + '페이지 · ' + suspectRanges.length + '구간</div>';
      for (var j = 0; j < suspectRanges.length; j++) {
        var sr = suspectRanges[j];
        var scount = sr.end - sr.start + 1;
        var slabel = sr.start === sr.end ? sr.start + 'p' : sr.start + '-' + sr.end + 'p';
        html += '<div class="missing-range suspect-range">' +
          '<span class="range-text">' + slabel + '</span>' +
          '<span class="range-count">' + scount + '개</span>' +
          '<button class="range-rescan" data-start="' + sr.start + '" data-end="' + sr.end + '">재스캔</button>' +
        '</div>';
      }
    }

    $('missingLabel').textContent = '누락 · 의심 구간';
    $('missingRanges').innerHTML = html;

    // Bind rescan buttons
    $('missingRanges').querySelectorAll('.range-rescan').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var start = parseInt(this.dataset.start, 10);
        var end = parseInt(this.dataset.end, 10);
        rescanRange(start, end);
      });
    });
  }

  function rescanRange(startPage, endPage) {
    if (!viewerTabId) {
      showToast('뷰어가 연결되어야 재스캔 가능합니다');
      return;
    }
    chrome.tabs.sendMessage(viewerTabId, {
      action: 'startCapture',
      options: {
        startPage: startPage, endPage: endPage,
        mode: 'normal', autoRetry: true, captureDelay: 500,
        pageDelayMin: 800, pageDelayMax: 1500, resume: true
      }
    }, function (r) {
      void chrome.runtime.lastError;
      if (r && r.success) {
        showToast(startPage + '-' + endPage + 'p 재스캔 시작');
        // Switch to viewer
        chrome.tabs.update(viewerTabId, { active: true });
      } else {
        showToast('재스캔 시작 실패');
      }
    });
  }

  // ── Batch delete ──
  function updateBatchBtn() {
    var checked = $('pageGrid').querySelectorAll('.tile-check:checked');
    var count = checked.length;
    if (count === 0) {
      $('batchConfirmBtn').hidden = true;
      $('batchDeleteBtn').hidden = true;
      return;
    }

    // Analyze what's selected
    var hasCaptured = false, hasSuspect = false;
    checked.forEach(function (cb) {
      var tile = cb.parentElement;
      if (tile.classList.contains('suspect') || tile.classList.contains('failed')) hasSuspect = true;
      if (tile.classList.contains('captured')) hasCaptured = true;
    });

    // suspect/failed selected → show "정상 확인" + "삭제"
    // captured selected → show "삭제" only
    // missing/failed → nothing useful (can't delete what's not there)
    $('batchConfirmBtn').hidden = !hasSuspect;
    $('batchDeleteBtn').hidden = !(hasCaptured || hasSuspect);
    $('batchConfirmBtn').textContent = count + '개 정상 확인';
    $('batchDeleteBtn').textContent = count + '개 삭제';
  }

  async function batchDeletePages(pageNums) {
    for (var i = 0; i < pageNums.length; i++) {
      try { await extDeletePage(selectedBookId, pageNums[i]); } catch (e) {}
      // Remove from thumb cache and inspection
      delete thumbCache[pageNums[i]];
    }
    capturedPageNums = capturedPageNums.filter(function (n) { return pageNums.indexOf(n) === -1; });
    // Update stored inspection count to match (avoid re-inspection)
    updateInspectionAfterDelete(pageNums);
    showToast(pageNums.length + '개 페이지 삭제됨');
    renderDetail();
    await loadBooks();
    renderBookList();
  }

  function updateInspectionAfterDelete(deletedPages) {
    var key = getInspectionKey();
    chrome.storage.local.get(key, function (d) {
      var stored = d[key];
      if (!stored) return;
      // Remove deleted pages from inspection data
      var delSet = {};
      deletedPages.forEach(function (p) { delSet[p] = true; });
      stored.count = capturedPageNums.length;
      stored.suspectPages = (stored.suspectPages || []).filter(function (p) { return !delSet[p]; });
      if (stored.thumbs) {
        deletedPages.forEach(function (p) { delete stored.thumbs[p]; });
      }
      var obj = {};
      obj[key] = stored;
      chrome.storage.local.set(obj);
    });
  }

  // ── Manual page status override (persisted) ──
  var confirmedPages = {}; // pageNum → true (persisted in chrome.storage)

  function loadConfirmedPages() {
    if (!selectedBookId) return;
    var key = 'confirmed_' + selectedBookId;
    chrome.storage.local.get(key, function (d) {
      var arr = d[key] || [];
      confirmedPages = {};
      arr.forEach(function (p) { confirmedPages[p] = true; });
    });
  }

  function saveConfirmedPages() {
    if (!selectedBookId) return;
    var key = 'confirmed_' + selectedBookId;
    var obj = {};
    obj[key] = Object.keys(confirmedPages).map(Number);
    chrome.storage.local.set(obj);
  }

  function setPageStatus(pageNum, status) {
    var grid = $('pageGrid');
    var tile = grid.querySelector('[data-page="' + pageNum + '"]');
    if (tile) {
      tile.classList.remove('captured', 'suspect', 'failed');
      tile.classList.add(status);
      tile.title = pageNum + '페이지';
    }
    if (status === 'captured') {
      confirmedPages[pageNum] = true;
      saveConfirmedPages();
    }
    showToast(pageNum + 'p → 정상 확인');
  }

  // Periodic DB refresh for page data (catches any missed real-time updates)
  function refreshPageDataIfNeeded() {
    if (!selectedBookId) return;
    var now = Date.now();
    if (now - lastPageGridUpdate < 5000) return; // Max once per 5s
    lastPageGridUpdate = now;

    extGetPagesInfo(selectedBookId).then(function (pagesInfo) {
      var newNums = pagesInfo.map(function (p) { return p.pageNum; }).sort(function (a, b) { return a - b; });
      if (newNums.length !== capturedPageNums.length) {
        capturedPageNums = newNums;
        renderDetail();
        loadBooks().then(renderBookList);
      }
    }).catch(function () {});
  }

  function switchToViewer() {
    if (viewerTabId) {
      chrome.tabs.update(viewerTabId, { active: true });
    }
  }

  function openViewer() {
    if (!selectedBook || !selectedBook.title) {
      showToast('도서관 페이지에서 바로보기로 뷰어를 열어주세요');
      return;
    }
    chrome.runtime.sendMessage({
      target: 'background', action: 'startCaptureForBook',
      bookTitle: selectedBook.title, resume: false
    }, function () { void chrome.runtime.lastError; });
    showToast('뷰어 여는 중...');
  }

  async function refreshBookData() {
    if (!selectedBookId) return;
    try {
      selectedBook = await extGetBookMeta(selectedBookId);
      var pagesInfo = await extGetPagesInfo(selectedBookId);
      capturedPageNums = pagesInfo.map(function (p) { return p.pageNum; }).sort(function (a, b) { return a - b; });
    } catch (e) {}
    if (!selectedBook) selectedBook = findBookInList(selectedBookId);
    renderDetail();
    await loadBooks();
    renderBookList();
  }

  function setupScanListeners() {
    // Viewer buttons
    $('switchToViewerBtn').addEventListener('click', switchToViewer);
    $('openViewerBtn').addEventListener('click', openViewer);

    // Start always-on polling
    startLivePolling();

    // Listen for real-time messages from content.js
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg.source !== 'KYOBO_CONTENT') return;

      switch (msg.type) {
        case 'bookMetaCached':
          loadBooks().then(function () {
            if (msg.data && msg.data.bookId && !selectedBookId) {
              selectBook(msg.data.bookId);
            } else if (msg.data && msg.data.bookId && selectedBookId === msg.data.bookId) {
              refreshBookData();
            }
          });
          break;

        case 'captureStarted':
          isScanning = true;
          setScanUI('active', '스캔 진행 중 - 뷰어에서 제어하세요');
          break;

        case 'captureProgress':
          if (msg.data) {
            isScanning = true;
            var pct = msg.data.total > 0 ? Math.round(msg.data.current / msg.data.total * 100) : 0;
            $('scanFill').style.width = pct + '%';
            $('scanLiveText').textContent = msg.data.current + '/' + msg.data.total + ' (' + pct + '%)' +
              (msg.data.message ? ' - ' + msg.data.message : '');
            setScanUI('active', '스캔 진행 중 - 뷰어에서 제어하세요');

            // Incrementally update page grid tile
            if (msg.data.page && msg.data.message && msg.data.message.indexOf('캡처 완료') !== -1) {
              markPageCaptured(msg.data.page);
            }
          }
          break;

        case 'autoRetrying':
          isScanning = true;
          setScanUI('recovering', '비정상 접근 감지 - 자동 복구 중...');
          $('scanLiveInfo').hidden = false;
          $('scanLiveText').textContent = '뷰어를 다시 여는 중... (자동 재시도)';
          showToast('비정상 접근 감지 - 자동 복구 시도 중');
          break;

        case 'captureComplete':
          isScanning = false;
          clearInspection(); // new scan → re-inspect
          refreshBookData().then(function () {
            // Highlight failed pages in red
            if (msg.data && msg.data.missingPages && msg.data.missingPages.length > 0) {
              markPagesFailed(msg.data.missingPages);
            }
          });
          if (msg.data && msg.data.missing > 0) {
            showToast('스캔 완료 - ' + msg.data.missing + '개 페이지 누락');
          } else {
            showToast('스캔 완료!');
          }
          break;

        case 'captureStopped':
          isScanning = false;
          refreshBookData();
          break;

        case 'captureError':
          isScanning = false;
          refreshBookData();
          if (msg.data) {
            setScanUI('error', '스캔 실패: ' + (msg.data.message || ''));
            showToast('스캔 오류: ' + (msg.data.message || ''));
          }
          break;
      }
    });
  }

  // ── PDF Download ──
  async function downloadPDF() {
    if (!selectedBookId || !selectedBook) return;
    if (typeof window.jspdf === 'undefined') {
      showError('라이브러리 로드 실패', 'jsPDF 라이브러리를 찾을 수 없습니다.', 'lib/jspdf.umd.min.js 파일이 존재하는지 확인하세요.');
      return;
    }

    var totalPages = selectedBook.totalPages || 0;
    var title = selectedBook.title || 'ebook';
    var toc = selectedBook.toc || [];
    var sizeVal = $('pdfSize').value;
    var SIZE_PRESETS = {
      original: null,
      a4: { w: 210, h: 297 },
      b5: { w: 182, h: 257 },
      a5: { w: 148, h: 210 }
    };
    var target = SIZE_PRESETS[sizeVal] || null;

    // Pre-sort TOC by page and build parent map for depth nesting
    var tocByPage = {};
    if (toc && toc.length > 0) {
      toc.forEach(function (t) {
        if (!tocByPage[t.page]) tocByPage[t.page] = [];
        tocByPage[t.page].push(t);
      });
    }
    var outlineParents = {}; // depth -> last outline node at that depth

    showProgress('PDF 생성 중...', 0);
    var sorted = capturedPageNums.slice().sort(function (a, b) { return a - b; });

    try {
      var firstPage = await extGetPage(selectedBookId, sorted[0]);
      if (!firstPage || !firstPage.dataURL) throw new Error('첫 페이지 로드 실패');

      var firstDims = await getImageDimensions(firstPage.dataURL);
      var pageOpts = calcPageDimensions(firstDims.width, firstDims.height, target);

      var jsPDF = window.jspdf.jsPDF;
      var pdf = new jsPDF({
        orientation: pageOpts.orientation,
        unit: 'mm',
        format: [pageOpts.pageW, pageOpts.pageH]
      });

      for (var i = 0; i < sorted.length; i++) {
        var pn = sorted[i];
        updateProgress(Math.round((i / sorted.length) * 100), pn + '페이지 처리 중...');

        var page = (i === 0) ? firstPage : await extGetPage(selectedBookId, pn);
        if (!page || !page.dataURL) continue;

        var imgDims = await getImageDimensions(page.dataURL);

        if (i > 0) {
          var opts = calcPageDimensions(imgDims.width, imgDims.height, target);
          pdf.addPage([opts.pageW, opts.pageH], opts.orientation);
        }

        var layout = calcImageLayout(imgDims.width, imgDims.height, pageOpts.pageW, pageOpts.pageH, target);
        var jpegURL = await toJpegDataURL(page.dataURL, 1.0);
        pdf.addImage(jpegURL, 'JPEG', layout.x, layout.y, layout.w, layout.h);

        // Add TOC bookmarks with proper depth nesting
        if (tocByPage[pn]) {
          tocByPage[pn].forEach(function (entry) {
            try {
              var depth = entry.depth || 1;
              var parent = depth > 1 ? (outlineParents[depth - 1] || null) : null;
              var node = pdf.outline.add(parent, entry.title || ('Page ' + pn), { pageNumber: i + 1 });
              outlineParents[depth] = node;
              // Clear deeper levels when a new node at this depth is added
              for (var d = depth + 1; d <= 10; d++) delete outlineParents[d];
            } catch (e) {}
          });
        }
      }

      updateProgress(100, '파일 저장 중...');
      var sizeSuffix = sizeVal && sizeVal !== 'original' ? '_' + sizeVal.toUpperCase() : '';
      pdf.save(sanitizeFilename(title) + sizeSuffix + '.pdf');
      hideProgress();
      showToast('PDF 저장 완료!');
    } catch (e) {
      showError('PDF 생성 실패', 'PDF 파일을 생성하는 중 오류가 발생했습니다.', formatErrorDetail(e));
    }
  }

  // ── ZIP Download ──
  async function downloadZIP() {
    if (!selectedBookId || !selectedBook) return;
    if (typeof JSZip === 'undefined') {
      showError('라이브러리 로드 실패', 'JSZip 라이브러리를 찾을 수 없습니다.', 'lib/jszip.min.js 파일이 존재하는지 확인하세요.');
      return;
    }

    var title = selectedBook.title || 'ebook';
    showProgress('ZIP 생성 중...', 0);
    var sorted = capturedPageNums.slice().sort(function (a, b) { return a - b; });

    try {
      var zip = new JSZip();
      var imgFolder = zip.folder('images');

      for (var i = 0; i < sorted.length; i++) {
        var pn = sorted[i];
        updateProgress(Math.round((i / sorted.length) * 100), pn + '페이지 추가 중...');

        var page = await extGetPage(selectedBookId, pn);
        if (!page || !page.dataURL) continue;

        var base64 = page.dataURL.split(',')[1];
        var ext = page.dataURL.indexOf('image/png') !== -1 ? '.png' : '.jpg';
        var padNum = String(pn).padStart(4, '0');
        imgFolder.file(padNum + ext, base64, { base64: true });
      }

      updateProgress(95, 'ZIP 압축 중...');
      var blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
      downloadBlob(blob, sanitizeFilename(title) + '_images.zip');
      hideProgress();
      showToast('ZIP 저장 완료!');
    } catch (e) {
      showError('ZIP 생성 실패', 'ZIP 파일을 생성하는 중 오류가 발생했습니다.', formatErrorDetail(e));
    }
  }

  // ── Export session (ZIP with metadata + images) ──
  async function exportSession() {
    if (!selectedBookId || !selectedBook) return;
    if (typeof JSZip === 'undefined') {
      showError('라이브러리 로드 실패', 'JSZip 라이브러리를 찾을 수 없습니다.', 'lib/jszip.min.js 파일이 존재하는지 확인하세요.');
      return;
    }

    var title = selectedBook.title || 'ebook';
    showProgress('세션 내보내기 중...', 0);
    var sorted = capturedPageNums.slice().sort(function (a, b) { return a - b; });

    try {
      var zip = new JSZip();

      var metadata = {
        version: 1,
        bookId: selectedBookId,
        title: selectedBook.title,
        totalPages: selectedBook.totalPages,
        toc: selectedBook.toc || [],
        capturedPages: sorted,
        exportDate: new Date().toISOString()
      };
      zip.file('metadata.json', JSON.stringify(metadata, null, 2));

      var pagesFolder = zip.folder('pages');
      for (var i = 0; i < sorted.length; i++) {
        var pn = sorted[i];
        updateProgress(Math.round((i / sorted.length) * 90), pn + '페이지 내보내기 중...');

        var page = await extGetPage(selectedBookId, pn);
        if (!page || !page.dataURL) continue;

        var pageInfo = {
          pageNum: page.pageNum,
          width: page.width,
          height: page.height
        };
        var base64 = page.dataURL.split(',')[1];
        var ext = page.dataURL.indexOf('image/png') !== -1 ? '.png' : '.jpg';
        var padNum = String(pn).padStart(4, '0');
        pagesFolder.file(padNum + ext, base64, { base64: true });
        pagesFolder.file(padNum + '.json', JSON.stringify(pageInfo));
      }

      updateProgress(95, 'ZIP 압축 중...');
      var blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
      downloadBlob(blob, sanitizeFilename(title) + '_session.zip');
      hideProgress();
      showToast('세션 내보내기 완료!');
    } catch (e) {
      showError('세션 내보내기 실패', '세션 데이터를 내보내는 중 오류가 발생했습니다.', formatErrorDetail(e));
    }
  }

  // ── Import session ──
  async function importSession(file) {
    if (!file) return;
    if (typeof JSZip === 'undefined') {
      showError('라이브러리 로드 실패', 'JSZip 라이브러리를 찾을 수 없습니다.', 'lib/jszip.min.js 파일이 존재하는지 확인하세요.');
      return;
    }

    showProgress('세션 불러오기 중...', 0);

    try {
      var zip = await JSZip.loadAsync(file);
      var metaFile = zip.file('metadata.json');
      if (!metaFile) throw new Error('metadata.json 없음 - 유효한 세션 파일이 아닙니다');

      var metaText = await metaFile.async('string');
      var metadata = JSON.parse(metaText);
      if (!metadata.bookId || typeof metadata.title !== 'string') throw new Error('유효하지 않은 메타데이터');
      metadata.totalPages = (typeof metadata.totalPages === 'number') ? Math.max(0, Math.floor(metadata.totalPages)) : 0;
      metadata.bookId = String(metadata.bookId);
      metadata.title = String(metadata.title);

      updateProgress(5, '메타데이터 저장 중...');
      await extStoreBookMeta(metadata.bookId, metadata.title, metadata.totalPages, metadata.toc || []);

      var pagesFolder = zip.folder('pages');
      var imageFiles = [];
      pagesFolder.forEach(function (relativePath, entry) {
        if (relativePath.endsWith('.jpg') || relativePath.endsWith('.png')) {
          imageFiles.push(entry);
        }
      });

      for (var i = 0; i < imageFiles.length; i++) {
        var entry = imageFiles[i];
        var filename = entry.name.split('/').pop();
        var pageNum = parseInt(filename.replace(/\.(jpg|png)$/, ''), 10);
        updateProgress(5 + Math.round((i / imageFiles.length) * 90), pageNum + '페이지 복원 중...');

        var imgData = await entry.async('base64');
        var isPng = entry.name.endsWith('.png');
        var dataURL = (isPng ? 'data:image/png;base64,' : 'data:image/jpeg;base64,') + imgData;

        var width = 0, height = 0;
        var infoFile = pagesFolder.file(String(pageNum).padStart(4, '0') + '.json');
        if (infoFile) {
          try {
            var info = JSON.parse(await infoFile.async('string'));
            width = info.width || 0;
            height = info.height || 0;
          } catch (e) {}
        }

        if (width === 0 || height === 0) {
          try {
            var dims = await getImageDimensions(dataURL);
            width = dims.width;
            height = dims.height;
          } catch (e) {}
        }

        await extStorePage(metadata.bookId, pageNum, dataURL, width, height);
      }

      hideProgress();
      showToast('"' + metadata.title + '" 불러오기 완료! (' + imageFiles.length + '페이지)');
      await loadBooks();
      selectBook(metadata.bookId);
    } catch (e) {
      showError('세션 불러오기 실패', '세션 파일을 복원하는 중 오류가 발생했습니다.', formatErrorDetail(e));
    }
  }

  // ── Event Listeners ──
  function setupCollapsible(toggleId, iconId, contentId) {
    var collapsed = false;
    $(toggleId).addEventListener('click', function () {
      collapsed = !collapsed;
      $(contentId).hidden = collapsed;
      $(iconId).className = 'collapse-icon' + (collapsed ? ' collapsed' : '');
      $(toggleId).style.marginBottom = collapsed ? '0' : '';
    });
  }

  // ── TOC Rescan ──
  function tocRescan() {
    if (viewerTabId) {
      // Viewer already open — just fetch TOC
      doTocFetch(viewerTabId);
    } else if (selectedBook && selectedBook.title) {
      // No viewer — open it first, then fetch
      showToast('뷰어 여는 중...');
      chrome.runtime.sendMessage({
        target: 'background', action: 'startCaptureForBook',
        bookTitle: selectedBook.title, resume: false
      }, function () { void chrome.runtime.lastError; });
      // Wait for viewer tab to appear, then fetch TOC
      var checkCount = 0;
      var waitForViewer = setInterval(function () {
        checkCount++;
        if (checkCount > 30) { clearInterval(waitForViewer); showToast('뷰어 열기 시간 초과'); return; }
        chrome.tabs.query({ url: 'https://wviewer.kyobobook.co.kr/*' }, function (tabs) {
          if (!tabs || tabs.length === 0) return;
          clearInterval(waitForViewer);
          viewerTabId = tabs[0].id;
          // Wait for content script to be ready
          setTimeout(function () { doTocFetch(viewerTabId); }, 5000);
        });
      }, 1000);
    } else {
      showToast('도서 정보가 없습니다');
    }
  }

  function doTocFetch(tabId) {
    showToast('목차 스캔 중...');
    chrome.tabs.sendMessage(tabId, { action: 'getTOC' }, function (r) {
      if (chrome.runtime.lastError || !r || !r.success) {
        showToast('목차 재스캔 실패 — 뷰어가 아직 로딩 중일 수 있습니다');
        return;
      }
      var newToc = r.data || [];
      if (newToc.length === 0) {
        showToast('뷰어에서 목차를 찾을 수 없습니다');
        return;
      }
      if (selectedBook) {
        selectedBook.toc = newToc;
        extStoreBookMeta(selectedBookId, selectedBook.title, selectedBook.totalPages, newToc).then(function () {
          renderTOC();
          showToast('목차 재스캔 완료 (' + newToc.length + '항목)');
        });
      }
    });
  }

  // ── TOC Visual Editor ──
  var editingToc = [];

  function openTocEditor() {
    editingToc = JSON.parse(JSON.stringify((selectedBook && selectedBook.toc) || []));
    renderTocEditor();
    $('tocEditOverlay').hidden = false;
    $('tocEditStatus').textContent = editingToc.length + '개 항목';
  }

  function closeTocEditor() {
    $('tocEditOverlay').hidden = true;
  }

  function renderTocEditor() {
    var list = $('tocEditList');
    var html = '';

    // Determine max allowed depth per item (can't go deeper than prev item + 1)
    for (var i = 0; i < editingToc.length; i++) {
      var item = editingToc[i];
      var depth = item.depth || 1;
      var isFirst = (i === 0);
      var prevDepth = isFirst ? 0 : (editingToc[i - 1].depth || 1);
      var maxDepth = Math.min(prevDepth + 1, 5);
      var canOutdent = depth > 1;
      var canIndent = depth < maxDepth;

      // Build tree connector: show hierarchy visually
      var treeHtml = '';
      for (var d = 1; d < depth; d++) {
        // Check if there's a sibling at this depth level below
        var hasSiblingBelow = false;
        for (var j = i + 1; j < editingToc.length; j++) {
          var jd = editingToc[j].depth || 1;
          if (jd <= d) { hasSiblingBelow = (jd === d); break; }
          if (jd === d + 1) { hasSiblingBelow = true; break; }
        }
        if (d === depth - 1) {
          // Last connector: └ or ├
          var isLastAtDepth = true;
          for (var k = i + 1; k < editingToc.length; k++) {
            var kd = editingToc[k].depth || 1;
            if (kd < depth) break;
            if (kd === depth) { isLastAtDepth = false; break; }
          }
          treeHtml += '<span class="tree-char">' + (isLastAtDepth ? '└─' : '├─') + '</span>';
        } else {
          // Vertical line or empty
          var hasLine = false;
          for (var m = i + 1; m < editingToc.length; m++) {
            var md = editingToc[m].depth || 1;
            if (md <= d) { hasLine = (md === d); break; }
            if (md > d) hasLine = true;
          }
          treeHtml += '<span class="tree-char">' + (hasLine ? '│&nbsp;' : '&nbsp;&nbsp;') + '</span>';
        }
      }

      html += '<div class="toc-edit-row" data-idx="' + i + '">' +
        '<div class="toc-edit-depth-btns">' +
          '<button class="toc-edit-depth-btn' + (canOutdent ? '' : ' disabled') + '" data-action="outdent" data-idx="' + i + '" title="상위로" ' + (canOutdent ? '' : 'disabled') + '>&lt;</button>' +
          '<button class="toc-edit-depth-btn' + (canIndent ? '' : ' disabled') + '" data-action="indent" data-idx="' + i + '" title="하위로" ' + (canIndent ? '' : 'disabled') + '>&gt;</button>' +
        '</div>' +
        '<div class="toc-edit-tree">' + treeHtml + '</div>' +
        '<input class="toc-edit-title" data-idx="' + i + '" value="' + escAttr(item.title || '') + '" placeholder="제목">' +
        '<input class="toc-edit-page" type="number" data-idx="' + i + '" value="' + (item.page || '') + '" placeholder="p">' +
        '<button class="toc-edit-del" data-action="delete" data-idx="' + i + '" title="삭제">✕</button>' +
      '</div>';
    }
    if (editingToc.length === 0) {
      html = '<div style="padding:40px;text-align:center;color:#aeaeb2;font-size:13px">목차 항목이 없습니다. + 추가 버튼을 눌러주세요.</div>';
    }
    list.innerHTML = html;
    $('tocEditStatus').textContent = editingToc.length + '개 항목';

    // Bind events
    list.querySelectorAll('[data-action]').forEach(function (btn) {
      if (btn.disabled) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(this.dataset.idx, 10);
        var action = this.dataset.action;
        if (action === 'indent') {
          editingToc[idx].depth = (editingToc[idx].depth || 1) + 1;
        } else if (action === 'outdent') {
          editingToc[idx].depth = (editingToc[idx].depth || 1) - 1;
        } else if (action === 'delete') {
          editingToc.splice(idx, 1);
        }
        renderTocEditor();
      });
    });
    list.querySelectorAll('.toc-edit-title').forEach(function (inp) {
      inp.addEventListener('input', function () {
        editingToc[parseInt(this.dataset.idx, 10)].title = this.value;
      });
    });
    list.querySelectorAll('.toc-edit-page').forEach(function (inp) {
      inp.addEventListener('input', function () {
        editingToc[parseInt(this.dataset.idx, 10)].page = parseInt(this.value, 10) || 0;
      });
    });
  }

  function addTocItem() {
    editingToc.push({ page: 0, title: '', depth: 1 });
    renderTocEditor();
    // Focus new item's title
    var inputs = $('tocEditList').querySelectorAll('.toc-edit-title');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  }

  function saveTocEdit() {
    // Filter out empty items
    var cleaned = editingToc.filter(function (item) { return item.title && item.page > 0; });
    if (selectedBook) {
      selectedBook.toc = cleaned;
      extStoreBookMeta(selectedBookId, selectedBook.title, selectedBook.totalPages, cleaned).then(function () {
        renderTOC();
        closeTocEditor();
        showToast('목차 저장 완료 (' + cleaned.length + '항목)');
      });
    }
  }

  function setupEventListeners() {
    $('deleteBookBtn').addEventListener('click', deleteBook);
    $('dlPdf').addEventListener('click', downloadPDF);
    $('dlZip').addEventListener('click', downloadZIP);
    $('exportBtn').addEventListener('click', exportSession);
    $('tocRescanBtn').addEventListener('click', tocRescan);
    $('tocEditBtn').addEventListener('click', openTocEditor);
    $('tocEditClose').addEventListener('click', closeTocEditor);
    $('tocEditBackdrop').addEventListener('click', closeTocEditor);
    $('tocEditSave').addEventListener('click', saveTocEdit);
    $('tocAddBtn').addEventListener('click', addTocItem);
    $('openReaderBtn').addEventListener('click', function () {
      if (!selectedBookId) return;
      chrome.runtime.sendMessage({
        target: 'background', action: 'openReader', bookId: selectedBookId
      }, function () { void chrome.runtime.lastError; });
    });

    // Collapsible sections
    setupCollapsible('tocToggle', 'tocIcon', 'tocList');
    setupCollapsible('gridToggle', 'gridIcon', 'pageGrid');

    // Rescan all missing
    $('rescanAllBtn').addEventListener('click', function () {
      var totalPages = (selectedBook && selectedBook.totalPages) || 0;
      if (totalPages === 0) return;
      var capturedSet = {};
      capturedPageNums.forEach(function (n) { capturedSet[n] = true; });
      // Find first missing and last missing
      var first = 0, last = 0;
      for (var p = 1; p <= totalPages; p++) {
        if (!capturedSet[p]) { if (!first) first = p; last = p; }
      }
      if (first === 0) { showToast('누락 페이지 없음'); return; }
      rescanRange(first, last);
    });

    // Grid filters
    $('gridFilters').querySelectorAll('.grid-filter').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $('gridFilters').querySelectorAll('.grid-filter').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        var filter = this.dataset.filter;
        var grid = $('pageGrid');
        var isSelect = grid.classList.contains('select-mode');
        grid.className = 'page-grid' + (filter !== 'all' ? ' filter-' + filter : '') + (isSelect ? ' select-mode' : '');
        updateBatchBtn();
      });
    });

    // Select all / deselect (respects active filter)
    $('selectAllBtn').addEventListener('click', function () {
      $('pageGrid').querySelectorAll('.page-tile').forEach(function (tile) {
        // Skip tiles hidden by CSS filter
        if (tile.offsetWidth === 0) return;
        var cb = tile.querySelector('.tile-check');
        if (cb) { cb.checked = true; tile.classList.add('selected'); }
      });
      updateBatchBtn();
    });
    $('deselectAllBtn').addEventListener('click', function () {
      $('pageGrid').querySelectorAll('.tile-check:checked').forEach(function (cb) {
        cb.checked = false;
        cb.parentElement.classList.remove('selected');
      });
      updateBatchBtn();
    });

    // Batch confirm normal
    $('batchConfirmBtn').addEventListener('click', function () {
      var checked = $('pageGrid').querySelectorAll('.tile-check:checked');
      var count = 0;
      checked.forEach(function (cb) {
        var tile = cb.parentElement;
        var pn = parseInt(cb.dataset.page, 10);
        if (tile.classList.contains('suspect') || tile.classList.contains('failed')) {
          tile.classList.remove('suspect', 'failed');
          tile.classList.add('captured');
          tile.title = pn + '페이지';
          confirmedPages[pn] = true;
          count++;
        }
        cb.checked = false;
        tile.classList.remove('selected');
      });
      saveConfirmedPages();
      updateBatchBtn();
      showToast(count + '개 페이지 정상 확인');
    });

    // Batch delete
    $('batchDeleteBtn').addEventListener('click', function () {
      var checked = $('pageGrid').querySelectorAll('.tile-check:checked');
      var pages = [];
      checked.forEach(function (cb) { pages.push(parseInt(cb.dataset.page, 10)); });
      if (pages.length === 0) return;
      if (!confirm(pages.length + '개 페이지를 삭제하시겠습니까?')) return;
      batchDeletePages(pages);
    });

    // Delegate checkbox clicks on grid
    $('pageGrid').addEventListener('change', function (e) {
      if (e.target.classList.contains('tile-check')) {
        e.target.parentElement.classList.toggle('selected', e.target.checked);
        updateBatchBtn();
      }
    });

    $('importBtn').addEventListener('click', function () {
      $('importFile').click();
    });
    $('importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) {
        importSession(this.files[0]);
        this.value = '';
      }
    });

    // Preview modal
    $('modalClose').addEventListener('click', closePreview);
    $('modalBackdrop').addEventListener('click', closePreview);
    $('prevPage').addEventListener('click', function () { navigatePreview(-1); });
    $('nextPage').addEventListener('click', function () { navigatePreview(1); });
    $('deletePageBtn').addEventListener('click', function () {
      if (previewPageNum > 0) deletePage(previewPageNum);
    });
    $('markNormalBtn').addEventListener('click', function () {
      setPageStatus(previewPageNum, 'captured');
      updatePreviewButtons();
    });

    // Error dialog
    $('errorCloseBtn').addEventListener('click', hideError);
    $('errorBackdrop').addEventListener('click', hideError);
    $('errorCopyBtn').addEventListener('click', function () {
      navigator.clipboard.writeText(getErrorText()).then(function () {
        $('errorCopyBtn').textContent = '복사됨!';
        setTimeout(function () { $('errorCopyBtn').textContent = '복사'; }, 1500);
      });
    });

    // Keyboard navigation
    document.addEventListener('keydown', function (e) {
      if (!$('errorDialog').hidden) {
        if (e.key === 'Escape') hideError();
        return;
      }
      if ($('previewModal').hidden) return;
      if (e.key === 'Escape') closePreview();
      if (e.key === 'ArrowLeft') navigatePreview(-1);
      if (e.key === 'ArrowRight') navigatePreview(1);
    });
  }

  // ── Helpers ──

  // Convert PNG dataURL to JPEG for PDF (reduces size ~10x)
  function toJpegDataURL(dataURL, quality) {
    return new Promise(function (resolve) {
      if (dataURL.indexOf('image/png') === -1) { resolve(dataURL); return; }
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/jpeg', quality || 0.92));
      };
      img.onerror = function () { resolve(dataURL); };
      img.src = dataURL;
    });
  }

  function getImageDimensions(dataURL) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve({ width: img.width, height: img.height }); };
      img.onerror = function () { reject(new Error('Image load failed')); };
      img.src = dataURL;
    });
  }

  function calcPageDimensions(imgW, imgH, target) {
    if (!target) {
      var PX_TO_MM = 25.4 / 96;
      return {
        pageW: imgW * PX_TO_MM,
        pageH: imgH * PX_TO_MM,
        orientation: imgW > imgH ? 'landscape' : 'portrait'
      };
    }
    return {
      pageW: target.w,
      pageH: target.h,
      orientation: 'portrait'
    };
  }

  function calcImageLayout(imgW, imgH, pageW, pageH, target) {
    if (!target) {
      return { x: 0, y: 0, w: pageW, h: pageH };
    }
    var margin = 5;
    var areaW = pageW - margin * 2;
    var areaH = pageH - margin * 2;
    var scale = Math.min(areaW / imgW, areaH / imgH);
    var w = imgW * scale;
    var h = imgH * scale;
    return {
      x: (pageW - w) / 2,
      y: (pageH - h) / 2,
      w: w,
      h: h
    };
  }

  function sanitizeFilename(name) {
    return (name || 'ebook').replace(/[\\/:*?"<>|]/g, '_').substring(0, 100);
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function showProgress(title, pct) {
    $('progressOverlay').hidden = false;
    $('progressTitle').textContent = title;
    $('progressFill').style.width = pct + '%';
    $('progressText').textContent = pct + '%';
  }

  function updateProgress(pct, text) {
    $('progressFill').style.width = pct + '%';
    $('progressText').textContent = text || (pct + '%');
  }

  function hideProgress() {
    $('progressOverlay').hidden = true;
  }

  var toastTimer = null;
  function showToast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3000);
  }

  function showError(title, message, detail) {
    console.error('[SessionManager]', title, message, detail);
    hideProgress();
    $('errorDialog').hidden = false;
    $('errorTitle').textContent = title || '오류 발생';
    $('errorMessage').textContent = message || '';
    $('errorDetail').textContent = detail || '(상세 정보 없음)';
  }

  function hideError() {
    $('errorDialog').hidden = true;
  }

  function getErrorText() {
    var title = $('errorTitle').textContent;
    var message = $('errorMessage').textContent;
    var detail = $('errorDetail').textContent;
    var parts = [title];
    if (message) parts.push(message);
    if (detail) parts.push('\n' + detail);
    return parts.join('\n');
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return '방금 전';
    if (d < 3600) return Math.floor(d / 60) + '분 전';
    if (d < 86400) return Math.floor(d / 3600) + '시간 전';
    return Math.floor(d / 86400) + '일 전';
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function escAttr(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  init().catch(function (e) {
    showGlobalError('초기화 실패', '세션 관리자를 시작할 수 없습니다.', e);
  });
})();
