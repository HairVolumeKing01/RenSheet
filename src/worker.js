// ============================================================
// RenSheet API — Cloudflare Worker
// 8 endpoints: verify, check-trial, consume-trial, get-code,
//              afdian-webhook, generate, codes, renew, revoke
// ============================================================

const CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 31 chars, no 0/O/1/I/l
const BLOCK_LEN = 4;
const RATE_LIMIT_WINDOW = 60;       // 60 seconds
const RATE_LIMIT_MAX = 5;           // max 5 admin requests per window

// --------------- helpers ---------------

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// MD5 (pure JS — WebCrypto has no MD5; required for Afdian API signing).
// Signing input is ASCII (token/params/ts/user_id), so utf-8 handling is trivial.
function md5(input) {
  let s = unescape(encodeURIComponent(input));
  const n = s.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= s.length; i += 64) {
    md5cycle(state, md5block(s.substring(i - 64, i)));
  }
  s = s.substring(i - 64);
  const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  let hex = '';
  for (i = 0; i < 4; i++) {
    hex += ((state[i] >>> 0) & 0xff).toString(16).padStart(2, '0')
      + (((state[i] >>> 8) & 0xff)).toString(16).padStart(2, '0')
      + (((state[i] >>> 16) & 0xff)).toString(16).padStart(2, '0')
      + (((state[i] >>> 24) & 0xff)).toString(16).padStart(2, '0');
  }
  return hex;
}

function md5cycle(state, k) {
  let a = state[0], b = state[1], c = state[2], d = state[3];
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const T = [];
  for (let t = 1; t <= 64; t++) {
    T[t - 1] = Math.floor(Math.abs(Math.sin(t)) * 4294967296);
  }
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
    else { f = c ^ (b | ~d); g = (7 * i) % 16; }
    const tmp = d;
    d = c;
    c = b;
    b = (b + md5Rotl((a + f + T[i] + k[g]) | 0, S[i])) | 0;
    a = tmp;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
}

function md5Rotl(x, n) {
  return (x << n) | (x >>> (32 - n));
}

function md5block(s) {
  const k = [];
  for (let i = 0; i < 16; i++) {
    k[i] = s.charCodeAt(i * 4) | (s.charCodeAt(i * 4 + 1) << 8) | (s.charCodeAt(i * 4 + 2) << 16) | (s.charCodeAt(i * 4 + 3) << 24);
  }
  return k;
}

// 反查爱发电订单 (开放 API): 真实存在 → {status, totalAmount, month}; 查无 → false; API 故障 → null
async function queryAfdianOrder(outTradeNo, env) {
  const ts = Math.floor(Date.now() / 1000);
  const params = JSON.stringify({ page: 1, out_trade_no: outTradeNo });
  const sign = md5(env.AFDIAN_TOKEN + 'params' + params + 'ts' + ts + 'user_id' + env.AFDIAN_USER_ID);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  let resp;
  try {
    resp = await fetch('https://ifdian.net/api/open/query-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: env.AFDIAN_USER_ID, params, ts, sign }),
      signal: ac.signal
    });
  } catch (e) {
    console.error('Afdian API fetch error:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await resp.json(); } catch (e) { return null; }
  if (data.ec !== 200) {
    console.error('Afdian API ec != 200:', data.ec, data.em);
    return null;
  }
  const list = (data.data && data.data.list) || [];
  const item = list.find(i => (i.order || i).out_trade_no === outTradeNo);
  if (!item) return false;
  const o = item.order || item;
  return {
    status: parseInt(o.status) || 0,
    totalAmount: parseFloat(o.total_amount) || 0,
    month: Math.max(1, parseInt(o.month) || 1)
  };
}

function randomChars(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < len; i++) s += CHARSET[arr[i] % 31];
  return s;
}

