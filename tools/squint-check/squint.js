/* Squint & Check. Reference Squint: value analysis, the value strip, its controls, Looks, the value readout, and saving.
   Loaded by index.html; the scripts share one global scope.
   co-authors: jtxt.org and claude opus 5.5 */
"use strict";

// =============================================================
// Value analysis: histogram of the squinted picture in L*
// =============================================================
var hist = null, histDirty = false, histCache = {};

function histFor(blur){
  if(!hasImage) return null;
  var key = String(blur);
  if(histCache[key]) return histCache[key];
  var hw = Math.min(256, imgW), hh = Math.max(1, Math.round(hw*imgH/imgW));
  if(hh > 256){ hh = 256; hw = Math.max(1, Math.round(256*imgW/imgH)); }
  var f = makeFBO(hw, hh);
  drawMain({ outL:true }, runBlur(blurPx(blur)), f.fbo, hw, hh, 0);
  var px = readFBO(f); killFBO(f);
  var h = new Float64Array(256), tot = 0;
  for(var i = 0; i < px.length; i += 4){ if(px[i+3] > 0){ h[px[i]]++; tot++; } }
  if(tot) for(i = 0; i < 256; i++) h[i] /= tot;
  histCache[key] = h;
  return h;
}
function binL(i){ return i / 255 * 100; }

function sanitize(th){
  for(var i = 0; i < th.length; i++){
    var lo = i ? th[i-1] + 1 : 0.5;
    var hi = 99.5 - (th.length - 1 - i);
    th[i] = Math.max(lo, Math.min(hi, th[i]));
  }
  return th;
}
function evenThresholds(n){
  var t = []; for(var j = 1; j < n; j++) t.push(j*100/n); return t;
}
// 1-D k-means on the histogram: boundaries fall in the valleys between
// the picture's own clusters of value.
function fitThresholds(h, n){
  if(!h) return evenThresholds(n);
  var c = [], cum = 0, k = 0, b, j;
  for(b = 0; b < 256 && k < n; b++){
    cum += h[b];
    while(k < n && cum >= (k + 0.5)/n){ c.push(binL(b)); k++; }
  }
  while(c.length < n) c.push(100);
  for(var it = 0; it < 50; it++){
    var sum = new Array(n).fill(0), w = new Array(n).fill(0);
    for(b = 0; b < 256; b++){
      if(!h[b]) continue;
      var L = binL(b), best = 0, bd = 1e9;
      for(j = 0; j < n; j++){ var d = Math.abs(L - c[j]); if(d < bd){ bd = d; best = j; } }
      sum[best] += h[b]*L; w[best] += h[b];
    }
    var moved = 0;
    for(j = 0; j < n; j++){ if(w[j] > 0){ var nc = sum[j]/w[j]; moved += Math.abs(nc - c[j]); c[j] = nc; } }
    c.sort(function(a, b2){ return a - b2; });
    if(moved < 0.01) break;
  }
  var th = [];
  for(j = 0; j < n - 1; j++) th.push((c[j] + c[j+1]) / 2);
  return sanitize(th);
}
function bandOf(L, th){ var b = 0; for(var i = 0; i < th.length; i++) if(L > th[i]) b++; return b; }
function bandStats(h, n, th){
  var area = new Array(n).fill(0), sum = new Array(n).fill(0);
  if(h) for(var i = 0; i < 256; i++){
    if(!h[i]) continue;
    var b = bandOf(binL(i), th); area[b] += h[i]; sum[b] += h[i]*binL(i);
  }
  return { area:area, sum:sum };
}
function tonesFor(n, th, h, mode){
  var t = [], i;
  if(mode === 'scale'){ for(i = 0; i < n; i++) t.push(i/(n-1)*100); return t; }
  var s = bandStats(h, n, th);
  for(i = 0; i < n; i++){
    var lo = i ? th[i-1] : 0, hi = i < n-1 ? th[i] : 100;
    t.push(s.area[i] > 0 ? s.sum[i]/s.area[i] : (lo + hi)/2);
  }
  return t;
}

