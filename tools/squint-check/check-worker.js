/*
 * Squint & Check: the work that would freeze the page, run off the main thread.
 *
 * Messages in:
 *   { type:'reference', img:{width, height, data} }   RGBA bytes, kept for matching
 *   { type:'drawing',   img:{width, height, data} }
 *   { type:'lines', id, maxSide }                      the drawing's lines as a distance field
 *   { type:'match', id, rotationRange }                full search
 *   { type:'refine', id, P }                           snap from a placement {scale, theta, tx, ty}
 *   { type:'edges', id, which, maxSide }               'ref' or 'draw': the matcher's edges as a distance field
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
    else if (m.type === 'lines') {
      if (!drawImg) { throw new Error('No drawing yet'); }
      var f = lines(drawImg, m.maxSide || 1024);
      self.postMessage({ type: 'lines', id: m.id, field: f }, [f.data.buffer]);
    }
    else if (m.type === 'edges') {
      var img = m.which === 'ref' ? refImg : drawImg;
      if (!img) { throw new Error('No picture yet'); }
      var ef = edgeField(img, m.maxSide || 1024);
      self.postMessage({ type: 'edges', id: m.id, which: m.which, field: ef }, [ef.data.buffer]);
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

/* ------------------------------------------------------------------ lines */

var BIG = 1e20;

// The drawing's marks as lines: strokes thinned to one-pixel centre lines, and
// filled marks (shading, smudges) traced around their edge, since a filled shape's
// centre line is a tangle. Stored as the distance from every pixel to the nearest
// line: the page draws the line wherever that distance is under the chosen width,
// so it stays smooth at any zoom and any width.
// Four bytes per pixel:
//   R  distance to the nearest line, 0..maxD mapped to 0..255 (Outline, Hairline)
//   G  the ink with no cutoff, as the old Drawing matcher tinted it: how much darker
//      than the paper, ramping in from 0.05 over 0.35 (Tint)
//   B  that ink blurred a little, so a soft edge drawn from it is smooth (Soft)
//   A  255
function lines(img, maxSide) {
  var W = img.width, H = img.height, src = img.data;
  var k = Math.min(1, maxSide / Math.max(W, H));
  var w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k)), n = w * h;
  var L = luminance(src, W, H, w, h);
  var bg = paper(L, w, h);

  // Ink: how much darker than the local paper. Shadows across the page stay paper.
  var ink = new Float32Array(n), i;
  for (i = 0; i < n; i++) {
    var a = (bg[i] - L[i] - 0.04) / 0.28;
    ink[i] = a < 0 ? 0 : (a > 1 ? 1 : a);
  }

  // Hysteresis: strong marks seed, fainter marks count only where they touch one.
  // Small pieces are specks, dust or paper grain, so they go.
  var mask = new Uint8Array(n), seen = new Uint8Array(n);
  var stack = new Int32Array(n), members = new Int32Array(n);
  var minPix = Math.max(8, Math.round(n * 0.00002));
  for (i = 0; i < n; i++) {
    if (seen[i] || ink[i] < 0.45) { continue; }
    var sp = 0, mc = 0;
    stack[sp++] = i; seen[i] = 1;
    while (sp > 0) {
      var p = stack[--sp], px = p % w, py = (p - px) / w;
      members[mc++] = p;
      for (var ny = py - 1; ny <= py + 1; ny++) {
        if (ny < 0 || ny >= h) { continue; }
        for (var nx = px - 1; nx <= px + 1; nx++) {
          if (nx < 0 || nx >= w) { continue; }
          var q = ny * w + nx;
          if (!seen[q] && ink[q] >= 0.18) { seen[q] = 1; stack[sp++] = q; }
        }
      }
    }
    if (mc >= minPix) { for (var j = 0; j < mc; j++) { mask[members[j]] = 1; } }
  }

  var inkCount = 0, out = new Uint8Array(n * 4), soft = new Float32Array(n);
  for (i = 0; i < n; i++) {
    if (mask[i]) { inkCount++; }
    var t = (bg[i] - L[i] - 0.05) / 0.35;
    soft[i] = t < 0 ? 0 : (t > 1 ? 1 : t);
    out[i * 4 + 1] = Math.round(soft[i] * 255);
    out[i * 4 + 3] = 255;
  }
  soft = blur(soft, w, h, 1.0);
  for (i = 0; i < n; i++) { out[i * 4 + 2] = Math.round(Math.min(1, soft[i]) * 255); }

  // Tiny gaps inside shading would thin into knots of loops; fill them first.
  // The limit is small (about 8 px across) so real small circles, like an eye, survive.
  fillHoles(mask, w, h, Math.max(12, Math.round(n * 0.00008)));

  // Label each connected mark, thin a copy, then judge each mark by how thick it
  // gets at its thickest: pencil strokes run 2 to 4 px here, shading far more.
  var lab = new Int32Array(n), area = [0], nc = 0;
  for (i = 0; i < n; i++) {
    if (!mask[i] || lab[i]) { continue; }
    nc++; area.push(0);
    var sp2 = 0; stack[sp2++] = i; lab[i] = nc;
    while (sp2 > 0) {
      var p2 = stack[--sp2], x2 = p2 % w, y2 = (p2 - x2) / w;
      area[nc]++;
      for (var yy = y2 - 1; yy <= y2 + 1; yy++) {
        if (yy < 0 || yy >= h) { continue; }
        for (var xx = x2 - 1; xx <= x2 + 1; xx++) {
          if (xx < 0 || xx >= w) { continue; }
          var q2 = yy * w + xx;
          if (mask[q2] && !lab[q2]) { lab[q2] = nc; stack[sp2++] = q2; }
        }
      }
    }
  }
  var inner = new Float64Array(n);
  for (i = 0; i < n; i++) { inner[i] = mask[i] ? BIG : 0; }
  edt2d(inner, w, h);
  var thick = new Float64Array(nc + 1);
  for (i = 0; i < n; i++) { if (mask[i] && inner[i] > thick[lab[i]]) { thick[lab[i]] = inner[i]; } }
  var filled = new Uint8Array(nc + 1);
  for (var c = 1; c <= nc; c++) { filled[c] = Math.sqrt(thick[c]) > 5 ? 1 : 0; }
  var skel = new Uint8Array(mask);
  thin(skel, w, h);

  var f = new Float64Array(n), lineCount = 0;
  for (i = 0; i < n; i++) {
    var on = 0;
    if (mask[i]) {
      if (!filled[lab[i]]) { on = skel[i]; }
      else {
        var x3 = i % w, y3 = (i - x3) / w;
        on = (x3 === 0 || y3 === 0 || x3 === w - 1 || y3 === h - 1 ||
              !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) ? 1 : 0;
      }
    }
    if (on) { f[i] = 0; lineCount++; } else { f[i] = BIG; }
  }
  var maxD = 40;
  if (lineCount) { edt2d(f, w, h); }
  for (i = 0; i < n; i++) {
    var d = lineCount ? Math.sqrt(f[i]) : maxD;
    out[i * 4] = d >= maxD ? 255 : Math.round(d / maxD * 255);
  }
  return { w: w, h: h, maxD: maxD, data: out, ink: inkCount, lines: lineCount };
}

