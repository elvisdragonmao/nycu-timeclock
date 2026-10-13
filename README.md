# 陽明交大 受僱者線上自動簽到

在交大學生部分單位的助教費、講師費等等費用會使用「零時工」的方式報時數。因此需要走個流程打卡簽到。不過誰會每天記得要打卡，我每天起床的時間都不固定了。因此寫了一個自動打卡的 GitHub Actions 來讓我每天自動幫我打卡。

打卡完成會傳送結果到 Discord Webhook 頻道，方便我確認打卡是否成功。

## 使用方式

在 GitHub 上 fork 這個專案，然後在 Settings -> Secrets 裡面新增以下幾個 Secret：

| Secret 名稱 | 說明 | 範例 |
| ----------- | ---- | ---- |
| USERNAME | 你的交大帳號 |
| PASSWORD | 你的交大密碼 |
| TOTP | 你的交大帳號的 TOTP (Google Authenticator) secret |

## VPN

由於學校的打卡系統需要在校園網路內才能使用，因此請使用自己的機器作為 Actions Runner，並確保機器網路在學校裡面，或是使用 VPN 連線到校園網路。

## LICENSE

本專案由毛哥EM開發，以 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 授權。