// Shift moves every boundary together: right is lighter (boundaries down), left darker.
function applyShift(){
  S.th = sanitize(S.thBase.map(function(t){ return t - S.shift; }));
}
function recalc(){
  if(S.n > 1){
    if(S.split === 'fit') S.thBase = fitThresholds(hist, S.n);
    else if(S.split === 'even' || S.thBase.length !== S.n - 1) S.thBase = evenThresholds(S.n);
    applyShift();
    tones = tonesFor(S.n, S.th, hist, S.tones);
  } else { S.th = []; S.thBase = []; tones = []; }
  if(S.iso >= S.n) S.iso = -1;
  drawStrip(); syncUI();
}
function updateHist(){
  histDirty = false;
  hist = histFor(S.blur);
  recalc();
}

// =============================================================
// Value strip: histogram, bands, draggable boundaries
// =============================================================
var activeHandle = 0;

function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function drawStrip(){
  var r = stripCv.getBoundingClientRect();
  if(!r.width) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var W = Math.max(1, Math.round(r.width*dpr)), H = Math.max(1, Math.round(r.height*dpr));
  if(stripCv.width !== W || stripCv.height !== H){ stripCv.width = W; stripCv.height = H; }
  var ctx = stripCv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  var ink = cssVar('--ink'), accent = cssVar('--accent'), panel = cssVar('--panel'), line = cssVar('--line');
  var barH = Math.round((r.height > 70 ? 20 : 15)*dpr), histH = H - barH - 2*dpr;
  var i, b, x;
  function X(L){ return L/100*W; }

  // Histogram, square-root scaled so small passages still show.
  ctx.fillStyle = line; ctx.fillRect(0, histH, W, 1*dpr);
  if(hist){
    var mx = 0; for(i = 0; i < 256; i++) mx = Math.max(mx, hist[i]);
    if(mx > 0){
      ctx.beginPath(); ctx.moveTo(0, histH);
      for(i = 0; i < 256; i++){
        var s = (hist[Math.max(0,i-1)] + 2*hist[i] + hist[Math.min(255,i+1)]) / 4;
        ctx.lineTo(X(binL(i)), histH - Math.sqrt(s/mx)*(histH - 3*dpr));
      }
      ctx.lineTo(W, histH); ctx.closePath();
      ctx.globalAlpha = 0.28; ctx.fillStyle = ink; ctx.fill(); ctx.globalAlpha = 1;
    }
  }

  // Band bar along the bottom.
  var y0 = H - barH;
  if(S.n > 1 && hasImage){
    var stats = bandStats(hist, S.n, S.th);
    for(b = 0; b < S.n; b++){
      var x0 = X(b ? S.th[b-1] : 0), x1 = X(b < S.n-1 ? S.th[b] : 100);
      ctx.globalAlpha = (S.iso >= 0 && S.iso !== b) ? 0.3 : 1;
      ctx.fillStyle = lstarToDisplay(tones[b]); ctx.fillRect(x0, y0, x1 - x0, barH);
      ctx.globalAlpha = 1;
      if(S.iso === b){
        ctx.strokeStyle = accent; ctx.lineWidth = 2.5*dpr;
        ctx.strokeRect(x0 + 1.25*dpr, y0 + 1.25*dpr, x1 - x0 - 2.5*dpr, barH - 2.5*dpr);
      }
      var pct = Math.round(stats.area[b]*100);
      if((x1 - x0)/dpr > 30 && histH > 14*dpr){
        ctx.font = '700 ' + Math.round(11*dpr) + 'px ' + cssVar('--ui').split(',')[0];
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.lineWidth = 3*dpr; ctx.strokeStyle = panel; ctx.lineJoin = 'round';
        var tx = (x0 + x1)/2, ty = histH - 4*dpr;
        ctx.strokeText(pct + '%', tx, ty); ctx.fillStyle = ink; ctx.fillText(pct + '%', tx, ty);
      }
    }
    // Boundaries
    for(i = 0; i < S.th.length; i++){
      x = Math.round(X(S.th[i]));
      ctx.fillStyle = accent;
      ctx.fillRect(x - 1*dpr, 0, 2*dpr, H);
      var kw = 10*dpr, kh = barH + 4*dpr;
      ctx.beginPath();
      if(ctx.roundRect) ctx.roundRect(x - kw/2, H - kh, kw, kh, 3*dpr); else ctx.rect(x - kw/2, H - kh, kw, kh);
      ctx.fillStyle = accent; ctx.fill();
      ctx.fillStyle = panel; ctx.fillRect(x - 1*dpr, H - kh + 4*dpr, 2*dpr, kh - 8*dpr);
      if(document.activeElement === strip && i === activeHandle){
        ctx.strokeStyle = ink; ctx.lineWidth = 1.5*dpr; ctx.strokeRect(x - kw/2 - 2*dpr, H - kh - 2*dpr, kw + 4*dpr, kh + 2*dpr);
      }
    }
  } else {
    var g = ctx.createLinearGradient(0, 0, W, 0);
    for(i = 0; i <= 10; i++) g.addColorStop(i/10, lstarToDisplay(i*10));
    ctx.fillStyle = g; ctx.fillRect(0, y0, W, barH);
  }

  // Where the last tap landed
  if(S.mark != null && hasImage){
    x = X(S.mark);
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.moveTo(x - 5*dpr, 0); ctx.lineTo(x + 5*dpr, 0); ctx.lineTo(x, 7*dpr); ctx.closePath(); ctx.fill();
    ctx.fillRect(x - 0.5*dpr, 0, 1*dpr, histH);
  }
}

