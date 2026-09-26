/* Squint & Check. Drawing Check: placing the drawing on the reference, its lines, the frame, the matcher worker, and saving.
   Loaded by index.html; the scripts share one global scope.
   co-authors: jtxt.org and claude opus 5.5 */
"use strict";

// =============================================================
// Drawing Check
// =============================================================
// Two coordinate spaces, both in pixels with y down:
//   R, the reference at up to REF_SIDE on its long side (what the matcher sees),
//   D, the drawing at up to DRAW_SIDE.
// The placement P = {scale, theta, tx, ty} maps D onto R: r = scale·rot(theta)·d + t.
// Scaling is always even, so the drawing's own proportions are never stretched away.
// How the drawing shows over the reference. Widths are the line's, in CSS px on screen.
//   style 0: Outline, a line along the drawing's edges, with a thin white halo
//   style 1: Soft, the marks themselves with a smooth edge
//   style 2: Tint, the marks with no cutoff, as the old Drawing matcher showed them
//   style 3: Edges, both pictures as their edges on a plain background, like the old
//            Drawing matcher's Edges view (reference gray, drawing blue)
var LINES = {
  outline:{ style:0 }, edges:{ style:3 }, soft:{ style:1 }, tint:{ style:2 }, off:{ style:0 }
};
// Views: each a whole setup, chosen from the Views sheet (like Reference Squint's Looks).
//   line: how the drawing shows (LINES)   ink: the line's color   squint: the reference with
//   Reference Squint's look   drift: arrows and the score   mix: where the slider starts, 0 to 100
// Soft isn't a view any more (it was nearly Tint); the shader keeps it.
var VIEWS = {
  outline:{ name:'Outline', desc:'A thin line on the reference', line:'outline', ink:'neutral', mix:15 },
  blue:{ name:'Blue line', desc:'The same line, in blue', line:'outline', ink:'color', mix:15 },
  values:{ name:'Values', desc:'The reference squinted to values', line:'outline', ink:'neutral', squint:true, mix:15 },
  edges:{ name:'Edges', desc:'Both as edges on plain paper', line:'edges', ink:'neutral', mix:50 },
  overlay:{ name:'Overlay', desc:'Your drawing over the reference at half', line:'off', ink:'neutral', mix:50 },
  tint:{ name:'Tint', desc:'Your marks tinted over the reference', line:'tint', ink:'color', mix:15 },
  drift:{ name:'Drift', desc:'The outline, with arrows where it drifted', line:'outline', ink:'neutral', drift:true, mix:15 }
};
var VIEW_ORDER = ['outline', 'blue', 'values', 'edges', 'overlay', 'tint', 'drift'];
// The Reference-Drawing slider (s, 0 to 1), as the shader's mix (the drawing photo over the
// reference), line alpha, and the Edges view's reference edges. Left end: the reference alone.
// Right end: the drawing alone. In between the line rides on top: from 0.12 to 0.15 over the
// reference only, then the photo comes in, half at 0.5. In Edges both sets of edges show in
// the middle, the drawing's fading out to the left and the reference's to the right.
function sstep(a, b, x){ var t = Math.max(0, Math.min(1, (x - a)/(b - a))); return t*t*(3 - 2*t); }
function blendFor(line, s){
  if(line === 'edges') return { mix:0, lineA:Math.min(1, s/0.5), rEdgeA:Math.min(1, (1 - s)/0.5) };
  return { mix:Math.max(0, Math.min(1, (s - 0.15)/0.7)), lineA:sstep(0.02, 0.12, s)*(1 - sstep(0.88, 0.98, s)), rEdgeA:1 };
}
var PEEK_BLEND = { mix:0, lineA:0, rEdgeA:1 };
// The lines come from a mask of each picture's edges and lines, found by the worker once
// when the picture loads, blurred once on the GPU, and thresholded every frame. A straight
// one-texel mark's blur peaks at MASK_PEAK, leaving room above it where marks crowd.
var MASK_PEAK = 0.5;
// The numbers behind the lines. debug.js (Looks → Debug) can change them while it's on.
//   mask: the worker finds the mask again     blur: the GPU re-blurs it     paint: redraw only
var TUNE = {
  // mask. Sizes are in pixels of a 1024px copy.
  edgeSide:1024,       // the mask's long side, px
  edgeSigma:0.85,      // the edge finder's blur, as a share of the matcher's own (scaled to the size)
  edgeThreshold:0.2,   // edges fainter than this share of a strong one are dropped
  edgeMinLen:0.025,    // edge pieces shorter than this share of the long side are dropped
  lines:1,             // find lines (thin strokes drawn along their centre) at all
  lineSigmaMin:1,      // strokes about 2× these wide count fully as lines ...
  lineSigmaMax:2.5,    // ... wider ones fade back to their outlines
  lineLo:0.06,         // a line's contrast where it starts to count ...
  lineHi:0.15,         // ... and where it counts fully (lower ones: photo texture turns to haze)
  lineBeta:3,          // how firmly the side of a step edge is kept from counting as a line
  lineMinLen:0.03,     // line pieces shorter than this share of the long side are dropped
  lineReach:1,         // how far out a line's side edges fade (1: where the edge finder puts them)
  lineAngle:4,         // how closely an edge must run along a line to fade with it
  lightRef:0,          // light lines on dark count on the reference (on: a photo's texture adds many) ...
  lightDraw:0,         // ... and on the drawing (off: gaps between pencil strokes would count)
  // blur
  blurSigma:1.2,       // the GPU blur, in mask texels
  // paint. Widths in CSS px on screen.
  outlineW:3, outlineHalo:1, haloAlpha:0.7, edgesW:2,
  tMin:0.1, tMax:0.5,  // the threshold's range, as a share of the peak (see lineParams)
  outlineBase:0.45,    // Outline: how bright the faintest mark is, next to the strongest
  edgesBaseRef:0.3, edgesBaseDraw:0.35,   // the same in the Edges view
  bloom:0.35           // the Edges view's glow
};
function maskOpts(){
  var o = {};
  ['edgeSigma','edgeThreshold','edgeMinLen','lines','lineSigmaMin','lineSigmaMax','lineLo','lineHi','lineBeta',
   'lineMinLen','lineReach','lineAngle','lightRef','lightDraw'].forEach(function(k){ o[k] = TUNE[k]; });
  return o;
}
var INK_NEUTRAL = [0.08, 0.08, 0.09], INK_COLOR = [0.21, 0.38, 0.83], HALO = [1, 1, 1];
var REF_SIDE = 1600, DRAW_SIDE = 1600;
var C = {
  rw:0, rh:0, refData:null,
  has:false, name:'', dw:0, dh:0, drawCanvas:null, drawData:null,
  P:null, auto:null, autoCost:null, moved:false, box:null, anim:null,
  // Each picture's mask from the worker ({w, h, data, edges}), kept to rebuild the GPU copy.
  mask:{ ref:null, draw:null }, maskJobs:{ ref:0, draw:0 },
  frame:null, frameOn:true,
  // view: the chosen view (VIEWS); line, color and squint follow from it (setView).
  // mix: the Reference-Drawing slider, 0 to 100. drift: the arrows and score, over any view.
  // analysis: the last drift the worker measured, for the placement P it measured.
  view:load('view', 'outline'), mix:Number(load('mix', 15)), line:'outline', color:false, squint:false, move:'view',
  drift:load('drift', '0') === '1', analysis:null, anJob:0,
  matching:false, job:0, status:'', statusBtn:null, lastRange:30,
  hoverOn:false, hoverPt:null
};
if(!(C.mix >= 0 && C.mix <= 100)) C.mix = 15;
if(!VIEWS[C.view]) C.view = 'outline';
if(C.view === 'drift') C.drift = true;
viewFields();
function curView(){ return VIEWS[C.view]; }
function viewFields(){ var V = VIEWS[C.view]; C.line = V.line; C.color = V.ink === 'color'; C.squint = !!V.squint; }
var maskGL = { ref:null, draw:null };   // each mask on the GPU: { raw, blur }

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

