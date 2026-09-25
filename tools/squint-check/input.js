/* Squint & Check. Input: stage gestures for both tabs, open, drop and paste, and the keyboard.
   Loaded by index.html; the scripts share one global scope. */
"use strict";

// =============================================================
// Stage gestures
//   Squint: tap reads a value, double tap isolates its band,
//     hold shows the original, pinch or wheel zooms, drag pans.
//   Check, moving the drawing: drag moves it, pinch or wheel scales it,
//     twist or the hover handle turns it, frame edges drag.
//   Check, moving the view: as Squint, and hold hides the outline.
// =============================================================
var holdTimer = null, downX = 0, downY = 0, moved = false, held = false;
var pointers = {}, pinch = null, panning = false, lastTap = { t:0, x:0, y:0 };
var drag = null, lastPtr = 'mouse', wheelTimer = null;

function steering(){ return MODE === 'check' && C.has && C.P && C.move === 'drawing'; }

function toCanvas(cx, cy){
  var r = stage.getBoundingClientRect();
  return {
    x: (cx - r.left)*canvas.width/Math.max(1, r.width) - canvas.width/2,
    y: -((cy - r.top)*canvas.height/Math.max(1, r.height) - canvas.height/2)
  };
}
function clampPan(){
  var mx = canvas.width*0.5*(view.zoom - 1), my = canvas.height*0.5*(view.zoom - 1);
  view.x = Math.max(-mx, Math.min(mx, view.x)); view.y = Math.max(-my, Math.min(my, view.y));
}
var zoomTimer = null;
function showZoom(){
  zoomTag.textContent = Math.round(view.zoom*100) + '%';
  zoomTag.classList.toggle('show', view.zoom > 1.005);
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(function(){ zoomTag.classList.remove('show'); }, 1400);
}
function zoomAbout(pt, factor){
  var z = Math.max(1, Math.min(16, view.zoom*factor)), k = z/view.zoom;
  if(k === 1) return;
  view.x = pt.x - (pt.x - view.x)*k; view.y = pt.y - (pt.y - view.y)*k;
  view.zoom = z; clampPan(); showZoom(); paint();
}
function resetView(){ view.zoom = 1; view.x = 0; view.y = 0; showZoom(); paint(); }

function list(){ var o = []; for(var k in pointers) if(pointers.hasOwnProperty(k)) o.push(pointers[k]); return o; }
function beginPinch(){
  var p = list(); if(p.length < 2) return;
  clearTimeout(holdTimer);
  if(held){ held = false; setComparing(false); }
  panning = false; moved = true;
  if(steering()){
    stopAnim(); drag = null;
    pinch = { kind:'draw', a:screenToRef(p[0].x, p[0].y), b:screenToRef(p[1].x, p[1].y) };
    return;
  }
  pinch = { kind:'view', dist:Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1,
            mid:toCanvas((p[0].x + p[1].x)/2, (p[0].y + p[1].y)/2) };
}
// Two fingers on the drawing: their spread scales it, their twist turns it, their middle moves it.
function pinchDrawing(p){
  var a = screenToRef(p[0].x, p[0].y), b = screenToRef(p[1].x, p[1].y), a0 = pinch.a, b0 = pinch.b;
  var d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1, d1 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  var rot = wrapAngle(Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x));
  var m0 = { x:(a0.x + b0.x)/2, y:(a0.y + b0.y)/2 }, m1 = { x:(a.x + b.x)/2, y:(a.y + b.y)/2 };
  transformAbout(m0, d1/d0, rot, m1.x - m0.x, m1.y - m0.y);
  pinch.a = a; pinch.b = b; C.moved = true;
  paint();
}
function stepDrag(e){
  var R = screenToRef(e.clientX, e.clientY);
  if(drag.kind === 'draw'){
    C.P.tx += R.x - drag.R.x; C.P.ty += R.y - drag.R.y; drag.R = R; C.moved = true;
  } else if(drag.kind === 'rotate'){
    var a = Math.atan2(R.y - drag.c.y, R.x - drag.c.x);
    transformAbout(drag.c, 1, wrapAngle(a - drag.a), 0, 0); drag.a = a; C.moved = true;
  } else if(drag.kind === 'frame'){
    moveFrame(drag.edges, R);
  }
  paint();
}

