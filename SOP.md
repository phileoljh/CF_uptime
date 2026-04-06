# CloudFlare Workers 多網站監控系統 — 標準作業程序 (SOP)

> **版本**：v1.1  
> **最後更新**：2026-04-03  
> **架構方案**：Cloudflare Zero Trust + Workers + D1  
> **部署方式**：🌐 **全 Cloudflare Dashboard 操作，無需本地安裝任何工具**  
> **適用範圍**：hihimonitor.win 域名下之多網站可用性監控

---

## 目錄

1. [系統架構總覽](#1-系統架構總覽)
2. [前置需求](#2-前置需求)
3. [Phase 1：D1 資料庫建置](#3-phase-1d1-資料庫建置)
4. [Phase 2：Worker 建立與程式碼部署](#4-phase-2worker-建立與程式碼部署)
5. [Phase 3：通知管道整合 (Telegram)](#5-phase-3通知管道整合-telegram)
6. [Phase 4：環境變數與 Secrets 設定](#6-phase-4環境變數與-secrets-設定)
7. [Phase 5：Cron Trigger 設定](#7-phase-5cron-trigger-設定)
8. [Phase 6：Zero Trust 安全防護](#8-phase-6zero-trust-安全防護)
9. [Phase 7：驗證與上線確認](#9-phase-7驗證與上線確認)
10. [Phase 8：日常維運與資料治理](#10-phase-8日常維運與資料治理)
11. [Gap 補完：原始設計不足之處與補強](#11-gap-補完原始設計不足之處與補強)
12. [故障排除 (Troubleshooting)](#12-故障排除-troubleshooting)
13. [附錄](#13-附錄)

---

## 1. 系統架構總覽

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                       │
│                                                                 │
│  ┌──────────────┐    Cron 觸發     ┌──────────────────────┐     │
│  │  Cron Trigger │ ──────────────► │  Worker (Scheduled)  │     │
│  │  */5 * * * *  │                 │  - 健康檢查          │     │
│  └──────────────┘                  │  - 防抖邏輯          │     │
│                                    │  - 寫入 D1           │     │
│                                    │  - 觸發通知          │     │
│                                    └──────────┬───────────┘     │
│                                               │                 │
│                                               ▼                 │
│                                    ┌──────────────────────┐     │
│                                    │   Cloudflare D1      │     │
│                                    │   (SQLite)           │     │
│                                    │   - sites            │     │
│                                    │   - uptime_logs      │     │
│                                    │   - alert_history    │     │
│                                    └──────────┬───────────┘     │
│                                               │                 │
│  ┌──────────────┐    HTTP 請求     ┌──────────┴───────────┐     │
│  │  Zero Trust  │ ◄────────────── │  Worker (Fetch)      │     │
│  │  Access Gate │ ──────────────► │  - 儀表板 HTML 渲染  │     │
│  └──────────────┘  驗證通過        │  - API 端點          │     │
│                                    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                  │                              │
                  ▼                              ▼
        ┌──────────────┐              ┌──────────────────┐
        │  受監控網站   │              │  Telegram Bot API │
        │  HEAD 探測    │              │  即時報警推播     │
        └──────────────┘              └──────────────────┘
```

### 核心設計原則

| 原則 | 說明 |
|------|------|
| **防抖優先** | 任何狀態變更需連續兩次確認 (ADD/DAA) 後才發送通知，避免暫時性波動誤報 |
| **零信任安全** | 儀表板由 Cloudflare Access 閘道保護，Worker 程式碼無需自行實作驗證邏輯 |
| **資料自治** | 所有紀錄儲存於 D1，Cron 自動輪替超過 90 天的舊資料 |
| **通知可靠** | Telegram Bot 即時推播為主管道，Email 管道預留待 API GA 後啟用 |
| **容錯隔離** | 單一網站的檢查失敗不影響其他網站的探測流程 |
| **全雲端操作** | 所有設定均透過 Cloudflare Dashboard UI 完成，無需本地開發環境 |

---

## 2. 前置需求

### 2.1 帳號與服務清單

| 項目 | 需求 | 說明 |
|------|------|------|
| **Cloudflare 帳號** | 已綁定 `hihimonitor.win` 域名 | Free Plan 即可支撐本系統 |
| **Telegram 帳號** | 用於建立通知 Bot | 透過官方 @BotFather 申請 |
| **瀏覽器** | Chrome / Edge / Firefox | 操作 Cloudflare Dashboard 用 |

> ✅ **無需安裝** Node.js、npm、Wrangler CLI 或任何本地工具。

### 2.2 Cloudflare Dashboard 入口

| 功能 | 網址 |
|------|------|
| 主控台 | https://dash.cloudflare.com |
| Zero Trust | https://one.dash.cloudflare.com |
| Workers & Pages | https://dash.cloudflare.com → 左側選單 |
| D1 資料庫 | https://dash.cloudflare.com → Storage & Databases → D1 |

---

## 3. Phase 1：D1 資料庫建置

### 3.1 建立 D1 資料庫

1. 登入 **Cloudflare Dashboard** → 左側選單 **Storage & Databases → D1**
2. 點擊右上角 **Create database**
3. 填入：
   - **Database name**：`uptime-monitor-db`
   - **Location**（選用）：Asia Pacific（降低台灣延遲）
4. 點擊 **Create** → 系統建立完成後會顯示 **Database ID**（格式：`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）
5. **記下 Database ID**，後續綁定 Worker 時需用到

### 3.2 執行 Schema 初始化

1. 進入剛建立的資料庫，點擊上方 **Console** 分頁
2. 在 SQL 輸入框貼入以下完整 Schema，點擊 **Execute**：

```sql
-- ============================================================
-- 表 1：監控網站清單
-- ============================================================
CREATE TABLE IF NOT EXISTS sites (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    url                 TEXT NOT NULL UNIQUE,
    check_method        TEXT DEFAULT 'HEAD',
    expected_status     INTEGER DEFAULT 200,
    timeout_ms          INTEGER DEFAULT 10000,
    is_active           INTEGER DEFAULT 1,
    last_stable_status  TEXT DEFAULT 'ALIVE',
    last_checked_at     DATETIME,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 表 2：歷史探測紀錄
-- ============================================================
CREATE TABLE IF NOT EXISTS uptime_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id     INTEGER NOT NULL,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
    status      TEXT NOT NULL,
    status_code INTEGER,
    latency_ms  INTEGER,
    error_msg   TEXT,
    region      TEXT,
    FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- ============================================================
-- 表 3：報警歷史紀錄
-- ============================================================
CREATE TABLE IF NOT EXISTS alert_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id     INTEGER NOT NULL,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
    alert_type  TEXT NOT NULL,
    channel     TEXT NOT NULL,
    message     TEXT,
    success     INTEGER DEFAULT 1,
    FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- ============================================================
-- 效能索引
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_logs_site_time
    ON uptime_logs(site_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp
    ON uptime_logs(timestamp);

CREATE INDEX IF NOT EXISTS idx_alert_site_time
    ON alert_history(site_id, timestamp DESC);

-- ============================================================
-- 初始監控站點（依實際情況修改）
-- ============================================================
INSERT INTO sites (name, url) VALUES
    ('官方網站',      'https://hihimonitor.win'),
    ('Fred總經數據',    'https://fred.hihimonitor.win'),
    ('英文學習',  'https://learning.hihimonitor.win');
```

3. 執行結果顯示 **Success** 即完成

> 💡 **驗證**：在 Console 執行 `SELECT * FROM sites;` 確認三筆初始資料已寫入

---

## 4. Phase 2：Worker 建立與程式碼部署

### 4.1 建立 Worker

1. **Dashboard** → 左側選單 **Workers & Pages**
2. 點擊 **Create** → 在「Ship something new」畫面中，點擊綠色地球圖示的 **「Start with Hello World!」** (從 Hello World 範本開始)。
3. **Worker name** 填入：`uptime-monitor`
4. 點擊右下角的 **Deploy** (部署)，建立一個初始的 Worker。

### 4.2 綁定 D1 資料庫

> ⚠️ **必須先完成此步驟**，Worker 程式碼才能使用 `env.DB`

1. 進入 Worker (`uptime-monitor`) → 上方 **Settings** 分頁
2. 左側選擇 **Bindings**
3. 點擊 **Add** → 選擇 **D1 database**
4. 填入：
   - **Variable name**：`DB`（大寫，必須完全一致）
   - **D1 database**：選擇 `uptime-monitor-db`
5. 點擊 **Save**

### 4.3 部署 Worker 程式碼

1. 進入 Worker → 上方 **Edit Code** 按鈕（進入線上編輯器）
2. **清空**左側編輯區的所有預設程式碼
3. **貼入**以下完整程式碼：

```javascript
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

    // 針對 HEAD 探測直接回傳 200，避免觸發儀表板渲染耗費 D1 讀取資源
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200 });
    }

    // 忽略 favicon 請求，避免無謂消耗 D1 資源去渲染 HTML
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 404 });
    }

    if (url.pathname === '/api/status') {
      return await handleApiStatus(env);
    }
    if (url.pathname === '/api/sites' && request.method === 'POST') {
      return await handleAddSite(request, env);
    }
    if (url.pathname.startsWith('/api/sites/') && request.method === 'DELETE') {
      return await handleDeleteSite(url, env);
    }

    // ============================================================
    // 精準快取策略：讀取 D1 最新日誌 ID (僅耗 1 Read) 作為版本號
    // ============================================================
    let dbVersion = '0';
    try {
      // 找出庫中最後一筆探測資料的 ID，當成全域狀態版本號 (極輕量查詢)
      const latest = await env.DB.prepare('SELECT id FROM uptime_logs ORDER BY id DESC LIMIT 1').first();
      dbVersion = latest ? latest.id.toString() : '0';
    } catch(e) {}

    const cache = caches.default;
    // 修正：必須使用屬於自己網域的 Origin，若用假網域可能會被 Cloudflare 視為無效資源而提早清掉
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
        console.log(`[STAMPEDE 防護] 搭便車！等候並共用渲染結果 (v${dbVersion})`);
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
          console.log(`[D1 查詢] 偵測到新狀態 (v${dbVersion})，耗費 D1 重新渲染`);
          
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
      // 從快取提取出的 response 會帶有一小時的標頭，為了確保使用者按 F5 時，
      // 必定會進來向 Worker 詢問最新版號，我們將回傳給瀏覽器的標頭改為防快取
      response = new Response(response.body, response);
      response.headers.set('Cache-Control', 'no-cache, no-store');
      console.log(`[CACHE HIT] 🚀 狀態無變更 (v${dbVersion})，僅耗 1 Read 直接回傳`);
    }

    return response;
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
  const { results: sites } = await env.DB.prepare('SELECT * FROM sites ORDER BY id').all();

  const siteData = [];
  for (const site of sites) {
    const { results: logs } = await env.DB.prepare(
      'SELECT status, latency_ms, timestamp FROM uptime_logs WHERE site_id = ? ORDER BY timestamp DESC LIMIT 40'
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
      const twTime = new Date(log.timestamp + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      return `<span class="dot" style="background:${c}" title="${twTime} ${log.status} ${log.latency_ms}ms"></span>`;
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
          <h3>${site.name}</h3>
          <span class="url">${site.url}</span>
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
      <td>${a.site_name}</td>
      <td>${a.channel}</td>
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
  try {
    const { name, url } = await request.json();
    if (!name || !url) return Response.json({ error: 'name 和 url 為必填' }, { status: 400 });
    await env.DB.prepare('INSERT INTO sites (name, url) VALUES (?, ?)').bind(name, url).run();
    return Response.json({ success: true }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

async function handleDeleteSite(url, env) {
  const id = url.pathname.split('/').pop();
  await env.DB.prepare('UPDATE sites SET is_active=0 WHERE id=?').bind(id).run();
  return Response.json({ success: true });
}
```

4. 點擊右上角 **Save and Deploy** 完成部署

---

## 5. Phase 3：通知管道整合 (雙方案自選)

本系統支援 **Telegram** 與 **LINE Messaging API** 兩種報警方式。您可擇一設定，或兩者皆設，並在下一階段透過旗標切換。

### 5.1 方案 A：Telegram 設定

| 步驟 | 操作 |
|------|------|
| 1 | 在 Telegram 搜尋並打開 **@BotFather** |
| 2 | 發送 `/newbot` 開始建立 |
| 3 | 輸入機器人顯示名稱，例：`HihiMonitor 報警` |
| 4 | 輸入機器人帳號（須以 `_bot` 結尾），例：`hihimonitor_alert_bot` |
| 5 | BotFather 回傳 **API Token**，格式：`123456789:ABCdef...`，**複製保存** |
| 6 | 搜尋並打開 **@userinfobot** → 發送任意文字 → 取得你的 **Chat ID（數字）** |
| 7 | 直接向你剛建立的 Bot 發送任意訊息（啟動對話，否則 Bot 無法主動傳訊給你） |

在瀏覽器網址列輸入以下 URL 測試（替換真實值），成功代表管道正常：
`https://api.telegram.org/bot<YOUR_TOKEN>/sendMessage?chat_id=<YOUR_CHAT_ID>&text=HihiMonitor+測試通知`

### 5.2 方案 B：LINE 設定

為保持教學單純，LINE 機器人的金鑰申請與設定步驟已獨立成冊。如果您選擇使用 LINE 來接收報警，請點擊參考同目錄下的設定手冊：
👉 **[LINE Messaging API 報警設定手冊](./LINE_Setup.md)**

---

## 6. Phase 4：環境變數與 Secrets 設定

> 所有變數與金鑰均在 **Worker → Settings → Variables and Secrets** 新增，透過選擇不同的 **Type (類型)** 來決定是否加密，無需 CLI。

### 6.1 設定非機敏環境變數 (純文字)

這些變數用於控制系統邏輯，不具安全性風險。這裡我們也設定「報警旗標」。

1. 進入 Worker (`uptime-monitor`) → 上方 **Settings** 分頁
2. 左側選擇 **Variables and Secrets** → 點擊右側的 **+ Add (新增)**
3. 畫面右側滑出設定面板，依序新增以下四筆（皆選擇 `Text` 類型）：

| Type (類型) | Variable name | Value | 說明 |
|-------------|---------------|-------|------|
| `Text` | `ALERT_CHANNELS`           | `telegram` | **報警旗標**！填入 `telegram` 或 `line`，或 `telegram,line` |
| `Text` | `ALERT_COOLDOWN_MINUTES`   | `30`       | 同一網站報警冷卻時間（分鐘） |
| `Text` | `DATA_RETENTION_DAYS`      | `90`       | uptime_logs 保留天數 |
| `Text` | `LONG_DOWN_HOURS`          | `8`        | 長期故障報警間隔時數（預設 8 小時） |

### 6.2 設定機敏金鑰 (加密儲存)

這是您的通訊軟體授權憑證，必須加密以防外洩。若您只選用一種報警管道，只需設定對應的變數即可。

1. 繼續點擊下方的 **Add variable (新增變數)**，依據您的需求設定以下值（請選 `Secret` 類型）：

| Type (類型) | Variable name | Value | 說明 |
|-------------|---------------|-------|------|
| `Secret` | `TELEGRAM_BOT_TOKEN`        | (值) | [方案A] Telegram 的 API Token |
| `Secret` | `TELEGRAM_CHAT_ID`          | (值) | [方案A] Telegram 的 Chat ID |
| `Secret` | `LINE_CHANNEL_ACCESS_TOKEN` | (值) | [方案B] LINE Messaging API 長效 Token |
| `Secret` | `LINE_USER_ID`              | (值) | [方案B] 您的 LINE User ID |

2. 全部新增完成後，點擊 **Save and deploy (儲存並部署)**

> 🔒 **技術顧問提示**：選擇 `Secret` (機密) 類型等同於舊版的 Encrypt 功能。部署後，該 Value (變數值) 在主控台上將會被完全隱藏，無法再次查看明文，確保資訊安全 (Information Security)。

---

## 7. Phase 5：Cron Trigger 設定

### 7.1 設定兩個 Cron 排程

1. **Workers & Pages** → `uptime-monitor` → **Settings** → **Triggers**
2. 點擊 **Add Cron Trigger**，依序新增：

| Cron 表達式 | 用途 | 台灣時間等效 |
|------------|------|-------------|
| `*/5 * * * *` | 每 5 分鐘健康檢查 | 全天候 |
| `0 19 * * *` | 每日資料清理 | 每天凌晨 03:00 (UTC+8) |

> ⚠️ **時區說明**：Cloudflare Cron 使用 **UTC**。台灣 03:00 (UTC+8) = UTC 前一天 19:00，因此填 `0 19 * * *`。

3. 新增完成後可在 **Triggers** 頁面確認兩個 Cron 都已列出

### 7.2 手動觸發測試（線上編輯器）

受限於預覽介面的更新，新的手動測試需進入編輯器面板來操作：

1. 進入您的 Worker 專案 → 點擊上方的 **Edit Code (編輯程式碼)** 進入線上編輯器。
2. 將視線移至畫面**右半部**（顯示儀表板畫面的上方），找到頁籤區，預設停留在 **「👁️ Preview (預覽)」**。
3. 請點擊旁邊的 **「🕒 Schedule (排程)」** 頁籤。
4. 切換後介面會轉換為排程測試工具，請選擇對應的 Cron 表達式（如 `*/5 * * * *`），並點擊按鈕手動發送 `scheduled` 事件，觸發健康檢查。
5. 前往 D1 Console 執行 `SELECT * FROM uptime_logs ORDER BY timestamp DESC LIMIT 5;` 確認有最新探測資料寫入。

---

## 8. Phase 6：Zero Trust 安全防護

### 8.1 啟用 Cloudflare Access 與 Zero Trust 的關係

> 💡 **觀念解析**：Cloudflare Access 是 **Cloudflare Zero Trust** 平台底下負責「身分驗證與存取控制」的核心服務。當您在 Worker 啟用 Access 時，系統實際上是在背後連動您的 Zero Trust 控制台，自動為該網址建立一個受保護的 Application (應用程式)。

1. **Workers & Pages** → `uptime-monitor` → **Settings** → **Domains & Routes**
2. 找到 `workers.dev` 子域名（儀表板預設網址）旁，點擊 **Enable Cloudflare Access**
3. 系統會自動在 Zero Trust 平台中建立名為 `uptime-monitor - Cloudflare Workers` 的 Application。

### 8.2 設定身分驗證政策 (Policies)

1. 前往 **Zero Trust Dashboard**：https://one.dash.cloudflare.com
2. 展開左側選單 **Access controls → Applications**
3. 您會在列表中看見 `uptime-monitor - Cloudflare Workers`，點擊該項目進入編輯。
4. 切換到上方的 **Policies** 分頁。系統通常會預設產生一筆名為 `uptime-monitor - Production` 的政策 (Policy)。
5. 點擊該政策以進入編輯 (Edit)，確保或修改下列允許規則：

| 欄位 | 設定狀態 / 應填入內容 |
|------|-----------------------|
| **Action (動作)** | `ALLOW` (允許) |
| **Include Rule (Select)** | 選擇 `Emails` |
| **Value (規則值)** | 填入您自己的信箱 (如 `phileoljh@gmail.com`)，只有這份名單內的人才能登入 |

6. **(實用功能)** 往下滑動找到 **Policy tester (政策測試器)**，輸入任意信箱點擊 Test。如果輸入您剛設定的信箱，應顯示綠色的 `ALLOWED` (100% is approved)，代表防護邏輯已正確生效！
7. 完成後點擊 **Save policy** 儲存。

### 8.3 (進階) 設定 WARP 免密碼直通 (Bypass)

如果您有綁定 Cloudflare Zero Trust 的 WARP 客戶端，可設定「連上 WARP 就不需輸入 Email」的直通規則：

> ⚠️ **避坑指南**：請務必在指定的「Application 內部」建立規則。**不要**跑到左側主選單的 `Reusable policies` 建立，否則 Application 抓不到規則（Used by applications 會顯示 0）。

1. 確保您在專案的 **Policies** 分頁中（路徑：Applications -> `uptime-monitor - Cloudflare Workers` -> Policies）。
2. 在此頁面點擊 **+ Create new policy**，填入以下設定：
   * **Action (動作)**：選擇 **`Bypass`** (繞過驗證)
   * **Include Rule**：選擇 **`Warp`**，後面的 Value 選 **`WARP`**
3. 儲存回到列表後，**【最重要的一步】**：拖曳這條 Bypass 規則到最上面，使其 **Order 為 1** (排在 Email Allow 規則之上)。
   * *防護邏輯：系統由上往下檢查，只要是 WARP 流量就優先放行，非 WARP 流量才會往下被 Email 規則攔截。*

### 8.4 設定驗證方式（Identity Provider）

1. 左側選單 **Settings → Authentication**
2. 預設已有 **One-time PIN (OTP)**，使用信箱收驗證碼即可登入。
3. 若想用 Google 帳號登入：點擊 **Add new → Google** → 依指示完成 OAuth 設定。

### 8.5 安全架構效果

```text
訪客 (非 WARP) → workers.dev/uptime-monitor
                 ↓
           Cloudflare Access 攔截
                 ↓
           要求輸入 Email 收取 OTP
                 ↓
           驗證通過 → Worker 正常回應
           驗證失敗 → 403 Access Denied

身分已驗證訪客 (開啟 WARP) → 直接繞過 (Bypass) → Worker 正常回應
```

---

## 9. Phase 7：驗證與上線確認

### 9.1 上線前檢查清單

```
□ D1 資料庫已建立，Schema 已執行，初始站點已寫入
□ Worker 程式碼已 Save and Deploy
□ Worker Settings → Bindings：DB 已綁定 uptime-monitor-db
□ Worker Settings → Environment Variables：4 個變數已設定
  □ ALERT_COOLDOWN_MINUTES
  □ DATA_RETENTION_DAYS
  □ TELEGRAM_BOT_TOKEN（已加密）
  □ TELEGRAM_CHAT_ID（已加密）
□ Worker Settings → Triggers：兩個 Cron 已新增
  □ */5 * * * *
  □ 0 19 * * *
□ Telegram 測試訊息已成功接收
□ Zero Trust Access 政策已設定，只有你的 Email 可通過
□ 手動觸發 Cron Test，D1 中已有 uptime_logs 資料
□ 儀表板 URL 可正常開啟並顯示站點卡片
```

### 9.2 驗證儀表板可用

- 開啟 `https://uptime-monitor.<your-account>.workers.dev`
- 若出現 Cloudflare Access 登入頁面：輸入你的 Email → 收 OTP → 登入
- 登入後應看到 3 個監控站點卡片

### 9.3 (選用) 綁定自訂域名

1. **Workers & Pages** → `uptime-monitor` → **Settings** → **Domains & Routes**
2. 點擊 **Add Custom Domain**
3. 輸入 `uptime.hihimonitor.win`（需在 Cloudflare 管理此域名）
4. 點擊 **Add Custom Domain** → CF 會自動配置 DNS 與 SSL 憑證。

> 🚨 **嚴重資安陷阱警告 (CRITICAL)**：
> Cloudflare Access 預設**只會保護** `workers.dev` 的網址。當您綁定新的自訂域名後，該自訂域名預設是「裸奔」狀態，所有人都可以無密碼直接存取，輕鬆繞過 Zero Trust！
> **綁定自訂域名後，請務必執行以下補救步驟：**

5. 再次前往 **Zero Trust 控制台** -> **Access controls** -> **Applications**。
6. 進入剛剛建立的 `uptime-monitor - Cloudflare Workers` 專案。
7. 在 **Basic information (基本資訊)** 頁籤中，找到 **Application domain (應用程式網域)** 區塊。
8. 將您的自訂域名 (`uptime.hihimonitor.win`) 加進去保護清單中（您可以點選 `+ Add public hostname` 或是直接修改原本的那筆）。
9. 點擊右下角的 Save application 儲存。
10. 設定完成後，存取 `https://uptime.hihimonitor.win` 就會被強制拉回 Zero Trust 的認證畫面了！

---

## 10. Phase 8：日常維運與資料治理

### 10.1 日常巡檢事項

| 頻率 | 項目 | 操作位置 |
|------|------|----------|
| **每日** | 確認 Telegram 無漏報 | 手機 Telegram App |
| **每週** | 登入儀表板確認可用率 | Worker URL |
| **每月** | 確認 D1 用量 | Dashboard → D1 → 你的資料庫 → Metrics |
| **每月** | 確認 Worker 用量 | Workers & Pages → Metrics |
| **有需要時** | 新增監控站點 | D1 Console 直接 INSERT，或呼叫 POST /api/sites |
| **有需要時** | 停用監控站點 | D1 Console 執行 `UPDATE sites SET is_active=0 WHERE id=?` |

### 10.2 D1 Console 常用維運指令

```sql
-- 查看所有監控站點狀態
SELECT id, name, url, is_active, last_stable_status, last_checked_at FROM sites;

-- 查看最近 20 筆探測紀錄（含站名）
SELECT s.name, l.status, l.latency_ms, l.error_msg, l.timestamp
FROM uptime_logs l JOIN sites s ON l.site_id = s.id
ORDER BY l.timestamp DESC LIMIT 20;

-- 查看最近報警歷程
SELECT s.name, ah.alert_type, ah.channel, ah.success, ah.timestamp
FROM alert_history ah JOIN sites s ON ah.site_id = s.id
ORDER BY ah.timestamp DESC LIMIT 10;

-- 新增監控站點（不用改程式碼）
INSERT INTO sites (name, url) VALUES ('新站點名稱', 'https://example.com');

-- 停用某個站點
UPDATE sites SET is_active = 0 WHERE id = 3;

-- 手動重置某站點的穩定狀態（緊急維護後恢復用）
UPDATE sites SET last_stable_status = 'ALIVE' WHERE id = 1;

-- 查詢過去 24h 可用率統計
SELECT
  s.name,
  COUNT(*) as total_checks,
  SUM(CASE WHEN l.status = 'ALIVE' THEN 1 ELSE 0 END) as alive_count,
  ROUND(SUM(CASE WHEN l.status = 'ALIVE' THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 2) as uptime_pct,
  ROUND(AVG(l.latency_ms), 0) as avg_latency_ms
FROM uptime_logs l
JOIN sites s ON l.site_id = s.id
WHERE l.timestamp > datetime('now', '-1 day')
GROUP BY s.id, s.name;
```

### 10.3 D1 Free Tier 額度評估

| 資源 | Free Tier 限制 | 系統預估（10 站 / 每 5 分鐘） |
|------|----------------|-------------------------------|
| D1 讀取 | 500 萬次/天 | ~14,400 次/天 ✅ (0.3%) |
| D1 寫入 | 10 萬次/天 | ~2,880 次/天 ✅ (2.9%) |
| D1 儲存 | 5 GB | ~50 MB/90 天 ✅ |
| Worker 請求 | 10 萬次/天 | ~288 次/天 (cron) ✅ |

---

## 11. Gap 補完：原始設計不足之處與補強

### 11.1 已補強項目

| # | 缺失項目 | 風險 | 本 SOP 補強方式 |
|---|----------|------|-----------------|
| 1 | `performHealthCheck()` 函數未定義 | 核心功能缺失 | 完整實作含 AbortController timeout、狀態碼判斷 |
| 2 | 無 `fetch` handler（儀表板） | 無法呈現 UI | 完整 HTML 渲染 + API 路由實作 |
| 3 | 無資料清理機制 | D1 持續膨脹超過免費額度 | 新增 Cron（UTC 19:00）+ 分批刪除邏輯 |
| 4 | 無報警歷史紀錄表 | 無法追蹤通知成功與否 | 新增 `alert_history` 表 |
| 5 | 無資料庫索引 | 資料量大後查詢緩慢 | 新增 3 個效能索引 |
| 6 | 無報警冷卻機制 | 持續異常時每 5 分鐘重複轟炸 | `ALERT_COOLDOWN_MINUTES` 環境變數 + 冷卻查詢 |
| 7 | 無容錯隔離 | 單一站點異常中斷所有檢查 | `Promise.allSettled()` + per-site catch |
| 8 | Telegram 僅為建議，未實作 | 無法實際收到通知 | 完整 sendMessage 實作含錯誤處理 |
| 9 | 無 24h 可用率與平均延遲統計 | 儀表板缺乏量化指標 | SQL 聚合查詢 + 前端顯示 |
| 10 | Schema 缺少欄位 | 無從記錄錯誤原因與檢查設定 | 新增 `check_method`、`timeout_ms`、`error_msg`、`status_code` 等 |
| 11 | `sites.url` 無唯一約束 | 可能重複新增同一網站 | 加入 `UNIQUE` 約束 |
| 12 | 資料清理 Cron 時區錯誤 | 凌晨 3 點實際應設 UTC 19:00 | 修正為 `0 19 * * *` 並說明原因 |
| 13 | 無本地 CLI 替代方案 | 須安裝 Node.js/Wrangler 才能操作 | **全面改為 Dashboard UI 操作**（本次修訂核心） |
| 14 | 無維運 SQL 查詢腳本 | 日常巡檢無工具可用 | 新增 D1 Console 常用查詢集 |

### 11.2 未來 Phase 2 擴充 Roadmap

| 優先序 | 項目 | 技術說明 |
|--------|------|----------|
| P1 | **SSL 憑證到期監控** | 解析 TLS handshake 取 `notAfter`，提前 14 天報警 |
| P1 | **延遲閾值報警** | 回應 > N ms 發"慢速警告"（非 DEAD 但健康惡化） |
| P2 | **Webhook 整合** | 支援 Slack / Discord / Line Notify 等管道 |
| P2 | **多區域探測** | 利用 Worker 全球節點從多地區探測並比較結果 |
| P3 | **Incident 事件管理** | 自動建立/關閉 Incident，計算 MTTR（平均修復時間） |
| P3 | **公開 Status Page** | 不加 Zero Trust，允許公開瀏覽系統狀態（分離 Worker） |

---

## 12. 故障排除 (Troubleshooting)

### 12.1 常見問題對照表

| 問題現象 | 可能原因 | 解決方式（純 Dashboard） |
|----------|----------|--------------------------|
| 儀表板顯示空白 / 無卡片 | Schema 未執行或 Cron 從未觸發 | D1 Console 執行 `SELECT * FROM sites;` 確認資料；手動 Cron Test |
| 儀表板顯示「尚無資料」點 | Cron 尚未執行過 | Worker → Triggers → 對應 Cron → Test |
| Telegram 通知未收到 | Token/ChatID 設定錯誤 | Worker → Settings → Environment Variables 確認值；用瀏覽器測試 Telegram API URL |
| `env.DB` 找不到 / D1 Error | Binding 未設定或名稱錯誤 | Settings → Bindings 確認 Variable name 為大寫 `DB` |
| 畫面顯示 1970 年時間戳 | SQLite 時間未加 'Z' 後綴 | 程式碼已修正（含 `+ 'Z'` 轉換） |
| Cron 未自動執行 | Cron 表達式格式錯誤 | Triggers 頁面確認 Cron 狀態顯示 Active |
| 報警持續重複發送 | 冷卻機制未生效 | 確認 `ALERT_COOLDOWN_MINUTES` 環境變數已儲存 |
| Worker 儲存失敗 | 程式碼語法錯誤 | Dashboard 編輯器底部有語法錯誤提示 |

### 12.2 Telegram Bot 診斷（瀏覽器直接測試）

在瀏覽器網址列輸入（替換實際值）：

```
# 驗證 Token 有效
https://api.telegram.org/bot<TOKEN>/getMe

# 測試發送訊息
https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=測試訊息
```

### 12.3 D1 Console 診斷查詢

```sql
-- 確認資料表已建立
SELECT name FROM sqlite_master WHERE type='table';

-- 確認最新一批探測是否正常
SELECT site_id, status, error_msg, timestamp
FROM uptime_logs ORDER BY timestamp DESC LIMIT 10;

-- 確認報警是否有發送失敗
SELECT * FROM alert_history WHERE success = 0 ORDER BY timestamp DESC LIMIT 5;
```

---

## 13. 附錄

### 附錄 A：防抖邏輯狀態機（ADD / DAA）

```
  last_stable_status   上一筆 log   本次探測   → 動作
  ─────────────────────────────────────────────────────
  ALIVE                DEAD         DEAD        → 🔴 ALERT_DOWN + stable ← DEAD
  DEAD                 ALIVE        ALIVE       → 🟢 ALERT_RECOVERY + stable ← ALIVE
  ALIVE                ALIVE        ALIVE       → 記錄，靜默
  DEAD                 DEAD         DEAD        → 記錄，靜默（已發過警，冷卻中）
  ALIVE                ALIVE        DEAD  (AD)  → 記錄，靜默（瞬時閃斷，等待確認）
  DEAD                 DEAD         ALIVE (DA)  → 記錄，靜默（瞬時恢復，等待確認）
```

### 附錄 B：Worker 完整 API 端點

| 方法 | 路徑 | 功能 | 保護 |
|------|------|------|------|
| `GET` | `/` | 儀表板 HTML | Zero Trust |
| `GET` | `/api/status` | 所有站點 JSON 狀態 | Zero Trust |
| `POST` | `/api/sites` | 新增站點 `{ name, url }` | Zero Trust |
| `DELETE` | `/api/sites/:id` | 停用站點（軟刪除） | Zero Trust |

### 附錄 C：Cron 時區速查

| 台灣時間 (UTC+8) | Cloudflare Cron (UTC) |
|------------------|-----------------------|
| 每 5 分鐘 | `*/5 * * * *` |
| 凌晨 00:00 | `0 16 * * *` |
| 凌晨 03:00 | `0 19 * * *` |
| 早上 09:00 | `0 1 * * *` |
| 中午 12:00 | `0 4 * * *` |

### 附錄 D：`.gitignore` 參考（無 Node.js 依賴版）

```gitignore
# 無需 node_modules/ 或 .wrangler/，因為不在本地開發

# Python (若有)
__pycache__/
*.py[cod]
venv/
.venv/

# SQLite Database
*.db
*.sqlite

# Environment variables（若有本地筆記）
.env
secrets.txt
```
