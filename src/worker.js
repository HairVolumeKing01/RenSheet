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

        const row = await env.DB.prepare(
          'SELECT code, plan, expires_at, delivered_at FROM activation_codes WHERE delivered_to = ? ORDER BY delivered_at DESC LIMIT 1'
        ).bind(orderId).first();

        if (!row) return json({ ok: false, error: 'order_not_found', message: '未找到该订单对应的激活码，请确认付款成功或联系客服' });
        return json({ ok: true, code: row.code, plan: row.plan, expires_at: row.expires_at });
      }

      if (path === '/api/afdian-webhook' && request.method === 'POST') {
        const body = await request.json();

        // Verify webhook: token is optional, URL itself is the secret
        // Check query param, header, or body for token — only enforce if AFDIAN_WEBHOOK_SECRET is set AND token is present
        const urlToken = url.searchParams.get('token') || '';
        const headerToken = request.headers.get('X-Af-Token') || '';
        const bodyToken = (body?.data?.token || body?.token || '').toString();
        const receivedToken = urlToken || headerToken || bodyToken;

        if (env.AFDIAN_WEBHOOK_SECRET && receivedToken && receivedToken !== env.AFDIAN_WEBHOOK_SECRET) {
          return json({ ok: false, error: 'invalid_token', message: 'Webhook token 验证失败' }, 403);
        }

        // Validate it looks like a real Afdian webhook
        if (!body || (!body.data && !body.order)) {
          return json({ ok: false, error: 'invalid_payload', message: '非法的请求格式' }, 400);
        }

        // Afdian webhook format: { ec:200, em:"ok", data:{ type:"order", order:{...} } }
        const orderData = body?.data?.order || body?.order || body?.data || body;
        const userId = (orderData?.user_id || orderData?.userId || 'unknown').toString();
        const planId = (orderData?.plan_id || '').toString();
        const month = parseInt(orderData?.month) || 1;
        const remark = (orderData?.remark || '').toString().toLowerCase();
        const totalAmount = parseFloat(orderData?.total_amount) || 0;

        // Determine plan + duration from month count and remark
        // month<12 and not marked as yearly → monthly × N months
        // month>=12 or explicitly yearly → yearly (365d)
        let plan = 'monthly';
        let durationDays = month * 30;
        if (remark.includes('年费') || remark.includes('yearly') || remark.includes('年度')) {
          plan = 'yearly';
          durationDays = 365;
        } else if (remark.includes('月费') || remark.includes('monthly') || remark.includes('月度')) {
          plan = 'monthly';
          durationDays = month * 30;
        } else if (month >= 12) {
          plan = 'yearly';
          durationDays = 365;
        } else if (totalAmount >= 25) {
          plan = 'yearly';
          durationDays = 365;
        }

        // Find any unused code — expiry gets set at delivery time
        const codeRow = await env.DB.prepare(
          "SELECT code FROM activation_codes WHERE status = 'unused' ORDER BY created_at ASC LIMIT 1"
        ).first();

        if (!codeRow) return json({ ok: false, error: 'no_codes_available', message: '暂无可用激活码，请联系管理员补充库存' });

        const now = new Date();
        const expiresAt = new Date(now.getTime() + durationDays * 86400000).toISOString();

        // Assign code + override plan & expiry based on actual purchase
        await env.DB.prepare(
          "UPDATE activation_codes SET status = 'delivered', plan = ?, expires_at = ?, delivered_to = ?, delivered_at = ? WHERE code = ?"
        ).bind(plan, expiresAt, userId, now.toISOString(), codeRow.code).run();

        return json({
          ok: true,
          code: codeRow.code,
          plan: plan,
          expires_at: expiresAt,
          duration_days: durationDays,
          month: month,
          message: '发货成功'
        });
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
        let query = 'SELECT code, plan, status, expires_at, created_at, renewed_at, delivered_to, delivered_at, activated_at, batch_label FROM activation_codes';
        let params = [];

        if (statusFilter) {
          query += ' WHERE status = ?';
          params.push(statusFilter);
        }
        query += ' ORDER BY created_at DESC LIMIT 200';

        let stmt = env.DB.prepare(query);
        for (const p of params) stmt = stmt.bind(p);
        const rows = await stmt.all();

        return json({ ok: true, total: rows.results.length, codes: rows.results });
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

      if (path === '/api/revoke' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        const { code } = await request.json();
        if (!code) return json({ ok: false, error: 'missing_code' }, 400);
        await env.DB.prepare("UPDATE activation_codes SET status = 'revoked' WHERE code = ?").bind(code).run();
        return json({ ok: true, message: '已吊销' });
      }

      // 404
      return json({ ok: false, error: 'not_found' }, 404);

    } catch (e) {
      console.error('Worker error:', e);
      return json({ ok: false, error: 'server_error', message: e.message }, 500);
    }
  }
};
