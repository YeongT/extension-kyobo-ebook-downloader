(function () {
  'use strict';

  var $ = function (s) { return document.getElementById(s); };
  var currentTab = null;
  var pageType = 'other';

  function showView(id) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    document.querySelector(id).classList.add('active');
  }

  $('openSettings').addEventListener('click', function () { showView('#viewSettings'); });
  $('backBtn').addEventListener('click', function () { showView('#viewMain'); });
  $('openSessions').addEventListener('click', function () {
    chrome.runtime.sendMessage({ target: 'background', action: 'openSessions' }, function () { void chrome.runtime.lastError; });
  });
  $('openReader').addEventListener('click', function () {
    chrome.runtime.sendMessage({
      target: 'background', action: 'openReader'
    }, function () { void chrome.runtime.lastError; });
  });

  // ── Init ──
  async function init() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tabs[0];
      if (!currentTab || !currentTab.url) { renderOtherPage(); return; }

      var url = currentTab.url;
      if (url.indexOf('dkyobobook.co.kr') !== -1) {
        pageType = 'library';
        renderLibraryPage();
      } else if (url.indexOf('wviewer.kyobobook.co.kr') !== -1) {
        pageType = 'viewer';
        renderViewerPage();
      } else {
        renderOtherPage();
      }
    } catch (e) {
      renderOtherPage();
    }
  }

  // ── Library Page ──
  async function renderLibraryPage() {
    var content = $('contentArea');
    content.innerHTML = '<div class="status-banner info"><span class="dot green"></span>도서관 페이지 감지됨</div>';

    try {
      var resp = await sendToTab(currentTab.id, { action: 'getBookList' });
      if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
        content.innerHTML += '<div class="empty">대출 도서를 찾을 수 없습니다.<br>대출 목록 페이지로 이동하세요.</div>';
        await renderCachedBooks(content);
        return;
      }

      var books = resp.data;
      var cachedBooks = [];
      try { cachedBooks = await extGetAllBooks(); } catch (e) {}

      var listHtml = '';
      for (var i = 0; i < books.length; i++) {
        var book = books[i];
        var cached = findCachedBook(cachedBooks, book.title);
        listHtml += renderBookItem(book, cached);
      }

      content.innerHTML =
        '<div class="status-banner info"><span class="dot green"></span>대출 도서 ' + books.length + '권</div>' +
        '<div class="book-list">' + listHtml + '</div>';

      content.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', handleBookAction);
      });

      await renderCachedBooks(content);
    } catch (e) {
      content.innerHTML += '<div class="empty">도서 목록 로드 실패<br><small>' + esc(e.message) + '</small></div>';
      await renderCachedBooks(content);
    }
  }

  function renderBookItem(book, cached) {
    var coverHtml = book.coverUrl
      ? '<img class="book-cover" src="' + escAttr(book.coverUrl) + '" alt="">'
      : '<div class="book-cover-placeholder">&#128218;</div>';

    var badgesHtml = '';
    if (cached && cached.cachedCount > 0) {
      var cpct = (cached.totalPages > 0) ? Math.round(cached.cachedCount / cached.totalPages * 100) : 0;
      var isComplete = cached.totalPages > 0 && cached.cachedCount >= cached.totalPages;
      if (isComplete) {
        badgesHtml += '<span class="badge badge-cache">스캔 완료</span>';
      } else {
        badgesHtml += '<span class="badge badge-cache">' + cpct + '% (' + cached.cachedCount + '/' + cached.totalPages + 'p)</span>';
      }
    }
    if (!book.hasWebViewer && book.hasDownViewer) {
      badgesHtml += '<span class="badge badge-noviewer">다운보기만</span>';
    } else if (!book.hasWebViewer && !book.hasDownViewer) {
      badgesHtml += '<span class="badge badge-noviewer">뷰어 없음</span>';
    }

    var actionsHtml = '';
    if (book.hasWebViewer) {
      actionsHtml += '<button class="btn btn-primary" data-action="openSession" data-title="' + escAttr(book.title) + '">세션 관리</button>';
    }

    var authorHtml = book.author
      ? '<div class="book-author">' + esc(book.author) + '</div>'
      : '';
    var dueHtml = book.dueDate
      ? '<div class="book-due">반납 ' + esc(book.dueDate) + '</div>'
      : '';

    return '<div class="book-item">' +
      coverHtml +
      '<div class="book-info">' +
        '<div class="book-name" title="' + escAttr(book.title) + '">' + esc(book.title) + '</div>' +
        '<div class="book-detail">' + authorHtml + dueHtml + '</div>' +
        (badgesHtml ? '<div class="book-badges">' + badgesHtml + '</div>' : '') +
        (actionsHtml ? '<div class="book-actions">' + actionsHtml + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  function handleBookAction(e) {
    var btn = e.currentTarget;
    var action = btn.dataset.action;
    var title = btn.dataset.title;
    var bookId = btn.dataset.bookid;

    if (action === 'openSession') {
      chrome.runtime.sendMessage({ target: 'background', action: 'openSessions', title: title }, function () { void chrome.runtime.lastError; });
    } else if (action === 'openReader') {
      chrome.runtime.sendMessage({ target: 'background', action: 'openReader', bookId: bookId }, function () { void chrome.runtime.lastError; });
    } else if (action === 'openInSessions') {
      chrome.runtime.sendMessage({ target: 'background', action: 'openSessions', bookId: bookId }, function () { void chrome.runtime.lastError; });
    } else if (action === 'deleteCache') {
      if (bookId) {
        extDeleteBook(bookId).then(function () {
          init();
        }).catch(function () {});
      }
    }
  }

  // ── Viewer Page ──
  async function renderViewerPage() {
    var content = $('contentArea');

    try {
      var r = await sendToTab(currentTab.id, { action: 'ping' });
      if (!r || r.status !== 'ready') {
        content.innerHTML = '<div class="status-banner warning"><span class="dot orange"></span>새로고침 필요</div>';
        return;
      }

      var info = await sendToTab(currentTab.id, { action: 'getPageInfo' });
      var bookTitle = (info && info.success && info.data) ? info.data.title : 'eBook';
      var totalPages = (info && info.success && info.data) ? info.data.total : '?';

      if (r.isCapturing) {
        renderCapturing(content, bookTitle, totalPages);
      } else {
        renderViewerIdle(content, bookTitle, totalPages);
      }
    } catch (e) {
      content.innerHTML = '<div class="status-banner warning"><span class="dot red"></span>연결 실패</div>';
    }
  }

  function renderCapturing(content, title, total) {
    content.innerHTML =
      '<div class="card capture-card">' +
        '<div class="status-banner success" style="margin-bottom:12px"><span class="dot orange"></span>캡처 진행 중</div>' +
        '<div class="capture-title">' + esc(title) + '</div>' +
        '<div class="progress-bar"><div class="progress-fill" id="capFill"></div></div>' +
        '<div class="progress-text" id="capText">진행 중...</div>' +
        '<div class="capture-actions">' +
          '<button class="btn btn-secondary" data-action="openSession" data-title="' + escAttr(title) + '">세션 관리자</button>' +
        '</div>' +
      '</div>';

    content.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', handleBookAction);
    });

    sendToTab(currentTab.id, { action: 'getProgress' }).then(function (p) {
      if (p && p.capturedCount > 0) updateCapProgress(p.capturedCount, 0);
    });
  }

  function renderViewerIdle(content, title, total) {
    content.innerHTML =
      '<div class="card">' +
        '<div class="status-banner success" style="margin-bottom:12px"><span class="dot green"></span>뷰어 연결됨</div>' +
        '<div class="capture-title">' + esc(title) + '</div>' +
        '<div style="font-size:12px;color:#86868b;margin-bottom:12px">' + total + '페이지</div>' +
        '<div class="capture-actions">' +
          '<button class="btn btn-primary" data-action="openSession" data-title="' + escAttr(title) + '">세션 관리자</button>' +
        '</div>' +
      '</div>';

    content.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', handleBookAction);
    });
  }

  function updateCapProgress(current, total) {
    var fill = document.getElementById('capFill');
    var text = document.getElementById('capText');
    if (!fill || !text) return;
    var pct = total > 0 ? Math.round(current / total * 100) : 0;
    fill.style.width = pct + '%';
    text.textContent = current + (total > 0 ? '/' + total + ' (' + pct + '%)' : 'p 진행 중');
  }

  // ── Other Page ──
  async function renderOtherPage() {
    var content = $('contentArea');
    content.innerHTML = '<div class="status-banner neutral">' +
      '<span class="dot gray"></span>교보 ebook 페이지가 아닙니다</div>';
    await renderCachedBooks(content);
  }

  // ── Cached Books Section ──
  async function renderCachedBooks(container) {
    try {
      var books = await extGetAllBooks();
      if (!books || books.length === 0) return;

      books.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });

      var html = '<div class="section-title" style="margin-top:14px">캐시된 도서</div><div class="card">';
      for (var i = 0; i < books.length; i++) {
        var b = books[i];
        var bpct = (b.totalPages > 0 && b.cachedCount > 0) ? Math.round(b.cachedCount / b.totalPages * 100) : 0;
        var bComplete = b.totalPages > 0 && b.cachedCount >= b.totalPages;
        var statusText = bComplete ? '스캔 완료' : bpct + '% (' + (b.cachedCount || 0) + '/' + (b.totalPages || '?') + 'p)';

        html += '<div class="cache-item">' +
          '<div class="cache-item-info">' +
            '<div class="cache-item-title">' + esc(b.title || '(제목 없음)') + '</div>' +
            '<div class="cache-item-meta">' + statusText + ' &middot; ' + timeAgo(b.timestamp) + '</div>' +
          '</div>' +
          '<div class="cache-item-actions">' +
            (bComplete ? '<button class="cache-action" data-action="openReader" data-bookid="' + escAttr(b.bookId) + '">보기</button>' : '') +
            '<button class="cache-action" data-action="openInSessions" data-bookid="' + escAttr(b.bookId) + '">관리</button>' +
            '<button class="cache-action delete" data-action="deleteCache" data-bookid="' + escAttr(b.bookId) + '">삭제</button>' +
          '</div>' +
        '</div>';
      }
      html += '</div>';
      container.innerHTML += html;

      container.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', handleBookAction);
      });
    } catch (e) {}
  }

  // ── Messages from content ──
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.source !== 'KYOBO_CONTENT') return;
    if (pageType !== 'viewer') return;

    switch (msg.type) {
      case 'captureProgress':
        if (msg.data) updateCapProgress(msg.data.current, msg.data.total);
        break;
      case 'captureComplete':
      case 'captureStopped':
      case 'captureError':
        init();
        break;
      case 'captureStarted':
        renderViewerPage();
        break;
    }
  });

  // ── Settings ──
  function loadSettings() {
    chrome.storage.local.get({ autoRetry: true, pageDelayMin: 800, pageDelayMax: 1500, captureDelay: 500 }, function (d) {
      $('autoRetry').checked = d.autoRetry !== false;
      $('sPageDelayMin').value = d.pageDelayMin;
      $('sPageDelayMax').value = d.pageDelayMax;
      $('captureDelay').value = d.captureDelay;
    });
  }

  function saveSettings() {
    chrome.storage.local.set({
      autoRetry: $('autoRetry').checked,
      pageDelayMin: parseInt($('sPageDelayMin').value, 10) || 800,
      pageDelayMax: parseInt($('sPageDelayMax').value, 10) || 1500,
      captureDelay: parseInt($('captureDelay').value, 10) || 500
    });
  }

  ['sPageDelayMin', 'sPageDelayMax', 'captureDelay'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('change', saveSettings);
  });
  var arEl = $('autoRetry');
  if (arEl) arEl.addEventListener('change', saveSettings);

  // ── Helpers ──
  function sendToTab(tabId, msg) {
    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(tabId, msg, function (r) {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    });
  }

  function findCachedBook(cachedBooks, title) {
    if (!cachedBooks || !title) return null;
    for (var i = 0; i < cachedBooks.length; i++) {
      if (cachedBooks[i].title === title) return cachedBooks[i];
    }
    return null;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return '방금 전';
    if (d < 3600) return Math.floor(d / 60) + '분 전';
    if (d < 86400) return Math.floor(d / 3600) + '시간 전';
    return Math.floor(d / 86400) + '일 전';
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function escAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  loadSettings();
  init();
})();
