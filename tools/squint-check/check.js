/* Squint & Check. Drawing Check: placing the drawing on the reference, the outline, the frame, the matcher worker, and saving.
   Loaded by index.html; the scripts share one global scope. */
"use strict";

// =============================================================
// Drawing Check
// =============================================================
// Two coordinate spaces, both in pixels with y down:
//   R, the reference at up to REF_SIDE on its long side (what the matcher sees),
//   D, the drawing at up to DRAW_SIDE.
// The placement P = {scale, theta, tx, ty} maps D onto R: r = scale·rot(theta)·d + t.
// Scaling is always even, so the drawing's own proportions are never stretched away.
// How the drawing shows over the reference. Widths in CSS px on screen.
//   style 0: a line along the thinned marks (Outline has a white halo, Hairline none)
//   style 1: Soft, the marks themselves with a smooth edge
//   style 2: Tint, the marks with no cutoff, as the old Drawing matcher showed them
var LINES = {
  outline:{ style:0, w:1.6, halo:1.2, label:'Outline' },
  soft:{ style:1, w:0, halo:0, label:'Soft' },
  tint:{ style:2, w:0, halo:0, label:'Tint' },
  hairline:{ style:0, w:1, halo:0, label:'Hairline' },
  off:{ style:0, w:0, halo:0, label:'No line' },
  edges:{ style:3, w:0, halo:0, label:'Edges' }
};
var LINE_ORDER = ['outline', 'edges', 'soft', 'tint', 'hairline', 'off'];
// Edges: both pictures as the matcher's edges, like the old Drawing matcher's Edges
// view, found on a 1024px copy and drawn with a thin core and a soft bloom (CSS px).
var EDGE = { side:1024, core:0.6, bloom:1.1 };
var INK_NEUTRAL = [0.08, 0.08, 0.09], INK_COLOR = [0.21, 0.38, 0.83], HALO = [1, 1, 1];
var REF_SIDE = 1600, DRAW_SIDE = 1600, FIELD_SIDE = 1024;
var C = {
  rw:0, rh:0, refData:null,
  has:false, name:'', dw:0, dh:0, drawCanvas:null, drawData:null,
  field:null, fieldData:null,
  P:null, auto:null, autoCost:null, moved:false, box:null, anim:null,
  refEdge:null, refEdgeData:null, drawEdge:null, drawEdgeData:null, edgeJobs:{ ref:0, draw:0 },
  frame:null, frameOn:true,
  // mix: Fade, 0 (outline only) to 100 (drawing only). squint: show the reference
  // with Reference Squint's look. color: a blue line instead of the neutral one.
  mix:Number(load('mix', 0)), squint:false, color:load('lineColor', '0') === '1', line:load('line', 'outline'), move:'view',
  matching:false, job:0, linesJob:0, status:'', statusBtn:null, lastRange:30,
  hoverOn:false, hoverPt:null
};
if(!(C.mix >= 0 && C.mix <= 100)) C.mix = 0;
if(!LINES[C.line]) C.line = 'outline';

function copyP(P){ return { scale:P.scale, theta:P.theta, tx:P.tx, ty:P.ty }; }
function applyP(P, x, y){
  var c = Math.cos(P.theta), s = Math.sin(P.theta);
  return [P.scale*(c*x - s*y) + P.tx, P.scale*(s*x + c*y) + P.ty];
}
function boxD(){ return C.box || { x0:0, y0:0, x1:C.dw, y1:C.dh }; }
function boxCenterD(){ var b = boxD(); return { x:(b.x0 + b.x1)/2, y:(b.y0 + b.y1)/2 }; }
function boxCenterR(){ var c = boxCenterD(), q = applyP(C.P, c.x, c.y); return { x:q[0], y:q[1] }; }
// Move the drawing by an even scale f and a turn rot about the reference point c, then slide it.
function transformAbout(c, f, rot, dx, dy){
  var P = C.P, cs = Math.cos(rot), sn = Math.sin(rot), ux = P.tx - c.x, uy = P.ty - c.y;
  f = Math.max(0.02/P.scale, Math.min(60/P.scale, f));
  P.scale *= f; P.theta = wrapAngle(P.theta + rot);
  P.tx = c.x + f*(cs*ux - sn*uy) + dx; P.ty = c.y + f*(sn*ux + cs*uy) + dy;
}
function guessPlacement(){
  var s = 0.9*Math.min(C.rw/C.dw, C.rh/C.dh);
  return { scale:s, theta:0, tx:C.rw/2 - s*C.dw/2, ty:C.rh/2 - s*C.dh/2 };
}