var sDrag = null;
function stripL(clientX){
  var r = stripCv.getBoundingClientRect();
  return Math.max(0, Math.min(100, (clientX - r.left)/Math.max(1, r.width)*100));
}
function nearestHandle(clientX){
  var r = stripCv.getBoundingClientRect(), best = -1, bd = 18;
  for(var i = 0; i < S.th.length; i++){
    var d = Math.abs(r.left + S.th[i]/100*r.width - clientX);
    if(d < bd){ bd = d; best = i; }
  }
  return best;
}
function moveHandle(i, L){
  var lo = i ? S.th[i-1] + 1 : 0.5, hi = i < S.th.length - 1 ? S.th[i+1] - 1 : 99.5;
  S.thBase = S.th.map(function(t){ return t + S.shift; });
  S.thBase[i] = Math.max(lo, Math.min(hi, L)) + S.shift;
  S.split = 'custom';
  applyShift();
  tones = tonesFor(S.n, S.th, hist, S.tones);
  drawStrip(); syncUI(); requestRender(); paint();
}

strip.addEventListener('pointerdown', function(e){
  if(!hasImage || S.n < 2) return;
  var h = nearestHandle(e.clientX);
  sDrag = { id:e.pointerId, handle:h, x0:e.clientX, moved:false };
  if(h >= 0) activeHandle = h;
  try { strip.setPointerCapture(e.pointerId); } catch(err){}
  e.preventDefault();
});
strip.addEventListener('pointermove', function(e){
  if(!sDrag || sDrag.id !== e.pointerId) return;
  if(Math.abs(e.clientX - sDrag.x0) > 3) sDrag.moved = true;
  if(sDrag.handle >= 0 && sDrag.moved) moveHandle(sDrag.handle, stripL(e.clientX));
});
function stripUp(e){
  if(!sDrag || sDrag.id !== e.pointerId) return;
  var d = sDrag; sDrag = null;
  if(e.type === 'pointerup' && !d.moved){
    var b = bandOf(stripL(e.clientX), S.th);
    setIso(S.iso === b ? -1 : b);
  }
}
strip.addEventListener('pointerup', stripUp);
strip.addEventListener('pointercancel', stripUp);
strip.addEventListener('focus', drawStrip);
strip.addEventListener('blur', drawStrip);
strip.addEventListener('keydown', function(e){
  if(!hasImage || S.n < 2) return;
  var step = e.shiftKey ? 5 : 1;
  if(e.key === 'ArrowLeft'){ moveHandle(activeHandle, S.th[activeHandle] - step); }
  else if(e.key === 'ArrowRight'){ moveHandle(activeHandle, S.th[activeHandle] + step); }
  else if(e.key === 'ArrowUp'){ activeHandle = Math.min(S.th.length - 1, activeHandle + 1); drawStrip(); }
  else if(e.key === 'ArrowDown'){ activeHandle = Math.max(0, activeHandle - 1); drawStrip(); }
  else return;
  e.preventDefault(); e.stopPropagation();
});

function setIso(b){
  S.iso = b;
  drawStrip(); syncUI(); paint();
}

