(function () {
  'use strict';

  // Register with background
  try {
    chrome.runtime.sendMessage({
      target: 'background', action: 'registerLibrary',
      origin: location.origin
    }, function () { void chrome.runtime.lastError; });
  } catch (e) {}

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'ping') {
      sendResponse({ status: 'ready', page: detectPage() });
      return false;
    }
    if (msg.action === 'getBookList') {
      sendResponse({ success: true, data: getBookList() });
      return false;
    }
    if (msg.action === 'clickViewButton') {
      var clicked = clickViewButton(msg.bookTitle);
      sendResponse({ success: clicked });
      return false;
    }
    return false;
  });

  function detectPage() {
    if (location.pathname.indexOf('myBorrowList') !== -1) return 'borrowList';
    if (location.pathname.indexOf('contentView') !== -1) return 'contentView';
    return 'other';
  }

  function getBookList() {
    var books = [];
    var list = document.querySelector('.book_resultList');
    if (!list) return books;

    var items = list.querySelectorAll(':scope > li');
    for (var i = 0; i < items.length; i++) {
      try {
        var item = items[i];
        var titleEl = item.querySelector('.tit a, li.tit a');
        if (!titleEl) continue;

        var title = titleEl.textContent.trim();
        var coverImg = '';
        var imgEl = item.querySelector('.img img');
        if (imgEl) coverImg = imgEl.src || '';

        var author = '';
        var publisher = '';
        var writerEl = item.querySelector('.writer');
        if (writerEl) {
          // Structure: <li class="writer">저자<span>출판사</span>날짜</li>
          var pubSpan = writerEl.querySelector('span');
          if (pubSpan) publisher = pubSpan.textContent.trim();
          // First text node = author name
          for (var k = 0; k < writerEl.childNodes.length; k++) {
            if (writerEl.childNodes[k].nodeType === 3) {
              var txt = writerEl.childNodes[k].textContent.trim();
              if (txt) { author = txt; break; }
            }
          }
        }

        var dueDate = '';
        var dueLi = item.querySelectorAll('.book_date li');
        for (var j = 0; j < dueLi.length; j++) {
          var strong = dueLi[j].querySelector('strong');
          if (strong && strong.textContent.indexOf('반납') !== -1) {
            var span = dueLi[j].querySelector('span');
            if (span) dueDate = span.textContent.trim();
          }
        }

        var viewBtn = item.querySelector('input[value="바로보기"]');
        var downBtn = item.querySelector('input[value="다운보기"]');
        var hasWebViewer = !!viewBtn;
        var hasDownViewer = !!downBtn;

        var contentId = '';
        var onclickSrc = viewBtn ? viewBtn.getAttribute('onclick') : (downBtn ? downBtn.getAttribute('onclick') : '');
        if (onclickSrc) {
          var match = onclickSrc.match(/'(\d{5,})'/g);
          if (match && match.length >= 2) {
            contentId = match.reduce(function (a, b) {
              var va = a.replace(/'/g, ''), vb = b.replace(/'/g, '');
              return va.length > vb.length ? a : b;
            }).replace(/'/g, '');
          }
        }

        books.push({
          title: title,
          coverUrl: coverImg,
          author: author,
          publisher: publisher,
          dueDate: dueDate,
          contentId: contentId,
          hasWebViewer: hasWebViewer,
          hasDownViewer: hasDownViewer,
          index: i
        });
      } catch (e) {}
    }
    return books;
  }

  function clickViewButton(bookTitle) {
    var list = document.querySelector('.book_resultList');
    if (!list) return false;

    var items = list.querySelectorAll(':scope > li');
    var exactMatch = null;
    var fuzzyMatch = null;

    for (var i = 0; i < items.length; i++) {
      try {
        var titleEl = items[i].querySelector('.tit a, li.tit a');
        if (!titleEl) continue;
        var title = titleEl.textContent.trim();

        if (title === bookTitle) { exactMatch = items[i]; break; }
        if (!fuzzyMatch && (title.indexOf(bookTitle) !== -1 || bookTitle.indexOf(title) !== -1)) {
          fuzzyMatch = items[i];
        }
      } catch (e) {}
    }

    var target = exactMatch || fuzzyMatch;
    if (target) {
      var viewBtn = target.querySelector('input[value="바로보기"]');
      if (viewBtn) { viewBtn.click(); return true; }
    }
    return false;
  }

  // ═══════════════════════════════════════════
  // ── Floating Banner System (Shadow DOM) ──
  // ═══════════════════════════════════════════

  if (detectPage() !== 'borrowList') return;

  var panelOpen = false;
  var bannerHost = document.createElement('div');
  bannerHost.id = 'kyobo-ext-banner';
  var shadow = bannerHost.attachShadow({ mode: 'closed' });

  var BANNER_CSS =
    ':host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;color:#1d1d1f}' +

    '#banner{position:fixed;bottom:20px;right:20px;z-index:999999}' +

    /* Toggle button */
    '#toggle{display:flex;align-items:center;gap:8px;padding:10px 18px;' +
      'background:linear-gradient(135deg,#e94560,#c23152);color:#fff;border:none;border-radius:24px;' +
      'font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(233,69,96,.35);' +
      'transition:all .2s;user-select:none;letter-spacing:-0.2px}' +
    '#toggle:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(233,69,96,.45)}' +
    '#toggle:active{transform:scale(.97)}' +
    '#toggle .ico{font-size:16px;line-height:1}' +
    '#toggle .badge{background:rgba(255,255,255,.25);padding:1px 7px;border-radius:10px;font-size:11px;font-weight:700;margin-left:2px}' +

    /* Panel */
    '#panel{display:none;position:absolute;bottom:calc(100% + 10px);right:0;' +
      'width:360px;max-height:520px;background:#fff;border-radius:18px;overflow:hidden;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.12),0 0 0 1px rgba(0,0,0,.04);' +
      'flex-direction:column;animation:slideUp .2s ease-out}' +
    '#panel.open{display:flex}' +
    '@keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}' +

    /* Panel header */
    '.p-header{display:flex;align-items:center;justify-content:space-between;' +
      'padding:16px 18px 12px;border-bottom:1px solid #f0f0f0}' +
    '.p-header-left{display:flex;align-items:center;gap:10px}' +
    '.p-logo{width:28px;height:28px;border-radius:8px;' +
      'background:linear-gradient(135deg,#e94560,#c23152);' +
      'display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:800}' +
    '.p-title{font-size:14px;font-weight:700;color:#1d1d1f}' +
    '.p-close{background:none;border:none;width:28px;height:28px;border-radius:8px;' +
      'display:flex;align-items:center;justify-content:center;color:#86868b;' +
      'cursor:pointer;font-size:18px;transition:all .12s}' +
    '.p-close:hover{background:#f0f0f0;color:#1d1d1f}' +

    /* Panel body */
    '.p-body{flex:1;overflow-y:auto;padding:12px 14px}' +

    /* Status */
    '.status{display:flex;align-items:center;gap:8px;' +
      'padding:8px 12px;border-radius:10px;font-size:12px;font-weight:600;margin-bottom:10px;' +
      'background:linear-gradient(135deg,#eef2ff,#e8f0fe);color:#4361b8}' +
    '.status .sdot{width:7px;height:7px;border-radius:50%;background:#34c759;flex-shrink:0}' +

    /* Book items */
    '.bk{display:flex;gap:12px;padding:12px;background:#f9fafb;border-radius:14px;margin-bottom:8px;transition:background .12s}' +
    '.bk:hover{background:#f3f4f6}' +
    '.bk:last-child{margin-bottom:0}' +
    '.bk-cover{width:50px;height:68px;border-radius:8px;object-fit:cover;background:#e5e5e5;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,.08)}' +
    '.bk-cover-ph{width:50px;height:68px;border-radius:8px;flex-shrink:0;' +
      'background:linear-gradient(135deg,#f0f0f0,#e5e5e5);display:flex;align-items:center;justify-content:center;' +
      'color:#c7c7cc;font-size:18px;box-shadow:0 1px 4px rgba(0,0,0,.08)}' +
    '.bk-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;justify-content:center}' +
    '.bk-name{font-size:13px;font-weight:650;color:#1d1d1f;line-height:1.35;' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
    '.bk-author{font-size:11px;color:#6e6e73;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.bk-due{font-size:10px;color:#aeaeb2}' +

    /* Badges */
    '.badges{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}' +
    '.bg{font-size:9.5px;font-weight:600;padding:2px 7px;border-radius:5px;line-height:1.4}' +
    '.bg-cache{background:#ecfdf5;color:#16a34a}' +
    '.bg-no{background:#f3f4f6;color:#9ca3af}' +

    /* Actions */
    '.bk-acts{display:flex;gap:5px;margin-top:5px;flex-wrap:wrap}' +
    '.abtn{padding:5px 12px;border:none;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;transition:all .12s}' +
    '.abtn:disabled{opacity:.4;cursor:not-allowed}' +
    '.abtn-primary{background:#e94560;color:#fff}' +
    '.abtn-primary:hover:not(:disabled){background:#d63d56}' +
    '.abtn-secondary{background:#f0f0f0;color:#1d1d1f}' +
    '.abtn-secondary:hover:not(:disabled){background:#e5e5e5}' +
    '.abtn-ghost{background:none;color:#86868b;padding:5px 10px}' +
    '.abtn-ghost:hover{color:#1d1d1f;background:#f0f0f0}' +

    /* Empty */
    '.empty{text-align:center;padding:28px 16px;color:#aeaeb2;font-size:12px;line-height:1.6}' +

    /* Scrollbar */
    '.p-body::-webkit-scrollbar{width:4px}' +
    '.p-body::-webkit-scrollbar-track{background:transparent}' +
    '.p-body::-webkit-scrollbar-thumb{background:#d2d2d7;border-radius:2px}' +
    '.p-body::-webkit-scrollbar-thumb:hover{background:#86868b}';

  shadow.innerHTML =
    '<style>' + BANNER_CSS + '</style>' +
    '<div id="banner">' +
      '<div id="panel">' +
        '<div class="p-header">' +
          '<div class="p-header-left"><div class="p-logo">K</div><span class="p-title">eBook PDF</span></div>' +
          '<button class="p-close" id="closePanel">&times;</button>' +
        '</div>' +
        '<div class="p-body" id="panelBody"><div class="empty">불러오는 중...</div></div>' +
      '</div>' +
      '<button id="toggle"><span class="ico">&#128218;</span> eBook PDF <span class="badge" id="bookCount">0</span></button>' +
    '</div>';

  var toggleBtn = shadow.getElementById('toggle');
  var panel = shadow.getElementById('panel');
  var closeBtn = shadow.getElementById('closePanel');
  var panelBody = shadow.getElementById('panelBody');
  var bookCountEl = shadow.getElementById('bookCount');

  toggleBtn.addEventListener('click', function () {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (panelOpen) renderBanner();
  });
  closeBtn.addEventListener('click', function () {
    panelOpen = false;
    panel.classList.remove('open');
  });

  document.body.appendChild(bannerHost);

  // Initial book count on toggle badge
  setTimeout(function () {
    var books = getBookList();
    bookCountEl.textContent = books.length;
  }, 500);

  // esc, escAttr loaded from shared/utils.js

  async function renderBanner() {
    var books = getBookList();
    bookCountEl.textContent = books.length;

    if (books.length === 0) {
      panelBody.innerHTML = '<div class="empty">대출 도서를 찾을 수 없습니다.<br>대출 목록 페이지에서 사용하세요.</div>';
      return;
    }

    var cachedBooks = [];
    try { cachedBooks = await extGetAllBooks(); } catch (e) {}

    renderBookList(books, cachedBooks);
  }

  function findCached(cachedBooks, title) {
    if (!cachedBooks || !title) return null;
    for (var i = 0; i < cachedBooks.length; i++) {
      if (cachedBooks[i].title === title) return cachedBooks[i];
    }
    return null;
  }

  function renderBookList(books, cachedBooks) {
    var html = '<div class="status"><span class="sdot"></span>대출 도서 ' + books.length + '권</div>';

    for (var i = 0; i < books.length; i++) {
      var bk = books[i];
      var cached = findCached(cachedBooks, bk.title);

      var coverHtml = bk.coverUrl
        ? '<img class="bk-cover" src="' + escAttr(bk.coverUrl) + '" alt="">'
        : '<div class="bk-cover-ph">&#128218;</div>';

      var badgesHtml = '';
      if (cached && cached.cachedCount > 0) {
        badgesHtml += '<span class="bg bg-cache">' + cached.cachedCount + 'p 캐시</span>';
      }
      if (!bk.hasWebViewer && bk.hasDownViewer) {
        badgesHtml += '<span class="bg bg-no">다운보기만</span>';
      } else if (!bk.hasWebViewer && !bk.hasDownViewer) {
        badgesHtml += '<span class="bg bg-no">뷰어 없음</span>';
      }

      var actionsHtml = '';
      if (bk.hasWebViewer) {
        actionsHtml += '<button class="abtn abtn-primary" data-act="openSession" data-idx="' + i + '">세션 관리</button>';
      }

      var dueHtml = bk.dueDate ? '<div class="bk-due">반납 ' + esc(bk.dueDate) + '</div>' : '';

      html += '<div class="bk">' +
        coverHtml +
        '<div class="bk-info">' +
          '<div class="bk-name">' + esc(bk.title) + '</div>' +
          (bk.author || bk.publisher ? '<div class="bk-author">' + esc(bk.author) + (bk.publisher ? ' · ' + esc(bk.publisher) : '') + '</div>' : '') +
          dueHtml +
          (badgesHtml ? '<div class="badges">' + badgesHtml + '</div>' : '') +
          (actionsHtml ? '<div class="bk-acts">' + actionsHtml + '</div>' : '') +
        '</div>' +
      '</div>';
    }

    panelBody.innerHTML = html;

    // Bind action buttons
    panelBody.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = this.dataset.act;

        if (action === 'openSession') {
          var idx = parseInt(this.dataset.idx, 10);
          var bk = books[idx];
          if (!bk) return;

          // Store book metadata for session manager
          chrome.storage.local.set({
            sessionManagerBook: {
              title: bk.title,
              coverUrl: bk.coverUrl,
              author: bk.author,
              publisher: bk.publisher,
              dueDate: bk.dueDate,
              contentId: bk.contentId
            }
          });

          // Open session manager
          chrome.runtime.sendMessage({
            target: 'background', action: 'openSessions',
            title: bk.title
          }, function () { void chrome.runtime.lastError; });

          this.textContent = '여는 중...';
          this.disabled = true;
          setTimeout(function () {
            panelOpen = false;
            panel.classList.remove('open');
          }, 800);
        }
      });
    });
  }

})();
