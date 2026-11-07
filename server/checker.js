import { AppError } from './store.js';
import { PatStore } from './pat-store.js';

const iso = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? new Date(value).toISOString() : null;
const cancelled = () => new AppError('检查已取消', 409);
class CheckpointError extends AppError {
  constructor() { super('无法保存检查进度，任务已中断；请检查本地存储后继续', 500); }
}

function quotaOf(response, clock) {
  const number = name => {
    const value = response.headers?.get(name);
    return value != null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  };
  const limit = number('x-ratelimit-limit');
  const remaining = number('x-ratelimit-remaining');
  const resetAt = iso(number('x-ratelimit-reset') * 1000);
  const retry = response.headers?.get('retry-after');
  const retryMs = retry ? (/^\d+$/.test(retry) ? clock() + Number(retry) * 1000 : Date.parse(retry)) : 0;
  const retryAt = iso(Math.max(iso(retryMs) ? retryMs : 0, remaining === 0 || response.status === 429 ? Date.parse(resetAt) || 0 : 0));
  return { limit, remaining, resetAt, retryAt };
}

// Credential and raw response remain internal. No upstream body/error text enters diagnostics.
export async function checkGithub(username, fetcher = fetch, signal, credential, clock = Date.now) {
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Local-Account-Desk', 'X-GitHub-Api-Version': '2022-11-28' };
    if (credential?.token) headers.Authorization = 'Bearer ' + credential.token;
    const response = await fetcher(`https://api.github.com/users/${encodeURIComponent(username)}`, {
      headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      redirect: 'error',
    });
    const quota = quotaOf(response, clock);
    const diagnostic = (status, kind, message) => ({ status, kind, message, httpStatus: response.status, quota });
    try {
      if (response.status === 200) {
        const profile = await response.json();
        if (typeof profile.login !== 'string' || profile.login.toLowerCase() !== username.toLowerCase() || profile.type !== 'User')
          return diagnostic('error', 'profile', '返回资料与个人账号不匹配，请核对用户名');
        return diagnostic('reachable', 'profile', 'GitHub 公开资料可访问；此结果不能判断登录限制或风控状态');
      }
      if (response.status === 404) return diagnostic('missing', 'profile', '公开资料不可访问：可能更名、删除或受限，无法仅据此判定封禁');
      if (response.status === 401) return diagnostic('error', 'auth', 'GitHub 已确认认证凭据无效，尚未判断账号状态');
      if (response.status === 403 || response.status === 429) {
        const kind = quota.remaining === 0 ? 'primary' : quota.retryAt ? 'secondary' : response.status === 429 ? 'quota' : 'forbidden';
        return diagnostic('limited', kind, kind === 'forbidden' ? 'GitHub 拒绝请求，请人工核对权限或限制' : 'GitHub 请求限流，保留进度等待恢复');
      }
      return diagnostic('error', response.status >= 500 ? 'server' : 'http', `GitHub 返回 HTTP ${response.status}，尚未判断账号状态`);
    } finally { try { if (!response.bodyUsed) await response.body?.cancel(); } catch {} }
  } catch {
    return { status: 'error', kind: signal?.aborted ? 'cancelled' : 'network', message: '网络请求失败或超时，未能判断账号状态，请检查网络后重试', httpStatus: null, quota: null };
  }
}

