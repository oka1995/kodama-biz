// ANA Chat 自動操作ロジック
// サーバ（src/server.js）から呼ばれる純関数群。
// Playwrightの導入状態を確認するdoctor()と、本処理のrun()を提供する。

import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SHOTS_DIR = path.resolve('screenshots');
const STEP_WAIT_MS = Number(process.env.STEP_WAIT_MS || 10_000);
const FINAL_WAIT_MS = Number(process.env.FINAL_WAIT_MS || 20_000);
const START_URL = process.env.START_URL
  || 'https://www.ana.co.jp/ja/jp/guide/amc/award/international/terms/';
const HEADLESS = process.env.HEADLESS !== '0'; // サーバ運用は既定headless

export const CLASSES = ['エコノミー', 'プレミアムエコノミー', 'ビジネス', 'ファースト'];

// ---------- 入力検証 ----------
export function normalizeDate(s) {
  const m = String(s).match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const yy = Number(y), mm = Number(mo), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}/${mm}/${dd}`;
}
export function normalizeFlight(s) {
  const m = String(s).toUpperCase().replace(/\s+/g, '').match(/^NH(\d{1,4})$/);
  return m ? `NH${m[1]}` : null;
}
export function normalizeCabin(s) {
  return CLASSES.includes(s) ? s : null;
}

// ---------- Playwrightローダ（未導入時のメッセージを分かりやすく） ----------
async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch (e) {
    const hint =
      'Playwrightが未インストールです。プロジェクト直下で次を実行してください:\n' +
      '  npm install\n' +
      '（postinstallでChromiumも自動取得されます。失敗時は「npx playwright install chromium」）';
    throw new Error(`${e.message}\n${hint}`);
  }
}

// ---------- ヘルスチェック ----------
export async function doctor() {
  const report = { ok: false, playwrightInstalled: false, browserLaunchable: false, message: '' };
  let chromium;
  try { chromium = await loadChromium(); report.playwrightInstalled = true; }
  catch (e) { report.message = e.message; return report; }
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
    report.browserLaunchable = true;
    report.ok = true;
    report.message = 'Playwright + Chromium が利用可能です。';
  } catch (e) {
    report.message =
      `Chromiumの起動に失敗しました: ${e.message}\n` +
      '次のコマンドでブラウザバイナリを再導入してください:\n' +
      '  npx playwright install chromium\n' +
      'Linuxの場合は依存ライブラリも必要です:\n' +
      '  npx playwright install-deps chromium';
  }
  return report;
}

// ---------- ブラウザ操作（内部ヘルパ） ----------
async function findChatInput(page, timeoutMs = 30_000) {
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
        } catch { /* ignore */ }
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
  const sendBtn = frame.locator(
    'button:has-text("送信"), button[aria-label*="送信"], button[aria-label*="Send"]'
  ).first();
  if (await sendBtn.count() > 0 && await sendBtn.isVisible().catch(() => false)) {
    await sendBtn.click().catch(() => {});
  }
}

async function shot(page, name) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${Date.now()}_${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

// ---------- 本処理 ----------
export async function run({ date, flight, cabin, log = console.log } = {}) {
  const d = normalizeDate(date);
  const f = normalizeFlight(flight);
  const c = normalizeCabin(cabin);
  if (!d || !f || !c) {
    throw new Error(`入力値が不正です: date=${date}, flight=${flight}, cabin=${cabin}`);
  }

  const chromium = await loadChromium();
  log(`ブラウザ起動 (headless=${HEADLESS})`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'ja-JP',
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const screenshots = [];

  try {
    log(`ページを開く: ${START_URL}`);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3_000);
    screenshots.push(await shot(page, '01_loaded'));

    log('チャット入力欄を探索');
    const target = await findChatInput(page);
    log(`入力欄を検出 (selector: ${target.selectorUsed})`);
    screenshots.push(await shot(page, '02_chat'));

    const sequence = [
      { label: 'menu', text: 'ANA国際線空席待ち人数案内' },
      { label: 'date', text: d },
      { label: 'flight', text: f },
      { label: 'cabin', text: c },
      { label: 'confirm', text: 'はい' },
    ];
    for (let i = 0; i < sequence.length; i++) {
      const { label, text } = sequence[i];
      log(`入力 ${i + 1}/5: ${label} = "${text}"`);
      await sendMessage(target, text);
      await page.waitForTimeout(STEP_WAIT_MS);
      screenshots.push(await shot(page, `step${i + 1}_${label}`));
    }

    log(`最終応答を待機 (${FINAL_WAIT_MS}ms)`);
    await page.waitForTimeout(FINAL_WAIT_MS);
    screenshots.push(await shot(page, '99_final'));

    const text = await target.frame.evaluate(() => document.body?.innerText || '');
    const tail = text.split('\n').slice(-40).join('\n');
    return { text: tail, screenshots };
  } finally {
    await browser.close().catch(() => {});
  }
}
