# はま寿司メニュー ルーレット

はま寿司の公式メニュー（https://www.hama-sushi.co.jp/menu/）を定期的に自動取得し、
回転寿司のレーンが流れてくるような演出（CS:GOのクレート開封風の減速アニメーション）で
ランダムに一品を決めてくれるWebアプリです。

- 自分のPCで動かす（ローカル / 同じWi-Fi内の他端末からもアクセス可）
- GitHub Pages + GitHub Actions で公開する（PCを起動していなくても外出先からアクセス可）

のどちらでも動くように作られています。フロントエンドはフレームワーク不使用（素のHTML/CSS/JS）です。

非公式のファンツールです。価格・品揃えは店舗や時期によって異なる場合があるので、
実際の注文は店舗の表示でご確認ください。

## 1. ローカルで動かす

```bash
npm install
npm start
```

起動後、ブラウザで `http://localhost:3000` を開いてください。

- 初回起動時に自動でメニューを1回取得します（数秒〜十数秒かかります）。
- 以降は毎日 04:00（既定）に自動で再取得し、画面右上の「今すぐ更新」ボタンからも手動更新できます。
- 起動時のログに、同じWi-Fi内の他端末（スマホなど）からアクセスできるURL（`http://<PCのIPアドレス>:3000`）が表示されます。

更新頻度を変えたい場合は環境変数 `SCRAPE_CRON` に cron 形式で指定してください。

```bash
# 6時間ごとに取得する例 (Windows PowerShell)
$env:SCRAPE_CRON = "0 */6 * * *"; npm start
```

## 2. GitHub Pagesで公開する（外出先からアクセスしたい場合）

PCを起動していなくても、いつでも・どこからでもアクセスできるようにするには、
GitHub Pages（静的ホスティング）+ GitHub Actions（定期スクレイピング）を使います。
この場合サーバー(server.js)は使わず、`docs/` フォルダがそのまま公開されます。

1. GitHubに新しいリポジトリを作成し、このプロジェクト一式をpushする
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
   git push -u origin main
   ```
2. リポジトリの **Settings → Pages** で、Source を
   **Deploy from a branch** / Branch: `main` / Folder: `/docs` に設定して Save
3. **Settings → Actions → General** で Workflow permissions を
   **Read and write permissions** にしておく（`.github/workflows/update-menu.yml` がコミットをpushするため）
4. 数分待つと `https://<あなたのユーザー名>.github.io/<リポジトリ名>/` で公開されます

以降は `.github/workflows/update-menu.yml` が毎日自動で `docs/data/menu.json` を
再取得してコミットし、Pagesに反映されます。すぐに最新化したい場合は、
GitHubリポジトリの **Actions タブ → Update menu data → Run workflow** から手動実行できます
（画面上の「今すぐ更新」ボタンはサーバーが無い環境では使えないため、案内メッセージが表示されます）。

> 無料のGitHub Pagesは公開リポジトリが必要です。ソースコードと自動更新されるメニューデータが
> 誰でも閲覧できる状態になる点にご注意ください。

## 機能

- 🍣 レーンが流れてから減速して1品に止まる、クレート開封風のルーレット演出。当選した一貫は弾むように拡大表示
- 🌎 地域選択: 「関東」などを選ぶと、その地域限定メニューも候補に追加されます（全国共通メニューは常に対象）
- ☑️ ジャンルのON/OFF: 握り・軍艦・巻物・デザート・ドリンク・麺類・揚げ物・その他をチェックボックスで対象から外せます
- 💰 価格モード: ジャンルの代わりに「〜110円」「〜165円」など価格帯で絞り込むモードに切り替え可能
- 🔄 定期自動取得 + 手動更新ボタン（ローカルサーバー環境のみ）
- 🔊 効果音のON/OFF（既定はOFF）
- 📱 スマホ表示に最適化（タップしやすいボタンサイズ、狭い画面向けレイアウト）

## 仕組み・構成

```
server.js               Expressサーバー。/api/refresh、node-cronでの定期取得、docs/を配信
lib/scraper.js           公式サイトをスクレイピングして docs/data/menu.json を生成するロジック
docs/                    公開される静的ファイル一式（ローカルサーバー・GitHub Pages共通）
  index.html / style.css / app.js   フロントエンド本体
  data/menu.json          取得結果のキャッシュ（自動生成・自動更新されます）
.github/workflows/update-menu.yml   GitHub Actionsでの定期スクレイピング＆自動コミット
```

フロントエンド (`docs/app.js`) は常に相対パス `data/menu.json` からメニューを読み込みます。
ローカルサーバーもGitHub Pagesも同じ場所に同じ形式のJSONを置くことで、
コードを変えずに両方の環境で動くようにしています。

### ジャンル分類について

公式サイトはHTMLの見出し(セクション)と商品名から、握り/軍艦/巻物/デザート/ドリンク/麺類/揚げ物/その他を
推定で振り分けています（完全に公式のカテゴリ分けではありません）。分類ルールは
`lib/scraper.js` の `classify()` 関数にまとまっているので、ずれが気になる場合はここを調整してください。

なお「お持ち帰り」限定の丼もの・複数貫セット・手巻きセットは、1貫単位のルーレットに
馴染まないため取得対象から除外しています。

### スクレイピングについて

- 対象は `https://www.hama-sushi.co.jp/menu/` の公開ページのみで、`robots.txt` 上も
  このパスへのアクセス制限はありません。
- 個人利用目的で、既定では1日1回程度の低頻度アクセスにしています。過度に高頻度な設定は避けてください。
- サイトの構造（HTMLのクラス名など）が変わるとスクレイピングが失敗することがあります。
  その場合は前回取得したキャッシュ (`docs/data/menu.json`) がそのまま使われ、次回の定期実行時に再度取得を試みます。

## 手動でスクレイピングだけ試す

```bash
npm run scrape
```

`docs/data/menu.json` が更新されます。