// Generate a single activation code with checksum
async function makeCode(salt) {
  const b1 = randomChars(BLOCK_LEN);
  const b2 = randomChars(BLOCK_LEN);
  const b3 = randomChars(BLOCK_LEN);
  const prefix = 'RENS-' + b1 + '-' + b2 + '-' + b3;
  const h = await sha256(prefix + salt);
  // First 15 bits of hash encoded as 4 base31 chars = checksum
  let val = parseInt(h.substring(0, 4), 16);
  let ck = '';
  for (let i = 0; i < BLOCK_LEN; i++) {
    ck = CHARSET[val % 31] + ck;
    val = Math.floor(val / 31);
  }
  return prefix + '-' + ck;
}

// Validate code format + checksum
async function validateCodeFormat(code, salt) {
  code = code.toUpperCase().trim();
  const re = /^RENS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
  if (!re.test(code)) return { valid: false, error: '格式不正确' };
  // re-derive checksum from first 3 blocks
  const parts = code.split('-');
  const prefix = parts[0] + '-' + parts[1] + '-' + parts[2] + '-' + parts[3];
  const h = await sha256(prefix + salt);
  let val = parseInt(h.substring(0, 4), 16);
  let expected = '';
  for (let i = 0; i < BLOCK_LEN; i++) {
    expected = CHARSET[val % 31] + expected;
    val = Math.floor(val / 31);
  }
  if (parts[4] !== expected) return { valid: false, error: '激活码校验失败' };
  return { valid: true, code };
}

// Get client IP from CF headers
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// ------ Admin rate limiter (simple in-memory per-IP) ------
const rateMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW * 1000) {
    rateMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;
  return true;
}

// ------ Auth check ------
function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  return token === env.ADMIN_SECRET;
}