/* ------------------------------------------------------------------ edges */

// The Edges view, like the old Drawing matcher's: the matcher's own edge finder
// (blur, gradient, one-pixel ridges, faint and short pieces dropped), run on a
// finer copy than its 480px working size. The blur scales with the size so the
// edges keep the old view's structure, only placed more precisely.
// Four bytes per pixel: R, distance to the nearest edge (0..maxD mapped to 0..255);
// G, that edge's weight (strong and long edges near 1); B unused; A 255.
function edgeField(img, maxSide) {
  var W = img.width, H = img.height, k = Math.min(1, maxSide / Math.max(W, H));
  var w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k)), n = w * h, i;
  var L = luminance(img.data, W, H, w, h);
  var o = {}, key;
  for (key in ImageMatch.DEFAULTS) { o[key] = ImageMatch.DEFAULTS[key]; }
  var E = ImageMatch.detectEdges(L, w, h, 1.4 * Math.max(w, h) / 480 * 0.85, o);
  var f = new Float64Array(n), wt = new Float32Array(n);
  for (i = 0; i < n; i++) { f[i] = BIG; }
  for (i = 0; i < E.n; i++) { var p = (E.y[i] | 0) * w + (E.x[i] | 0); f[p] = 0; wt[p] = Math.max(wt[p], E.wt[i]); }
  var near = new Int32Array(n), maxD = 32, out = new Uint8Array(n * 4);
  if (E.n) { edt2dArg(f, near, w, h); }
  for (i = 0; i < n; i++) {
    var d = E.n ? Math.sqrt(f[i]) : maxD;
    out[i * 4] = d >= maxD ? 255 : Math.round(d / maxD * 255);
    out[i * 4 + 1] = E.n ? Math.round(wt[near[i]] * 255) : 0;
    out[i * 4 + 3] = 255;
  }
  return { w: w, h: h, maxD: maxD, data: out, edges: E.n };
}

