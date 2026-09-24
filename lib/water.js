/* 账页水波共享库 — 纯新增，自建画布，不触碰页面任何既有 DOM/逻辑
 * 用法: <script src="lib/water.js"></script> 后调用
 *   WaterFx.init({ waves:true, ripples:false, fish:false, toggleId:null, palette:'ink' })
 * palette: 'ink' 墨蓝 | 'gold' 淡金（打赏页）
 */
(function (global) {
  'use strict';
  if (global.WaterFx) return;

  var PALETTES = {
    ink: {
      wave1: 'rgba(23, 107, 141, .13)',
      wave2: 'rgba(64, 141, 159, .1)',
      wave3: 'rgba(23, 107, 141, .12)',
      wave4: 'rgba(87, 160, 175, .11)',
      ripple: 'rgba(20, 48, 63, '
    },
    gold: {
      wave1: 'rgba(168, 139, 60, .11)',
      wave2: 'rgba(160, 128, 52, .08)',
      wave3: 'rgba(168, 139, 60, .1)',
      wave4: 'rgba(190, 160, 82, .09)',
      ripple: 'rgba(74, 58, 18, '
    }
  };

  var opts = null;
  var canvas = null;
  var ctx = null;
  var ripples = [];
  var fishes = [];
  var width = 0;
  var height = 0;
  var dpr = 1;
  var reducedMotion = false;
  var running = true;
  var frameId = 0;
  var lastTime = 0;
  var lastRipple = 0;

  function init(options) {
    if (opts) return; // 幂等
    opts = {
      waves: !!(options && options.waves),
      ripples: !!(options && options.ripples),
      fish: !!(options && options.fish),
      toggleId: (options && options.toggleId) || null,
      palette: (options && options.palette === 'gold') ? 'gold' : 'ink'
    };
    global.WaterFx.options = opts;

    reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    running = !reducedMotion;

    canvas = document.getElementById('waterCanvas');
    if (canvas) {
      // 复用页面已有画布（如 index-water-preview.html 的标记）
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:fixed;inset:0;z-index:0;width:100%;height:100%;opacity:.85;pointer-events:none;';
    } else {
      canvas = document.createElement('canvas');
      canvas.className = 'water-canvas';
      canvas.id = 'waterCanvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:fixed;inset:0;z-index:0;width:100%;height:100%;opacity:.85;pointer-events:none;';
      document.body.appendChild(canvas);
    }
    ctx = canvas.getContext('2d');

    global.addEventListener('resize', resize, { passive: true });
    if (opts.ripples) {
      global.addEventListener('pointermove', onPointerMove, { passive: true });
    }
    if (opts.fish) {
      document.addEventListener('click', onClick, false);
    }
    if (opts.toggleId) {
      var btn = document.getElementById(opts.toggleId);
      if (btn) {
        btn.addEventListener('click', function () { setMotion(!running); });
      }
    }

    resize();
    draw(0);
    setMotion(running);
  }

  function resize() {
    dpr = Math.min(global.devicePixelRatio || 1, 2);
    width = global.innerWidth;
    height = global.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawWave(y, amplitude, phase, color, lineWidth) {
    ctx.beginPath();
    for (var x = -20; x <= width + 20; x += 12) {
      var py = y + Math.sin(x * .009 + phase) * amplitude + Math.sin(x * .018 - phase * .68) * amplitude * .34;
      if (x === -20) ctx.moveTo(x, py); else ctx.lineTo(x, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  // 水墨金鱼：点击水面时绕点游一圈后化开
  function drawFish(f, time) {
    var prog = f.t / f.dur;
    var alpha = prog < .1 ? prog / .1 : (prog > .72 ? (1 - prog) / .28 : 1);
    if (alpha <= 0) return;
    alpha *= .88;

    var ang = f.phase + prog * Math.PI * 2 * f.loops * f.dir;
    var rad = f.r * (0.55 + 0.45 * Math.min(1, prog * 5));
    var x = f.cx + Math.cos(ang) * rad;
    var y = f.cy + Math.sin(ang) * rad * .9 + Math.sin(prog * Math.PI * 6) * 2.5;
    var heading = ang + f.dir * Math.PI / 2;
    var scale = f.size * (0.75 + 0.25 * Math.min(1, prog * 4));
    var sway = Math.sin(time * .012 + f.phase) + Math.sin(time * .019 + f.phase * 1.7) * .5;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    ctx.scale(scale, scale);
    ctx.lineCap = 'round';

    // 尾鳍三笔，墨色渐淡
    ctx.strokeStyle = 'rgba(198, 88, 58, ' + (.42 * alpha) + ')';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-13, 0);
    ctx.bezierCurveTo(-24, sway * 3 - 4, -33, sway * 5 - 9, -41, sway * 7 - 15);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(205, 98, 62, ' + (.34 * alpha) + ')';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(-13, 0);
    ctx.bezierCurveTo(-23, -sway * 3 + 4, -32, -sway * 5 + 9, -39, -sway * 7 + 14);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(210, 108, 68, ' + (.3 * alpha) + ')';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-13, 0);
    ctx.bezierCurveTo(-20, sway * 4, -26, sway * 6, -31, sway * 8 + 3);
    ctx.stroke();

    // 鱼身湿墨晕开
    var g = ctx.createRadialGradient(4, -2, 2, 4, -2, 27);
    g.addColorStop(0, 'rgba(214, 76, 50, ' + (.85 * alpha) + ')');
    g.addColorStop(.45, 'rgba(208, 88, 58, ' + (.5 * alpha) + ')');
    g.addColorStop(.75, 'rgba(205, 110, 78, ' + (.24 * alpha) + ')');
    g.addColorStop(1, 'rgba(212, 132, 96, ' + (.06 * alpha) + ')');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(22, 0);
    ctx.bezierCurveTo(14, -9, -4, -9, -14, -3);
    ctx.bezierCurveTo(-18, -1, -18, 1, -14, 3);
    ctx.bezierCurveTo(-4, 9, 14, 9, 22, 0);
    ctx.closePath();
    ctx.fill();

    // 背线一笔
    ctx.strokeStyle = 'rgba(148, 44, 30, ' + (.45 * alpha) + ')';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(20, -1);
    ctx.bezierCurveTo(12, -8, -2, -8.5, -13, -3.5);
    ctx.stroke();

    // 背鳍与胸鳍
    ctx.strokeStyle = 'rgba(190, 82, 56, ' + (.32 * alpha) + ')';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(2, -8);
    ctx.bezierCurveTo(4, -13, 8, -12, 10, -8);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(3, 3);
    ctx.bezierCurveTo(0, 6, -3, 8, -5, 7);
    ctx.stroke();

    // 肚白
    ctx.strokeStyle = 'rgba(255, 214, 178, ' + (.26 * alpha) + ')';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(16, 2);
    ctx.bezierCurveTo(6, 7, -6, 7, -13, 2.5);
    ctx.stroke();

    // 点睛
    ctx.fillStyle = 'rgba(34, 17, 11, ' + (.8 * alpha) + ')';
    ctx.beginPath();
    ctx.arc(13, -2.5, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 240, 222, ' + (.55 * alpha) + ')';
    ctx.beginPath();
    ctx.arc(13.6, -3.1, .6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function draw(time) {
    var dt = lastTime ? Math.min(time - lastTime, 40) : 16;
    lastTime = time;
    ctx.clearRect(0, 0, width, height);

    if (opts.waves) {
      var phase = reducedMotion ? 0 : time * .00018;
      var pal = PALETTES[opts.palette];
      drawWave(height * .15, 15, phase, pal.wave1, 1);
      drawWave(height * .165 + 10, 11, phase + 1.8, pal.wave2, 1);
      drawWave(height * .78, 24, phase * .72 + 3.4, pal.wave3, 1);
      drawWave(height * .815, 16, phase * .9 + 5.2, pal.wave4, 1);
    }

    for (var i = ripples.length - 1; i >= 0; i--) {
      var ripple = ripples[i];
      ripple.radius += .9;
      ripple.alpha *= .985;
      ctx.beginPath();
      ctx.ellipse(ripple.x, ripple.y, ripple.radius * 1.7, ripple.radius * .55, 0, 0, Math.PI * 2);
      ctx.strokeStyle = PALETTES[opts.palette].ripple + (ripple.alpha * 1.1) + ')';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (ripple.alpha < .018) ripples.splice(i, 1);
    }

    for (var j = fishes.length - 1; j >= 0; j--) {
      var f = fishes[j];
      f.t += dt;
      drawFish(f, time);
      if (f.t >= f.dur) fishes.splice(j, 1);
    }

    if (running) frameId = global.requestAnimationFrame(draw);
  }

  function onPointerMove(event) {
    if (!running || event.pointerType === 'touch') return;
    var now = performance.now();
    if (now - lastRipple > 115) {
      ripples.push({ x: event.clientX, y: event.clientY, radius: 4, alpha: .15 });
      if (ripples.length > 18) ripples.shift();
      lastRipple = now;
    }
  }

  function onClick(event) {
    if (!running || reducedMotion) return;
    if (event.target.closest && event.target.closest('a, button, summary, input, label, select, textarea')) return;
    if (fishes.length >= 6) fishes.shift();
    fishes.push({
      cx: event.clientX, cy: event.clientY,
      r: 46 + Math.random() * 24,
      dir: Math.random() < .5 ? 1 : -1,
      loops: 1.2 + Math.random() * .5,
      dur: 2600 + Math.random() * 600,
      phase: Math.random() * Math.PI * 2,
      size: .85 + Math.random() * .3,
      t: 0
    });
    ripples.push({ x: event.clientX, y: event.clientY, radius: 4, alpha: .2 });
  }

  function setMotion(next) {
    running = next;
    if (!next) fishes.length = 0;
    var label = next ? '暂停水波' : '继续水波';
    if (opts.toggleId) {
      var btn = document.getElementById(opts.toggleId);
      if (btn) {
        btn.textContent = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
      }
    }
    global.cancelAnimationFrame(frameId);
    if (running) frameId = global.requestAnimationFrame(draw);
    else draw(performance.now());
  }

  global.WaterFx = { init: init, options: null };
}(window));
