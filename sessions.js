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
    selectedBookId = bookId;
    selectedBook = null;
    capturedPageNums = [];

    $('emptyState').hidden = true;
    $('bookDetail').hidden = false;

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
    var pct = totalPages > 0 ? Math.round(cachedCount / totalPages * 100) : 0;
    var isComplete = totalPages > 0 && cachedCount >= totalPages;
    var hasData = cachedCount > 0 || totalPages > 0;

    $('detailTitle').textContent = title;

    // Meta info
    if (hasData) {
      var missingCount = totalPages > 0 ? totalPages - cachedCount : 0;
      var metaHtml = '<span>' + esc(String(totalPages)) + ' 페이지</span>' +
        '<span>' + esc(String(cachedCount)) + ' 캡처됨</span>';
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

    // Progress bar
    var fill = $('detailFill');
    fill.style.width = pct + '%';
    fill.className = 'progress-fill' + (isComplete ? ' complete' : '');
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

    // Show/hide sections based on data availability
    $('downloadToolbar').hidden = cachedCount === 0;
    $('gridSection').hidden = totalPages === 0;

    // TOC
    renderTOC();

    renderPageGrid();
    renderScanControls();
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

  // ── Render page grid ──
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
      html += '<div class="page-tile ' + (isCaptured ? 'captured' : 'missing') + '" data-page="' + p + '" title="' + p + '페이지' + (isCaptured ? '' : ' (누락)') + '">' + p + '</div>';
    }
    grid.innerHTML = html;

    grid.querySelectorAll('.page-tile.captured').forEach(function (tile) {
      tile.addEventListener('click', function () {
        openPreview(parseInt(this.dataset.page, 10));
      });
    });

    $('gridLabel').textContent = '페이지 맵 (' + capturedPageNums.length + '/' + totalPages + ')';
  }

  // ── Preview modal ──
  async function openPreview(pageNum) {
    if (!selectedBookId) return;

    previewPageNum = pageNum;
    $('previewModal').hidden = false;
    $('previewImg').src = '';
    $('modalTitle').textContent = pageNum + '페이지';
    $('modalInfo').textContent = '로딩 중...';
    updateNavButtons();

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
    var idx = capturedPageNums.indexOf(previewPageNum);
    $('prevPage').disabled = (idx <= 0);
    $('nextPage').disabled = (idx < 0 || idx >= capturedPageNums.length - 1);
  }

  function navigatePreview(direction) {
    var idx = capturedPageNums.indexOf(previewPageNum);
    if (idx < 0) return;

    var newIdx = idx + direction;
    if (newIdx >= 0 && newIdx < capturedPageNums.length) {
      openPreview(capturedPageNums[newIdx]);
    }
  }

  // ── Delete page ──
  async function deletePage(pageNum) {
    if (!selectedBookId || !pageNum) return;

    try {
      await extDeletePage(selectedBookId, pageNum);
      capturedPageNums = capturedPageNums.filter(function (n) { return n !== pageNum; });
      showToast(pageNum + '페이지 삭제됨');
      renderDetail();

      var sorted = capturedPageNums.slice().sort(function (a, b) { return a - b; });
      if (sorted.length === 0) {
        closePreview();
      } else {
        var nextPage = sorted.find(function (n) { return n > pageNum; }) || sorted[sorted.length - 1];
        openPreview(nextPage);
      }

      await loadBooks();
      renderBookList();
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

  // Viewer connected: get book info → auto-select in session manager
  function syncViewerBook(tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'getPageInfo' }, function (r) {
      if (chrome.runtime.lastError || !r || !r.success || !r.data) return;
      var title = r.data.title;
      var total = r.data.total;
      if (!title) return;

      var bookId = 'title:' + title;

      // Reload books from DB (metadata may have just been cached)
      loadBooks().then(function () {
        // Find this book in the list
        var found = null;
        for (var i = 0; i < books.length; i++) {
          if (books[i].title === title) { found = books[i]; break; }
        }

        if (found) {
          selectBook(found.bookId);
        } else {
          // Not in DB yet - create placeholder and select
          selectedBookId = bookId;
          selectedBook = { bookId: bookId, title: title, totalPages: total || 0, toc: [], cachedCount: 0 };
          capturedPageNums = [];
          $('emptyState').hidden = true;
          $('bookDetail').hidden = false;
          renderBookList();
          renderDetail();
        }
      });
    });
  }

  function setScanUI(state, statusText) {
    var dot = $('scanDot');
    var text = $('scanStatusText');

    var totalPages = (selectedBook && selectedBook.totalPages) || 0;
    var cachedCount = capturedPageNums.length;
    var isComplete = totalPages > 0 && cachedCount >= totalPages;

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
      tile.title = pageNum + '페이지';
      tile.addEventListener('click', function () {
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
          refreshBookData();
          showToast('스캔 완료!');
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
      pdf.save(sanitizeFilename(title) + '.pdf');
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

  function setupEventListeners() {
    $('deleteBookBtn').addEventListener('click', deleteBook);
    $('dlPdf').addEventListener('click', downloadPDF);
    $('dlZip').addEventListener('click', downloadZIP);
    $('exportBtn').addEventListener('click', exportSession);
    $('openReaderBtn').addEventListener('click', function () {
      if (!selectedBookId) return;
      chrome.runtime.sendMessage({
        target: 'background', action: 'openReader', bookId: selectedBookId
      }, function () { void chrome.runtime.lastError; });
    });

    // Collapsible sections
    setupCollapsible('tocToggle', 'tocIcon', 'tocList');
    setupCollapsible('gridToggle', 'gridIcon', 'pageGrid');

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
      if (previewPageNum > 0 && confirm(previewPageNum + '페이지를 삭제하시겠습니까?')) {
        deletePage(previewPageNum);
      }
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
