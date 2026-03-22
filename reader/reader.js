(function () {
  'use strict';

  var bookId = new URLSearchParams(location.search).get('book') || '';
  var pages = [];
  var currentPageIdx = 0;
  var zoom = 100;
  var fitMode = 'width';
  var viewMode = 'single'; // single | spread | scroll
  var coverIncluded = true;
  var tocVisible = true;
  var toc = [];
  var bookTitle = '';
  var pageCache = new Map();

  var $ = function (id) { return document.getElementById(id); };


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
      populateChapterDropdown();

      // Restore last read position
      var savedIdx = 0;
      try {
        var saved = localStorage.getItem('reader_lastPage_' + bookId);
        if (saved) {
          var si = parseInt(saved, 10);
          if (si >= 0 && si < pages.length) savedIdx = si;
        }
      } catch (e) {}
      currentPageIdx = savedIdx;
      showView();
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

  // ── View switching ──
  function showView() {
    // Hide all containers
    $('pageImg').classList.remove('loaded');
    $('pageImg').style.display = 'none';
    $('spreadContainer').classList.remove('active');
    $('scrollContainer').classList.remove('active');

    if (viewMode === 'single') {
      $('pageImg').style.display = '';
      loadSinglePage(currentPageIdx);
    } else if (viewMode === 'spread') {
      $('spreadContainer').classList.add('active');
      loadSpreadPage(currentPageIdx);
    } else if (viewMode === 'scroll') {
      $('scrollContainer').classList.add('active');
      loadScrollView();
    }
  }

  function setViewMode(mode) {
    if (pages.length === 0) return; // no book loaded yet
    viewMode = mode;
    $('viewSingle').classList.toggle('active', mode === 'single');
    $('viewSpread').classList.toggle('active', mode === 'spread');
    $('viewScroll').classList.toggle('active', mode === 'scroll');
    $('coverToggle').classList.toggle('active', coverIncluded);
    $('coverToggle').style.opacity = mode === 'spread' ? '1' : '.4';
    showView();
  }

  // ── Single page ──
  async function loadSinglePage(idx) {
    if (idx < 0 || idx >= pages.length) return;
    currentPageIdx = idx;
    var pageNum = pages[idx].pageNum;
    $('currentPage').value = idx + 1;
    updateTOCHighlight(pageNum);

    var img = $('pageImg');
    var dataURL = await getPageData(pageNum);
    if (dataURL) {
      img.src = dataURL;
      img.classList.add('loaded');
      img.style.display = '';
      hideStatus();
      applyFit();
    } else {
      showStatus('페이지 데이터 없음 (p' + pageNum + ')');
    }
    prefetch(idx + 1);
    prefetch(idx - 1);
  }

  // ── Spread (two-page) ──
  function getSpreadPair(idx) {
    // coverIncluded: page 0 alone, then pairs (1,2), (3,4), ...
    // !coverIncluded: pairs (0,1), (2,3), ...
    if (coverIncluded) {
      if (idx === 0) return [0, -1]; // cover alone on right
      var base = idx % 2 === 1 ? idx : idx - 1;
      return [base, base + 1 < pages.length ? base + 1 : -1];
    }
    var base = idx % 2 === 0 ? idx : idx - 1;
    return [base, base + 1 < pages.length ? base + 1 : -1];
  }

  async function loadSpreadPage(idx) {
    if (idx < 0 || idx >= pages.length) return;
    var pair = getSpreadPair(idx);
    currentPageIdx = pair[0];
    $('currentPage').value = pair[0] + 1;

    var leftImg = $('spreadLeft');
    var rightImg = $('spreadRight');
    leftImg.classList.remove('loaded', 'placeholder');
    rightImg.classList.remove('loaded', 'placeholder');

    hideStatus();

    // Cover alone: show only on right side
    if (coverIncluded && pair[0] === 0 && pair[1] === -1) {
      leftImg.classList.add('placeholder');
      var data = await getPageData(pages[0].pageNum);
      if (data) {
        rightImg.src = data;
        rightImg.classList.add('loaded');
      }
      updateTOCHighlight(pages[0].pageNum);
      applySpreadFit();
      prefetch(1);
      prefetch(2);
      return;
    }

    // Left page
    var leftData = await getPageData(pages[pair[0]].pageNum);
    if (leftData) {
      leftImg.src = leftData;
      leftImg.classList.add('loaded');
    }

    // Right page
    if (pair[1] >= 0 && pair[1] < pages.length) {
      var rightData = await getPageData(pages[pair[1]].pageNum);
      if (rightData) {
        rightImg.src = rightData;
        rightImg.classList.add('loaded');
      }
    } else {
      rightImg.classList.add('placeholder');
    }

    updateTOCHighlight(pages[pair[0]].pageNum);
    applySpreadFit();
    prefetch(pair[0] + 2);
    prefetch(pair[0] + 3);
  }

  function applySpreadFit() {
    var area = $('pageArea');
    var maxW = area.clientWidth - 48;
    var maxH = area.clientHeight - 48;
    var leftImg = $('spreadLeft');
    var rightImg = $('spreadRight');

    if (fitMode === 'page') {
      leftImg.style.maxHeight = maxH + 'px';
      leftImg.style.maxWidth = (maxW / 2 - 4) + 'px';
      leftImg.style.width = 'auto';
      rightImg.style.maxHeight = maxH + 'px';
      rightImg.style.maxWidth = (maxW / 2 - 4) + 'px';
      rightImg.style.width = 'auto';
    } else {
      // Width fit: each page takes half
      var halfW = (maxW / 2 - 4);
      leftImg.style.width = halfW + 'px';
      leftImg.style.maxHeight = 'none';
      leftImg.style.maxWidth = 'none';
      rightImg.style.width = halfW + 'px';
      rightImg.style.maxHeight = 'none';
      rightImg.style.maxWidth = 'none';
    }
  }

  function navigateSpread(direction) {
    var pair = getSpreadPair(currentPageIdx);
    var nextIdx;
    if (direction > 0) {
      nextIdx = (pair[1] >= 0 ? pair[1] : pair[0]) + 1;
    } else {
      nextIdx = pair[0] - 1;
      if (nextIdx >= 0) {
        var prevPair = getSpreadPair(nextIdx);
        nextIdx = prevPair[0];
      }
    }
    if (nextIdx >= 0 && nextIdx < pages.length) {
      loadSpreadPage(nextIdx);
    }
  }

  // ── Scroll view ──
  var scrollObserver = null;

  function loadScrollView() {
    var container = $('scrollContainer');
    container.innerHTML = '';
    hideStatus();

    // Create lightweight placeholders first (no images loaded)
    for (var i = 0; i < pages.length; i++) {
      var wrapper = document.createElement('div');
      wrapper.className = 'scroll-slot';
      wrapper.dataset.idx = i;
      wrapper.dataset.pagenum = pages[i].pageNum;
      wrapper.dataset.loaded = 'false';
      // Placeholder text
      var label = document.createElement('span');
      label.className = 'scroll-label';
      label.textContent = pages[i].pageNum;
      wrapper.appendChild(label);
      container.appendChild(wrapper);
    }

    applyScrollFit();

    // Lazy load with IntersectionObserver — only load nearby pages
    if (scrollObserver) scrollObserver.disconnect();
    scrollObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var slot = entry.target;
        if (entry.isIntersecting) {
          if (slot.dataset.loaded === 'false') {
            slot.dataset.loaded = 'loading';
            var pn = parseInt(slot.dataset.pagenum, 10);
            getPageData(pn).then(function (dataURL) {
              if (dataURL) {
                var img = document.createElement('img');
                img.className = 'scroll-page';
                img.src = dataURL;
                img.onload = function () {
                  slot.innerHTML = '';
                  slot.appendChild(img);
                  slot.dataset.loaded = 'true';
                  slot.classList.add('loaded');
                  applyScrollFit();
                };
              }
            });
          }
          // Update current page indicator
          var idx = parseInt(slot.dataset.idx, 10);
          $('currentPage').value = idx + 1;
          $('pageSlider').value = idx + 1;
          currentPageIdx = idx;
          updateTOCHighlight(parseInt(slot.dataset.pagenum, 10));
        }
      });
    }, { root: $('pageArea'), rootMargin: '600px 0px', threshold: 0.1 });

    container.querySelectorAll('.scroll-slot').forEach(function (slot) {
      scrollObserver.observe(slot);
    });
  }

  function applyScrollFit() {
    var area = $('pageArea');
    var maxH = area.clientHeight - 32;
    var maxW = area.clientWidth - 48;
    // Apply to both slots (placeholder) and loaded images
    var slots = $('scrollContainer').querySelectorAll('.scroll-slot');
    var imgs = $('scrollContainer').querySelectorAll('.scroll-page');
    if (fitMode === 'page') {
      slots.forEach(function (s) { s.style.width = 'auto'; s.style.maxWidth = maxW + 'px'; s.style.minHeight = maxH * 0.6 + 'px'; });
      imgs.forEach(function (img) {
        img.style.maxHeight = maxH + 'px';
        img.style.width = 'auto';
        img.style.maxWidth = maxW + 'px';
      });
    } else if (fitMode === 'width') {
      slots.forEach(function (s) { s.style.width = maxW + 'px'; s.style.maxWidth = 'none'; });
      imgs.forEach(function (img) {
        img.style.width = maxW + 'px';
        img.style.maxHeight = 'none';
        img.style.maxWidth = 'none';
      });
    } else {
      // Manual zoom: pixel-based, relative to each image's natural size
      imgs.forEach(function (img) {
        var w = img.naturalWidth > 0 ? Math.round(img.naturalWidth * zoom / 100) : maxW;
        img.style.width = w + 'px';
        img.style.maxHeight = 'none';
        img.style.maxWidth = 'none';
      });
      slots.forEach(function (s) {
        var img = s.querySelector('.scroll-page');
        if (img && img.naturalWidth > 0) {
          s.style.width = Math.round(img.naturalWidth * zoom / 100) + 'px';
        } else {
          s.style.width = maxW + 'px';
        }
        s.style.maxWidth = 'none';
      });
    }
  }

  // ── Page data ──
  async function getPageData(pageNum) {
    if (pageCache.has(pageNum)) return pageCache.get(pageNum);
    try {
      var page = await extGetPage(bookId, pageNum);
      if (page && page.dataURL) {
        pageCache.set(pageNum, page.dataURL);
        return page.dataURL;
      }
    } catch (e) {}
    return null;
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
  // Get current effective zoom as % of natural image size
  function getEffectiveZoom() {
    if (fitMode === 'manual') return zoom;
    if (viewMode === 'single') {
      var img = $('pageImg');
      if (img.naturalWidth > 0 && img.clientWidth > 0) {
        return Math.round(img.clientWidth / img.naturalWidth * 100);
      }
    } else if (viewMode === 'scroll') {
      var firstImg = $('scrollContainer').querySelector('.scroll-page');
      if (firstImg && firstImg.naturalWidth > 0 && firstImg.clientWidth > 0) {
        return Math.round(firstImg.clientWidth / firstImg.naturalWidth * 100);
      }
    }
    return 100;
  }

  function applyFit() {
    if (viewMode === 'spread') { applySpreadFit(); return; }
    if (viewMode === 'scroll') { applyScrollFit(); return; }

    var img = $('pageImg');
    var area = $('pageArea');
    if (fitMode === 'width') {
      img.style.width = (area.clientWidth - 48) + 'px';
      img.style.maxHeight = 'none';
      img.style.maxWidth = 'none';
    } else if (fitMode === 'page') {
      img.style.width = 'auto';
      img.style.maxWidth = (area.clientWidth - 48) + 'px';
      img.style.maxHeight = (area.clientHeight - 48) + 'px';
    } else {
      // Manual zoom: pixel-based, relative to natural image size
      var naturalW = img.naturalWidth;
      if (naturalW > 0) {
        img.style.width = Math.round(naturalW * zoom / 100) + 'px';
      }
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
      var d = Math.min(item.depth || 1, 10);
      var dc = d > 1 ? ' depth-' + Math.min(d, 3) : '';
      // depth 4+ uses inline padding (16px per level)
      var inlineStyle = d > 3 ? ' style="padding-left:' + (d * 16) + 'px;font-weight:400;color:#aeaeb2;font-size:11px"' : '';
      return '<div class="toc-item' + dc + '" data-page="' + item.page + '">' +
        '<span class="toc-item-title"' + inlineStyle + '>' + escHTML(item.title) + '</span>' +
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
      if (pages[i].pageNum >= pageNum) {
        currentPageIdx = i;
        if (viewMode === 'scroll') {
          var el = $('scrollContainer').querySelector('[data-idx="' + i + '"]');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          showView();
        }
        return;
      }
    }
  }

  // escHTML: use shared esc() from utils.js
  var escHTML = (typeof esc === 'function') ? esc : function (s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

  // ── Chapter dropdown for PDF export ──
  function populateChapterDropdown() {
    var sel = $('dlRange');
    sel.innerHTML = '<option value="all">전체 (' + pages.length + '페이지)</option>';
    if (!toc || toc.length === 0) return;

    // Build chapter ranges from depth-1 TOC items
    var chapters = [];
    for (var i = 0; i < toc.length; i++) {
      if (toc[i].depth === 1) {
        chapters.push({ title: toc[i].title, startPage: toc[i].page, endPage: 0 });
      }
    }
    // Calculate end pages
    for (var j = 0; j < chapters.length; j++) {
      if (j + 1 < chapters.length) {
        chapters[j].endPage = chapters[j + 1].startPage - 1;
      } else {
        // Last chapter goes to last page
        var lastPageNum = pages.length > 0 ? pages[pages.length - 1].pageNum : 0;
        chapters[j].endPage = lastPageNum;
      }
    }

    for (var k = 0; k < chapters.length; k++) {
      var ch = chapters[k];
      var pageCount = ch.endPage - ch.startPage + 1;
      var opt = document.createElement('option');
      opt.value = ch.startPage + '-' + ch.endPage;
      opt.textContent = ch.title + ' (p' + ch.startPage + '-' + ch.endPage + ', ' + pageCount + 'p)';
      sel.appendChild(opt);
    }
  }

  function getSelectedPageRange() {
    var val = $('dlRange').value;
    if (val === 'all') return null; // all pages
    var parts = val.split('-');
    return { start: parseInt(parts[0], 10), end: parseInt(parts[1], 10) };
  }

  // ── Navigation ──
  function navigate(direction) {
    if (viewMode === 'spread') {
      navigateSpread(direction);
    } else if (viewMode === 'single') {
      var next = currentPageIdx + direction;
      if (next >= 0 && next < pages.length) loadSinglePage(next);
    }
  }

  // ── Slider sync ──
  function syncSlider() {
    var slider = $('pageSlider');
    slider.max = pages.length || 1;
    slider.value = currentPageIdx + 1;
  }

  // ── Dark mode ──
  var isDark = false;
  function toggleDark() {
    isDark = !isDark;
    document.body.classList.toggle('dark', isDark);
    $('darkToggle').classList.toggle('active', isDark);
  }

  // ── Fullscreen ──
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(function () {});
    }
  }

  // ── Events ──
  $('prevPage').addEventListener('click', function () { navigate(-1); });
  $('nextPage').addEventListener('click', function () { navigate(1); });
  $('currentPage').addEventListener('change', function () {
    var idx = parseInt(this.value, 10) - 1;
    if (idx >= 0 && idx < pages.length) {
      currentPageIdx = idx;
      syncSlider();
      if (viewMode === 'scroll') {
        var slot = $('scrollContainer').querySelector('[data-idx="' + idx + '"]');
        if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
        updateTOCHighlight(pages[idx].pageNum);
      } else {
        showView();
      }
    } else {
      this.value = currentPageIdx + 1;
    }
  });
  $('currentPage').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { this.blur(); this.dispatchEvent(new Event('change')); }
  });
  $('pageSlider').addEventListener('input', function () {
    var idx = parseInt(this.value, 10) - 1;
    if (idx >= 0 && idx < pages.length) {
      currentPageIdx = idx;
      $('currentPage').value = idx + 1;
      if (viewMode === 'scroll') {
        // Scroll to the page instead of reloading everything
        var slot = $('scrollContainer').querySelector('[data-idx="' + idx + '"]');
        if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
        updateTOCHighlight(pages[idx].pageNum);
      } else {
        showView();
      }
    }
  });

  $('zoomIn').addEventListener('click', function () { setZoom(getEffectiveZoom() + 25); });
  $('zoomOut').addEventListener('click', function () { setZoom(getEffectiveZoom() - 25); });

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

  // View mode buttons
  $('viewSingle').addEventListener('click', function () { setViewMode('single'); });
  $('viewSpread').addEventListener('click', function () { setViewMode('spread'); });
  $('viewScroll').addEventListener('click', function () { setViewMode('scroll'); });
  $('coverToggle').addEventListener('click', function () {
    coverIncluded = !coverIncluded;
    this.classList.toggle('active', coverIncluded);
    if (viewMode === 'spread') showView();
  });

  $('darkToggle').addEventListener('click', toggleDark);
  $('fullscreenBtn').addEventListener('click', toggleFullscreen);

  // Copy current page image to clipboard
  $('copyImageBtn').addEventListener('click', async function () {
    if (!pages.length) return;
    var pn = pages[currentPageIdx].pageNum;
    var dataURL = await getPageData(pn);
    if (!dataURL) return;
    try {
      var res = await fetch(dataURL);
      var blob = await res.blob();
      var pngBlob = blob;
      // Convert to PNG if needed
      if (blob.type !== 'image/png') {
        var img = new Image();
        img.src = dataURL;
        await new Promise(function (r) { img.onload = r; });
        var c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        pngBlob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      flashBtn($('copyImageBtn'), '복사됨!');
    } catch (e) {
      flashBtn($('copyImageBtn'), '실패');
    }
  });

  // Save current page image
  $('saveImageBtn').addEventListener('click', async function () {
    if (!pages.length) return;
    var pn = pages[currentPageIdx].pageNum;
    var dataURL = await getPageData(pn);
    if (!dataURL) return;
    var a = document.createElement('a');
    a.href = dataURL;
    var safe = (bookTitle || 'page').replace(/[\\/:*?"<>|]/g, '_').substring(0, 80);
    var ext = dataURL.indexOf('image/png') !== -1 ? '.png' : '.jpg';
    a.download = safe + '_p' + String(pn).padStart(4, '0') + ext;
    a.click();
    flashBtn($('saveImageBtn'), '저장됨!');
  });

  function flashBtn(btn, text) {
    var span = btn.querySelector('span');
    if (!span) return;
    var orig = span.textContent;
    span.textContent = text;
    setTimeout(function () { span.textContent = orig; }, 1500);
  }

  $('tocToggle').addEventListener('click', function () {
    tocVisible = !tocVisible;
    $('tocSidebar').classList.toggle('hidden', !tocVisible);
    this.classList.toggle('active', tocVisible);
    setTimeout(applyFit, 260);
  });

  // Download dropdown
  $('downloadBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    $('dlDropdown').classList.toggle('open');
  });
  document.addEventListener('click', function () {
    $('dlDropdown').classList.remove('open');
  });
  $('dlDropdown').addEventListener('click', function (e) { e.stopPropagation(); });

  function getSelectedPdfSize() {
    var checked = document.querySelector('input[name="pdfSize"]:checked');
    return checked ? checked.value : 'original';
  }

  $('dlPdfBtn').addEventListener('click', async function () {
    if (!pages.length) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = '생성 중...';
    try {
      if (!window.jspdf) {
        var s = document.createElement('script');
        s.src = '../lib/jspdf.umd.min.js';
        document.head.appendChild(s);
        await new Promise(function (res, rej) { s.onload = res; s.onerror = rej; });
      }

      var range = getSelectedPageRange();
      var targetPages = pages;
      if (range) {
        targetPages = pages.filter(function (pg) {
          return pg.pageNum >= range.start && pg.pageNum <= range.end;
        });
      }

      if (targetPages.length === 0) throw new Error('No pages');

      var sizeVal = getSelectedPdfSize();
      var targetSize = SIZE_PRESETS[sizeVal] || null;
      var QUALITY = 0.85;

      // Memory check
      var perPageMB = targetSize ? 1 : 4;
      var estimatedMB = targetPages.length * perPageMB;
      if (estimatedMB > 1000) {
        if (!confirm('PDF 예상 용량: ~' + Math.round(estimatedMB / 1024 * 10) / 10 + 'GB\n브라우저에서 실패할 수 있습니다. 계속하시겠습니까?')) {
          btn.disabled = false;
          btn.textContent = 'PDF 다운로드';
          return;
        }
      }

      var pdf = null;
      var outlineParents = {};
      var tocByPage = {};
      if (toc && toc.length > 0) {
        toc.forEach(function (t) {
          if (!tocByPage[t.page]) tocByPage[t.page] = [];
          tocByPage[t.page].push(t);
        });
      }

      for (var j = 0; j < targetPages.length; j++) {
        btn.textContent = (j + 1) + '/' + targetPages.length + ' 처리 중...';
        var pg;
        if (pageCache.has(targetPages[j].pageNum)) {
          pg = { dataURL: pageCache.get(targetPages[j].pageNum), width: targetPages[j].width, height: targetPages[j].height };
        } else {
          pg = await extGetPage(bookId, targetPages[j].pageNum);
        }
        if (!pg || !pg.dataURL) continue;

        var imgDims = await getImageDimensions(pg.dataURL);
        var d = calcPageDimensions(imgDims.width, imgDims.height, targetSize);
        var lay = calcImageLayout(imgDims.width, imgDims.height, d.pageW, d.pageH, targetSize);

        if (!pdf) {
          pdf = new window.jspdf.jsPDF({ orientation: d.orientation, unit: 'mm', format: [d.pageW, d.pageH] });
        } else {
          pdf.addPage([d.pageW, d.pageH], d.orientation);
        }

        var maxW = targetSize ? Math.round(d.pageW / 25.4 * 300) : 0;
        var jpegURL = await toJpegDataURL(pg.dataURL, QUALITY, maxW);
        pdf.addImage(jpegURL, 'JPEG', lay.x, lay.y, lay.w, lay.h);
        pg.dataURL = null;
        jpegURL = null;

        var pn = targetPages[j].pageNum;
        if (tocByPage[pn]) {
          tocByPage[pn].forEach(function (entry) {
            try {
              var depth = entry.depth || 1;
              var parent = depth > 1 ? (outlineParents[depth - 1] || null) : null;
              var node = pdf.outline.add(parent, entry.title || ('Page ' + pn), { pageNumber: j + 1 });
              outlineParents[depth] = node;
              for (var dd = depth + 1; dd <= 10; dd++) delete outlineParents[dd];
            } catch (e) {}
          });
        }
      }
      if (!pdf) throw new Error('No pages');
      var safe = (bookTitle || 'ebook').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200);
      var sizeSuffix = sizeVal && sizeVal !== 'original' ? '_' + sizeVal.toUpperCase() : '';
      var rangeSuffix = range ? '_p' + range.start + '-' + range.end : '';
      pdf.save((safe || 'ebook') + rangeSuffix + sizeSuffix + '.pdf');
      $('dlDropdown').classList.remove('open');
    } catch (e) {
      alert('PDF 생성 실패: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'PDF 다운로드';
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); navigate(-1); break;
      case 'ArrowRight': e.preventDefault(); navigate(1); break;
      case '+': case '=': e.preventDefault(); setZoom(getEffectiveZoom() + 25); break;
      case '-': e.preventDefault(); setZoom(getEffectiveZoom() - 25); break;
      case 'w': case 'W': e.preventDefault(); $('fitWidth').click(); break;
      case 'f': case 'F':
        if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); $('fitPage').click(); }
        break;
      case 'd': case 'D': e.preventDefault(); toggleDark(); break;
      case 'F11': e.preventDefault(); toggleFullscreen(); break;
    }
  });

  window.addEventListener('resize', function () {
    if (fitMode !== 'manual') applyFit();
  });

  // Ctrl+wheel: zoom in/out. Plain wheel while zoomed: reset to fit-width
  var _wheelResetTimer = null;
  document.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      var delta = e.deltaY > 0 ? -25 : 25;
      setZoom(getEffectiveZoom() + delta);
    } else if (fitMode === 'manual') {
      // User scrolling while manually zoomed — debounce reset to fit-width
      clearTimeout(_wheelResetTimer);
      _wheelResetTimer = setTimeout(function () {
        fitMode = 'width';
        $('fitWidth').classList.add('active');
        $('fitPage').classList.remove('active');
        $('zoomText').textContent = '너비';
        applyFit();
      }, 800);
    }
  }, { passive: false });

  // Wrap original showView to sync slider
  var _origShowView = showView;
  showView = function () {
    _origShowView();
    syncSlider();
    // Save reading position
    if (bookId && pages.length > 0) {
      try { localStorage.setItem('reader_lastPage_' + bookId, String(currentPageIdx)); } catch (e) {}
    }
  };

  // Init — default to page fit (세로 맞춤)
  fitMode = 'page';
  $('fitPage').classList.add('active');
  $('zoomText').textContent = '맞춤';
  $('tocToggle').classList.add('active');
  $('coverToggle').classList.add('active');
  init();
})();
