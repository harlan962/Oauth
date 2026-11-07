import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { chromium as projectChromium, browserDirectory } from './browser-runtime.js';
import { AppError } from './store.js';
import { githubPatForm, requestMatchesForm } from './pat-form.js';

const newPath = '/settings/personal-access-tokens/new';
const createPath = '/settings/personal-access-tokens';
const manual = reason => ({ status: 'manual', reason });
// GitHub's sign-in flow needs login -> two-factor -> two-factor/app -> PAT form,
// and each hop may land on an interstitial. The old budget of 8 ran out after a
// single failed 2FA attempt and was then reported as a human challenge.
const stepBudget = 40;
const navigationTimeout = 15000;
// A code must stay valid while the browser sends the form. The old 2 s margin
// rejected usable codes and reported them as "no fresh TOTP".
const totpMargin = 5000;

async function inspectBrowserProcesses() {
  // Recovery is deliberately unavailable on platforms without an implemented
  // process witness. Enumerate paths only; never inspect browser arguments or
  // terminate a user's browser. Include old bundled Chromium revisions.
  if (process.platform !== 'win32') throw new Error('unsupported process inspection');
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $items=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='chromium.exe' OR Name='headless_shell.exe'\" | ForEach-Object { @{executablePath=$_.ExecutablePath} }); ConvertTo-Json -InputObject $items -Compress";
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

// Submit a form and wait for the navigation it starts. The wait is armed BEFORE
// the submit so a fast redirect cannot be missed, and it tolerates a page that
// legitimately stays on the same URL (a rejected challenge) by returning false
// after a short confirmation window.
// Submit a form and wait for the resulting navigation to land. Chromium may fire
// framenavigated before the redirect target is committed, and a rejected
// submission leaves the URL untouched, so this waits for an actual URL change
// and reports whether one happened.
async function submitAndSettle(page, from, submit) {
  const changed = page
    .waitForURL((url) => url.href !== from, { timeout: navigationTimeout })
    .then(() => true)
    .catch(() => false);
  await submit();
  if (!(await changed)) {
    // No navigation: give a slow in-flight request a chance to commit before the
    // caller treats the unchanged page as a rejected submission.
    await page.waitForTimeout(1000);
    return page.url() !== from;
  }
  // A redirect chain (302, meta refresh, location.replace) advances the URL more
  // than once, and the form POST that follows navigates again. Wait until the URL
  // has been stable AND the document is queryable, otherwise the next selector
  // runs against a context that is about to be destroyed.
  for (let round = 0; round < 30; round++) {
    const before = page.url();
    await page.waitForTimeout(100);
    if (page.url() !== before) continue;
    const ready = await page
      .evaluate(() => document.readyState === 'complete')
      .catch(() => false);
    if (ready) return true;
  }
  return page.url() !== from;
}

function official(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && !url.username && !url.password && !url.port && !url.hash;
  } catch { return false; }
}