// The distance transform again, also recording which edge pixel is nearest,
// so every pixel near a line knows how strong that line is.
function edt2dArg(f, near, w, h) {
  var n = Math.max(w, h), col = new Float64Array(n), d = new Float64Array(n), arg = new Int32Array(n);
  var v = new Int32Array(n), z = new Float64Array(n + 1), rowOf = new Int32Array(w * h), x, y;
  for (x = 0; x < w; x++) {
    for (y = 0; y < h; y++) { col[y] = f[y * w + x]; }
    edt1dArg(col, h, d, arg, v, z);
    for (y = 0; y < h; y++) { f[y * w + x] = d[y]; rowOf[y * w + x] = arg[y]; }
  }
  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) { col[x] = f[y * w + x]; }
    edt1dArg(col, w, d, arg, v, z);
    for (x = 0; x < w; x++) { f[y * w + x] = d[x]; near[y * w + x] = rowOf[y * w + arg[x]] * w + arg[x]; }
  }
}
function edt1dArg(f, n, d, arg, v, z) {
  var k = 0, q, s;
  v[0] = 0; z[0] = -BIG; z[1] = BIG;
  for (q = 1; q < n; q++) {
    s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = BIG;
  }
  k = 0;
  for (q = 0; q < n; q++) {
    while (z[k + 1] < q) { k++; }
    var dq = q - v[k];
    d[q] = dq * dq + f[v[k]]; arg[q] = v[k];
  }
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

// Separable Gaussian blur.
function blur(src, w, h, sigma) {
  var r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1), s = 0, i, x, y;
  for (i = -r; i <= r; i++) { k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); s += k[i + r]; }
  for (i = 0; i < k.length; i++) { k[i] /= s; }
  var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) {
      var acc = 0;
      for (i = -r; i <= r; i++) { var xx = x + i < 0 ? 0 : (x + i >= w ? w - 1 : x + i); acc += k[i + r] * src[y * w + xx]; }
      tmp[y * w + x] = acc;
    }
  }
  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) {
      var acc2 = 0;
      for (i = -r; i <= r; i++) { var yy = y + i < 0 ? 0 : (y + i >= h ? h - 1 : y + i); acc2 += k[i + r] * tmp[yy * w + x]; }
      out[y * w + x] = acc2;
    }
  }
  return out;
}

// Gaps in the mask that don't reach the border and are smaller than maxArea become ink.
function fillHoles(m, w, h, maxArea) {
  var n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n), members = new Int32Array(n), i;
  for (i = 0; i < n; i++) {
    if (m[i] || seen[i]) { continue; }
    var sp = 0, mc = 0, border = false;
    stack[sp++] = i; seen[i] = 1;
    while (sp > 0) {
      var p = stack[--sp], x = p % w, y = (p - x) / w;
      if (mc < n) { members[mc++] = p; }
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { border = true; }
      if (x > 0 && !m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && !m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && !m[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && !m[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (!border && mc <= maxArea) { for (var j = 0; j < mc; j++) { m[members[j]] = 1; } }
  }
}

// Zhang-Suen thinning: peel a mask down to one-pixel centre lines, keeping them connected.
function thin(m, w, h) {
  var x, y, i;
  for (x = 0; x < w; x++) { m[x] = 0; m[(h - 1) * w + x] = 0; }
  for (y = 0; y < h; y++) { m[y * w] = 0; m[y * w + w - 1] = 0; }
  var list = [], del = [];
  for (i = 0; i < w * h; i++) { if (m[i]) { list.push(i); } }
  var changed = true;
  while (changed) {
    changed = false;
    for (var pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (var li = 0; li < list.length; li++) {
        i = list[li];
        if (!m[i]) { continue; }
        var p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1];
        var p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
        var B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) { continue; }
        var A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
        if (A !== 1) { continue; }
        if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) { continue; }
        del.push(i);
      }
      for (var d = 0; d < del.length; d++) { m[del[d]] = 0; }
      if (del.length) { changed = true; }
    }
    var keep = [];
    for (var lj = 0; lj < list.length; lj++) { if (m[list[lj]]) { keep.push(list[lj]); } }
    list = keep;
  }
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), squared distances in place.
function edt1d(f, n, d, v, z) {
  var k = 0, q, s;
  v[0] = 0; z[0] = -BIG; z[1] = BIG;
  for (q = 1; q < n; q++) {
    s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = BIG;
  }
  k = 0;
  for (q = 0; q < n; q++) {
    while (z[k + 1] < q) { k++; }
    var dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}
function edt2d(f, w, h) {
  var n = Math.max(w, h), col = new Float64Array(n), d = new Float64Array(n);
  var v = new Int32Array(n), z = new Float64Array(n + 1), x, y;
  for (x = 0; x < w; x++) {
    for (y = 0; y < h; y++) { col[y] = f[y * w + x]; }
    edt1d(col, h, d, v, z);
    for (y = 0; y < h; y++) { f[y * w + x] = d[y]; }
  }
  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) { col[x] = f[y * w + x]; }
    edt1d(col, w, d, v, z);
    for (x = 0; x < w; x++) { f[y * w + x] = d[x]; }
  }
}
