/*!
 * comment-parse.js — 相册评论 → 结构化 → 排表
 *
 * 负责三件"业务"上的事（识别本身不在这里）：
 *   1) 把评论正文切成「角色 + 数量」token
 *   2) 别名归一：桐 = 桐生 = 同一个人（用户确认的映射，持久复用）
 *   3) 凹/all 结算：吃满该角色剩余配数，之后的同角色记录作废
 */
(function (global) {
  'use strict';

  /* ---------------- 1. 正文 → token ---------------- */

  var QUANT = '(\\d{1,3}|凹|[aA][lL]{2}|全|all)';
  var PAIR = new RegExp('([\\u4e00-\\u9fff\\u3400-\\u4dbfA-Za-z][\\u4e00-\\u9fff\\u3400-\\u4dbfA-Za-z·]*?)' + QUANT, 'g');
  var ALL_RE = /^(凹|[aA][lL]{2}|全|all)$/;

  /** 判断一个 token 是不是"包满"标记 */
  function isAll(q) { return ALL_RE.test(q); }

  /**
   * 尝试把正文里与昵称重复的前缀剥掉（"好困(梅宫大河)" 的评论 "好困 大河凹"）
   */
  function stripCnPrefix(body, cn) {
    if (!cn) return body;
    var clean = String(cn).replace(/[（(].*?[)）]/g, '').trim();
    var b = body.replace(/\s+/g, '');
    if (clean && b.indexOf(clean) === 0) return b.slice(clean.length);
    // 昵称带括号时，括号里的内容也可能被写进正文
    var inner = (String(cn).match(/[（(](.*?)[)）]/) || [])[1];
    if (inner) {
      var parts = inner.split(/[\s\/、,，]+/).filter(Boolean);
      for (var i = 0; i < parts.length; i++) {
        if (b.indexOf(parts[i]) === 0) { b = b.slice(parts[i].length); break; }
      }
    }
    return b;
  }

  /**
   * 从评论正文里抽出 {角色原文, 数量}
   * @returns {Array} [{raw, qty, all}]
   */
  function tokenizeBody(body, cn) {
    var text = stripCnPrefix(String(body || ''), cn);
    var out = [];
    PAIR.lastIndex = 0;
    var m;
    while ((m = PAIR.exec(text)) !== null) {
      var raw = m[1], q = m[2];
      if (!raw) continue;
      if (isAll(q)) out.push({ raw: raw, qty: 0, all: true, source: m[0] });
      else out.push({ raw: raw, qty: parseInt(q, 10), all: false, source: m[0] });
    }
    return out;
  }

  /**
   * 收集"没见过的新称呼"（识别后立即给用户确认）
   * @param {Object} ignore 被用户"删除"（忽略）的称呼表 {raw:true}
   */
  function collectRawRoles(records, ignore) {
    var map = Object.create(null);
    var skip = ignore || {};
    (records || []).forEach(function (r) {
      var bodies = r.body && r.body.length ? r.body : [r.cn || ''];
      bodies.forEach(function (b) {
        tokenizeBody(b, r.cn).forEach(function (t) {
          var k = t.raw;
          if (skip[k]) return;
          if (!map[k]) map[k] = { raw: k, count: 0, all: 0 };
          map[k].count += t.all ? 0 : t.qty;
          if (t.all) map[k].all++;
        });
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return (b.count + b.all) - (a.count + a.all); });
  }

  /* ---------------- 2. 别名归一 ---------------- */

  /** aliasMap: { 称呼原文 -> 规范角色名 }；没登记的原样返回 */
  function canon(raw, aliasMap) {
    if (aliasMap && Object.prototype.hasOwnProperty.call(aliasMap, raw)) return aliasMap[raw];
    return raw;
  }

  /** 给一批称呼自动生成初版映射：同一"规范名"下最长的那个当正名 */
  function suggestAliasMap(rawRoles) {
    var group = Object.create(null);
    rawRoles.forEach(function (r) {
      var key = null;
      // 已有同组：一个是另一个的前缀 → 归为同一人（桐 / 桐生）
      Object.keys(group).forEach(function (g) {
        if (key) return;
        if (g.indexOf(r.raw) === 0 || r.raw.indexOf(g) === 0) key = g;
      });
      if (!key) { group[r.raw] = [r.raw]; return; }
      group[key].push(r.raw);
    });
    var map = Object.create(null);
    Object.keys(group).forEach(function (g) {
      var longest = group[g].slice().sort(function (a, b) { return b.length - a.length; })[0];
      group[g].forEach(function (n) { map[n] = longest; });
    });
    return map;
  }

  /* ---------------- 3. 凹/all 结算 ---------------- */

  /**
   * @param {Array} records 相册顺序 [{cn, body:[], date}]
   * @param {Object} opt {aliasMap, quotas:{角色:配数}, quotaMode:'unified'|'per', unifiedQuota}
   * @returns {{rows:[], roles:[], warnings:[]}}
   */
  function settle(records, opt) {
    opt = opt || {};
    var aliasMap = opt.aliasMap || {};
    var quotas = opt.quotas || {};
    var ignore = opt.ignore || {};
    var roles = [];                 // 角色出现顺序
    var perRole = Object.create(null);
    var rows = [];                  // 每人每角色一条：{cn, role, qty, all, invalid, reason, date}
    var warnings = [];
    var unparsed = [];              // 解析不出「角色+数量」的评论：必须让用户确认

    function quotaOf(role) {
      if (opt.orderMode === 'single') return null;
      var u = opt.totalQuota == null ? opt.unifiedQuota : opt.totalQuota;
      return Number.isInteger(Number(u)) && Number(u) > 0 ? Number(u) : null;
    }

    (records || []).forEach(function (rec) {
      if (rec.omit) return;
      var cn = rec.cn && rec.cn.trim() ? rec.cn.trim() : null;
      var bodies = rec.body && rec.body.length ? rec.body : [];
      bodies.forEach(function (b) {
        var toks = tokenizeBody(b, rec.cn).filter(function (t) { return !ignore[t.raw]; });
        if (!toks.length) {
          var slim = String(b).replace(/\s+/g, '');
          if (slim) unparsed.push({ cn: cn, text: slim, date: rec.date });
          return;
        }
        toks.forEach(function (t) {
          var role = canon(t.raw, aliasMap);
          if (!perRole[role]) { perRole[role] = { count: 0, closed: false, closedBy: null }; roles.push(role); }
          var st = perRole[role];
          var quota = quotaOf(role);

          if (st.closed) {
            rows.push({ cn: cn, role: role, qty: t.qty, all: t.all, invalid: true,
              reason: '该角色已被「' + st.closedBy + '」凹满，本条作废', date: rec.date });
            return;
          }
          if (t.all) {
            if (quota == null) {
              rows.push({ cn: cn, role: role, qty: 0, all: true, invalid: false, pending: true,
                reason: '凹/all 需要先填该角色的配数', date: rec.date });
              warnings.push('「' + role + '」出现 凹/all，但还没填配数，请先填配数');
              return;
            }
            var remain = Math.max(0, quota - st.count);
            st.count = Math.max(st.count, quota);
            st.closed = true;
            st.closedBy = cn || '某位';
            rows.push({ cn: cn, role: role, qty: remain, all: true, invalid: false, date: rec.date });
            return;
          }
          var before = st.count;
          st.count += t.qty;
          var over = quota != null && st.count > quota;
          rows.push({ cn: cn, role: role, qty: t.qty, all: false, invalid: false,
            over: over, date: rec.date });
          if (over) warnings.push('「' + role + '」已排 ' + st.count + ' 个，超过配数 ' + quota + '（' + (before ? '本条之前 ' + before + ' 个' : '') + '）');
        });
      });
    });

    return { rows: rows, roles: roles, perRole: perRole, warnings: warnings, unparsed: unparsed, quotas: quotas,
      limit: opt.orderMode === 'ratio' ? quotaOf('') : null };
  }

  /* ---------------- 4. 生成排表网格 ---------------- */

  /**
   * 每个角色一列，列内自上而下填充；同一个人同一列的点数占多行。
   * @returns {{chars:[], cells:[[cn|null, ...]], seq:[]}}
   */
  function buildSheet(settleResult, roleOrder) {
    var roles = roleOrder && roleOrder.length ? roleOrder.slice() : settleResult.roles.slice();
    var col = roles.map(function () { return []; });
    var idx = Object.create(null);
    roles.forEach(function (r, i) { idx[r] = i; });
    settleResult.rows.forEach(function (r) {
      if (r.invalid) return;
      var ci = idx[r.role];
      if (ci === undefined) return;      // 列里没有这个角色：跳过而不是崩
      for (var i = 0; i < r.qty; i++) col[ci].push(r.cn || '');
    });
    var rows = Math.max.apply(null, [0].concat(col.map(function (c) { return c.length; })));
    var cells = [];
    for (var y = 0; y < rows; y++) {
      cells.push(col.map(function (c) { return c[y] == null ? '' : c[y]; }));
    }
    var totals = Object.create(null);
    roles.forEach(function (r, i) { totals[r] = col[i].length; });
    var limit = settleResult.limit;
    var grayRows = cells.map(function (_, i) { return limit != null && i >= limit; });
    var effectiveTotals = Object.create(null);
    roles.forEach(function (r, i) { effectiveTotals[r] = cells.reduce(function (n, row, y) {
      return n + (!grayRows[y] && row[i] ? 1 : 0);
    }, 0); });
    return { chars: roles, cells: cells, totals: totals, effectiveTotals: effectiveTotals,
      grayRows: grayRows, grayCount: grayRows.filter(Boolean).length, total: rows };
  }

  /** 导出成站内标准排表数据（A 列序号；第2行角色；第3行单价留空） */
  function toSheetMatrix(sheet, kindName, priceOfRole, options) {
    var head = ['种类'].concat(sheet.chars);
    var price = ['序号/单价'].concat(sheet.chars.map(function (c) { return priceOfRole && priceOfRole[c] != null ? priceOfRole[c] : ''; }));
    var selected = sheet.cells.filter(function (_, i) { return !(options && options.removeGray && sheet.grayRows[i]); });
    var body = selected.map(function (row, i) { return [i + 1].concat(row); });
    return [[kindName || ''], head, price].concat(body);
  }

  global.CommentParse = {
    tokenizeBody: tokenizeBody,
    collectRawRoles: collectRawRoles,
    suggestAliasMap: suggestAliasMap,
    canon: canon,
    settle: settle,
    buildSheet: buildSheet,
    toSheetMatrix: toSheetMatrix,
    isAll: isAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
