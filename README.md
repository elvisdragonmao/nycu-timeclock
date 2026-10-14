# 陽明交大 受僱者線上自動簽到

在交大學生部分單位的助教費、講師費等等費用會使用「零時工」的方式報時數。因此需要走個流程打卡簽到。不過誰會每天記得要打卡，我每天起床的時間都不固定了。因此寫了一個自動打卡程式，每天自動幫我打卡。

打卡完成會傳送結果到 Discord Webhook 頻道，方便我確認打卡是否成功。

打卡時間（週一到週五，台灣時間）：08:00 簽到、12:01 簽退、12:45 簽到、17:01 簽退，每日兩段各四小時。排程由校內機器的 crontab 執行（[`scripts/crontab.txt`](scripts/crontab.txt)），不用 GitHub Actions 的 `schedule`：實測 GitHub 排程會延遲 2 到 5 小時，工時又以整小時計算，延遲會直接算錯時數。

## 運作方式

1. 用 Playwright 開瀏覽器登入 [NYCU Portal](https://portal.nycu.edu.tw/#/login)。登入表單有 reCAPTCHA v3，所以無法只靠 HTTP 請求登入。
2. 二階段驗證碼由 TOTP secret 自動產生。
3. 前往 `#/redirect/timeclockParttime`，透過 Portal SSO 進入「受僱者線上簽到退」頁面。
4. 對每個進行中的計畫點擊「簽到」或「簽退」，再按確認畫面的「確定」；若確認畫面要求選擇原因（簽到或簽退都可能出現），會自動選「調課」。
5. 從「查詢」頁的打卡紀錄確認結果，並送到 Discord。列表頁的「本日」資訊在半夜到早上之間不會即時更新，查詢頁同一天的紀錄也不一定照時間排序，所以程式會自己依簽到時間排序來判斷。

簽到時若發現還有未簽退的紀錄（例如某次簽退失敗），會先簽退再簽到；30 分鐘內剛簽到的紀錄視為重複執行，直接略過。未簽退超過 6 小時的紀錄會在 Discord 訊息中標示警告，方便確認是否要請計畫主持人調整工時。

## 使用方式

需要一台在校園網路內（或用 VPN 連進校園網路）、可以使用 Docker 的機器，時區設成 `Asia/Taipei`。

```sh
git clone https://github.com/elvisdragonmao/nycu-timeclock.git ~/nycu-timeclock
cd ~/nycu-timeclock
cp .env.example .env # 填入帳號密碼，見下表
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app \
  mcr.microsoft.com/playwright:v1.64.0-noble npx -y pnpm@12.11.2 install --frozen-lockfile
scripts/cron.sh status && tail logs/cron.log  # 確認可以登入
crontab scripts/crontab.txt                   # 會取代目前的 crontab
```

| 變數                  | 說明                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `NYCU_USERNAME`       | 你的交大帳號                                                                                       |
| `NYCU_PASSWORD`       | 你的交大密碼                                                                                       |
| `NYCU_TOTP_SECRET`    | 你的交大帳號的 TOTP (Google Authenticator) secret，可以是 base32 secret 或完整的 `otpauth://` 網址 |
| `DISCORD_WEBHOOK_URL` | 選填，接收打卡結果的 Discord Webhook 網址                                                          |

執行紀錄寫在 `logs/cron.log`。更新程式時執行 `git pull`，若 `pnpm-lock.yaml` 有變動，再跑一次上面的 install 指令。

### 從 GitHub Actions 手動執行

把同一台機器註冊成 self-hosted runner，並在 Settings → Secrets 新增 `USERNAME`、`PASSWORD`、`TOTP`、`DISCORD_WEBHOOK_URL`（對應上表），就可以在 Actions 頁面手動執行 Timeclock workflow，選擇 `status`、`signin` 或 `signout`，並可勾選 dry run。Workflow 在 `mcr.microsoft.com/playwright` 容器中執行，所以 Runner 需要能使用 Docker。Runner 要開機自動啟動的話，在 runner 目錄執行 `sudo ./svc.sh install && sudo ./svc.sh start`。

公開 repo 搭配 self-hosted runner 時，請到 Settings → Actions → General 將 fork pull request 設為「Require approval for all outside collaborators」，避免別人的 PR 在你的機器上執行程式。

## 本機開發

```sh
pnpm install
pnpm exec playwright install chromium
cp .env.example .env # 填入帳號密碼
pnpm start status            # 列出計畫與目前狀態
pnpm start signin --dry-run  # 只判斷、不點擊
pnpm start signin
pnpm start signout
```

失敗時會把截圖與 HTML 存到 `debug/`（已在 `.gitignore` 中，內含個人資料，請勿上傳）。設定 `HEADLESS=false` 可以看到瀏覽器畫面。

## LICENSE

本專案由毛哥EM開發，以 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 授權。
