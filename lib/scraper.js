// はま寿司 公式メニューページのスクレイパー
//
// 対象ページ: https://www.hama-sushi.co.jp/menu/
// このページは各カテゴリーが <section class="men-section"> (または div) で区切られ、
// 先頭に <a id="anchor-xxx" class="u-anchor"> が置かれている。
// 地域限定メニュー（にぎり）や、お持ち帰りセットの地域別価格は、
// 親セクション (anchor-local / anchor-takeout) の中にさらに
// div.men-section がネストされる形で入っている。
//
// 商品1件は次の構造:
//   <div class="men-products-list__li">
//     <div class="men-products-item">
//       <div class="men-products-item__thumb"><img data-src="..." ...></div>
//       <div class="men-products-item__content">
//         <div class="men-products-item__text">商品名<br>100円（税込110円）</div>
//         <div class="men-products-item__small">※お持ち帰り不可</div>
//       </div>
//     </div>
//   </div>
//
// サイト構造が変わるとこのスクレイパーは壊れる可能性があります。
// その場合は data/menu.json は前回取得分のまま維持され、次回のcronで再取得を試みます。

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const MENU_URL = 'https://www.hama-sushi.co.jp/menu/';
const ORIGIN = 'https://www.hama-sushi.co.jp';

// anchor-local / anchor-takeout の直下（ネストしていない部分）が
// どの地域を表すか。ここに無い anchor-xxx は「全国」扱い。
const ANCHOR_DIRECT_REGION = {
  'anchor-local': '北海道', // 地域限定セクションの最初のグループは地域名の見出しがなく直下に入っている
};

// ネストされた地域別セクションの anchor -> 地域名
const NESTED_REGION_MAP = {
  'anchor-limited-touhoku': '東北',
  'anchor-limited-kanto': '関東',
  'anchor-limited-hokuriku': '北陸',
  'anchor-limited-tokai': '東海',
  'anchor-limited-kansai': '関西',
  'anchor-limited-chugoku': '中国',
  'anchor-limited-shikoku': '四国',
  'anchor-limited-kyushu': '九州',
  'anchor-limited-okinawa': '沖縄',
};

// anchor-takeout (お持ち帰り) セクションは、まぐろ丼などの丼もの・
// 家族向け複数貫セット・手巻きセットなど「テイクアウト限定」の商品しか無いため、
// 1貫単位のルーレットには馴染まないので丸ごと対象外にする。
// takeout-hokkaido / takeout-toshigata はその中の地域別価格バリエーション(同一商品)。
const SKIP_ANCHORS = new Set(['anchor-takeout', 'anchor-takeout-hokkaido', 'anchor-takeout-toshigata']);

const CATEGORIES = ['nigiri', 'gunkan', 'maki', 'dessert', 'drink', 'noodle', 'fried', 'other'];

const CATEGORY_LABEL = {
  nigiri: '握り',
  gunkan: '軍艦',
  maki: '巻物',
  dessert: 'デザート',
  drink: 'ドリンク',
  noodle: '麺類',
  fried: '揚げ物',
  other: 'その他',
};

/**
 * 商品名とセクション(anchorId)から大まかなジャンルを推定する。
 * 完璧な分類ではないので、明らかにおかしい場合はここを調整してください。
 */
function classify(name, anchorId) {
  // anchor-takeout は SKIP_ANCHORS で除外済みなのでここには来ない
  if (/ラーメン|うどん|そば/.test(name)) return 'noodle';
  if (/から揚げ|唐揚げ|ポテト|たこ焼き/.test(name)) return 'fried';
  if (/軍艦/.test(name)) return 'gunkan';
  if (/巻|ロール/.test(name)) return 'maki';
  if (anchorId === 'anchor-alcohol') return 'drink';
  if (anchorId === 'anchor-dessert') {
    if (/コーラ|カルピス|ファンタ|スプライト|烏龍茶|Qoo|ジュース|コーヒー|ラテ|フロート/.test(name)) {
      return 'drink';
    }
    return 'dessert';
  }
  if (anchorId === 'anchor-side') return 'other';
  if (anchorId === 'anchor-kids') return 'other';
  // 「軍艦・細巻き・その他」セクションの商品で、名前に「軍艦」「巻」等が
  // 含まれないもの（たらマヨ・コーン・まぐろたたき納豆 等）は軍艦ネタとして扱う。
  // ここでの判定漏れがあると、握り(nigiri)の色で表示されてしまう。
  if (anchorId === 'anchor-gunkan') return 'gunkan';
  return 'nigiri'; // にぎり/肉握り/贅沢握り/地域限定 などのデフォルト
}

function regionFor(anchorId, isDirect) {
  if (NESTED_REGION_MAP[anchorId]) return NESTED_REGION_MAP[anchorId];
  if (isDirect && ANCHOR_DIRECT_REGION[anchorId]) return ANCHOR_DIRECT_REGION[anchorId];
  return '全国';
}

function absUrl(src) {
  if (!src) return null;
  if (src.startsWith('http')) return src;
  return ORIGIN + (src.startsWith('/') ? src : `/${src}`);
}