// This is a conservative semantic adapter, NOT a claim that GitHub's live DOM
// has been inspected. Unknown controls/summaries require human review.
function minimalForm(form, { username, submit = false }) {
  const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const single = selector => { const nodes = [...form.querySelectorAll(selector)]; return nodes.length === 1 ? nodes[0] : null; };
  const identity = document.querySelectorAll('meta[name="user-login"]');
  if (identity.length !== 1 || identity[0].content.toLowerCase() !== username.toLowerCase()) return 'identity';
  if (form.ownerDocument !== document || !form.isConnected || !visible(form) || form.method !== 'post' || form.action !== 'https://github.com/settings/personal-access-tokens' || !['', '_self'].includes(form.target)) return 'form';
  const owner = single('select[name="target_name"]');
  if (!visible(owner) || owner.value.toLowerCase() !== username.toLowerCase()) return 'owner';
  const expiry = single('select[name="expires_in"]');
  if (!visible(expiry) || expiry.value !== '30') return 'expiry';
  const groups = [...form.querySelectorAll('fieldset')];
  const group = title => groups.filter(node => node.querySelector('legend')?.textContent.trim().toLowerCase() === title);
  const access = group('repository access');
  if (access.length !== 1 || !visible(access[0])) return 'public_access';
  const selected = [...access[0].querySelectorAll('input:checked')];
  if (selected.length !== 1 || selected[0].type !== 'radio' || selected[0].name !== 'repository_access' || selected[0].value !== 'public' || !visible(selected[0]) || !/public repositories.*read.only/i.test(selected[0].labels?.[0]?.textContent || '')) return 'public_access';
  for (const category of ['account', 'repository']) {
    const matches = group(category + ' permissions');
    if (matches.length !== 1 || !visible(matches[0])) return 'permissions_unknown';
    const summary = [...matches[0].querySelectorAll('p, summary, output')].filter(node => visible(node) && node.textContent.trim().toLowerCase() === `no ${category} permissions`);
    if (summary.length !== 1) return 'permissions_unknown';
  }
  // Inspect hidden enabled fields too: public summaries cannot override actual submitted permissions.
  const allowed = new Set(['target_name', 'expires_in', 'repository_access', 'name', 'description', 'authenticity_token', 'utf8']);
  for (const control of form.elements) {
    if (control.disabled) continue;
    if (control.tagName === 'FIELDSET' || ['submit', 'button', 'reset'].includes(control.type)) continue;
    if (['radio', 'checkbox'].includes(control.type) && !control.checked) continue;
    if (/permission|scope/i.test(control.name)) {
      if (!['', 'none', '0', 'no-access'].includes(control.value)) return 'permissions_extra';
    } else if (!allowed.has(control.name)) return 'permissions_unknown';
    if (control.name === 'repository_access' && control.value !== 'public') return 'public_access';
    if (control.name === 'target_name' && control.value.toLowerCase() !== username.toLowerCase()) return 'owner';
    if (control.name === 'expires_in' && control.value !== '30') return 'expiry';
  }
  const buttons = [...form.querySelectorAll('button[type="submit"],input[type="submit"]')].filter(visible);
  if (buttons.length !== 1 || buttons[0].disabled || !/^generate token$/i.test((buttons[0].textContent || buttons[0].value).trim())) return 'submit_unknown';
  const button = buttons[0];
  if ((button.hasAttribute('formaction') && button.formAction !== form.action) || (button.hasAttribute('formmethod') && button.formMethod !== 'post') || (button.hasAttribute('formtarget') && !['', '_self'].includes(button.formTarget))) return 'submit_unknown';
  // Validate and submit in the same document task, avoiding a gap in which a
  // rerender can replace permissions or change the destination.
  const entries = [...new FormData(form)];
  const submittedValues = new URLSearchParams();
  for (const [key, value] of entries) {
    if (typeof value !== 'string') return 'permissions_unknown';
    if (/permission|scope/i.test(key)) {
      if (!['', 'none', '0', 'no-access'].includes(value)) return 'permissions_extra';
    } else if (!allowed.has(key)) return 'permissions_unknown';
    submittedValues.append(key, value);
  }
  if (submittedValues.getAll('target_name').length !== 1 || submittedValues.get('target_name').toLowerCase() !== username.toLowerCase()) return 'owner';
  if (submittedValues.getAll('expires_in').length !== 1 || submittedValues.get('expires_in') !== '30') return 'expiry';
  if (submittedValues.getAll('repository_access').length !== 1 || submittedValues.get('repository_access') !== 'public') return 'public_access';
  if (submit) {
    let started = false;
    const observe = event => { started = !event.defaultPrevented; };
    form.addEventListener('submit', observe);
    try { form.requestSubmit(button); } finally { form.removeEventListener('submit', observe); }
    if (!started) return 'submission_not_started';
  }
  return { entries, modern: false };
}

