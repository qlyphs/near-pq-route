// Records the demo video from the live page: one real session (report, both retired-key attacks, a PQ mint
// through its timelock, the recorded upgrade), with captions drawn on the page. Writes the raw recording and
// the segment times that cut.sh uses. Usage: node demo/video/record.mjs <playwright module dir> <out dir>
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const [pwDir, outDir] = process.argv.slice(2);
const { chromium } = createRequire(join(pwDir, 'x.js'))('playwright');
const URL = process.env.DEMO_URL ?? 'https://qlyphs-guardian-demo.qlyphs.workers.dev';
const RECEIVER = process.env.RECEIVER ?? 'alice.testnet';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } } });
const page = await ctx.newPage();
const t0 = Date.now();
const marks = [];
const mark = (name) => { marks.push({ name, t: (Date.now() - t0) / 1000 }); console.log(name, ((Date.now() - t0) / 1000).toFixed(1)); };
const caption = (text) => page.evaluate((t) => {
  let el = document.getElementById('__cap');
  if (!el) {
    el = document.createElement('div'); el.id = '__cap';
    el.style.cssText = 'position:fixed;left:50%;top:28px;transform:translateX(-50%);width:max-content;max-width:1600px;padding:16px 30px;border-radius:16px;background:rgba(10,12,16,.92);border:1px solid #2b313b;color:#fff;font:600 34px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;text-align:center;z-index:99;transition:opacity .25s';
    document.body.appendChild(el);
  }
  el.style.opacity = t ? '1' : '0'; if (t) el.textContent = t;
}, text);
// Scrolls a section under the caption bar, leaving its content visible below it.
const scrollTo = (sel) => page.evaluate((s) => { const y = document.querySelector(s).getBoundingClientRect().top + window.scrollY - 150; window.scrollTo({ top: y, behavior: 'smooth' }); }, sel);
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: 'main{zoom:1.55} section{padding-top:4dvh!important;min-height:auto!important} section.hero{min-height:80dvh!important}' });
mark('intro');
await caption('Qlyphs Guardian: post-quantum admin control for NEAR contracts');
await wait(3500);
mark('verify');
await caption('Check it on chain: no keys left, reviewed code, audited cutover');
await scrollTo('#verify');
await page.waitForFunction(() => document.querySelectorAll('#checks li').length === 9, null, { timeout: 30000 });
await wait(4500);
mark('attack');
await caption('We published the old admin keys. Try them.');
await scrollTo('#attack');
await wait(1500);
await page.click('#attack-mint');
await page.waitForFunction(() => /Refused/.test(document.getElementById('attack-mint-result').textContent), null, { timeout: 30000 });
await wait(2000);
await page.click('#attack-deploy');
await page.waitForFunction(() => /Refused/.test(document.getElementById('attack-deploy-result').textContent), null, { timeout: 30000 });
await caption('The token refuses the old owner. The network refuses the deleted key.');
await wait(3500);
mark('mint');
await caption('A mint now needs 2 of 3 ML-DSA-87 approvals and a 60 s on-chain delay');
await scrollTo('#mint');
await wait(1200);
await page.fill('#receiver', RECEIVER);
await wait(600);
await page.click('#request');
await page.waitForFunction(() => /Queued/.test(document.getElementById('mint-result').textContent), null, { timeout: 60000 });
await wait(2500);
mark('timelock');
await caption('Queued. Nobody can execute it before the delay ends.');
await page.waitForFunction(() => !document.getElementById('execute').disabled, null, { timeout: 120000 });
mark('execute');
await caption('After the delay, anyone can execute it.');
await wait(1200);
await page.click('#execute');
await page.waitForFunction(() => /applied/.test(document.getElementById('exec-result').textContent), null, { timeout: 60000 });
await wait(3500);
mark('history');
await caption('Upgrades go the same way: V1 to V2, balances kept, old code safe if migration fails');
await scrollTo('#history');
await wait(5000);
mark('outro');
await caption('Unaudited testnet prototype · qlyphs-guardian-demo.qlyphs.workers.dev');
await wait(3500);
mark('end');
const video = page.video();
await ctx.close(); await browser.close();
renameSync(await video.path(), join(outDir, 'raw.webm'));
writeFileSync(join(outDir, 'marks.json'), JSON.stringify(marks, null, 2));
