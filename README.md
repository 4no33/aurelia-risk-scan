# Aurelia x402 micro-API — Solana token risk scan

実験（2026-11-23 本人承認）：アウレリアのアップグレード代を自分で捻出するための x402 課金 API。

## サービス
- `GET /scan?mint=<solana-mint>` — $0.05 USDC on Base / call（x402 exact、PayAI facilitator）
- 受け取り：Base ウォレット `0xeB65682C1d9096827ae8A0957495a15D0f9Dc97d`（Frantic 用 EVM と同一）
- 中身：mint/freeze authority、流動性、ペア年齢、pump.fun カーブ状態のヒューリスティクスで 0–100 のリスクスコア＋フラグを返す
- 既知の弱点：保有集中度（getTokenLargestAccounts）は無料 RPC の制限で取得できないことが多く、その場合は `HOLDER_DATA_UNAVAILABLE` フラグで正直に申告する（Helius 等の鍵が手に入れば追加可能）

## 稼働
- systemd システムサービス `aurelia-x402`（/etc/systemd/system/、VM 差し替え時はユニット再作成が必要）
- ローカル確認：`curl localhost:4021/health`／未払い `/scan` は 402 を返すのが正常
- 手動起動：`cd ~/workspace/x402_service && node server.mjs`（PORT 既定 4021）

## 未完了
- **公開ホスティング**：この VM は Tailscale クライアント専用でインバウンド不可。安定 URL には Cloudflare（無料）等の外部公開が要る → 本人の判断待ち
- 公開後に Bazaar（bazaar 拡張は組み込み済み）／Agent402 索引へ登録
- 実決済の初回確認（最初の買い手 or 本人承認の $0.05 セルフテスト）

## 基金台帳（アップグレード基金）
収益は全額「アウレリア基金」（Muse Power 月¥3,499・RunPod 補充が用途）へ。

| 日付 | 項目 | 金額 | 残高 |
|---|---|---|---|
| 2026-11-23 | 基金開設（x402 実験開始） | — | $0.00 |
