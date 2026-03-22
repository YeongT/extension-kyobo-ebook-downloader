(function (S) {
  'use strict';

  S.previewPageNum = 0;

  S.getActiveFilter = function () {
    var active = document.querySelector('.grid-filter.active');
    return active ? active.dataset.filter : 'all';
  };

  S.getFilteredPages = function () {
    var filter = S.getActiveFilter();
    if (filter === 'all') return S.capturedPageNums.slice();
    var grid = S.$('pageGrid');
    var result = [];
    grid.querySelectorAll('.page-tile.' + filter).forEach(function (tile) {
      result.push(parseInt(tile.dataset.page, 10));
    });
    return result.sort(function (a, b) { return a - b; });
  };

  S.openPreview = async function (pageNum) {
    if (!S.selectedBookId) return;

    S.previewPageNum = pageNum;
    S.$('previewModal').hidden = false;
    S.$('previewImg').src = '';
    S.$('modalTitle').textContent = pageNum + '페이지';
    S.$('modalInfo').textContent = '로딩 중...';
    S.updateNavButtons();
    S.updatePreviewButtons();

    try {
      var page = await extGetPage(S.selectedBookId, pageNum);
      if (page && page.dataURL) {
        S.$('previewImg').src = page.dataURL;
        S.$('modalInfo').textContent = pageNum + '페이지 · ' + (page.width || '?') + ' x ' + (page.height || '?') + 'px';
      } else {
        S.$('previewImg').src = '';
        S.$('modalInfo').textContent = '이미지 데이터 없음';
      }
    } catch (e) {
      S.$('modalInfo').textContent = '로딩 실패';
      S.showError('페이지 로딩 실패', S.previewPageNum + '페이지를 불러올 수 없습니다.', S.formatErrorDetail(e));
    }
  };

  S.closePreview = function () {
    S.$('previewModal').hidden = true;
    S.$('previewImg').src = '';
  };

  S.updateNavButtons = function () {
    var filtered = S.getFilteredPages();
    var idx = filtered.indexOf(S.previewPageNum);
    S.$('prevPage').disabled = (idx <= 0);
    S.$('nextPage').disabled = (idx < 0 || idx >= filtered.length - 1);
  };

  S.updatePreviewButtons = function () {
    var tile = S.$('pageGrid').querySelector('[data-page="' + S.previewPageNum + '"]');
    var isSuspect = tile && tile.classList.contains('suspect');
    var isFailed = tile && tile.classList.contains('failed');
    var needsAction = isSuspect || isFailed || (tile && !tile.classList.contains('captured'));
    S.$('markNormalBtn').disabled = !needsAction;
    S.$('markNormalBtn').textContent = needsAction ? '정상 확인' : '정상 확인됨';
  };

  S.navigatePreview = function (direction) {
    var filtered = S.getFilteredPages();
    var idx = filtered.indexOf(S.previewPageNum);
    if (idx < 0) {
      for (var i = 0; i < filtered.length; i++) {
        if (filtered[i] > S.previewPageNum) { idx = direction > 0 ? i : i - 1; break; }
      }
      if (idx < 0) idx = filtered.length - 1;
    } else {
      idx += direction;
    }
    if (idx >= 0 && idx < filtered.length) {
      S.openPreview(filtered[idx]);
    }
  };

  S.deletePage = async function (pageNum) {
    if (!S.selectedBookId || !pageNum) return;

    try {
      var filtered = S.getFilteredPages();
      var idx = filtered.indexOf(pageNum);
      var nextInFilter = null;
      if (idx >= 0 && idx + 1 < filtered.length) nextInFilter = filtered[idx + 1];
      else if (idx > 0) nextInFilter = filtered[idx - 1];

      await extDeletePage(S.selectedBookId, pageNum);
      S.capturedPageNums = S.capturedPageNums.filter(function (n) { return n !== pageNum; });
      delete S.thumbCache[pageNum];
      S.updateInspectionAfterDelete([pageNum]);

      var tile = S.$('pageGrid').querySelector('[data-page="' + pageNum + '"]');
      if (tile) {
        tile.className = 'page-tile missing';
        tile.dataset.loaded = 'false';
        var thumb = tile.querySelector('.tile-thumb');
        if (thumb) thumb.remove();
        tile.title = pageNum + '페이지 (누락)';
      }

      if (nextInFilter) {
        S.openPreview(nextInFilter);
      } else {
        S.closePreview();
      }

      var totalPages = (S.selectedBook && S.selectedBook.totalPages) || 0;
      if (totalPages > 0) {
        var pct = Math.round(S.capturedPageNums.length / totalPages * 100);
        S.$('detailFill').style.width = pct + '%';
        S.$('detailProgress').textContent = pct + '%';
        S.$('gridLabel').textContent = '페이지 맵 (' + S.capturedPageNums.length + '/' + totalPages + ')';
      }
      S.loadBooks().then(S.renderBookList);
    } catch (e) {
      S.showError('페이지 삭제 실패', pageNum + '페이지를 삭제하는 중 오류가 발생했습니다.', S.formatErrorDetail(e));
    }
  };

  S.deleteBook = async function () {
    if (!S.selectedBookId) return;
    var title = S.selectedBook ? S.selectedBook.title : S.selectedBookId;

    if (!confirm('"' + title + '" 도서의 모든 캐시 데이터를 삭제하시겠습니까?')) return;

    try {
      await extDeleteBook(S.selectedBookId);
      S.showToast('"' + title + '" 삭제됨');
      S.selectedBookId = null;
      S.selectedBook = null;
      S.$('bookDetail').hidden = true;
      S.$('emptyState').hidden = false;
      await S.loadBooks();
    } catch (e) {
      S.showError('도서 삭제 실패', '"' + title + '" 도서를 삭제하는 중 오류가 발생했습니다.', S.formatErrorDetail(e));
    }
  };

  S.setPageStatus = function (pageNum, status) {
    var grid = S.$('pageGrid');
    var tile = grid.querySelector('[data-page="' + pageNum + '"]');
    if (tile) {
      tile.classList.remove('captured', 'suspect', 'failed');
      tile.classList.add(status);
      tile.title = pageNum + '페이지';
    }
    if (status === 'captured') {
      S.confirmedPages[pageNum] = true;
      S.saveConfirmedPages();
      // Remove from suspect list and update inspection data
      if (S.inspectionData && S.inspectionData.suspectPages) {
        S.inspectionData.suspectPages = S.inspectionData.suspectPages.filter(function (p) { return p !== pageNum; });
        S.saveInspection(S.inspectionData.suspectPages, S.inspectionData.thumbs, S.inspectionData.pageSet);
      }
    }
    S.updateFilterCounts();
    S.refreshDetailHeader();
    S.renderMissingRanges();
    S.showToast(pageNum + 'p → 정상 확인');
  };

})(window._S = window._S || {});
