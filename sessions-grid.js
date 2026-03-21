(function (S) {
  'use strict';

  S.renderPageGrid = function () {
    var grid = S.$('pageGrid');
    var totalPages = (S.selectedBook && S.selectedBook.totalPages) || 0;

    if (totalPages === 0) {
      grid.innerHTML = '';
      return;
    }

    var capturedSet = {};
    S.capturedPageNums.forEach(function (n) { capturedSet[n] = true; });

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
        S.openPreview(parseInt(this.dataset.page, 10));
      });
    });

    S.$('gridLabel').textContent = '페이지 맵 (' + S.capturedPageNums.length + '/' + totalPages + ')';
    S.updateFilterCounts();

    S.loadAllThumbnails();
  };

  S.updateFilterCounts = function () {
    var grid = S.$('pageGrid');
    if (!grid) return;
    var counts = {
      all: grid.querySelectorAll('.page-tile').length,
      captured: grid.querySelectorAll('.page-tile.captured').length,
      suspect: grid.querySelectorAll('.page-tile.suspect').length,
      missing: grid.querySelectorAll('.page-tile.missing').length,
      failed: grid.querySelectorAll('.page-tile.failed').length
    };
    S.$('gridFilters').querySelectorAll('.grid-filter').forEach(function (btn) {
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
  };

  S.updateBatchBtn = function () {
    var checked = S.$('pageGrid').querySelectorAll('.tile-check:checked');
    var count = checked.length;
    if (count === 0) {
      S.$('batchConfirmBtn').hidden = true;
      S.$('batchDeleteBtn').hidden = true;
      return;
    }

    var hasCaptured = false, hasSuspect = false;
    checked.forEach(function (cb) {
      var tile = cb.parentElement;
      if (tile.classList.contains('suspect') || tile.classList.contains('failed')) hasSuspect = true;
      if (tile.classList.contains('captured')) hasCaptured = true;
    });

    S.$('batchConfirmBtn').hidden = !hasSuspect;
    S.$('batchDeleteBtn').hidden = !(hasCaptured || hasSuspect);
    S.$('batchConfirmBtn').textContent = count + '개 정상 확인';
    S.$('batchDeleteBtn').textContent = count + '개 삭제';
  };

  S.batchDeletePages = async function (pageNums) {
    for (var i = 0; i < pageNums.length; i++) {
      try { await extDeletePage(S.selectedBookId, pageNums[i]); } catch (e) {}
      delete S.thumbCache[pageNums[i]];
    }
    S.capturedPageNums = S.capturedPageNums.filter(function (n) { return pageNums.indexOf(n) === -1; });
    S.updateInspectionAfterDelete(pageNums);
    S.showToast(pageNums.length + '개 페이지 삭제됨');
    S.renderDetail();
    await S.loadBooks();
    S.renderBookList();
  };

})(window._S = window._S || {});
