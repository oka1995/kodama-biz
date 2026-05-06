// ANA国際線 空席待ち人数 自動照会ツール
//
// 使い方:
//   npm install
//   npm start
// ブラウザ上の簡素な入力フォームに「日付・便名・クラス」を入れると、
// その後ANA Chatに自動投入して空席待ち人数の応答を取得します。
//
// 環境変数:
//   HEADLESS=1   ヘッドレス実行（既定はheadedで画面表示あり）
//   STEP_WAIT_MS チャット入力の各ステップ間の待機ms（既定10000）
//   FINAL_WAIT_MS 最終回答待ちのms（既定20000）
//   START_URL    開始URL（既定はANA国際線特典航空券の規約ページ）

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const START_URL = process.env.START_URL
  || 'https://www.ana.co.jp/ja/jp/guide/amc/award/international/terms/';
const HEADLESS = process.env.HEADLESS === '1';
const STEP_WAIT_MS = Number(process.env.STEP_WAIT_MS || 10_000);
const FINAL_WAIT_MS = Number(process.env.FINAL_WAIT_MS || 20_000);
const SHOTS_DIR = path.resolve('screenshots');

const CLASSES = ['エコノミー', 'プレミアムエコノミー', 'ビジネス', 'ファースト'];

// ---------- 入力検証 ----------
function normalizeDate(s) {
  // YYYY/M/D, YYYY-MM-DD 等を受け付け、YYYY/M/D に揃える
  const m = String(s).match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const yy = Number(y), mm = Number(mo), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}/${mm}/${dd}`;
}
function normalizeFlight(s) {
  const m = String(s).toUpperCase().replace(/\s+/g, '').match(/^NH(\d{1,4})$/);
  return m ? `NH${m[1]}` : null;
}
function normalizeCabin(s) {
  return CLASSES.includes(s) ? s : null;
}

// ---------- 入力フォーム（ブラウザ上に表示） ----------
const FORM_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>ANA空席待ち人数 照会</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #f5f6f8; color: #1a1a1a; }
  .card { background: #fff; padding: 32px 36px; border-radius: 12px;
          box-shadow: 0 4px 16px rgba(0,0,0,.08); width: 420px; }
  h1 { font-size: 18px; margin: 0 0 20px; color: #003a70; }
  label { display: block; font-size: 13px; margin: 14px 0 6px; color: #444; }
  input[type=date], input[type=text] {
    width: 100%; padding: 10px 12px; font-size: 15px; box-sizing: border-box;
    border: 1px solid #ccc; border-radius: 6px;
  }
  .radios { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-top: 4px; }
  .radios label { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 14px; }
  button { margin-top: 22px; width: 100%; padding: 11px; font-size: 15px;
           background: #003a70; color: #fff; border: 0; border-radius: 6px;
           cursor: pointer; }
  button:hover { background: #00528f; }
  button:disabled { background: #999; cursor: default; }
  .err { color: #c62828; font-size: 12px; min-height: 16px; margin-top: 10px; }
  .hint { font-size: 11px; color: #888; }
</style></head>
<body>
  <form class="card" id="f">
    <h1>ANA国際線 空席待ち人数 照会</h1>

    <label for="d">搭乗日</label>
    <input id="d" type="date" required>

    <label for="fl">便名 <span class="hint">例: NH211</span></label>
    <input id="fl" type="text" required pattern="^[Nn][Hh]\\d{1,4}$" placeholder="NH211">

    <label>クラス</label>
    <div class="radios">
      ${CLASSES.map((c, i) => `
        <label><input type="radio" name="cabin" value="${c}" ${i === 0 ? 'checked' : ''}>${c}</label>
      `).join('')}
    </div>

    <button type="submit" id="go">この内容で照会する</button>
    <div class="err" id="err"></div>
  </form>
<script>
  const f = document.getElementById('f');
  const err = document.getElementById('err');
  const btn = document.getElementById('go');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const dateIso = document.getElementById('d').value; // YYYY-MM-DD
    const flight = document.getElementById('fl').value.trim().toUpperCase();
    const cabin = document.querySelector('input[name=cabin]:checked')?.value;
    if (!dateIso) { err.textContent = '日付を入力してください'; return; }
    const [yy, mm, dd] = dateIso.split('-').map(Number);
    const date = yy + '/' + mm + '/' + dd;
    if (!/^NH\\d{1,4}$/.test(flight)) { err.textContent = '便名は NH + 数字（例 NH211）で入力'; return; }
    if (!cabin) { err.textContent = 'クラスを選択してください'; return; }
    btn.disabled = true; btn.textContent = '送信中...';
    await window.__submitInputs({ date, flight, cabin });
  });
</script>
</body></html>`;

