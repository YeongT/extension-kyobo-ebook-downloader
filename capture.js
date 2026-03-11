(function () {
  'use strict';

  var targetTabId = parseInt(new URLSearchParams(location.search).get('tabId'), 10);
  var bookId = '';
  var bookInfo = null;
  var bookToc = [];
  var pages = new Map();
  var sortedPageNums = [];
  var isCapturing = false;
  var isPaused = false;
  var previewPageNum = -1;
  var lastClickedPage = -1;
  var autoRetryEnabled = true;
  var captureDelayMs = 500;

  var SIZE_PRESETS = { original: null, a4: { w: 210, h: 297 }, b5: { w: 182, h: 257 }, a5: { w: 148, h: 210 } };
  var MODES = { fast: { min: 300, max: 600, cap: 300 }, normal: { min: 800, max: 1500, cap: 500 }, stealth: { min: 2000, max: 5000, cap: 800 } };

  var $ = function (id) { return document.getElementById(id); };

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

  // ── Communication ──
  function sendToContent(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.tabs.sendMessage(targetTabId, msg, function (r) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(r);
        });
      } catch (e) { reject(e); }
    });
  }

  // ── Init ──
  async function init() {
    if (!targetTabId) { setStatus('error', '대상 탭 없음'); return; }

    chrome.storage.local.get({ autoRetry: true, captureDelay: 500 }, function (d) {
      autoRetryEnabled = d.autoRetry !== false;
      captureDelayMs = d.captureDelay || 500;
    });

    try {
      var r = await sendToContent({ action: 'ping' });
      if (!r || r.status !== 'ready') throw new Error('Not ready');
      setStatus('active', '연결됨');
      if (r.isCapturing) { isCapturing = true; showCapturing(); }

      var info = await sendToContent({ action: 'getPageInfo' });
      if (info && info.success) {
        bookInfo = info.data;
        $('bookTitle').textContent = bookInfo.title || 'eBook';
        document.title = (bookInfo.title || 'eBook') + ' - Capture Manager';
        $('startPage').value = 1;
        $('startPage').max = bookInfo.total || 9999;
        $('endPage').value = bookInfo.total || 1;
        $('endPage').max = bookInfo.total || 9999;
      }

      var ci = await sendToContent({ action: 'getCacheInfo' });
      if (ci && ci.success) bookId = ci.data.bookId;

      try { var tr = await sendToContent({ action: 'getTOC' }); if (tr && tr.success) bookToc = tr.data || []; } catch (e) {}

      await loadCachedPages();
    } catch (e) {
      setStatus('error', '연결 실패 - 뷰어 탭을 확인하세요');
    }
  }

  function setStatus(type, text) {
    $('statusDot').className = 'dot ' + type;
    $('statusText').textContent = text;
  }

  // ── Cached pages ──
  async function loadCachedPages() {
    if (!bookId) return;
    try {
      var pagesInfo = await extGetPagesInfo(bookId);
      if (!pagesInfo || pagesInfo.length === 0) return;
      pages.clear();
      pagesInfo.forEach(function (p) {
        pages.set(p.pageNum, { pageNum: p.pageNum, width: p.width, height: p.height, rotation: 0, selected: true });
      });
      sortedPageNums = Array.from(pages.keys()).sort(function (a, b) { return a - b; });
      renderThumbnails();
      updateSelectionCount();
      $('btnResumeCap').style.display = '';
    } catch (e) {}
  }

  // ── Thumbnails ──
  function renderThumbnails() {
    var grid = $('thumbnailGrid');
    if (sortedPageNums.length === 0) {
      grid.innerHTML = '<div class="empty-state">캡처된 페이지가 없습니다</div>';
      return;
    }
    var es = grid.querySelector('.empty-state');
    if (es) es.remove();

    grid.querySelectorAll('.thumb').forEach(function (t) {
      if (!pages.has(parseInt(t.dataset.page, 10))) t.remove();
    });

    sortedPageNums.forEach(function (pn) {
      if (grid.querySelector('.thumb[data-page="' + pn + '"]')) return;

      var thumb = document.createElement('div');
      thumb.className = 'thumb selected';
      thumb.dataset.page = pn;
      thumb.innerHTML =
        '<div class="thumb-check">&#10003;</div>' +
        '<div class="thumb-placeholder">p' + pn + '</div>' +
        '<div class="thumb-overlay">' + pn + 'p</div>';

      var obs = new IntersectionObserver(function (entries, o) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { loadThumbnail(pn, thumb); o.unobserve(e.target); }
        });
      }, { rootMargin: '200px' });
      obs.observe(thumb);

      thumb.addEventListener('click', function (e) {
        if (e.detail === 2) return;
        var pd = pages.get(pn);
        if (e.shiftKey && lastClickedPage >= 0) {
          var lo = Math.min(lastClickedPage, pn), hi = Math.max(lastClickedPage, pn);
          sortedPageNums.forEach(function (p) {
            if (p >= lo && p <= hi) {
              pages.get(p).selected = true;
              var t = grid.querySelector('.thumb[data-page="' + p + '"]');
              if (t) t.classList.add('selected');
            }
          });
        } else {
          pd.selected = !pd.selected;
          thumb.classList.toggle('selected', pd.selected);
        }
        lastClickedPage = pn;
        updateSelectionCount();
      });

      thumb.addEventListener('dblclick', function (e) { e.preventDefault(); openPreview(pn); });
      grid.appendChild(thumb);
    });
  }

  async function loadThumbnail(pageNum, el) {
    try {
      var p = await extGetPage(bookId, pageNum);
      if (p && p.dataURL) {
        var ph = el.querySelector('.thumb-placeholder');
        if (ph) {
          var img = document.createElement('img');
          img.src = p.dataURL;
          var pd = pages.get(pageNum);
          if (pd && pd.rotation) img.style.transform = 'rotate(' + pd.rotation + 'deg)';
          el.replaceChild(img, ph);
        }
      }
    } catch (e) {}
  }

  function updateSelectionCount() {
    var c = 0;
    pages.forEach(function (p) { if (p.selected) c++; });
    $('selectionCount').textContent = c;
    $('btnGeneratePDF').disabled = c === 0;
  }

  $('selectAll').addEventListener('click', function () {
    pages.forEach(function (p) { p.selected = true; });
    document.querySelectorAll('.thumb').forEach(function (t) { t.classList.add('selected'); });
    updateSelectionCount();
  });

  $('deselectAll').addEventListener('click', function () {
    pages.forEach(function (p) { p.selected = false; });
    document.querySelectorAll('.thumb').forEach(function (t) { t.classList.remove('selected'); });
    updateSelectionCount();
  });

  // ── Preview Modal ──
  function openPreview(pageNum) {
    previewPageNum = pageNum;
    $('previewModal').classList.add('open');
    $('previewTitle').textContent = '페이지 ' + pageNum;
    $('recaptureBtn').disabled = isCapturing;
    loadPreviewImage(pageNum);
  }

  function closePreview() {
    $('previewModal').classList.remove('open');
    previewPageNum = -1;
  }

  async function loadPreviewImage(pageNum) {
    var img = $('previewImg');
    img.src = '';
    img.style.transform = '';
    try {
      var p = await extGetPage(bookId, pageNum);
      if (p && p.dataURL) {
        img.src = p.dataURL;
        var pd = pages.get(pageNum);
        if (pd && pd.rotation) img.style.transform = 'rotate(' + pd.rotation + 'deg)';
      }
    } catch (e) {}
  }

  $('previewClose').addEventListener('click', closePreview);
  $('modalBackdrop').addEventListener('click', closePreview);

  $('previewPrev').addEventListener('click', function () {
    var i = sortedPageNums.indexOf(previewPageNum);
    if (i > 0) openPreview(sortedPageNums[i - 1]);
  });
  $('previewNext').addEventListener('click', function () {
    var i = sortedPageNums.indexOf(previewPageNum);
    if (i < sortedPageNums.length - 1) openPreview(sortedPageNums[i + 1]);
  });

  // ── Rotate ──
  $('rotateLeft').addEventListener('click', function () { rotateCurrent(-90); });
  $('rotateRight').addEventListener('click', function () { rotateCurrent(90); });

  function rotateCurrent(deg) {
    if (previewPageNum < 0) return;
    var pd = pages.get(previewPageNum);
    if (!pd) return;
    pd.rotation = ((pd.rotation || 0) + deg + 360) % 360;
    $('previewImg').style.transform = pd.rotation ? 'rotate(' + pd.rotation + 'deg)' : '';
    var ti = document.querySelector('.thumb[data-page="' + previewPageNum + '"] img');
    if (ti) ti.style.transform = pd.rotation ? 'rotate(' + pd.rotation + 'deg)' : '';
  }

  // ── Re-capture ──
  $('recaptureBtn').addEventListener('click', async function () {
    if (previewPageNum < 0 || isCapturing) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = '캡처 중...';
    try {
      var r = await sendToContent({ action: 'recapturePage', pageNum: previewPageNum });
      if (r && r.success) {
        await loadPreviewImage(previewPageNum);
        var thumb = document.querySelector('.thumb[data-page="' + previewPageNum + '"] img');
        if (thumb) {
          var p = await extGetPage(bookId, previewPageNum);
          if (p) thumb.src = p.dataURL;
        }
      } else {
        alert('재캡처 실패: ' + (r ? r.error : ''));
      }
    } catch (e) { alert('재캡처 실패: ' + e.message); }
    btn.disabled = false;
    btn.textContent = '재캡처';
  });

  // ── Delete ──
  $('deleteBtn').addEventListener('click', function () {
    if (previewPageNum < 0) return;
    var pn = previewPageNum;
    var idx = sortedPageNums.indexOf(pn);

    pages.delete(pn);
    sortedPageNums = sortedPageNums.filter(function (p) { return p !== pn; });
    if (bookId) extDeletePage(bookId, pn).catch(function () {});

    var thumb = document.querySelector('.thumb[data-page="' + pn + '"]');
    if (thumb) thumb.remove();
    updateSelectionCount();

    if (sortedPageNums.length === 0) {
      closePreview();
      $('thumbnailGrid').innerHTML = '<div class="empty-state">캡처된 페이지가 없습니다</div>';
      return;
    }
    openPreview(sortedPageNums[Math.min(idx, sortedPageNums.length - 1)]);
  });

  // ── Capture Control ──
  document.querySelectorAll('.mode-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.mode-btn').forEach(function (x) { x.classList.remove('active'); });
      this.classList.add('active');
      if (isCapturing) sendToContent({ action: 'changeMode', mode: this.dataset.mode }).catch(function () {});
    });
  });

  $('btnStart').addEventListener('click', function () { if (!isCapturing) startCapture(false); });
  $('btnResumeCap').addEventListener('click', function () { if (!isCapturing) startCapture(true); });

  $('btnPause').addEventListener('click', function () {
    sendToContent({ action: 'pauseCapture' }).catch(function () {});
    isPaused = true;
    $('btnPause').style.display = 'none';
    $('btnResume').style.display = '';
    setStatus('capturing', '일시정지');
  });

  $('btnResume').addEventListener('click', function () {
    sendToContent({ action: 'resumeCapture' }).catch(function () {});
    isPaused = false;
    $('btnResume').style.display = 'none';
    $('btnPause').style.display = '';
    setStatus('capturing', '캡처중...');
  });

  $('btnStop').addEventListener('click', function () {
    sendToContent({ action: 'stopCapture' }).catch(function () {});
  });

  async function startCapture(resume) {
    var sp = parseInt($('startPage').value, 10) || 1;
    var ep = parseInt($('endPage').value, 10) || 1;
    if (sp > ep) { alert('시작 > 끝'); return; }

    var active = document.querySelector('.mode-btn.active');
    var mode = active ? active.dataset.mode : 'normal';
    var mp = MODES[mode] || MODES.normal;

    try {
      var r = await sendToContent({
        action: 'startCapture',
        options: {
          startPage: sp, endPage: ep,
          pageDelayMin: mp.min, pageDelayMax: mp.max,
          captureDelay: captureDelayMs || mp.cap,
          mode: mode, resume: !!resume,
          autoRetry: autoRetryEnabled,
          targetSize: SIZE_PRESETS[$('pdfSize').value] || null
        }
      });
      if (r && r.success) showCapturing();
      else alert('시작 실패: ' + (r ? r.error : ''));
    } catch (e) { alert('시작 실패: ' + e.message); }
  }

  function showCapturing() {
    isCapturing = true;
    $('btnStart').style.display = 'none';
    $('btnResumeCap').style.display = 'none';
    $('btnPause').style.display = '';
    $('btnStop').style.display = '';
    $('progressPanel').style.display = '';
    setStatus('capturing', '캡처중...');
  }

  function showIdle(statusText) {
    isCapturing = false;
    isPaused = false;
    $('btnStart').style.display = '';
    $('btnResumeCap').style.display = sortedPageNums.length > 0 ? '' : 'none';
    $('btnPause').style.display = 'none';
    $('btnResume').style.display = 'none';
    $('btnStop').style.display = 'none';
    setStatus('active', statusText || '완료');
  }

  // ── Messages from content ──
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.source !== 'KYOBO_CONTENT') return;
    switch (msg.type) {
      case 'captureProgress': onProgress(msg.data); break;
      case 'captureComplete': showIdle('완료! ' + (msg.data.capturedCount || 0) + 'p'); loadCachedPages(); break;
      case 'captureStopped': showIdle('중지됨'); loadCachedPages(); break;
      case 'captureError': showIdle('오류'); break;
      case 'captureStarted': showCapturing(); break;
    }
  });

  function onProgress(d) {
    if (!d) return;
    var pct = d.total > 0 ? Math.round(d.current / d.total * 100) : 0;
    $('progressFill').style.width = pct + '%';
    $('progressInfo').textContent = d.current + '/' + d.total + ' (' + pct + '%)';
    if (d.page && !pages.has(d.page)) {
      setTimeout(function () { tryAddPage(d.page, 0); }, 300);
    }
  }

  function tryAddPage(pageNum, att) {
    extGetPage(bookId, pageNum).then(function (p) {
      if (p) {
        pages.set(pageNum, { pageNum: pageNum, width: p.width, height: p.height, rotation: 0, selected: true });
        sortedPageNums = Array.from(pages.keys()).sort(function (a, b) { return a - b; });
        renderThumbnails();
        updateSelectionCount();
      } else if (att < 5) {
        setTimeout(function () { tryAddPage(pageNum, att + 1); }, 500);
      }
    }).catch(function () {
      if (att < 5) setTimeout(function () { tryAddPage(pageNum, att + 1); }, 500);
    });
  }

  // ── PDF Generation ──
  $('btnGeneratePDF').addEventListener('click', async function () {
    var selected = [];
    sortedPageNums.forEach(function (pn) { var pd = pages.get(pn); if (pd && pd.selected) selected.push(pn); });
    if (selected.length === 0) return;

    var btn = this;
    btn.disabled = true;
    btn.textContent = 'PDF 생성 중...';

    try {
      if (!window.jspdf) {
        var s = document.createElement('script');
        s.src = 'lib/jspdf.umd.min.js';
        document.head.appendChild(s);
        await new Promise(function (res, rej) { s.onload = res; s.onerror = rej; });
      }

      var target = SIZE_PRESETS[$('pdfSize').value] || null;
      var all = [];

      for (var i = 0; i < selected.length; i++) {
        btn.textContent = 'PDF (' + (i + 1) + '/' + selected.length + ')';
        var pn = selected[i];
        var pd = pages.get(pn);
        var pg = await extGetPage(bookId, pn);
        if (!pg || !pg.dataURL) continue;

        var url = pg.dataURL, w = pg.width, h = pg.height;
        if (pd.rotation && pd.rotation !== 0) {
          var rot = await applyRotation(url, w, h, pd.rotation);
          url = rot.dataURL; w = rot.width; h = rot.height;
        }
        all.push({ dataURL: url, width: w, height: h });
      }

      if (all.length === 0) throw new Error('No pages');

      var d0 = calcPageDims(all[0].width, all[0].height, target);
      var pdf = new window.jspdf.jsPDF({
        orientation: d0.pageW > d0.pageH ? 'landscape' : 'portrait',
        unit: 'mm', format: [d0.pageW, d0.pageH]
      });

      for (var j = 0; j < all.length; j++) {
        var d = calcPageDims(all[j].width, all[j].height, target);
        if (j > 0) pdf.addPage([d.pageW, d.pageH], d.pageW > d.pageH ? 'landscape' : 'portrait');
        pdf.addImage(all[j].dataURL, 'JPEG', d.x, d.y, d.imgW, d.imgH);
      }

      if (bookToc.length > 0 && pdf.outline) {
        try {
          bookToc.forEach(function (item) {
            for (var k = 0; k < selected.length; k++) {
              if (selected[k] >= item.page) { pdf.outline.add(null, item.title, { pageNumber: k + 1 }); break; }
            }
          });
        } catch (e) {}
      }

      var title = (bookInfo && bookInfo.title) || 'ebook';
      var safe = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200);
      pdf.save((safe || 'ebook') + '.pdf');
    } catch (e) {
      alert('PDF 생성 실패: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'PDF 생성';
    updateSelectionCount();
  });

  function applyRotation(dataURL, w, h, deg) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        if (deg === 90 || deg === 270) { canvas.width = h; canvas.height = w; }
        else { canvas.width = w; canvas.height = h; }
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(deg * Math.PI / 180);
        ctx.drawImage(img, -w / 2, -h / 2);
        resolve({ dataURL: canvas.toDataURL('image/jpeg', 0.92), width: canvas.width, height: canvas.height });
      };
      img.src = dataURL;
    });
  }

  // ── Keyboard ──
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') closePreview();
    if (previewPageNum >= 0) {
      if (e.key === 'ArrowLeft') $('previewPrev').click();
      if (e.key === 'ArrowRight') $('previewNext').click();
    }
  });

  init();
})();