export function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function createChecker(store, fetcher = fetch, delayMs = 1100, options = {}) {
  const { pat = null, clock = Date.now, wait = abortableWait } = options;
  const persistence = store.pats || (store.db ? new PatStore(store) : null);
  const pageSize = 100;
  const emptyCounts = () => ({ reachable: 0, missing: 0, limited: 0, error: 0, skipped: 0 });
  let job = { running: false, total: 0, done: 0, message: '', current: '', cancelled: false, counts: emptyCounts(), currentId: '', scope: 'selected', phase: 'idle', retryAt: null, canResume: false };
  let queue = [], results = [], index = 0, authenticated = false;
  let controller, completion = Promise.resolve(), ownedPatTask = null;
  let schedule = null;
  const state = () => ({ queue, results, index, authenticated, job });
  const adopt = next => { ({ queue, results, index, authenticated, job } = next); };
  const transaction = action => store.transaction ? store.transaction(action) : action();
  const persist = (resultPage = -1, next = state(), publishQueue = false) => {
    if (!persistence) return;
    try {
      transaction(() => {
        if (publishQueue) {
          for (let page = 0; page < Math.ceil(next.queue.length / pageSize); page++) persistence.setCheckpoint('checks:queue:' + page, next.queue.slice(page * pageSize, (page + 1) * pageSize));
        }
        if (resultPage >= 0) persistence.setCheckpoint('checks:results:' + resultPage, next.results.slice(resultPage * pageSize, (resultPage + 1) * pageSize));
        persistence.setCheckpoint('checks', { version: 1, queuePages: Math.ceil(next.queue.length / pageSize), index: next.index, authenticated: next.authenticated, job: next.job });
      });
    } catch { throw new CheckpointError(); }
  };
  const persistenceFailed = () => {
    job.running = false; job.current = ''; job.currentId = '';
    job.phase = 'interrupted'; job.canResume = index < queue.length;
    job.message = new CheckpointError().message;
  };
  const saved = persistence?.getCheckpoint('checks');
  if (saved?.version === 1) {
    const loaded = [];
    let valid = Number.isInteger(saved.queuePages) && saved.queuePages > 0 && Number.isInteger(saved.index) && saved.index >= 0;
    for (let page = 0; valid && page < saved.queuePages; page++) {
      const rows = persistence.getCheckpoint('checks:queue:' + page);
      if (!Array.isArray(rows) || !rows.length || rows.length > pageSize || rows.some(row => typeof row.id !== 'string' || typeof row.username !== 'string')) valid = false;
      else loaded.push(...rows);
    }
    const recoveredResults = [];
    for (let page = 0; valid && page < Math.ceil(saved.index / pageSize); page++) {
      const rows = persistence.getCheckpoint('checks:results:' + page);
      if (!Array.isArray(rows)) valid = false;
      else recoveredResults.push(...rows);
    }
    if (valid && saved.index <= loaded.length && recoveredResults.length === saved.index && saved.job?.total === loaded.length) {
      queue = loaded; results = recoveredResults; index = saved.index; authenticated = saved.authenticated === true;
      job = { ...job, ...saved.job, counts: { ...emptyCounts(), ...saved.job.counts }, running: false, current: '', currentId: '', canResume: index < queue.length };
      job.autoResume = job.canResume && job.scope === 'scheduled' && !job.cancelled &&
        (saved.job.autoResume === true || (saved.job.running === true && ['checking', 'waiting', 'pat'].includes(saved.job.phase)));
      if (job.canResume) { job.phase = 'interrupted'; job.message = '检查已中断；点击继续后从未完成账号恢复'; }
      persist();
    }
  }
  const patEnabled = () => !!pat?.status().settings.enabled;
  const validRow = row => {
    try { const latest = store.get(row.id); return latest && !latest.deletedAt && latest.username === row.username && (job.scope !== 'scheduled' || !schedule || schedule.shouldCheck(latest)); }
    catch (error) { if (error.status === 404) return false; throw error; }
  };
  const pause = message => { job.phase = 'manual'; job.message = message; job.canResume = true; };
  const waitUntil = async retryAt => {
    const target = Date.parse(retryAt);
    if (!Number.isFinite(target) || target <= clock()) { pause('无法确认有效恢复时间，请人工核对限流状态后继续'); return false; }
    job.phase = 'waiting'; job.retryAt = retryAt; job.message = 'GitHub 配额冷却，保留当前进度等待恢复'; persist();
    while (target > clock()) {
      if (controller.signal.aborted) throw cancelled();
      await wait(Math.min(target - clock(), 2147483647), controller.signal);
    }
    if (controller.signal.aborted) throw cancelled();
    job.retryAt = null; job.phase = 'checking'; persist();
    return true;
  };
  const finishRow = (row, result, retryAt = job.retryAt, saveResult = true) => {
    const savedResult = result && validRow(row) && (saveResult ? store.setCheck(row.id, row.username, result, new Date(clock()).toISOString()) : true);
    const status = savedResult ? result.status : 'skipped';
    const nextIndex = index + 1;
    const next = {
      ...state(), index: nextIndex,
      results: [...results, { id: row.id, status, at: new Date(clock()).toISOString() }],
      job: { ...job, counts: { ...job.counts, [status]: job.counts[status] + 1 }, done: nextIndex, canResume: nextIndex < queue.length, retryAt: nextIndex < queue.length ? retryAt : null },
    };
    persist(Math.floor(index / pageSize), next);
    adopt(next);
    if (savedResult && saveResult) schedule?.completed(row.id);
  };
  async function run() {
    let credential = null;
    let failedCheckpoint = false;
    try {
      if (job.retryAt) {
        if (Date.parse(job.retryAt) <= clock()) { job.retryAt = null; persist(); }
        else if (!(await waitUntil(job.retryAt))) return;
      }
      while (index < queue.length && !controller.signal.aborted) {
        const row = queue[index];
        if (!validRow(row)) { finishRow(row, null); continue; }
        job.current = row.username; job.currentId = row.id; job.phase = 'checking'; persist();
        let authAttempts = 0, transientAttempts = 0, attempted = false;
        while (!controller.signal.aborted) {
          if (!validRow(row)) { finishRow(row, null); break; }
          const sharedCooldown = persistence?.getCheckpoint('global-cooldown');
          if (Date.parse(sharedCooldown?.waitUntil) > clock()) {
            if (!(await waitUntil(sharedCooldown.waitUntil))) return;
            continue;
          }
          if (authenticated) {
            if (!patEnabled()) { pause('PAT 自动维护已停用，请核对检测配置后继续'); return; }
            if (credential) {
              const records = pat.status().records;
              const current = records?.find(record => record.id === credential.id);
              if (records && (!current || ['disabled', 'manual', 'verifying'].includes(current.status))) {
                pause('当前 PAT 已停用或需要人工处理，请核对检测专用账号后继续'); return;
              }
              if (current && (current.status === 'invalid' || Date.parse(current.expiresAt) <= clock())) credential = null;
              if (current && Date.parse(current.retryAt) > clock()) credential = null;
            }
            if (!credential) {
              job.phase = 'pat'; job.message = '正在准备或验证 PAT 检测凭据'; persist();
              try {
                const previousTask = pat.active;
                const pending = pat.credential(controller.signal, { preferredId: job.patId });
                if (!previousTask && pat.active) ownedPatTask = pat.active;
                credential = await pending;
              }
              catch { if (!controller.signal.aborted) pause('PAT 不可用或需要人工处理，请查看检测专用账号后继续'); return; }
              if (controller.signal.aborted) break;
              if (credential?.waitUntil) {
                const retryAt = credential.waitUntil; credential = null;
                if (!(await waitUntil(retryAt))) return;
                continue;
              }
              if (typeof credential?.token !== 'string' || !credential.token || typeof credential?.id !== 'string') { pause('没有可用 PAT，请查看维护状态与候选账号'); return; }
              job.patId = credential.id;
              job.patUsername = credential.username || '';
              persist();
            }
          }
          if (controller.signal.aborted) break;
          if (!validRow(row)) { finishRow(row, null); break; }
          job.phase = 'checking'; job.message = '正在检查公开资料'; persist();
          if (job.scope === 'scheduled' && !attempted) { schedule?.attempted(store.get(row.id)); attempted = true; }
          let reported;
          const reportedFetcher = async (url, request) => {
            const response = await fetcher(url, request);
            if (credential && !controller.signal.aborted) reported = pat.reportResponse(credential.id, response);
            return response;
          };
          const result = await checkGithub(row.username, reportedFetcher, controller.signal, credential, clock);
          if (controller.signal.aborted) break;
          if (job.scope === 'scheduled' && result.kind === 'profile' && result.status === 'error') { finishRow(row, result, null, false); break; }
          if (result.status === 'reachable' || result.status === 'missing' || result.kind === 'profile') {
            const retryAt = reported?.cooldownScope === 'account' ? null : [result.quota?.retryAt, reported?.retryAt].filter(Boolean).sort().at(-1);
            finishRow(row, result, retryAt || null);
            if (reported?.cooldownScope === 'account') { credential = null; job.patId = null; }
            break;
          }
          if (result.kind === 'auth' && authenticated && ++authAttempts < 3) { credential = null; continue; }
          if (['primary', 'secondary', 'quota'].includes(result.kind)) {
            if (authenticated && reported?.cooldownScope === 'account') { credential = null; job.patId = null; continue; }
            const retryAt = [result.quota?.retryAt, reported?.retryAt].filter(Boolean).sort().at(-1);
            if (!retryAt) { pause('GitHub 请求限流但恢复时间未知，请人工核对后继续'); return; }
            if (!(await waitUntil(retryAt))) return;
            continue;
          }
          if (['network', 'server'].includes(result.kind) && ++transientAttempts < 3) {
            job.message = '网络或 GitHub 服务暂时异常，保留账号结果并有限重试'; persist();
            await wait(1000 * 2 ** (transientAttempts - 1), controller.signal);
            continue;
          }
          if (job.scope === 'scheduled' && ['network', 'server', 'http'].includes(result.kind)) { finishRow(row, result, null, false); break; }
          pause(result.message); return;
        }
        if (!controller.signal.aborted && index < queue.length) {
          if (job.retryAt && !(await waitUntil(job.retryAt))) return;
          if (delayMs > 0) { persist(); await wait(delayMs, controller.signal); }
        }
      }
      if (!controller.signal.aborted && index === queue.length) { job.phase = 'idle'; job.retryAt = null; job.message = '检查完成'; job.canResume = false; }
    } catch (error) {
      failedCheckpoint = error instanceof CheckpointError;
      if (failedCheckpoint) persistenceFailed();
      else if (!controller.signal.aborted) { job.phase = 'interrupted'; job.message = '检查中断，请继续未完成的账号'; }
    }
    finally {
      job.running = false; job.current = ''; job.currentId = ''; job.canResume = index < queue.length;
      if (controller.signal.aborted) {
        job.cancelled = true;
        if (!failedCheckpoint) { job.phase = 'interrupted'; job.message = '检查已取消，已完成的结果已保留'; }
      }
      persist();
    }
  }
  function launch(next = state(), publishQueue = false) {
    next = { ...next, job: { ...next.job, running: true, cancelled: false, canResume: false, autoResume: false } };
    // Neither start/resume nor completed-row publication changes live progress
    // until its queue/result pages and manifest have committed successfully.
    persist(-1, next, publishQueue);
    adopt(next); controller = new AbortController();
    // Attach at creation: finalization may reject before any caller cancels or
    // polls. A failed write changes only safe live diagnostics, never durability.
    completion = run().catch(persistenceFailed);
  }
  return {
    setSchedule(value) { schedule = value; },
    status: () => ({ ...job, counts: { ...job.counts } }),
    prepareRemoval(ids) {
      if (job.running) throw new AppError('请先停止检查再永久删除账号',409);
      const removed = new Set(ids);
      const nextQueue = queue.filter(row => !removed.has(row.id));
      const nextResults = results.filter(row => !removed.has(row.id));
      const nextIndex = queue.slice(0,index).filter(row => !removed.has(row.id)).length;
      const counts = emptyCounts();
      for (const row of nextResults) if (row.status in counts) counts[row.status]++;
      const next = {...state(), queue:nextQueue, results:nextResults, index:nextIndex,
        job:{...job, total:nextQueue.length, done:nextIndex, counts, current:'',currentId:'',canResume:nextIndex<nextQueue.length,
          ...(nextIndex>=nextQueue.length?{phase:'idle',retryAt:null,message:'',cancelled:false}:{})}};
      return {
        // Called within the account deletion transaction; no stale checkpoint pages remain.
        persist() {
          if (!persistence) return;
          store.db.exec("DELETE FROM pat_checkpoints WHERE name='checks' OR name LIKE 'checks:%'");
          for(let page=0;page<Math.ceil(nextQueue.length/pageSize);page++) persistence.setCheckpoint('checks:queue:'+page,nextQueue.slice(page*pageSize,(page+1)*pageSize));
          for(let page=0;page<Math.ceil(nextResults.length/pageSize);page++) persistence.setCheckpoint('checks:results:'+page,nextResults.slice(page*pageSize,(page+1)*pageSize));
          if(nextQueue.length) persistence.setCheckpoint('checks',{version:1,queuePages:Math.ceil(nextQueue.length/pageSize),index:nextIndex,authenticated,job:next.job});
        },
        commit() { adopt(next); },
      };
    },
    async cancel({ shutdown = false } = {}) {
      const recover = shutdown && job.running && job.scope === 'scheduled' && !job.cancelled && ['checking', 'waiting', 'pat'].includes(job.phase);
      if (job.running) { job.cancelled = true; controller.abort(); }
      await completion;
      // A manual browser may outlive credential(). Only close the exact task
      // synchronously claimed by this checker, never a user task or replacement.
      if (ownedPatTask && pat?.active === ownedPatTask) await pat.stop();
      if (recover && job.canResume) {
        job.cancelled = false; job.autoResume = true;
        job.message = '服务停止，自动检测将在重启后接续';
        persist();
      }
    },
    resume() {
      if (job.running) throw new AppError('已有检查任务运行中', 409);
      if (!job.canResume || index >= queue.length) throw new AppError('没有可继续的检查任务', 409);
      launch(); return this.status();
    },
    startAll() { return this.start(store.list().filter(row => !row.deletedAt).map(row => row.id), 'all'); },
    start(ids, scope = 'selected') {
      if (job.running) throw new AppError('已有检查任务运行中', 409);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new AppError('账号列表无效');
      const rows = [...new Set(ids)].map(id => store.get(id));
      if (!rows.length) throw new AppError('没有需要检查的账号');
      const next = {
        queue: rows.map(({ id, username }) => ({ id, username })), results: [], index: 0, authenticated: patEnabled(),
        job: { running: false, total: rows.length, done: 0, message: '正在检查公开资料', current: '', cancelled: false, counts: emptyCounts(), currentId: '', scope: scope === 'selected' && rows.length === 1 ? 'single' : scope, phase: 'checking', retryAt: null, canResume: false, patId: null, patUsername: '' },
      };
      launch(next, true); return this.status();
    },
  };
}
