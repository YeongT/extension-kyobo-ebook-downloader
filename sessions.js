(function () {
  'use strict';

  var S = window._S;

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
  S.formatErrorDetail = formatErrorDetail;

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

  // ── Shared state ──
  S.books = [];
  S.selectedBookId = null;
  S.selectedBook = null;
  S.capturedPageNums = [];

  // ── DOM shortcut ──
  S.$ = function (id) { return document.getElementById(id); };
  var $ = S.$;

  // ── Helpers (progress, toast, error) ──
  S.showProgress = function (title, pct) {
    $('progressOverlay').hidden = false;
    $('progressTitle').textContent = title;
    $('progressFill').style.width = pct + '%';
    $('progressText').textContent = pct + '%';
  };

  S.updateProgress = function (pct, text) {
    $('progressFill').style.width = pct + '%';
    $('progressText').textContent = text || (pct + '%');
  };

  S.hideProgress = function () {
    $('progressOverlay').hidden = true;
  };

  var toastTimer = null;
  S.showToast = function (msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3000);
  };

  S.showError = function (title, message, detail) {
    console.error('[SessionManager]', title, message, detail);
    S.hideProgress();
    $('errorDialog').hidden = false;
    $('errorTitle').textContent = title || '오류 발생';
    $('errorMessage').textContent = message || '';
    $('errorDetail').textContent = detail || '(상세 정보 없음)';
  };

  S.hideError = function () {
    $('errorDialog').hidden = true;
  };

  function getErrorText() {
    var title = $('errorTitle').textContent;
    var message = $('errorMessage').textContent;
    var detail = $('errorDetail').textContent;
    var parts = [title];
    if (message) parts.push(message);
    if (detail) parts.push('\n' + detail);
    return parts.join('\n');
  }

  // ── Init ──
  async function init() {
    await S.loadBooks();
    setupEventListeners();
    setupScanListeners();

    var params = new URLSearchParams(location.search);
    var titleParam = params.get('title');
    var bookParam = params.get('book');

    if (titleParam) {
      await openByTitle(titleParam);
    } else if (bookParam) {
      S.selectBook(bookParam);
    }
  }

  // ── Open by title (from library click) ──
  async function openByTitle(title) {
    var bookId = null;
    try { bookId = await extFindBookByTitle(title); } catch (e) {}

    if (bookId) {
      S.selectBook(bookId);
      return;
    }

    S.selectedBookId = 'title:' + title;
    S.selectedBook = { bookId: S.selectedBookId, title: title, totalPages: 0, toc: [], cachedCount: 0 };
    S.capturedPageNums = [];

    try {
      var stored = await new Promise(function (res) {
        chrome.storage.local.get('sessionManagerBook', function (d) { res(d.sessionManagerBook); });
      });
      if (stored && stored.title === title) {
        S.selectedBook.author = stored.author;
        S.selectedBook.coverUrl = stored.coverUrl;
        S.selectedBook.dueDate = stored.dueDate;
      }
    } catch (e) {}

    $('emptyState').hidden = true;
    $('bookDetail').hidden = false;
    S.renderBookList();
    S.renderDetail();
  }

  // ── Load books from IndexedDB ──
  S.loadBooks = async function () {
    try {
      S.books = await extGetAllBooks();
      S.books.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
    } catch (e) {
      S.books = [];
    }
    S.renderBookList();
  };

  // ── Render sidebar book list ──
  S.renderBookList = function () {
    var container = $('bookList');
    if (!S.books || S.books.length === 0) {
      container.innerHTML = '<div class="book-list-empty">캐시된 도서가 없습니다</div>';
      return;
    }

    var inspectionKeys = S.books.map(function (b) { return 'inspection_' + b.bookId; });
    chrome.storage.local.get(inspectionKeys, function (stored) {
      var html = '';
      for (var i = 0; i < S.books.length; i++) {
        var b = S.books[i];
        var insp = stored['inspection_' + b.bookId];
        var suspectCount = insp && insp.suspectPages ? insp.suspectPages.length : 0;
        var confirmed = (b.cachedCount || 0) - suspectCount;
        var pct = (b.totalPages > 0 && confirmed > 0)
          ? Math.round(confirmed / b.totalPages * 100)
          : 0;
        var isActive = b.bookId === S.selectedBookId;
        var isComplete = b.totalPages > 0 && confirmed >= b.totalPages;
        var hasSuspect = suspectCount > 0;

        var r = 14, stroke = 3, circ = 2 * Math.PI * r;
        var dashOffset = circ - (pct / 100) * circ;
        var ringColor = isComplete ? '#34c759' : hasSuspect ? '#ff9500' : '#e94560';
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
              (hasSuspect ? '<span style="color:#ff9500"> · ' + suspectCount + ' 의심</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      }
      container.innerHTML = html;

      container.querySelectorAll('.book-item').forEach(function (el) {
        el.addEventListener('click', function () {
          S.selectBook(this.dataset.bookid);
        });
      });
    });
  };

  // ── Select a book ──
  S.selectBook = async function (bookId) {
    S.gridLoadAbort = true;
    S.thumbCache = {};
    S.selectedBookId = bookId;
    S.selectedBook = null;
    S.capturedPageNums = [];
    S.confirmedPages = {};

    $('emptyState').hidden = true;
    $('bookDetail').hidden = false;

    S.loadConfirmedPages();
    S.renderBookList();

    try {
      S.selectedBook = await extGetBookMeta(bookId);
      var pagesInfo = await extGetPagesInfo(bookId);
      S.capturedPageNums = pagesInfo.map(function (p) { return p.pageNum; }).sort(function (a, b) { return a - b; });
    } catch (e) {
      S.selectedBook = null;
      S.capturedPageNums = [];
    }

    if (!S.selectedBook) {
      S.selectedBook = S.findBookInList(bookId);
    }

    S.renderDetail();
  };

  S.findBookInList = function (bookId) {
    for (var i = 0; i < S.books.length; i++) {
      if (S.books[i].bookId === bookId) return S.books[i];
    }
    return null;
  };

  // ── Render book detail ──
  S.renderDetail = function () {
    if (!S.selectedBook) {
      $('bookDetail').hidden = true;
      $('emptyState').hidden = false;
      return;
    }

    var title = S.selectedBook.title || '(제목 없음)';
    var totalPages = S.selectedBook.totalPages || 0;
    var cachedCount = S.capturedPageNums.length;
    var suspectCount = S.inspectionData && S.inspectionData.suspectPages ? S.inspectionData.suspectPages.length : 0;
    var confirmedCount = cachedCount - suspectCount;
    var missingCount = totalPages > 0 ? totalPages - cachedCount : 0;
    var pct = totalPages > 0 ? Math.round(confirmedCount / totalPages * 100) : 0;
    var isComplete = totalPages > 0 && confirmedCount >= totalPages;
    var hasData = cachedCount > 0 || totalPages > 0;

    $('detailTitle').textContent = title;

    if (hasData) {
      var metaHtml = '<span>' + esc(String(totalPages)) + ' 페이지</span>' +
        '<span>' + esc(String(cachedCount)) + ' 캡처됨</span>';
      if (suspectCount > 0) {
        metaHtml += '<span style="color:#e94560">' + esc(String(suspectCount)) + ' 의심</span>';
      }
      if (missingCount > 0) {
        metaHtml += '<span style="color:#ff9500">' + esc(String(missingCount)) + ' 누락</span>';
      }
      if (S.selectedBook.timestamp) {
        metaHtml += '<span>' + esc(timeAgo(S.selectedBook.timestamp)) + '</span>';
      }
      $('detailMeta').innerHTML = metaHtml;
      $('detailMeta').hidden = false;
    } else {
      $('detailMeta').innerHTML = '<span style="color:#aeaeb2">아직 스캔되지 않은 도서입니다. 스캔을 시작하세요.</span>';
      $('detailMeta').hidden = false;
    }

    var fill = $('detailFill');
    fill.style.width = pct + '%';
    fill.className = 'progress-fill' + (isComplete ? ' complete' : suspectCount > 0 ? ' has-suspect' : '');
    $('detailProgress').textContent = hasData ? pct + '%' : '';
    $('detailFill').parentElement.parentElement.hidden = !hasData;

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

    $('scanCard').hidden = !S.isScanning;

    var hideDownload = cachedCount === 0;
    $('downloadToolbar').hidden = hideDownload;
    $('pdfGroup').hidden = hideDownload;
    $('dlPdf').disabled = !isComplete;
    $('openReaderBtn').disabled = !isComplete;
    $('gridSection').hidden = totalPages === 0;

    S.renderTOC();
    S.renderMissingRanges();
    S.renderPageGrid();
    renderScanControls();
  };

  // Lightweight header-only refresh
  S.refreshDetailHeader = function () {
    if (!S.selectedBook) return;
    var totalPages = S.selectedBook.totalPages || 0;
    var cachedCount = S.capturedPageNums.length;
    var suspectCount = S.inspectionData && S.inspectionData.suspectPages ? S.inspectionData.suspectPages.length : 0;
    var confirmedCount = cachedCount - suspectCount;
    var missingCount = totalPages > 0 ? totalPages - cachedCount : 0;
    var pct = totalPages > 0 ? Math.round(confirmedCount / totalPages * 100) : 0;
    var isComplete = totalPages > 0 && confirmedCount >= totalPages;

    var metaHtml = '<span>' + esc(String(totalPages)) + ' 페이지</span>' +
      '<span>' + esc(String(cachedCount)) + ' 캡처됨</span>';
    if (suspectCount > 0) {
      metaHtml += '<span style="color:#e94560">' + esc(String(suspectCount)) + ' 의심</span>';
    }
    if (missingCount > 0) {
      metaHtml += '<span style="color:#ff9500">' + esc(String(missingCount)) + ' 누락</span>';
    }
    if (S.selectedBook.timestamp) {
      metaHtml += '<span>' + esc(timeAgo(S.selectedBook.timestamp)) + '</span>';
    }
    $('detailMeta').innerHTML = metaHtml;

    var fill = $('detailFill');
    fill.style.width = pct + '%';
    fill.className = 'progress-fill' + (isComplete ? ' complete' : suspectCount > 0 ? ' has-suspect' : '');
    $('detailProgress').textContent = pct + '%';

    if (isComplete) {
      if ($('completeBadge')) $('completeBadge').hidden = false;
    } else {
      if ($('completeBadge')) $('completeBadge').hidden = true;
    }
    $('dlPdf').disabled = !isComplete;
    $('openReaderBtn').disabled = !isComplete;
  };

  S.updateTocMissingRow = function () {
    var row = $('tocMissingRow');
    if (!row) return;
    var tocVisible = !$('tocSection').hidden;
    var missingVisible = !$('missingSection').hidden;
    row.hidden = !tocVisible && !missingVisible;
    if (row.hidden) return;
    var label = $('infoPanelsLabel');
    if (tocVisible && missingVisible) {
      label.textContent = '목차 · 누락/의심 구간';
    } else if (tocVisible) {
      label.textContent = '목차';
    } else {
      label.textContent = '누락 · 의심 구간';
    }
  };

  // ── Render TOC ──
  S.renderTOC = function () {
    var toc = (S.selectedBook && S.selectedBook.toc) || [];
    var section = $('tocSection');

    if (!toc || toc.length === 0) {
      section.hidden = true;
      S.updateTocMissingRow();
      return;
    }

    section.hidden = false;
    S.updateTocMissingRow();
    $('tocLabel').textContent = '목차 (' + toc.length + '항목)';

    var html = '';
    for (var i = 0; i < toc.length; i++) {
      var entry = toc[i];
      var depth = Math.min(entry.depth || 1, 3);
      html += '<div class="toc-item depth-' + depth + '" data-page="' + entry.page + '">' +
        '<span class="toc-page">' + (entry.page || '') + '</span>' +
        '<span class="toc-title">' + esc(entry.title || '') + '</span>' +
      '</div>';
    }
    $('tocList').innerHTML = html;

    $('tocList').querySelectorAll('.toc-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var pg = parseInt(this.dataset.page, 10);
        if (pg && S.capturedPageNums.indexOf(pg) !== -1) {
          S.openPreview(pg);
        }
      });
    });
  };

  // ── Missing ranges ──
  S.renderMissingRanges = function () {
    var totalPages = (S.selectedBook && S.selectedBook.totalPages) || 0;
    var section = $('missingSection');
    if (totalPages === 0) { section.hidden = true; S.updateTocMissingRow(); return; }

    var capturedSet = {};
    S.capturedPageNums.forEach(function (n) { capturedSet[n] = true; });

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

    var suspectPages = S.inspectionData && S.inspectionData.suspectPages ? S.inspectionData.suspectPages : [];
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

    if (!hasMissing && !hasSuspect) { section.hidden = true; S.updateTocMissingRow(); return; }

    section.hidden = false;
    S.updateTocMissingRow();

    var html = '';

    if (hasMissing) {
      var totalMissing = 0;
      ranges.forEach(function (r) { totalMissing += r.end - r.start + 1; });
      html += '<div class="range-group">';
      html += '<div class="range-section-label missing-label">누락 ' + totalMissing + '페이지 · ' + ranges.length + '구간</div>';
      html += '<div class="range-items">';
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
      html += '</div></div>';
    }

    if (hasSuspect) {
      html += '<div class="range-group">';
      html += '<div class="range-section-label suspect-label">의심 ' + suspectPages.length + '페이지 · ' + suspectRanges.length + '구간</div>';
      html += '<div class="range-items">';
      for (var j = 0; j < suspectRanges.length; j++) {
        var sr = suspectRanges[j];
        var scount = sr.end - sr.start + 1;
        var slabel = sr.start === sr.end ? sr.start + 'p' : sr.start + '-' + sr.end + 'p';
        var reasons = [];
        for (var rp = sr.start; rp <= sr.end; rp++) {
          var rtile = $('pageGrid') ? $('pageGrid').querySelector('[data-page="' + rp + '"]') : null;
          if (rtile && rtile.title) {
            var rm = rtile.title.match(/\((.+)\)/);
            if (rm && reasons.indexOf(rm[1]) === -1) reasons.push(rm[1]);
          }
        }
        var tooltip = reasons.length > 0 ? escAttr(reasons.join(', ')) : '';
        html += '<div class="missing-range suspect-range" ' + (tooltip ? 'data-reason="' + tooltip + '"' : '') + '>' +
          '<span class="range-text">' + slabel + '</span>' +
          '<span class="range-count">' + scount + '개</span>' +
          '<button class="range-rescan" data-start="' + sr.start + '" data-end="' + sr.end + '">재스캔</button>' +
        '</div>';
      }
      html += '</div></div>';
    }

    $('missingLabel').innerHTML = '<strong>누락 · 의심 구간</strong>';
    $('missingRanges').innerHTML = html;

    $('missingRanges').querySelectorAll('.range-rescan').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var start = parseInt(this.dataset.start, 10);
        var end = parseInt(this.dataset.end, 10);
        S.rescanRange(start, end);
      });
    });
  };

  function renderScanControls() {
    // Initial check - polling handles the rest
  }

  // ── Collapsible sections ──
  function setupCollapsible(toggleId, iconId, contentId) {
    var collapsed = false;
    $(toggleId).addEventListener('click', function (e) {
      if (e.target.closest('.toc-action-btn') || e.target.closest('.panel-action-btn')) return;
      collapsed = !collapsed;
      $(contentId).hidden = collapsed;
      $(iconId).className = 'collapse-icon' + (collapsed ? ' collapsed' : '');
      $(toggleId).style.marginBottom = collapsed ? '0' : '';
    });
  }

  // ── Scan listeners (chrome.runtime.onMessage dispatcher) ──
  function setupScanListeners() {
    $('switchToViewerBtn').addEventListener('click', S.switchToViewer);
    $('openViewerBtn').addEventListener('click', S.openViewer);

    S.startLivePolling();

    chrome.tabs.onRemoved.addListener(function (tabId) {
      if (tabId === S.viewerTabId) {
        S.viewerTabId = null;
        S.isScanning = false;
        $('switchToViewerBtn').hidden = true;
        $('openViewerBtn').hidden = false;
        S.setScanUI('disconnected', '뷰어 연결 안 됨');
        S.refreshBookData();
      }
    });

    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg.source !== 'KYOBO_CONTENT') return;

      switch (msg.type) {
        case 'bookMetaCached':
          S.loadBooks().then(function () {
            if (msg.data && msg.data.bookId && !S.selectedBookId) {
              S.selectBook(msg.data.bookId);
            } else if (msg.data && msg.data.bookId && S.selectedBookId === msg.data.bookId) {
              S.refreshBookData();
            }
          });
          break;

        case 'captureStarted':
          S.isScanning = true;
          S.setScanUI('active', '스캔 진행 중 - 뷰어에서 제어하세요');
          break;

        case 'captureProgress':
          if (msg.data) {
            S.isScanning = true;
            var hasScanRange = msg.data.scanTotal > 0 && msg.data.scanTotal < msg.data.total;
            var dispCur = hasScanRange ? msg.data.scanCurrent : msg.data.current;
            var dispTot = hasScanRange ? msg.data.scanTotal : msg.data.total;
            var pct = dispTot > 0 ? Math.round(dispCur / dispTot * 100) : 0;
            $('scanFill').style.width = pct + '%';
            $('scanLiveText').textContent = dispCur + '/' + dispTot + ' (' + pct + '%)' +
              (msg.data.message ? ' - ' + msg.data.message : '');
            S.setScanUI('active', hasScanRange ? '재스캔 진행 중' : '스캔 진행 중');

            if (msg.data.page && msg.data.message && msg.data.message.indexOf('캡처 완료') !== -1) {
              S.markPageCaptured(msg.data.page);
            }
          }
          break;

        case 'autoRetrying':
          S.isScanning = true;
          S.setScanUI('recovering', '비정상 접근 감지 - 자동 복구 중...');
          $('scanLiveInfo').hidden = false;
          $('scanLiveText').textContent = '뷰어를 다시 여는 중... (자동 재시도)';
          S.showToast('비정상 접근 감지 - 자동 복구 시도 중');
          break;

        case 'captureComplete':
          S.isScanning = false;
          S.clearInspection();
          S.refreshBookData().then(function () {
            if (msg.data && msg.data.missingPages && msg.data.missingPages.length > 0) {
              S.markPagesFailed(msg.data.missingPages);
            }
          });
          if (msg.data && msg.data.missing > 0) {
            S.showToast('스캔 완료 - ' + msg.data.missing + '개 페이지 누락');
          } else {
            S.showToast('스캔 완료!');
          }
          break;

        case 'passiveCapture':
          if (msg.data && msg.data.page && msg.data.bookId === S.selectedBookId) {
            S.markPageCaptured(msg.data.page);
            S.loadBooks().then(function () { S.renderBookList(); });
          }
          break;

        case 'captureStopped':
          S.isScanning = false;
          S.refreshBookData();
          break;

        case 'captureError':
          S.isScanning = false;
          S.refreshBookData();
          if (msg.data) {
            S.setScanUI('error', '스캔 실패: ' + (msg.data.message || ''));
            S.showToast('스캔 오류: ' + (msg.data.message || ''));
          }
          break;
      }
    });
  }

  // ── Event Listeners ──
  function setupEventListeners() {
    $('deleteBookBtn').addEventListener('click', S.deleteBook);
    $('dlPdf').addEventListener('click', S.downloadPDF);
    $('exportBtn').addEventListener('click', S.exportSession);
    $('reinspectBtn').addEventListener('click', function () {
      S.forceFullInspection();
    });
    $('tocRescanBtn').addEventListener('click', S.tocRescan);
    $('tocEditBtn').addEventListener('click', S.openTocEditor);
    $('tocEditClose').addEventListener('click', S.closeTocEditor);
    $('tocEditBackdrop').addEventListener('click', S.closeTocEditor);
    $('tocEditSave').addEventListener('click', S.saveTocEdit);
    $('tocAddBtn').addEventListener('click', S.addTocItem);
    $('openReaderBtn').addEventListener('click', function () {
      if (!S.selectedBookId) return;
      chrome.runtime.sendMessage({
        target: 'background', action: 'openReader', bookId: S.selectedBookId
      }, function () { void chrome.runtime.lastError; });
    });

    setupCollapsible('infoPanelsToggle', 'infoPanelsIcon', 'infoPanelsBody');
    setupCollapsible('gridToggle', 'gridIcon', 'pageGrid');

    $('rescanAllBtn').addEventListener('click', function () {
      var totalPages = (S.selectedBook && S.selectedBook.totalPages) || 0;
      if (totalPages === 0) return;
      var capturedSet = {};
      S.capturedPageNums.forEach(function (n) { capturedSet[n] = true; });
      var first = 0, last = 0;
      for (var p = 1; p <= totalPages; p++) {
        if (!capturedSet[p]) { if (!first) first = p; last = p; }
      }
      if (first === 0) { S.showToast('누락 페이지 없음'); return; }
      S.rescanRange(first, last);
    });

    $('gridFilters').querySelectorAll('.grid-filter').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $('gridFilters').querySelectorAll('.grid-filter').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        var filter = this.dataset.filter;
        var grid = $('pageGrid');
        var isSelect = grid.classList.contains('select-mode');
        grid.className = 'page-grid' + (filter !== 'all' ? ' filter-' + filter : '') + (isSelect ? ' select-mode' : '');
        S.updateBatchBtn();
      });
    });

    $('selectAllBtn').addEventListener('click', function () {
      $('pageGrid').querySelectorAll('.page-tile').forEach(function (tile) {
        if (tile.offsetWidth === 0) return;
        var cb = tile.querySelector('.tile-check');
        if (cb) { cb.checked = true; tile.classList.add('selected'); }
      });
      S.updateBatchBtn();
    });
    $('deselectAllBtn').addEventListener('click', function () {
      $('pageGrid').querySelectorAll('.tile-check:checked').forEach(function (cb) {
        cb.checked = false;
        cb.parentElement.classList.remove('selected');
      });
      S.updateBatchBtn();
    });

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
          S.confirmedPages[pn] = true;
          count++;
        }
        cb.checked = false;
        tile.classList.remove('selected');
      });
      S.saveConfirmedPages();
      S.updateBatchBtn();
      S.showToast(count + '개 페이지 정상 확인');
    });

    $('batchDeleteBtn').addEventListener('click', function () {
      var checked = $('pageGrid').querySelectorAll('.tile-check:checked');
      var pages = [];
      checked.forEach(function (cb) { pages.push(parseInt(cb.dataset.page, 10)); });
      if (pages.length === 0) return;
      if (!confirm(pages.length + '개 페이지를 삭제하시겠습니까?')) return;
      S.batchDeletePages(pages);
    });

    $('pageGrid').addEventListener('change', function (e) {
      if (e.target.classList.contains('tile-check')) {
        e.target.parentElement.classList.toggle('selected', e.target.checked);
        S.updateBatchBtn();
      }
    });

    $('importBtn').addEventListener('click', function () {
      $('importFile').click();
    });
    $('importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) {
        S.importSession(this.files[0]);
        this.value = '';
      }
    });

    $('modalClose').addEventListener('click', S.closePreview);
    $('modalBackdrop').addEventListener('click', S.closePreview);
    $('prevPage').addEventListener('click', function () { S.navigatePreview(-1); });
    $('nextPage').addEventListener('click', function () { S.navigatePreview(1); });
    $('copyPageBtn').addEventListener('click', function () {
      var img = $('previewImg');
      if (!img || !img.src) return;
      fetch(img.src).then(function (r) { return r.blob(); }).then(function (blob) {
        return navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      }).then(function () {
        S.showToast('클립보드에 복사됨');
      }).catch(function () {
        S.showToast('복사 실패');
      });
    });
    $('dlPageBtn').addEventListener('click', function () {
      var img = $('previewImg');
      if (!img || !img.src) return;
      var a = document.createElement('a');
      a.href = img.src;
      var title = (S.selectedBook && S.selectedBook.title) || 'page';
      a.download = title.replace(/[^a-zA-Z0-9가-힣]/g, '_') + '_p' + S.previewPageNum + '.png';
      a.click();
    });
    $('deletePageBtn').addEventListener('click', function () {
      if (S.previewPageNum > 0) S.deletePage(S.previewPageNum);
    });
    $('markNormalBtn').addEventListener('click', function () {
      S.setPageStatus(S.previewPageNum, 'captured');
      S.updatePreviewButtons();
    });

    $('errorCloseBtn').addEventListener('click', S.hideError);
    $('errorBackdrop').addEventListener('click', S.hideError);
    $('errorCopyBtn').addEventListener('click', function () {
      navigator.clipboard.writeText(getErrorText()).then(function () {
        $('errorCopyBtn').textContent = '복사됨!';
        setTimeout(function () { $('errorCopyBtn').textContent = '복사'; }, 1500);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (!$('errorDialog').hidden) {
        if (e.key === 'Escape') S.hideError();
        return;
      }
      if ($('previewModal').hidden) return;
      if (e.key === 'Escape') S.closePreview();
      if (e.key === 'ArrowLeft') S.navigatePreview(-1);
      if (e.key === 'ArrowRight') S.navigatePreview(1);
    });
  }

  // ── Init ──
  init().catch(function (e) {
    showGlobalError('초기화 실패', '세션 관리자를 시작할 수 없습니다.', e);
  });
})();
