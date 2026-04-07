// ============================================================
// HihiMonitor — CloudFlare Workers 多網站監控系統 v1.1
// 部署方式：直接貼入 CF Workers Dashboard 線上編輯器
// ============================================================

// 全域渲染鎖 (防止 Cache Stampede 快取雪崩效應)
const renderLocks = new Map();

export default {
  // ── HTTP 請求處理（儀表板 + API）
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // ── [新增] 資源耗盡與限流防護 (Rate Limiting) ──
    const rateLimitRes = await checkRateLimit(request, env);
    if (rateLimitRes) return withSecurityHeaders(rateLimitRes);
    // ──────────────────────────────────────────────

    // ── [新增] 惡意掃閱攔截邏輯 (方案二) ──
    // 條件一：判斷是否為非標準的 Port (通訊埠)
    const isUnusualPort = url.port !== "" && url.port !== "80" && url.port !== "443";
    
    // 條件二：判斷路徑是否以 "/." 開頭 (涵蓋 /.git, /.env 等隱藏檔)
    const isHiddenFile = url.pathname.startsWith('/.');

    // 若符合任一惡意特徵，直接 301 永久重新導向 (Redirect) 至首頁
    if (isUnusualPort || isHiddenFile) {
      return withSecurityHeaders(Response.redirect("https://uptime.hihimonitor.win/", 301));
    }
    // ─────────────────────────────────────
    
    // 針對 HEAD 探測直接回傳 200，避免觸發儀表板渲染耗費 D1 讀取資源
    if (request.method === 'HEAD') {
      return withSecurityHeaders(new Response(null, { status: 200 }));
    }

    // 忽略 favicon 請求，避免無謂消耗 D1 資源去渲染 HTML
    if (url.pathname === '/favicon.ico') {
      return withSecurityHeaders(new Response(null, { status: 404 }));
    }

    if (url.pathname === '/api/status') {
      return withSecurityHeaders(await handleApiStatus(env));
    }
    if (url.pathname === '/api/sites' && request.method === 'POST') {
      return withSecurityHeaders(await handleAddSite(request, env));
    }    if (url.pathname.startsWith('/api/sites/') && request.method === 'DELETE') {
      return withSecurityHeaders(await handleDeleteSite(url, env, request));
    }

    // ============================================================
    // 快取策略：以「5 分鐘時間窗口」作為版本號
    // ============================================================
    // 【設計考量】原本使用 D1 最新 ID 作為版本號，但 Cron 執行健康檢查時，
    // 會在短短數秒內連續寫入多筆資料，導致 ID 快速跳動 (v836→v837→v839...)。
    // 若多個 F5 請求恰好在 Cron 執行期間進來，每個請求拿到的「最新 ID」都不同，
    // Stampede 防護因此失效，每個請求都各自觸發 D1 全量重渲染（競態條件 Race Condition）。
    //
    // 解決方案：改用「UTC 分鐘數 ÷ 5 取整數」當作版本號。
    // 效果：在同一個 5 分鐘內（例如 22:30 ~ 22:35），所有請求的版本號完全一致，
    // 保障 Stampede 防護有效運作，且排程每 5 分鐘產生新資料後，版本號自然遞進，
    // 完美觸發快取更新。此方法完全免除對 D1 的版本查詢，節省 1 Read/request。
    //
    // 【60s 偏移量設計】：
    // 考慮到 Cron 排程執行健康檢查大約需 40-60 秒，若在整點（如 22:30:00）立即切換窗口，
    // 此時 D1 的新資料尚未寫入完成，儀表板會快取到舊資料。
    // 因此在計算分鐘數時主動「減去 60 秒」，強制將切換時間推遲到 */5 + 1 分鐘，
    // 確保 D1 資料已更新鮮後再重新渲染。
    const nowMinuteSlot = Math.floor((Date.now() - 60 * 1000) / (5 * 60 * 1000));
    const dbVersion = nowMinuteSlot.toString();

    const cache = caches.default;
    // 使用真實網域的 Origin 作為快取 Key 基底，確保受 Cloudflare Zone 管理
    const cacheKey = new Request(`${url.origin}/_internal_dash_cache?v=${dbVersion}`);
    let response = await cache.match(cacheKey);

    if (!response) {
      const cacheKeyUrl = cacheKey.url;
      if (renderLocks.has(cacheKeyUrl)) {
        // 【防雪崩機制】若已有併發請求正在渲染，改為直接等待共享純字串，避免 I/O 跨域衝突
        const sharedHtml = await renderLocks.get(cacheKeyUrl);
        response = new Response(sharedHtml, {
          headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'Cache-Control': 'no-cache, no-store'
          }
        });
        console.log(`[STAMPEDE 防護] 搭便車！等候並共用渲染結果 (窗口 ${dbVersion})`);
      } else {
        // 自己是第一個發現快取過期的人，建立鎖並開始渲染
        const renderPromise = (async () => {
          const res = await renderDashboard(env);
          // 關鍵修正：將 Response 轉為純粹的字串 (String)，因為純字串可以安全地在多次併發連線間共享
          const htmlText = await res.text();
          
          const cacheable = new Response(htmlText, {
            headers: {
              'Content-Type': 'text/html;charset=UTF-8',
              'Cache-Control': 'public, max-age=3600, s-maxage=3600'
            }
          });
          // 使用 await 確保快取確實寫入記憶體後再放行，保障後續併發
          await cache.put(cacheKey, cacheable);
          console.log(`[D1 查詢] 新的 5 分鐘窗口 (${dbVersion})，重新渲染儀表板`);
          
          return htmlText; // 回傳字串供大家搭便車共用
        })();
        
        renderLocks.set(cacheKeyUrl, renderPromise);
        
        try {
          const sharedHtml = await renderPromise;
          response = new Response(sharedHtml, {
            headers: {
              'Content-Type': 'text/html;charset=UTF-8',
              'Cache-Control': 'no-cache, no-store'
            }
          });
        } finally {
          renderLocks.delete(cacheKeyUrl); // 快取完畢後解除鎖定
        }
      }
    } else {
      // 同一 5 分鐘窗口內，直接從 Edge Cache 拿出已渲染的 HTML，完全不觸碰 D1
      response = new Response(response.body, response);
      response.headers.set('Cache-Control', 'no-cache, no-store');
      console.log(`[CACHE HIT] 🚀 窗口未切換 (${dbVersion})，0 Read 直接回傳`);
    }

    return withSecurityHeaders(response);
  },

  // ── 排程事件處理（健康檢查 + 資料清理）
  async scheduled(event, env, ctx) {
    if (event.cron === '0 19 * * *') {
      // UTC 19:00 = 台灣時間凌晨 03:00 → 資料清理
      ctx.waitUntil(cleanupOldData(env));
    } else {
      // 每 5 分鐘 → 健康檢查
      ctx.waitUntil(runHealthChecks(env));
    }
  },
};

