(() => {
  'use strict';

  const REGION_ORDER = ['北海道', '東北', '関東', '北陸', '東海', '関西', '中国', '四国', '九州', '沖縄'];
  const WINNER_INDEX = 42;
  const TOTAL_SLOTS = 52;
  const SPIN_DURATION_S = 5.4;

  // 価格で絞り込むモード用のプリセット。上限(円)を指定し、税込価格がその値以下のものを対象にする。
  const PRICE_BUCKETS = [
    { id: 'all', label: 'すべて', max: null },
    { id: 'le110', label: '〜110円', max: 110 },
    { id: 'le165', label: '〜165円', max: 165 },
  ];

  const el = {
    updatedAt: document.getElementById('updatedAt'),
    refreshBtn: document.getElementById('refreshBtn'),
    soundBtn: document.getElementById('soundBtn'),
    regionSelect: document.getElementById('regionSelect'),
    modeToggle: document.getElementById('modeToggle'),
    genreControl: document.getElementById('genreControl'),
    priceControl: document.getElementById('priceControl'),
    categoryChecks: document.getElementById('categoryChecks'),
    priceChecks: document.getElementById('priceChecks'),
    poolCount: document.getElementById('poolCount'),
    reelViewport: document.getElementById('reelViewport'),
    reelTrack: document.getElementById('reelTrack'),
    spinBtn: document.getElementById('spinBtn'),
    resultPanel: document.getElementById('resultPanel'),
    resultCard: document.getElementById('resultCard'),
    spinAgainBtn: document.getElementById('spinAgainBtn'),
    errorBanner: document.getElementById('errorBanner'),
  };

  let menuData = null;
  let selectedCategories = new Set();
  let selectedRegion = '';
  let filterMode = 'genre'; // 'genre' | 'price'
  let selectedPriceBucket = 'all';
  let isSpinning = false;
  let soundOn = false;
  let audioCtx = null;

  // ---------- 音 ----------

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    return audioCtx;
  }

  function beep(freq, dur, vol) {
    if (!soundOn) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function tickSound() { beep(600, 0.028, 0.05); }
  function chimeSound() { beep(880, 0.12, 0.07); setTimeout(() => beep(1320, 0.18, 0.07), 90); }

  el.soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    el.soundBtn.textContent = soundOn ? '🔊' : '🔇';
    if (soundOn) ensureAudio();
  });

  // ---------- ユーティリティ ----------

  function fmtPrice(p) {
    return p != null ? `¥${p.toLocaleString('ja-JP')}（税込）` : '価格情報なし';
  }

  function fmtUpdatedAt(iso) {
    if (!iso) return '未取得';
    const d = new Date(iso);
    return d.toLocaleString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }) + ' 時点';
  }

  function showError(msg) {
    el.errorBanner.textContent = msg;
    el.errorBanner.hidden = false;
  }
  function clearError() {
    el.errorBanner.hidden = true;
    el.errorBanner.textContent = '';
  }

  // ---------- データ読み込み ----------
  // "data/menu.json" は相対パスで取得する。ローカルサーバー(server.js)でも
  // GitHub Pages(docs/を公開)でも、同じ相対位置に同じファイルがあるため
  // どちらの環境でも同じコードで動作する。

  let initialLoadAttempts = 0;

  async function fetchMenu() {
    const res = await fetch('data/menu.json', { cache: 'no-store' });
    if (!res.ok) {
      const err = new Error(`メニューデータの取得に失敗しました (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function loadInitial() {
    try {
      const data = await fetchMenu();
      onMenuLoaded(data);
    } catch (err) {
      initialLoadAttempts += 1;
      // ローカルサーバーが起動直後で初回スクレイピング中の場合、data/menu.json がまだ
      // 存在しない(404)ことがあるので、しばらくリトライする。GitHub Pages等サーバーが
      // 無い環境で本当にファイルが無い場合は、一定回数で諦めてエラー表示にする。
      if (err.status === 404 && initialLoadAttempts <= 20) {
        el.updatedAt.textContent = '初回のメニュー取得中...少々お待ちください';
        setTimeout(loadInitial, 3000);
      } else {
        el.updatedAt.textContent = '取得エラー';
        showError(err.message);
      }
    }
  }

  function onMenuLoaded(data) {
    const isFirstLoad = !menuData;
    menuData = data;
    el.updatedAt.textContent = fmtUpdatedAt(data.updatedAt) + `（全${data.itemCount}品）`;
    clearError();

    if (isFirstLoad) {
      buildCategoryChecks(data.categories, data.categoryLabels);
      buildRegionSelect(data.regions || []);
      buildPriceChecks();
    }
    updatePoolCount();
  }

  // ---------- コントロールUI構築 ----------

  function buildCategoryChecks(categories, labels) {
    el.categoryChecks.innerHTML = '';
    categories.forEach((cat) => {
      selectedCategories.add(cat);
      const label = document.createElement('label');
      label.className = 'chk';
      label.innerHTML = `
        <input type="checkbox" checked data-cat="${cat}">
        <span class="dot" style="background: var(--cat-${cat})"></span>
        <span>${labels[cat] || cat}</span>
      `;
      const input = label.querySelector('input');
      input.addEventListener('change', () => {
        if (input.checked) selectedCategories.add(cat);
        else selectedCategories.delete(cat);
        updatePoolCount();
      });
      el.categoryChecks.appendChild(label);
    });
  }

  function buildPriceChecks() {
    el.priceChecks.innerHTML = '';
    PRICE_BUCKETS.forEach((bucket) => {
      const label = document.createElement('label');
      label.className = 'chk';
      label.innerHTML = `
        <input type="radio" name="priceBucket" value="${bucket.id}" ${bucket.id === selectedPriceBucket ? 'checked' : ''}>
        <span>${bucket.label}</span>
      `;
      const input = label.querySelector('input');
      input.addEventListener('change', () => {
        if (input.checked) {
          selectedPriceBucket = bucket.id;
          updatePoolCount();
        }
      });
      el.priceChecks.appendChild(label);
    });
  }

  el.modeToggle.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === filterMode) return;
    filterMode = mode;
    el.modeToggle.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    el.genreControl.hidden = filterMode !== 'genre';
    el.priceControl.hidden = filterMode !== 'price';
    updatePoolCount();
  });

  function buildRegionSelect(regions) {
    const regionSet = new Set(regions.filter((r) => r !== '全国'));
    const ordered = REGION_ORDER.filter((r) => regionSet.has(r));
    // 想定外の地域名が来た場合も表示だけはできるようにしておく
    regionSet.forEach((r) => { if (!ordered.includes(r)) ordered.push(r); });

    for (const r of ordered) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = `${r}の地域限定メニューを追加`;
      el.regionSelect.appendChild(opt);
    }
  }

  el.regionSelect.addEventListener('change', () => {
    selectedRegion = el.regionSelect.value;
    updatePoolCount();
  });

  // ---------- 対象商品の絞り込み ----------

  function getFilteredPool() {
    if (!menuData) return [];
    const priceBucket = PRICE_BUCKETS.find((b) => b.id === selectedPriceBucket) || PRICE_BUCKETS[0];

    return menuData.items.filter((item) => {
      if (item.region !== '全国' && item.region !== selectedRegion) return false;

      if (filterMode === 'price') {
        return priceBucket.max == null || (item.price != null && item.price <= priceBucket.max);
      }
      return selectedCategories.has(item.category);
    });
  }

  function updatePoolCount() {
    const pool = getFilteredPool();
    el.poolCount.textContent = pool.length.toLocaleString('ja-JP');
    el.spinBtn.disabled = pool.length === 0 || isSpinning;
  }

  // ---------- プレート(カード) DOM ----------

  function createPlateEl(item) {
    const plate = document.createElement('div');
    plate.className = 'plate';
    plate.style.setProperty('--cat-color', `var(--cat-${item.category})`);

    const img = document.createElement('div');
    img.className = 'plate-img';
    if (item.image) {
      const imgEl = document.createElement('img');
      imgEl.src = item.image;
      imgEl.alt = '';
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
      const fallback = document.createElement('span');
      fallback.textContent = '🍣';
      fallback.style.display = 'none';
      imgEl.addEventListener('error', () => {
        imgEl.style.display = 'none';
        fallback.style.display = 'flex';
      });
      img.appendChild(imgEl);
      img.appendChild(fallback);
    } else {
      img.textContent = '🍣';
    }

    const name = document.createElement('div');
    name.className = 'plate-name';
    name.textContent = item.name;

    const price = document.createElement('div');
    price.className = 'plate-price';
    price.textContent = item.price != null ? `¥${item.price.toLocaleString('ja-JP')}` : '-';

    plate.appendChild(img);
    plate.appendChild(name);
    plate.appendChild(price);
    return plate;
  }

  // ---------- ルーレット本体 ----------

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function measureSlotStep(track) {
    const children = track.children;
    if (children.length >= 2) {
      const r0 = children[0].getBoundingClientRect();
      const r1 = children[1].getBoundingClientRect();
      const step = r1.left - r0.left;
      if (step > 0) return step;
    }
    return children[0] ? children[0].getBoundingClientRect().width + 16 : 164;
  }

  function spin() {
    if (isSpinning) return;
    const pool = getFilteredPool();
    if (pool.length === 0) {
      showError('対象の商品がありません。ジャンルや地域の選択を見直してください。');
      return;
    }
    clearError();

    const winner = pickRandom(pool);

    // reel 用のダミー配列を組み立てる（WINNER_INDEX の位置だけ本当の当選商品にする）
    const reelItems = [];
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      reelItems.push(i === WINNER_INDEX ? winner : pickRandom(pool));
    }

    isSpinning = true;
    el.spinBtn.disabled = true;
    el.resultPanel.hidden = true;

    el.reelTrack.style.transition = 'none';
    el.reelTrack.style.transform = 'translateX(0px)';
    el.reelTrack.innerHTML = '';

    let winnerEl = null;
    reelItems.forEach((item, i) => {
      const plate = createPlateEl(item);
      if (i === WINNER_INDEX) winnerEl = plate;
      el.reelTrack.appendChild(plate);
    });

    // レイアウトを確定させてから位置を計測する
    // eslint-disable-next-line no-unused-expressions
    el.reelTrack.offsetWidth;

    const viewportRect = el.reelViewport.getBoundingClientRect();
    const winnerRect = winnerEl.getBoundingClientRect();
    const viewportCenterX = viewportRect.left + viewportRect.width / 2;
    const winnerCenterX = winnerRect.left + winnerRect.width / 2;
    const slotStep = measureSlotStep(el.reelTrack);

    const jitter = (Math.random() - 0.5) * slotStep * 0.5;
    const targetX = (viewportCenterX - winnerCenterX) + jitter;

    // ティック音のスケジュール(だいたいのカード通過タイミングに合わせる)
    const totalTicks = WINNER_INDEX;
    for (let i = 1; i <= totalTicks; i++) {
      const progress = 1 - Math.pow(1 - i / totalTicks, 3); // ease-out cubic 近似
      const delay = progress * SPIN_DURATION_S * 1000;
      setTimeout(tickSound, delay);
    }

    requestAnimationFrame(() => {
      el.reelTrack.style.transition = `transform ${SPIN_DURATION_S}s cubic-bezier(0.10, 0.82, 0.13, 1)`;
      el.reelTrack.style.transform = `translateX(${targetX}px)`;
    });

    const onDone = () => {
      el.reelTrack.removeEventListener('transitionend', onDone);
      finishSpin(winner, winnerEl);
    };
    el.reelTrack.addEventListener('transitionend', onDone);
    // フォールバック(transitionendが発火しない環境向け)
    setTimeout(() => {
      if (isSpinning) finishSpin(winner, winnerEl);
    }, SPIN_DURATION_S * 1000 + 300);
  }

  function finishSpin(winner, winnerEl) {
    if (!isSpinning) return; // 二重発火防止
    isSpinning = false;
    if (winnerEl) winnerEl.classList.add('is-winner');
    chimeSound();
    renderResult(winner);
    updatePoolCount();
  }

  function renderResult(item) {
    const imgHtml = item.image
      ? `<img src="${item.image}" alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.remove()">`
      : '🍣';
    el.resultCard.innerHTML = `
      <div class="result-label">今日の一貫はコレ！</div>
      <div class="result-img">${imgHtml}</div>
      <div class="result-name">${escapeHtml(item.name)}</div>
      <div class="result-price">${fmtPrice(item.price)}</div>
      <div class="badges">
        <span class="badge">${escapeHtml(menuData.categoryLabels[item.category] || item.category)}</span>
        <span class="badge">${escapeHtml(item.region)}</span>
      </div>
      ${item.note ? `<div class="result-note">${escapeHtml(item.note)}</div>` : ''}
    `;
    el.resultPanel.hidden = false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  el.spinBtn.addEventListener('click', spin);
  el.spinAgainBtn.addEventListener('click', spin);

  // ---------- 手動更新 ----------

  el.refreshBtn.addEventListener('click', async () => {
    el.refreshBtn.disabled = true;
    el.refreshBtn.textContent = '更新中...';
    clearError();
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        // GitHub Pagesなど、/api/refresh というサーバー機能自体が存在しない環境とみなす。
        throw Object.assign(new Error('NO_BACKEND'), { noBackend: true });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'メニュー更新に失敗しました');
      onMenuLoaded(data);
    } catch (err) {
      if (err.noBackend) {
        try {
          const data = await fetchMenu();
          onMenuLoaded(data);
        } catch {
          // 静的データの再取得にも失敗した場合は、下の案内メッセージだけ出す
        }
        showError('この環境では手動更新はできません。メニューはGitHub Actionsなどが自動で定期更新します。');
      } else {
        showError(err.message);
      }
    } finally {
      el.refreshBtn.disabled = false;
      el.refreshBtn.textContent = '今すぐ更新';
    }
  });

  // ---------- 初期化 ----------

  loadInitial();
})();
