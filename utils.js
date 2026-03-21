// Shared utility functions

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function escAttr(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeFilename(name) {
  return (name || 'ebook').replace(/[\\/:*?"<>|]/g, '_').substring(0, 100);
}

function timeAgo(ts) {
  if (!ts) return '';
  var d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return '방금 전';
  if (d < 3600) return Math.floor(d / 60) + '분 전';
  if (d < 86400) return Math.floor(d / 3600) + '시간 전';
  return Math.floor(d / 86400) + '일 전';
}

function getImageDimensions(dataURL) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () { resolve({ width: img.width, height: img.height }); };
    img.onerror = function () { reject(new Error('Image load failed')); };
    img.src = dataURL;
  });
}

function toJpegDataURL(dataURL, quality, maxWidth) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () {
      var w = img.width, h = img.height;
      // Downscale if maxWidth specified and image exceeds it
      if (maxWidth && w > maxWidth) {
        var scale = maxWidth / w;
        w = maxWidth;
        h = Math.round(img.height * scale);
      }
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality || 0.92));
    };
    img.onerror = function () { resolve(dataURL); };
    img.src = dataURL;
  });
}