// =============================================================
// UI sync
// =============================================================
// Reference Squint's controls, from state.
function syncSquint(){
  var on = hasImage;
  chips.forEach(function(c){
    c.disabled = !on;
    c.setAttribute('aria-pressed', String(Number(c.dataset.n) === S.n));
  });
  var bands = on && S.n > 1;
  shiftEl.disabled = !bands;
  shiftEl.value = S.shift;
  var pos = (S.shift + 25)/50*100;
  shiftEl.style.setProperty('--a', Math.min(50, pos) + '%');
  shiftEl.style.setProperty('--b', Math.max(50, pos) + '%');
  shiftEl.setAttribute('aria-valuetext', S.shift === 0 ? 'no shift'
    : (S.shift > 0 ? 'lighter by ' : 'darker by ') + Math.abs(S.shift));
  fitBtn.disabled = !bands || (S.split === 'fit' && S.shift === 0);
  pressed(document.querySelectorAll('#splitSeg button'), function(b){ return b.dataset.v === S.split; });
  pressed(document.querySelectorAll('#tonesSeg button'), function(b){ return b.dataset.v === S.tones; });

  stripHint.textContent = !on ? 'Open a reference to see its values.'
    : S.n < 2 ? 'The shape shows how much of the picture sits at each value, black on the left, white on the right. Pick a number of values to group it.'
    : S.iso >= 0 ? 'Showing only band ' + (S.iso + 1) + ' of ' + S.n + '. Tap it again to see every band.'
    : 'Shift moves every boundary at once. Drag a blue mark to move just one. Tap a band to see only that shape.';

  squint.disabled = !on;
  squint.value = S.blur;
  squint.style.setProperty('--p', S.blur + '%');
  var p = blurPct(S.blur);
  squintOut.textContent = S.blur === 0 ? 'Off' : (p < 1 ? p.toFixed(2) : p.toFixed(1)) + '%';
  squint.setAttribute('aria-valuetext', S.blur === 0 ? 'off' : p.toFixed(2) + ' percent of the picture');

  Object.keys(tools).forEach(function(k){ if(k !== 'open') tools[k].disabled = !on; });
  $('colorName').textContent = COLOR_NAMES[S.color];
  tools.color.classList.toggle('on', S.color !== 'full');
  tools.looks.classList.toggle('on', looksOpen);

  pressed(document.querySelectorAll('#surroundSeg button'), function(b){ return b.dataset.v === S.surround; });
  pressed(document.querySelectorAll('#themeSeg button'), function(b){ return b.dataset.v === theme; });

}

// =============================================================
// Controls
// =============================================================
var bandsHintShown = false;
function setValues(n){
  S.n = n; S.iso = -1;
  if(S.split === 'custom') S.split = 'fit';
  recalc(); paint();
  if(n > 1 && !bandsHintShown){
    bandsHintShown = true;
    toast('Shift moves every boundary at once. Drag a blue mark to move one.', 4200);
  }
}
chips.forEach(function(c){
  c.addEventListener('click', function(){ setValues(Number(c.dataset.n)); });
});
shiftEl.addEventListener('input', function(){
  S.shift = Number(shiftEl.value);
  if(S.n > 1){ applyShift(); tones = tonesFor(S.n, S.th, hist, S.tones); }
  drawStrip(); syncUI(); paint();
});
fitBtn.addEventListener('click', function(){
  S.split = 'fit'; S.shift = 0;
  recalc(); paint();
});
Array.prototype.forEach.call(document.querySelectorAll('#splitSeg button'), function(b){
  b.addEventListener('click', function(){ S.split = b.dataset.v; recalc(); paint(); if(looksOpen) markLooks(); });
});
Array.prototype.forEach.call(document.querySelectorAll('#tonesSeg button'), function(b){
  b.addEventListener('click', function(){ S.tones = b.dataset.v; store('tones', S.tones); recalc(); paint(); if(looksOpen) buildLooks(); });
});
squint.addEventListener('input', function(){
  S.blur = Number(squint.value);
  histDirty = true;
  syncUI(); requestRender();
});

function setColor(c){
  S.color = c; st.chroma.t = CHROMA[c];
  syncUI(); requestRender();
}
function cycleColor(){ setColor(COLORS[(COLORS.indexOf(S.color) + 1) % COLORS.length]); }
tools.open.addEventListener('click', function(){ fileInput.click(); });
tools.looks.addEventListener('click', function(){ looksOpen ? closeLooks() : openLooks(); });
tools.color.addEventListener('click', cycleColor);
tools.grid.addEventListener('click', cycleGrid);
tools.rotate.addEventListener('click', function(){ rotate(1); });
tools.mirror.addEventListener('click', toggleMirror);
tools.save.addEventListener('click', savePNG);
holdButton(tools.before);

