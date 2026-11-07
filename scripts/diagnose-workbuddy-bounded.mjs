// Single-account diagnostic: read-only local DB, one start, no poll or account writes.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decrypt, totpCode } from '../server/crypto.js';
import { OAuthBrowser, trustedOrigin } from '../server/oauth-browser.js';

const [jobId, positionText] = process.argv.slice(2);
const inspectConsent = process.argv.includes('--inspect-consent');
const position = Number(positionText);
if (!jobId || !Number.isInteger(position) || position < 1) throw new Error('Specify job and position');
const db = new DatabaseSync(resolve('data/accounts.sqlite'), { readOnly: true });
let account, target;
try {
  for (const table of ['workbuddy_jobs', 'integration_jobs']) {
    if (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE running=1`).get().n) throw new Error('An authorization job is running');
  }
  const item = db.prepare('SELECT i.accountId,i.status,j.targetId FROM workbuddy_items i JOIN workbuddy_jobs j ON i.jobId=j.id WHERE i.jobId=? AND i.position=?').get(jobId, position);
  if (!item || !(['unknown','skipped'].includes(item.status) || (inspectConsent && item.status === 'restricted'))) throw new Error('Diagnostic requires an unconfirmed item or consent inspection');
  account = db.prepare('SELECT id,username,email,password,totp,reservedBy FROM accounts WHERE id=? AND deletedAt IS NULL AND selectedAt IS NULL AND patDedicated=0').get(item.accountId);
  if (!account || account.reservedBy) throw new Error('Account is deleted, missing, used or reserved');
  target = db.prepare('SELECT * FROM integration_targets WHERE id=?').get(item.targetId);
} finally { db.close(); }
const key = readFileSync(resolve('data/master.key'));
const seed = decrypt(account.totp, key);
if (!seed || !/^\d{6}$/.test(totpCode(seed).code)) throw new Error('A valid configured TOTP account is required');
const directory = resolve('output', 'workbuddy-bounded-' + Date.now());
mkdirSync(directory, { recursive: true });
const report = { jobId, position, startedAt: new Date().toISOString(), events: [] };
function record(event) {
  report.events.push({ at: new Date().toISOString(), ...event });
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(event));
}
const controller = new AbortController();
let session, expired = false, deadlineTimer;
const deadline = new Promise((_, reject) => {
  deadlineTimer = setTimeout(() => { expired = true; controller.abort(); void session?.close().catch(() => {}); reject(new Error('diagnostic_timeout')); }, 180000);
});
const bounded = operation => Promise.race([Promise.resolve().then(operation), deadline]);
try {
  // Do not retry: this request creates a remote authorization session.
  const data = await bounded(async () => {
    const response = await fetch(target.baseUrl + '/panel/api/login/start', {
      method: 'POST', redirect: 'manual',
      headers: { Authorization: 'Bearer ' + decrypt(target.apiKey, key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ realm: 'global' }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    record({ stage: 'start', http: response.status });
    if (!response.ok) throw new Error('start_failed');
    return response.json();
  });
  if (data.ok !== true || data.realm !== 'global' || trustedOrigin(data.url) !== 'workbuddy') throw new Error('invalid_start');
  session = await bounded(async () => {
    const opened = await new OAuthBrowser().open({
      url: data.url, account: { id: account.id, username: account.username, email: account.email },
      proxy: target.browserProxy ? JSON.parse(decrypt(target.browserProxy, key)) : null,
      signal: controller.signal,
      getSecrets: () => { const totp = decrypt(account.totp, key); return { password: decrypt(account.password, key), otp: totp ? totpCode(totp) : null }; },
    });
    if (expired) { await opened.close(); throw new Error('diagnostic_timeout'); }
    return opened;
  });
  let result;
  if (inspectConsent) session.clickAuthorization = async () => ({ status: 'manual', reason: 'diagnostic_consent_hold' });
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      await bounded(() => delay(3000 * (attempt - 1), undefined, { signal: controller.signal }));
      if (['network', 'proxy'].includes(result?.reason)) await bounded(() => session.retryNavigation());
    }
    result = await bounded(() => session.step());
    record({ attempt, status: result.status, reason: result.reason, diagnostic: session.diagnostic() });
    if (inspectConsent) {
      const page = session.context.pages().filter(page => !page.isClosed()).at(-1);
      if (trustedOrigin(page?.url()) === 'github' && new URL(page.url()).pathname === '/login/oauth/authorize') {
        const inspect = () => page.evaluate(() => ({
          metaCount: document.querySelectorAll('meta[name="user-login"]').length,
          identity: [...document.querySelectorAll('p,li')].filter(e => /Verify your GitHub identity/.test(e.textContent)).map(e => ({ tag: e.tagName, text: e.innerText.replace(/\([^)]+\)/g, '([account])'), height: e.getBoundingClientRect().height })),
          forms: [...document.forms].map(f => ({ method: f.method, target: f.target, actionPath: new URL(f.action).pathname, actionQueryKeys: [...new URL(f.action).searchParams.keys()], fields: [...f.elements].map(e => ({ tag: e.tagName, type: e.type, name: e.name })) })),
          buttons: [...document.querySelectorAll('button,input[type=submit]')].map(e => ({ text: e.textContent?.trim() || e.value, type: e.type, name: e.name, disabled: e.disabled, form: !!e.form, rect: { top: e.getBoundingClientRect().top, height: e.getBoundingClientRect().height }, visibility: getComputedStyle(e).visibility, display: getComputedStyle(e).display })),
          scroll: { y: scrollY, height: innerHeight, total: document.documentElement.scrollHeight },
        }));
        record({ stage: 'consent_before_scroll', details: await bounded(inspect) });
        await bounded(() => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)));
        await bounded(() => page.waitForTimeout(1000));
        record({ stage: 'consent_after_scroll', details: await bounded(inspect) });
        result = await bounded(() => session.step());
        record({ stage: 'after_scroll_step', status: result.status, reason: result.reason, diagnostic: session.diagnostic() });
        break;
      }
    }
    if (result.status === 'manual') {
      const page = session.context.pages().filter(page => !page.isClosed()).at(-1);
      if (trustedOrigin(page?.url()) === 'github') {
        const path = new URL(page.url()).pathname;
        const redact = value => value.replaceAll(account.username, '[account]').replaceAll(account.email, '[email]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]').replace(/\b\d{6}\b/g, '[digits]').slice(0, 1000);
        const headings = await bounded(() => page.locator('h1,h2').allTextContents());
        const buttons = await bounded(() => page.locator('button').allTextContents());
        record({ stage: 'github_page', path: /^\/[a-z/-]{1,100}$/.test(path) ? redact(path) : '[unrecognized-path]', headings: headings.slice(0, 8).map(redact), buttons: buttons.slice(0, 12).map(redact) });
      }
    }
    if (['verified', 'restricted'].includes(result.status) || ['oauth_changed', 'github_email_device_verification'].includes(result.reason)) break;
  }
} catch (error) {
  record({ stage: 'error', reason: ['diagnostic_timeout', 'start_failed', 'invalid_start'].includes(error.message) ? error.message : 'operation_unconfirmed' });
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer);
  let closeTimer;
  try { await Promise.race([session?.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('close_timeout')), 10000); })]); }
  catch { record({ stage: 'cleanup', reason: 'close_unconfirmed' }); }
  finally { clearTimeout(closeTimer); }
  record({ stage: 'finished', pollCalled: false });
  console.log('Report: ' + resolve(directory, 'report.json'));
}
