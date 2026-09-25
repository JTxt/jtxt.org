/* Squint & Check. Shared by both tabs: settings, the DOM, the view and render loop, UI sync, tabs, loading the reference, saving.
   Loaded by index.html; the scripts share one global scope. */
"use strict";

function $(id){ return document.getElementById(id); }

// =============================================================
// Settings. Blur is measured against the picture's short side, so
// a look means the same thing on a phone snap and a 40 MP scan.
// Values are measured in CIE L* (0 black to 100 white), the same
// scale as a painter's value scale divided by ten.
// =============================================================
var MAX_LEVEL = 6;
var MAX_TEX = (Math.min(screen.width, screen.height) < 700) ? 1600 : 2048;
var EASE = 14, HOLD_MS = 230;
var SURROUNDS = { black:'#000000', dark:'#2a2a2a', mid:'#777777', white:'#ffffff' };
var COLORS = ['full', 'muted', 'gray'];
var CHROMA = { full:1, muted:0.35, gray:0 };
var COLOR_NAMES = { full:'Color', muted:'Muted', gray:'Gray' };
var GRIDS = [0, 3, 4, 6];
var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Boundaries are kept as thBase (fitted, even, or moved by hand) and shown
// as th: the same set moved by `shift`, so one slider moves them all.
var S = {
  blur:0, n:0, th:[], thBase:[], shift:0, split:'fit', tones:'seen', color:'full',
  grid:0, iso:-1, mirror:false, surround:'mid', mark:null
};
var tones = [];
var MODE = 'squint';

function load(k, d){ try { var v = localStorage.getItem('squintcheck.' + k); return v == null ? d : v; } catch(e){ return d; } }
function store(k, v){ try { localStorage.setItem('squintcheck.' + k, v); } catch(e){} }
S.surround = SURROUNDS[load('surround', 'mid')] ? load('surround', 'mid') : 'mid';
S.tones = load('tones', 'seen') === 'scale' ? 'scale' : 'seen';

function blurPct(s){ return 6 * Math.pow(s / 100, 2); }
function blurPx(s){ return blurPct(s) / 100 * Math.min(imgW || 1, imgH || 1); }

function toLstar(L){ var Y = L*L*L; return Y > 0.008856 ? 116*L - 16 : 903.3*Y; }
function lstarToDisplay(ls){
  // Same gamma-2 model the renderer uses, so swatches match the picture.
  var Y = ls > 8 ? Math.pow((ls + 16) / 116, 3) : ls / 903.3;
  var v = Math.round(Math.sqrt(Math.max(0, Math.min(1, Y))) * 255);
  return 'rgb(' + v + ',' + v + ',' + v + ')';
}
function hexRGB(h){
  return [parseInt(h.substr(1,2),16)/255, parseInt(h.substr(3,2),16)/255, parseInt(h.substr(5,2),16)/255];
}

// 3×3 matrices, row-major, for the 2-D affine maps between screen, reference and drawing.
var IDENT = [1,0,0, 0,1,0, 0,0,1];
function m3mul(a, b){
  var o = new Array(9);
  for(var r = 0; r < 3; r++) for(var c = 0; c < 3; c++)
    o[r*3+c] = a[r*3]*b[c] + a[r*3+1]*b[3+c] + a[r*3+2]*b[6+c];
  return o;
}
function m3inv(m){
  var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
  var det = a*e - b*d || 1e-12;
  return [ e/det, -b/det, (b*f - c*e)/det, -d/det, a/det, (c*d - a*f)/det, 0, 0, 1 ];
}
function m3apply(m, x, y){ return [m[0]*x + m[1]*y + m[2], m[3]*x + m[4]*y + m[5]]; }
var GLM = new Float32Array(9);
function m3gl(m){ // column-major for uniformMatrix3fv
  GLM[0] = m[0]; GLM[1] = m[3]; GLM[2] = m[6]; GLM[3] = m[1]; GLM[4] = m[4]; GLM[5] = m[7]; GLM[6] = m[2]; GLM[7] = m[5]; GLM[8] = m[8];
  return GLM;
}
function wrapAngle(a){ while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }

