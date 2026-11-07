import { AppError } from './store.js';
import { PatStore } from './pat-store.js';
import { PatBrowser } from './pat-browser.js';

const stamp = milliseconds => new Date(milliseconds).toISOString();
const abortError = () => new AppError('PAT 操作已取消', 409);
const messages = {
  identity: 'GitHub 登录身份不匹配，请核对专用账号', owner: 'PAT 资源所有者不匹配，请核对',
  expiry: '请在 GitHub 页面确认 30 天有效期', public_access: '请确认仅公开仓库只读访问；当前页面缺少明确证据',
  permissions_unknown: '无法确认零额外权限，请核对 GitHub 权限摘要', permissions_extra: '发现额外权限，已停止生成',
  result_unknown: '创建结果未知，请人工核对，禁止再次生成', document_changed: '页面已变化，请人工核对创建结果',
  generation_blocked: '已拦截未经权限核对的生成请求；请核对公开只读权限后继续',
  missing_totp: '该账号没有保存 TOTP 密钥，无法自动完成两步验证；请先在账号详情中补全密钥',
  fresh_totp_required: '未能取得有效的两步验证码；请核对 TOTP 密钥与服务器时间后重试',
  totp_rejected: 'GitHub 拒绝了两次验证码，已停止自动尝试；请在浏览器中人工完成验证',
  app_challenge_required: 'GitHub 两步验证页面结构无法识别，请人工检查',
  login_layout_unknown: 'GitHub 登录页结构无法识别，请人工检查',
  human_security_challenge: 'GitHub 需要人工完成安全验证（如人机校验）；请在浏览器中处理后继续',
  result_page_unknown: 'PAT 创建结果页面无法确认，请人工核对，禁止再次生成',
  permission_layout_unknown: 'GitHub 创建表单未能识别，需要更新页面适配；PAT 尚未生成，请勿手动重复创建',
  confirmation_unknown: 'GitHub 生成前确认页面未就绪；PAT 尚未生成，可稍后继续当前浏览器',
  submit_unknown: 'GitHub 生成按钮未能识别；PAT 尚未生成，需要检查页面适配',
  name: 'GitHub 表单中的 Token 名称与当前任务不一致，已暂停，请核对页面',
  submission_not_started: 'GitHub 未确认创建请求已发出，请保留当前页面并核对结果；不会自动重复生成',
  form: 'GitHub 创建表单的提交目标或结构不符合预期，已停止自动操作',
  unknown_layout_or_network: '浏览器页面读取或网络请求中断；请保留当前页面，稍后点击继续',
  official_github_required: 'GitHub 页面未加载完成或地址无法确认；请检查网络后继续',
  multiple_pages: '专用浏览器窗口数量不符合预期，请保留当前 GitHub 页面后继续',
  closed: '专用浏览器已关闭，当前任务无法继续；请停止任务后重新补充',
};
const progressMessages = {
  login: '1/4 · 正在登录 GitHub',
  two_factor: '1/4 · 正在完成 GitHub 两步验证',
  permissions: '2/4 · 已登录，正在核对账号、30 天有效期与公开只读权限',
  generating: '3/4 · 正在生成 PAT，等待一次性结果',
  capturing: '3/4 · 正在读取并加密保存 PAT',
};

