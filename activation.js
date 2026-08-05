// ============================================================
// RenSheet Activation System — activation.js
// 仅 guoji.html 加载。SwissSpa 医用蓝风格。
// 暴露: window.ensureActivated(toolName) → Promise<boolean>
//       window.markTrialUsed(toolName)   → void
// ============================================================
(function () {
  'use strict';

  // ===== CONFIG =====
  var API_BASE = 'https://api.rensheet.top';
  var TOOL_NAME = 'guoji';
  var STORAGE_ACTIVATION = 'renshet_activation';
  var STORAGE_USAGE = 'renshet_free_usage';
  var VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  var AFDIAN_URL = 'https://www.ifdian.net/a/baiyanxi';

  // ===== FP COLLECTION =====
  function detectCanvasHash() {
    try {
      var c = document.createElement('canvas');
      c.width = 200; c.height = 40;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#f60'; ctx.fillRect(10, 5, 180, 30);
      ctx.fillStyle = '#069'; ctx.font = '14px Arial';
      ctx.fillText('RenSheet Trial', 20, 28);
      return c.toDataURL().substring(0, 80);
    } catch (e) { return 'c-na'; }
  }

  function detectWebGLVendor() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg
        ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) + '|' + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
        : 'gl-na';
    } catch (e) { return 'gl-na'; }
  }

  async function collectFingerprintHash() {
    var parts = [
      navigator.hardwareConcurrency || 'na',
      screen.colorDepth + '|' + screen.width + '|' + screen.height,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.language,
      navigator.platform,
      detectCanvasHash(),
      detectWebGLVendor()
    ];
    var raw = parts.join('|||');
    // Simple SHA-256 via SubtleCrypto
    try {
      var data = new TextEncoder().encode(raw);
      var hash = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hash)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (e) {
      // Fallback: simple djb2 hash
      var h = 5381;
      for (var i = 0; i < raw.length; i++) { h = ((h << 5) + h + raw.charCodeAt(i)) | 0; }
      return 'djb2-' + (h >>> 0).toString(16);
    }
  }

  // ===== STORAGE HELPERS =====
  function getActivation() {
    try { return JSON.parse(localStorage.getItem(STORAGE_ACTIVATION)) || null; } catch (e) { return null; }
  }
  function setActivation(data) {
    try { localStorage.setItem(STORAGE_ACTIVATION, JSON.stringify(data)); } catch (e) {}
  }
  function clearActivation() {
    try { localStorage.removeItem(STORAGE_ACTIVATION); } catch (e) {}
  }

  function getUsage(tool) {
    try { var u = JSON.parse(localStorage.getItem(STORAGE_USAGE)) || {}; return u[tool] || 0; } catch (e) { return 0; }
  }
  function setUsage(tool, val) {
    try {
      var u = JSON.parse(localStorage.getItem(STORAGE_USAGE)) || {};
      u[tool] = val;
      localStorage.setItem(STORAGE_USAGE, JSON.stringify(u));
    } catch (e) {}
  }

  // ===== API CALLS =====
  async function apiCall(path, body) {
    try {
      var resp = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return await resp.json();
    } catch (e) {
      return { ok: false, error: 'network', message: '网络连接失败，请检查网络后重试' };
    }
  }

  async function verifyCode(code) {
    return apiCall('/api/verify', { code: code });
  }

  async function checkTrial(tool, fpHash) {
    return apiCall('/api/check-trial', { tool: tool, fp_hash: fpHash });
  }

  async function consumeTrial(tool, fpHash) {
    return apiCall('/api/consume-trial', { tool: tool, fp_hash: fpHash });
  }

  // ===== MODAL =====
  var overlayEl = null;
  var statusEl = null;
  var inputEl = null;
  var submitBtn = null;

  function createModal() {
    // Prevent duplicate
    if (document.getElementById('rensheet-activation-overlay')) return;

    var html = '<div id="rensheet-activation-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;'
      + 'background:rgba(13,33,55,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;'
      + 'font-family:\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',system-ui,sans-serif;">'
      + '<div style="background:#FFFFFF;border-radius:12px;padding:48px 40px;max-width:440px;width:90%;'
      + 'text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.15);position:relative;">'
      + '<div style="font-size:48px;margin-bottom:12px;line-height:1;">'
      + '<svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="22" stroke="#2B6FA8" stroke-width="2" fill="#EDF5FA"/>'
      + '<path d="M16 24l5 6 11-12" stroke="#1A4570" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '</div>'
      + '<h2 style="font-size:22px;font-weight:600;color:#0D2137;margin:0 0 6px;letter-spacing:2px;">激活 RenSheet 国际表</h2>'
      + '<p style="font-size:14px;color:#4A5568;margin:0 0 20px;font-weight:500;">输入激活码，解锁无限次处理与导出</p>'
      + '<div id="rensheet-code-input-group" style="display:flex;gap:0;justify-content:center;margin-bottom:20px;">'
      + '<input id="rensheet-code-input" type="text" placeholder="RENS-XXXX-XXXX-XXXX-XXXX" maxlength="24" autocomplete="off" '
      + 'style="width:100%;padding:14px 16px;border:2px solid #E2E8F0;border-radius:8px;font-size:16px;text-align:center;'
      + 'letter-spacing:2px;font-family:monospace;color:#0D2137;outline:none;transition:border-color 0.25s;" '
      + 'onfocus="this.style.borderColor=\'#2B6FA8\'" onblur="this.style.borderColor=\'#E2E8F0\'" />'
      + '</div>'
      + '<button id="rensheet-activate-btn" '
      + 'style="width:100%;padding:14px;background:#1A4570;color:#fff;border:none;border-radius:8px;font-size:16px;'
      + 'font-weight:600;cursor:pointer;letter-spacing:2px;transition:background 0.25s;" '
      + 'onmouseover="this.style.background=\'#2B6FA8\'" onmouseout="this.style.background=\'#1A4570\'">激活</button>'
      + '<p id="rensheet-status" style="font-size:13px;margin:12px 0 0;min-height:20px;"></p>'
      + '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #E2E8F0;text-align:left;">'
      + '<p style="font-size:11px;color:#C53030;margin:0 0 8px;font-weight:600;">&#9888; 一个激活码仅可激活一次，清除浏览器缓存后需重新输入。续费请重新赞助获取新码。</p>'
      + '<p style="font-size:12px;color:#4A5568;margin:0 0 4px;"><strong>如何获取激活码？</strong></p>'
      + '<p style="font-size:12px;color:#4A5568;margin:0 0 4px;">1. 前往 <a href="' + AFDIAN_URL + '" target="_blank" '
      + 'style="color:#2B6FA8;text-decoration:none;font-weight:600;">爱发电</a> 赞助（月费 ¥5 / 年费 ¥30）</p>'
      + '<p style="font-size:12px;color:#4A5568;margin:0 0 4px;">2. 付款后前往 <a href="get-code.html" target="_blank" '
      + 'style="color:#2B6FA8;text-decoration:none;font-weight:600;">取码页</a>，输入订单号领取激活码</p>'
      + '<p style="font-size:12px;color:#4A5568;margin:0;">3. 如取码页查询不到（漏单），请联系客服处理</p>'
      + '</div>'
      + '<button id="rensheet-close-modal" style="position:absolute;top:12px;right:16px;background:none;border:none;'
      + 'font-size:22px;color:#A0AEC0;cursor:pointer;line-height:1;" title="关闭">×</button>'
      + '</div></div>';

    var div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);

    overlayEl = document.getElementById('rensheet-activation-overlay');
    inputEl = document.getElementById('rensheet-code-input');
    statusEl = document.getElementById('rensheet-status');
    submitBtn = document.getElementById('rensheet-activate-btn');

    // Format input
    inputEl.addEventListener('input', function () {
      var raw = this.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
      // Strip leading RENS if user pasted full code, we add it back
      if (raw.substring(0, 4) === 'RENS') raw = raw.substring(4);
      var formatted = 'RENS-';
      for (var i = 0; i < 16 && i < raw.length; i++) {
        if (i > 0 && i % 4 === 0) formatted += '-';
        formatted += raw[i];
      }
      this.value = formatted;
    });

    // Submit
    submitBtn.addEventListener('click', activateHandler);
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') activateHandler(); });

    // Close
    document.getElementById('rensheet-close-modal').addEventListener('click', hideModal);
  }

  function showModal() {
    if (!overlayEl) createModal();
    overlayEl.style.display = 'flex';
    statusEl.textContent = '';
    statusEl.style.color = '';
    inputEl.value = '';
    inputEl.disabled = false;
    submitBtn.disabled = false;
    submitBtn.textContent = '激活';
  }

  function hideModal() {
    if (overlayEl) overlayEl.style.display = 'none';
  }

  async function activateHandler() {
    var code = (inputEl.value || '').trim();
    if (!code || code.length < 24) {
      statusEl.textContent = '请输入完整的激活码';
      statusEl.style.color = '#C53030';
      return;
    }

    inputEl.disabled = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '验证中...';
    statusEl.textContent = '';
    statusEl.style.color = '';

    var result = await verifyCode(code);

    if (result.ok) {
      setActivation({
        code: code,
        plan: result.plan,
        expires_at: result.expires_at,
        last_verified_at: new Date().toISOString()
      });
      statusEl.textContent = '激活成功！';
      statusEl.style.color = '#276749';
      updateBadge();
      setTimeout(hideModal, 1200);
    } else {
      statusEl.textContent = result.message || '激活失败，请检查激活码';
      statusEl.style.color = '#C53030';
      inputEl.disabled = false;
      submitBtn.disabled = false;
      submitBtn.textContent = '激活';
    }
  }

  // ===== BADGE =====
  var badgeEl = null;
  var badgePanelEl = null;

  function createBadge() {
    if (document.getElementById('rensheet-badge')) return;

    var html = '<div id="rensheet-badge" style="position:fixed;top:16px;right:20px;z-index:99990;'
      + 'font-family:\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',system-ui,sans-serif;">'
      + '<button id="rensheet-badge-btn" style="padding:6px 14px;border:none;border-radius:20px;font-size:12px;'
      + 'font-weight:600;cursor:pointer;letter-spacing:1px;transition:all 0.25s;">试用中 · 2次</button>'
      + '<div id="rensheet-badge-panel" style="display:none;position:absolute;top:38px;right:0;background:#fff;'
      + 'border:1px solid #E2E8F0;border-radius:10px;padding:16px 20px;width:260px;box-shadow:0 4px 16px rgba(0,0,0,0.08);'
      + 'text-align:left;font-size:13px;color:#4A5568;"></div>'
      + '</div>';

    var div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);

    badgeEl = document.getElementById('rensheet-badge');
    var btn = document.getElementById('rensheet-badge-btn');
    badgePanelEl = document.getElementById('rensheet-badge-panel');

    btn.addEventListener('click', function () { togglePanel(); });
    document.addEventListener('click', function (e) {
      if (!badgeEl.contains(e.target)) badgePanelEl.style.display = 'none';
    });
  }

  function togglePanel() {
    if (badgePanelEl.style.display === 'none' || !badgePanelEl.style.display) {
      updatePanel();
      badgePanelEl.style.display = 'block';
    } else {
      badgePanelEl.style.display = 'none';
    }
  }

  function updatePanel() {
    var act = getActivation();
    var usage = getUsage(TOOL_NAME);
    var remaining = 2 - usage;

    var html = '';
    if (act) {
      var exp = new Date(act.expires_at);
      var now = new Date();
      var daysLeft = Math.ceil((exp - now) / 86400000);
      html += '<p style="margin:0 0 6px;"><strong>状态：</strong><span style="color:#276749;">已激活</span></p>';
      html += '<p style="margin:0 0 6px;"><strong>方案：</strong>' + (act.plan === 'monthly' ? '月费 ¥5/月' : '年费 ¥30/年') + '</p>';
      html += '<p style="margin:0 0 6px;"><strong>有效期至：</strong>' + exp.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) + '</p>';
      html += '<p style="margin:0;color:#A0AEC0;font-size:12px;">' + (daysLeft > 0 ? '剩余 ' + daysLeft + ' 天' : '已过期') + '</p>';
      html += '<hr style="margin:8px 0;border-color:#FEFCBF;">';
      html += '<p style="margin:0 0 4px;font-size:11px;color:#975A16;font-weight:600;">&#9888; 清除浏览器缓存后 PRO 状态会消失</p>';
      html += '<p style="margin:0;font-size:11px;color:#975A16;">忘记激活码？凭订单号前往取码页找回</p>';
    } else if (remaining > 0) {
      html += '<p style="margin:0 0 6px;"><strong>免费试用</strong></p>';
      html += '<p style="margin:0 0 6px;">剩余处理次数：<strong>' + remaining + '</strong> / 2</p>';
      html += '<p style="margin:0;font-size:12px;color:#A0AEC0;">次数用完后需激活继续使用</p>';
    } else {
      html += '<p style="margin:0 0 6px;"><strong>试用次数已用完</strong></p>';
      html += '<p style="margin:0;font-size:12px;color:#A0AEC0;">请激活后继续使用</p>';
    }
    html += '<hr style="margin:10px 0;border-color:#E2E8F0;">';
    html += '<a href="' + AFDIAN_URL + '" target="_blank" style="color:#2B6FA8;text-decoration:none;font-weight:600;font-size:12px;">→ 前往爱发电赞助</a>';
    html += '<br><a href="get-code.html" target="_blank" style="color:#2B6FA8;text-decoration:none;font-weight:600;font-size:12px;">→ 已赞助？凭订单号取回激活码</a>';
    if (!act) {
      html += '<br><a href="#" id="rensheet-open-modal" style="color:#2B6FA8;text-decoration:none;font-weight:600;font-size:12px;">→ 输入激活码</a>';
    }

    badgePanelEl.innerHTML = html;

    // Bind the "open modal" link if present
    var openLink = document.getElementById('rensheet-open-modal');
    if (openLink) {
      openLink.addEventListener('click', function (e) { e.preventDefault(); showModal(); badgePanelEl.style.display = 'none'; });
    }
  }

  function updateBadge() {
    if (!badgeEl) createBadge();
    var btn = document.getElementById('rensheet-badge-btn');
    var act = getActivation();
    var usage = getUsage(TOOL_NAME);
    var remaining = 2 - usage;

    if (act) {
      var daysLeft = Math.ceil((new Date(act.expires_at) - new Date()) / 86400000);
      if (daysLeft <= 0) {
        btn.textContent = '已过期';
        btn.style.background = '#FED7D7'; btn.style.color = '#C53030';
      } else if (daysLeft <= 7) {
        btn.textContent = '即将到期 · ' + daysLeft + '天';
        btn.style.background = '#FEFCBF'; btn.style.color = '#975A16';
      } else {
        btn.textContent = 'PRO';
        btn.style.background = '#1A4570'; btn.style.color = '#FFFFFF';
      }
    } else if (remaining > 0) {
      btn.textContent = '试用中 · ' + remaining + '次';
      btn.style.background = '#EDF5FA'; btn.style.color = '#2B6FA8';
    } else {
      btn.textContent = '未激活';
      btn.style.background = '#E2E8F0'; btn.style.color = '#A0AEC0';
    }
  }

  // ===== SILENT RE-VERIFY =====
  async function silentReVerify() {
    var act = getActivation();
    if (!act) return;
    var now = new Date().toISOString();
    var lastVerified = act.last_verified_at || '1970-01-01';
    if (new Date(now) - new Date(lastVerified) < VERIFY_INTERVAL_MS) return;

    var result = await verifyCode(act.code);
    if (result.ok) {
      act.expires_at = result.expires_at;
      act.last_verified_at = now;
      setActivation(act);
    } else if (result.error === 'expired' || result.error === 'revoked' || result.error === 'invalid_code') {
      // Revoked codes must stop working immediately — clearing local state
      // drops the user back to trial/activation flow on next use
      clearActivation();
    }
    updateBadge();
  }

  // ===== PUBLIC API =====
  // Called by the tool page's "开始处理" button
  window.ensureActivated = async function (toolName) {
    toolName = toolName || TOOL_NAME;

    // 1. Check activation
    var act = getActivation();
    if (act) {
      var now = new Date();
      if (new Date(act.expires_at) > now) {
        // Re-verify with the server when the check interval elapsed, so a
        // revoked/expired code stops working promptly. Network failures must
        // not lock out a legitimately activated user.
        var lastVerified = act.last_verified_at ? new Date(act.last_verified_at) : null;
        if (!lastVerified || now - lastVerified >= VERIFY_INTERVAL_MS) {
          var verified = await verifyCode(act.code);
          if (verified.ok) {
            act.expires_at = verified.expires_at;
            act.last_verified_at = new Date().toISOString();
            setActivation(act);
            return true;
          }
          if (verified.error === 'network') return true;
          clearActivation();
          updateBadge();
          showModal();
          return false;
        }
        return true;
      }
      // Expired
      clearActivation();
      updateBadge();
      showModal();
      return false;
    }

    // 2. Check trial
    var usage = getUsage(toolName);
    if (usage >= 2) {
      // Trial exhausted locally
      showModal();
      return false;
    }

    // 3. Verify trial remotely
    var fpHash = await collectFingerprintHash();
    var result = await checkTrial(toolName, fpHash);

    if (result.ok && result.remaining > 0) {
      return true;
    }

    // Trial used up
    setUsage(toolName, 2); // Sync local
    updateBadge();
    showModal();
    return false;
  };

  // Called by the tool page after successful processing
  window.markTrialUsed = async function (toolName) {
    toolName = toolName || TOOL_NAME;

    var act = getActivation();
    if (act && new Date(act.expires_at) > new Date()) {
      // Activated users don't consume trial
      return;
    }

    // Consume trial locally
    var usage = getUsage(toolName);
    if (usage >= 2) return; // Already exhausted
    setUsage(toolName, usage + 1);

    // Consume on server
    try {
      var fpHash = await collectFingerprintHash();
      await consumeTrial(toolName, fpHash);
    } catch (e) { /* silent */ }

    updateBadge();
  };

  // ===== INIT =====
  function init() {
    createModal();
    hideModal();
    createBadge();
    updateBadge();
    silentReVerify();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