// Screen (the canvas's 0..1 uv, y up) -> reference texture uv: the same view
// the Squint shader applies, written as one matrix.
function viewToRef(w, h){
  var rot = st.rot.c, fl = st.flip.c, z = view.zoom, fit = fitScaleFor(rot, imgW, imgH, w, h);
  var A = [w, 0, -w/2 - view.x, 0, h, -h/2 - view.y, 0, 0, 1];
  var c = Math.cos(-rot), s = Math.sin(-rot), k = 1/(z*fit);
  var R = [c*k, -s*k, 0, s*k, c*k, 0, 0, 0, 1];
  var E = [fl/imgW, 0, 0.5, 0, 1/imgH, 0.5, 0, 0, 1];
  return m3mul(E, m3mul(R, A));
}
// Reference texture uv -> drawing texture uv, through the placement.
function refToDraw(P){
  var M1 = [C.rw, 0, 0, 0, -C.rh, C.rh, 0, 0, 1];
  var c = Math.cos(P.theta), sn = Math.sin(P.theta), is = 1/P.scale;
  var Pi = [c*is, sn*is, -(c*P.tx + sn*P.ty)*is, -sn*is, c*is, (sn*P.tx - c*P.ty)*is, 0, 0, 1];
  var M3 = [1/C.dw, 0, 0, 0, 1/C.dh, 0, 0, 0, 1];
  return m3mul(M3, m3mul(Pi, M1));
}
function screenToRef(cx, cy){
  var r = stage.getBoundingClientRect();
  var u = (cx - r.left)/Math.max(1, r.width), v = 1 - (cy - r.top)/Math.max(1, r.height);
  var q = m3apply(viewToRef(canvas.width, canvas.height), u, v);
  return { x:q[0]*C.rw, y:(1 - q[1])*C.rh };
}
// Device pixels per R pixel on screen.
function pxPerR(w, h){ return fitScaleFor(st.rot.c, imgW, imgH, w, h) * view.zoom * imgW / C.rw; }
function cssPxPerR(){ return pxPerR(canvas.width, canvas.height) * stage.clientWidth / Math.max(1, canvas.width); }

function drawCheck(target, w, h, o){
  gl.bindFramebuffer(gl.FRAMEBUFFER, target);
  gl.viewport(0, 0, w, h);
  gl.useProgram(checkProg); bindQuad(checkA);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, drawTex);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lineTex);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, o.refTex || texture);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, refEdgeTex);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, drawEdgeTex);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(CU.u_ref, 0); gl.uniform1i(CU.u_draw, 1); gl.uniform1i(CU.u_line, 2);
  gl.uniform1i(CU.u_refEdge, 3); gl.uniform1i(CU.u_drawEdge, 4);
  gl.uniformMatrix3fv(CU.u_toRef, false, m3gl(o.toRef));
  var hasD = C.has && C.P;
  gl.uniformMatrix3fv(CU.u_refToDraw, false, m3gl(hasD ? refToDraw(C.P) : IDENT));
  var bg = o.bg || surroundRGB();
  gl.uniform3f(CU.u_bg, bg[0], bg[1], bg[2]);
  gl.uniform1f(CU.u_mode, o.mode || 0);
  gl.uniform1f(CU.u_mix, hasD ? (o.mix || 0) : 0);
  gl.uniform1f(CU.u_hasDraw, hasD ? 1 : 0);
  var edges = C.line === 'edges';
  var lineOn = !!(hasD && o.showLine && (edges ? C.drawEdge : C.field && C.line !== 'off'));
  gl.uniform1f(CU.u_hasLine, lineOn ? 1 : 0);
  gl.uniform1f(CU.u_style, LINES[C.line].style);
  // Widths arrive in output pixels; the field measures in its own texels.
  var maxD = C.field ? C.field.maxD : 40;
  var ppt = lineOn ? o.pxPerR * C.P.scale * (C.dw / C.field.w) : 1;
  var wT = Math.max(0.75, o.widthPx/ppt), haloT = o.haloPx/ppt, aaT = Math.max(0.05, 0.8/ppt);
  var room = maxD - 1 - aaT;
  if(wT + haloT > room){ var k = room/(wT + haloT); wT *= k; haloT *= k; }
  gl.uniform1f(CU.u_w, wT); gl.uniform1f(CU.u_halo, haloT); gl.uniform1f(CU.u_aa, aaT); gl.uniform1f(CU.u_maxD, maxD);
  var ink = C.color ? INK_COLOR : INK_NEUTRAL;
  gl.uniform3f(CU.u_ink, ink[0], ink[1], ink[2]);
  gl.uniform3f(CU.u_haloC, HALO[0], HALO[1], HALO[2]);
  var f = (o.frameOn && C.frame) ? C.frame : null;
  if(f) gl.uniform4f(CU.u_frame, f.x0/C.rw, 1 - f.y1/C.rh, f.x1/C.rw, 1 - f.y0/C.rh);
  else gl.uniform4f(CU.u_frame, 0, 0, 1, 1);
  gl.uniform1f(CU.u_frameOn, f ? 1 : 0);
  gl.uniform1f(CU.u_edges, edges ? 1 : 0);
  if(edges){
    var ec = edgeColors();
    gl.uniform3f(CU.u_eBg, ec.bg[0], ec.bg[1], ec.bg[2]);
    gl.uniform3f(CU.u_eRef, ec.ref[0], ec.ref[1], ec.ref[2]);
    gl.uniform3f(CU.u_eDraw, ec.draw[0], ec.draw[1], ec.draw[2]);
    gl.uniform1f(CU.u_eMaxD, 32);
    // Core, bloom and antialiasing widths, each in its own field's texels. Zoomed in, the core
    // keeps at least 3/4 of a texel so the gap between diagonal edge pixels stays bridged.
    var wv = function(ppt){ return [Math.max(0.75, EDGE.core*o.unit/ppt), Math.max(0.9, EDGE.bloom*o.unit/ppt), Math.max(0.05, 0.8/ppt)]; };
    var rw = wv(C.refEdge ? o.pxPerR*C.rw/C.refEdge.w : 1), dw = wv(C.drawEdge && hasD ? o.pxPerR*C.P.scale*C.dw/C.drawEdge.w : 1);
    gl.uniform3f(CU.u_rW, rw[0], rw[1], rw[2]); gl.uniform3f(CU.u_dW, dw[0], dw[1], dw[2]);
    gl.uniform1f(CU.u_rHas, C.refEdge ? 1 : 0);
  }
  // Grid lines one output pixel wide, measured in reference uv.
  gl.uniform1f(CU.u_grid, S.grid || 0);
  gl.uniform2f(CU.u_gridPx, 1/(o.pxPerR*C.rw), 1/(o.pxPerR*C.rh));
  drawQuad();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// Drawing Check's controls, from state.
