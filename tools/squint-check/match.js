/*!
 * ImageMatch v0.1
 * Dependency-free alignment of a drawing (B) onto a reference (A).
 *
 * The only transform allowed is rotation + uniform scale + translation, so the
 * drawing's own proportion errors survive the alignment and can be measured.
 *
 * Written in plain ES5 with typed arrays and no platform APIs so it can be
 * ported line-for-line to Swift, Kotlin, C or C#. No canvas, no DOM, no workers.
 *
 * Usage:
 *   var r = ImageMatch.match(imageDataA, imageDataB, options);
 *   ctx.drawImage(refImage, 0, 0);
 *   ctx.setTransform.apply(ctx, r.matrix);   // [a, b, c, d, e, f]
 *   ctx.drawImage(drawingImage, 0, 0);       // drawing now sits on the reference
 *
 * Images are {width, height, data}: RGBA bytes (like canvas ImageData) or one
 * gray value per pixel (bytes 0..255 or floats 0..1). Transparent pixels count as white paper.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.ImageMatch = api; }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    levelSizes: [72, 180, 480], // long side in px of the coarse, mid and fine working images
    rotationRange: 30,          // search +/- this many degrees (180 = any rotation)
    scaleRange: 2,              // search the initial size guess divided/multiplied by this
    orientationBins: 8,         // edges only match edges of similar direction
    coarsePoints: 140,          // drawing points used in the brute-force search
    midPoints: 450,
    finePoints: 1200,
    reverseWeight: 0.5,         // reference->drawing term; lower it (~0.15) for unfinished drawings
    edgeThreshold: 0.2,         // keep edges stronger than this fraction of the strong-edge level
    minStroke: 0.025,           // drop connected edge pieces shorter than this x long side
    borderMargin: 0.012,        // ignore edges this close to the image border (x long side)
    candidates: 6,              // hypotheses carried from the coarse search into refinement
    grid: 4                     // proportion map uses grid x grid cells
  };

  var PI = Math.PI;
  var BIG = 1e20;

  function merge(opts) {
    var o = {}, k;
    for (k in DEFAULTS) { o[k] = DEFAULTS[k]; }
    if (opts) { for (k in opts) { if (opts[k] !== undefined) { o[k] = opts[k]; } } }
    return o;
  }
  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function mod(a, n) { a = a % n; return a < 0 ? a + n : a; }

  /* ---------------------------------------------------------------- pixels */

  function toGray(img) {
    var w = img.width, h = img.height, d = img.data, n = w * h;
    var g = new Float32Array(n), i;
    if (d.length === n) {
      var isFloat = (typeof Float32Array !== 'undefined' && d instanceof Float32Array) ||
                    (typeof Float64Array !== 'undefined' && d instanceof Float64Array);
      for (i = 0; i < n; i++) { g[i] = isFloat ? d[i] : d[i] / 255; }
    } else {
      for (i = 0; i < n; i++) {
        var j = i * 4, a = d[j + 3] / 255;
        var l = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
        g[i] = a * l + (1 - a);
      }
    }
    return { w: w, h: h, g: g };
  }

  // Area-average resample of the source rect (rx, ry, rw, rh) into nw x nh.
  // Anything outside the source reads as `fill` (white paper).
  function resample(src, sw, sh, rx, ry, rw, rh, nw, nh, fill) {
    var sx = rw / nw, sy = rh / nh;
    var yA = Math.floor(ry), yB = Math.ceil(ry + rh), th = yB - yA;
    var tmp = new Float32Array(nw * th), out = new Float32Array(nw * nh);
    var x, y, i, j;
    for (x = 0; x < nw; x++) {
      var x0 = rx + x * sx, x1 = x0 + sx, i0 = Math.floor(x0), i1 = Math.ceil(x1);
      for (var yy = 0; yy < th; yy++) {
        y = yA + yy;
        var rowOk = y >= 0 && y < sh, row = y * sw, acc = 0;
        for (i = i0; i < i1; i++) {
          var a = x0 > i ? x0 : i, b = x1 < i + 1 ? x1 : i + 1;
          if (b <= a) { continue; }
          acc += ((rowOk && i >= 0 && i < sw) ? src[row + i] : fill) * (b - a);
        }
        tmp[yy * nw + x] = acc / sx;
      }
    }
    for (y = 0; y < nh; y++) {
      var y0 = ry + y * sy, y1 = y0 + sy, j0 = Math.floor(y0), j1 = Math.ceil(y1);
      for (x = 0; x < nw; x++) {
        var acc2 = 0;
        for (j = j0; j < j1; j++) {
          var a2 = y0 > j ? y0 : j, b2 = y1 < j + 1 ? y1 : j + 1;
          if (b2 <= a2) { continue; }
          acc2 += tmp[(j - yA) * nw + x] * (b2 - a2);
        }
        out[y * nw + x] = acc2 / sy;
      }
    }
    return out;
  }

  function blur(src, w, h, sigma) {
    var n = w * h, out = new Float32Array(n);
    if (sigma <= 0) { for (var q = 0; q < n; q++) { out[q] = src[q]; } return out; }
    var r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1), s = 0, i, x, y;
    for (i = -r; i <= r; i++) { k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); s += k[i + r]; }
    for (i = 0; i < k.length; i++) { k[i] /= s; }
    var tmp = new Float32Array(n);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var acc = 0;
        for (i = -r; i <= r; i++) {
          var xx = x + i; if (xx < 0) { xx = 0; } else if (xx >= w) { xx = w - 1; }
          acc += k[i + r] * src[y * w + xx];
        }
        tmp[y * w + x] = acc;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var acc2 = 0;
        for (i = -r; i <= r; i++) {
          var yy = y + i; if (yy < 0) { yy = 0; } else if (yy >= h) { yy = h - 1; }
          acc2 += k[i + r] * tmp[yy * w + x];
        }
        out[y * w + x] = acc2;
      }
    }
    return out;
  }

  /* ----------------------------------------------------------------- edges */

  // Returns thin, de-noised edges. Each edge pixel carries a weight that favours
  // strong contrast and long connected strokes, so the strongest structure wins.
  function detectEdges(img, w, h, sigma, o) {
    var g = blur(img, w, h, sigma);
    var n = w * h, mag = new Float32Array(n), ori = new Float32Array(n);
    var x, y, i, longSide = Math.max(w, h);
    var bm = Math.max(1, Math.round(o.borderMargin * longSide));

    for (y = 1; y < h - 1; y++) {
      for (x = 1; x < w - 1; x++) {
        i = y * w + x;
        var a00 = g[i - w - 1], a01 = g[i - w], a02 = g[i - w + 1];
        var a10 = g[i - 1], a12 = g[i + 1];
        var a20 = g[i + w - 1], a21 = g[i + w], a22 = g[i + w + 1];
        var gx = (a02 + 2 * a12 + a22 - a00 - 2 * a10 - a20) * 0.125;
        var gy = (a20 + 2 * a21 + a22 - a00 - 2 * a01 - a02) * 0.125;
        mag[i] = Math.sqrt(gx * gx + gy * gy);
        var t = Math.atan2(gy, gx);
        if (t < 0) { t += PI; }
        if (t >= PI) { t -= PI; }
        ori[i] = t;
      }
    }

    // Non-maximum suppression: keep only the ridge of each edge (1 px wide).
    var keep = new Uint8Array(n), maxM = 0, kept = 0;
    for (y = bm; y < h - bm; y++) {
      for (x = bm; x < w - bm; x++) {
        i = y * w + x;
        var m = mag[i];
        if (m < 1e-3) { continue; }
        var t2 = ori[i], dx, dy;
        if (t2 < PI / 8 || t2 >= 7 * PI / 8) { dx = 1; dy = 0; }
        else if (t2 < 3 * PI / 8) { dx = 1; dy = 1; }
        else if (t2 < 5 * PI / 8) { dx = 0; dy = 1; }
        else { dx = -1; dy = 1; }
        if (m >= mag[i + dy * w + dx] && m > mag[i - dy * w - dx]) {
          keep[i] = 1; kept++;
          if (m > maxM) { maxM = m; }
        }
      }
    }

    // Strong-edge level = 95th percentile of surviving magnitudes (histogram).
    var strong = maxM;
    if (kept > 0 && maxM > 0) {
      var hist = new Float64Array(512);
      for (i = 0; i < n; i++) { if (keep[i]) { hist[Math.min(511, (mag[i] / maxM * 511) | 0)] += 1; } }
      var target = kept * 0.95, acc = 0;
      for (var b = 0; b < 512; b++) { acc += hist[b]; if (acc >= target) { strong = (b + 1) / 512 * maxM; break; } }
    }
    var thr = Math.max(o.edgeThreshold * strong, 0.006);
    for (i = 0; i < n; i++) { if (keep[i] && mag[i] < thr) { keep[i] = 0; } }

    // Connected pieces (gaps up to 1 px bridged). Short pieces are specks/texture: drop them.
    var minLen = Math.max(2, Math.round(o.minStroke * longSide));
    var refLen = Math.max(minLen + 1, 0.12 * longSide);
    var comp = new Int32Array(n), seen = new Uint8Array(n);
    var stack = new Int32Array(n), members = new Int32Array(n);
    for (i = 0; i < n; i++) {
      if (!keep[i] || seen[i]) { continue; }
      var sp = 0, mc = 0;
      stack[sp++] = i; seen[i] = 1;
      while (sp > 0) {
        var p = stack[--sp];
        members[mc++] = p;
        var px = p % w, py = (p - px) / w;
        for (var ny = py - 2; ny <= py + 2; ny++) {
          if (ny < 0 || ny >= h) { continue; }
          for (var nx = px - 2; nx <= px + 2; nx++) {
            if (nx < 0 || nx >= w) { continue; }
            var q = ny * w + nx;
            if (keep[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
          }
        }
      }
      for (var k = 0; k < mc; k++) {
        if (mc < minLen) { keep[members[k]] = 0; } else { comp[members[k]] = mc; }
      }
    }

    var bins = o.orientationBins, binW = PI / bins, count = 0;
    for (i = 0; i < n; i++) { if (keep[i]) { count++; } }
    var ex = new Float32Array(count), ey = new Float32Array(count);
    var eb = new Float32Array(count), ew = new Float32Array(count), e = 0;
    for (i = 0; i < n; i++) {
      if (!keep[i]) { continue; }
      ex[e] = i % w; ey[e] = (i / w) | 0; eb[e] = ori[i] / binW;
      ew[e] = Math.min(1, mag[i] / strong) * Math.min(1, comp[i] / refLen);
      e++;
    }
    return { n: count, x: ex, y: ey, b: eb, wt: ew };
  }

  // Weighted percentile box of the edges (robust to a few stray marks).
  function weightedBox(E, w, h, lo, hi) {
    var cx = new Float64Array(w), cy = new Float64Array(h), tot = 0, i;
    for (i = 0; i < E.n; i++) { cx[E.x[i] | 0] += E.wt[i]; cy[E.y[i] | 0] += E.wt[i]; tot += E.wt[i]; }
    if (tot <= 0) { return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }; }
    return { x0: pct(cx, tot, lo), x1: pct(cx, tot, hi), y0: pct(cy, tot, lo), y1: pct(cy, tot, hi) };
  }
  function pct(hist, tot, q) {
    var t = tot * q, acc = 0;
    for (var i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= t) { return i; } }
    return hist.length - 1;
  }

  /* ------------------------------------------------------ distance transform */

  // Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
  function edt1d(f, n, d, v, z) {
    var k = 0, q, s;
    v[0] = 0; z[0] = -BIG; z[1] = BIG;
    for (q = 1; q < n; q++) {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
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
  // One distance map per orientation channel. Channel c holds edges whose
  // direction is within one bin of c, so a point only "snaps" to similar edges.
  function buildDT(E, w, h, bins, maxD) {
    var n = w * h, dt = new Float32Array(bins * n), f = new Float64Array(n), i, c;
    for (c = 0; c < bins; c++) {
      for (i = 0; i < n; i++) { f[i] = BIG; }
      var any = false;
      for (i = 0; i < E.n; i++) {
        var b = mod(Math.round(E.b[i]), bins);
        if (mod(b - c + 1, bins) <= 2) { f[(E.y[i] | 0) * w + (E.x[i] | 0)] = 0; any = true; }
      }
      var off = c * n;
      if (!any) { for (i = 0; i < n; i++) { dt[off + i] = maxD; } continue; }
      edt2d(f, w, h);
      for (i = 0; i < n; i++) { var dd = Math.sqrt(f[i]); dt[off + i] = dd < maxD ? dd : maxD; }
    }
    return dt;
  }

  /* --------------------------------------------------------------- sampling */

  // Spread points over the image: keep the strongest edge pixel in each grid cell.
  function samplePoints(E, w, h, N) {
    var idx = [], i;
    if (N <= 0 || E.n === 0) { idx = []; }
    else if (E.n <= N) { for (i = 0; i < E.n; i++) { idx.push(i); } }
    else {
      var c = 1;
      for (;;) {
        var cw = Math.ceil(w / c), ch = Math.ceil(h / c), best = new Int32Array(cw * ch);
        for (i = 0; i < best.length; i++) { best[i] = -1; }
        for (i = 0; i < E.n; i++) {
          var cell = ((E.y[i] / c) | 0) * cw + ((E.x[i] / c) | 0), bi = best[cell];
          if (bi < 0 || E.wt[i] > E.wt[bi]) { best[cell] = i; }
        }
        idx = [];
        for (i = 0; i < best.length; i++) { if (best[i] >= 0) { idx.push(best[i]); } }
        if (idx.length <= N * 1.1) { break; }
        c += Math.max(1, Math.floor(c * 0.3));
      }
    }
    idx.sort(function (a, b) { return E.wt[b] - E.wt[a]; });
    var m = idx.length, P = { n: m, x: new Float32Array(m), y: new Float32Array(m),
      b: new Float32Array(m), wt: new Float32Array(m), wsum: 0 };
    for (i = 0; i < m; i++) {
      var j = idx[i];
      P.x[i] = E.x[j]; P.y[i] = E.y[j]; P.b[i] = E.b[j]; P.wt[i] = E.wt[j]; P.wsum += E.wt[j];
    }
    return P;
  }

  /* ----------------------------------------------------------------- levels */

  function makeSide(G, rect, size, sigma, o, nPts, withDT, maxD) {
    var k = size / Math.max(rect.w, rect.h);
    var w = Math.max(8, Math.round(rect.w * k)), h = Math.max(8, Math.round(rect.h * k));
    var img = resample(G.g, G.w, G.h, rect.x, rect.y, w / k, h / k, w, h, 1.0);
    var E = detectEdges(img, w, h, sigma, o);
    var side = { k: k, ox: rect.x, oy: rect.y, w: w, h: h, edges: E };
    side.pts = samplePoints(E, w, h, nPts);
    if (withDT) { side.dt = buildDT(E, w, h, o.orientationBins, maxD); }
    return side;
  }

  // Robust content box in original pixels, from a quick preview.
  function contentBox(G, o) {
    var s = makeSide(G, { x: 0, y: 0, w: G.w, h: G.h }, 256, 1.0, o, 0, false, 0);
    var bx = weightedBox(s.edges, s.w, s.h, 0.03, 0.97);
    return { x0: (bx.x0 + 0.5) / s.k, y0: (bx.y0 + 0.5) / s.k, x1: (bx.x1 + 0.5) / s.k, y1: (bx.y1 + 0.5) / s.k,
      edges: s.edges.n };
  }

  function prepare(imgA, imgB, opts) {
    var o = merge(opts), t0 = now();
    var GA = toGray(imgA), GB = toGray(imgB);
    var boxA = contentBox(GA, o), boxB = contentBox(GB, o);
    // Crop the drawing around its content so a small sketch on a big page still gets pixels.
    var bw = boxB.x1 - boxB.x0, bh = boxB.y1 - boxB.y0, pad = 0.02 * Math.max(GB.w, GB.h);
    var cx0 = Math.max(0, boxB.x0 - 0.12 * bw - pad), cy0 = Math.max(0, boxB.y0 - 0.12 * bh - pad);
    var cx1 = Math.min(GB.w, boxB.x1 + 0.12 * bw + pad), cy1 = Math.min(GB.h, boxB.y1 + 0.12 * bh + pad);
    if (cx1 - cx0 < 0.05 * GB.w || cy1 - cy0 < 0.05 * GB.h) { cx0 = 0; cy0 = 0; cx1 = GB.w; cy1 = GB.h; }
    var crop = { x: Math.floor(cx0), y: Math.floor(cy0), w: Math.ceil(cx1) - Math.floor(cx0), h: Math.ceil(cy1) - Math.floor(cy0) };

    var sigmas = [0.8, 1.0, 1.4], pts = [o.coarsePoints, o.midPoints, o.finePoints], levels = [];
    for (var li = 0; li < 3; li++) {
      var size = o.levelSizes[li], maxD = 0.05 * size + 2;
      var LA = makeSide(GA, { x: 0, y: 0, w: GA.w, h: GA.h }, size, sigmas[li], o, li === 0 ? 0 : pts[li], true, maxD);
      var LB = makeSide(GB, crop, size, sigmas[li], o, pts[li], li > 0, maxD);
      LB.box = { x0: (boxB.x0 - crop.x) * LB.k - 0.5, y0: (boxB.y0 - crop.y) * LB.k - 0.5,
                 x1: (boxB.x1 - crop.x) * LB.k - 0.5, y1: (boxB.y1 - crop.y) * LB.k - 0.5 };
      LB.cx = 0.5 * (LB.box.x0 + LB.box.x1); LB.cy = 0.5 * (LB.box.y0 + LB.box.y1);
      LA.box = { x0: boxA.x0 * LA.k - 0.5, y0: boxA.y0 * LA.k - 0.5, x1: boxA.x1 * LA.k - 0.5, y1: boxA.y1 * LA.k - 0.5 };
      levels.push({ A: LA, B: LB, size: size });
    }
    return { o: o, A: { w: GA.w, h: GA.h }, B: { w: GB.w, h: GB.h }, crop: crop, boxA: boxA, boxB: boxB,
      levels: levels, prepareMs: now() - t0 };
  }

  /* ------------------------------------------------------------ transforms */
  // Canonical params P = {scale, theta, tx, ty}: pA = scale * R(theta) * pB + t, in original pixels.
  // Level pose p = {s, th, tx, ty} does the same in a level's pixel-centre coordinates.

  function toLevel(P, L) {
    var A = L.A, B = L.B, c = Math.cos(P.theta), sn = Math.sin(P.theta);
    var s = A.k * P.scale / B.k;
    return { s: s, th: P.theta,
      tx: A.k * (P.scale * (c * B.ox - sn * B.oy) + P.tx - A.ox) + s * (c * 0.5 - sn * 0.5) - 0.5,
      ty: A.k * (P.scale * (sn * B.ox + c * B.oy) + P.ty - A.oy) + s * (sn * 0.5 + c * 0.5) - 0.5 };
  }
  function fromLevel(p, L) {
    var A = L.A, B = L.B, c = Math.cos(p.th), sn = Math.sin(p.th), S = p.s * B.k / A.k;
    return { scale: S, theta: p.th,
      tx: (p.tx - p.s * (c * 0.5 - sn * 0.5) + 0.5) / A.k - S * (c * B.ox - sn * B.oy) + A.ox,
      ty: (p.ty - p.s * (sn * 0.5 + c * 0.5) + 0.5) / A.k - S * (sn * B.ox + c * B.oy) + A.oy };
  }
  // Pose around the drawing's content centre: q = [mx, my, theta, log scale].
  function poseToQ(p, B) {
    var c = Math.cos(p.th), sn = Math.sin(p.th);
    return [p.s * (c * B.cx - sn * B.cy) + p.tx, p.s * (sn * B.cx + c * B.cy) + p.ty, p.th, Math.log(p.s)];
  }
  function qToPose(q, B) {
    var s = Math.exp(q[3]), c = Math.cos(q[2]), sn = Math.sin(q[2]);
    return { s: s, th: q[2], tx: q[0] - s * (c * B.cx - sn * B.cy), ty: q[1] - s * (sn * B.cx + c * B.cy) };
  }

  /* ------------------------------------------------------------------ costs */

  function dtAt(dt, W, H, off, x, y, cap) {
    if (x < 0 || y < 0 || x > W - 1 || y > H - 1) { return cap; }
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    var x1 = x0 < W - 1 ? x0 + 1 : x0, y1 = y0 < H - 1 ? y0 + 1 : y0;
    var r0 = off + y0 * W, r1 = off + y1 * W;
    var v = (dt[r0 + x0] * (1 - fx) + dt[r0 + x1] * fx) * (1 - fy) +
            (dt[r1 + x0] * (1 - fx) + dt[r1 + x1] * fx) * fy;
    return v < cap ? v : cap;
  }

  // Truncated, direction-aware chamfer cost in [0, 1]. Truncation is what makes it
  // robust: a stray mark or missing part can only cost `tau`, never drag the fit.
  function poseCost(L, p, tau, lambda, bins) {
    var A = L.A, B = L.B, P = B.pts, c = Math.cos(p.th), sn = Math.sin(p.th), s = p.s;
    var rot = p.th / (PI / bins), WH = A.w * A.h, sum = 0, i;
    for (i = 0; i < P.n; i++) {
      var x = P.x[i], y = P.y[i];
      var X = s * (c * x - sn * y) + p.tx, Y = s * (sn * x + c * y) + p.ty;
      var ch = mod(Math.round(P.b[i] + rot), bins);
      sum += P.wt[i] * dtAt(A.dt, A.w, A.h, ch * WH, X, Y, tau);
    }
    var fwd = P.wsum > 0 ? sum / (P.wsum * tau) : 1;
    if (!(lambda > 0) || !B.dt || A.pts.n === 0) { return fwd; }
    // Reverse term: reference edges that fall inside the drawing's area should be drawn.
    // Measured in the drawing's own pixels, so shrinking the drawing to a speck never pays off.
    var Q = A.pts, inv = 1 / s, bx = B.box, WHb = B.w * B.h, rsum = 0, rw = 0;
    var mx = 0.05 * (bx.x1 - bx.x0), my = 0.05 * (bx.y1 - bx.y0);
    for (i = 0; i < Q.n; i++) {
      var u = Q.x[i] - p.tx, v = Q.y[i] - p.ty;
      var xb = inv * (c * u + sn * v), yb = inv * (-sn * u + c * v);
      if (xb < bx.x0 - mx || xb > bx.x1 + mx || yb < bx.y0 - my || yb > bx.y1 + my) { continue; }
      var ch2 = mod(Math.round(Q.b[i] - rot), bins);
      rsum += Q.wt[i] * dtAt(B.dt, B.w, B.h, ch2 * WHb, xb, yb, tau);
      rw += Q.wt[i];
    }
    var rev = rw > 0 ? rsum / (rw * tau) : 1;
    return (fwd + lambda * rev) / (1 + lambda);
  }

  /* ----------------------------------------------------------------- search */

  // Brute force over rotation x scale x position on the coarse level.
  // Poses closest to the initial guess go first; each scale band keeps its own
  // shortlist, and positions that cannot beat that shortlist are abandoned early.
  function coarseSearch(prep) {
    var o = prep.o, L = prep.levels[0], A = L.A, B = L.B, P = B.pts, bins = o.orientationBins;
    var W = A.w, H = A.h, WH = W * H, dt = A.dt, n = P.n, binW = PI / bins, i;
    var tau = Math.max(2, 0.035 * L.size);
    var R = 0.5 * Math.sqrt(Math.pow(B.box.x1 - B.box.x0, 2) + Math.pow(B.box.y1 - B.box.y0, 2)) + 1;
    var dA = Math.sqrt(Math.pow(A.box.x1 - A.box.x0, 2) + Math.pow(A.box.y1 - A.box.y0, 2)) + 1;
    var s0 = dA / (2 * R), reach = R * s0, move = 1.6;

    var thetas = [], lss = [];
    var dth = Math.max(Math.atan2(move, reach), 0.5 * PI / 180);
    if (o.rotationRange >= 180) {
      var nFull = Math.ceil(2 * PI / dth);
      dth = 2 * PI / nFull;
      for (i = 0; i < nFull; i++) { thetas.push(-PI + i * dth); }
    } else {
      var rng = o.rotationRange * PI / 180, nT = Math.max(1, Math.ceil(rng / dth));
      dth = rng / nT;
      for (i = -nT; i <= nT; i++) { thetas.push(i * dth); }
    }
    var lr = Math.log(Math.max(1.0001, o.scaleRange)), dls = Math.max(move / reach, 0.012);
    var nS = Math.max(1, Math.ceil(lr / dls));
    dls = lr / nS;
    for (i = -nS; i <= nS; i++) { lss.push(i * dls); }

    // Visit poses nearest the guess (no rotation, guessed size) first.
    var order = [];
    for (var a = 0; a < thetas.length; a++) {
      for (var b = 0; b < lss.length; b++) {
        var ta = Math.abs(mod(thetas[a] + PI, 2 * PI) - PI) / dth;
        order.push({ a: a, b: b, key: ta + Math.abs(lss[b]) / dls });
      }
    }
    order.sort(function (p, q) { return p.key - q.key; });

    var BANDS = 4, KEEP = Math.max(3, o.candidates), bandLists = [];
    for (i = 0; i < BANDS; i++) { bandLists.push([]); }
    function bandOf(bi) { return Math.min(BANDS - 1, Math.floor(bi / lss.length * BANDS)); }
    function bound(list) { return list.length < KEEP ? Infinity : list[list.length - 1].sum; }
    function insert(list, c) {
      var k = list.length;
      list.push(c);
      while (k > 0 && list[k - 1].sum > c.sum) { list[k] = list[k - 1]; k--; }
      list[k] = c;
      if (list.length > KEEP * 3) { list.pop(); }
    }

    var rx = new Int32Array(n), ry = new Int32Array(n), off = new Int32Array(n), wt = P.wt;
    var margin = Math.round(0.15 * Math.max(W, H));
    function evalAt(mx, my, limit) {
      var sum = 0;
      for (var j = 0; j < n; j++) {
        var xx = rx[j] + mx, yy = ry[j] + my, d;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) { d = tau; }
        else { d = dt[off[j] + yy * W + xx]; if (d > tau) { d = tau; } }
        sum += wt[j] * d;
        if (sum >= limit) { return sum; }
      }
      return sum;
    }
    for (var oi = 0; oi < order.length; oi++) {
      var th = thetas[order[oi].a], bi = order[oi].b, list = bandLists[bandOf(bi)];
      var c = Math.cos(th), sn = Math.sin(th), s = s0 * Math.exp(lss[bi]);
      for (i = 0; i < n; i++) {
        var dx = P.x[i] - B.cx, dy = P.y[i] - B.cy;
        rx[i] = Math.round(s * (c * dx - sn * dy));
        ry[i] = Math.round(s * (sn * dx + c * dy));
        off[i] = mod(Math.round(P.b[i] + th / binW), bins) * WH;
      }
      // Anything worse than this band's shortlist (with slack) is not worth finishing.
      var cap = bound(list) * 1.15, best = cap, bmx = 0, bmy = 0, mx, my, v, found = false;
      for (my = -margin; my < H + margin; my += 2) {
        for (mx = -margin; mx < W + margin; mx += 2) {
          v = evalAt(mx, my, best);
          if (v < best) { best = v; bmx = mx; bmy = my; found = true; }
        }
      }
      if (!found) { continue; }
      var cx = bmx, cy = bmy;
      for (my = cy - 1; my <= cy + 1; my++) {
        for (mx = cx - 1; mx <= cx + 1; mx++) {
          if (mx === cx && my === cy) { continue; }
          v = evalAt(mx, my, best);
          if (v < best) { best = v; bmx = mx; bmy = my; }
        }
      }
      insert(list, { th: th, ls: Math.log(s), mx: bmx, my: bmy, sum: best, cost: best / (P.wsum * tau) });
    }

    // Merge: overall best hypotheses plus the best of every scale band, without near-duplicates.
    var all = [];
    for (i = 0; i < BANDS; i++) { all = all.concat(bandLists[i]); }
    all.sort(function (p, q) { return p.cost - q.cost; });
    function isDup(cd, kept) {
      for (var k = 0; k < kept.length; k++) {
        var kp = kept[k], dAng = Math.abs(mod(cd.th - kp.th + PI, 2 * PI) - PI);
        if (dAng < 2.5 * dth && Math.abs(cd.ls - kp.ls) < 2.5 * dls &&
            Math.abs(cd.mx - kp.mx) + Math.abs(cd.my - kp.my) < 5) { return true; }
      }
      return false;
    }
    var kept = [];
    for (i = 0; i < all.length && kept.length < o.candidates; i++) { if (!isDup(all[i], kept)) { kept.push(all[i]); } }
    for (var bb = 0; bb < BANDS; bb++) {
      var bl = bandLists[bb];
      for (i = 0; i < bl.length; i++) { if (!isDup(bl[i], kept)) { kept.push(bl[i]); break; } }
    }
    return { cands: kept, dth: dth, dls: dls, poses: order.length,
      lsMin: Math.log(s0) - lr - 0.15, lsMax: Math.log(s0) + lr + 0.15 };
  }

  // Compass search on [mx, my, theta, log scale]. Local, derivative-free, portable.
  function localRefine(L, pose, tau, lambda, steps, bins, lsLim) {
    var B = L.B, q = poseToQ(pose, B), st = steps.slice(), best = poseCost(L, pose, tau, lambda, bins);
    for (var it = 0; it < 400; it++) {
      var improved = false;
      for (var d = 0; d < 4; d++) {
        for (var sg = -1; sg <= 1; sg += 2) {
          var old = q[d];
          q[d] = old + sg * st[d];
          if (d === 3 && lsLim && (q[3] < lsLim[0] || q[3] > lsLim[1])) { q[d] = old; continue; }
          var c = poseCost(L, qToPose(q, B), tau, lambda, bins);
          if (c < best - 1e-7) { best = c; improved = true; } else { q[d] = old; }
        }
      }
      if (!improved) {
        for (var e = 0; e < 4; e++) { st[e] *= 0.5; }
        if (st[0] < 0.05) { break; }
      }
    }
    return { pose: qToPose(q, B), cost: best };
  }

  function inlierFraction(L, pose, bins) {
    var A = L.A, P = L.B.pts, c = Math.cos(pose.th), sn = Math.sin(pose.th), s = pose.s;
    var rot = pose.th / (PI / bins), WH = A.w * A.h, lim = Math.max(1.5, 0.01 * L.size), inW = 0;
    for (var i = 0; i < P.n; i++) {
      var X = s * (c * P.x[i] - sn * P.y[i]) + pose.tx, Y = s * (sn * P.x[i] + c * P.y[i]) + pose.ty;
      var ch = mod(Math.round(P.b[i] + rot), bins);
      if (dtAt(A.dt, A.w, A.h, ch * WH, X, Y, 1e9) <= lim) { inW += P.wt[i]; }
    }
    return P.wsum > 0 ? inW / P.wsum : 0;
  }

  function fineStages(prep, P, startScale, lsLim) {
    var o = prep.o, bins = o.orientationBins, L1 = prep.levels[1], L2 = prep.levels[2];
    var lam = o.reverseWeight, f = startScale || 1;
    var p1 = toLevel(P, L1);
    var r1 = localRefine(L1, p1, Math.max(2.5, 0.025 * L1.size), lam, [2 * f, 2 * f, 0.02 * f, 0.02 * f], bins, lsLim);
    var p2 = toLevel(fromLevel(r1.pose, L1), L2);
    var r2 = localRefine(L2, p2, 0.022 * L2.size, lam, [2, 2, 0.006, 0.006], bins, lsLim);
    var r3 = localRefine(L2, r2.pose, Math.max(3, 0.011 * L2.size), lam, [1, 1, 0.003, 0.003], bins, lsLim);
    return { P: fromLevel(r3.pose, L2), cost: r3.cost, midCost: r1.cost, quality: inlierFraction(L2, r3.pose, bins) };
  }

  function search(prep) {
    var t0 = now(), o = prep.o, L0 = prep.levels[0], L1 = prep.levels[1], bins = o.orientationBins, i;
    if (L0.B.pts.n < 8 || L0.A.edges.n < 8) {
      return finish(null, { error: 'Not enough edges found in ' + (L0.B.pts.n < 8 ? 'the drawing' : 'the reference') });
    }
    var cs = coarseSearch(prep), mids = [], lsLim = [cs.lsMin, cs.lsMax];
    for (i = 0; i < cs.cands.length; i++) {
      var cd = cs.cands[i], s = Math.exp(cd.ls), c = Math.cos(cd.th), sn = Math.sin(cd.th), B = L0.B;
      var pose = { s: s, th: cd.th, tx: cd.mx - s * (c * B.cx - sn * B.cy), ty: cd.my - s * (sn * B.cx + c * B.cy) };
      var P0 = fromLevel(pose, L0);
      var r = localRefine(L1, toLevel(P0, L1), Math.max(2.5, 0.025 * L1.size), o.reverseWeight,
        [2, 2, cs.dth / 2, cs.dls / 2], bins, lsLim);
      mids.push({ P: fromLevel(r.pose, L1), cost: r.cost, coarse: cd.cost });
    }
    mids.sort(function (a, b) { return a.cost - b.cost; });
    var finals = [];
    for (i = 0; i < Math.min(3, mids.length); i++) {
      var fr = fineStages(prep, mids[i].P, 0.5, lsLim);
      finals.push(fr);
    }
    finals.sort(function (a, b) { return a.cost - b.cost; });
    var best = finals[0], second = null;
    for (i = 1; i < finals.length; i++) {
      if (distinct(prep, best.P, finals[i].P)) { second = finals[i]; break; }
    }
    return finish(best.P, {
      cost: best.cost, quality: best.quality,
      ambiguity: second ? best.cost / second.cost : 0,
      poses: cs.poses, searchMs: now() - t0
    });
  }

  function distinct(prep, P, Q) {
    var bx = prep.boxB, cx = 0.5 * (bx.x0 + bx.x1), cy = 0.5 * (bx.y0 + bx.y1);
    var a = apply(P, cx, cy), b = apply(Q, cx, cy);
    var diag = Math.sqrt(Math.pow(bx.x1 - bx.x0, 2) + Math.pow(bx.y1 - bx.y0, 2)) * P.scale;
    return Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2)) > 0.03 * diag ||
      Math.abs(P.theta - Q.theta) > 3 * PI / 180 || Math.abs(Math.log(P.scale / Q.scale)) > 0.04;
  }

  function apply(P, x, y) {
    var c = Math.cos(P.theta), sn = Math.sin(P.theta);
    return [P.scale * (c * x - sn * y) + P.tx, P.scale * (sn * x + c * y) + P.ty];
  }

  function finish(P, extra) {
    var r = {}, k;
    if (P) {
      var c = Math.cos(P.theta), sn = Math.sin(P.theta);
      r.scale = P.scale; r.theta = P.theta; r.rotation = P.theta * 180 / PI; r.tx = P.tx; r.ty = P.ty;
      r.matrix = [P.scale * c, P.scale * sn, -P.scale * sn, P.scale * c, P.tx, P.ty];
    }
    for (k in extra) { r[k] = extra[k]; }
    return r;
  }

  // Snap from a user-placed position (e.g. after manual nudging).
  function refine(prep, P) {
    var ls = Math.log(toLevel(P, prep.levels[1]).s);
    var fr = fineStages(prep, { scale: P.scale, theta: P.theta, tx: P.tx, ty: P.ty }, 1, [ls - 0.25, ls + 0.25]);
    return finish(fr.P, { cost: fr.cost, quality: fr.quality });
  }

  /* --------------------------------------------------------------- analysis */

  // Proportion map: for each region of the drawing, how far would it have to move
  // (on the reference) to sit on the matching edges? Global alignment stays fixed.
  function analyze(prep, P) {
    var o = prep.o, bins = o.orientationBins, L = prep.levels[2], A = L.A, B = L.B, E = B.edges;
    var pose = toLevel(P, L), c = Math.cos(pose.th), sn = Math.sin(pose.th), s = pose.s;
    var rot = pose.th / (PI / bins), WH = A.w * A.h;
    var tau = Math.max(2, 0.012 * L.size), rad = Math.max(3, Math.round(0.06 * L.size));
    var G = o.grid, bx = B.box, cw = (bx.x1 - bx.x0) / G, chh = (bx.y1 - bx.y0) / G;
    var figDiag = s * Math.sqrt(Math.pow(bx.x1 - bx.x0, 2) + Math.pow(bx.y1 - bx.y0, 2));
    var buckets = [], i, j;
    for (i = 0; i < G * G; i++) { buckets.push([]); }
    for (i = 0; i < E.n; i++) {
      var gx = Math.floor((E.x[i] - bx.x0) / cw), gy = Math.floor((E.y[i] - bx.y0) / chh);
      if (gx < 0 || gy < 0 || gx >= G || gy >= G) { continue; }
      buckets[gy * G + gx].push(i);
    }
    var cells = [], sq = 0, sw = 0, inAll = 0, wAll = 0, lim = Math.max(1.5, 0.01 * L.size);
    for (j = 0; j < buckets.length; j++) {
      var bk = buckets[j];
      if (bk.length < 12) { continue; }
      bk.sort(function (a, b) { return E.wt[b] - E.wt[a]; });
      var m = Math.min(160, bk.length), X = new Float32Array(m), Y = new Float32Array(m);
      var OF = new Int32Array(m), Wt = new Float32Array(m), wsum = 0, mxs = 0, mys = 0;
      for (i = 0; i < m; i++) {
        var e = bk[Math.floor(i * bk.length / m)];
        X[i] = s * (c * E.x[e] - sn * E.y[e]) + pose.tx;
        Y[i] = s * (sn * E.x[e] + c * E.y[e]) + pose.ty;
        OF[i] = mod(Math.round(E.b[e] + rot), bins) * WH;
        Wt[i] = E.wt[e]; wsum += Wt[i]; mxs += Wt[i] * X[i]; mys += Wt[i] * Y[i];
      }
      var cellCost = function (dx, dy) {
        var sum = 0;
        for (var k = 0; k < m; k++) { sum += Wt[k] * dtAt(A.dt, A.w, A.h, OF[k], X[k] + dx, Y[k] + dy, tau); }
        return sum / (wsum * tau);
      };
      var base = cellCost(0, 0), best = base + 0, bdx = 0, bdy = 0, dx, dy, v;
      for (dy = -rad; dy <= rad; dy += 2) {
        for (dx = -rad; dx <= rad; dx += 2) {
          v = cellCost(dx, dy) + 0.05 * Math.sqrt(dx * dx + dy * dy) / rad;
          if (v < best) { best = v; bdx = dx; bdy = dy; }
        }
      }
      var step = 1;
      while (step >= 0.25) {
        var moved = false, ox = bdx, oy = bdy;
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) { continue; }
            var tx = ox + dx * step, ty = oy + dy * step;
            v = cellCost(tx, ty) + 0.05 * Math.sqrt(tx * tx + ty * ty) / rad;
            if (v < best) { best = v; bdx = tx; bdy = ty; moved = true; }
          }
        }
        if (!moved) { step *= 0.5; }
      }
      var fit = cellCost(bdx, bdy);
      // A shift only counts if it explains the region well and clearly beats staying put;
      // stray marks and notes rarely do either.
      var dmag = Math.sqrt(bdx * bdx + bdy * bdy);
      var reliable = dmag < 1.5 ? fit < 0.5 : (fit < 0.36 && (base - fit) / base >= 0.25);
      if (!reliable) { bdx = 0; bdy = 0; }
      var inW = 0;
      for (i = 0; i < m; i++) { if (dtAt(A.dt, A.w, A.h, OF[i], X[i], Y[i], 1e9) <= lim) { inW += Wt[i]; } }
      inAll += inW; wAll += wsum;
      var cxL = mxs / wsum, cyL = mys / wsum, dist = Math.sqrt(bdx * bdx + bdy * bdy);
      cells.push({
        x: A.ox + (cxL + 0.5) / A.k, y: A.oy + (cyL + 0.5) / A.k,   // region centre on the reference
        dx: bdx / A.k, dy: bdy / A.k,                               // where it should move, reference px
        errorPct: figDiag > 0 ? 100 * dist / figDiag : 0,
        weight: wsum, reliable: reliable
      });
      var cw2 = wsum * Math.max(0, 1 - fit);
      if (reliable) { sq += cw2 * dist * dist; sw += cw2; }
    }
    var rmsPct = (sw > 0 && figDiag > 0) ? 100 * Math.sqrt(sq / sw) / figDiag : 0;
    return {
      cells: cells,
      rmsErrorPct: rmsPct,
      proportionScore: sw > 0 ? Math.round(100 * Math.max(0, 1 - rmsPct / 8)) : null,
      matchQuality: wAll > 0 ? inAll / wAll : 0
    };
  }

  // Edge pixels the matcher actually uses (fine level), in original image pixels.
  function edges(prep, which) {
    var L = prep.levels[2], S = which === 'B' ? L.B : L.A, E = S.edges;
    var out = { n: E.n, x: new Float32Array(E.n), y: new Float32Array(E.n), w: new Float32Array(E.n) };
    for (var i = 0; i < E.n; i++) {
      out.x[i] = S.ox + (E.x[i] + 0.5) / S.k; out.y[i] = S.oy + (E.y[i] + 0.5) / S.k; out.w[i] = E.wt[i];
    }
    return out;
  }

  function match(imgA, imgB, opts) {
    var t0 = now(), prep = prepare(imgA, imgB, opts), r = search(prep);
    if (!r.error) { r.analysis = analyze(prep, r); }
    r.prepared = prep;
    r.timeMs = now() - t0;
    return r;
  }

  return {
    DEFAULTS: DEFAULTS,
    match: match,        // one call: prepare + search + analyze
    prepare: prepare,    // build working images once, reuse for refine/analyze
    search: search,
    refine: refine,      // snap from a manual placement
    analyze: analyze,    // proportion map for any placement {scale, theta, tx, ty}
    edges: edges,
    apply: apply
  };
}));