// A line's thresholds on a blurred mask, for a line widthPx wide with a halo haloPx
// wide each side, drawn at ppt output pixels per mask texel. A straight edge blurred by
// a Gaussian of sigma texels falls off as peak·exp(−d²/2σ²), so a line of half-width h
// is where the blur passes peak·exp(−h²/2σ²). That stays between 0.1 and 0.5 of the
// peak: lower swells lines into blobs, higher breaks them where edges are faint or run
// on a diagonal. So zoomed out, lines keep their width on screen; zoomed far in, they're
// as thin as the mask allows and grow with the drawing.
function lineParams(ppt, widthPx, haloPx){
  var s = TUNE.blurSigma, hw = widthPx/2/ppt;
  var t = Math.min(TUNE.tMax, Math.max(TUNE.tMin, Math.exp(-hw*hw/(2*s*s))));
  var h = s*Math.sqrt(2*Math.log(1/t));
  var aa = Math.max(0.002, 0.75*t*h/(s*s*ppt));        // how much the blur changes over about a pixel there
  var hh = h + haloPx/ppt, th = Math.min(t, Math.max(0.03, Math.exp(-hh*hh/(2*s*s))));
  return [t*MASK_PEAK, aa*MASK_PEAK, th*MASK_PEAK, 1/ppt];
}
function drawCheck(target, w, h, o){
  gl.bindFramebuffer(gl.FRAMEBUFFER, target);
  gl.viewport(0, 0, w, h);
  gl.useProgram(checkProg); bindQuad(checkA);
  var gd = maskGL.draw, gr = maskGL.ref, md = C.mask.draw, mr = C.mask.ref;
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, drawTex);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, gd ? gd.blur.tex : noMask);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, gd ? gd.raw : noMask);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, gr ? gr.blur.tex : noMask);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, o.refTex || texture);
  gl.uniform1i(CU.u_ref, 0); gl.uniform1i(CU.u_draw, 1);
  gl.uniform1i(CU.u_dMask, 2); gl.uniform1i(CU.u_dRaw, 3); gl.uniform1i(CU.u_rMask, 4);
  gl.uniformMatrix3fv(CU.u_toRef, false, m3gl(o.toRef));
  var hasD = C.has && C.P;
  gl.uniformMatrix3fv(CU.u_refToDraw, false, m3gl(hasD ? refToDraw(C.P) : IDENT));
  var bg = o.bg || surroundRGB();
  gl.uniform3f(CU.u_bg, bg[0], bg[1], bg[2]);
  gl.uniform1f(CU.u_mode, o.mode || 0);
  var line = o.line || C.line, bl = o.blend || blendFor(line, C.mix/100);
  gl.uniform1f(CU.u_mix, hasD ? bl.mix : 0);
  gl.uniform1f(CU.u_lineA, bl.lineA);
  gl.uniform1f(CU.u_rEdgeA, bl.rEdgeA);
  gl.uniform1f(CU.u_hasDraw, hasD ? 1 : 0);
  var edges = line === 'edges', L = LINES[line];
  var lineOn = !!(hasD && gd && line !== 'off' && bl.lineA > 0.001);
  gl.uniform1f(CU.u_hasLine, lineOn ? 1 : 0);
  gl.uniform1f(CU.u_style, L.style);
  // Output pixels per mask texel, for the drawing (through its placement) and the reference.
  var lw = (edges ? TUNE.edgesW : TUNE.outlineW)*o.unit, lh = edges ? 0 : TUNE.outlineHalo*o.unit;
  var dl = lineOn ? lineParams(o.pxPerR*C.P.scale*C.dw/md.w, lw, lh) : [1, 0, 1, 1];
  gl.uniform4f(CU.u_dLine, dl[0], dl[1], dl[2], dl[3]);
  gl.uniform2f(CU.u_dTexel, md ? 1/md.w : 1, md ? 1/md.h : 1);
  var refOn = !!(edges && gr);
  var rl = refOn ? lineParams(o.pxPerR*C.rw/mr.w, lw, 0) : [1, 0, 1, 1];
  gl.uniform4f(CU.u_rLine, rl[0], rl[1], rl[2], rl[3]);
  gl.uniform2f(CU.u_rTexel, mr ? 1/mr.w : 1, mr ? 1/mr.h : 1);
  gl.uniform1f(CU.u_rHas, refOn ? 1 : 0);
  var ink = (o.color != null ? o.color : C.color) ? INK_COLOR : INK_NEUTRAL;
  gl.uniform3f(CU.u_ink, ink[0], ink[1], ink[2]);
  gl.uniform3f(CU.u_haloC, HALO[0], HALO[1], HALO[2]);
  gl.uniform4f(CU.u_look, TUNE.outlineBase, TUNE.haloAlpha, TUNE.bloom, 0);
  gl.uniform2f(CU.u_eBase, TUNE.edgesBaseRef, TUNE.edgesBaseDraw);
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
  }
  // Grid lines one output pixel wide, measured in reference uv.
  gl.uniform1f(CU.u_grid, S.grid || 0);
  gl.uniform2f(CU.u_gridPx, 1/(o.pxPerR*C.rw), 1/(o.pxPerR*C.rh));
  drawQuad();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// Drawing Check's controls, from state.