function syncCheck(){
  var on = hasImage, d = on && C.has;
  pressed([$('showSquint')], function(){ return C.squint; });
  pressed([$('showColor')], function(){ return C.color; });
  pressed([$('showLine')], function(){ return C.line !== 'off'; });
  $('showLine').textContent = LINES[C.line].label;
  ['showSquint', 'showColor', 'showLine'].forEach(function(id){ $(id).disabled = !on; });
  if(C.line === 'edges') $('showColor').disabled = true;
  fade.value = C.mix;
  fade.disabled = !d;
  fade.style.setProperty('--p', C.mix + '%');
  fadeOut.textContent = C.mix === 0 ? 'Outline' : C.mix === 100 ? 'Drawing' : C.mix + '%';
  fade.setAttribute('aria-valuetext', C.mix === 0 ? 'outline only' : C.mix === 100 ? 'drawing only' : C.mix + ' percent drawing');
  pressed(document.querySelectorAll('#moveSeg button'), function(b){ return b.dataset.v === C.move; });
  ctools.open.disabled = !on;
  ctools.match.disabled = !d || C.matching;
  ctools.frame.disabled = !d;
  ctools.frame.classList.toggle('on', d && C.frameOn);
  ['grid','rotate','mirror','peek'].forEach(function(k){ ctools[k].disabled = !on; });
  ctools.save.disabled = !d;
  if(!d && !C.matching) setStatus(on ? 'Add a photo of your drawing to check it.' : 'Open a reference first.');
  stage.style.cursor = (MODE === 'check' && d && C.move === 'drawing') ? 'move' : '';
}

function checkRefTex(){ return C.squint ? squintTexture() : texture; }

function paintCheck(){
  sizeCanvas();
  var w = canvas.width, h = canvas.height, M = viewToRef(w, h);
  var dpr = w / Math.max(1, stage.clientWidth);
  // Peek (comparing) shows the reference alone: no outline, no drawing.
  drawCheck(null, w, h, {
    toRef:M, mode:0, refTex:checkRefTex(), mix:comparing ? 0 : C.mix/100, showLine:!comparing, frameOn:C.frameOn,
    pxPerR:pxPerR(w, h), unit:dpr, widthPx:LINES[C.line].w*dpr, haloPx:LINES[C.line].halo*dpr
  });
  drawOverlay(M);
}