// =============================================================
// DOM
// =============================================================
var app = $('app'), stage = $('stage'), canvas = $('gl'), ov = $('ov'), ovCtx = ov.getContext('2d');
var empty = $('empty'), emptyDraw = $('emptyDraw'), drop = $('drop'), toastEl = $('toast');
var readout = $('readout'), readSwatch = $('readSwatch'), readValue = $('readValue'), readMeta = $('readMeta');
var beforeTag = $('beforeTag'), zoomTag = $('zoomTag');
var looks = $('looks'), lookGrid = $('lookGrid');
var strip = $('strip'), stripCv = $('stripCv'), stripHint = $('stripHint');
var shiftEl = $('shift'), fitBtn = $('fitBtn');
var squint = $('squint'), squintOut = $('squintOut');
var fade = $('fade'), fadeOut = $('fadeOut'), statusEl = $('checkStatus'), statusBtn = $('statusBtn');
var saveSheet = $('saveSheet');
var fileInput = $('fileInput'), drawInput = $('drawInput');
var chips = Array.prototype.slice.call(document.querySelectorAll('#nChips .chip'));
var tools = {}, ctools = {};
Array.prototype.forEach.call(document.querySelectorAll('.tool[data-t]'), function(b){ tools[b.dataset.t] = b; });
Array.prototype.forEach.call(document.querySelectorAll('.tool[data-c]'), function(b){ ctools[b.dataset.c] = b; });

var toastTimer = null;
function toast(msg, ms){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, ms || 2600);
}

// =============================================================
// Eased state: only the things that should visibly move
// =============================================================
var st = {
  rot:{ c:0, t:0 }, flip:{ c:1, t:1 }, chroma:{ c:1, t:1 }
};
var ST_KEYS = ['rot','flip','chroma'];

// =============================================================
// Render loop
// =============================================================
var running = false, lastT = 0, comparing = false;
var view = { zoom:1, x:0, y:0 };

function surroundRGB(){ return hexRGB(SURROUNDS[S.surround]); }