stage.addEventListener('pointerdown', function(e){
  lastPtr = e.pointerType || 'mouse';
  if(!hasImage || looksOpen || saveOpen) return;
  if(e.target.closest && e.target.closest('.empty, #looks')) return;
  if(e.pointerType === 'mouse' && e.button !== 0) return;
  pointers[e.pointerId] = { x:e.clientX, y:e.clientY };
  try { stage.setPointerCapture(e.pointerId); } catch(err){}
  if(list().length === 2){ beginPinch(); return; }
  if(list().length > 2) return;
  downX = e.clientX; downY = e.clientY; moved = false; held = false; panning = false; drag = null;
  if(MODE === 'check' && C.has && C.P){
    var hit = hitTest(e);
    if(hit && hit.type === 'rotate'){
      var c = boxCenterR(), R0 = screenToRef(e.clientX, e.clientY);
      drag = { kind:'rotate', c:c, a:Math.atan2(R0.y - c.y, R0.x - c.x) };
    }
    else if(hit && hit.type === 'frame') drag = { kind:'frame', edges:hit.edges };
    else if(C.move === 'drawing') drag = { kind:'draw', R:screenToRef(e.clientX, e.clientY) };
  }
  // No hold-to-peek while steering the drawing: a pause before a drag is normal.
  if(drag){ stopAnim(); return; }
  holdTimer = setTimeout(function(){
    if(panning || moved) return;
    held = true; setComparing(true);
  }, HOLD_MS);
});
stage.addEventListener('pointermove', function(e){
  if(!pointers[e.pointerId]){ if(e.pointerType === 'mouse') hover(e); return; }
  var prev = pointers[e.pointerId], dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers[e.pointerId] = { x:e.clientX, y:e.clientY };
  var p = list();
  if(p.length >= 2){
    if(!pinch) beginPinch();
    if(!pinch) return;
    if(pinch.kind === 'draw'){ pinchDrawing(p); return; }
    var dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
    var mid = toCanvas((p[0].x + p[1].x)/2, (p[0].y + p[1].y)/2);
    view.x += mid.x - pinch.mid.x; view.y += mid.y - pinch.mid.y;
    pinch.mid = mid;
    zoomAbout(mid, dist/pinch.dist); pinch.dist = dist;
    return;
  }
  if(drag){
    if(!moved && Math.abs(e.clientX - downX) < 3 && Math.abs(e.clientY - downY) < 3) return;
    moved = true;
    stepDrag(e);
    return;
  }
  if(Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8){
    moved = true; clearTimeout(holdTimer);
    if(!held && view.zoom > 1.001) panning = true;
  }
  if(panning && !held){
    var r = stage.getBoundingClientRect();
    view.x += dx*canvas.width/r.width; view.y -= dy*canvas.height/r.height;
    clampPan(); paint();
  }
});
function stageUp(e){
  if(e && pointers[e.pointerId]) delete pointers[e.pointerId];
  if(list().length < 2) pinch = null;
  if(list().length > 0) return;
  clearTimeout(holdTimer);
  var was = drag; drag = null;
  if(held){ setComparing(false); }
  else if(!moved && !panning && hasImage && !looksOpen && e.type === 'pointerup'){
    var now = Date.now();
    var isDouble = now - lastTap.t < 320 && Math.abs(downX - lastTap.x) < 24 && Math.abs(downY - lastTap.y) < 24;
    if(MODE === 'squint'){
      var band = readAt(downX, downY);
      if(isDouble){
        lastTap.t = 0;
        if(S.n > 1 && band != null && band >= 0) setIso(S.iso === band ? -1 : band);
        else if(view.zoom > 1.001) resetView();
      } else lastTap = { t:now, x:downX, y:downY };
    } else {
      if(isDouble){ lastTap.t = 0; if(view.zoom > 1.001) resetView(); }
      else lastTap = { t:now, x:downX, y:downY };
    }
  }
  if(MODE === 'check' && moved && (was ? was.kind !== 'frame' : steering())) afterHandMove();
  if(was && was.kind === 'rotate') paint();
  held = false; panning = false;
}
stage.addEventListener('pointerup', stageUp);
stage.addEventListener('pointercancel', stageUp);
stage.addEventListener('contextmenu', function(e){ if(hasImage) e.preventDefault(); });
stage.addEventListener('wheel', function(e){
  if(!hasImage || looksOpen || saveOpen) return;
  e.preventDefault();
  var d = e.deltaMode === 1 ? e.deltaY*16 : e.deltaY, factor = Math.exp(-d*0.0022);
  if(steering()){
    stopAnim();
    transformAbout(screenToRef(e.clientX, e.clientY), factor, 0, 0, 0);
    C.moved = true; paint();
    clearTimeout(wheelTimer); wheelTimer = setTimeout(afterHandMove, 350);
    return;
  }
  zoomAbout(toCanvas(e.clientX, e.clientY), factor);
}, { passive:false });

