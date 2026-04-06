# LINE Messaging API 報警設定手冊

由於舊版的 LINE Notify 已經終止服務，本監控系統已改用正規的 **LINE Messaging API (Push Notification)**。此機制每個月享有 **200 則**的免付費推播額度，對於設有防抖邏輯 (Debounce) 的監控系統來說非常夠用。

---

## 取得金鑰的 4 步驟教學

### 步驟 1：登入 LINE Developers Console
1. 前往 [LINE Developers Console](https://developers.line.biz/console/)。
2. 使用您個人的 LINE 帳號完成登入。

### 步驟 2：從 LINE 官方帳號後台建立機器人 (新版政策)
根據 LINE 的最新政策，現在無法直接在開發者後台建立頻道，必須透過建立「LINE 官方帳號 (OA)」來開通：
1. 點擊畫面上的綠色按鈕 **Create a LINE Official Account** (它會將您引導至 LINE Official Account Manager 網頁)。
2. 填寫新建官方帳號的必填資料（Account name 填寫例如 `HihiMonitor`、輸入信箱並隨意選擇一個業別）後送出建立。
3. 建立成功後，點擊進入該官方帳號的後台首頁。
4. 點擊畫面右上角的 **「設定 (Settings / ⚙️齒輪圖示)」**。
5. 在左側選單中找到 **「Messaging API」** 並點選進入。
6. 點擊畫面上的 **「啟用 Messaging API」**。
7. 此時系統會跳出視窗請您選取 Provider，請選擇您剛剛在步驟 1 建立的 `UptimeMonitor` (或是當場輸入名字新建一個)，並點擊同意即可完成開通！

### 步驟 3：獲取 Channel Access Token (環境變數一)
雖然是在 OA 後台開通的，但我們要拿的金鑰一樣都在開發者後台找：
1. 回到剛才的 [LINE Developers Console](https://developers.line.biz/console/) 網頁並重新整理。
2. 點進您的 `UptimeMonitor` Provider，您會發現剛剛綁定的 Channel 終於出現了，點擊進入該 Channel。
3. 切換到上方的 **Messaging API** 分頁。
4. 頁面往下滑到最底部的 **Channel access token (long-lived)** 區塊。
5. 點擊 **Issue** 按鈕產生 Token。
6. 👉 **複製這段超長字串**，這就是您在 Cloudflare 要填入的 `LINE_CHANNEL_ACCESS_TOKEN`。

### 步驟 4：獲取 User ID (環境變數二) 與加好友
1. 切換回第一個 **Basic settings** 分頁。
2. 頁面滑到最底部的 **Your user ID** 區塊。
3. 👉 **複製這串英數字組合**（這不是您的普通 LINE ID），這將是 Cloudflare 要填入的 `LINE_USER_ID`。
4. 在同一個 Basic settings 頁面往上找，您會看到 **Bot basic ID** 旁邊有一個 **QR Code**。
5. **拿起手機掃描這個 QR code，將這隻機器人「加為好友」！**
   *(⚠️ 非常重要：若您未加機器人為好友，它將無法「推送」任何報警訊息給您！)*

---

## 回到 Cloudflare 設定
當您順利取得上述的 **兩個金鑰字串**，並且把機器人加為好友之後，您就可以關閉這個網頁，回到主目錄的 `SOP.md`。

接著，請在 **Phase 4 (環境變數與 Secrets 設定)** 之中：
- 將環境變數 `ALERT_CHANNELS` 改為或加入 `line`
- 將剛剛取得的兩串金鑰作為 **Secret** 加密儲存，即可完成整合！
