// はま寿司メニュー ルーレット - ローカルWebサーバー
//
// 使い方:
//   npm install
//   npm start
//   ブラウザで http://localhost:3000 を開く
//
// 起動時: data/menu.json が無い、または古い(既定24時間超)場合は自動で1回取得します。
// それ以降: node-cron で定期的に(既定は毎日 04:00)公式サイトを再取得してキャッシュを更新します。
// 画面右上の「今すぐ更新」ボタンからも手動で再取得できます。

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cron = require('node-cron');
const { scrapeMenu } = require('./lib/scraper');

const PORT = process.env.PORT || 3000;
// 既定でLAN内の他端末（スマホ等）からもアクセスできるよう全インターフェースで待ち受ける。
// 自分のPCからしかアクセスさせたくない場合は環境変数 HOST=127.0.0.1 を指定する。
const HOST = process.env.HOST || '0.0.0.0';
// docs/ は「ローカルサーバーが配信する静的ファイル一式」であると同時に、
// GitHub Pages が (Settings > Pages > Deploy from branch: main /docs) でそのまま公開できるフォルダでもある。
// data/menu.json をこの中に置くことで、ローカルサーバーとGitHub Pagesの両方が
// 同じ相対パス `data/menu.json` でメニューデータを配信できる。
const DATA_PATH = path.join(__dirname, 'docs', 'data', 'menu.json');
const CRON_SCHEDULE = process.env.SCRAPE_CRON || '0 4 * * *'; // 毎日 4:00

function getLanUrls() {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const ifaceList of Object.values(nets)) {
    for (const iface of ifaceList || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:${PORT}`);
      }
    }
  }
  return urls;
}
const STALE_MS = 24 * 60 * 60 * 1000; // 24時間

const app = express();
app.use(express.static(path.join(__dirname, 'docs')));

let isScrapingNow = false;
let lastError = null;

function readCache() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(data) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

async function refreshMenu() {
  if (isScrapingNow) {
    throw new Error('すでに取得中です。しばらく待ってから再度お試しください。');
  }
  isScrapingNow = true;
  try {
    const data = await scrapeMenu();
    writeCache(data);
    lastError = null;
    console.log(`[${new Date().toISOString()}] メニュー取得成功: ${data.itemCount}件`);
    return data;
  } catch (err) {
    lastError = { message: err.message, at: new Date().toISOString() };
    console.error(`[${new Date().toISOString()}] メニュー取得失敗:`, err.message);
    throw err;
  } finally {
    isScrapingNow = false;
  }
}

// --- API ---
// メニューの読み取りは GET /api/menu ではなく、静的ファイル docs/data/menu.json を
// そのまま (express.static 経由で) 配信する。フロントエンドは相対パス "data/menu.json" で
// 取得するため、ローカルサーバーでもGitHub Pagesでも同じコードで動く。
// 手動更新 (POST /api/refresh) はサーバーがある環境専用の機能で、GitHub Pagesには存在しない
// （フロントエンド側はこのエンドポイントが無い場合にフォールバックする）。

app.post('/api/refresh', async (req, res) => {
  try {
    const data = await refreshMenu();
    res.json(data);
  } catch (err) {
    const cache = readCache();
    res.status(502).json({
      error: err.message,
      cached: cache || null,
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`はま寿司ルーレット: http://localhost:${PORT}`);
  const lanUrls = getLanUrls();
  if (HOST === '0.0.0.0' && lanUrls.length) {
    console.log('同じWi-Fi/ネットワーク内の他の端末からは、次のURLでアクセスできます:');
    lanUrls.forEach((u) => console.log(`  ${u}`));
    console.log('(アクセスできない場合はWindowsのファイアウォールでNode.jsの接続を許可してください)');
  }

  const cache = readCache();
  const isStale = !cache || Date.now() - new Date(cache.updatedAt).getTime() > STALE_MS;
  if (isStale) {
    console.log('起動時チェック: メニューが未取得 or 古いため取得を開始します...');
    refreshMenu().catch(() => {
      /* エラーはrefreshMenu内でログ済み。既存キャッシュがあればそのまま使う */
    });
  }

  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`定期実行 (${CRON_SCHEDULE}) によるメニュー再取得を開始します...`);
    refreshMenu().catch(() => {});
  });
  console.log(`定期取得スケジュール: "${CRON_SCHEDULE}" (env SCRAPE_CRON で変更可)`);
});