function viewValues(){
  var v = {
    rotation:st.rot.c, flipX:st.flip.c, chroma:st.chroma.c,
    zoom:view.zoom, panX:view.x, panY:view.y,
    n:S.n, th:S.th, tones:tones, iso:S.iso, grid:S.grid,
    blurPx:blurPx(S.blur), bg:surroundRGB()
  };
  if(comparing){ v.chroma = 1; v.n = 0; v.iso = -1; v.blurPx = 0; v.grid = 0; }
  return v;
}
function sizeCanvas(){
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = Math.max(1, Math.round(stage.clientWidth*dpr)), h = Math.max(1, Math.round(stage.clientHeight*dpr));
  if(canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
  if(ov.width !== w || ov.height !== h){ ov.width = w; ov.height = h; }
}
function clearOverlay(){ ovCtx.setTransform(1,0,0,1,0,0); ovCtx.clearRect(0, 0, ov.width, ov.height); }
function paint(){
  if(!gl || glLost || !hasImage){ clearOverlay(); return; }
  if(MODE === 'check'){ paintCheck(); return; }
  clearOverlay();
  sizeCanvas();
  if(histDirty) updateHist();
  var v = viewValues();
  drawMain(v, runBlur(v.blurPx), null, canvas.width, canvas.height, 1);
}
function settled(){
  for(var i = 0; i < ST_KEYS.length; i++){
    var n = st[ST_KEYS[i]]; if(Math.abs(n.t - n.c) > 0.0015) return false;
  }
  return true;
}
function requestRender(){
  if(running || !hasImage) return;
  running = true; lastT = 0;
  requestAnimationFrame(frame);
}
function frame(now){
  if(!lastT) lastT = now;
  var dt = Math.min((now - lastT)/1000, 0.05); lastT = now;
  var k = 1 - Math.exp(-dt*EASE), i;
  for(i = 0; i < ST_KEYS.length; i++){ var n = st[ST_KEYS[i]]; n.c += (n.t - n.c)*k; }
  var animDone = stepAnim(now);
  var done = settled();
  if(done) for(i = 0; i < ST_KEYS.length; i++) st[ST_KEYS[i]].c = st[ST_KEYS[i]].t;
  paint();
  if(done && animDone){ running = false; return; }
  requestAnimationFrame(frame);
}

// =============================================================
// UI sync
// =============================================================
function pressed(nodes, test){
  Array.prototype.forEach.call(nodes, function(b){ b.setAttribute('aria-pressed', String(test(b))); });
}
function syncUI(){
  pressed(document.querySelectorAll('#tabs button'), function(b){ return b.dataset.mode === MODE; });
  // Rotate and Mirror turn the one view both tabs share.
  var deg = Math.round(((st.rot.t*180/Math.PI) % 360 + 360) % 360);
  Array.prototype.forEach.call(document.querySelectorAll('.rotName'), function(n){ n.textContent = deg ? deg + '°' : 'Rotate'; });
  [tools.rotate, ctools.rotate].forEach(function(t){ t.classList.toggle('on', deg !== 0); });
  [tools.mirror, ctools.mirror].forEach(function(t){
    t.classList.toggle('on', S.mirror); t.setAttribute('aria-pressed', String(S.mirror));
  });
  // Grid too: one grid, shown on both tabs.
  Array.prototype.forEach.call(document.querySelectorAll('.gridName'), function(n){ n.textContent = S.grid ? S.grid + '×' + S.grid : 'Grid'; });
  [tools.grid, ctools.grid].forEach(function(t){ t.classList.toggle('on', S.grid > 0); });
  syncSquint();
  syncCheck();
}

function cycleGrid(){ S.grid = GRIDS[(GRIDS.indexOf(S.grid) + 1) % GRIDS.length]; syncUI(); paint(); }
function rotate(dir){
  st.rot.t += dir*Math.PI/2;
  if(Math.abs(st.rot.t) > Math.PI*4){ st.rot.t %= Math.PI*2; st.rot.c %= Math.PI*2; }
  syncUI(); requestRender();
}
function toggleMirror(){ S.mirror = !S.mirror; st.flip.t = S.mirror ? -1 : 1; syncUI(); requestRender(); }
function setComparing(on){
  if(comparing === on) return;
  comparing = on;
  beforeTag.textContent = MODE === 'check' ? 'Reference only' : 'Before';
  beforeTag.classList.toggle('show', on);
  tools.before.classList.toggle('held', on);
  ctools.peek.classList.toggle('held', on);
  paint();
}
function holdButton(btn){
  btn.addEventListener('pointerdown', function(e){
    if(!hasImage) return;
    try { btn.setPointerCapture(e.pointerId); } catch(err){}
    setComparing(true);
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(function(ev){
    btn.addEventListener(ev, function(){ setComparing(false); });
  });
  btn.addEventListener('click', function(e){
    if(e.detail === 0 && hasImage){ setComparing(true); setTimeout(function(){ setComparing(false); }, 900); }
  });
  btn.addEventListener('contextmenu', function(e){ e.preventDefault(); });
}

// =============================================================
// Tabs
// =============================================================
function setMode(m){
  if(m !== 'check') m = 'squint';
  if(looksOpen) closeLooks();
  setComparing(false);
  MODE = m; app.dataset.mode = m; store('mode', m);
  readout.classList.remove('show');
  syncEmpty(); syncUI();
  requestAnimationFrame(function(){ sizeCanvas(); paint(); drawStrip(); });
}
Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function(b){
  b.addEventListener('click', function(){ setMode(b.dataset.mode); });
});
function syncEmpty(){
  // Until there's a picture the canvas would show black; let the surround show instead.
  canvas.style.visibility = ov.style.visibility = hasImage ? '' : 'hidden';
  empty.classList.toggle('hidden', hasImage);
  emptyDraw.classList.toggle('hidden', !(hasImage && MODE === 'check' && !C.has));
  if(!exampleBtn.disabled) exampleBtn.textContent = MODE === 'check' ? 'Try the sample pair' : 'Try a sample image';
}

function applySurround(){ document.documentElement.style.setProperty('--surround', SURROUNDS[S.surround]); }

// =============================================================
// Loading the reference
// =============================================================
var sampleData = null;
var refVersion = 0;     // changes with every new reference, for caches built from it

function prepare(source, maxDim){
  var iw = source.width || source.naturalWidth || 1, ih = source.height || source.naturalHeight || 1;
  var isBitmap = (typeof ImageBitmap !== 'undefined') && (source instanceof ImageBitmap);
  if(iw <= maxDim && ih <= maxDim && !isBitmap) return { image:source, w:iw, h:ih };
  var k = Math.min(maxDim/iw, maxDim/ih, 1);
  var w = Math.max(1, Math.round(iw*k)), h = Math.max(1, Math.round(ih*k));
  var c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(source, 0, 0, w, h);
  return { image:c, w:w, h:h };
}
function buildSample(p){
  sampleData = null;
  var k = Math.min(640/p.w, 640/p.h, 1);
  var w = Math.max(1, Math.round(p.w*k)), h = Math.max(1, Math.round(p.h*k));
  var c = document.createElement('canvas'); c.width = w; c.height = h;
  var ctx = c.getContext('2d', { willReadFrequently:true });
  ctx.drawImage(p.image, 0, 0, w, h);
  try { sampleData = { d:ctx.getImageData(0, 0, w, h).data, w:w, h:h }; } catch(e){ sampleData = null; }
}
function upload(p){
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.image);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

function loadSource(source, name){
  var p = prepare(source, MAX_TEX);
  lastPrepared = p; lastName = name || 'picture'; refVersion++;
  imgW = p.w; imgH = p.h;
  upload(p); setupTargets(imgW, imgH); buildSample(p);
  hasImage = true; histCache = {};

  S.blur = 0; S.n = 0; S.split = 'fit'; S.shift = 0; S.thBase = []; S.iso = -1; S.grid = 0; S.mirror = false; S.mark = null;
  S.color = 'full';
  st.rot.c = st.rot.t = 0; st.flip.c = st.flip.t = 1; st.chroma.c = st.chroma.t = 1;
  view.zoom = 1; view.x = 0; view.y = 0;
  readout.classList.remove('show');
  histDirty = true;
  setCheckReference(p);
  syncEmpty(); syncUI(); paint(); drawStrip();
  if(MODE === 'squint') openLooks();
}

function decode(file, done){
  if(!file || !gl) return;
  if(file.type && file.type.indexOf('image/') !== 0){ toast('That file isn’t an image. Try a JPEG or PNG.'); return; }
  function fallback(){
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function(){ done(img, file.name); URL.revokeObjectURL(url); };
    img.onerror = function(){ URL.revokeObjectURL(url); toast('That file isn’t an image this browser can open. Try a JPEG or PNG.'); };
    img.src = url;
  }
  if('createImageBitmap' in window){
    var pr;
    try { pr = createImageBitmap(file, { imageOrientation:'from-image' }); }
    catch(e){ fallback(); return; }
    pr.then(function(b){ done(b, file.name); }, fallback);
  } else fallback();
}
function handleFile(file, target, then){
  decode(file, function(img, name){
    if(target === 'draw') loadDrawing(img, name); else loadSource(img, name);
    if(then) then();
  });
}

// =============================================================
// Save
// =============================================================
function downloadCanvas(cv, name){
  cv.toBlob(function(blob){
    if(!blob){ toast('The picture couldn’t be saved. Try again after a reload.'); return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
    toast('Saved ' + name);
  }, 'image/png');
}
function baseName(n){ return (n || 'picture').replace(/\.[^.]+$/, ''); }