export class PatSession {
  constructor(context, { account, getSecrets, name, onSubmitted, onToken, onProgress }, browser = null) {
    Object.assign(this, { context, account, getSecrets, name, onSubmitted, onToken, onProgress, browser });
    this.closed = false;
    this.submitted = false;
    this.captured = false;
    this.epochs = new WeakMap();
    this.ready = context.route('**/settings/personal-access-tokens**', async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      if (request.url() === 'https://github.com' + createPath + '/confirmation') {
        const capability = this.previewCapability;
        this.previewCapability = null;
        let valid = false;
        try {
          const validation = await capability?.validation;
          valid = capability && validation && typeof validation !== 'string' &&
            !request.isNavigationRequest() && request.frame() === capability.page.mainFrame() &&
            this.current(capability.page, capability.url, capability.epoch) && !this.submitted &&
            await requestMatchesForm(request, validation.entries);
        } catch {}
        if (!valid || this.blockedGeneration || !this.current(capability.page, capability.url, capability.epoch)) { this.blockedGeneration = true; return route.abort('blockedbyclient'); }
        capability.allowed = true;
        capability.request = request;
        return route.fallback();
      }
      const capability = this.submissionCapability;
      let valid = false;
      try {
        const validation = capability ? await capability.validation : null;
        const url = new URL(request.url());
        valid = official(url.href) && url.pathname === createPath &&
          request.frame() === request.frame().page().mainFrame() &&
          validation && typeof validation !== 'string' && capability && this.submissionCapability === capability && capability.request === request &&
          capability.page === request.frame().page() && capability.page.url() === capability.url &&
          (this.epochs.get(capability.page) || 0) === capability.epoch + 1 &&
          this.submitted && !this.generationRequestSeen && !this.closed &&
          request.headers()['content-type']?.startsWith('application/x-www-form-urlencoded') &&
          await requestMatchesForm(request, validation.entries);
      } catch {}
      valid = valid && !this.closed && !this.blockedGeneration && this.submissionCapability === capability &&
        capability.page.url() === capability.url && (this.epochs.get(capability.page) || 0) === capability.epoch + 1;
      this.submissionCapability = null;
      if (!valid) { this.blockedGeneration = true; return route.abort('blockedbyclient'); }
      this.generationRequestSeen = true;
      return route.fallback();
    });
    context.on('request', request => {
      try {
        if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()) {
          const page = request.frame().page();
          this.previewCapability = null;
          this.confirmedPreview = null;
          const epoch = this.epochs.get(page) || 0;
          const capability = this.submissionCapability;
          if (capability && !capability.request && capability.page === page && capability.epoch === epoch &&
              capability.url === page.url() && request.method() === 'POST' && request.url() === 'https://github.com' + createPath) capability.request = request;
          else this.submissionCapability = null;
          this.epochs.set(page, epoch + 1);
        }
      } catch {}
    });
  }
  current(page, url, epoch) {
    return !this.closed && !page.isClosed() && page.url() === url && (this.epochs.get(page) || 0) === epoch;
  }
  // A selector read can lose its execution context when the page is mid-navigation
  // (redirect chains, slow GitHub responses). Retry briefly instead of reporting a
  // layout change that did not happen.
  async query(page, selector) {
    for (let i = 0; i < 6; i++) {
      try {
        return await page.$$(selector);
      } catch (error) {
        if (this.closed || page.isClosed()) throw error;
        if (!/Execution context was destroyed|navigat/i.test(String(error?.message))) throw error;
        await page.waitForTimeout(200);
      }
    }
    return [];
  }
  // Regenerate the code at fill time. Waiting for the next window is better than
  // rejecting a code that would expire while the browser posts the form.
  async freshOtp(page, url, epoch) {
    let otp = this.getSecrets()?.otp;
    if (!otp) return 'missing_totp';
    if (otp.expiresAt - Date.now() < totpMargin) {
      await page.waitForTimeout(Math.max(0, Math.min(31000, otp.expiresAt - Date.now() + 250)));
      if (this.closed || page.isClosed()) return 'closed';
      if (!this.current(page, url, epoch)) return 'document_changed';
      otp = this.getSecrets()?.otp;
      if (!otp) return 'missing_totp';
    }
    if (!/^\d{6}$/.test(otp.code) || otp.expiresAt - Date.now() < totpMargin) return null;
    return otp.code;
  }
  async step() {
    if (this.closed) return manual('closed');
    if (this.captured) return { status: 'captured' };
    if (this.stepping) return manual('step_running');
    this.stepping = true;
    this.lastError = '';
    try {
      await this.ready;
      if (this.blockedGeneration) return manual('generation_blocked');
      for (let attempt = 0; attempt < stepBudget; attempt++) {
        const pages = this.context.pages().filter(page => !page.isClosed());
        // A redirect can momentarily surface a transient page. Only a genuine
        // second window (popup) is a reason to hand control back to the operator.
        if (pages.length !== 1) {
          await new Promise(resolve => setTimeout(resolve, 150));
          const settled = this.context.pages().filter(page => !page.isClosed());
          if (settled.length !== 1) return manual('multiple_pages');
          pages.splice(0, pages.length, ...settled);
        }
        const page = pages[0];
        try {
        let url = page.url();
        let epoch = this.epochs.get(page) || 0;
        if (!official(url) || this.closed) return manual('official_github_required');
        const path = new URL(url).pathname;
        if (this.submitted) {
          await this.onProgress?.('capturing');
          if (path !== newPath && path !== createPath && !/^\/settings\/personal-access-tokens\/\d+$/.test(path)) return manual('result_unknown');
          // The result page may still be committing when the first read lands.
          // Read the token with the same bounded retry used for form lookups.
          let value = null;
          for (let i = 0; i < 6; i++) {
            try {
              const results = await page.$$('input#new-access-token');
              value = results.length === 1 ? await results[0].inputValue() : null;
              break;
            } catch (error) {
              if (this.closed || page.isClosed()) throw error;
              if (!/Execution context was destroyed|navigat/i.test(String(error?.message))) throw error;
              await page.waitForTimeout(250);
            }
          }
          if (!this.current(page, url, epoch)) return manual('document_changed');
          if (!value || !/^github_pat_[A-Za-z0-9_]+$/.test(value)) return manual('result_unknown');
          // Persistence is awaited immediately; plaintext never enters a public result.
          await this.onToken(value, this.expiresAt);
          this.captured = true;
          return { status: 'captured' };
        }
        if (path === newPath) {
          await this.onProgress?.('permissions');
          const formSelector='form[action="/settings/personal-access-tokens"],form[action="https://github.com/settings/personal-access-tokens"]';
          await page.locator(formSelector).first().waitFor({state:'attached',timeout:navigationTimeout}).catch(error=>{
            if(error.name!=='TimeoutError')throw error;
          });
          if (!this.current(page, url, epoch)) continue;
          const forms = await this.query(page, formSelector);
          if (forms.length !== 1) return manual('permission_layout_unknown');
          const form = forms[0];
          const modern = await form.evaluate(node => !!node.querySelector('input[name="user_programmatic_access[name]"]'));
          const adapter = modern ? githubPatForm : minimalForm;
          const expiryDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
          const args = { username: this.account.username, name: String(this.name).slice(0, 40), expiryDate };
          const validation = await form.evaluate(adapter, args);
          if (typeof validation === 'string') return manual(validation);
          if (!this.current(page, url, epoch)) return manual('document_changed');
          if (modern) {
            const confirmed = this.confirmedPreview;
            const open = await page.locator('#fgpat-confirmation-dialog').isVisible();
            if (open) {
              if (!confirmed || confirmed.page !== page || confirmed.url !== url || confirmed.epoch !== epoch || JSON.stringify(confirmed.entries) !== JSON.stringify(validation.entries)) return manual('confirmation_unknown');
            } else {
              const preview = { page, url, epoch, validation: null, allowed: false, request: null };
              this.previewCapability = preview;
              const responsePending = page.waitForResponse(response => response.request() === preview.request, { timeout: navigationTimeout }).catch(() => null);
              preview.validation = form.evaluate(adapter, { ...args, action: 'preview' });
              const checked = await preview.validation;
              if (typeof checked === 'string') return manual(checked);
              const response = await responsePending;
              let responseTimer;
              const responseError = response ? await Promise.race([
                response.finished(),
                new Promise(resolve => { responseTimer = setTimeout(() => resolve('response_timeout'), navigationTimeout); }),
              ]).finally(() => clearTimeout(responseTimer)) : 'missing_response';
              this.previewCapability = null;
              if (!this.current(page, url, epoch)) return manual('document_changed');
              if (!preview.allowed || !response?.ok() || responseError) return manual('confirmation_unknown');
              await page.locator('#fgpat-confirmation-dialog').waitFor({ state: 'visible', timeout: navigationTimeout }).catch(() => {});
              if (!this.current(page, url, epoch)) return manual('document_changed');
              if (!(await page.locator('#fgpat-confirmation-dialog').isVisible())) return manual('confirmation_unknown');
              this.confirmedPreview = { page, url, epoch, entries: checked.entries };
            }
            const rechecked = await form.evaluate(adapter, args);
            if (typeof rechecked === 'string') return manual(rechecked);
          }
          this.expiresAt = modern ? expiryDate + 'T00:00:00.000Z' : new Date(Date.now() + 30 * 86400000).toISOString();
          // Durable uncertainty must exist before ANY remote generation action.
          await this.onProgress?.('generating');
          this.submissionAttempted = true;
          await this.onSubmitted();
          this.submitted = true;
          if (!this.current(page, url, epoch)) return manual('document_changed');
          const capability = { page, url, epoch, form, request: null, validation: null };
          this.submissionCapability = capability;
          capability.validation = form.evaluate(adapter, { ...args, submit: true, action: 'submit' });
          const recheck = await capability.validation;
          if (typeof recheck === 'string') return manual(recheck);
          // The generation POST is now in flight. Wait for the result page before
          // the next iteration samples url/epoch, otherwise it reads the form page
          // and reports a document change once the navigation commits.
          await page
            .waitForURL((next) => next.pathname !== newPath, {
              timeout: navigationTimeout,
            })
            .catch(() => {});
          await page.waitForTimeout(150);
          continue;
        } else if (path === '/login' || path === '/session') {
          await this.onProgress?.('login');
          const forms = await this.query(page, 'form[action="/session"]');
          if (!this.current(page, url, epoch)) continue;
          if (forms.length !== 1) return manual('login_layout_unknown');
          const form = forms[0];
          if (!(await form.evaluate(node => node.method === 'post' && node.action === 'https://github.com/session'))) return manual('login_form');
          const login = await form.$('input#login_field'), password = await form.$('input#password');
          if (!login || !password || !(await login.isVisible()) || !(await password.isVisible())) return manual('login_layout_unknown');
          if (!this.current(page, url, epoch)) return manual('document_changed');
          const secrets = this.getSecrets();
          if (!this.current(page, url, epoch)) return manual('document_changed');
          const navigating = submitAndSettle(page, url, async () => {
            await login.fill(this.account.username);
            if (!this.current(page, url, epoch)) return;
            await password.fill(secrets.password);
            if (!this.current(page, url, epoch)) return;
            await form.evaluate(node => node.requestSubmit());
          });
          // Await the navigation instead of a fixed pause: a slow response must
          // not be mistaken for a human challenge on the unchanged page.
          await navigating;
          // The steps above re-check the document between fills; if one decided
          // the page was replaced, surface it rather than continuing.
          if (this.closed) return manual('closed');
          if (page.isClosed()) return manual('closed');
        } else if (path === '/sessions/two-factor/app' || path === '/sessions/two-factor') {
          await this.onProgress?.('two_factor');
          const forms = await this.query(page, 'form[action="/sessions/two-factor"]');
          if (!this.current(page, url, epoch)) continue;
          if (forms.length !== 1) return manual('app_challenge_required');
          const form = forms[0], otp = await form.$('input#app_totp');
          if (!otp || !(await otp.isVisible()) || !(await form.evaluate(node => node.method === 'post' && node.action === 'https://github.com/sessions/two-factor'))) return manual('app_challenge_required');
          if (!this.current(page, url, epoch)) return manual('document_changed');
          const fresh = await this.freshOtp(page, url, epoch);
          if (fresh === 'document_changed' || fresh === 'closed') return manual(fresh);
          // Distinguish a missing key from a key that is merely unusable, so the
          // operator knows to add a TOTP secret instead of re-reading the page.
          if (fresh === 'missing_totp') return manual('missing_totp');
          if (!fresh) return manual('fresh_totp_required');
          await submitAndSettle(page, url, async () => {
            await otp.fill(fresh);
            if (!this.current(page, url, epoch)) return;
            await form.evaluate(node => node.requestSubmit());
          });
          if (this.closed) return manual('closed');
          // A successful challenge navigates away from the 2FA page. That is the
          // expected outcome, not a hijacked document: only a page that stayed
          // on the challenge while advancing its epoch is suspicious.
          const landed = new URL(page.url()).pathname;
          if (landed === '/sessions/two-factor' || landed === '/sessions/two-factor/app') {
            // Still on the challenge: a rejected code re-renders the form.
            // One automatic retry with a regenerated code is safe.
            if (this.twoFactorRetried) return manual('totp_rejected');
            this.twoFactorRetried = true;
            continue;
          }
        } else if (path === '/sessions/trusted-device') {
          // GitHub briefly renders this document before redirecting an already
          // verified login. Only wait for that navigation; do not act on a
          // security challenge if it remains on the page.
          await page.waitForURL(next => next.href !== url, { timeout: navigationTimeout }).catch(() => {});
          if (this.closed || page.isClosed()) return manual('closed');
          if (page.url() !== url) continue;
          return manual('human_security_challenge');
        } else if (path === '/' || path === '/dashboard') {
          const identity = await page.locator('meta[name="user-login"]').evaluateAll(nodes => nodes.length === 1 ? nodes[0].content : null);
          if (!this.current(page, url, epoch)) continue;
          if (identity?.toLowerCase() !== this.account.username.toLowerCase()) return manual('identity');
          const target = new URL('https://github.com' + newPath);
          target.searchParams.set('name', String(this.name).slice(0, 40));
          target.searchParams.set('description', 'Local account desk public resource read-only checks');
          target.searchParams.set('expires_in', '30');
          await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else return manual('human_security_challenge');
        if (this.closed) return manual('closed');
        if (!this.submitted && page.url() === url) return manual('human_security_challenge');
        } catch (error) {
          // Authentication redirects can replace handles between individual
          // reads. Reacquire the landed document and recheck origin/identity;
          // never retry a generation attempt or relax the submission epoch.
          if (!this.closed && !this.submitted && !this.submissionAttempted && !page.isClosed() &&
              /Execution context was destroyed|Cannot find context with specified id/.test(String(error?.message))) {
            await page.waitForTimeout(150);
            continue;
          }
          throw error;
        }
      }
      return manual('human_security_challenge');
    } catch (error) {
      // Preserve the reason for the operator: a generic "unknown layout or
      // network" hides selectors that changed and makes support impossible.
      if (this.closed) return manual('closed');
      this.lastError = error instanceof Error ? error.message : String(error);
      return manual('unknown_layout_or_network');
    }
    finally { this.submissionCapability = null; this.previewCapability = null; this.stepping = false; }
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.submissionCapability = null;
    this.previewCapability = null;
    this.confirmedPreview = null;
    this.detachAbort?.();
    this.closePromise = (async () => { try { await this.context.close(); } finally { await this.browser?.close(); } })();
    return this.closePromise;
  }
}