// =============================================================
// Looks
// =============================================================
var LOOKS = [
  { name:'Original',     desc:'As photographed',            blur:0,  n:0, color:'full' },
  { name:'Squint',       desc:'Soft focus, color kept',     blur:50, n:0, color:'full' },
  { name:'Value only',   desc:'Color taken out',            blur:0,  n:0, color:'gray' },
  { name:'Notan',        desc:'Two values, light and dark', blur:45, n:2, color:'gray' },
  { name:'Three values', desc:'Light, middle and dark',     blur:45, n:3, color:'gray' },
  { name:'Five values',  desc:'The classic value study',    blur:35, n:5, color:'gray' },
  { name:'Big shapes',   desc:'A hard squint, three values',blur:72, n:3, color:'gray' },
  { name:'Color masses', desc:'Five values, color kept',    blur:45, n:5, color:'full' },
  { name:'Fine study',   desc:'Seven values, a light blur', blur:22, n:7, color:'gray' }
];
var looksOpen = false;

function lookMatches(p){
  return p.blur === S.blur && p.n === S.n && p.color === S.color && (S.n < 2 || (S.split === 'fit' && S.shift === 0));
}
function applyLook(p){
  S.blur = p.blur; S.n = p.n; S.split = 'fit'; S.shift = 0; S.iso = -1;
  setColor(p.color);
  histDirty = true;
  syncUI(); requestRender();
}
function thumbSize(){
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = Math.round(150*dpr);
  var rot = st.rot.t, c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  var ow = imgW*c + imgH*s, oh = imgW*s + imgH*c;
  var h = Math.max(24, Math.min(Math.round(w*1.4), Math.round(w*oh/ow)));
  return { w:w, h:h };
}
function markLooks(){
  Array.prototype.forEach.call(lookGrid.children, function(card, i){ card.classList.toggle('current', lookMatches(LOOKS[i])); });
}
function buildLooks(){
  if(!hasImage || !gl || glLost) return;
  lookGrid.innerHTML = '';
  var size = thumbSize(), bg = surroundRGB();
  LOOKS.forEach(function(p){
    var h = histFor(p.blur);
    var th = p.n > 1 ? fitThresholds(h, p.n) : [];
    var v = { rotation:st.rot.t, flipX:st.flip.t, chroma:CHROMA[p.color], n:p.n, th:th,
              tones:p.n > 1 ? tonesFor(p.n, th, h, S.tones) : [], iso:-1, grid:0, bg:bg };
    var f = makeFBO(size.w, size.h);
    drawMain(v, runBlur(blurPx(p.blur)), f.fbo, size.w, size.h, 1);
    var px = readFBO(f); killFBO(f);
    var card = document.createElement('button');
    card.type = 'button'; card.className = 'look' + (lookMatches(p) ? ' current' : '');
    card.appendChild(pxToCanvas(px, size.w, size.h, document.createElement('canvas')));
    var n = document.createElement('span'); n.className = 'ln'; n.textContent = p.name;
    var d = document.createElement('span'); d.className = 'ld'; d.textContent = p.desc;
    card.appendChild(n); card.appendChild(d);
    card.addEventListener('click', function(){ applyLook(p); closeLooks(); });
    lookGrid.appendChild(card);
  });
  paint();
}
function openLooks(){
  if(!hasImage) return;
  looksOpen = true; looks.classList.add('open');
  syncUI();
  requestAnimationFrame(buildLooks);
}
function closeLooks(){
  looksOpen = false; looks.classList.remove('open');
  syncUI(); paint();
}
$('looksClose').addEventListener('click', closeLooks);
Array.prototype.forEach.call(document.querySelectorAll('#surroundSeg button'), function(b){
  b.addEventListener('click', function(){
    S.surround = b.dataset.v; store('surround', S.surround);
    applySurround();
    if(looksOpen) buildLooks();
    syncUI(); paint();
  });
});
Array.prototype.forEach.call(document.querySelectorAll('#themeSeg button'), function(b){
  b.addEventListener('click', function(){ setTheme(b.dataset.v); });
});
function savePNG(){
  if(!hasImage || !gl || glLost) return;
  var rot = st.rot.t, c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  var w = Math.max(1, Math.round(imgW*c + imgH*s)), h = Math.max(1, Math.round(imgW*s + imgH*c));
  var v = { rotation:rot, flipX:st.flip.t, chroma:st.chroma.t, n:S.n, th:S.th, tones:tones,
            iso:S.iso, grid:S.grid, bg:surroundRGB() };
  var f = makeFBO(w, h);
  drawMain(v, runBlur(blurPx(S.blur)), f.fbo, w, h, 0);
  var px = readFBO(f); killFBO(f);
  var cv = pxToCanvas(px, w, h, document.createElement('canvas'));
  paint();
  downloadCanvas(cv, baseName(lastName) + '-squint.png');
}

