(function (S) {
  'use strict';

  var editingToc = [];

  S.openTocEditor = function () {
    editingToc = JSON.parse(JSON.stringify((S.selectedBook && S.selectedBook.toc) || []));
    renderTocEditorInternal();
    S.$('tocEditOverlay').hidden = false;
    S.$('tocEditStatus').textContent = editingToc.length + '개 항목';
  };

  S.closeTocEditor = function () {
    S.$('tocEditOverlay').hidden = true;
  };

  function renderTocEditorInternal() {
    var list = S.$('tocEditList');
    var html = '';

    for (var i = 0; i < editingToc.length; i++) {
      var item = editingToc[i];
      var depth = item.depth || 1;
      var isFirst = (i === 0);
      var prevDepth = isFirst ? 0 : (editingToc[i - 1].depth || 1);
      var maxDepth = Math.min(prevDepth + 1, 5);
      var canOutdent = depth > 1;
      var canIndent = depth < maxDepth;

      var treeHtml = '';
      for (var d = 1; d < depth; d++) {
        if (d === depth - 1) {
          var isLastAtDepth = true;
          for (var k = i + 1; k < editingToc.length; k++) {
            var kd = editingToc[k].depth || 1;
            if (kd < depth) break;
            if (kd === depth) { isLastAtDepth = false; break; }
          }
          treeHtml += '<span class="tree-char">' + (isLastAtDepth ? '└─' : '├─') + '</span>';
        } else {
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
    S.$('tocEditStatus').textContent = editingToc.length + '개 항목';

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
        renderTocEditorInternal();
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

  S.renderTocEditor = renderTocEditorInternal;

  S.addTocItem = function () {
    editingToc.push({ page: 0, title: '', depth: 1 });
    renderTocEditorInternal();
    var inputs = S.$('tocEditList').querySelectorAll('.toc-edit-title');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  };

  S.saveTocEdit = function () {
    var cleaned = editingToc.filter(function (item) { return item.title && item.page > 0; });
    if (S.selectedBook) {
      S.selectedBook.toc = cleaned;
      extStoreBookMeta(S.selectedBookId, S.selectedBook.title, S.selectedBook.totalPages, cleaned).then(function () {
        S.renderTOC();
        S.closeTocEditor();
        S.showToast('목차 저장 완료 (' + cleaned.length + '항목)');
      });
    }
  };

  S.tocRescan = function () {
    if (S.viewerTabId) {
      S.doTocFetch(S.viewerTabId);
    } else if (S.selectedBook && S.selectedBook.title) {
      S.showToast('뷰어 여는 중...');
      chrome.runtime.sendMessage({
        target: 'background', action: 'startCaptureForBook',
        bookTitle: S.selectedBook.title, resume: false
      }, function () { void chrome.runtime.lastError; });
      var checkCount = 0;
      var waitForViewer = setInterval(function () {
        checkCount++;
        if (checkCount > 30) { clearInterval(waitForViewer); S.showToast('뷰어 열기 시간 초과'); return; }
        chrome.tabs.query({ url: 'https://wviewer.kyobobook.co.kr/*' }, function (tabs) {
          if (!tabs || tabs.length === 0) return;
          clearInterval(waitForViewer);
          S.viewerTabId = tabs[0].id;
          setTimeout(function () { S.doTocFetch(S.viewerTabId); }, 5000);
        });
      }, 1000);
    } else {
      S.showToast('도서 정보가 없습니다');
    }
  };

  S.doTocFetch = function (tabId) {
    S.showToast('목차 스캔 중...');
    chrome.tabs.sendMessage(tabId, { action: 'getTOC' }, function (r) {
      if (chrome.runtime.lastError || !r || !r.success) {
        S.showToast('목차 재스캔 실패 — 뷰어가 아직 로딩 중일 수 있습니다');
        return;
      }
      var newToc = r.data || [];
      if (newToc.length === 0) {
        S.showToast('뷰어에서 목차를 찾을 수 없습니다');
        return;
      }
      if (S.selectedBook) {
        S.selectedBook.toc = newToc;
        extStoreBookMeta(S.selectedBookId, S.selectedBook.title, S.selectedBook.totalPages, newToc).then(function () {
          S.renderTOC();
          S.showToast('목차 재스캔 완료 (' + newToc.length + '항목)');
        });
      }
    });
  };

})(window._S = window._S || {});
