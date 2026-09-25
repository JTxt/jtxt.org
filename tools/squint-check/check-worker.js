/*
 * Squint & Check: the work that would freeze the page, run off the main thread.
 *
 * Messages in:
 *   { type:'reference', img:{width, height, data} }   RGBA bytes, kept for matching
 *   { type:'drawing',   img:{width, height, data} }
 *   { type:'mask', id, which, maxSide, opts }          'ref' or 'draw': the picture's edges and lines (and the drawing's ink) as a mask
 *   { type:'match', id, rotationRange }                full search
 *   { type:'refine', id, P }                           snap from a placement {scale, theta, tx, ty}
 * Every reply carries the same type and id, plus `error` if it failed.
 *
 * co-authors: jtxt.org and claude opus 5.5
 */
importScripts('match.js' + self.location.search);   // the same ?v= as this worker

var refImg = null, drawImg = null, prep = null;

self.onmessage = function (e) {
  var m = e.data;
  try {
    if (m.type === 'reference') { refImg = m.img; prep = null; }
    else if (m.type === 'drawing') { drawImg = m.img; prep = null; }
    else if (m.type === 'mask') {
      var img = m.which === 'ref' ? refImg : drawImg;
      if (!img) { throw new Error('No picture yet'); }
      var mk = mask(img, m.maxSide || 1024, m.which === 'draw', m.opts || {});
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

function pick(v, d) { return v == null || v !== v ? d : v; }
function smooth(a, b, x) { var t = (x - a) / (b - a); t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); }
function now() { return (self.performance && performance.now) ? performance.now() : Date.now(); }

// A picture as the mask its lines are drawn from, found once when the picture loads.
// Two kinds of mark go in:
//   Edges, the outlines of value shapes: the matcher's own edge finder (blur, gradient,
//     one-pixel ridges, faint and short pieces dropped), on a finer copy than its 480px,
//     with its blur scaled to match.
//   Lines, thin strokes drawn along their centre (see findLines). Where a stroke counts
//     as a line, the two edges along its sides fade out by as much as the line fades in.
// Both are found on lightness alone, so color makes no difference. The page blurs the mask
// on the GPU and thresholds the blur into a smooth line. Sizes in `o` are in pixels of a
// 1024px copy, so they mean the same at any mask size.
// A mark that's partly a line and partly an edge (a stroke getting wider) keeps its full
// width in both forms, and each fades by alpha, so the two blend instead of both thinning.
// Four bytes per pixel:
//   R  a mark here (255), its shape. A mark almost faded out stops counting, so it doesn't
//      widen the line next to it
//   G  that, times the mark's weight: strong, long marks near 255, so they show brighter
//   B  the drawing's ink, as the old Drawing matcher tinted it: how much darker than
//      the paper, ramping in from 0.05 over 0.35 (Soft and Tint; 0 on the reference)
//   A  how much the mark shows (255 fully): R over A, blurred, is its alpha
function mask(img, maxSide, withInk, o) {
  var W = img.width, H = img.height, k = Math.min(1, maxSide / Math.max(W, H));
  var w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k)), n = w * h, i;
  var t0 = now();
  var L = luminance(img.data, W, H, w, h);
  var mo = {}, key;
  for (key in ImageMatch.DEFAULTS) { mo[key] = ImageMatch.DEFAULTS[key]; }
  mo.edgeThreshold = pick(o.edgeThreshold, mo.edgeThreshold);
  mo.minStroke = pick(o.edgeMinLen, mo.minStroke);
  var sigE = 1.4 * Math.max(w, h) / 480 * pick(o.edgeSigma, 0.85);
  var E = ImageMatch.detectEdges(L, w, h, sigE, mo);
  var t1 = now();
  var li = pick(o.lines, 1) ? findLines(L, w, h, o, sigE, withInk ? pick(o.lightDraw, 0) : pick(o.lightRef, 0)) : null;
  var t2 = now();
  var out = new Uint8Array(n * 4), sharp = pick(o.lineAngle, 4);
  function put(p, fade, wt) {
    var j = p * 4, sh = smooth(0, 0.3, fade), r = Math.round(sh * 255), g = Math.round(sh * wt * 255), a = Math.round(fade * 255);
    if (r > out[j]) { out[j] = r; }
    if (g > out[j + 1]) { out[j + 1] = g; }
    if (a > out[j + 3]) { out[j + 3] = a; }
  }
  for (i = 0; i < E.n; i++) {
    var p = (E.y[i] | 0) * w + (E.x[i] | 0), a = 1;
    // A side of a line: the edge runs along the line (its gradient across it), so it fades.
    if (li && li.near[p] > 0) { a = 1 - li.near[p] * Math.pow(Math.abs(Math.cos(E.b[i] * Math.PI / 8 - li.nearAng[p])), sharp); }
    if (a > 0.004) { put(p, a, E.wt[i]); }
  }
  if (li) { for (i = 0; i < li.n; i++) { put(li.p[i], li.a[i], li.wt[i]); } }
  if (withInk) {
    var bg = paper(L, w, h);
    for (i = 0; i < n; i++) {
      var t = (bg[i] - L[i] - 0.05) / 0.35;
      out[i * 4 + 2] = t <= 0 ? 0 : (t >= 1 ? 255 : Math.round(t * 255));
    }
  }
  return { w: w, h: h, data: out, edges: E.n, lines: li ? li.n : 0,
    ms: { edges: Math.round(t1 - t0), lines: Math.round(t2 - t1), total: Math.round(now() - t0) } };
}

