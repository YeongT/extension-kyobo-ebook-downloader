(function () {
  'use strict';

  var bookId = new URLSearchParams(location.search).get('book') || '';
  var pages = [];
  var currentPageIdx = 0;
  var zoom = 100;
  var fitMode = 'width';
  var tocVisible = true;
  var toc = [];
  var bookTitle = '';
  var pageCache = new Map();

  var $ = function (id) { return document.getElementById(id); };

  var SIZE_PRESETS = { original: null, a4: { w: 210, h: 297 }, b5: { w: 182, h: 257 }, a5: { w: 148, h: 210 } };

  function calcPageDims(pxW, pxH, target) {
    var mmW = (pxW / 96) * 25.4, mmH = (pxH / 96) * 25.4;
    if (!target) return { pageW: mmW, pageH: mmH, imgW: mmW, imgH: mmH, x: 0, y: 0 };
    var tw = target.w, th = target.h;
    if (pxW > pxH) { tw = Math.max(target.w, target.h); th = Math.min(target.w, target.h); }
    else { tw = Math.min(target.w, target.h); th = Math.max(target.w, target.h); }
    var scale = Math.min(tw / mmW, th / mmH);
    var sw = mmW * scale, sh = mmH * scale;
    return { pageW: tw, pageH: th, imgW: sw, imgH: sh, x: (tw - sw) / 2, y: (th - sh) / 2 };
  }

  // ── Book selector ──
  async function showBookSelector() {
    try {
      var books = await extGetAllBooks();
      if (!books || books.length === 0) {
        showStatus('캐시된 도서가 없습니다.\n\n세션 관리자에서 도서를 스캔해주세요.');
        return;
      }
      books.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });

      var html = '<div style="max-width:520px;margin:0 auto;padding:32px 24px">' +
        '<h2 style="font-size:20px;font-weight:700;margin-bottom:20px;color:#1d1d1f;text-align:center">도서 선택</h2>';
      for (var i = 0; i < books.length; i++) {
        var b = books[i];
        var pct = (b.totalPages > 0 && b.cachedCount > 0) ? Math.round(b.cachedCount / b.totalPages * 100) : 0;
        var isComplete = b.totalPages > 0 && b.cachedCount >= b.totalPages;
        var statusText = isComplete ? '스캔 완료' : pct + '% (' + (b.cachedCount || 0) + '/' + (b.totalPages || '?') + 'p)';
        var statusColor = isComplete ? '#16a34a' : '#aeaeb2';

        // Try to get first page as cover thumbnail
        var coverStyle = 'width:64px;height:88px;border-radius:8px;background:linear-gradient(135deg,#f0f0f0,#e5e5e5);' +
          'display:flex;align-items:center;justify-content:center;color:#c7c7cc;font-size:24px;flex-shrink:0;' +
          'box-shadow:0 2px 8px rgba(0,0,0,.08);overflow:hidden';

        html += '<div class="book-select-item" data-bookid="' + (b.bookId || '').replace(/"/g, '&quot;') + '" style="' +
          'display:flex;align-items:center;gap:16px;padding:16px 18px;border-radius:14px;cursor:pointer;' +
          'border:1px solid #e8e8ed;margin-bottom:10px;transition:all .15s;background:#fff">' +
          '<div style="' + coverStyle + '" data-cover="' + (b.bookId || '').replace(/"/g, '&quot;') + '">&#128218;</div>' +
          '<div style="min-width:0;flex:1">' +
            '<div style="font-size:15px;font-weight:650;color:#1d1d1f;line-height:1.4;margin-bottom:4px;' +
              'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' +
              (b.title || '(제목 없음)').replace(/</g, '&lt;') + '</div>' +
            '<div style="font-size:12px;color:' + statusColor + ';font-weight:600">' + statusText + '</div>' +
          '</div>' +
          '<div style="font-size:12px;color:#e94560;font-weight:700;flex-shrink:0;padding:6px 12px;' +
            'background:#fef2f4;border-radius:8px">열기</div>' +
        '</div>';
      }
      html += '</div>';

      // Load cover thumbnails from first cached page
      setTimeout(function () {
        var coverEls = $('pageStatus').querySelectorAll('[data-cover]');
        coverEls.forEach(function (el) {
          var bid = el.dataset.cover;
          if (!bid) return;
          extGetPagesInfo(bid).then(function (pgs) {
            if (!pgs || pgs.length === 0) return;
            return extGetPage(bid, pgs[0].pageNum);
          }).then(function (pg) {
            if (pg && pg.dataURL) {
              el.innerHTML = '<img src="' + pg.dataURL + '" style="width:100%;height:100%;object-fit:cover">';
            }
          }).catch(function () {});
        });
      }, 100);

      $('pageStatus').innerHTML = html;
      $('pageStatus').style.display = '';

      $('pageStatus').querySelectorAll('.book-select-item').forEach(function (el) {
        el.addEventListener('mouseenter', function () { this.style.borderColor = '#e94560'; this.style.background = '#fef2f4'; });
        el.addEventListener('mouseleave', function () { this.style.borderColor = '#e8e8ed'; this.style.background = '#fff'; });
        el.addEventListener('click', function () {
          var id = this.dataset.bookid;
          if (id) {
            bookId = id;
            history.replaceState(null, '', '?book=' + encodeURIComponent(id));
            init();
          }
        });
      });
    } catch (e) {
      showStatus('도서 목록 로드 실패: ' + e.message);
    }
  }

  // ── Init ──
  async function init() {
    if (!bookId) { showBookSelector(); return; }

    showStatus('도서 정보 불러오는 중...');
    try {
      var meta = await extGetBookMeta(bookId);
      if (meta) {
        bookTitle = meta.title || '';
        toc = meta.toc || [];
        $('readerTitle').textContent = bookTitle || 'eBook Reader';
        document.title = (bookTitle || 'eBook') + ' - Reader';
        renderTOC();
      }

      var pagesInfo = await extGetPagesInfo(bookId);
      if (!pagesInfo || pagesInfo.length === 0) {
        showStatus('캐시된 페이지가 없습니다.\n\n캡처 후 이 페이지를 다시 열어주세요.');
        return;
      }

      pages = pagesInfo;
      $('totalPages').textContent = pages.length;
      $('currentPage').max = pages.length;
      await loadPage(0);
    } catch (e) {
      showStatus('로드 실패: ' + e.message);
    }
  }

  function showStatus(msg) {
    $('pageStatus').textContent = msg;
    $('pageStatus').style.display = '';
    $('pageImg').classList.remove('loaded');
  }

  function hideStatus() { $('pageStatus').style.display = 'none'; }

  // ── Page loading ──
  async function loadPage(idx) {
    if (idx < 0 || idx >= pages.length) return;
    currentPageIdx = idx;
    var pageNum = pages[idx].pageNum;
    $('currentPage').value = idx + 1;
    updateTOCHighlight(pageNum);

    var img = $('pageImg');
    if (pageCache.has(pageNum)) {
      img.src = pageCache.get(pageNum);
      img.classList.add('loaded');
      hideStatus();
      applyFit();
    } else {
      showStatus('페이지 ' + pageNum + ' 로딩 중...');
      try {
        var page = await extGetPage(bookId, pageNum);
        if (page && page.dataURL) {
          pageCache.set(pageNum, page.dataURL);
          img.src = page.dataURL;
          img.classList.add('loaded');
          hideStatus();
          applyFit();
        } else {
          showStatus('페이지 데이터 없음 (p' + pageNum + ')');
        }
      } catch (e) {
        showStatus('로드 실패');
      }
    }

    prefetch(idx + 1);
    prefetch(idx + 2);
    prefetch(idx - 1);
  }

  async function prefetch(idx) {
    if (idx < 0 || idx >= pages.length) return;
    var pn = pages[idx].pageNum;
    if (pageCache.has(pn)) return;
    try {
      var p = await extGetPage(bookId, pn);
      if (p && p.dataURL) pageCache.set(pn, p.dataURL);
    } catch (e) {}
  }

  // ── Fit / Zoom ──
  function applyFit() {
    var img = $('pageImg');
    var area = $('pageArea');
    if (fitMode === 'width') {
      img.style.width = (area.clientWidth - 48) + 'px';
      img.style.maxHeight = 'none';
    } else if (fitMode === 'page') {
      img.style.width = 'auto';
      img.style.maxWidth = (area.clientWidth - 48) + 'px';
      img.style.maxHeight = (area.clientHeight - 48) + 'px';
    } else {
      img.style.width = zoom + '%';
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
    }
  }

  function setZoom(z) {
    fitMode = 'manual';
    zoom = Math.max(25, Math.min(400, z));
    $('zoomText').textContent = zoom + '%';
    $('fitWidth').classList.remove('active');
    $('fitPage').classList.remove('active');
    applyFit();
  }

  // ── TOC ──
  function renderTOC() {
    var list = $('tocList');
    if (!toc || toc.length === 0) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:#6b7280;font-size:12px">목차 없음</div>';
      return;
    }
    list.innerHTML = toc.map(function (item) {
      var dc = item.depth > 1 ? ' depth-' + item.depth : '';
      return '<div class="toc-item' + dc + '" data-page="' + item.page + '">' +
        '<span class="toc-item-title">' + escHTML(item.title) + '</span>' +
        '<span class="toc-item-page">' + item.page + 'p</span></div>';
    }).join('');

    list.querySelectorAll('.toc-item').forEach(function (el) {
      el.addEventListener('click', function () {
        goToPageNum(parseInt(this.dataset.page, 10));
      });
    });
  }

  function updateTOCHighlight(pageNum) {
    var items = $('tocList').querySelectorAll('.toc-item');
    var best = null;
    items.forEach(function (el) {
      el.classList.remove('active');
      if (parseInt(el.dataset.page, 10) <= pageNum) best = el;
    });
    if (best) {
      best.classList.add('active');
      best.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function goToPageNum(pageNum) {
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].pageNum >= pageNum) { loadPage(i); return; }
    }
  }

  function escHTML(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ── Events ──
  $('prevPage').addEventListener('click', function () { loadPage(currentPageIdx - 1); });
  $('nextPage').addEventListener('click', function () { loadPage(currentPageIdx + 1); });
  $('currentPage').addEventListener('change', function () {
    var idx = parseInt(this.value, 10) - 1;
    if (idx >= 0 && idx < pages.length) loadPage(idx);
    else this.value = currentPageIdx + 1;
  });
  $('currentPage').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { this.blur(); this.dispatchEvent(new Event('change')); }
  });

  $('zoomIn').addEventListener('click', function () { setZoom((fitMode === 'manual' ? zoom : 100) + 25); });
  $('zoomOut').addEventListener('click', function () { setZoom((fitMode === 'manual' ? zoom : 100) - 25); });

  $('fitWidth').addEventListener('click', function () {
    fitMode = 'width';
    this.classList.add('active');
    $('fitPage').classList.remove('active');
    $('zoomText').textContent = '너비';
    applyFit();
  });
  $('fitPage').addEventListener('click', function () {
    fitMode = 'page';
    this.classList.add('active');
    $('fitWidth').classList.remove('active');
    $('zoomText').textContent = '맞춤';
    applyFit();
  });

  $('tocToggle').addEventListener('click', function () {
    tocVisible = !tocVisible;
    $('tocSidebar').classList.toggle('hidden', !tocVisible);
    this.classList.toggle('active', tocVisible);
    setTimeout(applyFit, 260);
  });

  $('downloadPDF').addEventListener('click', async function () {
    if (!pages.length) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = '생성 중...';
    try {
      if (!window.jspdf) {
        var s = document.createElement('script');
        s.src = 'lib/jspdf.umd.min.js';
        document.head.appendChild(s);
        await new Promise(function (res, rej) { s.onload = res; s.onerror = rej; });
      }

      var allPages = [];
      for (var i = 0; i < pages.length; i++) {
        var p;
        if (pageCache.has(pages[i].pageNum)) {
          p = { dataURL: pageCache.get(pages[i].pageNum), width: pages[i].width, height: pages[i].height };
        } else {
          p = await extGetPage(bookId, pages[i].pageNum);
        }
        if (p && p.dataURL) allPages.push(p);
      }
      if (allPages.length === 0) throw new Error('No pages');

      var targetSize = SIZE_PRESETS[$('pdfSize').value] || null;
      var f = allPages[0];
      var dims0 = calcPageDims(f.width, f.height, targetSize);
      var pdf = new window.jspdf.jsPDF({
        orientation: dims0.pageW > dims0.pageH ? 'landscape' : 'portrait', unit: 'mm', format: [dims0.pageW, dims0.pageH]
      });
      for (var j = 0; j < allPages.length; j++) {
        var pg = allPages[j];
        var d = calcPageDims(pg.width, pg.height, targetSize);
        if (j > 0) pdf.addPage([d.pageW, d.pageH], d.pageW > d.pageH ? 'landscape' : 'portrait');
        pdf.addImage(pg.dataURL, 'JPEG', d.x, d.y, d.imgW, d.imgH);
      }
      if (toc && toc.length > 0 && pdf.outline) {
        try {
          var firstPage = pages[0].pageNum, lastPage = pages[pages.length - 1].pageNum;
          toc.forEach(function (item) {
            if (item.page >= firstPage && item.page <= lastPage) {
              for (var k = 0; k < pages.length; k++) {
                if (pages[k].pageNum >= item.page) { pdf.outline.add(null, item.title, { pageNumber: k + 1 }); break; }
              }
            }
          });
        } catch (e) {}
      }
      var safe = (bookTitle || 'ebook').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200);
      pdf.save((safe || 'ebook') + '.pdf');
    } catch (e) {
      alert('PDF 생성 실패: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = '\uD83D\uDCC4';
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); loadPage(currentPageIdx - 1); break;
      case 'ArrowRight': e.preventDefault(); loadPage(currentPageIdx + 1); break;
      case '+': case '=': e.preventDefault(); setZoom((fitMode === 'manual' ? zoom : 100) + 25); break;
      case '-': e.preventDefault(); setZoom((fitMode === 'manual' ? zoom : 100) - 25); break;
    }
  });

  window.addEventListener('resize', function () { if (fitMode !== 'manual') applyFit(); });

  // Init
  $('fitWidth').classList.add('active');
  $('tocToggle').classList.add('active');
  init();
})();
