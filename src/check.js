// ANA国際線 空席待ち人数 自動照会ツール
//
// 使い方:
//   npm install
//   npm start
// ユーザに「日付・便名・クラス」を対話的に尋ね、ANA Chatに自動投入して
// 空席待ち人数の応答を取得します。
//
// 環境変数:
//   HEADLESS=1   ヘッドレス実行（既定はheadedで画面表示あり）
//   STEP_WAIT_MS チャット入力の各ステップ間の待機ms（既定10000）
//   FINAL_WAIT_MS 最終回答待ちのms（既定20000）
//   START_URL    開始URL（既定はANA国際線特典航空券の規約ページ）

import { chromium } from 'playwright';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const START_URL = process.env.START_URL
  || 'https://www.ana.co.jp/ja/jp/guide/amc/award/international/terms/';
const HEADLESS = process.env.HEADLESS === '1';
const STEP_WAIT_MS = Number(process.env.STEP_WAIT_MS || 10_000);
const FINAL_WAIT_MS = Number(process.env.FINAL_WAIT_MS || 20_000);
const SHOTS_DIR = path.resolve('screenshots');

const CLASSES = ['エコノミー', 'プレミアムエコノミー', 'ビジネス', 'ファースト'];

// ---------- 入力フェーズ ----------
async function promptInputs() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('--- ANA国際線 空席待ち人数 照会 ---');
    const dateRaw = (await rl.question('搭乗日 (YYYY/M/D 例 2026/7/15): ')).trim();
    const date = normalizeDate(dateRaw);
    if (!date) throw new Error(`日付の形式が不正です: ${dateRaw}`);

    const flightRaw = (await rl.question('便名 (例 NH211): ')).trim();
    const flight = normalizeFlight(flightRaw);
    if (!flight) throw new Error(`便名の形式が不正です: ${flightRaw}`);

    console.log('クラス:');
    CLASSES.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
    const cabinRaw = (await rl.question('番号 または クラス名: ')).trim();
    const cabin = normalizeCabin(cabinRaw);
    if (!cabin) throw new Error(`クラスの指定が不正です: ${cabinRaw}`);

    console.log(`\n入力内容: ${date} / ${flight} / ${cabin}`);
    const ok = (await rl.question('この内容で実行しますか? [y/N]: ')).trim().toLowerCase();
    if (ok !== 'y' && ok !== 'yes') {
      console.log('中止しました。');
      process.exit(0);
    }
    return { date, flight, cabin };
  } finally {
    rl.close();
  }
}

function normalizeDate(s) {
  // YYYY/M/D, YYYY/MM/DD, YYYY-M-D 等を受け付け、YYYY/M/D に揃える
  const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const yy = Number(y), mm = Number(mo), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}/${mm}/${dd}`;
}

function normalizeFlight(s) {
  const m = s.toUpperCase().replace(/\s+/g, '').match(/^NH(\d{1,4})$/);
  if (!m) return null;
  return `NH${m[1]}`;
}

function normalizeCabin(s) {
  if (/^[1-4]$/.test(s)) return CLASSES[Number(s) - 1];
  if (CLASSES.includes(s)) return s;
  return null;
}

// ---------- ブラウザ操作 ----------
async function findChatInput(page, timeoutMs = 30_000) {
  // チャットウィジェットは iframe 内の可能性が高い。
  // ページ・全フレームから「表示されている textbox / textarea / 入力可能な
  // contenteditable」を一定時間ポーリングで探す。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = [page, ...page.frames()];
    for (const ctx of candidates) {
      try {
        const loc = ctx.locator(
          'textarea:visible, input[type="text"]:visible, [role="textbox"]:visible, [contenteditable="true"]:visible'
        ).first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
          return { frame: ctx, locator: loc };
        }
      } catch { /* ignore frame churn */ }
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
  // まずEnterで送信を試行
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
  // チャットフレーム内の可視テキストをまるごと取得（最終応答抽出のため）
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

async function run({ date, flight, cabin }) {
  console.log(`\n[1/8] ブラウザ起動 (headless=${HEADLESS})`);
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
    console.log(`[2/8] ページを開く: ${START_URL}`);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3_000); // チャットがインしてくるのを待つ
    await shot(page, '01_loaded');

    console.log('[3/8] チャット入力欄を探索');
    const target = await findChatInput(page);
    console.log('  ✓ 入力欄を検出');
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
      console.log(`[${4 + i}/8] 入力: ${label} = "${text}"`);
      await sendMessage(target, text);
      await page.waitForTimeout(STEP_WAIT_MS);
      await shot(page, `step${i + 1}_${label}`);
    }

    console.log(`[8/8] 最終応答を待機 (${FINAL_WAIT_MS}ms)`);
    await page.waitForTimeout(FINAL_WAIT_MS);
    await shot(page, '99_final');

    const text = await captureFrameText(target.frame);
    console.log('\n========== チャット最終内容（末尾） ==========');
    // ノイズ低減のため末尾の数十行のみ表示
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

// ---------- エントリポイント ----------
const inputs = await promptInputs();
await run(inputs);
