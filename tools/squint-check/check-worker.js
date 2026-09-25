/*
 * Squint & Check: the work that would freeze the page, run off the main thread.
 *
 * Messages in:
 *   { type:'reference', img:{width, height, data} }   RGBA bytes, kept for matching
 *   { type:'drawing',   img:{width, height, data} }
 *   { type:'mask', id, which, maxSide }                'ref' or 'draw': the picture's edges (and the drawing's ink) as a mask
 *   { type:'match', id, rotationRange }                full search
 *   { type:'refine', id, P }                           snap from a placement {scale, theta, tx, ty}
 * Every reply carries the same type and id, plus `error` if it failed.
 *
 * co-authors: jtxt.org and claude opus 5.5
 */
importScripts('match.js');

var refImg = null, drawImg = null, prep = null;

self.onmessage = function (e) {
  var m = e.data;
  try {
    if (m.type === 'reference') { refImg = m.img; prep = null; }
    else if (m.type === 'drawing') { drawImg = m.img; prep = null; }
    else if (m.type === 'mask') {
      var img = m.which === 'ref' ? refImg : drawImg;
      if (!img) { throw new Error('No picture yet'); }
      var mk = mask(img, m.maxSide || 1024, m.which === 'draw');
      self.postMessage({ type: 'mask', id: m.id, which: m.which, mask: mk }, [mk.data.buffer]);
    }
    else if (m.type === 'match' || m.type === 'refine') {
      if (!refImg || !drawImg) { throw new Error('Add both a reference and a drawing first'); }
      var t0 = Date.now();
      if (!prep) { prep = ImageMatch.prepare(refImg, drawImg, { rotationRange: m.rotationRange || 30 }); }
      prep.o.rotationRange = m.rotationRange || 30;
      var r = m.type === 'match' ? ImageMatch.search(prep) : ImageMatch.refine(prep, m.P);
      self.postMessage({
        type: m.type, id: m.id, timeMs: Date.now() - t0,
        error: r.error || null,
        P: r.error ? null : { scale: r.scale, theta: r.theta, tx: r.tx, ty: r.ty },
        quality: r.quality, ambiguity: r.ambiguity || 0, cost: r.cost,
        box: prep.boxB ? { x0: prep.boxB.x0, y0: prep.boxB.y0, x1: prep.boxB.x1, y1: prep.boxB.y1 } : null
      });
    }
  } catch (err) {
    self.postMessage({ type: m.type, id: m.id, error: String((err && err.message) || err) });
  }
};

/* ------------------------------------------------------------------ mask */

// A picture as the mask its lines are drawn from, found once when the picture loads.
// The edges are the matcher's own (blur, gradient, one-pixel ridges, faint and short
// pieces dropped), found on lightness alone, so color makes no difference. They're
// found on a finer copy than the matcher's 480px, with its blur scaled to match, so
// they keep the same structure, only placed more precisely. The page blurs this mask
// on the GPU and thresholds the blur into a smooth line.
// Four bytes per pixel:
//   R  255 on an edge
//   G  that edge's weight: strong, long edges near 255, so they can show brighter
//   B  the drawing's ink, as the old Drawing matcher tinted it: how much darker than
//      the paper, ramping in from 0.05 over 0.35 (Soft and Tint; 0 on the reference)
//   A  255
function mask(img, maxSide, withInk) {
  var W = img.width, H = img.height, k = Math.min(1, maxSide / Math.max(W, H));
  var w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k)), n = w * h, i;
  var L = luminance(img.data, W, H, w, h);
  var o = {}, key;
  for (key in ImageMatch.DEFAULTS) { o[key] = ImageMatch.DEFAULTS[key]; }
  var E = ImageMatch.detectEdges(L, w, h, 1.4 * Math.max(w, h) / 480 * 0.85, o);
  var out = new Uint8Array(n * 4);
  for (i = 0; i < n; i++) { out[i * 4 + 3] = 255; }
  for (i = 0; i < E.n; i++) {
    var p = ((E.y[i] | 0) * w + (E.x[i] | 0)) * 4;
    out[p] = 255;
    out[p + 1] = Math.max(out[p + 1], Math.round(E.wt[i] * 255));
  }
  if (withInk) {
    var bg = paper(L, w, h);
    for (i = 0; i < n; i++) {
      var t = (bg[i] - L[i] - 0.05) / 0.35;
      out[i * 4 + 2] = t <= 0 ? 0 : (t >= 1 ? 255 : Math.round(t * 255));
    }
  }
  return { w: w, h: h, data: out, edges: E.n };
}

// Area-averaged luminance at the working size. Transparent pixels read as white paper.
function luminance(src, W, H, w, h) {
  var out = new Float32Array(w * h), sx = W / w, sy = H / h, x, y;
  for (y = 0; y < h; y++) {
    var y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (x = 0; x < w; x++) {
      var x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), acc = 0, cnt = 0;
      for (var yy = y0; yy < y1 && yy < H; yy++) {
        var row = yy * W;
        for (var xx = x0; xx < x1 && xx < W; xx++) {
          var j = (row + xx) * 4, a = src[j + 3] / 255;
          acc += a * (0.2126 * src[j] + 0.7152 * src[j + 1] + 0.0722 * src[j + 2]) / 255 + (1 - a);
          cnt++;
        }
      }
      out[y * w + x] = cnt ? acc / cnt : 1;
    }
  }
  return out;
}

// The paper's brightness around every pixel: the brightest value in coarse blocks,
// spread one block each way so a dark passage still finds paper, then blended smoothly.
function paper(L, w, h) {
  var bs = Math.max(8, Math.round(Math.max(w, h) / 40));
  var gw = Math.ceil(w / bs), gh = Math.ceil(h / bs), g = new Float32Array(gw * gh), g2 = new Float32Array(gw * gh);
  var x, y, i;
  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) {
      var k = ((y / bs) | 0) * gw + ((x / bs) | 0), v = L[y * w + x];
      if (v > g[k]) { g[k] = v; }
    }
  }
  for (y = 0; y < gh; y++) {
    for (x = 0; x < gw; x++) {
      var m = 0;
      for (var yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++) {
        for (var xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++) { if (g[yy * gw + xx] > m) { m = g[yy * gw + xx]; } }
      }
      g2[y * gw + x] = m;
    }
  }
  var out = new Float32Array(w * h);
  for (y = 0; y < h; y++) {
    var gy = Math.max(0, Math.min(gh - 1, (y + 0.5) / bs - 0.5)), y0 = Math.floor(gy), y1 = Math.min(gh - 1, y0 + 1), fy = gy - y0;
    for (x = 0; x < w; x++) {
      var gx = Math.max(0, Math.min(gw - 1, (x + 0.5) / bs - 0.5)), x0 = Math.floor(gx), x1 = Math.min(gw - 1, x0 + 1), fx = gx - x0;
      out[y * w + x] = (g2[y0 * gw + x0] * (1 - fx) + g2[y0 * gw + x1] * fx) * (1 - fy) +
                       (g2[y1 * gw + x0] * (1 - fx) + g2[y1 * gw + x1] * fx) * fy;
    }
  }
  return out;
}