function parsePrice(text) {
  const matches = [...text.matchAll(/税込([\d,]+)円/g)].map((m) => parseInt(m[1].replace(/,/g, ''), 10));
  if (matches.length) return matches[0];
  // フォールバック: 「税込」表記が無い単純な「◯円」
  const fallback = text.match(/([\d,]+)円/);
  return fallback ? parseInt(fallback[1].replace(/,/g, ''), 10) : null;
}

function extractItem($, li, anchorId, region) {
  const $li = $(li);
  const imgSrc = $li.find('.men-products-item__thumb img').attr('data-src')
    || $li.find('.men-products-item__thumb img').attr('src');

  const $text = $li.find('.men-products-item__text').first();
  const textHtml = $text.html() || '';
  const rawLines = textHtml
    .split(/<br\s*\/?>/i)
    .map((s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!rawLines.length) return null;

  // 商品名が <br> で2行に分かれているもの（例: 「フランス直輸入<br>濃厚ガトーショコラ」）があるため、
  // 「円」を含む行が現れるまでを商品名として結合する。
  // （「特上11種セット」のように .men-products-item__text に商品名しか無く、
  //   価格は .men-products-item__small 側にだけ書かれているケースもある）
  const priceLineStart = rawLines.findIndex((l) => /\d+\s*円/.test(l));
  const splitIdx = priceLineStart === -1 ? rawLines.length : Math.max(priceLineStart, 1);
  const name = rawLines.slice(0, splitIdx).join('');
  const textPriceLines = rawLines.slice(splitIdx);
  if (!name) return null;

  const smallTexts = $li
    .find('.men-products-item__small')
    .toArray()
    .map((s) => $(s).text().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const note = smallTexts.length ? smallTexts.join(' / ') : null;

  const priceSourceText = [...textPriceLines, ...smallTexts].join(' ');
  const price = parsePrice(priceSourceText);

  const category = classify(name, anchorId);
  const takeoutUnavailable = !!(note && note.includes('お持ち帰り不可'));

  const id = crypto.createHash('md5').update(`${anchorId}|${region}|${name}`).digest('hex').slice(0, 12);

  return {
    id,
    name,
    price,
    category,
    region,
    note,
    takeoutUnavailable,
    image: absUrl(imgSrc),
  };
}

/**
 * ページ全体を走査し、セクションごとの商品リストを取り出す。
 * ネストしたセクション（地域限定・お持ち帰り地域別価格）は、
 * 親セクションの「直下(direct)」の商品と重複しないよう分離して扱う。
 */
function extractAll($) {
  const items = [];
  const allSections = $('.men-section').toArray();

  for (const sec of allSections) {
    const $sec = $(sec);
    const anchorId = $sec.find('a.u-anchor').first().attr('id');
    if (!anchorId || SKIP_ANCHORS.has(anchorId)) continue;

    // このセクションの中にネストされた .men-section の要素（孫要素含む）
    const nestedSectionEls = $sec.find('.men-section').toArray();
    const nestedLiSet = new Set();
    for (const nsEl of nestedSectionEls) {
      $(nsEl)
        .find('.men-products-list__li')
        .each((_, li) => nestedLiSet.add(li));
    }

    const directLis = $sec
      .find('.men-products-list__li')
      .toArray()
      .filter((li) => !nestedLiSet.has(li));

    if (!directLis.length) continue;

    const region = regionFor(anchorId, true);

    for (const li of directLis) {
      const item = extractItem($, li, anchorId, region);
      if (item) items.push(item);
    }
  }

  // 念のため id で重複排除（同名・同地域・同セクションが重複する場合に後勝ち）
  const map = new Map();
  for (const it of items) map.set(it.id, it);
  return [...map.values()];
}

async function scrapeMenu() {
  const res = await axios.get(MENU_URL, {
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; HamazushiRouletteBot/1.0; personal-use; +https://github.com/) ',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });

  const $ = cheerio.load(res.data);
  const items = extractAll($);

  if (!items.length) {
    throw new Error('商品を1件も取得できませんでした（サイト構造が変わった可能性があります）');
  }

  const regions = [...new Set(items.map((i) => i.region))].sort();

  return {
    updatedAt: new Date().toISOString(),
    sourceUrl: MENU_URL,
    itemCount: items.length,
    categories: CATEGORIES,
    categoryLabels: CATEGORY_LABEL,
    regions,
    items,
  };
}

module.exports = { scrapeMenu, classify, CATEGORIES, CATEGORY_LABEL };

// `node lib/scraper.js` で直接実行した場合は docs/data/menu.json に保存する
// (docs/ はローカルサーバーとGitHub Pagesの両方が配信する共通の静的ファイルフォルダ)
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, '..', 'docs', 'data', 'menu.json');

  scrapeMenu()
    .then((data) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`OK: ${data.itemCount}件を取得し ${outPath} に保存しました`);
    })
    .catch((err) => {
      console.error('スクレイピングに失敗しました:', err.message);
      process.exitCode = 1;
    });
}