function syncCheck(){
  var on = hasImage, d = on && C.has, V = curView();
  $('viewName').textContent = V.name;
  $('viewBtn').disabled = !d;
  $('viewBtn').classList.toggle('open', viewsOpen);
  pressed([$('driftChip')], function(){ return C.drift; });
  $('driftChip').disabled = !d;
  fade.value = C.mix;
  fade.disabled = !d;
  fade.style.setProperty('--p', C.mix + '%');
  fade.setAttribute('aria-valuetext', mixText());
  ctools.move.classList.toggle('on', C.move === 'drawing');
  ctools.move.setAttribute('aria-pressed', String(C.move === 'drawing'));
  ctools.move.disabled = !d;
  ctools.open.disabled = !on;
  ctools.match.disabled = !d || C.matching;
  ctools.frame.disabled = !d;
  ctools.frame.classList.toggle('on', d && C.frameOn);
  ['grid','rotate','mirror'].forEach(function(k){ ctools[k].disabled = !on; });
  ctools.save.disabled = !d;
  if(!d && !C.matching) setStatus(on ? 'Add a photo of your drawing to check it.' : 'Open a reference first.');
  stage.style.cursor = (MODE === 'check' && d && C.move === 'drawing') ? 'move' : '';
}
function mixText(){
  var b = blendFor(C.line, C.mix/100);
  if(C.line === 'edges') return C.mix <= 2 ? 'reference edges alone' : C.mix >= 98 ? 'drawing edges alone' : 'both sets of edges';
  if(C.mix <= 2) return 'reference alone';
  if(C.mix >= 98) return 'drawing alone';
  if(b.mix < 0.005) return 'reference with the line';
  return Math.round(b.mix*100) + ' percent drawing' + (b.lineA > 0.5 && C.line !== 'off' ? ', with the line' : '');
}