// Lines: thin strokes, found as narrow valleys of lightness (dark lines) or ridges (light
// lines), from the second derivative, after Steger's line detector (1998). Across a thin
// dark stroke, lightness curves up most at its centre, while its slope there is zero; the
// side of a step edge curves too, but on a steep slope, so the slope is subtracted to leave
// only strokes. It's measured at a few blur sizes, and a stroke answers most at the size of
// half its width, so strokes from lineSigmaMin to lineSigmaMax × 2 wide count fully; wider
// marks answer less and less, and keep their outlines. None of this cuts on brightness, so
// a gradient (no curve across it) makes no line.
// Returns the line's centre pixels, each with how much it counts as a line (a, from its
// contrast: 0 below lineLo, 1 above lineHi) and its weight; and, around them, how much
// nearby edges are the sides of a line (near) and which way across the line runs (nearAng).
function findLines(L, w, h, o, sigE, light) {
  var n = w * h, sc = Math.max(w, h) / 1024, x, y, i, k;
  var smin = Math.max(0.3, pick(o.lineSigmaMin, 1) * sc), smax = Math.max(smin, pick(o.lineSigmaMax, 2.5) * sc);
  var ns = smax > smin * 1.05 ? Math.min(5, 1 + Math.ceil(Math.log(smax / smin) / Math.log(1.6))) : 1;
  var beta = pick(o.lineBeta, 3), lo = pick(o.lineLo, 0.06), hi = Math.max(lo + 0.001, pick(o.lineHi, 0.15));
  var M = new Float32Array(n), A = new Float32Array(n), S = new Float32Array(n);
  var g = L, prev = 0;
  for (k = 0; k < ns; k++) {
    var s = ns > 1 ? smin * Math.pow(smax / smin, k / (ns - 1)) : smin, s2 = s * s;
    g = gauss(g, w, h, Math.sqrt(Math.max(0, s2 - prev * prev)));   // each size blurs the last one further
    prev = s;
    for (y = 1; y < h - 1; y++) {
      for (x = 1; x < w - 1; x++) {
        i = y * w + x;
        var c = g[i], l = g[i - 1], r = g[i + 1], u = g[i - w], d = g[i + w];
        var ixx = r - 2 * c + l, iyy = d - 2 * c + u, ixy = (g[i + w + 1] - g[i + w - 1] - g[i - w + 1] + g[i - w - 1]) * 0.25;
        var tr = (ixx + iyy) * 0.5, dd = Math.sqrt((ixx - iyy) * (ixx - iyy) * 0.25 + ixy * ixy);
        // The slope a centre up to half a pixel away would give is allowed: a stroke centred
        // between two pixels still counts at the smallest size.
        var ix = (r - l) * 0.5, iy = (d - u) * 0.5, gm = Math.sqrt(ix * ix + iy * iy);
        var v = s2 * (tr + dd) - beta * s * Math.max(0, gm - 0.5 * Math.abs(tr + dd)), turn = 0;
        if (light) { var v2 = -s2 * (tr - dd) - beta * s * Math.max(0, gm - 0.5 * Math.abs(tr - dd)); if (v2 > v) { v = v2; turn = Math.PI / 2; } }
        if (v > M[i] && v > lo * 0.5) { M[i] = v; A[i] = 0.5 * Math.atan2(2 * ixy, ixx - iyy) + turn; S[i] = s; }
      }
    }
  }
  // The centre: the strongest point across the line. Nothing near the border.
  var bm = Math.max(2, Math.round(0.012 * Math.max(w, h))), keep = new Uint8Array(n);
  for (y = bm; y < h - bm; y++) {
    for (x = bm; x < w - bm; x++) {
      i = y * w + x;
      var m = M[i];
      if (m < lo) { continue; }
      // A tie (a stroke centred between two pixels) goes to the one on the higher index's
      // side whichever way across points, so exactly one of the two is kept.
      var dx = Math.round(Math.cos(A[i])), dy = Math.round(Math.sin(A[i])), p1 = i + dy * w + dx, p2 = i - dy * w - dx;
      if (m >= M[Math.max(p1, p2)] && m > M[Math.min(p1, p2)]) { keep[i] = 1; }
    }
  }
  // Short pieces are texture or specks: gone. Longer ones show brighter, as edges do.
  var minLen = Math.max(3, Math.round(pick(o.lineMinLen, 0.03) * Math.max(w, h)));
  var refLen = Math.max(minLen + 1, 0.06 * Math.max(w, h));
  var seen = new Uint8Array(n), stack = new Int32Array(n), members = new Int32Array(n), lenOf = new Float32Array(n);
  var cnt = 0;
  for (i = 0; i < n; i++) {
    if (!keep[i] || seen[i]) { continue; }
    var sp = 0, mc = 0;
    stack[sp++] = i; seen[i] = 1;
    while (sp > 0) {
      var q = stack[--sp], qx = q % w, qy = (q - qx) / w;
      members[mc++] = q;
      for (var ny = qy - 2; ny <= qy + 2; ny++) {
        if (ny < 0 || ny >= h) { continue; }
        for (var nx = qx - 2; nx <= qx + 2; nx++) {
          if (nx < 0 || nx >= w) { continue; }
          var z = ny * w + nx;
          if (keep[z] && !seen[z]) { seen[z] = 1; stack[sp++] = z; }
        }
      }
    }
    for (var j = 0; j < mc; j++) {
      if (mc < minLen) { keep[members[j]] = 0; } else { lenOf[members[j]] = mc; cnt++; }
    }
  }
  // Each line pixel's strength, averaged with the line pixels around it, so a faint line
  // shows evenly instead of in dashes, while slow changes (a stroke widening) still show.
  var Ms = new Float32Array(n);
  for (i = 0; i < n; i++) {
    if (!keep[i]) { continue; }
    var ax = i % w, ay = (i - ax) / w, sum = 0, num = 0;
    for (var by = Math.max(0, ay - 3); by <= Math.min(h - 1, ay + 3); by++) {
      for (var bx = Math.max(0, ax - 3); bx <= Math.min(w - 1, ax + 3); bx++) {
        if (keep[by * w + bx]) { sum += M[by * w + bx]; num++; }
      }
    }
    Ms[i] = sum / num;
  }
  // A strong line: the 95th percentile of their strength, as the edges use.
  var vals = new Float32Array(cnt), c2 = 0;
  for (i = 0; i < n; i++) { if (keep[i]) { vals[c2++] = Ms[i]; } }
  vals.sort();
  var strong = cnt ? Math.max(hi, vals[Math.min(cnt - 1, Math.floor(cnt * 0.95))]) : hi;
  var P = new Int32Array(cnt), Aa = new Float32Array(cnt), Wt = new Float32Array(cnt);
  var near = new Float32Array(n), nearAng = new Float32Array(n), reach = pick(o.lineReach, 1), e = 0;
  for (i = 0; i < n; i++) {
    if (!keep[i]) { continue; }
    var a = smooth(lo, hi, Ms[i]);
    P[e] = i; Aa[e] = a; Wt[e] = Math.min(1, Ms[i] / strong) * Math.min(1, lenOf[i] / refLen); e++;
    if (!(a > 0) || !(reach > 0)) { continue; }
    // The line's sides: an edge finder blurring by sigE puts them about sqrt(s² + sigE²) out.
    var rd = reach * Math.sqrt(S[i] * S[i] + sigE * sigE), R = Math.ceil(rd + 2), cx = i % w, cy = (i - cx) / w;
    for (var yy = Math.max(0, cy - R); yy <= Math.min(h - 1, cy + R); yy++) {
      for (var xx = Math.max(0, cx - R); xx <= Math.min(w - 1, cx + R); xx++) {
        var f = a * (1 - smooth(rd + 0.5, rd + 2, Math.sqrt((xx - cx) * (xx - cx) + (yy - cy) * (yy - cy)))), t = yy * w + xx;
        if (f > near[t]) { near[t] = f; nearAng[t] = A[i]; }
      }
    }
  }
  return { n: cnt, p: P, a: Aa, wt: Wt, near: near, nearAng: nearAng };
}

// Separable Gaussian blur, edges clamped.
function gauss(src, w, h, sigma) {
  if (!(sigma > 0.05)) { return src; }
  var r = Math.ceil(sigma * 3), kn = new Float32Array(2 * r + 1), s = 0, i, x, y;
  for (i = -r; i <= r; i++) { kn[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); s += kn[i + r]; }
  for (i = 0; i < kn.length; i++) { kn[i] /= s; }
  var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (y = 0; y < h; y++) {
    var row = y * w;
    for (x = 0; x < w; x++) {
      var acc = 0;
      for (i = -r; i <= r; i++) { var xx = x + i; acc += kn[i + r] * src[row + (xx < 0 ? 0 : (xx >= w ? w - 1 : xx))]; }
      tmp[row + x] = acc;
    }
  }
  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) {
      var acc2 = 0;
      for (i = -r; i <= r; i++) { var yy = y + i; acc2 += kn[i + r] * tmp[(yy < 0 ? 0 : (yy >= h ? h - 1 : yy)) * w + x]; }
      out[y * w + x] = acc2;
    }
  }
  return out;
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
