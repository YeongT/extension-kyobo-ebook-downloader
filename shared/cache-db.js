// Shared IndexedDB helpers for extension-local cache (used by popup, reader, background)
var EXT_DB_NAME = 'kyobo_reader_cache';
var EXT_DB_VERSION = 1;

function openExtDB() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(EXT_DB_NAME, EXT_DB_VERSION);
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

function extStorePage(bookId, pageNum, dataURL, width, height) {
  return openExtDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('pages', 'readwrite');
      tx.objectStore('pages').put({
        id: bookId + '_' + pageNum, bookId: bookId, pageNum: pageNum,
        dataURL: dataURL, width: width, height: height, timestamp: Date.now()
      });
      tx.oncomplete = function () { db.close(); resolve(true); };
      tx.onerror = function () { db.close(); reject(tx.error); };
    });
  });
}

function extStoreBookMeta(bookId, title, totalPages, toc) {
  return openExtDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('books', 'readwrite');
      tx.objectStore('books').put({
        bookId: bookId, title: title, totalPages: totalPages,
        toc: toc || [], timestamp: Date.now()
      });
      tx.oncomplete = function () { db.close(); resolve(true); };
      tx.onerror = function () { db.close(); reject(tx.error); };
    });
  });
}

function extGetAllBooks() {
  return openExtDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['books', 'pages'], 'readonly');
      var booksReq = tx.objectStore('books').getAll();
      booksReq.onsuccess = function () {
        var books = booksReq.result || [];
        var remaining = books.length;
        if (remaining === 0) { db.close(); resolve([]); return; }
        books.forEach(function (book, idx) {
          var countReq = tx.objectStore('pages').index('bookId').count(book.bookId);
          countReq.onsuccess = function () {
            books[idx].cachedCount = countReq.result || 0;
            remaining--;
            if (remaining === 0) { db.close(); resolve(books); }
          };
          countReq.onerror = function () {
            books[idx].cachedCount = 0;
            remaining--;
            if (remaining === 0) { db.close(); resolve(books); }
          };
        });
      };
      booksReq.onerror = function () { db.close(); reject(booksReq.error); };
    });
  });
}

function extGetPage(bookId, pageNum) {
  return openExtDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('pages', 'readonly');
      var req = tx.objectStore('pages').get(bookId + '_' + pageNum);
      req.onsuccess = function () { db.close(); resolve(req.result || null); };
      req.onerror = function () { db.close(); reject(req.error); };
    });
  });
}

function extGetPagesInfo(bookId) {
  return openExtDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('pages', 'readonly');
      var req = tx.objectStore('pages').index('bookId').getAll(bookId);
      req.onsuccess = function () {
        db.close();
        var pages = (req.result || []).map(function (p) {
          return { pageNum: p.pageNum, width: p.width, height: p.height };
        });
        pages.sort(function (a, b) { return a.pageNum - b.pageNum; });
        resolve(pages);
      };
      req.onerror = function () { db.close(); reject(req.error); };
    });
  });
}

function extGetBookMeta(bookId) {
  return openExtDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('books', 'readonly');
      var req = tx.objectStore('books').get(bookId);
      req.onsuccess = function () { db.close(); resolve(req.result || null); };
      req.onerror = function () { db.close(); reject(req.error); };
    });
  });
}

function extDeleteBook(bookId) {
  return openExtDB().then(function (db) {
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

function extDeletePage(bookId, pageNum) {
  return openExtDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('pages', 'readwrite');
      tx.objectStore('pages').delete(bookId + '_' + pageNum);
      tx.oncomplete = function () { db.close(); resolve(true); };
      tx.onerror = function () { db.close(); reject(tx.error); };
    });
  });
}

function extFindBookByTitle(title) {
  if (!title) return Promise.resolve(null);
  return openExtDB().then(function (db) {
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

function extMigrateBook(oldBookId, newBookId) {
  if (oldBookId === newBookId) return Promise.resolve();
  return openExtDB().then(function (db) {
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