function checkRefTex(){ return C.squint ? squintTexture() : texture; }

function paintCheck(){
  sizeCanvas();
  var w = canvas.width, h = canvas.height, M = viewToRef(w, h);
  var dpr = w / Math.max(1, stage.clientWidth);
  // Peek (hold on the picture, or Space) shows the reference alone: no line, no drawing.
  drawCheck(null, w, h, {
    toRef:M, mode:0, refTex:checkRefTex(), blend:comparing ? PEEK_BLEND : null, frameOn:C.frameOn,
    pxPerR:pxPerR(w, h), unit:dpr
  });
  drawOverlay(M);
  syncDriftTag();
}

// ---------- Drift: arrows where a region of the drawing would have to move to sit on the
// reference, and a score (Compare's proportion map, measured by the worker).
// Only a region that clearly fits better moved counts, and only a drift of 0.6% of the figure's
// size or more gets an arrow. Arrows are drawn at least minLen long so their direction shows.
var DRIFT_RED = '#e5484d';
function driftFresh(){
  var a = C.analysis, P = C.P;
  if(!a || !P || !a.P) return false;
  return Math.abs(a.P.scale - P.scale) <= 1e-4*P.scale && Math.abs(a.P.theta - P.theta) < 1e-4 &&
    Math.abs(a.P.tx - P.tx) < 0.05 && Math.abs(a.P.ty - P.ty) < 0.05;
}
function driftCells(){
  return C.analysis.cells.filter(function(c){ return c.reliable && c.errorPct >= 0.6; });
}
function drawArrows(ctx, toXY, lw, minLen){
  driftCells().forEach(function(c){
    var a = toXY(c.x, c.y), b = toXY(c.x + c.dx, c.y + c.dy);
    var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    if(l < minLen){ b = [a[0] + dx/l*minLen, a[1] + dy/l*minLen]; }
    arrow(ctx, a[0], a[1], b[0], b[1], lw, DRIFT_RED);
  });
}
function arrow(ctx, x0, y0, x1, y1, lw, color){
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = lw*1.5;
  ctx.beginPath(); ctx.arc(x0, y0, lw*1.4, 0, 2*Math.PI); ctx.fill();
  var a = Math.atan2(y1 - y0, x1 - x0), hl = lw*4;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - hl*0.6*Math.cos(a), y1 - hl*0.6*Math.sin(a)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - hl*Math.cos(a - 0.45), y1 - hl*Math.sin(a - 0.45));
  ctx.lineTo(x1 - hl*Math.cos(a + 0.45), y1 - hl*Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}