export class PatBrowser {
  constructor({ chromium = projectChromium, inspectProcesses = inspectBrowserProcesses } = {}) {
    this.chromium = chromium;
    this.inspectProcesses = inspectProcesses;
  }
  async confirmClosed() {
    try {
      const processes = await this.inspectProcesses();
      const root = win32.resolve(browserDirectory).toLowerCase() + '\\';
      return Array.isArray(processes) && processes.every(item =>
        typeof item?.executablePath === 'string' && win32.isAbsolute(item.executablePath) &&
        !win32.resolve(item.executablePath).toLowerCase().startsWith(root));
    } catch { return false; }
  }
  assertAvailable() {
    const path = this.chromium.executablePath();
    if (!existsSync(path)) throw new AppError('项目专用 Chromium 尚未安装，请运行 npm run browser:install', 409);
    return path;
  }
  async open(options) {
    const executablePath = this.assertAvailable();
    let browser, session, ownership, cancelPartial;
    try {
      browser = await this.chromium.launch({ executablePath, headless: false, args: ['--no-proxy-server'] });
      let closing;
      ownership = { close: () => closing ||= Promise.resolve().then(() => browser.close()) };
      cancelPartial = () => { void ownership.close().catch(() => {}); };
      options.signal?.addEventListener('abort', cancelPartial, { once: true });
      if (options.signal?.aborted) { await ownership.close(); throw new Error('cancelled'); }
      const context = await browser.newContext({ viewport: null });
      session = new PatSession(context, options, { close: () => ownership.close() });
      options.signal?.removeEventListener('abort', cancelPartial);
      const cancel = () => { void session.close().catch(() => {}); };
      session.detachAbort = () => options.signal?.removeEventListener('abort', cancel);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) {
        await session.close();
        return session;
      }
      await session.ready;
      const page = await context.newPage();
      const url = new URL('https://github.com' + newPath);
      url.searchParams.set('name', String(options.name).slice(0, 40));
      url.searchParams.set('description', 'Local account desk public resource read-only checks');
      url.searchParams.set('expires_in', '30');
      try { await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
      if (options.signal?.aborted) await session.close();
      return session;
    } catch {
      const failure = new AppError('无法启动 PAT 专用浏览器，请检查项目 Chromium 安装', 409);
      try { await (session || ownership)?.close(); }
      catch { Object.defineProperty(failure, 'patSession', { value: session || ownership }); }
      throw failure;
    } finally {
      options.signal?.removeEventListener('abort', cancelPartial);
    }
  }
}
