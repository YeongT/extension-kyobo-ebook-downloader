// Service worker for Kyobo eBook PDF Downloader
try { importScripts('cache-db.js'); } catch (e) {}

var libraryTabId = null;
var libraryOrigin = null;

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target !== 'background') return false;

  switch (msg.action) {
    case 'cachePage':
      extStorePage(msg.bookId, msg.pageNum, msg.dataURL, msg.width, msg.height)
        .then(function () { sendResponse({ success: true }); })
        .catch(function (e) { sendResponse({ success: false, error: e.message }); });
      return true;

    case 'cacheBookMeta':
      extStoreBookMeta(msg.bookId, msg.title, msg.totalPages, msg.toc)
        .then(function () { sendResponse({ success: true }); })
        .catch(function (e) { sendResponse({ success: false, error: e.message }); });
      return true;

    case 'registerLibrary':
      libraryOrigin = msg.origin || null;
      if (sender.tab) libraryTabId = sender.tab.id;
      sendResponse({ success: true });
      return false;

    case 'recovery':
      handleRecovery(msg.bookTitle).catch(function (e) {
        console.error('[Recovery] Failed:', e);
      });
      sendResponse({ success: true });
      return false;

    case 'openReader':
      var rUrl = chrome.runtime.getURL('reader.html');
      if (msg.bookId) rUrl += '?book=' + encodeURIComponent(msg.bookId);
      chrome.tabs.create({ url: rUrl });
      sendResponse({ success: true });
      return false;

    case 'openSessions':
      (async function () {
        var sUrl = chrome.runtime.getURL('sessions.html');
        if (msg.title) sUrl += '?title=' + encodeURIComponent(msg.title);
        else if (msg.bookId) sUrl += '?book=' + encodeURIComponent(msg.bookId);

        var baseUrl = chrome.runtime.getURL('sessions.html');
        var existing = await chrome.tabs.query({ url: baseUrl + '*' });
        if (existing.length > 0) {
          await chrome.tabs.update(existing[0].id, { url: sUrl, active: true });
        } else {
          await chrome.tabs.create({ url: sUrl });
        }
        sendResponse({ success: true });
      })();
      return true;

    case 'startCaptureForBook':
      startCaptureForBook(msg.bookTitle, msg.resume).catch(function (e) {
        console.error('[StartCapture] Failed:', e);
      });
      sendResponse({ success: true });
      return false;

    case 'getRecentBookTitle':
      extGetAllBooks()
        .then(function (books) {
          if (books && books.length > 0) {
            books.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
            sendResponse({ success: true, title: books[0].title });
          } else {
            sendResponse({ success: false, title: '' });
          }
        })
        .catch(function () { sendResponse({ success: false, title: '' }); });
      return true;

    case 'getPagesInfo':
      extGetPagesInfo(msg.bookId)
        .then(function (pages) {
          sendResponse({ success: true, pages: pages.map(function (p) { return p.pageNum; }) });
        })
        .catch(function (e) { sendResponse({ success: false, pages: [] }); });
      return true;

    case 'findBookByTitle':
      extFindBookByTitle(msg.title)
        .then(function (bookId) { sendResponse({ success: true, bookId: bookId }); })
        .catch(function (e) { sendResponse({ success: false, bookId: null }); });
      return true;

    case 'migrateBookCache':
      (async function () {
        try {
          if (msg.oldBookId && msg.newBookId && msg.oldBookId !== msg.newBookId) {
            await extMigrateBook(msg.oldBookId, msg.newBookId);
          }
          if (msg.title) {
            var found = await extFindBookByTitle(msg.title);
            if (found && found !== msg.newBookId) {
              await extMigrateBook(found, msg.newBookId);
            }
          }
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'focusTab':
      if (sender.tab) {
        chrome.tabs.update(sender.tab.id, { active: true }, function () {
          void chrome.runtime.lastError;
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false });
      }
      return true;

    case 'showNotification':
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: msg.title || '교보 eBook',
        message: msg.message || '',
        requireInteraction: !!msg.requireInteraction
      });
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (tabId === libraryTabId) libraryTabId = null;
});

// ── Recovery: close viewer → library → click 바로보기 → new viewer resumes ──