function driftText(){
  if(!C.drift || !C.has || !C.P) return '';
  if(!driftFresh()) return (C.anJob || C.matching || C.anim) ? 'Measuring drift…' : '';
  var a = C.analysis;
  if(a.score == null) return 'No drift score: too few lines agree';
  var n = driftCells().length;
  return 'Score ' + a.score + ' · drift ' + a.rmsPct.toFixed(1) + '%' + (n ? '' : ' · no arrows');
}
function syncDriftTag(){
  var t = MODE === 'check' && !comparing ? driftText() : '';
  var el = $('driftTag');
  if(t) el.textContent = t;
  el.classList.toggle('show', !!t);
}
function requestDrift(P){
  P = P || C.P;
  if(!C.has || !P || !hasImage) return;
  var w = getWorker();
  if(!w) return;
  ensureData(w);
  C.anJob = ++jobSeq;
  w.postMessage({ type:'analyze', id:C.anJob, P:copyP(P) });
}
var driftTimer = null;
function scheduleDrift(){
  clearTimeout(driftTimer);
  if(!C.drift) return;
  driftTimer = setTimeout(function(){ if(!C.matching && !driftFresh()) requestDrift(); }, 400);
}
function setDrift(on){
  C.drift = on; store('drift', on ? '1' : '0');
  // The Drift view is Outline with the arrows: turning Drift on in Outline names it Drift, and off, Outline again.
  if(on && C.view === 'outline') setView('drift', true);
  else if(!on && C.view === 'drift') setView('outline', true);
  if(on && !driftFresh() && !C.matching) requestDrift();
  syncUI(); paint();
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
  if(C.drift && !comparing && driftFresh()){
    drawArrows(ctx, function(x, y){ var q = m3apply(Mi, x/C.rw, 1 - y/C.rh); return [q[0]*stage.clientWidth, (1 - q[1])*stage.clientHeight]; }, 2.5, 20);
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
// The worker gets this script's ?v= (see index.html), so it can't be an old cached copy.
var FILE_V = (function(){ var c = document.currentScript, q = c && c.src.split('?')[1]; return q ? '?' + q : ''; })();
function getWorker(){
  if(worker) return worker;
  try {
    worker = new Worker('check-worker.js' + FILE_V);
    worker.onmessage = onWorker;
    worker.onerror = function(ev){
      if(ev && ev.preventDefault) ev.preventDefault();
      killWorker(); C.matching = false; C.maskJobs = { ref:0, draw:0 };
      setStatus('The matcher stopped with an error. Line the drawing up by hand, or reload and try again.');
      syncUI();
    };
  } catch(e){ worker = null; }
  sent.ref = sent.draw = false;
  return worker;
}
function killWorker(){ if(worker){ worker.terminate(); worker = null; } C.anJob = 0; }
function ensureData(w){
  if(!sent.ref && C.refData){ w.postMessage({ type:'reference', img:C.refData }); sent.ref = true; }
  if(!sent.draw && C.drawData){ w.postMessage({ type:'drawing', img:C.drawData }); sent.draw = true; }
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
  C.maskJobs = { ref:0, draw:0 }; needMasks();
  syncUI();
}
// Each picture's mask is found once, when it loads. If the worker was stopped
// (Cancel, or an error) before a mask came back, it's asked for again.
function needMasks(){
  if(hasImage && !C.mask.ref && !C.maskJobs.ref) requestMask('ref');
  if(C.has && !C.mask.draw && !C.maskJobs.draw) requestMask('draw');
}
function requestMask(which){
  var w = getWorker();
  if(!w) return;
  ensureData(w);
  C.maskJobs[which] = ++jobSeq;
  var side = Math.min(TUNE.edgeSide, (gl && !glLost) ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 2048);
  w.postMessage({ type:'mask', id:C.maskJobs[which], which:which, maxSide:side, opts:maskOpts() });
}
function setMask(which, m){
  if(maskGL[which] && gl && !glLost) freeMask(maskGL[which]);
  maskGL[which] = null;
  C.mask[which] = m; C.maskJobs[which] = 0;
  if(m && gl && !glLost) maskGL[which] = blurMask(m, TUNE.blurSigma, MASK_PEAK);
}
// After TUNE changes: find both masks again (the old ones show until the new arrive) ...
function refindMasks(){
  C.maskJobs = { ref:0, draw:0 };
  if(C.has) requestMask('draw');
  if(hasImage) requestMask('ref');
}
// ... or only blur them again.
// After the WebGL context comes back, the GPU copies are rebuilt from the kept masks.
function remakeMasks(){
  ['ref', 'draw'].forEach(function(k){ maskGL[k] = C.mask[k] ? blurMask(C.mask[k], TUNE.blurSigma, MASK_PEAK) : null; });
}
function reblurMasks(){
  if(!gl || glLost) return;
  ['ref', 'draw'].forEach(function(k){ if(maskGL[k]) freeMask(maskGL[k]); });
  remakeMasks();
}
// The Edges view's colors follow the page's theme, like the old tool's.
var edgeCols = null;
function edgeColors(){
  if(!edgeCols) edgeCols = { bg:hexRGB(cssVar('--edge-bg')), ref:hexRGB(cssVar('--edge-ref')), draw:hexRGB(cssVar('--edge-draw')) };
  return edgeCols;
}
function onWorker(e){
  var m = e.data;
  if(m.type === 'mask'){
    if(m.id !== C.maskJobs[m.which]) return;
    if(m.error){ C.maskJobs[m.which] = 0; toast('Couldn’t find the lines in that picture.'); return; }
    setMask(m.which, m.mask);
    // For the Debug menu's timings (debug.js), if it's loaded.
    document.dispatchEvent(new CustomEvent('squintcheck:mask', { detail:{ which:m.which, mask:m.mask } }));
    if(m.which === 'draw' && !m.mask.edges) toast('No lines found in that photo. Try a sharper, better-lit one.', 4000);
    paint();
    return;
  }
  if(m.type === 'analyze'){
    if(m.id !== C.anJob) return;
    C.anJob = 0;
    C.analysis = m.error ? null : { P:m.P, cells:m.cells, score:m.score, rmsPct:m.rmsPct };
    paint();
    if(viewsOpen) buildViews();
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
    animateTo(C.auto); requestDrift(C.auto);
    setStatus('Back to the automatic match: it fits better than the nearest fit from there.');
    syncUI(); return;
  }
  C.auto = copyP(m.P); C.autoCost = m.cost; C.moved = false;
  if(m.type === 'match' || !C.frame) suggestFrame(m.P);
  animateTo(m.P);
  requestDrift(m.P);    // always, so Drift and the Views sheet have it ready
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
  scheduleDrift();
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
  C.frame = null; C.analysis = null;
  setMask('ref', null);
  if(C.squint) valuesLook(false);
  if(C.has){
    C.P = guessPlacement(); C.auto = null; C.moved = false;
    startMatch('match');
  }
  needMasks();
}
function uploadDraw(){
  gl.bindTexture(gl.TEXTURE_2D, drawTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, C.drawCanvas);
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
  C.has = true; C.auto = null; C.box = null; C.moved = false; C.frame = null; C.anim = null; C.analysis = null;
  setMask('draw', null);
  C.P = guessPlacement();
  if(MODE !== 'check') setMode('check');
  syncEmpty(); syncUI();
  needMasks();      // before the match, so the line shows while it works
  startMatch('match');
  paint();
}

// ---------- Check controls
// Values shows the reference with Reference Squint's look. If that look is still
// plain, there'd be nothing to see, so it starts from Three values.
function lookPlain(){ return S.blur === 0 && S.n < 2 && S.color === 'full'; }
function valuesLook(tell){
  if(!lookPlain()) return;
  applyLook(LOOKS[4]);
  if(tell) toast('Values uses Reference Squint’s look, set to three values. Change it on that tab.', 4200);
}
// keepMix: switching between Outline and Drift with the Drift button leaves the slider where it is.
function setView(id, keepMix){
  if(!VIEWS[id]) return;
  C.view = id; store('view', id); viewFields();
  var V = VIEWS[id];
  if(!keepMix){ C.mix = V.mix; store('mix', C.mix); }
  if(V.drift && !C.drift){ C.drift = true; store('drift', '1'); if(!driftFresh() && !C.matching) requestDrift(); }
  if(C.squint) valuesLook(true);
  syncUI(); paint();
}
$('viewBtn').addEventListener('click', function(){ viewsOpen ? closeViews() : openViews(); });
$('driftChip').addEventListener('click', function(){ setDrift(!C.drift); });
fade.addEventListener('input', function(){ C.mix = Number(fade.value); store('mix', C.mix); syncUI(); paint(); });
ctools.move.addEventListener('click', function(){
  C.move = C.move === 'drawing' ? 'view' : 'drawing';
  toast(C.move === 'drawing' ? 'Move drawing on: drags move the drawing.' : 'Move drawing off: drags move the view.', 2200);
  syncUI(); paint();
});

// ---------- The Views sheet: each view as a small picture of this pair, like Looks
var viewsOpen = false, viewsEl = $('views'), viewGrid = $('viewGrid');
function openViews(){
  if(!hasImage || !C.has) return;
  if(looksOpen) closeLooks();
  viewsOpen = true; viewsEl.classList.add('open');
  syncUI();
  requestAnimationFrame(buildViews);
}
function closeViews(){
  viewsOpen = false; viewsEl.classList.remove('open');
  syncUI(); paint();
}
$('viewsClose').addEventListener('click', closeViews);
// The region the cards show: the frame, or the whole reference, at most 1.4 times as tall as wide.
function thumbRegion(w){
  var f = (C.frameOn && C.frame) ? C.frame : { x0:0, y0:0, x1:C.rw, y1:C.rh };
  var fw = f.x1 - f.x0, fh = f.y1 - f.y0, k = w/fw, h = Math.round(fh*k);
  if(h > 1.4*w){ h = Math.round(1.4*w); var c = (f.y0 + f.y1)/2; fh = h/k; f = { x0:f.x0, x1:f.x1, y0:c - fh/2, y1:c + fh/2 }; }
  return { f:f, k:k, w:w, h:Math.max(24, h) };
}
// The reference as Values shows it. If Reference Squint's look is still plain, the card
// shows Three values, which is what choosing Values would set.
function valuesTex(){
  if(!lookPlain()) return { tex:squintTexture(), tmp:null };
  var p = LOOKS[4], hh = histFor(p.blur), th = fitThresholds(hh, p.n);
  var k = Math.min(1, 512/Math.max(imgW, imgH)), fb = makeFBO(Math.max(1, Math.round(imgW*k)), Math.max(1, Math.round(imgH*k)));
  drawMain({ rotation:0, flipX:1, chroma:CHROMA[p.color], zoom:1, panX:0, panY:0, n:p.n, th:th,
             tones:tonesFor(p.n, th, hh, S.tones), iso:-1, grid:0, bg:surroundRGB() }, runBlur(blurPx(p.blur)), fb.fbo, fb.w, fb.h, 1);
  return { tex:fb.tex, tmp:fb };
}
function buildViews(){
  if(!viewsOpen || !gl || glLost || !C.has || !C.P) return;
  viewGrid.innerHTML = '';
  var dpr = Math.min(window.devicePixelRatio || 1, 2), T = thumbRegion(Math.round(150*dpr));
  var f = T.f, M = [(f.x1 - f.x0)/C.rw, 0, f.x0/C.rw, 0, (f.y1 - f.y0)/C.rh, 1 - f.y1/C.rh, 0, 0, 1];
  var vt = null;
  VIEW_ORDER.forEach(function(id){
    var V = VIEWS[id], refTex = texture;
    if(V.squint){ vt = vt || valuesTex(); refTex = vt.tex; }
    var cv = renderCheck(T.w, T.h, { toRef:M, mode:0, refTex:refTex, blend:blendFor(V.line, V.mix/100), line:V.line,
      color:V.ink === 'color', frameOn:false, pxPerR:T.k, unit:0.7*dpr });
    if(V.drift && driftFresh()){
      var ctx = cv.getContext('2d');
      drawArrows(ctx, function(x, y){ return [(x - f.x0)*T.k, (y - f.y0)*T.k]; }, 2*dpr, 10*dpr);
    }
    var card = document.createElement('button');
    card.type = 'button'; card.className = 'look' + (id === C.view ? ' current' : '');
    card.setAttribute('aria-pressed', String(id === C.view));
    card.appendChild(cv);
    var n = document.createElement('span'); n.className = 'ln'; n.textContent = V.name;
    var d = document.createElement('span'); d.className = 'ld'; d.textContent = V.desc;
    card.appendChild(n); card.appendChild(d);
    card.addEventListener('click', function(){ setView(id); closeViews(); });
    viewGrid.appendChild(card);
  });
  if(vt && vt.tmp) killFBO(vt.tmp);
  paint();
}

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

// ---------- Saving: the outline on the reference, or the two side by side
var saveOpen = false;
function openSave(){
  if(!C.has || !C.P) return;
  $('saveOverlayNote').textContent = 'The ' + curView().name + ' view as it is now' + (C.drift && driftFresh() ? ', with the drift arrows' : '') + ', without the dimming';
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
    return { toRef:M, mode:mode, refTex:checkRefTex(), frameOn:false, pxPerR:k, unit:grow, bg:[1,1,1] };
  }
  var cv;
  if(kind === 'overlay'){
    // What you see: the view, the slider, the grid, and the drift arrows if they're on.
    cv = renderCheck(w, h, opts(0));
    if(C.drift && driftFresh()) drawArrows(cv.getContext('2d'), function(x, y){ return [(x - f.x0)*k, (y - f.y0)*k]; }, 2.5*grow, 20*grow);
  }
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
