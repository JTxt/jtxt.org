/* Squint & Check. WebGL: programs, textures, framebuffers, the blur pyramid, blurring the edge masks, and drawing the Squint view.
   Loaded by index.html; the scripts share one global scope.
   co-authors: jtxt.org and claude opus 5.5 */
"use strict";

// =============================================================
// WebGL
// =============================================================
var gl = null, glLost = false;
var mainProg, boxProg, gaussProg, checkProg, maskProg, U = {}, BU = {}, GU = {}, CU = {}, MU = {};
var mainA, boxA, gaussA, checkA, maskA, quad, texture, drawTex, noMask, fboA = null, fboB = null;
var texW = 0, texH = 0, levels = [];
var imgW = 0, imgH = 0, hasImage = false, lastPrepared = null, lastName = '';

function makeProgram(vs, fs, name){
  function sh(type, src){
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(name, gl.getShaderInfoLog(s));
    return s;
  }
  var p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(name, gl.getProgramInfoLog(p));
  return p;
}
function uniforms(prog, names){
  var o = {}; names.forEach(function(n){ o[n] = gl.getUniformLocation(prog, n); }); return o;
}
function makeTex(){
  var t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}
function blankTex(rgba){
  var t = makeTex();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba || [255,255,255,0]));
  return t;
}

function initGL(){
  gl = canvas.getContext('webgl', { alpha:false, premultipliedAlpha:false, antialias:false })
    || canvas.getContext('experimental-webgl');
  if(!gl) return false;
  mainProg = makeProgram(VERT, MAIN_FRAG, 'main');
  boxProg = makeProgram(VERT, BOX_FRAG, 'box');
  gaussProg = makeProgram(VERT, GAUSS_FRAG, 'gauss');
  checkProg = makeProgram(VERT, CHECK_FRAG, 'check');
  maskProg = makeProgram(VERT, MASK_FRAG, 'mask');
  mainA = gl.getAttribLocation(mainProg, 'a_position');
  boxA = gl.getAttribLocation(boxProg, 'a_position');
  gaussA = gl.getAttribLocation(gaussProg, 'a_position');
  checkA = gl.getAttribLocation(checkProg, 'a_position');
  maskA = gl.getAttribLocation(maskProg, 'a_position');
  U = uniforms(mainProg, ['u_image','u_canvasSize','u_imageSize','u_pan','u_rotation','u_flipX','u_flipY',
    'u_fitScale','u_zoom','u_bgAlpha','u_bg','u_chroma','u_n','u_iso','u_grid','u_outL']);
  U.u_th = gl.getUniformLocation(mainProg, 'u_th[0]');
  U.u_tone = gl.getUniformLocation(mainProg, 'u_tone[0]');
  BU = uniforms(boxProg, ['u_src','u_texel','u_region','u_srcMax','u_off']);
  GU = uniforms(gaussProg, ['u_src','u_texel','u_region','u_srcMax','u_dir','u_radius']);
  CU = uniforms(checkProg, ['u_ref','u_draw','u_dMask','u_dRaw','u_rMask','u_toRef','u_refToDraw','u_bg','u_mode','u_mix',
    'u_hasDraw','u_hasLine','u_style','u_rHas','u_dLine','u_rLine','u_dTexel','u_rTexel','u_ink','u_haloC',
    'u_frame','u_frameOn','u_grid','u_gridPx','u_edges','u_eBg','u_eRef','u_eDraw','u_look','u_eBase','u_lineA','u_rEdgeA']);
  MU = uniforms(maskProg, ['u_src','u_step','u_sigma','u_scale']);
  quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  texture = makeTex();
  drawTex = blankTex(); noMask = blankTex([0,0,0,0]);
  return true;
}

function makeFBO(w, h){
  var tex = makeTex();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  var fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo:fbo, tex:tex, w:w, h:h };
}
function killFBO(f){ if(f){ gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.tex); } }

function setupTargets(w, h){
  killFBO(fboA); killFBO(fboB);
  texW = w; texH = h;
  fboA = makeFBO(w, h); fboB = makeFBO(w, h);
  levels = [{ w:w, h:h }];
  for(var i = 1; i <= MAX_LEVEL; i++){
    levels.push({ w:Math.max(1, Math.ceil(levels[i-1].w/2)), h:Math.max(1, Math.ceil(levels[i-1].h/2)) });
  }
}
function bindQuad(a){
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
}
function drawQuad(){ gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
function setRegion(u, lv){
  var l = levels[lv];
  gl.uniform2f(u.u_region, l.w/texW, l.h/texH);
  gl.uniform2f(u.u_srcMax, (l.w-0.5)/texW, (l.h-0.5)/texH);
}

function runBlur(radius){
  if(!(radius > 0.3) || !fboA) return texture;
  var L = Math.max(0, Math.min(MAX_LEVEL, Math.floor(Math.log(radius/3)/Math.LN2)));
  var src = texture, srcLv = 0, dst = fboA, i;
  if(L > 0){
    gl.useProgram(boxProg); bindQuad(boxA);
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(BU.u_src, 0);
    gl.uniform2f(BU.u_texel, 1/texW, 1/texH); gl.uniform1f(BU.u_off, 0.5);
    for(i = 1; i <= L; i++){
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, levels[i].w, levels[i].h);
      gl.bindTexture(gl.TEXTURE_2D, src); setRegion(BU, srcLv); drawQuad();
      src = dst.tex; srcLv = i; dst = (dst === fboA) ? fboB : fboA;
    }
  }
  gl.useProgram(gaussProg); bindQuad(gaussA);
  gl.activeTexture(gl.TEXTURE0); gl.uniform1i(GU.u_src, 0);
  gl.uniform2f(GU.u_texel, 1/texW, 1/texH);
  gl.uniform1f(GU.u_radius, radius/Math.pow(2, L));
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
  gl.viewport(0, 0, levels[L].w, levels[L].h);
  gl.bindTexture(gl.TEXTURE_2D, src); setRegion(GU, srcLv);
  gl.uniform2f(GU.u_dir, 1, 0); drawQuad();
  var mid = dst; dst = (dst === fboA) ? fboB : fboA;
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
  gl.viewport(0, 0, levels[L].w, levels[L].h);
  gl.bindTexture(gl.TEXTURE_2D, mid.tex); setRegion(GU, L);
  gl.uniform2f(GU.u_dir, 0, 1); drawQuad();
  var cur = dst;
  if(L > 0){
    dst = (dst === fboA) ? fboB : fboA;
    gl.useProgram(boxProg); bindQuad(boxA);
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(BU.u_src, 0);
    gl.uniform2f(BU.u_texel, 1/texW, 1/texH); gl.uniform1f(BU.u_off, 0.75);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, texW, texH);
    gl.bindTexture(gl.TEXTURE_2D, cur.tex); setRegion(BU, L); drawQuad();
    cur = dst;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return cur.tex;
}