async function handleRecovery(bookTitle) {
  console.log('[Recovery] Starting for:', bookTitle);

  var keepAlive = setInterval(function () {
    chrome.runtime.getPlatformInfo(function () {});
  }, 25000);

  try {
    var viewerTabs = await chrome.tabs.query({ url: 'https://wviewer.kyobobook.co.kr/*' });
    for (var i = 0; i < viewerTabs.length; i++) {
      try { await chrome.tabs.remove(viewerTabs[i].id); } catch (e) {}
    }

    await sleep(2000 + Math.random() * 3000);

    var libTabId = await findOrCreateLibraryTab();
    if (!libTabId) {
      console.error('[Recovery] Cannot find library tab');
      return;
    }

    var borrowUrl = (libraryOrigin || 'https://cau.dkyobobook.co.kr') + '/myLib/myBorrowList.ink';
    await chrome.tabs.update(libTabId, { active: true, url: borrowUrl });
    await waitForTabLoad(libTabId, 20000);
    await sleep(2000 + Math.random() * 2000);

    for (var pingAttempt = 0; pingAttempt < 10; pingAttempt++) {
      try {
        var pong = await chrome.tabs.sendMessage(libTabId, { action: 'ping' });
        if (pong && pong.status === 'ready') break;
      } catch (e) {}
      await sleep(1000);
    }

    var clicked = false;
    for (var attempt = 0; attempt < 3 && !clicked; attempt++) {
      if (attempt > 0) await sleep(2000);
      try {
        var resp = await chrome.tabs.sendMessage(libTabId, {
          action: 'clickViewButton',
          bookTitle: bookTitle
        });
        clicked = resp && resp.success;
      } catch (e) {
        console.log('[Recovery] Click attempt ' + (attempt + 1) + ' failed:', e.message);
      }
    }

    if (!clicked) {
      console.error('[Recovery] Failed to click 바로보기 for:', bookTitle);
      return;
    }

    console.log('[Recovery] 바로보기 clicked, waiting for new viewer tab...');
    await waitForNewTab('https://wviewer.kyobobook.co.kr/*', 20000);
    console.log('[Recovery] New viewer tab detected, capture should resume automatically');
  } finally {
    clearInterval(keepAlive);
  }
}

async function findOrCreateLibraryTab() {
  if (libraryTabId) {
    try {
      var tab = await chrome.tabs.get(libraryTabId);
      if (tab) return libraryTabId;
    } catch (e) {}
    libraryTabId = null;
  }

  var libTabs = await chrome.tabs.query({ url: 'https://*.dkyobobook.co.kr/*' });
  if (libTabs.length > 0) {
    libraryTabId = libTabs[0].id;
    if (!libraryOrigin) {
      try { libraryOrigin = new URL(libTabs[0].url).origin; } catch (e) {}
    }
    return libraryTabId;
  }

  var origin = libraryOrigin || 'https://cau.dkyobobook.co.kr';
  var newTab = await chrome.tabs.create({ url: origin + '/myLib/myBorrowList.ink' });
  libraryTabId = newTab.id;
  return libraryTabId;
}

function waitForTabLoad(tabId, timeout) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      chrome.tabs.onUpdated.removeListener(check);
      resolve(false);
    }, timeout || 15000);

    function check(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(check);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(check);
  });
}

function waitForNewTab(urlPattern, timeout) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      chrome.tabs.onUpdated.removeListener(check);
      resolve(false);
    }, timeout || 20000);

    function check(tabId, info, tab) {
      if (info.status === 'complete' && tab.url && tab.url.match(/wviewer\.kyobobook\.co\.kr/)) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(check);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(check);
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// ── Start capture from library page ──

async function startCaptureForBook(bookTitle, resume) {
  console.log('[StartCapture] Book:', bookTitle, 'Resume:', resume);

  if (resume) {
    await chrome.storage.local.set({
      pendingCapture: {
        bookTitle: bookTitle,
        action: 'resume',
        timestamp: Date.now()
      }
    });
  } else {
    await chrome.storage.local.remove('pendingCapture');
  }

  // Find library tab and click 바로보기 to open viewer
  var libTabId = await findOrCreateLibraryTab();
  if (!libTabId) {
    console.error('[StartCapture] No library tab');
    return;
  }

  var borrowUrl = (libraryOrigin || 'https://cau.dkyobobook.co.kr') + '/myLib/myBorrowList.ink';
  var libTab = await chrome.tabs.get(libTabId);
  if (!libTab.url || libTab.url.indexOf('myBorrowList') === -1) {
    await chrome.tabs.update(libTabId, { url: borrowUrl });
    await waitForTabLoad(libTabId, 15000);
    await sleep(2000);
  }

  for (var p = 0; p < 10; p++) {
    try {
      var pong = await chrome.tabs.sendMessage(libTabId, { action: 'ping' });
      if (pong && pong.status === 'ready') break;
    } catch (e) {}
    await sleep(1000);
  }

  try {
    var resp = await chrome.tabs.sendMessage(libTabId, {
      action: 'clickViewButton', bookTitle: bookTitle
    });
    if (!resp || !resp.success) {
      console.error('[StartCapture] Click failed');
      await chrome.storage.local.remove('pendingCapture');
    }
  } catch (e) {
    console.error('[StartCapture] Error:', e);
    await chrome.storage.local.remove('pendingCapture');
  }
}