// ---------- Overlay: the frame, and the drawing's box with its rotate handle
function handleGeom(Mi){
  var b = boxD(), cw = stage.clientWidth, ch = stage.clientHeight;
  var pts = [[b.x0,b.y0],[b.x1,b.y0],[b.x1,b.y1],[b.x0,b.y1]].map(function(q){
    var r = applyP(C.P, q[0], q[1]), s = m3apply(Mi, r[0]/C.rw, 1 - r[1]/C.rh);
    return [s[0]*cw, (1 - s[1])*ch];
  });
  var cx = (pts[0][0] + pts[2][0])/2, cy = (pts[0][1] + pts[2][1])/2;
  var tx = (pts[0][0] + pts[1][0])/2, ty = (pts[0][1] + pts[1][1])/2;
  var dx = tx - cx, dy = ty - cy, dl = Math.hypot(dx, dy) || 1;
  return { pts:pts, top:[tx, ty], handle:[tx + dx/dl*30, ty + dy/dl*30] };
}
function showHandle(){
  return MODE === 'check' && C.has && C.P && C.move === 'drawing' &&
    ((C.hoverOn && lastPtr === 'mouse') || (drag && drag.kind === 'rotate'));
}
function frameScreen(Mi){
  var f = C.frame, cw = stage.clientWidth, ch = stage.clientHeight;
  return [[f.x0,f.y0],[f.x1,f.y0],[f.x1,f.y1],[f.x0,f.y1]].map(function(q){
    var s = m3apply(Mi, q[0]/C.rw, 1 - q[1]/C.rh); return [s[0]*cw, (1 - s[1])*ch];
  });
}
function drawOverlay(M){
  var ctx = ovCtx, dpr = ov.width / Math.max(1, stage.clientWidth);
  clearOverlay();
  if(!C.has || !C.P) return;
  var Mi = m3inv(M);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  function poly(pts){ ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for(var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); }
  function seg(a, b){ ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  function towards(a, b, len){ var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [a[0] + dx/l*len, a[1] + dy/l*len]; }
  function twice(draw, w){
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = w + 2; draw(); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = w; draw(); ctx.stroke();
  }
  if(C.frameOn && C.frame){
    var p = frameScreen(Mi);
    twice(function(){ poly(p); }, 1.5);
    // Grips: corner marks and edge bars show the frame can be dragged.
    for(var i = 0; i < 4; i++){
      var a = p[i], nx = p[(i + 1) % 4], pv = p[(i + 3) % 4];
      twice(function(){ ctx.beginPath(); var q = towards(a, pv, 16), r = towards(a, nx, 16); ctx.moveTo(q[0], q[1]); ctx.lineTo(a[0], a[1]); ctx.lineTo(r[0], r[1]); }, 4);
      var m = [(a[0] + nx[0])/2, (a[1] + nx[1])/2];
      twice(function(){ seg(towards(m, a, 9), towards(m, nx, 9)); }, 4);
    }
  }
  if(showHandle()){
    var g = handleGeom(Mi);
    ctx.setLineDash([5, 5]);
    twice(function(){ poly(g.pts); }, 1);
    ctx.setLineDash([]);
    twice(function(){ seg(g.top, g.handle); }, 1.5);
    ctx.beginPath(); ctx.arc(g.handle[0], g.handle[1], 10, 0, Math.PI*2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(g.handle[0], g.handle[1], 5, -Math.PI*0.9, Math.PI*0.45);
    ctx.strokeStyle = '#1c1c1e'; ctx.lineWidth = 1.6; ctx.stroke();
  }
}

// ---------- Hit testing: rotate handle first, then the frame's edges
function hitTest(e){
  var r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  var Mi = m3inv(viewToRef(canvas.width, canvas.height));
  if(C.move === 'drawing' && e.pointerType === 'mouse'){
    var g = handleGeom(Mi);
    if(Math.hypot(px - g.handle[0], py - g.handle[1]) < 15) return { type:'rotate' };
  }
  if(C.frameOn && C.frame){
    var tol = (e.pointerType === 'mouse' ? 8 : 20) / cssPxPerR();
    var R = screenToRef(e.clientX, e.clientY), f = C.frame, ed = {}, any = false;
    var inY = R.y > f.y0 - tol && R.y < f.y1 + tol, inX = R.x > f.x0 - tol && R.x < f.x1 + tol;
    if(inY && Math.abs(R.x - f.x0) < tol){ ed.x0 = 1; any = true; }
    else if(inY && Math.abs(R.x - f.x1) < tol){ ed.x1 = 1; any = true; }
    if(inX && Math.abs(R.y - f.y0) < tol){ ed.y0 = 1; any = true; }
    else if(inX && Math.abs(R.y - f.y1) < tol){ ed.y1 = 1; any = true; }
    if(any) return { type:'frame', edges:ed };
  }
  return null;
}
function moveFrame(ed, R){
  var f = C.frame, min = 0.04*Math.max(C.rw, C.rh);
  if(ed.x0) f.x0 = Math.max(0, Math.min(f.x1 - min, R.x));
  if(ed.x1) f.x1 = Math.min(C.rw, Math.max(f.x0 + min, R.x));
  if(ed.y0) f.y0 = Math.max(0, Math.min(f.y1 - min, R.y));
  if(ed.y1) f.y1 = Math.min(C.rh, Math.max(f.y0 + min, R.y));
}
function cursorFor(hit){
  if(!hit) return C.move === 'drawing' ? 'move' : '';
  if(hit.type === 'rotate') return 'grab';
  var e = hit.edges, n = (e.x0 || e.x1 ? 1 : 0) + (e.y0 || e.y1 ? 1 : 0);
  if(n === 2) return 'move';
  var Mi = m3inv(viewToRef(canvas.width, canvas.height));
  var a = m3apply(Mi, 0, 0), b = m3apply(Mi, e.x0 || e.x1 ? 0.1 : 0, e.x0 || e.x1 ? 0 : 0.1);
  var dx = Math.abs(b[0] - a[0])*stage.clientWidth, dy = Math.abs(b[1] - a[1])*stage.clientHeight;
  return dx > dy ? 'ew-resize' : 'ns-resize';
}
function hover(e){
  if(MODE !== 'check' || !C.has || !C.P) return;
  var was = C.hoverOn;
  C.hoverOn = true;
  stage.style.cursor = cursorFor(hitTest(e));
  if(!was || C.move === 'drawing') schedulePaint();
}
var paintQueued = false;
function schedulePaint(){
  if(paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(function(){ paintQueued = false; paint(); });
}
stage.addEventListener('pointerleave', function(e){
  if(e.pointerType !== 'mouse' || !C.hoverOn) return;
  C.hoverOn = false;
  if(MODE === 'check') paint();
});

// Suggest a frame: where the drawing sits on the reference, plus a little room.
function suggestFrame(P){
  var b = boxD(), xs = [], ys = [];
  [[b.x0,b.y0],[b.x1,b.y0],[b.x1,b.y1],[b.x0,b.y1]].forEach(function(q){ var r = applyP(P, q[0], q[1]); xs.push(r[0]); ys.push(r[1]); });
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  var pad = 0.05*Math.max(x1 - x0, y1 - y0);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(C.rw, x1 + pad); y1 = Math.min(C.rh, y1 + pad);
  if(x1 - x0 < 0.1*C.rw || y1 - y0 < 0.1*C.rh){ x0 = 0; y0 = 0; x1 = C.rw; y1 = C.rh; }
  C.frame = { x0:x0, y0:y0, x1:x1, y1:y1 };
}

// ---------- The match result glides in instead of jumping
function animateTo(P1){
  if(!C.P || REDUCED){ C.P = copyP(P1); C.anim = null; paint(); return; }
  C.anim = { a:copyP(C.P), b:copyP(P1), t0:0, dur:420 };
  requestRender();
}
function stepAnim(now){
  var A = C.anim;
  if(!A) return true;
  if(!A.t0) A.t0 = now;
  var k = Math.min(1, (now - A.t0)/A.dur), e = 1 - Math.pow(1 - k, 3);
  if(k >= 1){ C.P = copyP(A.b); C.anim = null; return true; }
  var cD = boxCenterD(), ca = applyP(A.a, cD.x, cD.y), cb = applyP(A.b, cD.x, cD.y);
  var th = A.a.theta + wrapAngle(A.b.theta - A.a.theta)*e;
  var s = Math.exp(Math.log(A.a.scale) + (Math.log(A.b.scale) - Math.log(A.a.scale))*e);
  var cx = ca[0] + (cb[0] - ca[0])*e, cy = ca[1] + (cb[1] - ca[1])*e, cs = Math.cos(th), sn = Math.sin(th);
  C.P = { scale:s, theta:th, tx:cx - s*(cs*cD.x - sn*cD.y), ty:cy - s*(sn*cD.x + cs*cD.y) };
  return false;
}
function stopAnim(){ C.anim = null; }

// ---------- The worker does the matching and finds the lines
var worker = null, sent = { ref:false, draw:false }, jobSeq = 0;
function getWorker(){
  if(worker) return worker;
  try {
    worker = new Worker('check-worker.js');
    worker.onmessage = onWorker;
    worker.onerror = function(ev){
      if(ev && ev.preventDefault) ev.preventDefault();
      killWorker(); C.matching = false; C.edgeJobs = { ref:0, draw:0 };
      setStatus('The matcher stopped with an error. Line the drawing up by hand, or reload and try again.');
      syncUI();
    };
  } catch(e){ worker = null; }
  sent.ref = sent.draw = false;
  return worker;
}
function killWorker(){ if(worker){ worker.terminate(); worker = null; } }
function ensureData(w){
  if(!sent.ref && C.refData){ w.postMessage({ type:'reference', img:C.refData }); sent.ref = true; }
  if(!sent.draw && C.drawData){ w.postMessage({ type:'drawing', img:C.drawData }); sent.draw = true; }
}
function requestLines(){
  var w = getWorker();
  if(!w) return;
  ensureData(w);
  C.linesJob = ++jobSeq;
  w.postMessage({ type:'lines', id:C.linesJob, maxSide:FIELD_SIDE });
}
function startMatch(kind, range){
  if(!C.has || !hasImage) return;
  var w = getWorker();
  if(!w){ setStatus('This browser can’t run the matcher here. Line the drawing up by hand.'); return; }
  ensureData(w);
  C.job = ++jobSeq; C.matching = true; C.lastRange = range || 30;
  var msg = { type:kind, id:C.job, rotationRange:C.lastRange };
  if(kind === 'refine') msg.P = copyP(C.P);
  w.postMessage(msg);
  setStatus(kind === 'refine' ? 'Snapping to the nearest fit…'
    : C.lastRange >= 180 ? 'Matching at any angle. This can take a while…' : 'Matching…', 'cancel');
  syncUI();
}
function cancelMatch(){
  killWorker(); C.matching = false; C.job = ++jobSeq;
  setStatus('Stopped. Drag the drawing into place, or tap Match to try again.');
  if(!C.field && C.has) requestLines();
  C.edgeJobs = { ref:0, draw:0 }; needEdges();
  syncUI();
}
// The Edges view's fields are found only when it's in use, once per picture.
function needEdges(){
  if(C.line !== 'edges') return;
  if(hasImage && !C.refEdge && !C.edgeJobs.ref) requestEdges('ref');
  if(C.has && !C.drawEdge && !C.edgeJobs.draw) requestEdges('draw');
}
function requestEdges(which){
  var w = getWorker();
  if(!w) return;
  ensureData(w);
  C.edgeJobs[which] = ++jobSeq;
  w.postMessage({ type:'edges', id:C.edgeJobs[which], which:which, maxSide:EDGE.side });
}
function uploadEdge(which){
  var f = which === 'ref' ? C.refEdge : C.drawEdge;
  gl.bindTexture(gl.TEXTURE_2D, which === 'ref' ? refEdgeTex : drawEdgeTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, which === 'ref' ? C.refEdgeData : C.drawEdgeData);
}
// The Edges view's colors follow the page's theme, like the old tool's.
var edgeCols = null;
function edgeColors(){
  if(!edgeCols) edgeCols = { bg:hexRGB(cssVar('--edge-bg')), ref:hexRGB(cssVar('--edge-ref')), draw:hexRGB(cssVar('--edge-draw')) };
  return edgeCols;
}
function onWorker(e){
  var m = e.data;
  if(m.type === 'edges'){
    if(m.id !== C.edgeJobs[m.which]) return;
    C.edgeJobs[m.which] = 0;
    if(m.error){ toast('Couldn’t find the edges.'); return; }
    var meta = { w:m.field.w, h:m.field.h, maxD:m.field.maxD, edges:m.field.edges };
    if(m.which === 'ref'){ C.refEdge = meta; C.refEdgeData = m.field.data; }
    else { C.drawEdge = meta; C.drawEdgeData = m.field.data; }
    uploadEdge(m.which);
    paint();
    return;
  }
  if(m.type === 'lines'){
    if(m.id !== C.linesJob) return;
    if(m.error){ toast('Couldn’t find the lines in that photo.'); return; }
    C.field = { w:m.field.w, h:m.field.h, maxD:m.field.maxD, lines:m.field.lines };
    C.fieldData = m.field.data;
    uploadField();
    if(!m.field.lines) toast('No lines found in that photo. Try a sharper, better-lit one.', 4000);
    paint();
    return;
  }
  if(m.id !== C.job) return;
  C.matching = false;
  if(m.error){
    setStatus(m.error + '. Drag the drawing close and tap Match, or try a sharper photo.');
    syncUI(); return;
  }
  if(m.box) C.box = m.box;
  // Match after moving by hand snaps to the nearest fit. If that fits clearly worse
  // than the automatic match (the drawing was moved far off), go back to the match.
  if(m.type === 'refine' && C.auto && C.autoCost != null && m.cost > C.autoCost*1.15){
    C.moved = false;
    animateTo(C.auto);
    setStatus('Back to the automatic match: it fits better than the nearest fit from there.');
    syncUI(); return;
  }
  C.auto = copyP(m.P); C.autoCost = m.cost; C.moved = false;
  if(m.type === 'match' || !C.frame) suggestFrame(m.P);
  animateTo(m.P);
  var msg = m.type === 'refine' ? 'Snapped to the nearest fit.' : 'Lined up in ' + (m.timeMs/1000).toFixed(1) + ' s.';
  var btn = null;
  if(m.quality != null && m.quality < 0.3){
    msg += ' Few lines agree, so check it.';
    if(m.type === 'match' && C.lastRange < 180) btn = 'any';
  } else if(m.ambiguity > 0.92) msg += ' Another position fits almost as well, so check it.';
  setStatus(msg, btn);
  syncUI();
}
function setStatus(t, btn){
  C.status = t || ''; C.statusBtn = btn || null;
  statusEl.textContent = C.status;
  statusBtn.hidden = !btn;
  statusBtn.textContent = btn === 'cancel' ? 'Cancel' : btn === 'any' ? 'Try any angle' : '';
}
statusBtn.addEventListener('click', function(){
  if(C.statusBtn === 'cancel') cancelMatch();
  else if(C.statusBtn === 'any') startMatch('match', 180);
});
function afterHandMove(){
  if(C.matching) return;
  setStatus('Moved by hand. Match snaps it to the nearest fit.');
  syncUI();
}

// ---------- Loading the drawing, and the reference's copy for the matcher
function setCheckReference(p){
  var k = Math.min(1, REF_SIDE / Math.max(p.w, p.h));
  var w = Math.max(1, Math.round(p.w*k)), h = Math.max(1, Math.round(p.h*k));
  var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  var ctx = cv.getContext('2d', { willReadFrequently:true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(p.image, 0, 0, w, h);
  var d = ctx.getImageData(0, 0, w, h);
  C.rw = w; C.rh = h; C.refData = { width:w, height:h, data:d.data };
  sent.ref = false;
  C.frame = null;
  C.refEdge = null; C.refEdgeData = null; C.edgeJobs.ref = 0;
  if(C.has){
    C.P = guessPlacement(); C.auto = null; C.moved = false;
    startMatch('match');
  }
  needEdges();
}
function uploadDraw(){
  gl.bindTexture(gl.TEXTURE_2D, drawTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, C.drawCanvas);
}
function uploadField(){
  gl.bindTexture(gl.TEXTURE_2D, lineTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, C.field.w, C.field.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, C.fieldData);
}
function loadDrawing(source, name){
  if(!hasImage){ toast('Open a reference first.'); return; }
  var iw = source.width || source.naturalWidth || 1, ih = source.height || source.naturalHeight || 1;
  var k = Math.min(1, DRAW_SIDE / Math.max(iw, ih));
  var w = Math.max(1, Math.round(iw*k)), h = Math.max(1, Math.round(ih*k));
  var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  var ctx = cv.getContext('2d', { willReadFrequently:true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  var d = ctx.getImageData(0, 0, w, h);
  C.drawCanvas = cv; C.dw = w; C.dh = h; C.name = name || 'drawing';
  C.drawData = { width:w, height:h, data:d.data };
  sent.draw = false;
  uploadDraw();
  C.has = true; C.field = null; C.fieldData = null; C.auto = null; C.box = null; C.moved = false; C.frame = null; C.anim = null;
  C.drawEdge = null; C.drawEdgeData = null; C.edgeJobs.draw = 0;
  C.P = guessPlacement();
  if(MODE !== 'check') setMode('check');
  syncEmpty(); syncUI();
  requestLines();
  startMatch('match');
  needEdges();
  paint();
}

// ---------- Check controls
// Squint shows the reference with Reference Squint's look. If that look is still
// plain, there'd be nothing to see, so it starts from Three values.
$('showSquint').addEventListener('click', function(){
  C.squint = !C.squint;
  if(C.squint && S.blur === 0 && S.n < 2 && S.color === 'full'){
    applyLook(LOOKS[4]);
    toast('Squint uses Reference Squint’s look, set to three values. Change it on that tab.', 4200);
  }
  syncUI(); paint();
});
$('showColor').addEventListener('click', function(){
  C.color = !C.color; store('lineColor', C.color ? '1' : '0'); syncUI(); paint();
});
function cycleLine(){
  C.line = LINE_ORDER[(LINE_ORDER.indexOf(C.line) + 1) % LINE_ORDER.length];
  store('line', C.line); needEdges(); syncUI(); paint();
}
$('showLine').addEventListener('click', cycleLine);
fade.addEventListener('input', function(){ C.mix = Number(fade.value); store('mix', C.mix); syncUI(); paint(); });
Array.prototype.forEach.call(document.querySelectorAll('#moveSeg button'), function(b){
  b.addEventListener('click', function(){ C.move = b.dataset.v; syncUI(); paint(); });
});
ctools.open.addEventListener('click', function(){ drawInput.click(); });
ctools.match.addEventListener('click', function(){
  if(!C.has) return;
  if(C.moved && C.auto) startMatch('refine'); else startMatch('match', C.lastRange);
});
ctools.frame.addEventListener('click', function(){
  C.frameOn = !C.frameOn;
  if(C.frameOn && !C.frame && C.P) suggestFrame(C.P);
  syncUI(); paint();
});
ctools.grid.addEventListener('click', cycleGrid);
ctools.rotate.addEventListener('click', function(){ rotate(1); });
ctools.mirror.addEventListener('click', toggleMirror);
ctools.save.addEventListener('click', openSave);
holdButton(ctools.peek);

// ---------- Saving: the outline on the reference, or the two side by side
var saveOpen = false;
function openSave(){
  if(!C.has || !C.P) return;
  $('saveNote').textContent = (C.frameOn && C.frame) ? 'Saves what’s inside the frame.' : 'Saves the whole reference. Turn on Frame to save part of it.';
  saveOpen = true; saveSheet.classList.add('open');
  $('saveOverlay').focus();
}
function closeSave(){ saveOpen = false; saveSheet.classList.remove('open'); }
$('saveOverlay').addEventListener('click', function(){ closeSave(); exportCheck('overlay'); });
$('saveSide').addEventListener('click', function(){ closeSave(); exportCheck('side'); });
$('saveCancel').addEventListener('click', closeSave);
saveSheet.addEventListener('click', function(e){ if(e.target === saveSheet) closeSave(); });

function renderCheck(w, h, o){
  var fb = makeFBO(w, h);
  drawCheck(fb.fbo, w, h, o);
  var px = readFBO(fb); killFBO(fb);
  return pxToCanvas(px, w, h, document.createElement('canvas'));
}
function exportCheck(kind){
  if(!gl || glLost || !C.has || !C.P) return;
  var f = (C.frameOn && C.frame) ? C.frame : { x0:0, y0:0, x1:C.rw, y1:C.rh };
  var fw = f.x1 - f.x0, fh = f.y1 - f.y0;
  var k = Math.min(imgW / C.rw, 2048 / Math.max(fw, fh));      // output px per R pixel
  var w = Math.max(1, Math.round(fw*k)), h = Math.max(1, Math.round(fh*k));
  var M = [fw/C.rw, 0, f.x0/C.rw, 0, fh/C.rh, 1 - f.y1/C.rh, 0, 0, 1];   // output uv -> reference uv
  var grow = Math.max(1, Math.max(w, h)/800);
  function opts(mode){
    return { toRef:M, mode:mode, refTex:checkRefTex(), mix:C.mix/100, showLine:true, frameOn:false,
             pxPerR:k, unit:grow, widthPx:LINES[C.line].w*grow, haloPx:LINES[C.line].halo*grow, bg:[1,1,1] };
  }
  var cv;
  if(kind === 'overlay') cv = renderCheck(w, h, opts(0));
  else {
    var a = renderCheck(w, h, opts(2)), b = renderCheck(w, h, opts(1));
    var gap = Math.round(Math.max(w, h)*0.02);
    cv = document.createElement('canvas'); cv.width = w*2 + gap; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(a, 0, 0); ctx.drawImage(b, w + gap, 0);
  }
  paint();
  downloadCanvas(cv, baseName(C.name) + (kind === 'overlay' ? '-check.png' : '-side-by-side.png'));
}

// ---------- The sample pair: a made-up reference and a drawing with two errors
function loadPair(){
  if(!gl || !window.SamplePair) return;
  var pair = window.SamplePair.build();
  if(MODE !== 'check') setMode('check');
  C.has = false;
  loadSource(pair.reference, 'sample-reference');
  loadDrawing(pair.drawing, 'sample-drawing');
}
