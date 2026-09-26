/* Squint & Check. The Debug menu: sliders for the numbers behind the lines (TUNE, in check.js),
   turned on in Looks → Debug. It floats over the picture so the change shows as you drag, folds
   away to one button, and scrolls. Copy changes puts every value that differs from the default
   on the clipboard. Changes are kept for next time, but only count while Debug is on: Off puts
   the defaults back. Everything for it is in this file; without it the app runs on the defaults.
   Loaded by index.html after check.js; the scripts share one global scope.
   co-authors: jtxt.org and claude opus 5.5 */
"use strict";

(function(){
  // kind: 'mask' finds both masks again in the worker (a moment), 'blur' re-blurs them on the
  // GPU, 'paint' only redraws.
  var DEFS = [
    { group:'Edges: outlines of value shapes' },
    { key:'edgeSide', label:'Mask size (px)', min:512, max:3200, step:64, kind:'mask' },
    { key:'edgeSigma', label:'Edge blur', min:0.3, max:2, step:0.05, kind:'mask' },
    { key:'edgeThreshold', label:'Faintest edge kept', min:0, max:0.6, step:0.01, kind:'mask' },
    { key:'edgeMinLen', label:'Shortest edge kept (× long side)', min:0, max:0.1, step:0.005, kind:'mask' },
    { group:'Lines: thin strokes along their centre (px of a 1024 copy)' },
    { key:'lines', label:'Lines on', min:0, max:1, step:1, kind:'mask' },
    { key:'lineSigmaMin', label:'Thinnest line, half width', min:0.3, max:4, step:0.1, kind:'mask' },
    { key:'lineSigmaMax', label:'Widest full line, half width', min:0.5, max:8, step:0.1, kind:'mask' },
    { key:'lineLo', label:'Contrast where a line starts', min:0, max:0.3, step:0.005, kind:'mask' },
    { key:'lineHi', label:'Contrast where a line is full', min:0, max:0.5, step:0.005, kind:'mask' },
    { key:'lineBeta', label:'Keep sides of edges out of lines', min:0, max:4, step:0.1, kind:'mask' },
    { key:'lineMinLen', label:'Shortest line kept (× long side)', min:0, max:0.1, step:0.0025, kind:'mask' },
    { key:'lineReach', label:'Side edges fade out to (× usual distance)', min:0, max:3, step:0.05, kind:'mask' },
    { key:'lineAngle', label:'Side edges must run along the line', min:0, max:16, step:0.5, kind:'mask' },
    { key:'lightRef', label:'Light lines on the reference', min:0, max:1, step:1, kind:'mask' },
    { key:'lightDraw', label:'Light lines on the drawing', min:0, max:1, step:1, kind:'mask' },
    { group:'Blur (GPU)' },
    { key:'blurSigma', label:'Mask blur (texels)', min:0.5, max:3, step:0.05, kind:'blur' },
    { group:'Drawing the lines (px on screen)' },
    { key:'outlineW', label:'Outline width', min:0.5, max:10, step:0.1, kind:'paint' },
    { key:'outlineHalo', label:'Outline halo width', min:0, max:4, step:0.1, kind:'paint' },
    { key:'haloAlpha', label:'Halo strength', min:0, max:1, step:0.05, kind:'paint' },
    { key:'edgesW', label:'Edges view width', min:0.5, max:10, step:0.1, kind:'paint' },
    { key:'tMin', label:'Threshold, lowest (× peak)', min:0.02, max:0.5, step:0.01, kind:'paint' },
    { key:'tMax', label:'Threshold, highest (× peak)', min:0.1, max:0.95, step:0.01, kind:'paint' },
    { key:'outlineBase', label:'Outline: faintest mark', min:0, max:1, step:0.05, kind:'paint' },
    { key:'edgesBaseRef', label:'Edges view: faintest reference mark', min:0, max:1, step:0.05, kind:'paint' },
    { key:'edgesBaseDraw', label:'Edges view: faintest drawing mark', min:0, max:1, step:0.05, kind:'paint' },
    { key:'bloom', label:'Edges view: glow', min:0, max:1, step:0.05, kind:'paint' }
  ];
  var DEFAULT = {}, saved = {}, on = load('debug', '0') === '1', open = load('debugOpen', '1') === '1';
  DEFS.forEach(function(d){ if(d.key) DEFAULT[d.key] = TUNE[d.key]; });
  try { saved = JSON.parse(load('tune', '{}')) || {}; } catch(e){ saved = {}; }
  Object.keys(saved).forEach(function(k){ if(!(k in DEFAULT) || !isFinite(Number(saved[k]))) delete saved[k]; });

  function applyAll(){
    Object.keys(DEFAULT).forEach(function(k){ TUNE[k] = on && k in saved ? Number(saved[k]) : DEFAULT[k]; });
  }
  applyAll();

  // ---------- Styles
  var css = document.createElement('style');
  css.textContent = [
    '#debug{ position:fixed; z-index:15; left:8px; top:calc(env(safe-area-inset-top, 0px) + 8px);',
    '  width:min(340px, calc(100vw - 16px)); max-height:50vh; max-height:50dvh; display:flex; flex-direction:column;',
    '  background:var(--panel); color:var(--ink); border-radius:12px; box-shadow:0 6px 24px rgba(0,0,0,.3);',
    '  font-size:14px; line-height:1.3; touch-action:manipulation; }',
    '#debug.shut{ width:auto; }',
    '#debugHead{ display:flex; align-items:center; gap:8px; padding:6px; }',
    '#debugHead button, #debugFoot button{ border:none; border-radius:15px; min-height:30px; padding:0 12px; cursor:pointer;',
    '  background:var(--chip); font-weight:700; font-size:14px; }',
    '#debugToggle[aria-expanded="true"]{ background:var(--accent); color:var(--on-accent); }',
    '#debugTime{ flex:1; min-width:0; font-size:12.5px; color:var(--muted); }',
    '#debug.shut #debugTime, #debug.shut #debugBody, #debug.shut #debugFoot{ display:none; }',
    '#debugBody{ overflow-y:auto; -webkit-overflow-scrolling:touch; overscroll-behavior:contain; padding:0 10px 6px; }',
    '#debugBody h4{ margin:10px 0 2px; font-size:13px; color:var(--muted); }',
    '.dbg-row{ display:grid; grid-template-columns:minmax(0,1fr) 58px; align-items:center; column-gap:8px; padding:2px 0; }',
    '.dbg-row label{ grid-column:1 / 3; font-size:13px; }',
    '.dbg-row input[type=range]{ height:26px; }',
    '.dbg-row output{ font-size:13px; min-width:0; cursor:pointer; }',
    '.dbg-row.changed label{ color:var(--accent); font-weight:700; }',
    '#debugFoot{ display:flex; gap:8px; align-items:center; padding:8px 10px; border-top:1px solid var(--line); }',
    '#debugCount{ flex:1; font-size:12.5px; color:var(--muted); }',
    '#debugTime .slow{ color:#c2410c; font-weight:700; }',
    '@media (min-width: 880px){ #debug{ left:12px; top:12px; max-height:calc(100vh - 24px); max-height:calc(100dvh - 24px); } }'
  ].join('\n');
  document.head.appendChild(css);

  // ---------- The switch, in Looks
  var set = document.createElement('div');
  set.innerHTML = '<h3>Debug</h3><p>A menu over the picture for tuning how the lines are found and drawn.</p>' +
    '<div class="seg accent" id="debugSeg"><button type="button" data-v="0">Off</button><button type="button" data-v="1">On</button></div>';
  document.querySelector('#looks .settings').appendChild(set);

  // ---------- The menu
  var box = document.createElement('div');
  box.id = 'debug';
  box.innerHTML = '<div id="debugHead"><button type="button" id="debugToggle">Debug</button><span id="debugTime"></span></div>' +
    '<div id="debugBody"></div>' +
    '<div id="debugFoot"><span id="debugCount"></span><button type="button" id="debugReset">Reset all</button>' +
    '<button type="button" id="debugCopy">Copy changes</button></div>';
  document.body.appendChild(box);
  var body = box.querySelector('#debugBody'), rows = {};
  function decimals(step){ var s = String(step); return s.indexOf('.') < 0 ? 0 : s.length - s.indexOf('.') - 1; }
  function fmt(d, v){ return Number(v).toFixed(decimals(d.step)); }
  DEFS.forEach(function(d){
    if(d.group){ var h = document.createElement('h4'); h.textContent = d.group; body.appendChild(h); return; }
    var r = document.createElement('div'); r.className = 'dbg-row';
    var id = 'dbg-' + d.key;
    r.innerHTML = '<label for="' + id + '"></label><input type="range" id="' + id + '"><output></output>';
    r.querySelector('label').textContent = d.label;
    var input = r.querySelector('input'), out = r.querySelector('output');
    input.min = d.min; input.max = d.max; input.step = d.step;
    input.addEventListener('input', function(){
      var v = Number(input.value);
      if(Math.abs(v - DEFAULT[d.key]) < d.step/2) delete saved[d.key]; else saved[d.key] = v;
      store('tune', JSON.stringify(saved));
      TUNE[d.key] = v;
      syncRow(d); syncFoot();
      redo(d.kind);
    });
    // Tapping the value puts that slider back to its default.
    out.addEventListener('click', function(){
      if(!(d.key in saved)) return;
      delete saved[d.key];
      store('tune', JSON.stringify(saved));
      TUNE[d.key] = DEFAULT[d.key];
      syncRow(d); syncFoot();
      redo(d.kind);
    });
    body.appendChild(r);
    rows[d.key] = { el:r, input:input, out:out };
  });
  function syncRow(d){
    var r = rows[d.key], v = TUNE[d.key];
    r.input.value = v; r.out.textContent = fmt(d, v);
    r.input.style.setProperty('--p', ((v - d.min)/(d.max - d.min)*100) + '%');
    r.el.classList.toggle('changed', d.key in saved);
    r.el.title = 'Default ' + fmt(d, DEFAULT[d.key]) + '. Tap the value to reset it.';
  }
  function syncFoot(){
    var n = Object.keys(saved).length;
    box.querySelector('#debugCount').textContent = n ? n + ' changed' : 'All defaults';
  }
  function sync(){
    box.hidden = !on;
    box.classList.toggle('shut', !open);
    box.querySelector('#debugToggle').setAttribute('aria-expanded', String(open));
    pressed(document.querySelectorAll('#debugSeg button'), function(b){ return b.dataset.v === (on ? '1' : '0'); });
    DEFS.forEach(function(d){ if(d.key) syncRow(d); });
    syncFoot();
  }

  // ---------- Redoing what a change touches
  var maskTimer = null;
  function redo(kind){
    if(kind === 'mask'){ clearTimeout(maskTimer); maskTimer = setTimeout(function(){ times = {}; showTimes('Finding the lines again…'); refindMasks(); }, 300); }
    else if(kind === 'blur'){ reblurMasks(); paint(); }
    else if(kind === 'all'){ clearTimeout(maskTimer); refindMasks(); reblurMasks(); paint(); }
    else paint();
  }

  // ---------- How long each mask took to find, flagged when it's slow
  var times = {};
  function showTimes(msg){
    var el = box.querySelector('#debugTime'), parts = [];
    [['draw', 'Drawing'], ['ref', 'Reference']].forEach(function(p){
      var m = times[p[0]];
      if(!m) return;
      var slow = m.ms.total > 800;
      parts.push('<span' + (slow ? ' class="slow" title="Slow: this would take several times longer on a phone"' : '') + '>' +
        p[1] + ' ' + m.ms.total + ' ms</span> (edges ' + m.ms.edges + ', lines ' + m.ms.lines + '; ' + m.lines + ' line px)');
    });
    el.innerHTML = parts.length ? parts.join('<br>') : (msg || '');
  }
  document.addEventListener('squintcheck:mask', function(e){ times[e.detail.which] = e.detail.mask; showTimes(); });

  // ---------- Buttons
  box.querySelector('#debugToggle').addEventListener('click', function(){ open = !open; store('debugOpen', open ? '1' : '0'); sync(); });
  box.querySelector('#debugReset').addEventListener('click', function(){
    saved = {}; store('tune', '{}'); applyAll(); sync(); redo('all');
  });
  box.querySelector('#debugCopy').addEventListener('click', function(){
    var keys = Object.keys(saved);
    var text = keys.length ? 'Squint & Check debug changes:\n' + DEFS.filter(function(d){ return d.key in saved; }).map(function(d){
      return d.key + ': ' + fmt(d, saved[d.key]) + '   (default ' + fmt(d, DEFAULT[d.key]) + ', ' + d.label + ')';
    }).join('\n') : 'Squint & Check debug: all defaults';
    copyText(text, function(ok){ toast(ok ? (keys.length ? 'Copied ' + keys.length + ' change' + (keys.length > 1 ? 's' : '') : 'Copied: all defaults') : 'Couldn’t copy here.'); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#debugSeg button'), function(b){
    b.addEventListener('click', function(){
      var was = on;
      on = b.dataset.v === '1'; store('debug', on ? '1' : '0');
      applyAll(); sync();
      if(was !== on && Object.keys(saved).length) redo('all');
    });
  });
  // The clipboard API needs a secure page (https); on a LAN test server the old way still works.
  function copyText(text, done){
    if(navigator.clipboard && window.isSecureContext){
      navigator.clipboard.writeText(text).then(function(){ done(true); }, function(){ done(fallback()); });
    } else done(fallback());
    function fallback(){
      var t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch(e){}
      t.remove();
      return ok;
    }
  }

  sync();
})();
