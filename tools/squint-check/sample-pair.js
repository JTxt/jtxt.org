/*
 * A made-up reference and a drawing of it with two proportion errors: the apple
 * sits 28 px too far right and the vase is 18 px too wide on each side. The
 * drawing is on a noisy page, scaled, turned 6° and moved, the way a photo of a
 * real drawing would be. Taken from the Drawing matcher's "Noisy page,
 * proportion errors" sample (jtxt.org/tools/compare/).
 *
 * co-authors: jtxt.org and claude opus 5.5
 */
(function (root) {
  'use strict';
  function grayToCanvas(img) {
    var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    var x = c.getContext('2d'), d = x.createImageData(img.width, img.height), p = d.data;
    for (var i = 0; i < img.data.length; i++) {
      var v = Math.max(0, Math.min(255, Math.round(img.data[i] * 255)));
      p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = v; p[i * 4 + 3] = 255;
    }
    x.putImageData(d, 0, 0);
    return c;
  }
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function blank(w, h, v) { var g = new Float32Array(w * h); g.fill(v); return { width: w, height: h, data: g }; }
  function strokePoly(img, pts, r, ink) {
    var w = img.width, h = img.height, g = img.data;
    for (var k = 0; k < pts.length - 1; k++) {
      var x0 = pts[k][0], y0 = pts[k][1], x1 = pts[k + 1][0], y1 = pts[k + 1][1];
      var minx = Math.max(0, Math.floor(Math.min(x0, x1) - r - 2)), maxx = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + r + 2));
      var miny = Math.max(0, Math.floor(Math.min(y0, y1) - r - 2)), maxy = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + r + 2));
      var dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
      for (var y = miny; y <= maxy; y++) {
        for (var x = minx; x <= maxx; x++) {
          var t = ((x - x0) * dx + (y - y0) * dy) / L2; t = Math.max(0, Math.min(1, t));
          var d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
          var a = Math.max(0, Math.min(1, r + 0.5 - d)), v = 1 - a * ink;
          if (v < g[y * w + x]) { g[y * w + x] = v; }
        }
      }
    }
  }
  function fillPoly(img, pts, shade) {
    var w = img.width, h = img.height, g = img.data, ys = pts.map(function (p) { return p[1]; });
    var y0 = Math.max(0, Math.floor(Math.min.apply(null, ys))), y1 = Math.min(h - 1, Math.ceil(Math.max.apply(null, ys)));
    for (var y = y0; y <= y1; y++) {
      var xs = [];
      for (var k = 0; k < pts.length; k++) {
        var a = pts[k], b = pts[(k + 1) % pts.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) { xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0])); }
      }
      xs.sort(function (p, q) { return p - q; });
      for (var j = 0; j + 1 < xs.length; j += 2) {
        for (var x = Math.max(0, Math.ceil(xs[j])); x <= Math.min(w - 1, Math.floor(xs[j + 1])); x++) { g[y * w + x] = shade(x, y); }
      }
    }
  }
  function ellipse(cx, cy, rx, ry) {
    var out = [];
    for (var i = 0; i <= 72; i++) { out.push([cx + rx * Math.cos(i / 72 * 2 * Math.PI), cy + ry * Math.sin(i / 72 * 2 * Math.PI)]); }
    return out;
  }
  function shapes(err) {
    var vase = [[330, 300], [370, 300], [365, 360], [420 + err.vaseW, 470], [430 + err.vaseW, 560], [400, 640], [300, 640],
      [270 - err.vaseW, 560], [280 - err.vaseW, 470], [335, 360]];
    vase.push(vase[0]);
    return {
      apple: ellipse(190 + err.appleDx, 560, 75, 68), vase: vase,
      box: [[440, 520], [560, 520], [560, 650], [440, 650], [440, 520]],
      lid: [[440, 520], [470, 490], [585, 490], [560, 520]],
      side: [[560, 520], [585, 490], [585, 620], [560, 650]]
    };
  }
  function makeReference(rand) {
    var W = 640, H = 800, img = blank(W, H, 0.6), x, y;
    for (y = 0; y < H; y++) { for (x = 0; x < W; x++) { img.data[y * W + x] = (y < 660 ? 0.55 + 0.15 * x / W : 0.35) + (rand() - 0.5) * 0.06; } }
    var s = shapes({ appleDx: 0, vaseW: 0 });
    fillPoly(img, s.vase, function (x) { return 0.25 + 0.4 * (x - 270) / 160; });
    fillPoly(img, s.apple, function (x, y) { return 0.75 - 0.5 * Math.hypot(x - 170, y - 540) / 90; });
    fillPoly(img, s.box, function (x) { return 0.85 - 0.1 * (x - 440) / 120; });
    fillPoly(img, s.lid, function () { return 0.93; });
    fillPoly(img, s.side, function () { return 0.5; });
    strokePoly(img, [[40, 40], [220, 40], [220, 230], [40, 230], [40, 40]], 3, 0.6);
    strokePoly(img, [[130, 40], [130, 230]], 2, 0.5);
    return img;
  }
  function makeDrawing(rand, truth, err, noise) {
    var W = 1000, H = 1300, img = blank(W, H, 1), x, y, n, k;
    for (y = 0; y < H; y++) { for (x = 0; x < W; x++) { img.data[y * W + x] = 0.97 - 0.18 * (x / W) * (y / H) + (rand() - 0.5) * 0.07; } }
    var c = Math.cos(truth.theta), s = Math.sin(truth.theta);
    var toB = function (p) { var u = (p[0] - truth.tx) / truth.scale, v = (p[1] - truth.ty) / truth.scale; return [c * u + s * v, -s * u + c * v]; };
    var sh = shapes(err);
    ['apple', 'vase', 'box', 'lid', 'side'].forEach(function (key) {
      var pts = sh[key].map(toB).map(function (p) { return [p[0] + (rand() - 0.5) * 1.5, p[1] + (rand() - 0.5) * 1.5]; });
      strokePoly(img, pts, 1.6, 0.8);
    });
    if (noise) {
      for (n = 0; n < 6; n++) {
        var px = 80 + rand() * 250, py = 80 + rand() * 1100, pts = [[px, py]];
        for (k = 0; k < 25; k++) { px += (rand() - 0.3) * 18; py += (rand() - 0.5) * 18; pts.push([px, py]); }
        strokePoly(img, pts, 1.2, 0.7);
      }
      for (var line = 0; line < 3; line++) {
        var z = [];
        for (k = 0; k < 40; k++) { z.push([620 + k * 8, 1150 + line * 30 + (k % 2 ? -8 : 8)]); }
        strokePoly(img, z, 1.1, 0.8);
      }
      for (y = 300; y < 420; y++) {
        for (x = 700; x < 860; x++) {
          var dd = Math.hypot((x - 780) / 80, (y - 360) / 60);
          if (dd < 1) { img.data[y * W + x] -= 0.25 * (1 - dd); }
        }
      }
      strokePoly(img, [[100, 950], [900, 700]], 1.0, 0.5);
      for (n = 0; n < 400; n++) { var sx = rand() * W | 0, sy = rand() * H | 0; strokePoly(img, [[sx, sy], [sx + 1, sy]], 0.8, 0.6); }
    }
    return img;
  }

  root.SamplePair = {
    build: function () {
      var rand = rng(42), t = { scale: 0.62, theta: 6 * Math.PI / 180, tx: 20, ty: 30 };
      var ref = makeReference(rand), drw = makeDrawing(rand, t, { appleDx: 28, vaseW: 18 }, true);
      return { reference: grayToCanvas(ref), drawing: grayToCanvas(drw) };
    }
  };
}(window));