// Safari sends trackpad pinch and twist as its own gesture events. On iPhone the
// same fingers also send pointer events, which the pinch above already handles.
var gest = null;
stage.addEventListener('gesturestart', function(e){ e.preventDefault(); gest = { s:1, r:0 }; });
stage.addEventListener('gesturechange', function(e){
  e.preventDefault();
  if(!gest || !hasImage || list().length >= 2) return;
  var f = e.scale/gest.s, rot = (e.rotation - gest.r)*Math.PI/180;
  gest.s = e.scale; gest.r = e.rotation;
  if(steering()){
    stopAnim();
    transformAbout(screenToRef(e.clientX, e.clientY), f, rot*(st.flip.t < 0 ? -1 : 1), 0, 0);
    C.moved = true; paint();
  } else zoomAbout(toCanvas(e.clientX, e.clientY), f);
});
stage.addEventListener('gestureend', function(e){ e.preventDefault(); if(gest && steering()) afterHandMove(); gest = null; });

// =============================================================
// Open, drop, paste
// =============================================================
fileInput.addEventListener('change', function(e){
  var f = e.target.files && e.target.files[0];
  if(f) handleFile(f, 'ref');
  fileInput.value = '';
});
drawInput.addEventListener('change', function(e){
  var f = e.target.files && e.target.files[0];
  if(f) handleFile(f, 'draw');
  drawInput.value = '';
});
$('openBtn').addEventListener('click', function(){ fileInput.click(); });
$('drawBtn').addEventListener('click', function(){ drawInput.click(); });
$('pairBtn').addEventListener('click', loadPair);
// The sample image is Squint's, next door on the website.
var exampleBtn = $('exampleBtn');
exampleBtn.addEventListener('click', function(){
  if(!gl) return;
  if(MODE === 'check'){ loadPair(); return; }
  var label = exampleBtn.textContent;
  exampleBtn.disabled = true; exampleBtn.textContent = 'Loading…';
  function done(){ exampleBtn.disabled = false; exampleBtn.textContent = label; }
  function failed(){ done(); toast('The sample image couldn’t load. Open a photo of your own instead.'); }
  fetch('../squint/sample-cc0-image.jpg').then(function(res){
    if(!res.ok) throw new Error('missing');
    return res.blob();
  }).then(function(blob){
    if(!blob.type || blob.type.indexOf('image/') !== 0) throw new Error('not an image');
    var img = new Image(), url = URL.createObjectURL(blob);
    img.onload = function(){ URL.revokeObjectURL(url); done(); loadSource(img, 'sample-cc0-image.jpg'); };
    img.onerror = function(){ URL.revokeObjectURL(url); failed(); };
    img.src = url;
  }).catch(failed);
});

