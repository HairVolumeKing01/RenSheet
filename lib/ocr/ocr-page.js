/* 相册排表：图片队列 → 一次识别 → 校对 → 标准排表。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var P = window.CommentParse;
  var DRAFT = 'renshet_ocr_draft_v3', OLD_DRAFT = 'renshet_ocr_draft_v2';
  var LS_ALIAS = 'renshet_ocr_aliases_v1', LS_IGNORE = 'renshet_ocr_ignored_v1';
  var CACHE_LIMIT = 2200000;
  function stored(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { return {}; } }
  function initialState() {
    return {
      queue: [], records: [], aliases: Object.assign(Object.create(null), stored(LS_ALIAS)),
      ignored: Object.assign(Object.create(null), stored(LS_IGNORE)), canon: [], prices: Object.create(null),
      aliasConfirmed: false, orderConfirmed: false, confirmed: false, orderMode: '',
      totalQuota: '', kindName: '', fileName: '', theme: 'blue', selectedRecordId: '', busy: false, ingesting: false, sourceView: '', liveOpen: false
    };
  }
  var state = initialState();
  var toastTimer, saveTimer, exportBusy = false, choiceResolve = null, draftCleared = false, queueDrag = null, queueScrollFrame = null;
  var imageWindows = new Map(), imageWindowSerial = 0;
  function raiseWindow(panel) {
    var panels = Array.from(imageWindows.values()).map(function (view) { return view.panel; });
    if (state.liveOpen) panels.push($('livePanel'));
    panels = panels.filter(function (p) { return p !== panel; }).sort(function (a, b) { return Number(a.style.zIndex) - Number(b.style.zIndex); });
    panels.push(panel); panels.forEach(function (p, i) { p.style.zIndex = 73 + i; });
  }
  var SHEET_STYLE = { ink: '173442', gray: 'E4E7E9', grayInk: '7A858C', rule: 'D2DDE1', font: 'Microsoft YaHei', size: 11 };
  var THEMES = {
    blue:   {titleBg:'#0D2137', titleFg:'#FFFFFF', headerBg:'#1A4570', rowEven:'#EDF5FA', rowOdd:'#FFFFFF'},
    teal:   {titleBg:'#1D4044', titleFg:'#FFFFFF', headerBg:'#285E61', rowEven:'#E6FFFA', rowOdd:'#FFFFFF'},
    slate:  {titleBg:'#1A202C', titleFg:'#FFFFFF', headerBg:'#2D3748', rowEven:'#EDF2F7', rowOdd:'#FFFFFF'},
    indigo: {titleBg:'#2A204A', titleFg:'#FFFFFF', headerBg:'#44337A', rowEven:'#EBF4FF', rowOdd:'#FFFFFF'},
    cyan:    {titleBg:'#0F4C6A', titleFg:'#FFFFFF', headerBg:'#0E7490', rowEven:'#E0F2FE', rowOdd:'#FFFFFF'},
    sage:    {titleBg:'#1F4532', titleFg:'#FFFFFF', headerBg:'#256D46', rowEven:'#E6FFFA', rowOdd:'#FFFFFF'},
    sea:     {titleBg:'#164E63', titleFg:'#FFFFFF', headerBg:'#0F766E', rowEven:'#D9F2F9', rowOdd:'#FFFFFF'},
    violet:  {titleBg:'#2D1B4E', titleFg:'#FFFFFF', headerBg:'#553C9A', rowEven:'#F5F0FF', rowOdd:'#FFFFFF'},
    navy:    {titleBg:'#0A1628', titleFg:'#FFFFFF', headerBg:'#1E3A5F', rowEven:'#EBF0F7', rowOdd:'#FFFFFF'},
    steel:   {titleBg:'#1E2D3D', titleFg:'#FFFFFF', headerBg:'#3B5C7A', rowEven:'#EDF2F7', rowOdd:'#FFFFFF'},
    moss:    {titleBg:'#1C2A1C', titleFg:'#FFFFFF', headerBg:'#3A5A3A', rowEven:'#F2F7F2', rowOdd:'#FFFFFF'},
    graphite:{titleBg:'#1A1A1A', titleFg:'#FFFFFF', headerBg:'#3D3D3D', rowEven:'#F5F5F5', rowOdd:'#FFFFFF'},
    amber:   {titleBg:'#5C3A16', titleFg:'#FFFFFF', headerBg:'#A0642A', rowEven:'#FFF4E5', rowOdd:'#FFFFFF'},
    terracotta:{titleBg:'#5A2E24', titleFg:'#FFFFFF', headerBg:'#A85F4B', rowEven:'#FBEDEA', rowOdd:'#FFFFFF'},
    warmrose:{titleBg:'#5B2736', titleFg:'#FFFFFF', headerBg:'#A6536D', rowEven:'#FCEEF3', rowOdd:'#FFFFFF'},
    cocoa:   {titleBg:'#4B3528', titleFg:'#FFFFFF', headerBg:'#8A684E', rowEven:'#F7F0E8', rowOdd:'#FFFFFF'}
  };
  var SWATCHES = [["blue", "linear-gradient(135deg, #1A4570, #2B6FA8)", "医用蓝"], ["teal", "linear-gradient(135deg, #234E52, #319795)", "水色"], ["slate", "linear-gradient(135deg, #2D3748, #4A5568)", "暗灰"], ["indigo", "linear-gradient(135deg, #3C366B, #5A4FCF)", "紫蓝"], ["cyan", "linear-gradient(135deg, #0E7490, #38BDF8)", "青蓝"], ["sage", "linear-gradient(135deg, #22543D, #68D391)", "薄荷"], ["sea", "linear-gradient(135deg, #164E63, #38BDF8)", "海蓝"], ["violet", "linear-gradient(135deg, #44337A, #805AD5)", "暮紫"], ["navy", "linear-gradient(135deg, #0A1628, #1E3A5F)", "海军蓝"], ["steel", "linear-gradient(135deg, #2D3748, #4A6578)", "钢蓝"], ["moss", "linear-gradient(135deg, #1C2A1C, #3A5A3A)", "苔绿"], ["graphite", "linear-gradient(135deg, #1A1A1A, #3D3D3D)", "石墨"], ["amber", "linear-gradient(135deg, #5C3A16, #A0642A)", "琥珀"], ["terracotta", "linear-gradient(135deg, #5A2E24, #A85F4B)", "陶土"], ["warmrose", "linear-gradient(135deg, #5B2736, #A6536D)", "暖玫瑰"], ["cocoa", "linear-gradient(135deg, #4B3528, #8A684E)", "暖棕"]];
  var measureContext = document.createElement('canvas').getContext('2d');
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function exportName() {
    var name = (state.fileName.trim() || state.kindName.trim() || '排表').replace(/(?:\.xlsx)+$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!name) name = '排表';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  }
  function renderTheme() {
    if (!$('colorSwatches').children.length) $('colorSwatches').innerHTML = SWATCHES.map(function (s) {
      return '<button type="button" class="color-swatch" data-theme="' + s[0] + '" style="background:' + esc(s[1]) + '" title="' + esc(s[2]) + '" aria-label="' + esc(s[2]) + '" aria-pressed="false"></button>';
    }).join('');
    $('colorSwatches').querySelectorAll('[data-theme]').forEach(function (b) {
      var on = b.dataset.theme === state.theme;
      b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); b.disabled = state.busy || state.ingesting || exportBusy;
      if (on) $('themeName').textContent = b.title;
    });
  }
  function toast(msg, error) { clearTimeout(toastTimer); $('toast').textContent = msg; $('toast').className = 'toast on' + (error ? ' err' : ''); toastTimer = setTimeout(function () { $('toast').className = 'toast'; }, 4200); }
  function active() { return state.records.filter(function (r) { return !r.omit; }); }
  function rawRoles() { return P.collectRawRoles(active(), state.ignored); }
  function tokens(r) { return (r.body || []).flatMap(function (b) { return P.tokenizeBody(b, r.cn); }).filter(function (t) { return !state.ignored[t.raw]; }); }
  function issues(r) {
    if (r.omit) return [];
    var out = [], t = tokens(r);
    if (!String(r.cn || '').trim()) out.push('补充昵称');
    if (!(r.body || []).join('').trim()) out.push('补充正文');
    else if (!t.length) out.push('核对角色与数量');
    if (t.some(function (v) { return !v.all && v.qty <= 0; })) out.push('数量须大于 0');
    if (state.orderMode === 'single' && t.some(function (v) { return v.all; })) out.push('单领模式请将凹/all改为数量');
    if (r.duplicateOf && !r.duplicateReviewed) out.push('疑似截图重叠，确认保留或忽略');
    return out;
  }
  function sortRecords() {
    var ranks = new Map(state.queue.map(function (q, i) { return [q.id, i]; }));
    state.records.sort(function (a, b) { return (ranks.get(a.sourceId) ?? 999) - (ranks.get(b.sourceId) ?? 999) || (a.index || 0) - (b.index || 0); });
    markOverlaps();
  }
  function markOverlaps() {
    var previous = state.records.map(function (r) { var ref = r.duplicateOf; delete r.duplicateOf; return ref; });
    function same(a, b) {
      return a.cn && b.cn && (a.body || []).length && (b.body || []).length &&
        a.cn.replace(/\s/g, '') === b.cn.replace(/\s/g, '') &&
        a.body.join('').replace(/\s/g, '') === b.body.join('').replace(/\s/g, '') &&
        (!a.date || !b.date || a.date === b.date);
    }
    state.queue.forEach(function (q, i) {
      if (!i) return;
      var left = state.records.filter(function (r) { return r.sourceId === state.queue[i - 1].id && r.src !== '手动'; });
      var right = state.records.filter(function (r) { return r.sourceId === q.id && r.src !== '手动'; });
      for (var n = Math.min(left.length, right.length); n > 0; n--) {
        if (right.slice(0, n).every(function (r, k) { return same(left[left.length - n + k], r); })) {
          right.slice(0, n).forEach(function (r, k) { r.duplicateOf = left[left.length - n + k].id; }); break;
        }
      }
    });
    state.records.forEach(function (r, i) { if (previous[i] !== r.duplicateOf) r.duplicateReviewed = false; });
  }
  function syncRoles(previousMap) {
    var roles = [];
    active().forEach(function (r) { tokens(r).forEach(function (t) {
      if (!Object.prototype.hasOwnProperty.call(state.aliases, t.raw)) { state.aliases[t.raw] = t.raw; state.aliasConfirmed = false; }
      var name = state.aliases[t.raw] || t.raw;
      if (!roles.includes(name)) roles.push(name);
    }); });
    var old = state.canon.map(function (r) {
      if (roles.includes(r)) return r;
      var raw = previousMap && Object.keys(previousMap).find(function (k) { return previousMap[k] === r && roles.includes(state.aliases[k]); });
      return raw ? state.aliases[raw] : r;
    });
    state.canon = old.filter(function (r, i) { return roles.includes(r) && old.indexOf(r) === i; });
    roles.forEach(function (r) { if (!state.canon.includes(r)) state.canon.push(r); });
  }
  function current() {
    var settled = P.settle(active(), { orderMode: state.orderMode || 'single', totalQuota: state.totalQuota, aliasMap: state.aliases, ignore: state.ignored });
    return { settled: settled, sheet: P.buildSheet(settled, state.canon) };
  }
  function saveDraft() {
    clearTimeout(saveTimer);
    if (draftCleared) return;
    var cacheSize = 0;
    var queue = state.queue.map(function (q) {
      var dataUrl = q.dataUrl && cacheSize + q.dataUrl.length <= CACHE_LIMIT ? q.dataUrl : '';
      cacheSize += dataUrl.length;
      return { id: q.id, hash: q.hash, name: q.name, width: q.width, height: q.height, status: q.status === 'working' ? 'pending' : q.status, error: q.error, count: q.count, dataUrl: dataUrl };
    });
    var d = { queue: queue, records: state.records, aliases: state.aliases, ignored: state.ignored,
      canon: state.canon, prices: state.prices, aliasConfirmed: state.aliasConfirmed,
      orderConfirmed: state.orderConfirmed, confirmed: state.confirmed, orderMode: state.orderMode,
      totalQuota: state.totalQuota, kindName: state.kindName, fileName: state.fileName, theme: state.theme, selectedRecordId: state.selectedRecordId };
    try { sessionStorage.setItem(DRAFT, JSON.stringify(d)); }
    catch (_) {
      d.queue.forEach(function (q) { q.dataUrl = ''; });
      try { sessionStorage.setItem(DRAFT, JSON.stringify(d)); }
      catch (_) { $('queueNotice').textContent = '浏览器存储空间不足，请在关闭页面前导出。'; }
    }
  }
  function touch(aliasChange) { draftCleared = false; state.confirmed = false; if (aliasChange) state.aliasConfirmed = false; syncRoles(); clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 180); }
  function resetDraft() {
    if (state.busy || state.ingesting || exportBusy) return;
    if (!window.confirm('重置本次排表？将清空本次图片、评论和输出设置，保留已保存的角色对照。')) return;
    clearTimeout(saveTimer); clearTimeout(toastTimer); queueDrag = null; stopQueueScroll();
    imageWindows.forEach(closeImageWindow);
    $('sourceImage').onload = null;
    $('sourceImage').removeAttribute('src');
    state.queue.forEach(function (q) { if (q.url && q.url.startsWith('blob:')) URL.revokeObjectURL(q.url); });
    state = initialState(); draftCleared = true;
    try { [DRAFT, OLD_DRAFT, 'renshet_ocr_handoff'].forEach(function (key) { sessionStorage.removeItem(key); }); } catch (_) {}
    $('imgInput').value = ''; $('onlyIssues').checked = false; $('aliasDetails').open = false;
    $('aliasNewRaw').value = ''; $('aliasNewCanon').value = '';
    $('priceBox').closest('details').open = false;
    $('progress').style.display = 'none'; $('progressLabel').textContent = ''; $('barFill').style.width = '0%';
    $('queueNotice').textContent = ''; $('dropZone').classList.remove('drag-over');
    $('sourceScroll').scrollTop = 0; $('editTable').parentElement.scrollTop = 0;
    $('previewTable').parentElement.scrollLeft = 0; $('previewTable').parentElement.scrollTop = 0;
    $('livePanel').removeAttribute('style'); showLive(false);
    renderAll(); $('btnResetDraft').focus(); toast('本次排表已重置');
  }
  function restore() {
    var d;
    try { d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null'); } catch (_) {}
    if (!d) {
      try {
        var old = JSON.parse(sessionStorage.getItem(OLD_DRAFT) || 'null');
        if (old && old.records && old.records.length) {
          var names = Array.from(new Set(old.records.map(function (r) { return r.src || '旧截图'; })));
          d = Object.assign({}, old, { orderMode: '', totalQuota: '', confirmed: false, orderConfirmed: false,
            queue: names.map(function (name, i) { return { id: 'legacy-' + i, name: name, status: 'done', count: old.records.filter(function (r) { return (r.src || '旧截图') === name; }).length }; }),
            records: old.records.map(function (r, i) { return Object.assign({}, r, { id: 'legacy-record-' + i, sourceId: 'legacy-' + names.indexOf(r.src || '旧截图'), index: i }); }) });
        }
      } catch (_) {}
    }
    if (!d || !Array.isArray(d.records) || !Array.isArray(d.queue)) return;
    ['records', 'canon', 'prices', 'aliasConfirmed', 'orderConfirmed', 'confirmed', 'orderMode', 'totalQuota', 'kindName', 'fileName', 'theme', 'selectedRecordId'].forEach(function (k) { if (d[k] != null) state[k] = d[k]; });
    if (!Object.prototype.hasOwnProperty.call(THEMES, state.theme)) state.theme = 'blue';
    state.aliases = Object.assign(Object.create(null), d.aliases || {});
    state.ignored = Object.assign(Object.create(null), d.ignored || {});
    state.queue = d.queue.map(function (q) { q.url = q.dataUrl || ''; return q; });
    state.sourceView = state.queue[0] && state.queue[0].id || '';
    syncRoles(); sortRecords();
    $('queueNotice').textContent = '已恢复 ' + state.queue.length + ' 张图片、' + state.records.length + ' 条评论。' + (state.queue.some(function (q) { return !q.url; }) ? '未缓存的原图可补选，已识别内容不会重复加入。' : '可继续校对。');
  }
  function renderQueue() {
    var working = state.busy || state.ingesting || exportBusy;
    $('imageQueue').innerHTML = state.queue.map(function (q, i) {
      var label = { pending: '待识别', working: '识别中', done: '已识别 ' + (q.count || 0) + ' 条', failed: '识别失败，可重试' }[q.status] || '待识别';
      var long = q.height / q.width > 5 || q.height > 4000;
      return '<div class="queue-item ' + esc(q.status) + '" draggable="' + !working + '" data-image="' + esc(q.id) + '"><button class="thumb" data-view="' + esc(q.id) + '" aria-label="查看 ' + esc(q.name) + '">' + (q.url ? '<img draggable="false" src="' + esc(q.url) + '" alt="' + esc(q.name) + '">' : '<span>补选原图</span>') + '</button><div class="queue-name">' + (i + 1) + '. ' + esc(q.name) + '</div><div class="queue-meta">' + esc(label) + (long ? ' · 建议分图' : '') + '</div>' + (q.error ? '<div class="record-issue">' + esc(q.error) + '</div>' : '') + '<div class="queue-actions"><button type="button" class="queue-grip" data-grip="' + esc(q.id) + '" aria-label="拖动 ' + esc(q.name) + ' 排序，键盘左右键调整" ' + (working ? 'disabled' : '') + '><svg viewBox="0 0 12 18" aria-hidden="true" fill="currentColor"><circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="9" r="1.4"/><circle cx="3" cy="15" r="1.4"/><circle cx="9" cy="15" r="1.4"/></svg>排序</button><button class="btn ghost xs" data-remove="' + esc(q.id) + '" ' + (working ? 'disabled' : '') + '>移除</button></div></div>';
    }).join('');
    $('orderState').textContent = state.queue.length ? (state.orderConfirmed ? '图片顺序已确认。' : '请确认图片顺序后识别。') : '';
    $('btnConfirmOrder').disabled = working || !state.queue.length;
    $('btnResetDraft').disabled = working || exportBusy;
    var pending = state.queue.filter(function (q) { return q.status !== 'done'; });
    $('btnRecognize').disabled = working || !state.orderConfirmed || !pending.some(function (q) { return q.url; });
    $('btnRecognize').textContent = state.busy ? '识别中…' : pending.some(function (q) { return q.status === 'failed'; }) ? '重试未完成图片' : '全部识别';
    $('imgInput').disabled = working;
    $('dropZone').setAttribute('aria-disabled', String(working));
    $('importStat').textContent = state.queue.length ? state.queue.length + ' 张图片 · 已识别 ' + state.queue.filter(function (q) { return q.status === 'done'; }).length + ' 张 · ' + state.records.length + ' 条评论' : '';
    $('sourceFilter').innerHTML = '<option value="all">全部图片</option>' + state.queue.map(function (q, i) { return '<option value="' + esc(q.id) + '">' + (i + 1) + '. ' + esc(q.name) + '</option>'; }).join('');
    $('sourceFilter').value = state.sourceFilter || 'all';
  }
  function setSource(id, y) {
    var q = state.queue.find(function (v) { return v.id === id; });
    state.sourceView = id;
    $('sourceTitle').textContent = q ? q.name : '原图对照';
    $('sourceImage').hidden = !q || !q.url; $('sourceEmpty').hidden = !!(q && q.url);
    $('sourceEmpty').textContent = q ? '补选此图片可恢复原图对照。' : '选择评论查看对应原图。';
    if (q && q.url) {
      var im = $('sourceImage');
      im.setAttribute('aria-label', '打开 ' + q.name + ' 原图悬浮窗');
      if (im.getAttribute('src') !== q.url) im.src = q.url;
      function scroll() { if (y != null) $('sourceScroll').scrollTop = Math.max(0, y * im.clientWidth / q.width - 30); }
      if (im.complete) scroll(); else im.onload = scroll;
    }
  }
  function issueHtml(r) { return esc(issues(r).join(' · ')) + (r.duplicateOf && !r.duplicateReviewed && !r.omit ? '<button class="btn ghost xs" data-keepduplicate="' + esc(r.id) + '">确认保留此条</button>' : ''); }
  function renderEditHint() {
    var count = active().filter(function (r) { return issues(r).length; }).length;
    $('editHint').textContent = count ? count + ' 条待核对；补齐昵称、角色与数量，或勾选忽略。日期可留空。' : '共 ' + state.records.length + ' 条评论；请对照原图核对昵称与数量。';
  }
  function renderEdit() {
    if (!state.records.some(function (r) { return r.id === state.selectedRecordId; })) state.selectedRecordId = '';
    var visible = state.records.filter(function (r) { return (!state.sourceFilter || state.sourceFilter === 'all' || r.sourceId === state.sourceFilter) && (!$('onlyIssues').checked || issues(r).length); });
    var html = '<thead><tr><th style="width:17%">来源</th><th style="width:30%">昵称 / CN</th><th>评论内容</th></tr></thead><tbody>';
    visible.forEach(function (r) {
      var n = state.records.indexOf(r) + 1, problem = issues(r);
      html += '<tr class="record' + (problem.length ? ' pending' : '') + (r.omit ? ' omitted' : '') + '" data-id="' + esc(r.id) + '"><td><div class="record-meta"><b>' + n + '</b><button class="source-link" data-source="' + esc(r.sourceId) + '" data-y="' + (r.y || 0) + '">' + esc(r.src || '手动') + '</button>' + (r.date ? '<small>' + esc(r.date) + '</small>' : '') + '</div><label class="record-select"><input type="radio" name="selectedRecord" aria-label="选中第 ' + n + ' 条评论">选中</label><label class="record-ignore"><input type="checkbox" data-f="omit" ' + (r.omit ? 'checked' : '') + '> 忽略</label></td><td data-label="昵称 / CN"><input type="text" data-f="cn" aria-label="第 ' + n + ' 条昵称" value="' + esc(r.cn || '') + '"></td><td data-label="评论内容"><textarea data-f="body" aria-label="第 ' + n + ' 条评论">' + esc((r.body || []).join('\n')) + '</textarea><div class="record-issue">' + issueHtml(r) + '</div>' + '</td></tr>';
    });
    $('editTable').innerHTML = html + '</tbody>';
    renderSelection(); renderEditHint();
  }
  function renderSelection() {
    var selected = state.records.find(function (r) { return r.id === state.selectedRecordId; });
    $('editTable').querySelectorAll('[data-id]').forEach(function (tr) {
      var on = tr.dataset.id === state.selectedRecordId;
      tr.classList.toggle('active', on); tr.querySelector('[name=selectedRecord]').checked = on;
    });
    $('btnAddRecord').disabled = !selected || state.busy || state.ingesting || exportBusy;
    $('insertionHint').textContent = selected ? '新增评论将插在第 ' + (state.records.indexOf(selected) + 1) + ' 条之后。' : '先选中评论，再在其后新增。';
  }
  function selectRecord(tr) {
    if (!tr || state.busy || state.ingesting || exportBusy) return;
    state.selectedRecordId = tr.dataset.id; renderSelection(); saveDraft();
  }
  function renderAlias() {
    var raws = rawRoles();
    $('aliasSummary').textContent = '角色对照 · ' + raws.length + ' 个称呼 · ' + (state.aliasConfirmed ? '已确认' : '待确认');
    $('aliasHint').textContent = '同一角色的不同称呼，填写相同归属。';
    $('aliasTable').innerHTML = '<thead><tr><th>原称呼</th><th>归属角色</th><th style="width:75px">操作</th></tr></thead><tbody>' + raws.map(function (r) { return '<tr><td>' + esc(r.raw) + '</td><td><input type="text" data-raw="' + esc(r.raw) + '" value="' + esc(state.aliases[r.raw] || r.raw) + '" aria-label="' + esc(r.raw) + ' 的归属" list="canonList"></td><td><button class="btn ghost xs" data-ignore="' + esc(r.raw) + '">忽略</button></td></tr>'; }).join('') + '</tbody>';
    $('canonListBox').innerHTML = '<datalist id="canonList">' + state.canon.map(function (v) { return '<option value="' + esc(v) + '"></option>'; }).join('') + '</datalist>';
    $('ignoredBox').innerHTML = Object.keys(state.ignored).map(function (k) { return '<span class="tag">' + esc(k) + ' <button class="btn ghost xs" data-restore="' + esc(k) + '">恢复</button></span>'; }).join('');
    var currentRaw = raws.map(function (r) { return r.raw; });
    var saved = Object.keys(state.aliases).filter(function (k) { return !currentRaw.includes(k) && !state.ignored[k]; });
    $('savedOnlyBox').innerHTML = saved.length ? '<details><summary class="compact-hint">其他已保存对照（' + saved.length + '）</summary>' + saved.map(function (k) { return '<div class="compact-hint">' + esc(k) + ' → ' + esc(state.aliases[k]) + '</div>'; }).join('') + '</details>' : '';
  }
  function sheetPresentation(sheet, removeGray) {
    var theme = THEMES[state.theme] || THEMES.blue;
    var prices = Object.create(null);
    state.canon.forEach(function (r) { var v = state.prices[r]; prices[r] = v === '' || v == null ? '' : Number(v); });
    var matrix = P.toSheetMatrix(sheet, state.kindName.trim(), prices, { removeGray: removeGray });
    var columns = matrix[1].map(function (_, i) { var width = i ? 24 : 13; return { width: width, pixels: width * 7 + 5 }; });
    function lineCount(value, maxWidth) {
      return String(value ?? '').split('\n').reduce(function (total, line) {
        var count = 1, width = 0;
        Array.from(line).forEach(function (c) { var advance = measureContext.measureText(c).width; if (width && width + advance > maxWidth) { count++; width = 0; } width += advance; });
        return total + count;
      }, 0);
    }
    var rows = matrix.map(function (row, i) {
      var size = i === 0 ? 15 : SHEET_STYLE.size;
      measureContext.font = (i < 2 ? 'bold ' : '') + size + 'pt "' + SHEET_STYLE.font + '"';
      var lines = columns.reduce(function (n, col, c) { return Math.max(n, lineCount(row[c], col.pixels - 16)); }, 1);
      var gray = !removeGray && i >= 3 && sheet.grayRows[i - 3];
      return { header: i === 1, gray: gray, size: size, bold: i < 2, height: Math.max(i === 0 ? 36 : i === 1 ? 28 : i === 2 ? 24 : 22, Math.ceil(lines * size * 1.2 + 6)),
        background: (gray ? SHEET_STYLE.gray : i === 0 ? theme.titleBg : i === 1 ? theme.headerBg : i === 2 ? theme.rowOdd : (i - 3) % 2 === 0 ? theme.rowEven : theme.rowOdd).replace('#', ''),
        color: gray ? SHEET_STYLE.grayInk : i < 2 ? theme.titleFg.replace('#', '') : SHEET_STYLE.ink };
    });
    return { matrix: matrix, columns: columns, rows: rows };
  }
  function tableHtml(presentation) {
    var html = '<colgroup>' + presentation.columns.map(function (c) { return '<col style="width:' + c.pixels + 'px">'; }).join('') + '</colgroup><thead>';
    presentation.matrix.forEach(function (row, i) {
      if (i === 3) html += '</thead><tbody>';
      var style = presentation.rows[i], cellTag = style.header ? 'th' : 'td';
      html += '<tr class="' + (i === 0 ? 'kind-row' : i === 1 ? 'role-row' : i === 2 ? 'price-row' : 'data-row') + (style.gray ? ' gray-row' : '') + '" style="height:' + style.height * 4 / 3 + 'px;--row-bg:#' + style.background + ';--row-ink:#' + style.color + ';--row-size:' + style.size + 'pt;--row-weight:' + (style.bold ? 700 : 400) + '">';
      html += presentation.columns.map(function (_, c) { return '<' + cellTag + (c === 0 && i >= 3 ? ' class="seq"' : '') + '>' + esc(row[c]) + '</' + cellTag + '>'; }).join('') + '</tr>';
    });
    return html + (presentation.matrix.length > 3 ? '</tbody>' : '</thead>');
  }
  function renderColumnOrder(sheet) {
    $('columnOrder').hidden = !sheet.chars.length;
    $('columnOrder').innerHTML = '<span>列顺序</span>' + sheet.chars.map(function (r, i) {
      return '<span class="column-chip"><span>' + esc(r) + '</span><button type="button" data-col="' + i + '" data-dir="-1" aria-label="' + esc(r) + ' 左移" ' + (i ? '' : 'disabled') + '>←</button><button type="button" data-col="' + i + '" data-dir="1" aria-label="' + esc(r) + ' 右移" ' + (i === sheet.chars.length - 1 ? 'disabled' : '') + '>→</button></span>';
    }).join('');
  }
  function renderPrices() {
    $('priceBox').innerHTML = '<div class="field">' + state.canon.map(function (r) { return '<div class="field-group"><label>' + esc(r) + '</label><input type="number" min="0" step="0.01" data-price="' + esc(r) + '" aria-label="' + esc(r) + ' 单价" value="' + esc(state.prices[r] ?? '') + '" placeholder="留空按 0" style="width:110px"></div>'; }).join('') + '</div>';
  }
  function renderPreview() {
    renderTheme(); renderSelection();
    var result = current(), sheet = result.sheet;
    var presentation = sheetPresentation(sheet, false), html = tableHtml(presentation);
    ['previewTable', 'liveTable'].forEach(function (id) {
      var table = $(id), width = presentation.columns.reduce(function (n, c) { return n + c.pixels; }, 0);
      table.classList.add('sheet-grid'); table.innerHTML = html; table.style.minWidth = width + 'px'; table.style.width = width + 'px';
      table.style.setProperty('--sheet-rule', '#' + SHEET_STYLE.rule); table.style.setProperty('--sheet-font', '"' + SHEET_STYLE.font + '"'); table.style.setProperty('--sheet-size', SHEET_STYLE.size + 'pt');
    });
    renderColumnOrder(sheet);
    $('quotaField').hidden = state.orderMode !== 'ratio';
    $('kindName').disabled = !state.orderMode;
    $('priceBox').querySelectorAll('input').forEach(function (el) { el.disabled = !state.orderMode; });
    $('modeHint').textContent = !state.orderMode ? '请先选择模式。' : state.orderMode === 'single' ? '无需总配数；凹/all 请改为明确数量。' : '每个角色同一限额，优先保留前面的排位。';
    $('grayLegend').hidden = !sheet.grayCount;
    var invalid = result.settled.rows.filter(function (r) { return r.invalid; });
    $('previewWarn').innerHTML = (state.aliasConfirmed ? '' : '<div class="note warn">角色对照尚未确认。</div>') + (invalid.length ? '<details class="note warn"><summary>' + invalid.length + ' 条记录在凹/all 之后，未计入排表</summary>' + invalid.map(function (r) { return '<div>' + esc(r.cn) + ' · ' + esc(r.role) + '：' + esc(r.reason) + '</div>'; }).join('') + '</details>' : '');
    var points = sheet.chars.reduce(function (n, r) { return n + sheet.effectiveTotals[r]; }, 0);
    $('previewStat').textContent = sheet.chars.length + ' 个角色 · ' + sheet.cells.length + ' 行 · 有效 ' + points + ' 点' + (sheet.grayCount ? ' · 超出 ' + sheet.grayCount + ' 行' : '');
    $('liveStats').textContent = sheet.chars.length + ' 列 · ' + points + ' 点';
    $('confirmState').textContent = state.confirmed ? '已确认校对' : '修改后需确认校对';
    $('btnConfirmBatch').disabled = state.busy || state.ingesting || !state.records.length;
    $('btnExportFinal').disabled = !state.confirmed || exportBusy || state.busy;
    $('btnToShenbiao').disabled = !state.confirmed || exportBusy || state.busy;
    $('btnResetDraft').disabled = state.busy || state.ingesting || exportBusy;
    $('fileName').disabled = $('renameBtn').disabled = state.busy || state.ingesting || exportBusy;
  }
  function renderAll() {
    renderQueue(); syncRoles();
    var show = !!state.records.length;
    $('cardEdit').hidden = !show; $('cardPreview').hidden = !show; $('liveToggle').hidden = !show;
    $('kindName').value = state.kindName; $('totalQuota').value = state.totalQuota; $('fileName').value = state.fileName;
    document.querySelectorAll('[name=orderMode]').forEach(function (r) { r.checked = r.value === state.orderMode; });
    renderEdit(); renderAlias(); renderPrices(); renderPreview(); setSource(state.sourceView || (state.queue[0] && state.queue[0].id));
  }
  async function image(url) { var img = new Image(); img.src = url; await img.decode(); return img; }
  function dataUrl(file) { return new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = reject; reader.readAsDataURL(file); }); }
  async function pick(files) {
    if (state.busy || state.ingesting) return;
    state.ingesting = true; renderQueue();
    var added = 0, duplicates = 0, attached = 0, errors = [];
    var sorted = Array.from(files).sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-CN', { numeric: true }); });
    try {
      if (!crypto.subtle) throw new Error('内容防重需要通过 localhost 或 HTTPS 访问。');
      for (var file of sorted) {
        if (!file.type.startsWith('image/')) { errors.push(file.name + ' 不是图片'); continue; }
        var url;
        try {
          var digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
          var hash = Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          var old = state.queue.find(function (q) { return q.hash === hash; });
          // 旧版草稿没有指纹；同名补选只能恢复对照，不自动追加已有评论。
          if (!old) old = state.queue.find(function (q) { return !q.hash && q.name === file.name; });
          if (old && old.url) { duplicates++; continue; }
          if (!old && state.queue.length >= 50) { errors.push('最多导入 50 张图片'); break; }
          url = URL.createObjectURL(file);
          var im = await image(url);
          var q = old || { id: hash, hash: hash, name: file.name, status: 'pending', count: 0 };
          q.hash = hash; q.url = url; q.width = im.naturalWidth; q.height = im.naturalHeight;
          var cached = state.queue.reduce(function (n, entry) { return n + (entry.dataUrl || '').length; }, 0);
          q.dataUrl = file.size * 1.4 + cached < CACHE_LIMIT ? await dataUrl(file) : '';
          if (old) attached++; else { state.queue.push(q); added++; }
        } catch (error) { if (url) URL.revokeObjectURL(url); errors.push(file.name + ' 无法读取'); }
      }
      if (added) { state.orderConfirmed = false; touch(true); }
      if (!state.sourceView && state.queue.length) state.sourceView = state.queue[0].id;
      $('queueNotice').textContent = [added ? '加入 ' + added + ' 张图片。' : '', attached ? '恢复 ' + attached + ' 张原图。' : '', duplicates ? '跳过 ' + duplicates + ' 张重复图片（按内容识别）。' : '', state.queue.some(function (q) { return q.height / q.width > 5 || q.height > 4000; }) ? '建议使用清晰分图，避免超长截图。' : '', errors.join('；')].join(' ');
    } catch (error) { toast(error.message, true); }
    finally { state.ingesting = false; $('imgInput').value = ''; saveDraft(); renderAll(); }
  }
  function progress(text, percent) { $('progress').style.display = 'block'; $('progressLabel').textContent = text; $('barFill').style.width = percent + '%'; }
  async function recognize() {
    if (state.busy || state.ingesting || !state.orderConfirmed) return;
    var list = state.queue.filter(function (q) { return q.status !== 'done' && q.url; });
    if (!list.length) return;
    state.busy = true; state.confirmed = false; renderQueue(); renderPreview();
    var failed = 0;
    try {
      progress('加载本地识别模型…', 0);
      await window.OcrEngine.load();
      for (var i = 0; i < list.length; i++) {
        var q = list[i]; q.status = 'working'; q.error = ''; renderQueue();
        try {
          var im = await image(q.url);
          var lines = await window.OcrEngine.recognize(im, { onProgress: function (p) { progress('识别 ' + (i + 1) + '/' + list.length + ' · ' + q.name, 100 * (i + (p.total ? p.done / p.total : 0)) / list.length); } });
          var canvas = document.createElement('canvas'); canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
          var ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(im, 0, 0);
          var grouped = window.OcrEngine.groupAlbumComments(lines, { imageData: ctx.getImageData(0, 0, canvas.width, canvas.height) });
          if (!grouped.length) throw new Error('未找到评论，请检查图片');
          grouped.forEach(function (r, n) { state.records.push(Object.assign({}, r, { id: q.id + ':' + n, sourceId: q.id, src: q.name, index: n, omit: false })); });
          q.count = grouped.length; q.status = 'done'; state.aliasConfirmed = false;
          sortRecords(); syncRoles(); saveDraft(); renderAll();
        } catch (error) { q.status = 'failed'; q.error = error.message || '识别失败'; failed++; saveDraft(); renderQueue(); }
      }
      progress(failed ? '已完成；' + failed + ' 张失败，可重试。' : '识别完成，请统一校对。', 100);
    } catch (error) { progress('模型加载失败，请重试。', 0); toast('本地模型加载失败：' + error.message, true); }
    finally { state.busy = false; saveDraft(); renderAll(); }
  }
  function guard() {
    var message = '';
    if (state.busy || state.ingesting) message = '请等待图片处理完成';
    else if (!state.orderConfirmed) message = '请先确认图片顺序';
    else if (state.queue.some(function (q) { return q.status !== 'done'; })) message = '请识别全部图片，或移除不需要的图片';
    else if (!state.orderMode) message = '请先选择单领模式或配比模式';
    else if (state.orderMode === 'ratio' && (!Number.isInteger(Number(state.totalQuota)) || Number(state.totalQuota) <= 0)) message = '总配数必须是正整数';
    else if (!state.kindName.trim()) message = '请填写品类名';
    else if (active().some(function (r) { return issues(r).length; })) message = '仍有待核对评论，请补齐或勾选忽略';
    else if (!state.aliasConfirmed) { message = '请确认角色对照'; $('aliasDetails').open = true; }
    else if (!current().sheet.cells.length) message = '没有可导出的排表数据';
    else if (state.canon.some(function (r) { var v = state.prices[r]; return v !== '' && v != null && (!Number.isFinite(Number(v)) || Number(v) < 0); })) message = '单价须为非负数，或留空';
    if (message) { toast(message, true); return false; }
    return true;
  }
  function chooseGray(sheet) {
    if (!sheet.grayCount) return Promise.resolve('keep');
    $('exportMessage').textContent = '底部 ' + sheet.grayCount + ' 行超过总配数。删除后仅导出有效排位；保留则导出全部排位并标灰。';
    return new Promise(function (resolve) { choiceResolve = resolve; $('exportDialog').showModal(); });
  }
  function closeChoice(value) { var resolve = choiceResolve; choiceResolve = null; $('exportDialog').close(); if (resolve) resolve(value); }
  async function output(handoff) {
    if (exportBusy || !state.confirmed || !guard()) return;
    exportBusy = true; renderQueue(); renderPreview();
    try {
      var sheet = current().sheet, choice = await chooseGray(sheet);
      if (!choice) return;
      var presentation = sheetPresentation(sheet, choice === 'remove'), matrix = presentation.matrix;
      var wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('排表'); ws.addRows(matrix);
      ws.columns = presentation.columns.map(function (c) { return { width: c.width }; });
      ws.eachRow(function (row, n) {
        var style = presentation.rows[n - 1]; row.height = style.height;
        for (var c = 1; c <= sheet.chars.length + 1; c++) {
          var cell = row.getCell(c);
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          cell.font = { name: SHEET_STYLE.font, size: style.size, bold: style.bold, color: { argb: 'FF' + style.color } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + style.background } };
          var border = { style: 'thin', color: { argb: 'FF' + SHEET_STYLE.rule } };
          cell.border = { top: border, bottom: border, left: border, right: border };
        }
      });
      ws.views = [{ state: 'frozen', ySplit: 3, xSplit: 1 }];
      var bytes = await wb.xlsx.writeBuffer();
      var name = exportName() + '.xlsx';
      if (handoff) {
        var u8 = new Uint8Array(bytes), chunks = [];
        for (var i = 0; i < u8.length; i += 8192) chunks.push(String.fromCharCode.apply(null, u8.subarray(i, i + 8192)));
        sessionStorage.setItem('renshet_ocr_handoff', JSON.stringify({ b64: btoa(chunks.join('')), name: name, from: 'ocr' }));
        saveDraft(); location.href = 'shenbiao.html?from=ocr';
      } else {
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000); toast('排表已导出');
      }
    } catch (error) { toast('导出失败：' + error.message, true); }
    finally { exportBusy = false; renderQueue(); renderPreview(); }
  }
  function showLive(open) { state.liveOpen = open; $('livePanel').style.display = open ? 'flex' : 'none'; if (open) raiseWindow($('livePanel')); $('liveToggleText').textContent = open ? '收起实时排表' : '实时排表'; }
  function closeImageWindow(view) {
    if (view.cancelGesture) view.cancelGesture();
    view.image.onload = null; view.image.removeAttribute('src');
    view.panel.remove(); imageWindows.delete(view.id);
  }
  function constrainImageWindow(view) {
    var panel = view.panel, rect = panel.getBoundingClientRect();
    var width = Math.min(rect.width, innerWidth - 16), height = Math.min(view.height, innerHeight - 16);
    panel.style.width = width + 'px'; view.height = height;
    if (!view.collapsed) panel.style.height = height + 'px';
    panel.style.left = Math.max(8, Math.min(innerWidth - width - 8, rect.left)) + 'px';
    panel.style.top = Math.max(8, Math.min(innerHeight - (view.collapsed ? panel.offsetHeight : height) - 8, rect.top)) + 'px';
  }
  function imageFitScale(view) { return Math.min(1, Math.max(1, view.scroll.clientWidth) / view.image.naturalWidth); }
  function setImageScale(view, scale, anchor) {
    if (!view.image.naturalWidth || !view.scroll.clientWidth) return;
    var scroll = view.scroll, old = view.scale || 1;
    var x = anchor ? anchor.x : scroll.clientWidth / 2, y = anchor ? anchor.y : scroll.clientHeight / 2;
    var pointX = (scroll.scrollLeft + x) / old, pointY = (scroll.scrollTop + y) / old;
    view.scale = Math.max(Math.min(.1, imageFitScale(view)), Math.min(4, scale));
    view.image.style.width = view.image.naturalWidth * view.scale + 'px';
    view.panel.querySelector('.iv-scale').textContent = Math.round(view.scale * 100) + '%';
    view.panel.querySelector('[data-action="out"]').disabled = view.scale <= Math.min(.1, imageFitScale(view)) + .00001;
    view.panel.querySelector('[data-action="in"]').disabled = view.scale >= 4;
    scroll.scrollLeft = pointX * view.scale - x; scroll.scrollTop = pointY * view.scale - y;
  }
  function fitImage(view) { view.fit = true; setImageScale(view, imageFitScale(view)); }
  function collapseImageWindow(view, collapsed) {
    view.collapsed = collapsed; view.panel.classList.toggle('collapsed', collapsed);
    view.panel.style.height = collapsed ? 'auto' : view.height + 'px';
    var button = view.panel.querySelector('[data-action="collapse"]');
    button.textContent = collapsed ? '展开' : '收起'; button.setAttribute('aria-expanded', String(!collapsed));
    constrainImageWindow(view);
    if (!collapsed && view.fit) fitImage(view);
  }
  function imageWindowGesture(view, handle, resize) {
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('button') || (resize && view.collapsed)) return;
      if (view.cancelGesture) view.cancelGesture();
      var rect = view.panel.getBoundingClientRect(), pointer = e.pointerId, startX = e.clientX, startY = e.clientY;
      handle.setPointerCapture(pointer); e.preventDefault(); raiseWindow(view.panel);
      function move(ev) {
        if (ev.pointerId !== pointer) return;
        if (resize) {
          var width = Math.max(Math.min(280, innerWidth - 16), Math.min(innerWidth - rect.left - 8, rect.width + ev.clientX - startX));
          view.height = Math.max(Math.min(180, innerHeight - 16), Math.min(innerHeight - rect.top - 8, rect.height + ev.clientY - startY));
          view.panel.style.width = width + 'px'; view.panel.style.height = view.height + 'px';
          constrainImageWindow(view); if (view.fit) fitImage(view);
        } else {
          view.panel.style.left = Math.max(8, Math.min(innerWidth - rect.width - 8, rect.left + ev.clientX - startX)) + 'px';
          view.panel.style.top = Math.max(8, Math.min(innerHeight - rect.height - 8, rect.top + ev.clientY - startY)) + 'px';
        }
      }
      function end(ev) {
        if (ev && ev.pointerId !== pointer) return;
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end); handle.removeEventListener('lostpointercapture', end);
        if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
        view.cancelGesture = null;
      }
      view.cancelGesture = end;
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end); handle.addEventListener('lostpointercapture', end);
    });
  }
  function openSourceWindow() {
    var q = state.queue.find(function (v) { return v.id === state.sourceView; });
    if (!q || !q.url || $('sourceImage').hidden) return;
    var existing = imageWindows.get(q.id);
    if (existing) { collapseImageWindow(existing, false); raiseWindow(existing.panel); existing.panel.focus({ preventScroll: true }); return; }
    var panel = document.createElement('section'), titleId = 'image-window-title-' + ++imageWindowSerial;
    panel.className = 'image-window'; panel.dataset.imageId = q.id; panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-labelledby', titleId);
    panel.innerHTML = '<header class="iv-head"><span class="iv-title" id="' + titleId + '"></span><div class="iv-actions"><button type="button" data-action="collapse" aria-expanded="true">收起</button><button type="button" data-action="close" aria-label="关闭原图悬浮窗">&times;</button></div></header><div class="iv-tools"><button type="button" data-action="out" aria-label="缩小图片" title="缩小图片">−</button><output class="iv-scale" aria-live="polite"></output><button type="button" data-action="in" aria-label="放大图片" title="放大图片">+</button><button type="button" data-action="fit">适应宽度</button><button type="button" data-action="actual">原尺寸</button></div><div class="iv-scroll"><img draggable="false" alt=""></div><footer class="iv-foot">拖动标题移动 · 右下角调整大小</footer><span class="iv-resize" title="拖动调整窗口大小" aria-hidden="true"></span>';
    panel.querySelector('.iv-title').textContent = q.name; panel.querySelector('.iv-title').title = q.name;
    var view = { id: q.id, panel: panel, image: panel.querySelector('img'), scroll: panel.querySelector('.iv-scroll'), scale: 1, fit: true, collapsed: false, height: Math.min(560, innerHeight - 32) };
    view.image.alt = q.name + ' 原图';
    var offset = imageWindows.size % 6 * 26, width = Math.min(480, innerWidth - 24);
    panel.style.width = width + 'px'; panel.style.height = view.height + 'px';
    panel.style.left = Math.max(12, Math.min(innerWidth - width - 12, 36 + offset)) + 'px';
    panel.style.top = Math.max(12, Math.min(innerHeight - view.height - 12, 48 + offset)) + 'px';
    imageWindows.set(q.id, view); document.body.appendChild(panel); raiseWindow(panel);
    panel.addEventListener('pointerdown', function () { raiseWindow(panel); });
    panel.addEventListener('focusin', function () { raiseWindow(panel); });
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImageWindow(view); $('sourceImage').focus({ preventScroll: true }); }
    });
    panel.addEventListener('click', function (e) {
      var button = e.target.closest('[data-action]'); if (!button || button.disabled) return;
      switch (button.dataset.action) {
        case 'close': closeImageWindow(view); if (state.sourceView === view.id) $('sourceImage').focus({ preventScroll: true }); break;
        case 'collapse': collapseImageWindow(view, !view.collapsed); break;
        case 'fit': fitImage(view); break;
        case 'actual': view.fit = false; setImageScale(view, 1); break;
        case 'in': case 'out': view.fit = false; setImageScale(view, view.scale * (button.dataset.action === 'in' ? 1.25 : .8)); break;
      }
    });
    view.scroll.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault(); view.fit = false; var rect = view.scroll.getBoundingClientRect();
      setImageScale(view, view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });
    imageWindowGesture(view, panel.querySelector('.iv-head'), false);
    imageWindowGesture(view, panel.querySelector('.iv-resize'), true);
    var sourceImage = $('sourceImage'), sourceWidth = sourceImage.clientWidth;
    var sourceY = sourceWidth && q.width ? $('sourceScroll').scrollTop * q.width / sourceWidth : 0;
    view.image.onload = function () {
      if (!imageWindows.has(view.id)) return;
      fitImage(view); view.scroll.scrollTop = sourceY * view.scale; view.image.onload = null;
    };
    view.image.src = q.url; panel.focus({ preventScroll: true });
  }
  window.addEventListener('resize', function () {
    imageWindows.forEach(function (view) { constrainImageWindow(view); if (!view.collapsed && view.fit) fitImage(view); });
  });
  $('dropZone').onclick = function () { if (!state.busy && !state.ingesting) $('imgInput').click(); };
  $('dropZone').onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('dropZone').click(); } };
  $('imgInput').onchange = function (e) { pick(e.target.files); };
  ['dragover', 'dragleave', 'drop'].forEach(function (event) { $('dropZone').addEventListener(event, function (e) {
    e.preventDefault(); $('dropZone').classList.toggle('drag-over', event === 'dragover'); if (event === 'drop') pick(e.dataTransfer.files);
  }); });
  function commitQueueOrder(ids) {
    if (state.busy || state.ingesting || exportBusy || ids.length !== state.queue.length || new Set(ids).size !== ids.length) return;
    var byId = new Map(state.queue.map(function (q) { return [q.id, q]; }));
    if (ids.some(function (id) { return !byId.has(id); }) || ids.every(function (id, i) { return id === state.queue[i].id; })) return;
    state.queue = ids.map(function (id) { return byId.get(id); });
    sortRecords(); state.orderConfirmed = false; touch(); saveDraft(); renderAll(); toast('图片顺序已调整，请重新确认');
  }
  function moveQueueCard(target, x, y) {
    if (!queueDrag || !target || target.dataset.image === queueDrag.id) return;
    var list = $('imageQueue'), dragged = Array.from(list.children).find(function (el) { return el.dataset.image === queueDrag.id; });
    if (!dragged || !list.contains(target)) return;
    var rect = target.getBoundingClientRect(), origin = dragged.getBoundingClientRect();
    var before = Math.abs(origin.top - rect.top) < 12 ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2;
    list.insertBefore(dragged, before ? target : target.nextElementSibling);
    // 卡片移动 DOM 后，重新捕获触点，避免手指离开列表时丢失移动或松手事件。
    if (queueDrag.pointerId != null) queueDrag.capture.setPointerCapture(queueDrag.pointerId);
  }
  function finishQueueDrag(cancel) {
    if (!queueDrag) return;
    stopQueueScroll();
    var ids = Array.from($('imageQueue').children).map(function (el) { el.classList.remove('dragging'); return el.dataset.image; });
    queueDrag = null;
    if (cancel) renderQueue(); else commitQueueOrder(ids);
  }
  function stopQueueScroll() { if (queueScrollFrame != null) cancelAnimationFrame(queueScrollFrame); queueScrollFrame = null; }
  function queueTouchScroll() {
    if (queueScrollFrame != null) return;
    function tick() {
      queueScrollFrame = null;
      if (!queueDrag || queueDrag.pointerId == null || !queueDrag.moved) return;
      var y = queueDrag.currentY, edge = 75;
      var direction = y < edge ? -1 : y > innerHeight - edge ? 1 : 0;
      if (direction) {
        var depth = direction < 0 ? (edge - y) / edge : (y - innerHeight + edge) / edge;
        window.scrollBy(0, direction * Math.max(3, Math.min(16, Math.ceil(depth * 16))));
        var at = document.elementFromPoint(queueDrag.currentX, y);
        moveQueueCard(at && at.closest('[data-image]'), queueDrag.currentX, y);
      }
      queueScrollFrame = requestAnimationFrame(tick);
    }
    queueScrollFrame = requestAnimationFrame(tick);
  }
  $('imageQueue').addEventListener('dragstart', function (e) {
    var card = e.target.closest('[data-image]');
    if (!card || state.busy || state.ingesting || exportBusy || queueDrag) { e.preventDefault(); return; }
    queueDrag = { id: card.dataset.image }; card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.dataset.image);
  });
  $('imageQueue').addEventListener('dragover', function (e) {
    if (!queueDrag || queueDrag.pointerId != null) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; moveQueueCard(e.target.closest('[data-image]'), e.clientX, e.clientY);
  });
  $('imageQueue').addEventListener('drop', function (e) { if (queueDrag) { e.preventDefault(); finishQueueDrag(false); } });
  $('imageQueue').addEventListener('dragend', function () { finishQueueDrag(false); });
  $('imageQueue').addEventListener('pointerdown', function (e) {
    var grip = e.target.closest('[data-grip]');
    if (e.pointerType === 'mouse' || !grip || grip.disabled || queueDrag) return;
    queueDrag = { id: grip.dataset.grip, pointerId: e.pointerId, capture: grip, x: e.clientX, y: e.clientY, moved: false };
    grip.setPointerCapture(e.pointerId);
  });
  $('imageQueue').addEventListener('pointermove', function (e) {
    if (!queueDrag || queueDrag.pointerId !== e.pointerId) return;
    if (!queueDrag.moved && Math.hypot(e.clientX - queueDrag.x, e.clientY - queueDrag.y) < 6) return;
    queueDrag.moved = true; queueDrag.currentX = e.clientX; queueDrag.currentY = e.clientY; e.preventDefault(); queueTouchScroll();
    var card = Array.from($('imageQueue').children).find(function (el) { return el.dataset.image === queueDrag.id; });
    card.classList.add('dragging');
    var at = document.elementFromPoint(e.clientX, e.clientY); moveQueueCard(at && at.closest('[data-image]'), e.clientX, e.clientY);
  });
  $('imageQueue').addEventListener('pointerup', function (e) { if (queueDrag && queueDrag.pointerId === e.pointerId) finishQueueDrag(false); });
  $('imageQueue').addEventListener('pointercancel', function (e) { if (queueDrag && queueDrag.pointerId === e.pointerId) finishQueueDrag(true); });
  $('imageQueue').addEventListener('keydown', function (e) {
    var grip = e.target.closest('[data-grip]'); if (!grip || grip.disabled || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault(); var ids = state.queue.map(function (q) { return q.id; }), i = ids.indexOf(grip.dataset.grip), j = i + (e.key === 'ArrowLeft' ? -1 : 1);
    if (j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]); commitQueueOrder(ids);
    Array.from($('imageQueue').querySelectorAll('[data-grip]')).find(function (el) { return el.dataset.grip === grip.dataset.grip; }).focus();
  });
  $('imageQueue').onclick = function (e) {
    var b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.view) { setSource(b.dataset.view); return; }
    if (state.busy || state.ingesting || exportBusy) return;
    if (b.dataset.remove) {
      var target = state.queue.find(function (q) { return q.id === b.dataset.remove; });
      if (target.status === 'done' && !window.confirm('移除此图片及其 ' + target.count + ' 条评论？')) return;
      if (imageWindows.has(target.id)) closeImageWindow(imageWindows.get(target.id));
      if (target.url && target.url.startsWith('blob:')) URL.revokeObjectURL(target.url);
      state.queue = state.queue.filter(function (q) { return q !== target; }); state.records = state.records.filter(function (r) { return r.sourceId !== target.id; });
      state.orderConfirmed = false; touch(true); saveDraft(); renderAll();
    }
  };
  $('btnConfirmOrder').onclick = function () { if (state.busy || state.ingesting) return; state.orderConfirmed = true; saveDraft(); renderQueue(); toast('图片顺序已确认'); };
  $('btnRecognize').onclick = recognize;
  $('btnResetDraft').onclick = resetDraft;
  $('sourceFilter').onchange = function (e) { state.sourceFilter = e.target.value; if (state.sourceFilter !== 'all') setSource(state.sourceFilter); renderEdit(); };
  $('onlyIssues').onchange = renderEdit;
  $('editTable').onclick = function (e) {
    selectRecord(e.target.closest('[data-id]'));
    var source = e.target.closest('[data-source]'); if (source) setSource(source.dataset.source, Number(source.dataset.y));
    var keep = e.target.closest('[data-keepduplicate]'); if (keep) { var r = state.records.find(function (v) { return v.id === keep.dataset.keepduplicate; }); r.duplicateReviewed = true; touch(); renderEdit(); renderPreview(); }
  };
  $('editTable').addEventListener('focusin', function (e) { var tr = e.target.closest('[data-id]'); if (tr) { selectRecord(tr); var r = state.records.find(function (v) { return v.id === tr.dataset.id; }); setSource(r.sourceId, r.y); if (innerWidth <= 700) showLive(false); } });
  $('editTable').oninput = function (e) {
    var tr = e.target.closest('[data-id]'), f = e.target.dataset.f; if (!tr || !f) return;
    var r = state.records.find(function (v) { return v.id === tr.dataset.id; });
    r[f] = f === 'body' ? e.target.value.split('\n').filter(function (s) { return s.trim(); }) : f === 'omit' ? e.target.checked : e.target.value;
    markOverlaps(); touch(); tr.classList.toggle('pending', !!issues(r).length); tr.classList.toggle('omitted', !!r.omit); tr.querySelector('.record-issue').innerHTML = issueHtml(r);
    $('editTable').querySelectorAll('tr[data-id]').forEach(function (row) { var record = state.records.find(function (v) { return v.id === row.dataset.id; }); row.querySelector('.record-issue').innerHTML = issueHtml(record); row.classList.toggle('pending', !!issues(record).length); });
    renderEditHint();
    renderAlias(); renderPrices(); renderPreview();
  };
  $('btnAddRecord').onclick = function () {
    if (state.busy || state.ingesting || exportBusy) return;
    var i = state.records.findIndex(function (r) { return r.id === state.selectedRecordId; });
    if (i < 0) { toast('请先选中一条评论', true); return; }
    var anchor = state.records[i], record = { id: 'manual-' + crypto.randomUUID(), cn: '', body: [], sourceId: anchor.sourceId, src: '手动', y: anchor.y };
    state.records.splice(i + 1, 0, record);
    var index = 0; state.records.forEach(function (r) { if (r.sourceId === anchor.sourceId) r.index = index++; });
    state.selectedRecordId = record.id; touch(true); markOverlaps(); saveDraft(); renderAll();
    var row = Array.from($('editTable').querySelectorAll('[data-id]')).find(function (tr) { return tr.dataset.id === record.id; });
    if (row) row.querySelector('[data-f=cn]').focus();
  };
  $('aliasTable').oninput = function (e) { if (e.target.dataset.raw) { var before = Object.assign({}, state.aliases); state.aliases[e.target.dataset.raw] = e.target.value.trim(); syncRoles(before); touch(true); renderPrices(); renderPreview(); $('aliasSummary').textContent = '角色对照 · 待确认'; } };
  $('aliasTable').onclick = function (e) { var b = e.target.closest('[data-ignore]'); if (b) { state.ignored[b.dataset.ignore] = true; touch(true); renderAll(); } };
  $('ignoredBox').onclick = function (e) { var b = e.target.closest('[data-restore]'); if (b) { delete state.ignored[b.dataset.restore]; touch(true); renderAll(); } };
  $('btnAliasAdd').onclick = function () { var raw = $('aliasNewRaw').value.trim(), name = $('aliasNewCanon').value.trim(); if (!raw || !name) { toast('请填写原称呼与归属角色', true); return; } var old = Object.assign({}, state.aliases); delete state.ignored[raw]; state.aliases[raw] = name; syncRoles(old); touch(true); $('aliasNewRaw').value = ''; $('aliasNewCanon').value = ''; renderAll(); };
  $('btnAliasAuto').onclick = function () { var before = Object.assign({}, state.aliases); Object.assign(state.aliases, P.suggestAliasMap(rawRoles())); syncRoles(before); touch(true); renderAll(); };
  $('btnAliasClear').onclick = function () { state.aliases = Object.create(null); state.ignored = Object.create(null); touch(true); renderAll(); };
  $('btnAliasConfirm').onclick = function () {
    if (Array.from($('aliasTable').querySelectorAll('[data-raw]')).some(function (el) { return !el.value.trim(); })) { toast('归属角色不能为空', true); return; }
    syncRoles(); state.aliasConfirmed = true; state.confirmed = false;
    try { localStorage.setItem(LS_ALIAS, JSON.stringify(state.aliases)); localStorage.setItem(LS_IGNORE, JSON.stringify(state.ignored)); } catch (_) { toast('浏览器未允许保存对照，下次需重新填写', true); }
    saveDraft(); renderAlias(); renderPreview();
  };
  document.querySelectorAll('[name=orderMode]').forEach(function (radio) { radio.onchange = function () { state.orderMode = radio.value; touch(); renderEdit(); renderPreview(); }; });
  $('kindName').oninput = function (e) { state.kindName = e.target.value; touch(); renderPreview(); };
  $('totalQuota').oninput = function (e) { state.totalQuota = e.target.value; touch(); renderPreview(); };
  $('priceBox').oninput = function (e) { if (e.target.dataset.price) { state.prices[e.target.dataset.price] = e.target.value; touch(); renderPreview(); } };
  $('fileName').oninput = function (e) { state.fileName = e.target.value; touch(); renderPreview(); };
  $('renameBtn').onclick = function () {
    if (state.busy || state.ingesting || exportBusy) return;
    if (!state.fileName.trim()) { toast('请填写文件名称', true); $('fileName').focus(); return; }
    state.fileName = exportName(); $('fileName').value = state.fileName; touch(); saveDraft(); renderPreview(); toast('文件名称已更新');
  };
  $('colorSwatches').onclick = function (e) {
    var b = e.target.closest('[data-theme]'); if (!b || b.disabled || state.theme === b.dataset.theme) return;
    state.theme = b.dataset.theme; touch(); saveDraft(); renderPreview();
  };
  function reorderColumn(e) { var b = e.target.closest('[data-col]'); if (!b || b.disabled) return; var i = Number(b.dataset.col), j = i + Number(b.dataset.dir); if (j < 0 || j >= state.canon.length) return; var role = state.canon.splice(i, 1)[0]; state.canon.splice(j, 0, role); touch(); renderPrices(); renderPreview(); }
  $('columnOrder').onclick = reorderColumn;
  $('btnConfirmBatch').onclick = function () { if (!guard()) return; state.confirmed = true; saveDraft(); renderPreview(); toast('校对已确认，可导出'); };
  $('btnExportFinal').onclick = function () { output(false); }; $('btnToShenbiao').onclick = function () { output(true); };
  $('exportRemove').onclick = function () { closeChoice('remove'); }; $('exportKeep').onclick = function () { closeChoice('keep'); }; $('exportCancel').onclick = function () { closeChoice(null); };
  $('exportDialog').oncancel = function (e) { e.preventDefault(); closeChoice(null); };
  $('sourceImage').onclick = openSourceWindow;
  $('sourceImage').onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSourceWindow(); } };
  $('livePanel').addEventListener('pointerdown', function () { raiseWindow($('livePanel')); });
  $('livePanel').addEventListener('focusin', function () { raiseWindow($('livePanel')); });
  $('btnOpenLive').onclick = function () { $('btnOpenLive').focus(); showLive(true); }; $('liveToggle').onclick = function () { $('liveToggle').focus(); showLive(!state.liveOpen); }; $('liveClose').onclick = function () { showLive(false); };
  $('liveGo').onclick = function () { showLive(false); $('cardPreview').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  function movable(handle, resize) {
    handle.onpointerdown = function (e) {
      if (innerWidth <= 700 || e.target.closest('button')) return;
      var panel = $('livePanel'), rect = panel.getBoundingClientRect(), x = e.clientX, y = e.clientY;
      handle.setPointerCapture(e.pointerId); e.preventDefault();
      function move(ev) {
        if (resize) { panel.style.width = Math.min(innerWidth - 24, Math.max(340, rect.width + ev.clientX - x)) + 'px'; panel.style.height = Math.min(innerHeight - 32, Math.max(200, rect.height + ev.clientY - y)) + 'px'; }
        else { panel.style.left = Math.max(0, Math.min(innerWidth - rect.width, rect.left + ev.clientX - x)) + 'px'; panel.style.top = Math.max(0, Math.min(innerHeight - rect.height, rect.top + ev.clientY - y)) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; }
      }
      function end() { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); }
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    };
  }
  movable($('liveHead'), false); movable($('liveResize'), true);
  window.addEventListener('pagehide', saveDraft);
  if (location.protocol === 'file:') { $('protoWarn').hidden = false; $('dropZone').setAttribute('aria-disabled', 'true'); }
  restore(); renderAll();
})();
