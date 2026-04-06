# LINE Messaging API 報警設定手冊

由於舊版的 LINE Notify 已經終止服務，本監控系統已改用正規的 **LINE Messaging API (Push Notification)**。此機制每個月享有 **200 則**的免付費推播額度，對於設有防抖邏輯 (Debounce) 的監控系統來說非常夠用。

---

## 取得金鑰的 4 步驟教學

### 步驟 1：登入 LINE Developers Console
1. 前往 [LINE Developers Console](https://developers.line.biz/console/)。
2. 使用您個人的 LINE 帳號完成登入。

### 步驟 2：建立 Provider 與 Channel
1. 若您尚未擁有任何 Provider，點擊 **Create a new provider** 建立一個（例如可命名為 `UptimeMonitor`）。
2. 進入該 Provider 頁面後，點擊 **Create a new channel**。
3. 服務類型請選擇：**Messaging API**。
4. 依序填寫必填欄位：
   - Channel name (機器人顯示名稱)
   - Channel description (描述)
   - Category (類別，可隨意選)
   - Email (您的信箱)
5. 勾選同意服務條款，並點擊 **Create** 確認建立機器人。

### 步驟 3：獲取 Channel Access Token (環境變數一)
1. 建立完成後，點擊進入您剛成立的 Channel。
2. 切換到 **Messaging API** 分頁。
3. 頁面往下滑到最底部的 **Channel access token (long-lived)** 區塊。
4. 點擊 **Issue** 按鈕產生 Token。
5. 👉 **複製這段超長字串**，這就是您在 Cloudflare 等下要填入的 `LINE_CHANNEL_ACCESS_TOKEN`。

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
