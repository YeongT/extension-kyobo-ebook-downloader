(function () {
  'use strict';

  // ============================================================
  // CAU Kyobo Ebook PDF Downloader - MAIN World Injection
  // Bypasses all detection layers, captures canvas, generates PDF
  // ============================================================

  var ALLOWED_ORIGIN = location.origin;

  // Incremental PDF building
  var pdfDocument = null;
  var pdfDims = null;
  var capturedCount = 0;
  var capturedPageMeta = [];

  // ── 1. Bypass bot detection (bdb.derobotect.js) ──
  // Detector tracks mousedown/mouseup/keydown/keyup timing intervals.
  // If stddev < 1.9 after 40+ events → bot detected → /invalidUse.
  // Fix: inject jitter into event handlers + poison detector with varied fake events.
  try {
    var origAddEventListener = EventTarget.prototype.addEventListener;
    var noisedTypes = { mousedown: 1, mouseup: 1, keydown: 1, keyup: 1, touchstart: 1, touchend: 1 };

    EventTarget.prototype.addEventListener = function (type, handler, opts) {
      if (noisedTypes[type] && this === window) {
        var origHandler = handler;
        handler = function (event) {
          var jitter = Math.random() * 80 + 10;
          setTimeout(function () { origHandler.call(this, event); }.bind(this), jitter);
        };
      }
      return origAddEventListener.call(this, type, handler, opts);
    };
  } catch (e) {}

  // Periodically inject fake mouse events with high variance to poison the detector
  try {
    setInterval(function () {
      var duration = Math.random() * 400 + 50;
      var target = document.querySelector('.header_zone') || document.body;
      var cx = Math.random() * window.innerWidth;
      var cy = Math.random() * window.innerHeight;
      target.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0
      }));
      setTimeout(function () {
        target.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0
        }));
      }, duration);
    }, 3000 + Math.random() * 5000);
  } catch (e) {}

  // ── 1a. Bypass DevTools detection (Worker heartbeat) ──
  var OriginalWorker = window.Worker;

  window.Worker = function (url, options) {
    var worker = new OriginalWorker(url, options);
    var origPostMessage = worker.postMessage.bind(worker);
    var fakeListeners = [];

    var origWAEL = worker.addEventListener.bind(worker);
    worker.addEventListener = function (type, handler, opts) {
      if (type === 'message') fakeListeners.push(handler);
      return origWAEL(type, handler, opts);
    };

    worker.postMessage = function (data) {
      if (data && typeof data === 'object' && 'moreDebugs' in data) {
        var dispatchFake = function (rd) {
          var evt = { data: rd };
          if (worker.onmessage) worker.onmessage(evt);
          fakeListeners.forEach(function (fn) { fn(evt); });
        };
        setTimeout(function () {
          dispatchFake({ isOpenBeat: true });
          setTimeout(function () { dispatchFake({ isOpenBeat: false }); }, 1);
        }, 5);
        return;
      }
      return origPostMessage(data);
    };
    return worker;
  };
  Object.setPrototypeOf(window.Worker, OriginalWorker);
  Object.setPrototypeOf(window.Worker.prototype, OriginalWorker.prototype);

  // ── 1b. Bypass geolocation permission check ──
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (desc) {
        if (desc && desc.name === 'geolocation')
          return Promise.resolve({ state: 'prompt', name: 'geolocation', onchange: null });
        return origQuery(desc);
      };
    }
  } catch (e) {}

  // ── 1c. Block redirect to /invalidUse ──
  var blockedPatterns = ['invalidUse', 'invalidMobileUse', 'abnormal', 'blocked', 'restrict'];
  function isBlocked(url) {
    if (typeof url !== 'string') return false;
    for (var i = 0; i < blockedPatterns.length; i++) {
      if (url.indexOf(blockedPatterns[i]) !== -1) return true;
    }
    return false;
  }

  try {
    var oReplace = Object.getOwnPropertyDescriptor(Location.prototype, 'replace');
    if (oReplace && oReplace.value) {
      Location.prototype.replace = function (url) {
        if (isBlocked(url)) return;
        return oReplace.value.call(this, url);
      };
    }
  } catch (e) {}
  try {
    var oAssign = Object.getOwnPropertyDescriptor(Location.prototype, 'assign');
    if (oAssign && oAssign.value) {
      Location.prototype.assign = function (url) {
        if (isBlocked(url)) return;
        return oAssign.value.call(this, url);
      };
    }
  } catch (e) {}
  try {
    var oHref = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (oHref && oHref.set) {
      var origSet = oHref.set;
      Object.defineProperty(Location.prototype, 'href', {
        get: oHref.get,
        set: function (url) { if (isBlocked(url)) return; return origSet.call(this, url); },
        configurable: true, enumerable: true
      });
    }
  } catch (e) {}

  // ── 1d. Suppress "비정상적인 접근" alerts ──
  try {
    var origAlert = window.alert;
    window.alert = function (msg) {
      if (typeof msg === 'string' && (
        msg.indexOf('비정상') !== -1 || msg.indexOf('abnormal') !== -1 ||
        msg.indexOf('이용을 중단') !== -1 || msg.indexOf('접근이 차단') !== -1
      )) {
        window.postMessage({
          source: 'KYOBO_INJECT', type: 'ABNORMAL_BLOCKED',
          data: { message: msg, timestamp: Date.now() }
        }, ALLOWED_ORIGIN);
        return;
      }
      return origAlert.call(window, msg);
    };
  } catch (e) {}

  // ── 2. Remove watermarks ──
  function removeWatermarks() {
    document.querySelectorAll('[data-id="wmk"], .watermark, .ball').forEach(function (el) {
      el.style.display = 'none';
      el.style.visibility = 'hidden';
      el.style.opacity = '0';
    });
  }

  // ── 3. Find content canvas ──
  function findCanvas() {
    var c = document.querySelector('.canvasLayer canvas');
    if (c) return c;
    var pages = document.querySelectorAll('.pdfPage[pdf-load="true"]');
    for (var i = 0; i < pages.length; i++) {
      c = pages[i].querySelector('.canvasLayer canvas');
      if (c) return c;
    }
    return document.querySelector('#content canvas, .mid_zone canvas');
  }

  // ── 4. Page info ──
  function getPageInfo() {
    var info = { current: 0, total: 0, title: '' };
    var el = document.querySelector('[data-page="pageInfo"], .range_current');
    if (el) {
      var parts = el.textContent.trim().split('/');
      if (parts.length === 2) {
        info.current = parseInt(parts[0], 10) || 0;
        info.total = parseInt(parts[1], 10) || 0;
      }
    }
    var t = document.querySelector('[data-layout="title"]');
    if (t) info.title = t.textContent.trim();
    return info;
  }

  function getTOC() {
    var items = [];
    document.querySelectorAll('[id^="pdfList_"]').forEach(function (el) {
      try {
        var pn = el.querySelector('.lbook_spnum');
        var ti = el.querySelector('.lbook_sdep_in');
        var dep = el.querySelector('.lbook_sdep');
        if (!pn || !ti) return;
        var depth = 1;
        if (dep) {
          var cls = dep.className;
          if (cls.indexOf('dep3') !== -1) depth = 3;
          else if (cls.indexOf('dep2') !== -1) depth = 2;
        }
        items.push({ page: parseInt(pn.textContent.trim(), 10) || 0, title: ti.textContent.trim(), depth: depth });
      } catch (e) {}
    });
    return items;
  }

  // ── 5. Navigation ──
  function navigateViaAPI(forward) {
    try {
      if (window.chkPdf && window.chkPdf.Navi && typeof window.chkPdf.Navi.GotoPage === 'function') {
        window.chkPdf.Navi.GotoPage(forward); return true;
      }
    } catch (e) {}
    try {
      if (window.KYService && window.KYService.Navi) {
        if (forward && typeof window.KYService.Navi.nextPage === 'function') { window.KYService.Navi.nextPage(); return true; }
        if (!forward && typeof window.KYService.Navi.prevPage === 'function') { window.KYService.Navi.prevPage(); return true; }
      }
    } catch (e) {}
    return false;
  }

  function dispatchMouseDown(el) {
    var od = el.style.display, ov = el.style.visibility, oo = el.style.opacity;
    el.style.display = 'block'; el.style.visibility = 'visible'; el.style.opacity = '1';
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (r.width === 0 || r.height === 0) { cx = window.innerWidth / 2; cy = window.innerHeight / 2; }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
    el.style.display = od; el.style.visibility = ov; el.style.opacity = oo;
  }

  function clickNextPage() {
    if (navigateViaAPI(true)) return true;
    var btn = document.querySelector('a[data-navi="right"]');
    if (btn) { dispatchMouseDown(btn); return true; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true }));
    return false;
  }

  function clickPrevPage() {
    if (navigateViaAPI(false)) return true;
    var btn = document.querySelector('a[data-navi="left"]');
    if (btn) { dispatchMouseDown(btn); return true; }
    return false;
  }

  function goToPage(pageNum) {
    try {
      if (window.chkPdf && window.chkPdf.Navi && typeof window.chkPdf.Navi.goPage === 'function') {
        window.chkPdf.Navi.goPage(pageNum); return true;
      }
    } catch (e) {}
    try {
      var el = document.querySelector('.range_current[data-page="pageInfo"]');
      if (el) {
        el.click();
        var input = document.querySelector('.range_input input, input.page_input, input[data-page]');
        if (input) {
          input.value = pageNum;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // ── 6. IndexedDB Cache ──
  var DB_NAME = 'kyobo_ebook_cache';
  var DB_VERSION = 1;

  function getBookId() { return location.pathname + location.search; }

  function openCacheDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('pages')) {
          var s = db.createObjectStore('pages', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId', { unique: false });
        }
        if (!db.objectStoreNames.contains('books'))
          db.createObjectStore('books', { keyPath: 'bookId' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function cachePageData(bookId, pageNum, dataURL, w, h) {
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('pages', 'readwrite');
        tx.objectStore('pages').put({ id: bookId + '_' + pageNum, bookId: bookId, pageNum: pageNum, dataURL: dataURL, width: w, height: h, timestamp: Date.now() });
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function updateBookMeta(bookId, title, totalPages, toc) {
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('books', 'readwrite');
        tx.objectStore('books').put({ bookId: bookId, title: title, totalPages: totalPages, toc: toc || [], timestamp: Date.now() });
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function getCachedPages(bookId) {
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('pages', 'readonly');
        var req = tx.objectStore('pages').index('bookId').getAll(bookId);
        req.onsuccess = function () {
          db.close();
          var pages = req.result || [];
          pages.sort(function (a, b) { return a.pageNum - b.pageNum; });
          resolve(pages);
        };
        req.onerror = function () { db.close(); reject(req.error); };
      });
    });
  }

  function getBookMeta(bookId) {
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('books', 'readonly');
        var req = tx.objectStore('books').get(bookId);
        req.onsuccess = function () { db.close(); resolve(req.result || null); };
        req.onerror = function () { db.close(); reject(req.error); };
      });
    });
  }

  function clearBookCache(bookId) {
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(['pages', 'books'], 'readwrite');
        var cur = tx.objectStore('pages').index('bookId').openCursor(bookId);
        cur.onsuccess = function (e) { var c = e.target.result; if (c) { c.delete(); c.continue(); } };
        tx.objectStore('books').delete(bookId);
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function buildPDFFromCacheData(extURL, bookId, title, toc, targetSize) {
    return loadJsPDF(extURL).then(function () {
      return getCachedPages(bookId);
    }).then(function (pages) {
      if (!pages || pages.length === 0) throw new Error('캐시된 페이지 없음');
      var f = pages[0];
      var dims0 = calcPageDims(f.width, f.height, targetSize || null);
      var pdf = new window.jspdf.jsPDF({ orientation: dims0.pageW > dims0.pageH ? 'landscape' : 'portrait', unit: 'mm', format: [dims0.pageW, dims0.pageH] });
      for (var i = 0; i < pages.length; i++) {
        var p = pages[i];
        var d = calcPageDims(p.width, p.height, targetSize || null);
        if (i > 0) pdf.addPage([d.pageW, d.pageH], d.pageW > d.pageH ? 'landscape' : 'portrait');
        pdf.addImage(p.dataURL, 'JPEG', d.x, d.y, d.imgW, d.imgH);
      }
      if (toc && toc.length > 0 && pdf.outline) {
        try {
          var fp = pages[0].pageNum, lp = pages[pages.length - 1].pageNum;
          toc.forEach(function (item) {
            if (item.page >= fp && item.page <= lp) {
              for (var j = 0; j < pages.length; j++) {
                if (pages[j].pageNum >= item.page) { pdf.outline.add(null, item.title, { pageNumber: j + 1 }); break; }
              }
            }
          });
        } catch (e) {}
      }
      var safe = (title || 'ebook').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200);
      pdf.save((safe || 'ebook') + '.pdf');
      return pages.length;
    });
  }

  // ── 7. PDF building ──
  var pdfTargetSize = null; // null=original, or {w:mm, h:mm}

  function calcPageDims(pxW, pxH, target) {
    var mmW = (pxW / 96) * 25.4, mmH = (pxH / 96) * 25.4;
    if (!target) return { pageW: mmW, pageH: mmH, imgW: mmW, imgH: mmH, x: 0, y: 0 };
    var imgAR = pxW / pxH;
    var tw = target.w, th = target.h;
    if (imgAR > 1) { tw = Math.max(target.w, target.h); th = Math.min(target.w, target.h); }
    else { tw = Math.min(target.w, target.h); th = Math.max(target.w, target.h); }
    var scale = Math.min(tw / mmW, th / mmH);
    var sw = mmW * scale, sh = mmH * scale;
    return { pageW: tw, pageH: th, imgW: sw, imgH: sh, x: (tw - sw) / 2, y: (th - sh) / 2 };
  }

  function loadJsPDF(extURL) {
    return new Promise(function (resolve, reject) {
      if (window.jspdf) { resolve(); return; }
      if (!extURL || extURL.indexOf('chrome-extension://') !== 0) { reject(new Error('Invalid URL')); return; }
      var s = document.createElement('script');
      s.src = extURL + 'lib/jspdf.umd.min.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('jsPDF load failed')); };
      document.head.appendChild(s);
    });
  }

  function initPDF(extURL, targetSize) {
    return loadJsPDF(extURL).then(function () {
      var c = findCanvas();
      if (!c) throw new Error('Canvas not found');
      pdfTargetSize = targetSize || null;
      var dims = calcPageDims(c.width, c.height, pdfTargetSize);
      pdfDocument = new window.jspdf.jsPDF({ orientation: dims.pageW > dims.pageH ? 'landscape' : 'portrait', unit: 'mm', format: [dims.pageW, dims.pageH] });
      pdfDims = dims;
      capturedCount = 0;
      capturedPageMeta = [];
      return true;
    });
  }

  function captureAndAddToPDF(pageNum) {
    var c = findCanvas();
    if (!c || !pdfDocument) return false;
    removeWatermarks();
    try {
      var dataURL = c.toDataURL('image/jpeg', 0.92);
      var dims = calcPageDims(c.width, c.height, pdfTargetSize);
      if (capturedCount > 0) pdfDocument.addPage([dims.pageW, dims.pageH], dims.pageW > dims.pageH ? 'landscape' : 'portrait');
      pdfDocument.addImage(dataURL, 'JPEG', dims.x, dims.y, dims.imgW, dims.imgH);
      capturedPageMeta.push({ page: pageNum, width: c.width, height: c.height });
      capturedCount++;
      cachePageData(getBookId(), pageNum, dataURL, c.width, c.height).catch(function () {});
      return { ok: true, dataURL: dataURL, width: c.width, height: c.height, pageNum: pageNum, bookId: getBookId() };
    } catch (e) { return false; }
  }

  function finalizePDF(title, toc) {
    if (!pdfDocument || capturedCount === 0) throw new Error('No pages');
    if (toc && toc.length > 0 && capturedPageMeta.length > 0 && pdfDocument.outline) {
      try {
        var fp = capturedPageMeta[0].page, lp = capturedPageMeta[capturedPageMeta.length - 1].page;
        toc.forEach(function (item) {
          if (item.page >= fp && item.page <= lp) {
            for (var j = 0; j < capturedPageMeta.length; j++) {
              if (capturedPageMeta[j].page >= item.page) { pdfDocument.outline.add(null, item.title, { pageNumber: j + 1 }); break; }
            }
          }
        });
      } catch (e) {}
    }
    var safe = (title || 'ebook').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200);
    pdfDocument.save((safe || 'ebook') + '.pdf');
    pdfDocument = null; pdfDims = null; capturedCount = 0; capturedPageMeta = [];
    return true;
  }

  function clearState() {
    pdfDocument = null; pdfDims = null; capturedCount = 0; capturedPageMeta = [];
  }

  // ── 8. Message handler ──
  window.addEventListener('message', function (event) {
    if (event.origin !== ALLOWED_ORIGIN || event.source !== window) return;
    if (!event.data || event.data.source !== 'KYOBO_CONTENT') return;

    var resp = { source: 'KYOBO_INJECT', id: event.data.id };
    var send = function () { window.postMessage(resp, ALLOWED_ORIGIN); };

    switch (event.data.action) {
      case 'getPageInfo': resp.data = getPageInfo(); send(); break;
      case 'getCanvasDimensions':
        var cv = findCanvas();
        resp.data = cv ? { width: cv.width, height: cv.height } : null; send(); break;
      case 'initPDF':
        initPDF(event.data.extensionBaseURL || '', event.data.targetSize || null).then(function () { resp.data = true; send(); }).catch(function (e) { resp.error = e.message; send(); }); break;
      case 'captureAndAddToPDF':
        resp.data = captureAndAddToPDF(event.data.pageNum || 0); send(); break;
      case 'capturePageOnly':
        var cpC = findCanvas();
        if (!cpC) { resp.error = 'Canvas not found'; send(); break; }
        removeWatermarks();
        try {
          var cpURL = cpC.toDataURL('image/jpeg', 0.92);
          var cpPN = event.data.pageNum || 0;
          cachePageData(getBookId(), cpPN, cpURL, cpC.width, cpC.height).catch(function () {});
          resp.data = { ok: true, dataURL: cpURL, width: cpC.width, height: cpC.height, pageNum: cpPN, bookId: getBookId() };
        } catch (cpE) { resp.error = cpE.message; }
        send(); break;
      case 'getCapturedCount': resp.data = capturedCount; send(); break;
      case 'clearState': clearState(); resp.data = true; send(); break;
      case 'getTOC': resp.data = getTOC(); send(); break;
      case 'nextPage': resp.data = clickNextPage(); send(); break;
      case 'prevPage': resp.data = clickPrevPage(); send(); break;
      case 'goToPage': resp.data = goToPage(event.data.pageNum); send(); break;
      case 'finalizePDF':
        try { resp.data = finalizePDF(event.data.title || 'ebook', event.data.toc || []); }
        catch (e) { resp.error = e.message; }
        send(); break;
      case 'getCacheInfo':
        var bid = getBookId();
        Promise.all([getBookMeta(bid), getCachedPages(bid)]).then(function (r) {
          resp.data = { bookId: bid, hasCachedPages: r[1].length > 0, cachedCount: r[1].length, cachedPageNums: r[1].map(function (p) { return p.pageNum; }), meta: r[0] };
          send();
        }).catch(function () { resp.data = { hasCachedPages: false, cachedCount: 0, cachedPageNums: [] }; send(); });
        break;
      case 'updateBookMeta':
        updateBookMeta(getBookId(), event.data.title || '', event.data.totalPages || 0, event.data.toc || [])
          .then(function () { resp.data = true; send(); }).catch(function (e) { resp.error = e.message; send(); });
        break;
      case 'buildPDFFromCache':
        buildPDFFromCacheData(event.data.extensionBaseURL || '', getBookId(), event.data.title || 'ebook', event.data.toc || [], event.data.targetSize || null)
          .then(function (n) { resp.data = { success: true, pageCount: n }; send(); }).catch(function (e) { resp.error = e.message; send(); });
        break;
      case 'clearCache':
        clearBookCache(getBookId()).then(function () { resp.data = true; send(); }).catch(function (e) { resp.error = e.message; send(); });
        break;
      case 'ping': resp.data = 'pong'; send(); break;
      default: resp.error = 'Unknown action'; send();
    }
  });

  // ── 9. Notify injection ──
  window.postMessage({ source: 'KYOBO_INJECT', type: 'INJECTED', data: { timestamp: Date.now() } }, ALLOWED_ORIGIN);

})();
