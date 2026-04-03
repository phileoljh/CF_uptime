-- ============================================================
-- HihiMonitor D1 Schema v1.0
-- 初始遷移：建立監控系統資料表
-- ============================================================

-- 表 1：監控網站清單
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

-- 表 2：歷史探測紀錄
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

-- 表 3：報警歷史紀錄
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

-- 索引：加速查詢效能
CREATE INDEX IF NOT EXISTS idx_logs_site_time
    ON uptime_logs(site_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp
    ON uptime_logs(timestamp);

CREATE INDEX IF NOT EXISTS idx_alert_site_time
    ON alert_history(site_id, timestamp DESC);

-- 初始監控資料
INSERT INTO sites (name, url) VALUES
    ('官方網站',      'https://hihimonitor.win'),
    ('API 伺服器',    'https://api.hihimonitor.win'),
    ('後台管理系統',  'https://admin.hihimonitor.win');
