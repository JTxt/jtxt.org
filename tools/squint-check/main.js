/* Squint & Check. Resize, theme and context loss, then boot.
   Loaded by index.html; the scripts share one global scope.
   co-authors: jtxt.org and claude opus 5.5 */
"use strict";

// =============================================================
// Resize, theme and context loss
// =============================================================
function onResize(){ sizeCanvas(); paint(); drawStrip(); }
if('ResizeObserver' in window){
  var rt = null;
  // The stage, not only the body: it also changes size when the tools slide up or down.
  var ro = new ResizeObserver(function(){ clearTimeout(rt); rt = setTimeout(onResize, 60); });
  ro.observe(document.body); ro.observe(stage); ro.observe(panelEl);
} else window.addEventListener('resize', onResize);
// =============================================================
// Glass: is the panel's blur too slow on this device?
// =============================================================
// While a finger moves the picture, time the frames. A smooth device keeps the glass. If
// the frames are slow (median over 22 ms, under about 45 a second), the next move runs
// without the glass: when that is clearly faster, the blur was the cost, so it stays off on
// this device. When it is not, something else is slow, and the glass comes back.
// Stored as squintcheck.glass: 'on' (keep it) or 'off'. Delete that key to test again.
var glass = { state:load('glass', ''), times:[], last:0, live:false, slowOn:0 };
if(glass.state === 'off') app.dataset.glass = 'off';
function glassFrame(now){
  if(!glass.live) return;
  if(glass.last) glass.times.push(now - glass.last);
  glass.last = now;
  requestAnimationFrame(glassFrame);
}
stage.addEventListener('pointerdown', function(){
  if(glass.state || glass.live || !hasImage || !(coverX || coverY)) return;
  glass.live = true; glass.times = []; glass.last = 0;
  requestAnimationFrame(glassFrame);
}, { passive:true });
function glassEnd(){
  if(!glass.live) return;
  glass.live = false;
  var t = glass.times.slice().sort(function(a, b){ return a - b; });
  if(t.length < 20) return;   // a tap, or too short to tell
  var med = t[t.length >> 1];
  if(!glass.slowOn){
    if(med > 22){ glass.slowOn = med; app.dataset.glass = 'off'; }   // try the next move without it
    return;
  }
  glass.state = med < glass.slowOn*0.8 ? 'off' : 'on';
  app.dataset.glass = glass.state;
  store('glass', glass.state);
}
stage.addEventListener('pointerup', glassEnd);
stage.addEventListener('pointercancel', glassEnd);

if(window.matchMedia){
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  if(mq.addEventListener) mq.addEventListener('change', function(){ edgeCols = null; drawStrip(); paint(); });
}

canvas.addEventListener('webglcontextlost', function(e){ e.preventDefault(); glLost = true; running = false; });
canvas.addEventListener('webglcontextrestored', function(){
  glLost = false; fboA = fboB = null; lookFBO = null; lookKey = '';
  if(!initGL()) return;
  if(lastPrepared){ upload(lastPrepared); setupTargets(imgW, imgH); histCache = {}; histDirty = true; }
  if(C.drawCanvas) uploadDraw();
  remakeMasks();
  paint();
});

// =============================================================
// Boot
// =============================================================
document.addEventListener('selectstart', function(e){ e.preventDefault(); });
document.addEventListener('dragstart', function(e){ e.preventDefault(); });

applySurround();
applyTheme();
if(!initGL()){
  document.querySelector('#empty .lead').textContent = 'This browser can’t run WebGL, which this tool needs to draw the picture.';
  document.querySelector('#empty .actions').style.display = 'none';
}
setMode(/check/.test(location.hash) ? 'check' : (load('mode', 'squint') === 'check' ? 'check' : 'squint'));
sizeCanvas();
requestAnimationFrame(drawStrip);

// For testing in a browser console: window.__sc.state()
window.__sc = { state:function(){ return { mode:MODE, hasImage:hasImage, view:view, C:{ has:C.has, P:C.P, auto:C.auto, moved:C.moved, frame:C.frame, frameOn:C.frameOn, matching:C.matching, status:C.status, box:C.box, line:C.line,
    view:C.view, mix:C.mix, drift:C.drift, move:C.move, driftFresh:driftFresh(), driftTag:driftText(),
    analysis:C.analysis && { score:C.analysis.score, rmsPct:C.analysis.rmsPct, cells:C.analysis.cells.length, arrows:driftCells().length },
    mask:{ ref:C.mask.ref && { w:C.mask.ref.w, h:C.mask.ref.h, edges:C.mask.ref.edges }, draw:C.mask.draw && { w:C.mask.draw.w, h:C.mask.draw.h, edges:C.mask.draw.edges } } }, S:{ n:S.n, th:S.th, shift:S.shift, split:S.split } }; },
  loadPair:loadPair, setMode:setMode, setView:setView, setDrift:setDrift, openViews:openViews, closeViews:closeViews,
  setMix:function(v){ fade.value = v; fade.dispatchEvent(new Event('input')); }, loadDrawing:loadDrawing, refSize:function(){ return [C.rw, C.rh]; },
  // Client coordinates of the rotate handle and the frame's corners, for scripted pointer tests.
  handle:function(){ var r = stage.getBoundingClientRect(), g = handleGeom(m3inv(viewToRef(canvas.width, canvas.height))); return [r.left + g.handle[0], r.top + g.handle[1]]; },
  frame:function(){ var r = stage.getBoundingClientRect(); return frameScreen(m3inv(viewToRef(canvas.width, canvas.height))).map(function(p){ return [r.left + p[0], r.top + p[1]]; }); } };