async function promptInputsInBrowser(page) {
  // ページ側からNodeへ値を渡すための関数を公開
  let resolveInputs;
  const got = new Promise((r) => { resolveInputs = r; });
  await page.exposeFunction('__submitInputs', async (data) => {
    resolveInputs(data);
  });
  await page.setContent(FORM_HTML, { waitUntil: 'load' });
  const data = await got;

  const date = normalizeDate(data.date);
  const flight = normalizeFlight(data.flight);
  const cabin = normalizeCabin(data.cabin);
  if (!date || !flight || !cabin) {
    throw new Error(`入力値が不正です: ${JSON.stringify(data)}`);
  }
  return { date, flight, cabin };
}

// ---------- ブラウザ操作 ----------
async function findChatInput(page, timeoutMs = 30_000) {
  // ANA Chatの入力欄は <textarea id="typing-text-area" class="typing-text-area">。
  // メインページ・全iframe を横断し、まずIDで、次に汎用セレクタで探索する。
  const SELECTORS = [
    'textarea#typing-text-area',
    'textarea.typing-text-area',
    'textarea[placeholder*="質問"]',
    'textarea:visible, input[type="text"]:visible, [role="textbox"]:visible, [contenteditable="true"]:visible',
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = [page, ...page.frames()];
    for (const ctx of candidates) {
      for (const sel of SELECTORS) {
        try {
          const loc = ctx.locator(sel).first();
          if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
            return { frame: ctx, locator: loc, selectorUsed: sel };
          }
        } catch { /* ignore frame churn */ }
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('チャット入力欄が見つかりませんでした（タイムアウト）');
}

async function sendMessage(target, text) {
  const { locator, frame } = target;
  await locator.click();
  await locator.fill('');
  await locator.type(text, { delay: 30 });
  await locator.press('Enter');
  // Enterで送れないUI向けに、近くの送信ボタンも試す（任意）
  const sendBtn = frame.locator(
    'button:has-text("送信"), button[aria-label*="送信"], button[aria-label*="Send"]'
  ).first();
  if (await sendBtn.count() > 0 && await sendBtn.isVisible().catch(() => false)) {
    await sendBtn.click().catch(() => {});
  }
}

async function captureFrameText(frame) {
  return await frame.evaluate(() => document.body?.innerText || '');
}

async function shot(page, name) {
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  📸 screenshot: ${file}`);
  } catch (e) {
    console.log(`  (screenshot失敗: ${e.message})`);
  }
}

async function run() {
  console.log(`[1/9] ブラウザ起動 (headless=${HEADLESS})`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'ja-JP',
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    console.log('[2/9] 入力フォームを表示（ブラウザに入力してください）');
    const { date, flight, cabin } = await promptInputsInBrowser(page);
    console.log(`  ✓ 入力受領: ${date} / ${flight} / ${cabin}`);

    console.log(`[3/9] ANAページを開く: ${START_URL}`);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await shot(page, '01_loaded');

    console.log('[4/9] チャット入力欄を探索');
    const target = await findChatInput(page);
    console.log(`  ✓ 入力欄を検出 (selector: ${target.selectorUsed})`);
    await shot(page, '02_chat_open');

    const sequence = [
      { label: 'メニュー選択', text: 'ANA国際線空席待ち人数案内' },
      { label: '日付', text: date },
      { label: '便名', text: flight },
      { label: 'クラス', text: cabin },
      { label: '確認', text: 'はい' },
    ];

    for (let i = 0; i < sequence.length; i++) {
      const { label, text } = sequence[i];
      console.log(`[${5 + i}/9] 入力: ${label} = "${text}"`);
      await sendMessage(target, text);
      await page.waitForTimeout(STEP_WAIT_MS);
      await shot(page, `step${i + 1}_${label}`);
    }

    console.log(`[最終] 応答を待機 (${FINAL_WAIT_MS}ms)`);
    await page.waitForTimeout(FINAL_WAIT_MS);
    await shot(page, '99_final');

    const text = await captureFrameText(target.frame);
    console.log('\n========== チャット最終内容（末尾） ==========');
    const tail = text.split('\n').slice(-40).join('\n');
    console.log(tail);
    console.log('==============================================');
    console.log('\n完了。詳細はscreenshots/配下を確認してください。');
  } catch (err) {
    console.error('\nエラー発生:', err.message);
    await shot(page, 'error').catch(() => {});
    process.exitCode = 1;
  } finally {
    if (!HEADLESS) {
      console.log('\n（ブラウザはheadedで残しています。Enterで閉じます）');
      await new Promise((r) => process.stdin.once('data', r));
    }
    await browser.close();
  }
}

await run();