// An edge mask from the worker ({w, h, data}), uploaded, then blurred once by a Gaussian
// of `sigma` texels into its own texture: one pass across, one down. Both are read with
// bilinear filtering. The mark channels (all but B, the ink) are scaled so a straight
// one-texel mark peaks at `peak`, leaving room above it where marks crowd together.
function blurMask(m, sigma, peak){
  var raw = makeTex();
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, m.w, m.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.data);
  var tmp = makeFBO(m.w, m.h), out = makeFBO(m.w, m.h), sum = 0;
  for(var i = -6; i <= 6; i++) sum += Math.exp(-i*i/(2*sigma*sigma));
  gl.useProgram(maskProg); bindQuad(maskA);
  gl.activeTexture(gl.TEXTURE0); gl.uniform1i(MU.u_src, 0);
  gl.uniform1f(MU.u_sigma, sigma);
  gl.viewport(0, 0, m.w, m.h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fbo);
  gl.bindTexture(gl.TEXTURE_2D, raw);
  gl.uniform2f(MU.u_step, 1/m.w, 0); gl.uniform4f(MU.u_scale, 1, 1, 1, 1); drawQuad();
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
  gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
  gl.uniform2f(MU.u_step, 0, 1/m.h); gl.uniform4f(MU.u_scale, peak*sum, peak*sum, 1, peak*sum); drawQuad();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  killFBO(tmp);
  return { raw:raw, blur:out };
}
function freeMask(g){ if(g){ gl.deleteTexture(g.raw); killFBO(g.blur); } }

function fitScaleFor(rot, iw, ih, cw, ch){
  var c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  return Math.min(cw/(iw*c + ih*s), ch/(iw*s + ih*c));
}

var TH = new Float32Array(8), TN = new Float32Array(9);
function drawMain(v, srcTex, target, w, h, bgAlpha){
  gl.bindFramebuffer(gl.FRAMEBUFFER, target);
  gl.viewport(0, 0, w, h);
  gl.useProgram(mainProg); bindQuad(mainA);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(U.u_image, 0);
  gl.uniform2f(U.u_canvasSize, w, h);
  gl.uniform2f(U.u_imageSize, imgW, imgH);
  gl.uniform2f(U.u_pan, v.panX || 0, v.panY || 0);
  gl.uniform1f(U.u_rotation, v.rotation || 0);
  gl.uniform1f(U.u_flipX, v.flipX == null ? 1 : v.flipX);
  gl.uniform1f(U.u_flipY, 1);
  gl.uniform1f(U.u_zoom, v.zoom || 1);
  gl.uniform1f(U.u_fitScale, fitScaleFor(v.rotation || 0, imgW, imgH, w, h));
  gl.uniform1f(U.u_bgAlpha, bgAlpha);
  var bg = v.bg || [0,0,0];
  gl.uniform3f(U.u_bg, bg[0], bg[1], bg[2]);
  gl.uniform1f(U.u_chroma, v.chroma == null ? 1 : v.chroma);
  gl.uniform1f(U.u_n, v.n > 1 ? v.n : 0);
  TH.fill(0); TN.fill(0);
  var i;
  if(v.th) for(i = 0; i < v.th.length && i < 8; i++) TH[i] = v.th[i];
  if(v.tones) for(i = 0; i < v.tones.length && i < 9; i++) TN[i] = v.tones[i];
  gl.uniform1fv(U.u_th, TH);
  gl.uniform1fv(U.u_tone, TN);
  gl.uniform1f(U.u_iso, v.iso == null ? -1 : v.iso);
  gl.uniform1f(U.u_grid, v.grid || 0);
  gl.uniform1f(U.u_outL, v.outL ? 1 : 0);
  drawQuad();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function readFBO(f){
  var px = new Uint8Array(f.w * f.h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
  gl.readPixels(0, 0, f.w, f.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return px;
}
function pxToCanvas(px, w, h, cv){
  cv.width = w; cv.height = h;
  var ctx = cv.getContext('2d'), img = ctx.createImageData(w, h), row = w*4;
  for(var y = 0; y < h; y++) img.data.set(px.subarray((h-1-y)*row, (h-y)*row), y*row);
  ctx.putImageData(img, 0, 0);
  return cv;
}