// In Check, one file is the drawing (once there's a reference); two are the reference, then the drawing.
function routeFiles(files){
  if(!files.length) return;
  if(MODE === 'check'){
    if(files.length >= 2){ C.has = false; handleFile(files[0], 'ref', function(){ handleFile(files[1], 'draw'); }); return; }
    handleFile(files[0], hasImage ? 'draw' : 'ref');
    return;
  }
  handleFile(files[0], 'ref');
}
var dragDepth = 0;
window.addEventListener('dragenter', function(e){ e.preventDefault(); dragDepth++; drop.classList.add('show'); });
window.addEventListener('dragover', function(e){ e.preventDefault(); });
window.addEventListener('dragleave', function(){ dragDepth = Math.max(0, dragDepth - 1); if(!dragDepth) drop.classList.remove('show'); });
window.addEventListener('drop', function(e){
  e.preventDefault(); dragDepth = 0; drop.classList.remove('show');
  var fl = e.dataTransfer && e.dataTransfer.files;
  if(fl && fl.length) routeFiles(Array.prototype.slice.call(fl, 0, 2));
});
window.addEventListener('paste', function(e){
  var items = e.clipboardData && e.clipboardData.items;
  if(!items) return;
  for(var i = 0; i < items.length; i++){
    if(items[i].type && items[i].type.indexOf('image/') === 0){
      var f = items[i].getAsFile();
      if(f){ routeFiles([f]); e.preventDefault(); }
      break;
    }
  }
});

// =============================================================
// Keyboard
// =============================================================
function nudge(dx, dy){
  var r = stage.getBoundingClientRect(), cx = r.left + r.width/2, cy = r.top + r.height/2;
  var a = screenToRef(cx, cy), b = screenToRef(cx + dx, cy + dy);
  stopAnim(); C.P.tx += b.x - a.x; C.P.ty += b.y - a.y; C.moved = true; paint(); afterHandMove();
}
window.addEventListener('keydown', function(e){
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  var ae = document.activeElement, tag = ae && ae.tagName;
  if(tag === 'INPUT' && ae.type !== 'range') return;
  var k = e.key.toLowerCase();
  if(k === 'escape'){
    if(saveOpen) closeSave(); else if(looksOpen) closeLooks(); else if(S.iso >= 0) setIso(-1);
    return;
  }
  if(saveOpen || looksOpen && k !== 'l') return;
  if(e.key === ' ' && hasImage && !e.repeat && tag !== 'BUTTON'){ setComparing(true); e.preventDefault(); return; }
  if(!hasImage){ if(k === 'o') fileInput.click(); return; }
  var common = { 'r':function(){ rotate(1); }, 'm':toggleMirror, 'f':resetView,
    '=':function(){ zoomAbout({ x:0, y:0 }, 1.25); }, '+':function(){ zoomAbout({ x:0, y:0 }, 1.25); },
    '-':function(){ zoomAbout({ x:0, y:0 }, 0.8); } };
  if(common[k]){ common[k](); return; }
  if(MODE === 'check'){
    var onRange = tag === 'INPUT';
    var step = e.shiftKey ? 10 : 1;
    switch(k){
      case 'o': drawInput.click(); break;
      case 's': openSave(); break;
      case 'g': cycleGrid(); break;
      case '[': if(C.has && C.P){ stopAnim(); transformAbout(boxCenterR(), 1, -0.5*Math.PI/180, 0, 0); C.moved = true; paint(); afterHandMove(); } break;
      case ']': if(C.has && C.P){ stopAnim(); transformAbout(boxCenterR(), 1, 0.5*Math.PI/180, 0, 0); C.moved = true; paint(); afterHandMove(); } break;
      case 'arrowleft': case 'arrowright': case 'arrowup': case 'arrowdown':
        if(onRange || !C.has || !C.P) return;
        nudge(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
        e.preventDefault(); break;
    }
    return;
  }
  switch(k){
    case 'o': fileInput.click(); break;
    case 'l': looksOpen ? closeLooks() : openLooks(); break;
    case 'c': cycleColor(); break;
    case 'g': cycleGrid(); break;
    case 's': savePNG(); break;
    case '0': setValues(0); break;
    case '2': case '3': case '4': case '5': case '7': setValues(Number(e.key)); break;
    case '[': S.blur = Math.max(0, S.blur - 5); histDirty = true; syncUI(); requestRender(); break;
    case ']': S.blur = Math.min(100, S.blur + 5); histDirty = true; syncUI(); requestRender(); break;
  }
});
window.addEventListener('keyup', function(e){ if(e.key === ' ') setComparing(false); });
window.addEventListener('blur', function(){ setComparing(false); });
