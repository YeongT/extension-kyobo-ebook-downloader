// Service worker for Kyobo eBook PDF Downloader
try { importScripts('cache-db.js'); } catch (e) {}

var captureManagerTabId = null;

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

    case 'openReader':
      var rUrl = chrome.runtime.getURL('reader.html');
      if (msg.bookId) rUrl += '?book=' + encodeURIComponent(msg.bookId);
      chrome.tabs.create({ url: rUrl });
      sendResponse({ success: true });
      return false;

    case 'openCaptureManager':
      var baseUrl = chrome.runtime.getURL('capture.html');
      var fullUrl = baseUrl + '?tabId=' + (msg.tabId || '');
      if (captureManagerTabId) {
        chrome.tabs.get(captureManagerTabId, function (tab) {
          if (chrome.runtime.lastError || !tab) {
            captureManagerTabId = null;
            chrome.tabs.create({ url: fullUrl }, function (t) { if (t) captureManagerTabId = t.id; });
          } else {
            chrome.tabs.update(captureManagerTabId, { active: true, url: fullUrl });
          }
        });
      } else {
        chrome.tabs.create({ url: fullUrl }, function (t) { if (t) captureManagerTabId = t.id; });
      }
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (tabId === captureManagerTabId) captureManagerTabId = null;
});
