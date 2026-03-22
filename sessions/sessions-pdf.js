(function (S) {
  'use strict';

  S.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  var JPEG_QUALITY = 0.85;

  S.downloadPDFForce = function () { S._doPDF(true); };
  S.downloadPDF = function () { S._doPDF(false); };

  S._doPDF = async function (force) {
    if (!S.selectedBookId || !S.selectedBook) return;
    if (typeof window.jspdf === 'undefined') {
      S.showError('라이브러리 로드 실패', 'jsPDF 라이브러리를 찾을 수 없습니다.', 'lib/jspdf.umd.min.js 파일이 존재하는지 확인하세요.');
      return;
    }

    var title = S.selectedBook.title || 'ebook';
    var toc = S.selectedBook.toc || [];
    var sizeVal = S.$('pdfSize').value;
    var target = SIZE_PRESETS[sizeVal] || null;

    var tocByPage = {};
    if (toc && toc.length > 0) {
      toc.forEach(function (t) {
        if (!tocByPage[t.page]) tocByPage[t.page] = [];
        tocByPage[t.page].push(t);
      });
    }

    var sorted = S.capturedPageNums.slice().sort(function (a, b) { return a - b; });

    // Estimate PDF memory: original ~4MB/page, A4 300DPI ~1MB/page
    var perPageMB = target ? 1 : 4;
    var estimatedMB = sorted.length * perPageMB;
    var maxMB = 1000;
    if (!force && estimatedMB > maxMB) {
      S.hideProgress();
      document.getElementById('pdfWarningMsg').textContent =
        'PDF 예상 용량: ~' + Math.round(estimatedMB / 1024 * 10) / 10 + 'GB (' + sorted.length + '페이지)';
      document.getElementById('pdfWarningDialog').hidden = false;
      return;
    }

    S.showProgress('PDF 생성 중...', 0);

    try {
      var jsPDF = window.jspdf.jsPDF;
      var sizeSuffix = sizeVal && sizeVal !== 'original' ? '_' + sizeVal.toUpperCase() : '';
      var safeName = sanitizeFilename(title);

      var outlineParents = {};
      var pdf = null;

      for (var i = 0; i < sorted.length; i++) {
        var pn = sorted[i];
        S.updateProgress(Math.round((i / sorted.length) * 100), pn + '페이지 처리 중...');

        var page = await extGetPage(S.selectedBookId, pn);
        if (!page || !page.dataURL) continue;

        var imgDims = await getImageDimensions(page.dataURL);
        var curPageOpts = calcPageDimensions(imgDims.width, imgDims.height, target);

        if (!pdf) {
          pdf = new jsPDF({
            orientation: curPageOpts.orientation,
            unit: 'mm',
            format: [curPageOpts.pageW, curPageOpts.pageH]
          });
        } else {
          pdf.addPage([curPageOpts.pageW, curPageOpts.pageH], curPageOpts.orientation);
        }

        var layout = calcImageLayout(imgDims.width, imgDims.height, curPageOpts.pageW, curPageOpts.pageH, target);
        // Downscale to 300DPI for target size (A4 etc.) — drastically reduces file size
        var maxW = target ? Math.round(curPageOpts.pageW / 25.4 * 300) : 0;
        var jpegURL = await toJpegDataURL(page.dataURL, JPEG_QUALITY, maxW);
        pdf.addImage(jpegURL, 'JPEG', layout.x, layout.y, layout.w, layout.h);

        // Free memory immediately
        page.dataURL = null;
        jpegURL = null;

        if (tocByPage[pn]) {
          tocByPage[pn].forEach(function (entry) {
            try {
              var depth = entry.depth || 1;
              var parent = depth > 1 ? (outlineParents[depth - 1] || null) : null;
              var node = pdf.outline.add(parent, entry.title || ('Page ' + pn), { pageNumber: i + 1 });
              outlineParents[depth] = node;
              for (var d = depth + 1; d <= 10; d++) delete outlineParents[d];
            } catch (e) {}
          });
        }
      }

      if (pdf) {
        S.updateProgress(100, '파일 저장 중...');
        try {
          pdf.save(safeName + sizeSuffix + '.pdf');
        } catch (saveErr) {
          if (saveErr.message && saveErr.message.indexOf('string length') !== -1) {
            pdf = null;
            S.hideProgress();
            var doExport = confirm(
              'PDF 용량 초과 — 브라우저 메모리 한계 도달\n\n' +
              'ZIP 이미지 + Python 병합 스크립트를 다운로드하시겠습니까?\n\n' +
              '사용법:\n' +
              '  1. pip install Pillow\n' +
              '  2. python merge_pdf.py <zip파일>'
            );
            if (doExport) {
              try {
                var scriptUrl = chrome.runtime.getURL('assets/merge_pdf.py');
                var a = document.createElement('a');
                a.href = scriptUrl;
                a.download = 'merge_pdf.py';
                a.click();
              } catch (e) {}
              S.downloadZIP();
            }
            return;
          }
          throw saveErr;
        }
        pdf = null;
      }

      S.hideProgress();
      S.showToast('PDF 저장 완료!');
    } catch (e) {
      S.hideProgress();
      S.showError('PDF 생성 실패', 'PDF 파일을 생성하는 중 오류가 발생했습니다.', S.formatErrorDetail(e));
    }
  };


  S.downloadZIP = async function () {
    if (!S.selectedBookId || !S.selectedBook) return;
    if (typeof JSZip === 'undefined') {
      S.showError('라이브러리 로드 실패', 'JSZip 라이브러리를 찾을 수 없습니다.', 'lib/jszip.min.js 파일이 존재하는지 확인하세요.');
      return;
    }

    var title = S.selectedBook.title || 'ebook';
    S.showProgress('ZIP 생성 중...', 0);
    var sorted = S.capturedPageNums.slice().sort(function (a, b) { return a - b; });

    try {
      var zip = new JSZip();
      var imgFolder = zip.folder('images');

      for (var i = 0; i < sorted.length; i++) {
        var pn = sorted[i];
        S.updateProgress(Math.round((i / sorted.length) * 100), pn + '페이지 추가 중...');

        var page = await extGetPage(S.selectedBookId, pn);
        if (!page || !page.dataURL) continue;

        var base64 = page.dataURL.split(',')[1];
        var ext = page.dataURL.indexOf('image/png') !== -1 ? '.png' : '.jpg';
        var padNum = String(pn).padStart(4, '0');
        imgFolder.file(padNum + ext, base64, { base64: true });
      }

      S.updateProgress(95, 'ZIP 압축 중...');
      var blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
      S.downloadBlob(blob, sanitizeFilename(title) + '_images.zip');
      S.hideProgress();
      S.showToast('ZIP 저장 완료!');
    } catch (e) {
      S.showError('ZIP 생성 실패', 'ZIP 파일을 생성하는 중 오류가 발생했습니다.', S.formatErrorDetail(e));
    }
  };

  S.exportSession = async function () {
    if (!S.selectedBookId || !S.selectedBook) return;
    if (typeof JSZip === 'undefined') {
      S.showError('라이브러리 로드 실패', 'JSZip 라이브러리를 찾을 수 없습니다.', 'lib/jszip.min.js 파일이 존재하는지 확인하세요.');
      return;
    }

    var title = S.selectedBook.title || 'ebook';
    S.showProgress('세션 내보내기 중...', 0);
    var sorted = S.capturedPageNums.slice().sort(function (a, b) { return a - b; });

    try {
      var zip = new JSZip();

      var metadata = {
        version: 1,
        bookId: S.selectedBookId,
        title: S.selectedBook.title,
        totalPages: S.selectedBook.totalPages,
        toc: S.selectedBook.toc || [],
        capturedPages: sorted,
        exportDate: new Date().toISOString()
      };
      zip.file('metadata.json', JSON.stringify(metadata, null, 2));

      var pagesFolder = zip.folder('pages');
      for (var i = 0; i < sorted.length; i++) {
        var pn = sorted[i];
        S.updateProgress(Math.round((i / sorted.length) * 90), pn + '페이지 내보내기 중...');

        var page = await extGetPage(S.selectedBookId, pn);
        if (!page || !page.dataURL) continue;

        var pageInfo = {
          pageNum: page.pageNum,
          width: page.width,
          height: page.height
        };
        var base64 = page.dataURL.split(',')[1];
        var ext = page.dataURL.indexOf('image/png') !== -1 ? '.png' : '.jpg';
        var padNum = String(pn).padStart(4, '0');
        pagesFolder.file(padNum + ext, base64, { base64: true });
        pagesFolder.file(padNum + '.json', JSON.stringify(pageInfo));
      }

      // Include merge scripts (py + bat for one-click)
      try {
        var pyResp = await fetch(chrome.runtime.getURL('assets/merge_pdf.py'));
        if (pyResp.ok) zip.file('merge_pdf.py', await pyResp.text());
        var batResp = await fetch(chrome.runtime.getURL('assets/merge_pdf.bat'));
        if (batResp.ok) zip.file('PDF 생성.bat', await batResp.text());
      } catch (e) {}

      S.updateProgress(95, 'ZIP 압축 중...');
      var blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
      S.downloadBlob(blob, sanitizeFilename(title) + '_session.zip');
      S.hideProgress();
      S.showToast('세션 내보내기 완료!');
    } catch (e) {
      S.showError('세션 내보내기 실패', '세션 데이터를 내보내는 중 오류가 발생했습니다.', S.formatErrorDetail(e));
    }
  };

  S.importSession = async function (file) {
    if (!file) return;
    if (typeof JSZip === 'undefined') {
      S.showError('라이브러리 로드 실패', 'JSZip 라이브러리를 찾을 수 없습니다.', 'lib/jszip.min.js 파일이 존재하는지 확인하세요.');
      return;
    }

    S.showProgress('세션 불러오기 중...', 0);

    try {
      var zip = await JSZip.loadAsync(file);
      var metaFile = zip.file('metadata.json');
      if (!metaFile) throw new Error('metadata.json 없음 - 유효한 세션 파일이 아닙니다');

      var metaText = await metaFile.async('string');
      var metadata = JSON.parse(metaText);
      if (!metadata.bookId || typeof metadata.title !== 'string') throw new Error('유효하지 않은 메타데이터');
      metadata.totalPages = (typeof metadata.totalPages === 'number') ? Math.max(0, Math.floor(metadata.totalPages)) : 0;
      metadata.bookId = String(metadata.bookId);
      metadata.title = String(metadata.title);

      S.updateProgress(5, '메타데이터 저장 중...');
      await extStoreBookMeta(metadata.bookId, metadata.title, metadata.totalPages, metadata.toc || []);

      var pagesFolder = zip.folder('pages');
      var imageFiles = [];
      pagesFolder.forEach(function (relativePath, entry) {
        if (relativePath.endsWith('.jpg') || relativePath.endsWith('.png')) {
          imageFiles.push(entry);
        }
      });

      for (var i = 0; i < imageFiles.length; i++) {
        var entry = imageFiles[i];
        var filename = entry.name.split('/').pop();
        var pageNum = parseInt(filename.replace(/\.(jpg|png)$/, ''), 10);
        S.updateProgress(5 + Math.round((i / imageFiles.length) * 90), pageNum + '페이지 복원 중...');

        var imgData = await entry.async('base64');
        var isPng = entry.name.endsWith('.png');
        var dataURL = (isPng ? 'data:image/png;base64,' : 'data:image/jpeg;base64,') + imgData;

        var width = 0, height = 0;
        var infoFile = pagesFolder.file(String(pageNum).padStart(4, '0') + '.json');
        if (infoFile) {
          try {
            var info = JSON.parse(await infoFile.async('string'));
            width = info.width || 0;
            height = info.height || 0;
          } catch (e) {}
        }

        if (width === 0 || height === 0) {
          try {
            var dims = await getImageDimensions(dataURL);
            width = dims.width;
            height = dims.height;
          } catch (e) {}
        }

        await extStorePage(metadata.bookId, pageNum, dataURL, width, height);
      }

      S.hideProgress();
      S.showToast('"' + metadata.title + '" 불러오기 완료! (' + imageFiles.length + '페이지)');
      await S.loadBooks();
      S.selectBook(metadata.bookId);
    } catch (e) {
      S.showError('세션 불러오기 실패', '세션 파일을 복원하는 중 오류가 발생했습니다.', S.formatErrorDetail(e));
    }
  };

})(window._S = window._S || {});
