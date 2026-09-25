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
  new ResizeObserver(function(){ clearTimeout(rt); rt = setTimeout(onResize, 60); }).observe(document.body);
} else window.addEventListener('resize', onResize);
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
  if(C.field && C.fieldData) uploadField();
  if(C.refEdge) uploadEdge('ref');
  if(C.drawEdge) uploadEdge('draw');
  paint();
});

// =============================================================
// Boot
// =============================================================
document.addEventListener('selectstart', function(e){ e.preventDefault(); });
document.addEventListener('dragstart', function(e){ e.preventDefault(); });

applySurround();
if(!initGL()){
  document.querySelector('#empty .lead').textContent = 'This browser can’t run WebGL, which this tool needs to draw the picture.';
  document.querySelector('#empty .actions').style.display = 'none';
}
setMode(/check/.test(location.hash) ? 'check' : (load('mode', 'squint') === 'check' ? 'check' : 'squint'));
sizeCanvas();
requestAnimationFrame(drawStrip);

// For testing in a browser console: window.__sc.state()
window.__sc = { state:function(){ return { mode:MODE, hasImage:hasImage, view:view, C:{ has:C.has, P:C.P, auto:C.auto, moved:C.moved, field:C.field, frame:C.frame, frameOn:C.frameOn, matching:C.matching, status:C.status, box:C.box, refEdge:C.refEdge, drawEdge:C.drawEdge, line:C.line }, S:{ n:S.n, th:S.th, shift:S.shift, split:S.split } }; },
  loadPair:loadPair, setMode:setMode, loadDrawing:loadDrawing, refSize:function(){ return [C.rw, C.rh]; },
  // Client coordinates of the rotate handle and the frame's corners, for scripted pointer tests.
  handle:function(){ var r = stage.getBoundingClientRect(), g = handleGeom(m3inv(viewToRef(canvas.width, canvas.height))); return [r.left + g.handle[0], r.top + g.handle[1]]; },
  frame:function(){ var r = stage.getBoundingClientRect(); return frameScreen(m3inv(viewToRef(canvas.width, canvas.height))).map(function(p){ return [r.left + p[0], r.top + p[1]]; }); } };