export class PatService {
  constructor(store, { patBrowser = new PatBrowser(), patFetcher = fetch, random = Math.random, clock = Date.now } = {}) {
    this.store = store;
    this.pats = store.pats || new PatStore(store);
    this.browser = patBrowser;
    this.fetcher = patFetcher;
    this.random = random;
    this.clock = clock;
    this.active = null;
    this.message = '';
    this.verifications = new Map();
    this.interrupted = new Set();
    store.patService = this;
    // Startup does not log in. A requested maintenance run may retry an
    // unsubmitted record only after independently proving old browsers exited.
    for (const row of this.pats.list()) {
      if (row.status === 'preparing') this.pats.update(row.id, { status: 'manual', message: '服务中断，请人工核对 GitHub 创建结果后处理' });
      const account = store.get(row.accountId, true);
      if (account.reservedBy === 'pat:' + row.id || (!account.reservedBy && account.patDedicated && !row.hasToken && !row.creationUncertain && ['manual', 'preparing'].includes(row.status))) {
        this.interrupted.add(row.id);
        this.pats.update(row.id, { message: this.canRecover(this.pats.row(row.id))
          ? '上次任务在提交前中断；下次补充或检测时将自动确认旧浏览器已退出，并继续此账号'
          : '旧 PAT 浏览器关闭状态无法确认；保留占用，请人工核对旧进程及远端结果' });
      }
    }
  }
  status() {
    return { settings: this.pats.settings(), records: this.pats.list(), running: !!this.active, activeId: this.active?.record?.id || null, message: this.message };
  }
  configure(body) {
    this.pats.configure(body);
    if (!this.pats.settings().enabled && this.active) void this.stop();
    return this.status();
  }
  enabled() { if (!this.pats.settings().enabled) throw new AppError('请先确认启用 PAT 自动维护', 409); }
  canRecover(row) {
    if (!this.interrupted.has(row.id) || row.creationUncertain || !['manual', 'preparing'].includes(row.status) || this.pats.row(row.id).token) return false;
    const account = this.store.get(row.accountId, true);
    return !account.deletedAt && !!account.patDedicated && (!account.reservedBy || account.reservedBy === 'pat:' + row.id);
  }
  blockers(allowRecovery = false) {
    if (this.store.workbuddy?.active || this.integrations?.active) throw new AppError('已有授权任务正在运行，请先完成或停止', 409);
    if (this.pats.list().some(row => (row.creationUncertain || row.status === 'manual' || row.status === 'preparing') && !(allowRecovery && this.canRecover(row)))) throw new AppError('PAT 需要人工核对或创建结果未知，请先处理现有记录', 409);
  }
  cooldown() {
    const checkpoint = this.pats.getCheckpoint('global-cooldown');
    return checkpoint && Date.parse(checkpoint.waitUntil) > this.clock() ? { waitUntil: checkpoint.waitUntil, message: checkpoint.message } : null;
  }
  start() {
    this.enabled();
    if (this.active) throw new AppError('PAT 任务正在运行', 409);
    this.blockers(true);
    this.message = '';
    const task = { controller: new AbortController(), record: null, session: null, closing: null, promise: null, manual: false, attempts: 0, maxAttempts: Math.max(3, this.pats.settings().targetCount), candidates: new Set(), initialized: false };
    // Claim before invoking asynchronous browser code, including synchronous throws.
    this.active = task;
    task.promise = this.run(task);
    return this.status();
  }
  async ensure(signal) {
    this.enabled();
    if (signal?.aborted) throw abortError();
    let owned = false;
    if (!this.active) { this.start(); owned = true; }
    const task = this.active;
    if (!task) return this.status();
    if (task.manual) return this.status();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const cancel = () => {
      if (owned) this.stop().then(() => rejectAbort(abortError()), () => rejectAbort(abortError()));
      else rejectAbort(abortError());
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      await Promise.race([task.promise, aborted]);
      // A cancellation owning this run must await the shared closing operation.
      if (signal?.aborted) { if (owned) await this.stop(); throw abortError(); }
      return this.status();
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  resume() {
    this.enabled();
    const task = this.active;
    if (!task?.manual || !task.session || task.controller.signal.aborted) throw new AppError('没有可继续的 PAT 浏览器；请人工核对现有记录', 409);
    if (this.store.workbuddy?.active || this.integrations?.active) throw new AppError('已有授权任务正在运行', 409);
    this.message = '';
    task.manual = false;
    task.promise = this.run(task);
    return this.status();
  }
  async close(task) {
    if (!task.session) return;
    task.closing ||= Promise.resolve().then(() => task.session.close());
    await task.closing;
    this.pats.complete(task.record.id);
    task.session = null;
  }
  async stop() {
    const task = this.active;
    if (!task) return this.status();
    task.controller.abort();
    // Closing an existing page interrupts a pending browser step. If open is
    // pending, run() observes abort and closes the eventual session itself.
    if (task.session) void this.close(task).catch(() => {});
    await task.promise;
    try {
      await this.close(task);
      if (task.record) {
        const record = this.pats.list().find(row => row.id === task.record.id);
        if (record?.status === 'preparing') this.pats.update(record.id, { status: 'manual', message: record.creationUncertain ? '创建结果未知，请人工核对' : '已停止，请人工核对后释放专用用途' });
        if (record && !record.hasToken && !record.creationUncertain && ['manual', 'preparing'].includes(record.status)) this.interrupted.add(record.id);
      }
      if (this.active === task) this.active = null;
      this.message = 'PAT 任务已停止';
    } catch { this.message = '浏览器关闭未确认，继续保留账号占用，请检查专用浏览器'; }
    return this.status();
  }
  async run(task) {
    try {
      if (task.session) {
        const state = await this.step(task);
        if (state !== 'valid' && state !== 'invalid') return;
      }
      if (!task.initialized && this.pats.list().some(row => this.canRecover(row))) {
        let closed = false;
        try { closed = await this.browser.confirmClosed?.(); } catch {}
        if (task.controller.signal.aborted) return;
        if (closed !== true) {
          this.message = '尚不能确认旧项目浏览器已退出，保留账号占用；关闭旧项目浏览器后可再次补充，系统会重新检查';
          return;
        }
      }
      // Existing saved tokens are verified before deciding whether supply is low.
      for (const row of task.initialized ? [] : this.pats.usable()) {
        if (task.controller.signal.aborted || this.cooldown()) break;
        if (row.status === 'verifying') {
          await this.verify(row, task.controller.signal);
          if (!['valid', 'invalid'].includes(this.pats.list().find(item => item.id === row.id)?.status)) return;
        }
      }
      task.initialized = true;
      while (task.attempts < task.maxAttempts) {
        if (task.controller.signal.aborted || this.cooldown()) break;
        const usable = this.pats.usable();
        const interrupted = this.pats.list().find(row => this.canRecover(row));
        if (!interrupted && usable.length >= this.pats.settings().targetCount) break;
        if (usable.some(row => row.status === 'verifying')) break;
        if (interrupted && usable.length >= this.pats.settings().targetCount) {
          this.pats.update(interrupted.id, { status: 'disabled', message: '有效 PAT 已达到目标；已结束未提交的旧任务，保留专用用途' });
          this.pats.complete(interrupted.id);
          this.interrupted.delete(interrupted.id);
          continue;
        }
        this.browser.assertAvailable();
        const record = interrupted || this.pats.reserve();
        if (!record) { this.message = '没有符合条件的 PAT 专用候选账号'; break; }
        if (interrupted) {
          this.pats.retry(record.id);
          this.interrupted.delete(record.id);
        }
        task.attempts++;
        task.candidates.add(record.accountId);
        task.record = record;
        task.closing = null;
        task.session = await this.browser.open({
          account: this.store.get(record.accountId),
          getSecrets: () => this.store.secrets(record.accountId),
          name: 'AccountDesk ' + record.id.slice(0, 8),
          signal: task.controller.signal,
          onProgress: phase => {
            if (task.controller.signal.aborted || this.active !== task) return;
            if (Object.hasOwn(progressMessages, phase)) this.pats.update(record.id, { message: progressMessages[phase] });
          },
          onSubmitted: () => {
            if (task.controller.signal.aborted || this.active !== task) throw abortError();
            this.pats.update(record.id, { creationUncertain: true, message: '3/4 · 正在生成；结果未确认前禁止重试' });
          },
          onToken: (value, expiry) => {
            // Even a stop racing capture must retain an already issued credential.
            this.pats.saveToken(record.id, value, expiry);
            this.pats.update(record.id, { message: '4/4 · PAT 已加密保存，正在验证身份与额度' });
          },
        });
        if (task.controller.signal.aborted) break;
        const state = await this.step(task);
        if (state !== 'valid' && state !== 'invalid') break;
      }
    } catch (error) {
      if (error.patSession) task.session = error.patSession;
      this.message = 'PAT 操作中断，请核对现有记录及项目浏览器';
    }
    finally {
      if (!task.manual) await this.finish(task);
    }
  }
  async step(task) {
    const result = await task.session.step();
    if (task.controller.signal.aborted) return 'stopped';
    const record = this.pats.list().find(row => row.id === task.record.id);
    if (result.status === 'captured' && this.pats.secret(record.id)) {
      await this.close(task);
      await this.verify(record, task.controller.signal);
      return this.pats.list().find(row => row.id === record.id).status;
    }
    this.pats.update(record.id, { status: 'manual', message: messages[result.reason] || 'GitHub 页面需要人工处理；请核对身份、公开只读权限及创建结果后继续' });
    task.manual = true;
    this.message = 'PAT 流程已暂停，请查看当前账号的具体诊断';
    return 'manual';
  }
  async finish(task) {
    try {
      await this.close(task);
      if (task.record) {
        const row = this.pats.list().find(row => row.id === task.record.id);
        if (row.status === 'preparing') this.pats.update(row.id, { status: 'manual', message: '创建流程中断，请人工核对远端结果' });
        this.pats.complete(task.record.id);
      }
      if (this.active === task) this.active = null;
    } catch { this.message = '浏览器关闭未确认，继续保留账号占用，请检查专用浏览器'; }
  }
  verify(row, signal) {
    if (this.verifications.has(row.id)) return this.verifications.get(row.id);
    const pending = this.verifyRequest(row, signal).finally(() => this.verifications.delete(row.id));
    this.verifications.set(row.id, pending);
    return pending;
  }
  async verifyRequest(row, signal) {
    if (signal?.aborted) return;
    const token = this.pats.secret(row.id);
    if (!token) return;
    let response;
    try {
      response = await this.fetcher('https://api.github.com/user', {
        redirect: 'error', headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      if (response.status === 401) { this.pats.markInvalid(row.id, 'GitHub 已确认 PAT 无效'); return; }
      if (response.status === 403 || response.status === 429) { this.reportResponse(row.id, response); return; }
      if (!response.ok || response.status >= 300) throw new Error();
      const chunks = []; let size = 0;
      if (!response.body) throw new Error();
      for await (const chunk of response.body) { size += chunk.length; if (size > 65536) throw new Error(); chunks.push(Buffer.from(chunk)); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (this.pats.list().find(item => item.id === row.id)?.status === 'disabled') return;
      if (typeof data.login !== 'string') throw new Error();
      if (data.login.toLowerCase() !== row.username.toLowerCase()) {
        this.pats.update(row.id, { status: 'manual', message: 'PAT 所属 GitHub 用户不匹配，请人工核对' }); return;
      }
      this.pats.update(row.id, { status: 'valid', message: 'GitHub 已验证 PAT 身份', retryAt: null });
      this.reportResponse(row.id, response);
    } catch {
      // Network, redirects and malformed responses do not prove invalidity.
      if (this.pats.list().find(item => item.id === row.id)?.status !== 'disabled') this.pats.update(row.id, { status: 'verifying', message: 'PAT 已保存，网络或响应异常；等待重新验证' });
    } finally { try { if (response && !response.bodyUsed) await response.body?.cancel(); } catch {} }
  }
  reportResponse(id, response) {
    const record = this.pats.list().find(row => row.id === id);
    if (!record) throw new AppError('PAT 记录不存在', 404);
    if (record.status === 'disabled') return record;
    if (response.status === 401) return this.pats.markInvalid(id, 'GitHub 已确认 PAT 无效');
    const headers = response.headers;
    const number = name => { const value = headers?.get(name); return value !== null && value !== undefined && /^\d+$/.test(value) ? Number(value) : null; };
    const remaining = number('x-ratelimit-remaining'), limit = number('x-ratelimit-limit'), reset = number('x-ratelimit-reset');
    const retry = headers?.get('retry-after');
    let wait = 0;
    if (retry) wait = /^\d+$/.test(retry) ? this.clock() + Number(retry) * 1000 : Date.parse(retry);
    if (remaining === 0 && reset) wait = Math.max(wait || 0, reset * 1000);
    const patch = {};
    if (remaining !== null) patch.remaining = remaining;
    if (limit !== null) patch.limit = limit;
    if (reset && Number.isFinite(reset * 1000) && reset * 1000 < 8640000000000000) patch.resetAt = stamp(reset * 1000);
    // Primary REST quota belongs to the authenticated account. Retry-After
    // takes precedence: it can indicate a broader secondary limit.
    if (remaining === 0 && !retry && (response.ok || response.status === 403 || response.status === 429)) {
      if (!patch.resetAt) {
        Object.assign(patch, { status: 'manual', message: 'PAT 额度耗尽但恢复时间未知，请核对后继续' });
        return { ...this.pats.update(id, patch), cooldownScope: 'unknown' };
      }
      const retryAt = stamp(Math.max(reset * 1000, this.clock() + 1000));
      Object.assign(patch, { status: record.status === 'verifying' ? 'verifying' : 'cooling', retryAt, message: '此账号额度已用完，恢复前使用其他可用 PAT' });
      for (const sibling of this.pats.usable().filter(row => row.accountId === record.accountId && row.id !== id)) {
        this.pats.update(sibling.id, { remaining: 0, resetAt: patch.resetAt, retryAt, status: sibling.status === 'verifying' ? 'verifying' : 'cooling', message: patch.message });
      }
      return { ...this.pats.update(id, patch), cooldownScope: 'account' };
    }
    if ((response.status === 403 || response.status === 429 || remaining === 0) && Number.isFinite(wait) && wait > 0) {
      const previous = this.pats.getCheckpoint('global-cooldown');
      const failures = Math.min((previous?.failures || 0) + 1, 7);
      const backoff = remaining === 0 ? 60000 : Math.min(3600000, 60000 * 2 ** (failures - 1));
      wait = Math.max(wait, this.clock() + backoff, Date.parse(this.cooldown()?.waitUntil || '') || 0);
      const waitUntil = stamp(Math.min(wait, 8640000000000000));
      this.pats.setCheckpoint('global-cooldown', { waitUntil, failures, scope: 'global', message: 'GitHub 限流，所有检查等待后再试' });
      Object.assign(patch, { status: record.status === 'verifying' ? 'verifying' : 'cooling', retryAt: waitUntil, message: 'GitHub 配额冷却；不会更换账号绕过限制' });
    } else if (response.status === 403 || response.status === 429) {
      Object.assign(patch, { status: 'manual', message: 'GitHub 拒绝请求且无法确认冷却时间，请人工核对权限或限制' });
    } else if (record.status === 'cooling' && response.status >= 200 && response.status < 300 && remaining > 0
      && (!record.retryAt || Date.parse(record.retryAt) <= this.clock())) {
      // Fresh positive evidence repairs this record only. Another request may
      // already have established a later shared deadline, which stays intact.
      Object.assign(patch, { status: 'valid', retryAt: null, message: '' });
    }
    return this.pats.update(id, patch);
  }
  async credential(signal, { preferredId } = {}) {
    this.enabled();
    if (signal?.aborted) throw abortError();
    if (this.cooldown()) return this.cooldown();
    if (this.active?.manual) throw new AppError('PAT 需要人工处理，请查看专用浏览器', 409);
    if (!this.active) this.blockers(true);
    let rows = this.pats.usable();
    // A single maintenance run verifies saved supply and replenishes confirmed
    // shortages using its fixed per-run candidate budget. Never restart that
    // budget after a saved/new token fails verification during this acquisition.
    if (this.active || this.pats.list().some(row => this.canRecover(row)) || rows.length < this.pats.settings().targetCount || rows.some(row => row.status === 'verifying')) {
      await this.ensure(signal);
      this.enabled();
      if (signal?.aborted) throw abortError();
      if (this.cooldown()) return this.cooldown();
      rows = this.pats.usable();
    }
    this.blockers();
    if (rows.some(row => row.status === 'verifying')) throw new AppError('PAT 需要重新验证或人工核对，未更换账号', 409);
    if (signal?.aborted) throw abortError();
    this.enabled();
    if (this.cooldown()) return this.cooldown();
    rows = this.pats.usable().filter(row => ['valid', 'cooling'].includes(row.status));
    const blockedAccounts = new Set(rows.filter(row => Date.parse(row.retryAt) > this.clock()).map(row => row.accountId));
    const candidates = [...new Map(rows.filter(row => !blockedAccounts.has(row.accountId)).map(row => [row.accountId, row])).values()];
    if (candidates.length) {
      const current = candidates.find(row => row.id === preferredId) || candidates[Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))];
      return { id: current.id, username: current.username, token: this.pats.secret(current.id) };
    }
    const earliest = rows.filter(row => Date.parse(row.retryAt) > this.clock()).sort((a,b) => Date.parse(a.retryAt) - Date.parse(b.retryAt))[0];
    if (earliest) return { waitUntil: earliest.retryAt, message: '所有 PAT 暂无额度，等待最早恢复时间' };
    throw new AppError('没有可用 PAT，请查看维护状态与候选账号', 409);
  }
  disable(id) {
    if (this.active?.record?.id === id) throw new AppError('请先停止 PAT 浏览器任务', 409);
    this.pats.disable(id); return this.status();
  }
  release(id, body) { this.pats.releaseDedicated(id, body); return this.status(); }
  remove(id, body) {
    if (this.active || this.verifications.has(id) || this.checker?.status().running) throw new AppError('请等待 PAT 任务或检测完成后删除',409);
    this.pats.remove(id, body);
    this.interrupted.delete(id);
    return this.status();
  }
  releaseAccount(id, body) {
    if (this.active || this.verifications.size) throw new AppError('请等待 PAT 任务或验证完成',409);
    this.pats.releaseAccount(id, body); return this.status();
  }
}

export function registerPat(app, service) {
  app.get('/api/pat', (req, res) => res.json(service.status()));
  app.put('/api/pat/config', (req, res) => res.json(service.configure(req.body)));
  app.post('/api/pat/start', (req, res) => res.status(202).json(service.start()));
  app.post('/api/pat/resume', (req, res) => res.status(202).json(service.resume()));
  app.post('/api/pat/stop', async (req, res) => res.json(await service.stop()));
  app.post('/api/pat/:id/disable', (req, res) => res.json(service.disable(req.params.id)));
  app.post('/api/pat/:id/release', (req, res) => res.json(service.release(req.params.id, req.body)));
  app.delete('/api/pat/:id', (req, res) => res.json(service.remove(req.params.id, req.body)));
  app.post('/api/pat/accounts/:id/release', (req, res) => res.json(service.releaseAccount(req.params.id, req.body)));
}
