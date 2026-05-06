// ANA空席待ち人数照会 ローカルWebサーバ
//
// 起動:
//   npm start
// → 端末に表示されるURLをPC/スマホ（同じWi-Fi）のブラウザで開いて使う。
//
// 環境変数:
//   PORT     リッスンポート（既定 3000）
//   HOST     バインドアドレス（既定 0.0.0.0 = LAN内に公開）
//   HEADLESS 0=ブラウザ画面を表示、1=非表示（既定1）

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { run as runAutomation, doctor, CLASSES } from './automate.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SHOTS_DIR = path.resolve('screenshots');

let busy = false;

const FORM_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ANA空席待ち人数</title>
<style>
  :root { color-scheme: light; --ana:#003a70; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif;
         margin: 0; padding: 16px; background: #f5f6f8; color: #1a1a1a; }
  .card { background:#fff; padding:20px; border-radius:12px; max-width:520px;
          margin:0 auto; box-shadow:0 4px 16px rgba(0,0,0,.08); }
  h1 { font-size:17px; margin:0 0 16px; color:var(--ana); }
  label { display:block; font-size:13px; margin:14px 0 6px; color:#444; }
  input[type=date], input[type=text] {
    width:100%; padding:12px; font-size:16px; /* 16px未満はiOSで自動ズーム */
    border:1px solid #ccc; border-radius:8px; background:#fff;
  }
  .radios { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:4px; }
  .radios label { margin:0; padding:12px; border:1px solid #ccc; border-radius:8px;
                  display:flex; align-items:center; gap:8px; font-size:15px;
                  background:#fff; cursor:pointer; }
  .radios input { width:18px; height:18px; }
  button { margin-top:20px; width:100%; padding:14px; font-size:16px;
           background:var(--ana); color:#fff; border:0; border-radius:8px; cursor:pointer; }
  button:disabled { background:#999; }
  .err { color:#c62828; font-size:13px; min-height:18px; margin-top:10px; }
  .hint { font-size:11px; color:#888; }
  #log { white-space:pre-wrap; background:#0b1020; color:#cfe; padding:12px;
         border-radius:8px; font-size:12px; max-height:160px; overflow:auto;
         margin-top:14px; display:none; font-family:ui-monospace,Menlo,monospace; }
  #result { display:none; margin-top:16px; padding:14px; background:#eef5ff;
            border-radius:8px; white-space:pre-wrap; font-size:14px; }
  .health { font-size:12px; color:#666; margin-top:10px; }
  .ok { color:#2e7d32; } .ng { color:#c62828; }
</style></head>
<body>
  <form class="card" id="f">
    <h1>ANA国際線 空席待ち人数</h1>

    <label for="d">搭乗日</label>
    <input id="d" type="date" required>

    <label for="fl">便名 <span class="hint">例: NH211</span></label>
    <input id="fl" type="text" inputmode="text" autocapitalize="characters"
           required pattern="^[Nn][Hh]\\d{1,4}$" placeholder="NH211">

    <label>クラス</label>
    <div class="radios">
      ${CLASSES.map((c, i) => `
        <label><input type="radio" name="cabin" value="${c}" ${i === 0 ? 'checked' : ''}>${c}</label>
      `).join('')}
    </div>

    <button type="submit" id="go">この内容で照会する</button>
    <div class="err" id="err"></div>
    <div class="health" id="health">起動状態を確認中...</div>
    <pre id="log"></pre>
    <div id="result"></div>
  </form>

<script>
  const $ = (id) => document.getElementById(id);
  const f = $('f'), err = $('err'), btn = $('go'), log = $('log'), result = $('result'), health = $('health');

  fetch('/healthz').then(r => r.json()).then(r => {
    health.textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
    health.className = 'health ' + (r.ok ? 'ok' : 'ng');
    if (!r.ok) btn.disabled = true;
  }).catch(() => { health.textContent = '✗ ヘルスチェック失敗'; });

  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = ''; result.style.display='none'; log.style.display='block'; log.textContent='';
    const dateIso = $('d').value;
    const flight = $('fl').value.trim().toUpperCase();
    const cabin = document.querySelector('input[name=cabin]:checked')?.value;
    if (!dateIso) { err.textContent = '日付を入力してください'; return; }
    const [yy, mm, dd] = dateIso.split('-').map(Number);
    const date = yy + '/' + mm + '/' + dd;
    if (!/^NH\\d{1,4}$/.test(flight)) { err.textContent = '便名は NH+数字 で入力'; return; }
    if (!cabin) { err.textContent = 'クラスを選択してください'; return; }

    btn.disabled = true; btn.textContent = '照会中... (1〜2分かかります)';
    log.textContent = '送信: ' + JSON.stringify({date, flight, cabin}) + '\\n';
    try {
      const r = await fetch('/check', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({date, flight, cabin}),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || 'unknown error');
      result.textContent = r.text || '(応答テキストなし)';
      result.style.display = 'block';
      if (r.screenshotUrl) {
        const img = document.createElement('img');
        img.src = r.screenshotUrl; img.style.width = '100%'; img.style.marginTop='12px';
        img.style.borderRadius='8px'; img.style.border='1px solid #ccc';
        result.appendChild(img);
      }
      log.textContent += '完了\\n';
    } catch (e) {
      err.textContent = 'エラー: ' + e.message;
      log.textContent += 'ERROR: ' + e.message + '\\n';
    } finally {
      btn.disabled = false; btn.textContent = 'この内容で照会する';
    }
  });
</script>
</body></html>`;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) reject(new Error('payload too large')); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isStr ? (headers['Content-Type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return send(res, 200, FORM_HTML, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      const r = await doctor();
      return send(res, r.ok ? 200 : 503, r);
    }
    if (req.method === 'GET' && req.url.startsWith('/screenshots/')) {
      const file = path.join(SHOTS_DIR, path.basename(req.url));
      if (!existsSync(file)) return send(res, 404, 'not found');
      return send(res, 200, readFileSync(file), { 'Content-Type': 'image/png' });
    }
    if (req.method === 'POST' && req.url === '/check') {
      if (busy) return send(res, 429, { ok: false, error: '別の照会が実行中です。しばらく待ってください。' });
      busy = true;
      try {
        const body = await readJson(req);
        console.log('[check]', body);
        const { text, screenshots } = await runAutomation({ ...body, log: (m) => console.log('  ', m) });
        const last = screenshots[screenshots.length - 1];
        const url = last ? '/screenshots/' + path.basename(last) : null;
        return send(res, 200, { ok: true, text, screenshotUrl: url });
      } catch (e) {
        console.error('[check] error:', e);
        return send(res, 500, { ok: false, error: e.message });
      } finally {
        busy = false;
      }
    }
    return send(res, 404, 'not found');
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
});

function lanIps() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, async () => {
  console.log(`\nANA空席待ちチェッカー サーバ起動`);
  console.log(`  ローカル:  http://localhost:${PORT}`);
  for (const ip of lanIps()) {
    console.log(`  スマホから: http://${ip}:${PORT}   ← 同じWi-Fiのスマホでこのアドレスを開く`);
  }
  console.log('\nPlaywrightの状態を確認中...');
  const r = await doctor();
  console.log(r.ok ? '  ✓ ' + r.message : '  ✗ ' + r.message);
  if (!r.ok) console.log('  → 上記の指示にしたがってセットアップしてください。');
});
