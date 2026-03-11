(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var currentTab = null;
  var isCapturing = false;

  function showView(id) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    $(id).classList.add('active');
  }

  $('#openSettings').addEventListener('click', function () { showView('#viewSettings'); });
  $('#backBtn').addEventListener('click', function () { showView('#viewMain'); });
  $('#openCache').addEventListener('click', function () { showView('#viewCache'); loadCacheBooks(); });
  $('#cacheBackBtn').addEventListener('click', function () { showView('#viewMain'); });

  // ── Init ──
  async function init() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tabs[0];
      if (!currentTab || !currentTab.url || currentTab.url.indexOf('wviewer.kyobobook.co.kr') === -1) {
        setStatus('inactive', '교보 ebook 뷰어가 아닙니다');
        return;
      }
      chrome.tabs.sendMessage(currentTab.id, { action: 'ping' }, function (r) {
        if (chrome.runtime.lastError) { setStatus('warning', '새로고침 필요'); return; }
        if (r && r.status === 'ready') {
          setStatus('active', '준비 완료');
          loadPageInfo();
          if (r.isCapturing) {
            showCapturingState();
            chrome.tabs.sendMessage(currentTab.id, { action: 'getProgress' }, function (p) {
              if (p && p.capturedCount > 0) updateMiniProgress(p.capturedCount, 0);
            });
          }
        }
      });
    } catch (e) { setStatus('inactive', '초기화 실패'); }
  }

  function setStatus(type, text) {
    $('#statusDot').className = 'dot ' + type;
    $('#statusText').textContent = text;
  }

  function loadPageInfo() {
    chrome.tabs.sendMessage(currentTab.id, { action: 'getPageInfo' }, function (r) {
      if (chrome.runtime.lastError || !r || !r.success) return;
      var d = r.data;
      $('#bookTitle').textContent = d.title || '(제목 없음)';
      $('#totalPages').textContent = (d.total || '?') + '페이지';
      $('#bookInfoCard').style.display = '';
      $('#actionCard').style.display = '';
    });
  }

  // ── Actions ──
  $('#btnCapture').addEventListener('click', function () {
    if (!currentTab) return;
    chrome.runtime.sendMessage({ target: 'background', action: 'openCaptureManager', tabId: currentTab.id }, function () { void chrome.runtime.lastError; });
  });

  $('#btnStop').addEventListener('click', function () {
    if (currentTab) chrome.tabs.sendMessage(currentTab.id, { action: 'stopCapture' }, function () { void chrome.runtime.lastError; });
  });

  $('#btnOpenManager').addEventListener('click', function () {
    if (!currentTab) return;
    chrome.runtime.sendMessage({ target: 'background', action: 'openCaptureManager', tabId: currentTab.id }, function () { void chrome.runtime.lastError; });
  });

  function showCapturingState() {
    isCapturing = true;
    $('#actionCard').style.display = '';
    $('#btnCapture').style.display = 'none';
    $('#captureControls').style.display = '';
    setStatus('active', '캡처 진행 중');
  }

  function showIdleState() {
    isCapturing = false;
    $('#btnCapture').style.display = '';
    $('#captureControls').style.display = 'none';
  }

  function updateMiniProgress(current, total) {
    var pct = total > 0 ? Math.round(current / total * 100) : 0;
    $('#miniProgressText').textContent = current + (total > 0 ? '/' + total + ' (' + pct + '%)' : 'p 진행 중');
    if (total > 0) $('#miniProgressFill').style.width = pct + '%';
  }

  // ── Messages from content ──
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.source !== 'KYOBO_CONTENT') return;
    switch (msg.type) {
      case 'captureProgress': showCapturingState(); if (msg.data) updateMiniProgress(msg.data.current, msg.data.total); break;
      case 'captureComplete': setStatus('active', '완료!'); showIdleState(); break;
      case 'captureStopped': setStatus('active', '중지됨'); showIdleState(); break;
      case 'captureError': setStatus('warning', '오류'); showIdleState(); break;
      case 'captureStarted': showCapturingState(); break;
    }
  });

  // ── Cache viewer ──
  function loadCacheBooks() {
    var list = $('#cacheBookList');
    list.innerHTML = '<div class="cache-empty">불러오는 중...</div>';
    extGetAllBooks().then(function (books) {
      if (!books || books.length === 0) { list.innerHTML = '<div class="cache-empty">캐시된 도서가 없습니다.</div>'; return; }
      books.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
      list.innerHTML = books.map(function (book) {
        return '<div class="cache-book-card" data-bookid="' + escAttr(book.bookId) + '">' +
          '<div class="cache-book-title">' + esc(book.title || '(제목 없음)') + '</div>' +
          '<div class="cache-book-meta">' + (book.cachedCount || 0) + '페이지 &middot; ' + timeAgo(book.timestamp) + '</div>' +
          '<div class="cache-book-actions">' +
            '<button class="cache-action-btn reader" data-action="reader">리더</button>' +
            '<button class="cache-action-btn delete" data-action="delete">삭제</button>' +
          '</div></div>';
      }).join('');
      list.querySelectorAll('.cache-action-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var card = this.closest('.cache-book-card');
          var bId = card.dataset.bookid;
          if (this.dataset.action === 'reader') {
            chrome.runtime.sendMessage({ target: 'background', action: 'openReader', bookId: bId }, function () { void chrome.runtime.lastError; });
          } else if (this.dataset.action === 'delete') {
            extDeleteBook(bId).then(function () {
              card.remove();
              if (!$('#cacheBookList .cache-book-card')) $('#cacheBookList').innerHTML = '<div class="cache-empty">캐시된 도서가 없습니다.</div>';
            }).catch(function () {});
          }
        });
      });
    }).catch(function () { list.innerHTML = '<div class="cache-empty">로드 실패</div>'; });
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return '방금 전';
    if (d < 3600) return Math.floor(d / 60) + '분 전';
    if (d < 86400) return Math.floor(d / 3600) + '시간 전';
    return Math.floor(d / 86400) + '일 전';
  }

  // ── Settings ──
  function loadSettings() {
    chrome.storage.local.get({ autoRetry: true, pageDelayMin: 800, pageDelayMax: 1500, captureDelay: 500 }, function (d) {
      $('#autoRetry').checked = d.autoRetry !== false;
      $('#sPageDelayMin').value = d.pageDelayMin;
      $('#sPageDelayMax').value = d.pageDelayMax;
      $('#captureDelay').value = d.captureDelay;
    });
  }

  function saveSettings() {
    chrome.storage.local.set({
      autoRetry: $('#autoRetry').checked,
      pageDelayMin: parseInt($('#sPageDelayMin').value, 10) || 800,
      pageDelayMax: parseInt($('#sPageDelayMax').value, 10) || 1500,
      captureDelay: parseInt($('#captureDelay').value, 10) || 500
    });
  }

  ['sPageDelayMin', 'sPageDelayMax', 'captureDelay'].forEach(function (id) {
    var el = $('#' + id);
    if (el) el.addEventListener('change', saveSettings);
  });
  var arEl = document.querySelector('#autoRetry');
  if (arEl) arEl.addEventListener('change', saveSettings);

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  loadSettings();
  init();
})();
