(function (S) {
  'use strict';

  S.viewerTabId = null;
  S.isScanning = false;
  S.scanPollInterval = null;
  var lastPageGridUpdate = 0;

  S.startLivePolling = function () {
    if (S.scanPollInterval) return;
    S.updateViewerStatus();
    S.scanPollInterval = setInterval(function () {
      S.updateViewerStatus();
      S.refreshPageDataIfNeeded();
    }, 2000);
  };

  S.updateViewerStatus = function () {
    chrome.tabs.query({ url: 'https://wviewer.kyobobook.co.kr/*' }, function (tabs) {
      var hasViewer = tabs && tabs.length > 0;
      var prevTabId = S.viewerTabId;
      S.viewerTabId = hasViewer ? tabs[0].id : null;

      S.$('switchToViewerBtn').hidden = !S.viewerTabId;
      S.$('openViewerBtn').hidden = !!S.viewerTabId;

      if (!hasViewer) {
        if (S.isScanning) {
          S.isScanning = false;
          S.refreshBookData();
        }
        S.setScanUI('disconnected', '뷰어 연결 안 됨');
        return;
      }

      if (!prevTabId && S.viewerTabId) {
        S.syncViewerBook(tabs[0].id);
      }

      chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' }, function (r) {
        if (chrome.runtime.lastError || !r) {
          S.setScanUI('disconnected', '뷰어 응답 없음');
          return;
        }
        var wasScanning = S.isScanning;
        S.isScanning = !!r.isCapturing;

        if (S.isScanning) {
          S.setScanUI('active', '스캔 진행 중 - 뷰어에서 제어하세요');
        } else if (wasScanning) {
          S.setScanUI('connected', '뷰어 연결됨');
          S.refreshBookData();
        } else {
          S.setScanUI('connected', '뷰어 연결됨');
        }
      });
    });
  };

  S.syncViewerBook = function (tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'getPageInfo' }, function (r) {
      if (chrome.runtime.lastError || !r || !r.success || !r.data) return;
      var title = r.data.title;
      var total = r.data.total;
      if (!title) return;

      var bookId = 'title:' + title;

      chrome.tabs.sendMessage(tabId, { action: 'getTOC' }, function (tocR) {
        void chrome.runtime.lastError;
        var liveToc = (tocR && tocR.success && tocR.data) ? tocR.data : [];

        S.loadBooks().then(function () {
          var found = null;
          for (var i = 0; i < S.books.length; i++) {
            if (S.books[i].title === title) { found = S.books[i]; break; }
          }

          if (found) {
            if (liveToc.length > 0 && (!found.toc || found.toc.length === 0 || liveToc.length > found.toc.length)) {
              found.toc = liveToc;
              extStoreBookMeta(found.bookId, found.title, found.totalPages, liveToc).catch(function () {});
            }
            S.selectBook(found.bookId);
          } else {
            S.selectedBookId = bookId;
            S.selectedBook = { bookId: bookId, title: title, totalPages: total || 0, toc: liveToc, cachedCount: 0 };
            S.capturedPageNums = [];
            if (liveToc.length > 0) {
              extStoreBookMeta(bookId, title, total || 0, liveToc).catch(function () {});
            }
            S.$('emptyState').hidden = true;
            S.$('bookDetail').hidden = false;
            S.renderBookList();
            S.renderDetail();
          }
        });
      });
    });
  };

  S.setScanUI = function (state, statusText) {
    var dot = S.$('scanDot');
    var text = S.$('scanStatusText');
    var isConnected = state === 'connected' || state === 'active' || state === 'recovering';

    if (state === 'recovering' || state === 'active') {
      dot.className = 'scan-dot active';
      text.textContent = statusText;
      S.$('scanCard').hidden = false;
    } else if (state === 'connected') {
      dot.className = 'scan-dot complete';
      text.textContent = statusText;
      S.$('scanCard').hidden = true;
    } else {
      dot.className = 'scan-dot idle';
      text.textContent = statusText;
      S.$('scanCard').hidden = true;
    }

    S.$('rescanAllBtn').disabled = !isConnected;
    var rescanBtns = document.querySelectorAll('.range-rescan');
    rescanBtns.forEach(function (btn) { btn.disabled = !isConnected; });
  };

  S.markPageCaptured = function (pageNum) {
    if (S.capturedPageNums.indexOf(pageNum) !== -1) return;
    S.capturedPageNums.push(pageNum);
    S.capturedPageNums.sort(function (a, b) { return a - b; });

    var grid = S.$('pageGrid');
    var tile = grid.querySelector('[data-page="' + pageNum + '"]');
    if (tile) {
      tile.className = 'page-tile captured';
      tile.dataset.loaded = 'false';
      tile.title = pageNum + '페이지';
      tile.addEventListener('click', function (e) {
        if (e.target.classList.contains('tile-check')) return;
        S.openPreview(parseInt(this.dataset.page, 10));
      });
    }

    var totalPages = (S.selectedBook && S.selectedBook.totalPages) || 0;
    if (totalPages > 0) {
      var pct = Math.round(S.capturedPageNums.length / totalPages * 100);
      S.$('detailFill').style.width = pct + '%';
      S.$('detailProgress').textContent = pct + '%';
      S.$('gridLabel').textContent = '페이지 맵 (' + S.capturedPageNums.length + '/' + totalPages + ')';
    }
  };

  S.markPagesFailed = function (failedPages) {
    var grid = S.$('pageGrid');
    if (!grid) return;
    for (var i = 0; i < failedPages.length; i++) {
      var tile = grid.querySelector('[data-page="' + failedPages[i] + '"]');
      if (tile) {
        tile.className = 'page-tile failed';
        tile.title = failedPages[i] + '페이지 (캡처 실패)';
      }
    }
  };

  S.rescanRange = function (startPage, endPage) {
    if (!S.viewerTabId) {
      S.showToast('뷰어가 연결되어야 재스캔 가능합니다');
      return;
    }
    chrome.storage.local.get({
      pageDelayMin: 800, pageDelayMax: 1500
    }, function (settings) {
      chrome.tabs.sendMessage(S.viewerTabId, {
        action: 'startCapture',
        options: {
          startPage: startPage, endPage: endPage,
          mode: 'normal', autoRetry: false, captureDelay: 500,
          pageDelayMin: settings.pageDelayMin, pageDelayMax: settings.pageDelayMax,
          resume: true
        }
      }, function (r) {
        void chrome.runtime.lastError;
        if (r && r.success) {
          S.showToast(startPage + '-' + endPage + 'p 재스캔 시작');
          chrome.tabs.update(S.viewerTabId, { active: true });
        } else {
          S.showToast('재스캔 시작 실패');
        }
      });
    });
  };

  S.switchToViewer = function () {
    if (S.viewerTabId) {
      chrome.tabs.update(S.viewerTabId, { active: true });
    }
  };

  S.openViewer = function () {
    if (!S.selectedBook || !S.selectedBook.title) {
      S.showToast('도서관 페이지에서 바로보기로 뷰어를 열어주세요');
      return;
    }
    chrome.runtime.sendMessage({
      target: 'background', action: 'startCaptureForBook',
      bookTitle: S.selectedBook.title, resume: false
    }, function () { void chrome.runtime.lastError; });
    S.showToast('뷰어 여는 중...');
  };

  S.refreshBookData = async function () {
    if (!S.selectedBookId) return;
    try {
      S.selectedBook = await extGetBookMeta(S.selectedBookId);
      var pagesInfo = await extGetPagesInfo(S.selectedBookId);
      S.capturedPageNums = pagesInfo.map(function (p) { return p.pageNum; }).sort(function (a, b) { return a - b; });
    } catch (e) {}
    if (!S.selectedBook) S.selectedBook = S.findBookInList(S.selectedBookId);
    S.renderDetail();
    await S.loadBooks();
    S.renderBookList();
  };

  S.refreshPageDataIfNeeded = function () {
    if (!S.selectedBookId) return;
    var now = Date.now();
    if (now - lastPageGridUpdate < 5000) return;
    lastPageGridUpdate = now;

    extGetPagesInfo(S.selectedBookId).then(function (pagesInfo) {
      var newNums = pagesInfo.map(function (p) { return p.pageNum; }).sort(function (a, b) { return a - b; });
      if (newNums.length !== S.capturedPageNums.length) {
        S.capturedPageNums = newNums;
        S.renderDetail();
        S.loadBooks().then(S.renderBookList);
      }
    }).catch(function () {});
  };

})(window._S = window._S || {});