function screenToImage(cx, cy){
  if(!sampleData || !hasImage) return null;
  var c = toCanvas(cx, cy);
  var px = (c.x - view.x)/view.zoom, py = (c.y - view.y)/view.zoom;
  var rot = st.rot.c, cs = Math.cos(-rot), sn = Math.sin(-rot);
  var f = fitScaleFor(rot, imgW, imgH, canvas.width, canvas.height);
  var rx = (px*cs - py*sn)/f, ry = (px*sn + py*cs)/f;
  var u = rx/imgW*st.flip.c + 0.5, v = ry/imgH + 0.5;
  if(u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u:u, v:v };
}
// Average around the tap, as wide as the current squint, in linear light.
function sampleL(uv){
  var sd = sampleData, sx = Math.floor(uv.u*sd.w), sy = Math.floor((1 - uv.v)*sd.h);
  var rad = Math.max(1, Math.min(12, Math.round(blurPx(S.blur)*sd.w/imgW)));
  var R = 0, G = 0, B = 0, n = 0;
  for(var y = sy - rad; y <= sy + rad; y++){
    if(y < 0 || y >= sd.h) continue;
    for(var x = sx - rad; x <= sx + rad; x++){
      if(x < 0 || x >= sd.w) continue;
      var i = (y*sd.w + x)*4, r = sd.d[i]/255, g = sd.d[i+1]/255, b = sd.d[i+2]/255;
      R += r*r; G += g*g; B += b*b; n++;
    }
  }
  if(!n) return null;
  R /= n; G /= n; B /= n;
  var cb = function(v){ return Math.cbrt ? Math.cbrt(v) : Math.pow(Math.max(v,0), 1/3); };
  var l = cb(0.4122214708*R + 0.5363325363*G + 0.0514459929*B);
  var m = cb(0.2119034982*R + 0.6806995451*G + 0.1073969566*B);
  var s = cb(0.0883024619*R + 0.2817188376*G + 0.6299787005*B);
  return toLstar(0.2104542553*l + 0.7936177850*m - 0.0040720468*s);
}

var readTimer = null;
function readAt(cx, cy){
  var uv = screenToImage(cx, cy);
  if(!uv) return null;
  var L = sampleL(uv);
  if(L == null) return null;
  L = Math.max(0, Math.min(100, L));
  S.mark = L;
  readSwatch.style.background = lstarToDisplay(L);
  readValue.textContent = 'Value ' + (L/10).toFixed(1);
  var band = S.n > 1 ? bandOf(L, S.th) : -1;
  readMeta.textContent = 'L* ' + Math.round(L) + (band >= 0 ? ', band ' + (band + 1) + ' of ' + S.n : '');
  readout.classList.add('show');
  clearTimeout(readTimer);
  readTimer = setTimeout(function(){ readout.classList.remove('show'); S.mark = null; drawStrip(); }, 3200);
  drawStrip();
  return band;
}

// =============================================================
// The Squint look as a texture, for Drawing Check's Squint option:
// the reference drawn once with the current squint and values, at
// full size and unturned, redrawn only when a setting changes.
// =============================================================
var lookFBO = null, lookKey = '';
function squintTexture(){
  if(!hasImage || !gl) return texture;
  if(histDirty) updateHist();
  if(!lookFBO || lookFBO.w !== imgW || lookFBO.h !== imgH){ killFBO(lookFBO); lookFBO = makeFBO(imgW, imgH); lookKey = ''; }
  var key = [refVersion, S.blur, S.n, S.th.join(','), tones.join(','), st.chroma.t, S.iso, S.surround].join('|');
  if(key !== lookKey){
    drawMain({ rotation:0, flipX:1, chroma:st.chroma.t, zoom:1, panX:0, panY:0, n:S.n, th:S.th, tones:tones,
               iso:S.iso, grid:0, bg:surroundRGB() }, runBlur(blurPx(S.blur)), lookFBO.fbo, imgW, imgH, 1);
    lookKey = key;
  }
  return lookFBO.tex;
}