// ============================================================
// 健康檢查主邏輯
// ============================================================
async function runHealthChecks(env) {
  const { results: sites } = await env.DB.prepare(
    'SELECT * FROM sites WHERE is_active = 1'
  ).all();

  // 並行檢查，各自錯誤隔離
  const checks = sites.map((site) =>
    checkSingleSite(site, env).catch((err) =>
      console.error(`[ERROR] 檢查 ${site.name} 失敗: ${err.message}`)
    )
  );

  await Promise.allSettled(checks);
}

async function checkSingleSite(site, env) {
  const result = await performHealthCheck(site);

  const lastLog = await env.DB.prepare(
    'SELECT status FROM uptime_logs WHERE site_id = ? ORDER BY timestamp DESC LIMIT 1'
  ).bind(site.id).first();

  await evaluateDebounce(site, result, lastLog, env);

  await env.DB.prepare(
    'INSERT INTO uptime_logs (site_id, status, status_code, latency_ms, error_msg) VALUES (?, ?, ?, ?, ?)'
  ).bind(site.id, result.status, result.statusCode, result.latencyMs, result.errorMsg).run();

  await env.DB.prepare(
    'UPDATE sites SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(site.id).run();
}

// ============================================================
// 健康檢查實作（含 Timeout 控制）
// ============================================================
async function performHealthCheck(site) {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutMs = site.timeout_ms || 10000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(site.url, {
      method: site.check_method || 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'HihiMonitor/1.1 (Uptime Check)' },
      redirect: 'follow',
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isAlive = response.status >= 200 && response.status < 400;

    return {
      status: isAlive ? 'ALIVE' : 'DEAD',
      statusCode: response.status,
      latencyMs,
      errorMsg: isAlive ? null : `HTTP ${response.status}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      status: 'DEAD',
      statusCode: null,
      latencyMs: Date.now() - startTime,
      errorMsg: err.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : err.message,
    };
  }
}

// ============================================================
// 防抖邏輯：ADD（故障確認）/ DAA（恢復確認） / DDDDDD（持續故障報警）
// ============================================================
//  last_stable_status  上一筆  本次   → 動作
//  ALIVE               DEAD    DEAD   → ALERT_DOWN  + stable←DEAD
//  DEAD                ALIVE   ALIVE  → ALERT_RECOVERY + stable←ALIVE
//  DEAD                DEAD    DEAD   → 檢查是否超過預設小時數未恢復，是則 ALERT_LONG_DOWN
//  其他任何組合                       → 僅寫入紀錄，靜默
async function evaluateDebounce(site, result, lastLog, env) {
  const cur = result.status;
  const prev = lastLog?.status;
  const stable = site.last_stable_status;

  if (cur === 'DEAD' && prev === 'DEAD' && stable === 'ALIVE') {
    const cooldown = env.ALERT_COOLDOWN_MINUTES || '30';
    const recent = await env.DB.prepare(
      `SELECT id FROM alert_history
       WHERE site_id = ? AND alert_type = 'ALERT_DOWN'
       AND timestamp > datetime('now', '-' || ? || ' minutes')`
    ).bind(site.id, cooldown).first();

    if (!recent) await sendAlert(env, site, 'ALERT_DOWN', result);

    await env.DB.prepare(
      "UPDATE sites SET last_stable_status='DEAD', updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(site.id).run();

  } else if (cur === 'ALIVE' && prev === 'ALIVE' && stable === 'DEAD') {
    await sendAlert(env, site, 'ALERT_RECOVERY', result);

    await env.DB.prepare(
      "UPDATE sites SET last_stable_status='ALIVE', updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(site.id).run();

  } else if (cur === 'DEAD' && prev === 'DEAD' && stable === 'DEAD') {
    // DDDDDD 長期故障報警邏輯
    // 當狀態保持為 DEAD 時，我們會檢查 alert_history
    // 如果過去 N 小時內（從 timestamp 計算），該站點沒有觸發過任何 ALERT_DOWN 或 ALERT_LONG_DOWN
    // 代表故障已經持續超過 N 小時且未發送過長效報警，便觸發 ALERT_LONG_DOWN 進行追蹤
    const longDownHours = env.LONG_DOWN_HOURS || '8';
    const recentLongDown = await env.DB.prepare(
      `SELECT id FROM alert_history
       WHERE site_id = ? AND alert_type IN ('ALERT_DOWN', 'ALERT_LONG_DOWN')
       AND timestamp > datetime('now', '-' || ? || ' hours')`
    ).bind(site.id, longDownHours).first();

    if (!recentLongDown) {
      await sendAlert(env, site, 'ALERT_LONG_DOWN', result);
    }
  }
}

// ============================================================
// 通知發送邏輯 (具備開關 Flag：Telegram / LINE 雙管道)
// ============================================================
async function sendAlert(env, site, alertType, result) {
  // 旗標控制：telegram, line 或是 telegram,line 兩者並存
  const channels = (env.ALERT_CHANNELS || 'telegram').toLowerCase();
  const useTelegram = channels.includes('telegram');
  const useLine = channels.includes('line');

  const isDown = alertType === 'ALERT_DOWN';
  const isLongDown = alertType === 'ALERT_LONG_DOWN';
  const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  const longDownHours = env.LONG_DOWN_HOURS || '8';

  let title = '🟢 *已恢復正常*';
  if (isDown) title = '🔴 *故障確認*';
  if (isLongDown) title = `⚠️ *持續故障警告 (已超過${longDownHours}小時)*`;

  let logicText = '💡 邏輯：DAA（連續兩次探測恢復）';
  if (isDown) logicText = '💡 邏輯：ADD（連續兩次探測失敗）';
  if (isLongDown) logicText = `💡 邏輯：DDDDDD（超過預設${longDownHours}小時未恢復）`;

  const message = [
    title,
    '',
    `📍 站點：${site.name}`,
    `🔗 網址：${site.url}`,
    `⏱️ 延遲：${result.latencyMs}ms`,
    (isDown || isLongDown) ? `❌ 錯誤：${result.errorMsg || 'N/A'}` : null,
    logicText,
    '',
    `🕐 時間：${timestamp}`,
  ].filter(Boolean).join('\n');

  let anySuccess = false;

  // 管道 A：Telegram
  if (useTelegram && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
          }),
        }
      );
      if (res.ok) anySuccess = true;
      if (!res.ok) console.error(`[TELEGRAM] 失敗: ${res.status}`);
    } catch (err) {
      console.error(`[TELEGRAM] 異常: ${err.message}`);
    }
  }

  // 管道 B：LINE Messaging API
  if (useLine && env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_USER_ID) {
    try {
      // LINE 不支援 Markdown 星號，做簡單清理
      const cleanMessage = message.replace(/\*/g, '');
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          to: env.LINE_USER_ID,
          messages: [{ type: 'text', text: cleanMessage }]
        })
      });
      if (res.ok) anySuccess = true;
      if (!res.ok) console.error(`[LINE] 失敗: ${res.status}`);
    } catch (err) {
      console.error(`[LINE] 異常: ${err.message}`);
    }
  }

  await env.DB.prepare(
    'INSERT INTO alert_history (site_id, alert_type, channel, message, success) VALUES (?, ?, ?, ?, ?)'
  ).bind(site.id, alertType, channels, message, anySuccess ? 1 : 0).run();
}

// ============================================================
// 資料清理（保留天數由環境變數控制）
// ============================================================
async function cleanupOldData(env) {
  const days = env.DATA_RETENTION_DAYS || '90';

  for (const [table, col, retDays] of [
    ['uptime_logs', 'timestamp', days],
    ['alert_history', 'timestamp', '180'],
  ]) {
    let deleted = true;
    while (deleted) {
      const r = await env.DB.prepare(
        `DELETE FROM ${table} WHERE id IN
         (SELECT id FROM ${table} WHERE ${col} < datetime('now', '-' || ? || ' days') LIMIT 500)`
      ).bind(retDays).run();
      deleted = r.meta.rows_written > 0;
    }
  }

  console.log(`[CLEANUP] 完成 (uptime_logs 保留 ${days} 天，alert_history 保留 180 天)`);
}

// ============================================================
// 儀表板 HTML 渲染
// ============================================================
async function renderDashboard(env) {
  const { results: sites } = await env.DB.prepare('SELECT * FROM sites WHERE is_active = 1 ORDER BY id').all();

  const siteData = [];
  for (const site of sites) {
    const { results: logs } = await env.DB.prepare(
      'SELECT status, latency_ms, timestamp FROM uptime_logs WHERE site_id = ? ORDER BY timestamp DESC LIMIT 72'
    ).bind(site.id).all();

    const { results: stats } = await env.DB.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status='ALIVE' THEN 1 ELSE 0 END) as alive_count,
              AVG(latency_ms) as avg_latency
       FROM uptime_logs
       WHERE site_id = ? AND timestamp > datetime('now', '-1 day')`
    ).bind(site.id).all();

    const s = stats[0];
    siteData.push({
      ...site,
      logs: logs.reverse(),
      uptimePercent: s?.total > 0 ? ((s.alive_count / s.total) * 100).toFixed(2) : 'N/A',
      avgLatency: s?.avg_latency ? Math.round(s.avg_latency) : 'N/A',
    });
  }

  const { results: alerts } = await env.DB.prepare(
    `SELECT ah.*, s.name as site_name FROM alert_history ah
     JOIN sites s ON ah.site_id = s.id ORDER BY ah.timestamp DESC LIMIT 10`
  ).all();

  return new Response(buildHTML(siteData, alerts, env), {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

function buildHTML(sites, alerts, env) {
  const cards = sites.map(site => {
    const dots = site.logs.map(log => {
      const c = log.status === 'ALIVE' ? '#10b981' : '#ef4444';
      const twTime = new Date(log.timestamp.replace(' ', 'T') + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      return `<span class="dot" style="background:${c}" title="${twTime} ${escapeHTML(log.status)} ${log.latency_ms}ms"></span>`;
    }).join('');

    const isAlive = site.last_stable_status === 'ALIVE';
    const badgeColor = isAlive ? '#10b981' : '#ef4444';
    const checkedAt = site.last_checked_at
      ? new Date(site.last_checked_at + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
      : '尚未執行';

    return `
    <div class="card ${isAlive ? '' : 'card-down'}">
      <div class="card-header">
        <div>
          <h3>${escapeHTML(site.name)}</h3>
          <span class="url">${escapeHTML(site.url)}</span>
        </div>
        <span class="badge" style="background:${badgeColor}">${isAlive ? '正常' : '異常'}</span>
      </div>
      <div class="dots">${dots || '<span style="color:#475569;font-size:0.8rem">尚無資料</span>'}</div>
      <div class="card-footer">
        <span>24h 可用率：<b>${site.uptimePercent}%</b></span>
        <span>平均延遲：<b>${site.avgLatency}ms</b></span>
        <span>上次檢查：${checkedAt}</span>
      </div>
    </div>`;
  }).join('');

  const alertRows = alerts.map(a => {
    let icon = '🟢';
    let label = '恢復通知';
    if (a.alert_type === 'ALERT_DOWN') {
      icon = '🔴';
      label = '故障報警';
    } else if (a.alert_type === 'ALERT_LONG_DOWN') {
      const h = env.LONG_DOWN_HOURS || '8';
      icon = '⚠️';
      label = `持續故障(>${h}h)`;
    }
    const ts = new Date(a.timestamp + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    return `<tr>
      <td>${icon} ${label}</td>
      <td>${escapeHTML(a.site_name)}</td>
      <td>${escapeHTML(a.channel)}</td>
      <td>${ts}</td>
      <td>${a.success ? '✅ 成功' : '❌ 失敗'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">目前沒有報警紀錄</td></tr>';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>HihiMonitor — 系統監控儀表板</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem;min-height:100vh}
  header{margin-bottom:2rem}
  header h1{font-size:1.8rem;font-weight:700;letter-spacing:-0.5px}
  header p{color:#64748b;margin-top:0.25rem;font-size:0.9rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:1.25rem;margin-bottom:2.5rem}
  .card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:1.25rem;transition:border-color 0.2s}
  .card:hover{border-color:#475569}
  .card-down{border-color:#ef444444;background:#1e1a2e}
  .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;gap:0.5rem}
  .card-header h3{font-size:1rem;font-weight:600;color:#f1f5f9}
  .url{font-size:0.75rem;color:#475569;margin-top:2px;display:block;word-break:break-all}
  .badge{padding:3px 10px;border-radius:20px;font-size:0.72rem;color:#fff;font-weight:600;white-space:nowrap;flex-shrink:0}
  .dots{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:0.9rem;min-height:24px;align-items:center}
  .dot{width:10px;height:28px;border-radius:3px;cursor:default;transition:transform 0.15s,opacity 0.15s}
  .dot:hover{transform:scaleY(1.25);opacity:0.85}
  .card-footer{display:flex;gap:1rem;flex-wrap:wrap;font-size:0.75rem;color:#64748b}
  .card-footer b{color:#94a3b8}
  h2{font-size:1.15rem;font-weight:600;margin-bottom:1rem;color:#f1f5f9}
  table{width:100%;border-collapse:collapse;background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden}
  th,td{padding:0.7rem 1rem;text-align:left;border-bottom:1px solid #1e293b;font-size:0.83rem}
  thead tr{background:#334155}
  th{color:#94a3b8;font-weight:600}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#263348}
  .empty{text-align:center;color:#475569;padding:1.5rem!important}
  footer{margin-top:2rem;font-size:0.75rem;color:#334155;text-align:center}
</style>
</head>
<body>
<header>
  <h1>📡 HiHiMonitor 系統監控</h1>
  <p>防抖機制 ADD / DAA / DDDDDD ｜ 每 5 分鐘探測 ｜ 資料保留 90 天 ｜ Line/Telegram 即時報警</p>
</header>
<div class="grid">${cards}</div>
<h2>📋 近期報警紀錄</h2>
<table>
  <thead><tr><th>類型</th><th>站點</th><th>管道</th><th>時間（台灣）</th><th>狀態</th></tr></thead>
  <tbody>${alertRows}</tbody>
</table>
<footer>HihiMonitor v1.1 · Powered by Cloudflare Workers + D1</footer>
</body>
</html>`;
}

// ============================================================
// API 端點
// ============================================================
async function handleApiStatus(env) {
  const { results: sites } = await env.DB.prepare(
    'SELECT id, name, url, last_stable_status, last_checked_at FROM sites WHERE is_active = 1'
  ).all();
  return Response.json({ sites, timestamp: new Date().toISOString() });
}

async function handleAddSite(request, env) {
  // CSRF 防護：強制檢查自定義標頭
  if (!verifyCsrf(request)) {
    return Response.json({ error: 'CSRF 驗證失敗：缺少必要的安全標頭' }, { status: 403 });
  }
  try {
    const { name, url } = await request.json();
    if (!name || !url) return Response.json({ error: 'name 和 url 為必填' }, { status: 400 });
    await env.DB.prepare('INSERT INTO sites (name, url) VALUES (?, ?)').bind(name, url).run();
    return Response.json({ success: true }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

async function handleDeleteSite(url, env, request) {
  // CSRF 防護：強制檢查自定義標頭 (DELETE 亦須校驗)
  if (!verifyCsrf(request)) {
    return Response.json({ error: 'CSRF 驗證失敗：缺少必要的安全標頭' }, { status: 403 });
  }
  const id = url.pathname.split('/').pop();
  await env.DB.prepare('UPDATE sites SET is_active=0 WHERE id=?').bind(id).run();
  return Response.json({ success: true });
}

// ── 安全性輔助工具 ──

/**
 * 封裝常用的 HTTP 安全標頭
 */
function withSecurityHeaders(response) {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('X-Frame-Options', 'DENY');
  newResponse.headers.set('X-Content-Type-Options', 'nosniff');
  newResponse.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // CSP: 限制資源來源，允許 Google Fonts、Cloudflare 分析腳本與內聯樣式 (含 Web Worker 與 Beacon)
  const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; worker-src 'self' blob:;";
  newResponse.headers.set('Content-Security-Policy', csp);
  
  return newResponse;
}

/**
 * HTML 字串轉義 (防範 XSS)
 */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * CSRF 驗證 (防範跨站請求偽造)
 */
function verifyCsrf(request) {
  // 非同源的請求無法在未觸發 CORS 預檢的情況下帶入此自定義標頭
  return request.headers.get('X-Requested-With') === 'HihiMonitor';
}

/**
 * 資源耗盡與限流防護 (利用 Cache API 實作零成本計數)
 */
async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return null; // 靈魂偵測失敗則跳過

  const url = new URL(request.url);
  const isApiRequest = request.method !== 'GET' || url.pathname.startsWith('/api/');
  const type = isApiRequest ? 'api' : 'dash';

  // 門檻設定：優先讀取環境變數，預設為 Dash 30/min, API 10/min
  const threshold = parseInt(isApiRequest ? (env.RATE_LIMIT_API || '10') : (env.RATE_LIMIT_DASH || '30'));
  
  const cache = caches.default;
  const baseUrl = `http://ratelimit.local/${type}/${ip}`;
  
  // 1. 檢查是否存在「封鎖標記」 (Block Flag)
  const blockKey = new Request(`${baseUrl}/blocked`);
  const isBlocked = await cache.match(blockKey);
  if (isBlocked) {
    return new Response('Too Many Requests (IP Blocked for 1m)', { 
      status: 429,
      headers: { 'Retry-After': '60' }
    });
  }

  // 2. 檢查/更新「計數器」 (Counter)
  const countKey = new Request(`${baseUrl}/count`);
  const cachedRes = await cache.match(countKey);
  
  let currentCount = 0;
  if (cachedRes) {
    currentCount = parseInt(await cachedRes.text()) || 0;
  }

  if (currentCount >= threshold) {
    // 觸發封鎖：寫入一個 60 秒過期的封鎖標記
    const blockRes = new Response('blocked', {
      headers: { 'Cache-Control': 'max-age=60, s-maxage=60' }
    });
    // 使用 waitUntil 異步寫入，不阻塞主流程
    // 注意：在 fetch 中 ctx 可能不直接傳入，但可利用 request.signal 或直接 await
    await cache.put(blockKey, blockRes);
    
    return new Response('Too Many Requests (Rate limit exceeded)', { 
      status: 429,
      headers: { 'Retry-After': '60' }
    });
  }

  // 更新計數：s-maxage=60 代表每一分鐘重置一次窗口
  const nextCountRes = new Response((currentCount + 1).toString(), {
    headers: { 'Cache-Control': 'max-age=60, s-maxage=60' }
  });
  await cache.put(countKey, nextCountRes);

  return null;
}
