/*!
 * ocr-engine.js — RenSheet 自研 OCR 管线（PP-OCRv4 识别 + 自研版面切分）
 *
 * 与 Tesseract 方案的区别：
 *   1) 识别用 PP-OCRv4 (ONNX, onnxruntime-web) —— 中文精度高一个档
 *   2) 不做通用文字检测(det)，改用「墨迹投影切分」—— 相册评论是单列文本，
 *      投影法更准、更快，还省掉 4.5MB 的 det 模型
 *   3) CTC 解码支持「词表约束」—— 角色名是有限集合，生僻字锁死在词表内
 */
(function (global) {
  'use strict';

  var BASE = 'lib/ocr/';
  var recSession = null;
  var charset = null;
  var charIndex = null;
  var INPUT_NAME = 'x';

  /* ---------------- 加载 ---------------- */

  async function load(opts) {
    opts = opts || {};
    BASE = opts.basePath || BASE;
    if (!global.ort) throw new Error('onnxruntime-web 未加载（lib/ocr/ort.min.js）');
    if (recSession) return;

    ort.env.wasm.numThreads = 1;          // 静态站没有 COOP/COEP，只能用单线程
    // 必须是绝对 URL —— 运行时用动态 import() 加载 wasm 胶水层，相对路径解析不了
    ort.env.wasm.wasmPaths = new URL(BASE, document.baseURI).href;
    ort.env.wasm.simd = true;

    var candidate = await ort.InferenceSession.create(BASE + 'ch_PP-OCRv4_rec_infer.onnx', {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
    INPUT_NAME = candidate.inputNames[0];

    // 字典：优先读 ONNX metadata，取不到就读同目录的 ppocr_keys.txt（6623 字）
    var meta = (candidate.modelMetadata && candidate.modelMetadata.customMetadata) || {};
    var raw = meta.character;
    if (!raw) {
      try {
        var resp = await fetch(new URL('ppocr_keys.txt', ort.env.wasm.wasmPaths).href);
        if (!resp.ok) throw new Error('读取字典失败：ppocr_keys.txt ' + resp.status);
        raw = await resp.text();
      } catch (error) { await candidate.release(); throw error; }
    }
    charset = ['blank'].concat(raw.replace(/\r/g, '').split('\n')).concat([' ']);
    charIndex = Object.create(null);
    for (var i = 0; i < charset.length; i++) if (!(charset[i] in charIndex)) charIndex[charset[i]] = i;
    recSession = candidate;
  }

  /* ---------------- 墨迹切分 ---------------- */

  function grayOf(d, i) { return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; }

  /** 背景亮度（直方图众数） */
  function backgroundGray(gray) {
    var hist = new Int32Array(256);
    for (var i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
    var best = 0;
    for (var v = 1; v < 256; v++) if (hist[v] > hist[best]) best = v;
    return best;
  }

  /** 二值掩膜的横向腐蚀：窗口内必须全是墨迹 */
  function erodeH(src, W, H, r) {
    var out = new Uint8Array(W * H), win = 2 * r + 1;
    for (var y = 0; y < H; y++) {
      var base = y * W, sum = 0;
      for (var x = 0; x < W + r; x++) {
        if (x < W) sum += src[base + x];
        if (x - win >= 0) sum -= src[base + x - win];
        var tx = x - r;
        if (tx >= 0 && tx < W && x >= win - 1) out[base + tx] = (sum === win) ? 1 : 0;
      }
    }
    return out;
  }

  /** 纵向腐蚀 */
  function erodeV(src, W, H, r) {
    var out = new Uint8Array(W * H), win = 2 * r + 1;
    for (var x = 0; x < W; x++) {
      var sum = 0;
      for (var y = 0; y < H + r; y++) {
        if (y < H) sum += src[y * W + x];
        if (y - win >= 0) sum -= src[(y - win) * W + x];
        var ty = y - r;
        if (ty >= 0 && ty < H && y >= win - 1) out[ty * W + x] = (sum === win) ? 1 : 0;
      }
    }
    return out;
  }

  /** 膨胀（横+纵） */
  function dilate(src, W, H, r) {
    var tmp = new Uint8Array(W * H), out = new Uint8Array(W * H), win = 2 * r + 1;
    for (var y = 0; y < H; y++) {
      var base = y * W, sum = 0;
      for (var x = 0; x < W + r; x++) {
        if (x < W) sum += src[base + x];
        if (x - win >= 0) sum -= src[base + x - win];
        var tx = x - r;
        if (tx >= 0 && tx < W && x >= win - 1) tmp[base + tx] = sum > 0 ? 1 : 0;
      }
    }
    for (var xx = 0; xx < W; xx++) {
      var s = 0;
      for (var yy = 0; yy < H + r; yy++) {
        if (yy < H) s += tmp[yy * W + xx];
        if (yy - win >= 0) s -= tmp[(yy - win) * W + xx];
        var ty = yy - r;
        if (ty >= 0 && ty < H && yy >= win - 1) out[ty * W + xx] = s > 0 ? 1 : 0;
      }
    }
    return out;
  }

  /** 头像与正文之间的竖直空白槽：返回正文起始列 */
  function findTextLeft(colAll, W) {
    var seenInk = false, run = 0;
    var limit = Math.floor(W * 0.4);
    for (var x = 4; x < limit; x++) {
      if (colAll[x] > 0) {
        if (seenInk && run >= 10) {
          var after = 0;
          for (var k = x; k < Math.min(W, x + 80); k++) if (colAll[k] > 0) after++;
          if (after >= 12) return x;
        }
        seenInk = true; run = 0;
      } else if (seenInk) {
        run++;
      }
    }
    return 0;
  }

  /**
   * 抠掉「头像 / 大图标」。
   * 头像分两种：实心插画、线稿。腐蚀法只能抓实心的，所以改成
   * 「在原始墨迹上做连通域，外接框够大（宽高都 >= 64px）就判为头像」——
   * 中文正文字符是独立的小连通域（约 40x40），不会被误杀。
   * 抠掉后，"头像把昵称行和内容行粘成一行"的问题就没了。
   */
  function removeBlobs(ink, W, H, opt) {
    opt = opt || {};
    var minW = opt.avatarW || 64, minH = opt.avatarH || 64;
    var label = new Uint8Array(W * H);
    var stack = new Int32Array(W * H);
    var keep = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) {
      if (!ink[i] || label[i]) continue;
      var top = 0;
      stack[top++] = i; label[i] = 1;
      var x0 = i % W, x1 = x0, y0 = (i - x0) / W, y1 = y0, cnt = 0;
      while (top > 0) {
        var p = stack[--top];
        cnt++;
        var px = p % W, py = (p - px) / W;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = py + dy; if (ny < 0 || ny >= H) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var nx = px + dx; if (nx < 0 || nx >= W) continue;
            var n = ny * W + nx;
            if (ink[n] && !label[n]) { label[n] = 1; stack[top++] = n; }
          }
        }
      }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = cnt / (bw * bh);
      // 头像：外接框够大。图标/实心 emoji：填充率高（汉字的填充率通常只有 0.15~0.4）
      if ((bw >= minW && bh >= minH) || (cnt >= 600 && fill >= 0.62)) {
        for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) keep[yy * W + xx] = 1;
      }
    }
    var grown = dilate(keep, W, H, 4);
    var text = new Uint8Array(W * H);
    for (var k = 0; k < W * H; k++) text[k] = (ink[k] && !grown[k]) ? 1 : 0;
    return text;
  }

  /**
   * 切分：行带 → 行内片段
   * @returns {Array} [{x,y,w,h}]
   */
  function segment(imageData, opt) {
    opt = opt || {};
    var W = imageData.width, H = imageData.height, d = imageData.data;
    var gray = new Uint8Array(W * H);
    for (var i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = grayOf(d, i);
    var bg = backgroundGray(gray);

    var diff = new Uint8Array(W * H), maxD = 0;
    for (var q = 0; q < gray.length; q++) {
      var v = Math.abs(gray[q] - bg);
      diff[q] = v;
      if (v > maxD) maxD = v;
    }
    var inkThresh = Math.max(40, Math.round(maxD * 0.28));

    var ink = new Uint8Array(W * H);
    for (var m = 0; m < gray.length; m++) ink[m] = diff[m] > inkThresh ? 1 : 0;
    var textInk = opt.skipBlobRemoval ? ink : removeBlobs(ink, W, H, opt);

    // 整列墨迹量
    var colAll = new Int32Array(W);
    for (var y0i = 0; y0i < H; y0i++) {
      var b0 = y0i * W;
      for (var x0i = 0; x0i < W; x0i++) if (textInk[b0 + x0i]) colAll[x0i]++;
    }
    // 头像与正文之间会有一条竖直空白槽 —— 找到它，正文只从槽后面算
    var X0 = findTextLeft(colAll, W);

    // 行投影（只看正文区，头像再也不会把两行粘起来）
    var rowInk = new Int32Array(H);
    for (var y = 0; y < H; y++) {
      var n = 0, base = y * W;
      for (var x = X0; x < W; x++) if (textInk[base + x]) n++;
      rowInk[y] = n;
    }
    var minRowInk = Math.max(2, Math.round((W - X0) * 0.004));
    var bands = [], s = -1;
    for (var yy = 0; yy <= H; yy++) {
      var on = yy < H && rowInk[yy] >= minRowInk;
      if (on && s < 0) s = yy;
      if (!on && s >= 0) { bands.push([s, yy]); s = -1; }
    }
    var merged = [];
    for (var b = 0; b < bands.length; b++) {
      var cur2 = bands[b];
      if (merged.length && cur2[0] - merged[merged.length - 1][1] <= 6) merged[merged.length - 1][1] = cur2[1];
      else merged.push([cur2[0], cur2[1]]);
    }
    merged = merged.filter(function (r0) { return r0[1] - r0[0] >= 10; });

    // 保险：仍然过高的行带（说明被什么粘住了）→ 在投影谷底劈开
    var heights = merged.map(function (r0) { return r0[1] - r0[0]; }).sort(function (a, c) { return a - c; });
    var medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
    if (medH > 0) {
      var split = [];
      for (var si = 0; si < merged.length; si++) {
        var r0 = merged[si];
        if (r0[1] - r0[0] < medH * 1.7) { split.push(r0); continue; }
        var lo = r0[0] + Math.round(medH * 0.5), hi = r0[1] - Math.round(medH * 0.5);
        var bestY = -1, bestV = Infinity;
        for (var cy = lo; cy < hi; cy++) if (rowInk[cy] < bestV) { bestV = rowInk[cy]; bestY = cy; }
        if (bestY > 0) { split.push([r0[0], bestY]); split.push([bestY, r0[1]]); }
        else split.push(r0);
      }
      merged = split.filter(function (r0) { return r0[1] - r0[0] >= 10; });
    }

    // 行内列投影 → 片段
    var padY = opt.padY == null ? 3 : opt.padY;
    var gapSplit = opt.gapSplit == null ? 22 : opt.gapSplit;
    var boxes = [];
    for (var mi = 0; mi < merged.length; mi++) {
      var y0 = merged[mi][0], y1 = merged[mi][1];
      var colInk = new Int32Array(W);
      for (var xx = X0; xx < W; xx++) {
        var c = 0;
        for (var ry = y0; ry < y1; ry++) if (textInk[ry * W + xx]) c++;
        colInk[xx] = c;
      }
      var segs = [], st = -1, gap = 0, minCol = 1;
      for (var cx = X0; cx <= W; cx++) {
        var onC = cx < W && colInk[cx] >= minCol;
        if (onC) { if (st < 0) st = cx; gap = 0; }
        else if (st >= 0) {
          gap++;
          if (gap >= gapSplit || cx === W) { segs.push([st, cx - gap + 1]); st = -1; gap = 0; }
        }
      }
      for (var g = 0; g < segs.length; g++) {
        var sx = segs[g][0], sw = segs[g][1] - segs[g][0];
        if (sw < 6) continue;
        var bx = Math.max(0, sx - 2), bh = Math.min(H, y1 + padY) - Math.max(0, y0 - padY);
        boxes.push({ x: bx, y: Math.max(0, y0 - padY), w: Math.min(W, sx + sw + 2) - bx, h: bh });
      }
    }
    return boxes;
  }

  /* ---------------- 识别 ---------------- */

  function cropToTensor(srcCanvas, box, opt) {
    opt = opt || {};
    var padX = opt.padX == null ? 2 : opt.padX;
    var scale = 48 / box.h;
    var cropX = Math.max(0, box.x - padX), cropW = box.w + padX * 2;
    var tmp = document.createElement('canvas');
    tmp.width = cropW; tmp.height = box.h;
    var tc = tmp.getContext('2d');
    tc.drawImage(srcCanvas, cropX, box.y, cropW, box.h, 0, 0, cropW, box.h);

    var ratio = cropW / box.h;
    // 默认不留黑边：PP-OCRv4 的 rec 是全卷积，可以吃任意宽度；
    // 留一大片黑色 padding 会让它在地尾部多吐字（实测"兔8"→"兔8個"），还更慢。
    var maxRatio = opt.paddleWidth === true ? Math.max(320 / 48, ratio) : ratio;
    var imgW = Math.max(1, Math.ceil(48 * maxRatio));
    var resizedW = Math.min(imgW, Math.ceil(48 * ratio));

    var rs = document.createElement('canvas');
    rs.width = resizedW; rs.height = 48;
    var rc = rs.getContext('2d', { willReadFrequently: true });
    rc.imageSmoothingEnabled = true; rc.imageSmoothingQuality = 'high';
    rc.drawImage(tmp, 0, 0, cropW, box.h, 0, 0, resizedW, 48);
    var px = rc.getImageData(0, 0, resizedW, 48).data;

    var data = new Float32Array(3 * 48 * imgW);
    data.fill(-1);                                  // 归一化后的 0 = -1
    var hw = 48 * imgW;
    for (var y = 0; y < 48; y++) {
      for (var x = 0; x < resizedW; x++) {
        var o = (y * resizedW + x) * 4, idx = y * imgW + x;
        data[idx]          = px[o]     / 127.5 - 1;
        data[hw + idx]     = px[o + 1] / 127.5 - 1;
        data[2 * hw + idx] = px[o + 2] / 127.5 - 1;
      }
    }
    return { data: data, w: imgW };
  }

  /** CTC 贪心解码；allowSet 非空时把候选限制在该字符集合内（词表约束） */
  function ctcDecode(out, dims, allowSet) {
    var T = dims[1], C = dims[2], data = out;
    var text = '', probs = [], prev = -1;
    for (var t = 0; t < T; t++) {
      var off = t * C, bi = 0, bp = -Infinity;
      for (var c = 0; c < C; c++) {
        var p = data[off + c];
        if (p > bp) {
          if (allowSet && c !== 0 && !allowSet.has(c)) continue;
          bp = p; bi = c;
        }
      }
      if (bi !== prev && bi !== 0) {
        var ch = charset[bi];
        if (ch !== undefined && ch !== 'blank') { text += ch; probs.push(bp); }
      }
      prev = bi;
    }
    var score = probs.length ? probs.reduce(function (a, b) { return a + b; }, 0) / probs.length : 0;
    return { text: text, score: score };
  }

  async function runBatch(srcCanvas, items, allowSet, recOpt) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var t = cropToTensor(srcCanvas, items[i].box, recOpt);
      var tensor = new ort.Tensor('float32', t.data, [1, 3, 48, t.w]);
      var feeds = {}; feeds[INPUT_NAME] = tensor;
      var res = await recSession.run(feeds);
      var key = recSession.outputNames[0];
      var r = ctcDecode(res[key].data, res[key].dims, allowSet);
      out.push({ box: items[i].box, text: r.text, score: r.score });
      if (items[i].onStep) items[i].onStep(i + 1, items.length);
    }
    return out;
  }

  /**
   * 识别整张图（或指定区域）
   * @param {HTMLCanvasElement|HTMLImageElement} image
   * @param {Object} opts {onProgress(p), allowChars:[], region:{x,y,w,h}}
   */
  async function recognize(image, opts) {
    opts = opts || {};
    if (!recSession) await load(opts);
    var W = image.naturalWidth || image.width, H = image.naturalHeight || image.height;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0);

    if (opts.onProgress) opts.onProgress({ phase: 'segment' });
    var boxes = segment(canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, W, H));

    var allowSet = null;
    if (opts.allowChars && opts.allowChars.length) {
      allowSet = new Set();
      for (var i = 0; i < opts.allowChars.length; i++) {
        var idx = charIndex[opts.allowChars[i]];
        if (idx !== undefined) allowSet.add(idx);
      }
    }
    var items = boxes.map(function (b) {
      return { box: b, onStep: opts.onProgress ? function (d, tot) { opts.onProgress({ phase: 'rec', done: d, total: tot }); } : null };
    });
    var res = await runBatch(canvas, items, allowSet, opts);
    // 丢掉空片段 / 低置信度的碎屑（头像残边、图标之类）
    return res.filter(function (r) {
      var t = r.text.trim();
      if (!t) return false;
      if (r.score < 0.5 && t.length <= 1) return false;
      return true;
    });
  }

  /* ---------------- 版面还原：片段 → 评论记录 ---------------- */

  var DATE_RE = /^20\d{2}[-.\/]?\d{1,2}[-.\/]?\d{1,2}$/;
  var UI_RE = /^(回复|回就|回|评论|赞)$/;

  /**
   * QQ 群相册评论的版式还原。
   * 版式：每条评论 = [昵称行] [内容行(可多行)] [日期行 + 回复]，
   * 按头像和评论间距切块，日期可缺失；块内第一行 = 昵称，其余 = 内容。
   * @param {Array} lines OcrEngine.recognize 的结果
   * @returns {Array} [{cn, body:[...], date, y}]
   */
  function groupAlbumComments(lines, opts) {
    opts = opts || {};
    var sorted = lines.slice().sort(function (a, b) {
      return (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2) || a.box.x - b.box.x;
    });
    var hs = sorted.map(function (l) { return l.box.h; }).sort(function (a, b) { return a - b; });
    var medH = hs.length ? hs[Math.floor(hs.length / 2)] : 40;
    var tol = Math.max(10, medH * 0.45);

    // 同一行的片段合并成一行（"回复"这类按钮先剔掉，否则会把日期行污染成"2025-02-21回复"）
    var rows = [];
    sorted.filter(function (l) { return !UI_RE.test(l.text.trim()); }).forEach(function (l) {
      var cy = l.box.y + l.box.h / 2;
      var row = null;
      for (var i = rows.length - 1; i >= 0 && i >= rows.length - 6; i--) {
        if (Math.abs(rows[i].cy - cy) <= tol) { row = rows[i]; break; }
      }
      if (!row) { row = { cy: cy, y: l.box.y, segs: [] }; rows.push(row); }
      row.segs.push(l);
      row.cy = (row.cy * (row.segs.length - 1) + cy) / row.segs.length;
    });
    rows.forEach(function (r) {
      r.segs.sort(function (a, b) { return a.box.x - b.box.x; });
      r.text = r.segs.map(function (s) { return s.text; }).join('');
      r.score = r.segs.reduce(function (a, s) { return a + s.score; }, 0) / r.segs.length;
    });
    rows = rows.filter(function (r) { return r.text; });

    // 以评论间距 / 头像位置分块，日期只作为可选信息。
    var blocks = [], avatarBands = [], data = opts.imageData;
    if (data && data.width >= 180) {
      var W = data.width, H = data.height, pixels = data.data;
      var hist = new Int32Array(256);
      for (var py = 0; py < H; py += 8) hist[grayOf(pixels, (py * W + Math.floor(W * .94)) * 4) | 0]++;
      var bg = 0;
      for (var g = 1; g < 256; g++) if (hist[g] > hist[bg]) bg = g;
      var start = -1, last = -1, minInk = Math.max(4, Math.round(W * .006));
      for (var ay = 0; ay <= H; ay++) {
        var count = 0;
        if (ay < H) for (var ax = Math.floor(W * .025); ax < W * .15; ax++) {
          if (Math.abs(grayOf(pixels, (ay * W + ax) * 4) - bg) > 28) count++;
        }
        if (count >= minInk) { if (start < 0) start = ay; last = ay; }
        else if (start >= 0 && (ay - last > Math.max(8, W * .018) || ay === H)) {
          if (last - start >= W * .05 && last - start <= W * .28) avatarBands.push({ start: start, end: last });
          start = -1;
        }
      }
    }
    if (avatarBands.length) {
      avatarBands.forEach(function (b, i) {
        var lo = i ? b.start - medH * .7 : -Infinity;
        var hi = i + 1 < avatarBands.length ? avatarBands[i + 1].start - medH * .7 : Infinity;
        blocks.push({ rows: rows.filter(function (r) { return r.cy >= lo && r.cy < hi; }), y: b.start });
      });
    } else {
      var visible = rows.filter(function (r) { return !DATE_RE.test(r.text.replace(/\s/g, '')); });
      visible.forEach(function (r) {
        var lastBlock = blocks[blocks.length - 1];
        var prev = lastBlock && lastBlock.rows[lastBlock.rows.length - 1];
        if (!prev || r.cy - prev.cy > medH * 2.7) blocks.push({ rows: [r], y: r.y });
        else lastBlock.rows.push(r);
      });
    }
    function purchase(text) {
      return /[\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z·]*?(?:\d{1,3}|凹|all|全)/i.test(text.replace(/\s/g, ''));
    }
    var recs = blocks.map(function (block) {
      var date = '', content = block.rows.filter(function (r) {
        var compact = r.text.replace(/\s/g, '');
        if (DATE_RE.test(compact)) { date = r.text; return false; }
        if (/^20\d{2}[-./]\d/.test(compact) || UI_RE.test(compact)) return false;
        return true;
      });
      var nick = content.length ? content[0].text : null;
      var body = content.slice(1).map(function (r) { return r.text; });
      if (content.length === 1 && purchase(content[0].text)) { nick = null; body = [content[0].text]; }
      else if (content.length > 1 && content[0].score < .65) nick = null;
      return { cn: nick, body: body, date: date, y: block.y, needsReview: !nick || !body.length };
    });
    return recs;
  }

  global.OcrEngine = {
    load: load,
    recognize: recognize,
    segment: segment,
    groupAlbumComments: groupAlbumComments,
    get charsetSize() { return charset ? charset.length : 0; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