// ============== MAIN ==============

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    try {
      // ---- Public endpoints ----
      if (path === '/api/verify' && request.method === 'POST') {
        const { code } = await request.json();
        if (!code) return json({ ok: false, error: 'missing_code' }, 400);

        const valid = await validateCodeFormat(code, env.CODE_SALT);
        if (!valid.valid) return json({ ok: false, error: valid.error });

        const row = await env.DB.prepare(
          'SELECT plan, status, expires_at, activated_at FROM activation_codes WHERE code = ?'
        ).bind(valid.code).first();

        if (!row) return json({ ok: false, error: 'invalid_code', message: '激活码不存在' });
        if (row.status === 'revoked') return json({ ok: false, error: 'revoked', message: '该激活码已被吊销' });

        const now = new Date().toISOString();
        if (now > row.expires_at) {
          await env.DB.prepare("UPDATE activation_codes SET status = 'expired' WHERE code = ?").bind(valid.code).run();
          return json({ ok: false, error: 'expired', expires_at: row.expires_at, message: '激活码已过期，请续费' });
        }

        // First-time activation: update status
        if (row.status === 'delivered' || row.status === 'unused') {
          await env.DB.prepare(
            "UPDATE activation_codes SET status = 'activated', activated_at = ? WHERE code = ?"
          ).bind(now, valid.code).run();
        } else if (!row.activated_at) {
          await env.DB.prepare(
            "UPDATE activation_codes SET activated_at = ? WHERE code = ?"
          ).bind(now, valid.code).run();
        }

        return json({ ok: true, plan: row.plan, expires_at: row.expires_at, message: '激活成功' });
      }

      if (path === '/api/check-trial' && request.method === 'POST') {
        const { tool, fp_hash } = await request.json();
        if (!tool || !fp_hash) return json({ ok: false, error: 'missing_params' }, 400);
        if (!['guoji'].includes(tool)) return json({ ok: false, error: 'invalid_tool' }, 400);

        const row = await env.DB.prepare(
          'SELECT remaining FROM trial_usage WHERE fp_hash = ? AND tool = ?'
        ).bind(fp_hash, tool).first();

        if (!row) {
          await env.DB.prepare(
            'INSERT INTO trial_usage (fp_hash, tool, remaining) VALUES (?, ?, 2)'
          ).bind(fp_hash, tool).run();
          return json({ ok: true, remaining: 2, message: 'trial_granted' });
        }

        if (row.remaining > 0) {
          return json({ ok: true, remaining: row.remaining });
        }
        return json({ ok: false, error: 'trial_used', message: '免费试用次数已用完，请激活后继续使用' });
      }

      if (path === '/api/consume-trial' && request.method === 'POST') {
        const { tool, fp_hash } = await request.json();
        if (!tool || !fp_hash) return json({ ok: false, error: 'missing_params' }, 400);
        if (!['guoji'].includes(tool)) return json({ ok: false, error: 'invalid_tool' }, 400);

        await env.DB.prepare(
          'UPDATE trial_usage SET remaining = MAX(0, remaining - 1) WHERE fp_hash = ? AND tool = ? AND remaining > 0'
        ).bind(fp_hash, tool).run();

        const row = await env.DB.prepare(
          'SELECT remaining FROM trial_usage WHERE fp_hash = ? AND tool = ?'
        ).bind(fp_hash, tool).first();

        return json({ ok: true, remaining: row ? row.remaining : 0 });
      }

      if (path === '/api/get-code' && request.method === 'GET') {
        const orderId = url.searchParams.get('order');
        if (!orderId) return json({ ok: false, error: 'missing_order' }, 400);
        // Rate-limit per IP — order number is the only credential for code lookup
        if (!checkRateLimit(getClientIP(request))) {
          return json({ ok: false, error: 'rate_limited', message: '请求过于频繁，请稍后再试' }, 429);
        }

        const row = await env.DB.prepare(
          'SELECT code, plan, expires_at, delivered_at FROM activation_codes WHERE delivered_to = ? ORDER BY delivered_at DESC LIMIT 1'
        ).bind(orderId).first();

        if (!row) return json({ ok: false, error: 'order_not_found', message: '未找到该订单对应的激活码，请确认付款成功或联系客服' });
        return json({ ok: true, code: row.code, plan: row.plan, expires_at: row.expires_at });
      }

      if (path === '/api/afdian-webhook' && request.method === 'POST') {
        const body = await request.json();

        // Validate it looks like a real Afdian webhook
        if (!body?.data?.order) {
          return json({ ec: 400, em: 'invalid payload' });
        }

        // The webhook payload itself is NOT trustworthy (Afdian has no verifiable
        // webhook signature). It only triggers a lookup — the order is verified
        // against the Afdian open API using the real API token.
        const outTradeNo = (body.data.order.out_trade_no || '').toString();
        if (!outTradeNo) {
          return json({ ec: 400, em: 'missing out_trade_no' });
        }

        if (!env.AFDIAN_USER_ID || !env.AFDIAN_TOKEN) {
          console.error('AFDIAN_USER_ID/AFDIAN_TOKEN not configured — webhook rejected');
          return json({ ec: 500, em: 'afdian api credentials not configured' });
        }

        const verified = await queryAfdianOrder(outTradeNo, env);
        if (verified === null) {
          // API unreachable — reject so Afdian retries; codes are never lost
          return json({ ec: 500, em: 'afdian api unavailable' });
        }
        if (verified === false) {
          // Order does not exist in Afdian → forged webhook
          return json({ ec: 400, em: 'order verification failed' });
        }

        // Only process successful payments (status=2)
        if (verified.status !== 2) {
          return json({ ec: 200, em: 'skipped, status not 2' });
        }

        // Plan from API-verified amount & months: >=¥25 yearly, else monthly × N.
        // Month count comes from the API response, not the (spoofable) webhook.
        let plan = 'monthly';
        let durationDays = verified.month * 30;
        if (verified.totalAmount >= 25) {
          plan = 'yearly';
          durationDays = 365;
        }

        // Idempotency: this order already delivered → return success without
        // consuming another code (Afdian retries webhooks; replays must be safe).
        const existing = await env.DB.prepare(
          "SELECT code FROM activation_codes WHERE delivered_to = ? LIMIT 1"
        ).bind(outTradeNo).first();
        if (existing) {
          return json({ ec: 200, em: '' });
        }

        // Find any unused code — expiry gets set at delivery time
        const codeRow = await env.DB.prepare(
          "SELECT code FROM activation_codes WHERE status = 'unused' ORDER BY created_at ASC LIMIT 1"
        ).first();

        if (!codeRow) {
          return json({ ec: 200, em: 'no codes available' });
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + durationDays * 86400000).toISOString();

        // Assign code + override plan & expiry based on actual purchase.
        // delivered_to UNIQUE index backstops concurrent duplicate deliveries.
        try {
          await env.DB.prepare(
            "UPDATE activation_codes SET status = 'delivered', plan = ?, expires_at = ?, delivered_to = ?, delivered_at = ? WHERE code = ?"
          ).bind(plan, expiresAt, outTradeNo, now.toISOString(), codeRow.code).run();
        } catch (e) {
          // UNIQUE violation → another delivery of this order won the race; idempotent success
          if (String(e.message || e).includes('UNIQUE')) {
            return json({ ec: 200, em: '' });
          }
          throw e;
        }

        // Afdian REQUIRES this exact response format — anything else is treated as failure
        return json({ ec: 200, em: '' });
      }

      // ---- Admin endpoints (require Bearer token) ----
      const ip = getClientIP(request);
      if (!checkRateLimit(ip)) {
        return json({ ok: false, error: 'rate_limited', message: '请求过于频繁，请稍后再试' }, 429);
      }

      if (path === '/api/generate' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);

        const { count, plan, batch_label, expires_at } = await request.json();
        if (!count || count < 1 || count > 100) return json({ ok: false, error: 'invalid_count' }, 400);
        if (!['monthly', 'yearly', 'custom'].includes(plan)) return json({ ok: false, error: 'invalid_plan' }, 400);

        const days = plan === 'monthly' ? 30 : plan === 'yearly' ? 365 : 0;
        const customExpiry = plan === 'custom' && expires_at ? new Date(expires_at) : null;
        if (plan === 'custom' && (!customExpiry || isNaN(customExpiry.getTime()))) {
          return json({ ok: false, error: 'invalid_expires_at' }, 400);
        }

        const codes = [];
        const stmt = env.DB.prepare(
          'INSERT INTO activation_codes (code, plan, expires_at, batch_label) VALUES (?, ?, ?, ?)'
        );

        // Use a batch for better performance
        const batch = [];
        for (let i = 0; i < count; i++) {
          const code = await makeCode(env.CODE_SALT);
          const expiresAt = customExpiry
            ? customExpiry.toISOString()
            : new Date(Date.now() + days * 86400000).toISOString();
          batch.push(stmt.bind(code, plan, expiresAt, batch_label || null));
          codes.push(code);
        }

        await env.DB.batch(batch);
        return json({ ok: true, codes: codes, plan: plan, count: codes.length });
      }

      if (path === '/api/codes' && request.method === 'GET') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);

        const statusFilter = url.searchParams.get('status');
        const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
        const perPage = Math.min(100, Math.max(10, parseInt(url.searchParams.get('per_page')) || 50));

        let whereClause = '';
        let params = [];
        if (statusFilter) {
          whereClause = ' WHERE status = ?';
          params.push(statusFilter);
        }

        // Count total
        const countRow = await env.DB.prepare('SELECT COUNT(*) as total FROM activation_codes' + whereClause).bind(...params).first();
        const total = countRow.total;

        // Fetch page
        const offset = (page - 1) * perPage;
        const rows = await env.DB.prepare(
          'SELECT code, plan, status, expires_at, created_at, renewed_at, delivered_to, delivered_at, activated_at, batch_label FROM activation_codes' + whereClause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
        ).bind(...params, perPage, offset).all();

        return json({ ok: true, total: total, page: page, per_page: perPage, total_pages: Math.ceil(total / perPage), codes: rows.results });
      }

      if (path === '/api/renew' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);

        const { code, plan } = await request.json();
        if (!code) return json({ ok: false, error: 'missing_code' }, 400);
        if (!['monthly', 'yearly'].includes(plan)) return json({ ok: false, error: 'invalid_plan' }, 400);

        const row = await env.DB.prepare('SELECT code, expires_at FROM activation_codes WHERE code = ?').bind(code).first();
        if (!row) return json({ ok: false, error: 'code_not_found' });

        const days = plan === 'monthly' ? 30 : 365;
        const now = new Date();
        const currentExpiry = new Date(row.expires_at);
        const base = currentExpiry > now ? currentExpiry : now;
        const newExpiry = new Date(base.getTime() + days * 86400000).toISOString();

        await env.DB.prepare(
          "UPDATE activation_codes SET status = 'activated', expires_at = ?, renewed_at = ? WHERE code = ?"
        ).bind(newExpiry, now.toISOString(), code).run();

        return json({ ok: true, code: code, plan: plan, expires_at: newExpiry, message: '续期成功' });
      }

      if (path === '/api/deliver' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        const { code, user, plan, month } = await request.json();
        if (!code || !user) return json({ ok: false, error: 'missing_params' }, 400);

        const row = await env.DB.prepare('SELECT status FROM activation_codes WHERE code = ?').bind(code).first();
        if (!row) return json({ ok: false, error: 'code_not_found', message: '激活码不存在' });
        if (row.status === 'revoked') return json({ ok: false, error: 'revoked', message: '该码已吊销' });

        const effectivePlan = plan || 'monthly';
        const effectiveMonth = Math.max(1, parseInt(month) || 1);
        const days = effectivePlan === 'yearly' ? 365 : effectiveMonth * 30;
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

        await env.DB.prepare(
          "UPDATE activation_codes SET status = 'delivered', plan = ?, expires_at = ?, delivered_to = ?, delivered_at = ? WHERE code = ?"
        ).bind(effectivePlan, expiresAt, user, now, code).run();

        return json({ ok: true, code: code, plan: effectivePlan, expires_at: expiresAt, message: '分发成功' });
      }

      if (path === '/api/revoke' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        const { code } = await request.json();
        if (!code) return json({ ok: false, error: 'missing_code' }, 400);
        await env.DB.prepare("UPDATE activation_codes SET status = 'revoked' WHERE code = ?").bind(code).run();
        return json({ ok: true, message: '已吊销' });
      }

      if (path === '/api/revoke-batch' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        const { codes } = await request.json();
        if (!codes || !Array.isArray(codes) || codes.length === 0) {
          return json({ ok: false, error: 'missing_codes' }, 400);
        }
        const stmt = env.DB.prepare("UPDATE activation_codes SET status = 'revoked' WHERE code = ?");
        const batch = codes.map(c => stmt.bind(c));
        await env.DB.batch(batch);
        return json({ ok: true, count: codes.length, message: '已批量吊销' });
      }

      if (path === '/api/clear-all' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        const codesResult = await env.DB.prepare("DELETE FROM activation_codes").run();
        const trialsResult = await env.DB.prepare("DELETE FROM trial_usage").run();
        return json({ ok: true, codes: codesResult.meta?.changes_written || 0, trials: trialsResult.meta?.changes_written || 0, message: '数据库已清空' });
      }

      // 404
      return json({ ok: false, error: 'not_found' }, 404);

    } catch (e) {
      console.error('Worker error:', e);
      // Never echo internal error details to clients
      return json({ ok: false, error: 'server_error' }, 500);
    }
  }
};
