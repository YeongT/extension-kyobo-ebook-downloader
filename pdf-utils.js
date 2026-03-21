// Shared PDF utility functions

var SIZE_PRESETS = {
  original: null,
  a4: { w: 210, h: 297 },
  b5: { w: 182, h: 257 },
  a5: { w: 148, h: 210 }
};

function calcPageDimensions(imgW, imgH, target) {
  if (!target) {
    var PX_TO_MM = 25.4 / 96;
    return {
      pageW: imgW * PX_TO_MM,
      pageH: imgH * PX_TO_MM,
      orientation: imgW > imgH ? 'landscape' : 'portrait'
    };
  }
  return {
    pageW: target.w,
    pageH: target.h,
    orientation: 'portrait'
  };
}

function calcImageLayout(imgW, imgH, pageW, pageH, target) {
  if (!target) {
    return { x: 0, y: 0, w: pageW, h: pageH };
  }
  var margin = 5;
  var areaW = pageW - margin * 2;
  var areaH = pageH - margin * 2;
  var scale = Math.min(areaW / imgW, areaH / imgH);
  var w = imgW * scale;
  var h = imgH * scale;
  return {
    x: (pageW - w) / 2,
    y: (pageH - h) / 2,
    w: w,
    h: h
  };
}
