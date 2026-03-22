(function () {
  'use strict';

  // ============================================================
  // CAU Kyobo Ebook PDF Downloader - MAIN World Injection
  // Bypasses all detection layers, captures canvas, generates PDF
  // ============================================================

  // ── 0. High-resolution capture: Override devicePixelRatio ──
  // The viewer (PDF.js-based) reads window.devicePixelRatio to size its canvas.
  // canvas.width = CSS너비 × DPR → higher DPR = more pixels = sharper text/vectors.
  // Fixed at 4x for maximum resolution. Format/quality still configurable.
  var _nativeDPR = window.devicePixelRatio || 1;
  var _captureDPR = 4;
  var _captureFormat = 'image/png';
  var _captureQuality = 0.92;
  try {
    var storedFmt = localStorage.getItem('kyobo_ext_format');
    if (storedFmt === 'jpeg') {
      _captureFormat = 'image/jpeg';
    }
    var storedQ = localStorage.getItem('kyobo_ext_quality');
    if (storedQ !== null && storedQ !== '') {
      var pq = parseFloat(storedQ);
      if (pq > 0 && pq <= 1) _captureQuality = pq;
    }
  } catch (e) {}
  // Always override DPR via getter (PDF.js reads this on every render)
  Object.defineProperty(window, 'devicePixelRatio', {
    get: function () { return _captureDPR; },
    configurable: true
  });


  // Live update: format/quality only, DPR is fixed at 4x
  function _handleLiveDPRUpdate(newDPR, newFormat, newQuality) {
    // DPR ignored — always 4x
    if (newFormat) _captureFormat = newFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
    if (newQuality > 0 && newQuality <= 1) _captureQuality = newQuality;
  }

  var ALLOWED_ORIGIN = location.origin;

  // Incremental PDF building
  var pdfDocument = null;
  var pdfDims = null;
  var capturedCount = 0;
  var capturedPageMeta = [];

  // Stable book ID (title-based, survives URL changes across sessions)
  var resolvedBookId = null;

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
          var jitter = Math.random() * 400 + 20;
          setTimeout(function () { origHandler.call(this, event); }.bind(this), jitter);
        };
      }
      return origAddEventListener.call(this, type, handler, opts);
    };
  } catch (e) {}

  // Periodically inject fake interaction events to poison the bot detector.
  // The detector tracks mousedown/mouseup/keydown/keyup timing intervals on window.
  // If stddev of intervals is too low (< threshold after 40+ events) → bot flagged.
  // Strategy: dispatch events at highly varied intervals (2-12s) so stddev stays high.
  try {
    function _fakeInteraction() {
      var target = document.querySelector('.header_zone') || document.querySelector('[data-layout="header_zone"]') || document.body;
      var cx = Math.random() * window.innerWidth;
      var cy = 10 + Math.random() * 40; // stay in header area
      var roll = Math.random();
      if (roll < 0.4) {
        // Fake mousedown/mouseup pair on header (won't trigger page navigation)
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
        setTimeout(function () {
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
        }, 30 + Math.random() * 150);
      } else if (roll < 0.7) {
        // Fake keydown/keyup (safe keys that don't trigger viewer actions)
        var keys = ['Shift', 'Control', 'Alt', 'CapsLock', 'ScrollLock'];
        var key = keys[Math.floor(Math.random() * keys.length)];
        window.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: key + 'Left', bubbles: true, cancelable: true }));
        setTimeout(function () {
          window.dispatchEvent(new KeyboardEvent('keyup', { key: key, code: key + 'Left', bubbles: true, cancelable: true }));
        }, 50 + Math.random() * 200);
      } else {
        // mousemove for variety
        target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
      }
      // Schedule next at highly random interval (2-12s) for high stddev
      setTimeout(_fakeInteraction, 2000 + Math.random() * 10000);
    }
    // Start after page loads
    setTimeout(_fakeInteraction, 1000 + Math.random() * 3000);
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

  // ── 1e. Suppress beforeunload dialogs (prevents "Leave site?" on tab close) ──
  try {
    // Capture-phase listener fires first and stops all other handlers
    window.addEventListener('beforeunload', function (e) {
      e.stopImmediatePropagation();
      delete e.returnValue;
    }, true);
    // Block onbeforeunload property assignment
    Object.defineProperty(window, 'onbeforeunload', {
      get: function () { return null; },
      set: function () {},
      configurable: true
    });
    // Intercept addEventListener to silently drop beforeunload registrations
    var _origAEL = EventTarget.prototype.addEventListener;
    var _origREL = EventTarget.prototype.removeEventListener;
    var _blockedBU = [];
    EventTarget.prototype.addEventListener = function (type, handler, opts) {
      if (type === 'beforeunload' && this === window) {
        _blockedBU.push(handler);
        return;
      }
      return _origAEL.call(this, type, handler, opts);
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

  // ── 3. Canvas size locking ──
  // First large canvas sets the reference size. Subsequent canvas width/height
  // assignments within ±20px of reference are snapped to exact reference.
  // This makes PDF.js render into a fixed-size canvas regardless of sub-pixel
  // layout variance (fullscreen, scrollbar, etc). No post-capture resizing needed.
  var _refCanvasWidth = 0;
  var _refCanvasHeight = 0;

  var _origWidthDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  var _origHeightDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');

  Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
    set: function (v) {
      if (_refCanvasWidth > 0 && v > 100 && Math.abs(v - _refCanvasWidth) <= 20) {
        v = _refCanvasWidth;
      } else if (_refCanvasWidth === 0 && v > 1000) {
        _refCanvasWidth = v;
      }
      _origWidthDesc.set.call(this, v);
    },
    get: function () { return _origWidthDesc.get.call(this); },
    configurable: true
  });

  Object.defineProperty(HTMLCanvasElement.prototype, 'height', {
    set: function (v) {
      if (_refCanvasHeight > 0 && v > 100 && Math.abs(v - _refCanvasHeight) <= 20) {
        v = _refCanvasHeight;
      } else if (_refCanvasHeight === 0 && v > 1000) {
        _refCanvasHeight = v;
      }
      _origHeightDesc.set.call(this, v);
    },
    get: function () { return _origHeightDesc.get.call(this); },
    configurable: true
  });

  // ── 3b. Find content canvas ──
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

  // Find all rendered canvases with actual content (not blank)
  function findAllCanvases() {
    var result = [];
    var pages = document.querySelectorAll('.pdfPage[pdf-load="true"]');
    for (var i = 0; i < pages.length; i++) {
      var c = pages[i].querySelector('.canvasLayer canvas');
      if (!c) c = pages[i].querySelector('canvas');
      if (c && c.width > 0 && c.height > 0) {
        // Verify canvas has actual content by sampling pixels
        if (isCanvasBlank(c)) continue;
        var idMatch = pages[i].id.match(/pdfPage_(\d+)/);
        var pageNum = idMatch ? parseInt(idMatch[1], 10) : 0;
        result.push({ canvas: c, pageNum: pageNum });
      }
    }
    result.sort(function (a, b) { return a.pageNum - b.pageNum; });
    return result;
  }

  // Quick check: sample 5 points — if all same color (white, black, or transparent), it's blank/unrendered
  function isCanvasBlank(canvas) {
    try {
      var ctx = canvas.getContext('2d');
      var w = canvas.width, h = canvas.height;
      var points = [
        [Math.floor(w * 0.25), Math.floor(h * 0.25)],
        [Math.floor(w * 0.5), Math.floor(h * 0.5)],
        [Math.floor(w * 0.75), Math.floor(h * 0.75)],
        [Math.floor(w * 0.5), Math.floor(h * 0.25)],
        [Math.floor(w * 0.25), Math.floor(h * 0.75)]
      ];
      for (var i = 0; i < points.length; i++) {
        var px = ctx.getImageData(points[i][0], points[i][1], 1, 1).data;
        if (px[3] === 0) continue; // transparent
        var isWhite = px[0] >= 250 && px[1] >= 250 && px[2] >= 250;
        var isBlack = px[0] <= 5 && px[1] <= 5 && px[2] <= 5;
        if (!isWhite && !isBlack) return false; // has actual content
      }
      return true;
    } catch (e) { return true; }
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

    // Strategy 1: PDF viewer outline (nested <li> with .depth2 containers)
    var outlineContainer = document.querySelector('#outlineView, .treeView, [class*="outline"]');
    if (outlineContainer) {
      var lis = outlineContainer.querySelectorAll('li');
      lis.forEach(function (li) {
        // Skip container-only <li> elements (they only hold children)
        var hasDirectText = false;
        var titleEl = li.querySelector('.chapter, a, span');
        var pageEl = li.querySelector('.percent, .page');
        if (!titleEl && !pageEl) {
          // Check if li itself has meaningful text (not just child containers)
          var text = '';
          for (var n = 0; n < li.childNodes.length; n++) {
            if (li.childNodes[n].nodeType === 3) text += li.childNodes[n].textContent.trim();
          }
          if (!text) return;
        }

        var title = titleEl ? titleEl.textContent.trim() : li.textContent.trim();
        var pageNum = 0;
        if (pageEl) pageNum = parseInt(pageEl.textContent.trim(), 10) || 0;

        // Skip if no title or it's a container class only
        if (!title || li.className === 'depth2') return;

        // Detect depth by counting .depth2 ancestors
        var depth = 1;
        var parent = li.parentElement;
        while (parent && parent !== outlineContainer) {
          if (parent.classList && parent.classList.contains('depth2')) depth++;
          parent = parent.parentElement;
        }

        items.push({ page: pageNum, title: title, depth: depth });
      });
    }

    // Strategy 2: lbook_sdep with depN classes (flat <li> list, depth via class)
    if (items.length === 0) {
      var els = document.querySelectorAll('[id^="pdfList_"]');
      if (els.length === 0) els = document.querySelectorAll('.lbook_sphitem');

      els.forEach(function (el) {
        try {
          var pn = el.querySelector('.lbook_spnum');
          var ti = el.querySelector('.lbook_sdep_in');
          if (!pn || !ti) return;

          var depth = 1;
          var depEl = el.querySelector('.lbook_sdep') || el;
          var cls = (depEl.className || '') + ' ' + (el.className || '');
          // Match dep1, dep2, dep3, dep4, dep5, etc.
          var depMatch = cls.match(/\bdep(\d+)\b/);
          if (depMatch) depth = parseInt(depMatch[1], 10) || 1;

          items.push({ page: parseInt(pn.textContent.trim(), 10) || 0, title: ti.textContent.trim(), depth: depth });
        } catch (e) {}
      });
    }

    // Fallback: infer depth from title patterns
    if (items.length > 0 && items.every(function (it) { return it.depth === 1; })) {
      var hasChapter = items.some(function (it) { return /^(CHAPTER|PART|챕터|파트)\s/i.test(it.title); });
      if (hasChapter) {
        var underChapter = false;
        for (var i = 0; i < items.length; i++) {
          var t = items[i].title;
          if (/^(CHAPTER|PART|챕터|파트)\s/i.test(t)) {
            items[i].depth = 1;
            underChapter = true;
          } else if (underChapter) {
            items[i].depth = 2;
          }
        }
      }
    }

    return items;
  }

  // ── 5. Navigation (API-based, no arrow keys) ──

  // Read the viewer's page indicator (authoritative page number)
  function getViewerPageNum() {
    var el = document.querySelector('[data-page="pageInfo"], .range_current');
    if (el) {
      var parts = el.textContent.trim().split('/');
      if (parts.length === 2) return parseInt(parts[0], 10) || 0;
    }
    return 0;
  }

  function navigateViaAPI(forward) {
    try {
      var navi = window.chkPdf && window.chkPdf.Navi;
      if (navi) {
        if (forward && typeof navi.nextPage === 'function') { navi.nextPage(); return true; }
        if (!forward && typeof navi.prevPage === 'function') { navi.prevPage(); return true; }
        if (typeof navi.GotoPage === 'function') { navi.GotoPage(forward); return true; }
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

  // Async mouse click: delay > 20ms between down/up to avoid bot detector
  // (detector only tracks events with duration ≤ 20ms)
  function dispatchMouseDown(el) {
    return new Promise(function (resolve) {
      var od = el.style.display, ov = el.style.visibility, oo = el.style.opacity;
      el.style.display = 'block'; el.style.visibility = 'visible'; el.style.opacity = '1';
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (r.width === 0 || r.height === 0) { cx = window.innerWidth / 2; cy = window.innerHeight / 2; }
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
      // Delay 40-120ms so duration > 20ms threshold
      setTimeout(function () {
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
        el.style.display = od; el.style.visibility = ov; el.style.opacity = oo;
        resolve();
      }, 40 + Math.random() * 80);
    });
  }

  // Manual prev/next (API + UI button only, no arrow keys)
  function clickNextPage() {
    if (navigateViaAPI(true)) return Promise.resolve(true);
    var btn = document.querySelector('a[data-navi="right"]');
    if (btn) return dispatchMouseDown(btn).then(function () { return true; });
    return Promise.resolve(false);
  }

  function clickPrevPage() {
    if (navigateViaAPI(false)) return Promise.resolve(true);
    var btn = document.querySelector('a[data-navi="left"]');
    if (btn) return dispatchMouseDown(btn).then(function () { return true; });
    return Promise.resolve(false);
  }

  // Direct page jump (primary navigation for capture)
  function goToPage(pageNum) {
    // 1. Slider bar manipulation (most reliable — always works)
    var slider = findSlider();
    if (slider) {
      return setSliderToPage(slider, pageNum, getTotalPages());
    }

    // 2. moveToPage API (pdf.engine.js) — fallback
    try {
      if (window.chkPdf && window.chkPdf.Navi && typeof window.chkPdf.Navi.moveToPage === 'function') {
        window.chkPdf.Navi.moveToPage(pageNum);
        return Promise.resolve(true);
      }
    } catch (e) {}

    // 3. goPage fallback (older viewer)
    try {
      if (window.chkPdf && window.chkPdf.Navi && typeof window.chkPdf.Navi.goPage === 'function') {
        window.chkPdf.Navi.goPage(pageNum);
        return Promise.resolve(true);
      }
    } catch (e) {}

    // 4. KYService API
    try {
      if (window.KYService && window.KYService.Navi && typeof window.KYService.Navi.moveToPage === 'function') {
        window.KYService.Navi.moveToPage(pageNum);
        return Promise.resolve(true);
      }
    } catch (e) {}

    // 5. UI input fallback
    var totalPages = getTotalPages();
    if (totalPages > 0) {
      var slider = findSlider();
      if (slider) {
        return setSliderToPage(slider, pageNum, totalPages);
      }
    }

    // 5. UI input fallback (show header → type page → enter)
    return new Promise(function (resolve) {
      // Show header/footer to expose controls
      var header = document.querySelector('.header_zone, [data-layout="header_zone"]');
      if (header) header.classList.remove('hide');
      var footer = document.querySelector('.footer_zone, [data-layout="footer_zone"], .bottom_zone');
      if (footer) footer.classList.remove('hide');

      var viewer = document.querySelector('[data-layout="viewer"]') || document.querySelector('.mid_zone');
      if (viewer) {
        var r = viewer.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        viewer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
        setTimeout(function () {
          viewer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
        }, 40 + Math.random() * 60);
      }

      // After header/footer revealed, try slider again
      setTimeout(function () {
        var slider2 = findSlider();
        if (slider2) {
          setSliderToPage(slider2, pageNum, totalPages || getTotalPages()).then(resolve);
          return;
        }

        // Text input fallback
        var el = document.querySelector('.range_current[data-page="pageInfo"]');
        if (!el) { resolve(false); return; }
        dispatchMouseDown(el).then(function () { el.click(); });

        setTimeout(function () {
          var input = document.querySelector('.range_input input, input.page_input, input[data-page]');
          if (!input) { resolve(false); return; }
          input.focus();
          input.value = pageNum;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          setTimeout(function () {
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            resolve(true);
          }, 40 + Math.random() * 80);
        }, 500);
      }, 600);
    });
  }

  function getTotalPages() {
    var el = document.querySelector('[data-page="pageInfo"], .range_current');
    if (el) {
      var parts = el.textContent.trim().split('/');
      if (parts.length === 2) return parseInt(parts[1], 10) || 0;
    }
    return 0;
  }

  function findSlider() {
    // Kyobo viewer: input[data-layout="rangeslider"] with class "bcrange"
    var primary = document.querySelector('input[data-layout="rangeslider"].bcrange');
    if (primary) return primary;
    // Fallback: any range input in bottom control zone (even if hidden)
    var bottom = document.querySelector('.bottomcontrol_zone input[type="range"]');
    if (bottom) return bottom;
    // data-layout rangeslider without bcrange class
    var dataLayout = document.querySelector('input[data-layout="rangeslider"]');
    if (dataLayout) return dataLayout;
    // Generic fallback — any range input
    var all = document.querySelectorAll('input[type="range"]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].max > 10) return all[i]; // likely page slider, not opacity/volume
    }
    return null;
  }

  function setSliderToPage(slider, pageNum, totalPages) {
    return new Promise(function (resolve) {
      var min = parseFloat(slider.min) || 1;
      var max = parseFloat(slider.max) || totalPages;
      var val = Math.max(min, Math.min(max, pageNum));

      // Method 1: jQuery rangeslider plugin — most reliable
      try {
        if (window.$ && window.$(slider).data('plugin_rangeslider')) {
          window.$(slider).val(val).change();
          resolve(true);
          return;
        }
      } catch (e) {}

      // Method 2: jQuery without plugin data check
      try {
        if (window.$) {
          window.$(slider).val(val).trigger('input').trigger('change');
          resolve(true);
          return;
        }
      } catch (e) {}

      // Method 3: Native setter + events
      try {
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(slider, val);
      } catch (e) {
        slider.value = val;
      }
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      resolve(true);
    });
  }

  // ── 5b. ZIP building from cache ──
  function loadJsZip(extURL) {
    return new Promise(function (resolve, reject) {
      if (window.JSZip) { resolve(); return; }
      if (!extURL || extURL.indexOf('chrome-extension://') !== 0) { reject(new Error('Invalid URL')); return; }
      var s = document.createElement('script');
      s.src = extURL + 'lib/jszip.min.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('JSZip load failed')); };
      document.head.appendChild(s);
    });
  }

  function buildZIPFromCacheData(extURL, bookId, title) {
    return loadJsZip(extURL).then(function () {
      return getCachedPages(bookId);
    }).then(function (pages) {
      if (!pages || pages.length === 0) throw new Error('캐시된 페이지 없음');
      var zip = new window.JSZip();
      var safe = (title || 'ebook').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 100) || 'ebook';
      for (var i = 0; i < pages.length; i++) {
        var p = pages[i];
        if (!p.dataURL) continue;
        var parts = p.dataURL.split(',');
        var binary = atob(parts[1]);
        var arr = new Uint8Array(binary.length);
        for (var j = 0; j < binary.length; j++) arr[j] = binary.charCodeAt(j);
        var ext = parts[0].indexOf('png') !== -1 ? 'png' : 'jpg';
        var padded = String(p.pageNum).padStart(4, '0');
        zip.file(safe + '_' + padded + '.' + ext, arr);
      }
      return zip.generateAsync({ type: 'blob' });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      var safeName = (title || 'ebook').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 100) || 'ebook';
      a.download = safeName + '_images.zip';
      a.click();
      URL.revokeObjectURL(url);
      return true;
    });
  }

  // ── 6. IndexedDB Cache ──
  var DB_NAME = 'kyobo_ebook_cache';
  var DB_VERSION = 1;

  function getBookId() { return resolvedBookId || location.pathname + location.search; }

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

  // Find bookId by title in the books store (for cache migration)
  function findBookIdByTitle(title) {
    if (!title) return Promise.resolve(null);
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('books', 'readonly');
        var req = tx.objectStore('books').getAll();
        req.onsuccess = function () {
          db.close();
          var books = req.result || [];
          for (var i = 0; i < books.length; i++) {
            if (books[i].title === title) { resolve(books[i].bookId); return; }
          }
          resolve(null);
        };
        req.onerror = function () { db.close(); resolve(null); };
      });
    });
  }

  // Migrate cache from one bookId to another (when URL changes but same book)
  function migrateBookCache(oldBookId, newBookId) {
    if (oldBookId === newBookId) return Promise.resolve();
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(['pages', 'books'], 'readwrite');
        var pagesStore = tx.objectStore('pages');
        var booksStore = tx.objectStore('books');

        var metaReq = booksStore.get(oldBookId);
        metaReq.onsuccess = function () {
          if (metaReq.result) {
            var m = metaReq.result;
            booksStore.put({ bookId: newBookId, title: m.title, totalPages: m.totalPages, toc: m.toc || [], timestamp: m.timestamp });
            booksStore.delete(oldBookId);
          }
        };

        var cur = pagesStore.index('bookId').openCursor(oldBookId);
        cur.onsuccess = function (e) {
          var c = e.target.result;
          if (c) {
            var pg = c.value;
            pagesStore.put({ id: newBookId + '_' + pg.pageNum, bookId: newBookId, pageNum: pg.pageNum, dataURL: pg.dataURL, width: pg.width, height: pg.height, timestamp: pg.timestamp });
            pagesStore.delete(c.primaryKey);
            c.continue();
          }
        };

        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  // Check if a specific page exists in cache
  function isPageCached(bookId, pageNum) {
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('pages', 'readonly');
        var req = tx.objectStore('pages').get(bookId + '_' + pageNum);
        req.onsuccess = function () { db.close(); resolve(!!req.result); };
        req.onerror = function () { db.close(); resolve(false); };
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
    if (!c) return { ok: false, error: 'canvas_not_found' };
    if (!pdfDocument) return { ok: false, error: 'pdf_not_initialized' };
    if (c.width === 0 || c.height === 0) return { ok: false, error: 'canvas_empty' };
    removeWatermarks();
    try {
      var dataURL = (_captureFormat === 'image/jpeg')
        ? c.toDataURL('image/jpeg', _captureQuality)
        : c.toDataURL('image/png');
      if (!dataURL || dataURL.length < 1000) return { ok: false, error: 'canvas_blank' };
      var dims = calcPageDims(c.width, c.height, pdfTargetSize);
      if (capturedCount > 0) pdfDocument.addPage([dims.pageW, dims.pageH], dims.pageW > dims.pageH ? 'landscape' : 'portrait');
      pdfDocument.addImage(dataURL, 'JPEG', dims.x, dims.y, dims.imgW, dims.imgH);
      capturedPageMeta.push({ page: pageNum, width: c.width, height: c.height });
      capturedCount++;
      cachePageData(getBookId(), pageNum, dataURL, c.width, c.height).catch(function (e) {
        console.error('[Cache] captureAndAddToPDF write failed:', pageNum, e);
      });
      return { ok: true, dataURL: dataURL, width: c.width, height: c.height, pageNum: pageNum, bookId: getBookId() };
    } catch (e) { return { ok: false, error: 'capture_exception: ' + e.message }; }
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
    _refCanvasWidth = 0; _refCanvasHeight = 0;
  }

  // ── 7b. Capture helpers (extracted from message handler) ──

  function capturePageOnly(pageNum) {
    var canvas = findCanvas();
    if (!canvas) return Promise.reject(new Error('Canvas not found'));
    if (canvas.width === 0 || canvas.height === 0) return Promise.resolve({ ok: false, error: 'canvas_empty' });
    removeWatermarks();
    try {
      var dataURL = (_captureFormat === 'image/jpeg')
        ? canvas.toDataURL('image/jpeg', _captureQuality)
        : canvas.toDataURL('image/png');
      if (!dataURL || dataURL.length < 1000) return Promise.resolve({ ok: false, error: 'canvas_blank' });
      var bid = getBookId();
      return cachePageData(bid, pageNum, dataURL, canvas.width, canvas.height).then(function () {
        return { ok: true, dataURL: dataURL, width: canvas.width, height: canvas.height, pageNum: pageNum, bookId: bid, cached: true };
      }).catch(function () {
        return { ok: true, dataURL: dataURL, width: canvas.width, height: canvas.height, pageNum: pageNum, bookId: bid, cached: false };
      });
    } catch (e) { return Promise.reject(e); }
  }

  function captureBothPages() {
    removeWatermarks();
    var canvases = findAllCanvases();
    if (canvases.length === 0) return Promise.resolve([]);
    var bid = getBookId();
    var promises = canvases.map(function (bc) {
      try {
        var url = (_captureFormat === 'image/jpeg')
          ? bc.canvas.toDataURL('image/jpeg', _captureQuality)
          : bc.canvas.toDataURL('image/png');
        if (!url || url.length < 1000) return Promise.resolve({ ok: false, error: 'canvas_blank', pageNum: bc.pageNum });
        return cachePageData(bid, bc.pageNum, url, bc.canvas.width, bc.canvas.height).then(function () {
          return { ok: true, dataURL: url, width: bc.canvas.width, height: bc.canvas.height, pageNum: bc.pageNum, bookId: bid, cached: true };
        }).catch(function () {
          return { ok: true, dataURL: url, width: bc.canvas.width, height: bc.canvas.height, pageNum: bc.pageNum, bookId: bid, cached: false };
        });
      } catch (e) {
        return Promise.resolve({ ok: false, error: e.message, pageNum: bc.pageNum });
      }
    });
    return Promise.all(promises);
  }

  function getCacheInfoForCurrentBook() {
    var bid = getBookId();
    return Promise.all([getBookMeta(bid), getCachedPages(bid)]).then(function (r) {
      if (r[1].length > 0) {
        return { bookId: bid, hasCachedPages: true, cachedCount: r[1].length, cachedPageNums: r[1].map(function (p) { return p.pageNum; }), meta: r[0] };
      }
      var title = getPageInfo().title;
      if (!title) return { bookId: bid, hasCachedPages: false, cachedCount: 0, cachedPageNums: [] };
      var titleId = 'title:' + title;
      var tryIds = titleId !== bid ? [titleId] : [];
      return findBookIdByTitle(title).then(function (foundId) {
        if (foundId && foundId !== bid && tryIds.indexOf(foundId) === -1) tryIds.push(foundId);
        return (function tryNext(idx) {
          if (idx >= tryIds.length) return { bookId: bid, hasCachedPages: false, cachedCount: 0, cachedPageNums: [] };
          var altId = tryIds[idx];
          return getCachedPages(altId).then(function (altPages) {
            if (altPages.length > 0) {
              return migrateBookCache(altId, bid).then(function () {
                return Promise.all([getBookMeta(bid), getCachedPages(bid)]);
              }).then(function (r2) {
                return { bookId: bid, hasCachedPages: true, cachedCount: r2[1].length, cachedPageNums: r2[1].map(function (p) { return p.pageNum; }), meta: r2[0], migrated: true };
              }).catch(function () {
                return { bookId: altId, hasCachedPages: true, cachedCount: altPages.length, cachedPageNums: altPages.map(function (p) { return p.pageNum; }), meta: null };
              });
            }
            return tryNext(idx + 1);
          }).catch(function () { return tryNext(idx + 1); });
        })(0);
      }).catch(function () {
        return { bookId: bid, hasCachedPages: false, cachedCount: 0, cachedPageNums: [] };
      });
    }).catch(function () { return { hasCachedPages: false, cachedCount: 0, cachedPageNums: [] }; });
  }

  function resolveBookIdFromTitle(title) {
    if (!title) return Promise.resolve(getBookId());
    var stableId = 'title:' + title;
    return getCachedPages(stableId).then(function (stablePages) {
      if (stablePages.length > 0) { resolvedBookId = stableId; return stableId; }
      var urlId = location.pathname + location.search;
      return getCachedPages(urlId).then(function (urlPages) {
        if (urlPages.length > 0 && urlId !== stableId) {
          return migrateBookCache(urlId, stableId).then(function () { resolvedBookId = stableId; return stableId; });
        }
        return findBookIdByTitle(title).then(function (foundId) {
          if (foundId && foundId !== stableId) {
            return migrateBookCache(foundId, stableId).then(function () { resolvedBookId = stableId; return stableId; });
          }
          resolvedBookId = stableId;
          return stableId;
        });
      });
    }).catch(function () { resolvedBookId = stableId; return stableId; });
  }

  function findBlankPagesInRange(startPage, endPage) {
    return getCachedPages(getBookId()).then(function (allPages) {
      var blanks = [];
      allPages.forEach(function (pg) {
        if (pg.pageNum < startPage || pg.pageNum > endPage) return;
        if (!pg.dataURL || pg.dataURL.length < 2000) { blanks.push(pg.pageNum); return; }
        var expectedMin = (pg.width || 100) * (pg.height || 100) * 0.01;
        var actualSize = pg.dataURL.length * 0.75;
        if (actualSize < expectedMin) blanks.push(pg.pageNum);
      });
      return blanks;
    }).catch(function () { return []; });
  }

  // ── 7c. Canvas fingerprint (detect content change after page navigation) ──
  function getCanvasFingerprint() {
    var c = findCanvas();
    if (!c || c.width === 0 || c.height === 0) return '';
    try {
      var ctx = c.getContext('2d');
      var positions = [
        [Math.floor(c.width * 0.2), Math.floor(c.height * 0.2)],
        [Math.floor(c.width * 0.8), Math.floor(c.height * 0.2)],
        [Math.floor(c.width * 0.5), Math.floor(c.height * 0.5)],
        [Math.floor(c.width * 0.2), Math.floor(c.height * 0.8)],
        [Math.floor(c.width * 0.8), Math.floor(c.height * 0.8)]
      ];
      var parts = [];
      for (var i = 0; i < positions.length; i++) {
        var d = ctx.getImageData(positions[i][0], positions[i][1], 1, 1).data;
        parts.push(d[0] + ',' + d[1] + ',' + d[2]);
      }
      return parts.join('|');
    } catch (e) { return ''; }
  }

  // ── 8. Message handler ──
  window.addEventListener('message', function (event) {
    if (event.origin !== ALLOWED_ORIGIN || event.source !== window) return;
    if (!event.data || event.data.source !== 'KYOBO_CONTENT') return;

    var resp = { source: 'KYOBO_INJECT', id: event.data.id };
    var send = function () { window.postMessage(resp, ALLOWED_ORIGIN); };

    // Helper: route async handler results to response
    var handle = function (promise) {
      promise.then(function (d) { resp.data = d; send(); }).catch(function (e) { resp.error = e.message; send(); });
    };

    switch (event.data.action) {
      // ── Sync queries ──
      case 'getPageInfo':          resp.data = getPageInfo(); send(); break;
      case 'getTOC':               resp.data = getTOC(); send(); break;
      case 'getViewerPageNum':     resp.data = getViewerPageNum(); send(); break;
      case 'getCapturedCount':     resp.data = capturedCount; send(); break;
      case 'getCanvasFingerprint': resp.data = getCanvasFingerprint(); send(); break;
      case 'ping':                 resp.data = 'pong'; send(); break;
      case 'getCanvasDimensions':
        var cv = findCanvas();
        resp.data = cv ? { width: cv.width, height: cv.height } : null; send(); break;
      case 'canvasReady':
        var crc = findCanvas();
        resp.data = !!(crc && crc.width > 0 && crc.height > 0); send(); break;
      case 'getCaptureDPR':
        var crc2 = findCanvas();
        resp.data = { dpr: _captureDPR, nativeDPR: _nativeDPR, format: _captureFormat, quality: _captureQuality, canvasW: crc2 ? crc2.width : 0, canvasH: crc2 ? crc2.height : 0 };
        send(); break;
      case 'updateCaptureSettings':
        _handleLiveDPRUpdate(event.data.dpr || _captureDPR, event.data.format || null, event.data.quality || 0);
        resp.data = { dpr: _captureDPR, format: _captureFormat }; send(); break;
      case 'clearState':
        clearState(); resp.data = true; send(); break;
      case 'captureAndAddToPDF':
        resp.data = captureAndAddToPDF(event.data.pageNum || 0); send(); break;
      case 'finalizePDF':
        try { resp.data = finalizePDF(event.data.title || 'ebook', event.data.toc || []); }
        catch (e) { resp.error = e.message; }
        send(); break;

      // ── Async: capture ──
      case 'capturePageOnly':   handle(capturePageOnly(event.data.pageNum || 0)); break;
      case 'captureBothPages':  handle(captureBothPages()); break;

      // ── Async: navigation ──
      case 'nextPage':  handle(clickNextPage()); break;
      case 'prevPage':  handle(clickPrevPage()); break;
      case 'goToPage':  handle(Promise.resolve(goToPage(event.data.pageNum))); break;

      // ── Async: cache ──
      case 'getCacheInfo':    handle(getCacheInfoForCurrentBook()); break;
      case 'resolveBookId':   handle(resolveBookIdFromTitle(event.data.title)); break;
      case 'findBlankPages':  handle(findBlankPagesInRange(event.data.startPage || 1, event.data.endPage || 0)); break;
      case 'isPageCached':    handle(isPageCached(getBookId(), event.data.pageNum || 0)); break;
      case 'clearCache':      handle(clearBookCache(getBookId())); break;
      case 'updateBookMeta':  handle(updateBookMeta(getBookId(), event.data.title || '', event.data.totalPages || 0, event.data.toc || [])); break;

      // ── Async: PDF/ZIP ──
      case 'initPDF':           handle(initPDF(event.data.extensionBaseURL || '', event.data.targetSize || null)); break;
      case 'buildPDFFromCache':
        handle(buildPDFFromCacheData(event.data.extensionBaseURL || '', getBookId(), event.data.title || 'ebook', event.data.toc || [], event.data.targetSize || null)
          .then(function (n) { return { success: true, pageCount: n }; }));
        break;
      case 'buildZIPFromCache':
        handle(buildZIPFromCacheData(event.data.extensionBaseURL || '', getBookId(), event.data.title || 'ebook')
          .then(function () { return { success: true }; }));
        break;

      default: resp.error = 'Unknown action'; send();
    }
  });

  // ── 9. Notify injection ──
  window.postMessage({ source: 'KYOBO_INJECT', type: 'INJECTED', data: { timestamp: Date.now() } }, ALLOWED_ORIGIN);

})();
