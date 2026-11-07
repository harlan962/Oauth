const patLabels = { preparing: '准备中', verifying: '待验证', valid: '可用', cooling: '额度冷却', manual: '需处理', invalid: '已失效', disabled: '已停用', pending: '待准备' };
const workbuddyLabels = { queued: '待执行', running: '执行中', manual: '待人工处理', linked: '已关联', external: '外部已登记' };

// Public projections only: never load credentials, decrypt tokens, expire records,
// reconcile reservations, or invoke a task service from an account read.
export function accountTaskMetadata(store, accounts) {
  const db = store.db;
  // Compatibility for the old, explicitly confirmed external-pool registration.
  // Require the current selection AND its migrated registration, not a keyword in notes/purpose.
  const externalRegistrations = new Map(db.prepare(`SELECT r.accountId,r.selectedAt FROM workbuddy_registrations r
    JOIN accounts a ON a.id=r.accountId AND a.selectedAt=r.selectedAt AND a.username=r.username COLLATE NOCASE
    WHERE a.purpose=?`).all('WorkBuddy 国际版：远端账号池已存在（用户确认）').map(row=>[row.accountId,row.selectedAt]));
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const latestPats = new Map();
  const patsById = new Map();
  const timestamp = Date.now();
  if (tables.has('pats')) {
    const rows = db.prepare(`SELECT p.id,p.accountId,a.username,p.status,p.message,p.createdAt,p.expiresAt,
      p.remaining,p."limit",p.resetAt,p.retryAt,p.creationUncertain,(p.token IS NOT NULL) AS hasToken
      FROM pats p JOIN accounts a ON a.id=p.accountId ORDER BY p.createdAt DESC,p.rowid DESC`).all();
    for (const row of rows) {
      const expired = row.expiresAt && Date.parse(row.expiresAt) <= timestamp && !row.creationUncertain && !['invalid','disabled'].includes(row.status);
      const pat = { ...row, creationUncertain: !!row.creationUncertain, hasToken: !!row.hasToken,
        ...(expired ? { status: 'invalid', message: 'PAT 已过期' } : {}) };
      patsById.set(pat.id, pat);
      if (!latestPats.has(pat.accountId)) latestPats.set(pat.accountId, pat);
    }
  }
  const jobs = new Map(tables.has('workbuddy_jobs')
    ? db.prepare('SELECT id,targetId,targetName,status,running FROM workbuddy_jobs').all().map(row => [row.id, row]) : []);
  const latestResults = new Map();
  const latestFinished = new Map();
  const reservations = new Map();
  if (tables.has('workbuddy_items')) {
    for (const row of db.prepare('SELECT jobId,accountId,status,message,finishedAt,reserved FROM workbuddy_items ORDER BY rowid DESC').all()) {
      if (!['queued', 'skipped'].includes(row.status)) {
        if (!latestResults.has(row.accountId)) latestResults.set(row.accountId, row);
        // An active retry or malformed historical timestamp must not erase the
        // last real processing end time. Navigation still uses latestResults.
        if (row.finishedAt && Number.isFinite(Date.parse(row.finishedAt)) && !latestFinished.has(row.accountId)) latestFinished.set(row.accountId, row.finishedAt);
      }
      if (row.reserved && jobs.has(row.jobId)) {
        if (!reservations.has(row.accountId)) reservations.set(row.accountId, new Map());
        if (!reservations.get(row.accountId).has(row.jobId)) reservations.get(row.accountId).set(row.jobId, row);
      }
    }
  }
  const targetNames = new Map(tables.has('integration_targets')
    ? db.prepare('SELECT id,name FROM integration_targets').all().map(row => [row.id, row.name]) : []);
  const mappings = new Map();
  if (tables.has('workbuddy_mappings')) {
    for (const row of db.prepare('SELECT accountId,targetId,jobId,createdAt FROM workbuddy_mappings ORDER BY createdAt DESC,rowid DESC').all()) {
      if (!mappings.has(row.accountId)) mappings.set(row.accountId, []);
      mappings.get(row.accountId).push(row);
    }
  }
  const restricted = new Set(tables.has('workbuddy_restrictions')
    ? db.prepare('SELECT accountId FROM workbuddy_restrictions').all().map(row => row.accountId) : []);
  // Reuse the actual selection query, including its NULL and freshness rules.
  const candidates = new Set(store.candidateRows().map(row => row.id));
  return new Map(accounts.map(account => {
    const links = mappings.get(account.id) || [];
    const registeredAt = externalRegistrations.get(account.id) || null;
    const result = latestResults.get(account.id);
    const reservedPat = typeof account.reservedBy === 'string' && account.reservedBy.startsWith('pat:')
      ? patsById.get(account.reservedBy.slice(4)) : null;
    const patReservation = reservedPat?.accountId === account.id ? reservedPat : null;
    const pat = patReservation || latestPats.get(account.id) || null;
    const item = reservations.get(account.id)?.get(account.reservedBy);
    const job = item && jobs.get(item.jobId);
    const unknownReservation = !!account.reservedBy && !patReservation && !item;
    const patOwned = !!account.patDedicated || !!patReservation;
    const workbuddyOwned = !!links.length || !!item || !!registeredAt;
    const owner = patOwned ? 'pat' : workbuddyOwned ? 'workbuddy' : account.selectedAt || account.reservedBy ? 'other' : 'unassigned';
    let state = owner === 'other' ? unknownReservation ? 'unknown' : 'assigned' : 'unassigned';
    let label = unknownReservation ? '占用来源待核对' : owner === 'other' ? '其他已分配' : '未分配';
    let message = unknownReservation ? '当前占用无法关联到此账号的任务，请核对占用来源' : owner === 'other' ? '已设置选用标记；用途见账号详情' : '尚未分配任务';
    if (owner === 'pat') {
      state = pat?.status || 'pending';
      const active = store.patService?.active;
      if (state === 'preparing' && !(active?.record?.id === pat.id && active.record.accountId === account.id && !active.manual && !active.controller?.signal.aborted)) state = 'manual';
      label = patLabels[state] || '需处理';
      message = pat?.message || (state === 'pending' ? '已标记 PAT 专用，尚无 PAT 记录' : state === 'manual' ? '当前没有可确认的执行任务，请核对后处理' : label);
    } else if (owner === 'workbuddy') {
      state = item ? item.status === 'queued' && job.running ? 'queued'
        : job.running && job.status === 'running' && ['linking', 'browser', 'polling'].includes(item.status) ? 'running' : 'manual'
        : links.length ? 'linked' : 'external';
      label = workbuddyLabels[state];
      message = item?.message || (state === 'linked' ? '已保存账号与 WorkBuddy 目标的关联' : state === 'external' ? '历史记录已确认此账号在远端 WorkBuddy 账号池中；保留选用保护，未生成自动授权 UID 关联' : label);
    }
    const canPat = candidates.has(account.id);
    const canWorkbuddy = canPat && !restricted.has(account.id);
    const reasons = [];
    if (account.deletedAt) reasons.push('账号在回收站');
    if (account.patDedicated) reasons.push('已设为 PAT 专用');
    if (account.selectedAt) reasons.push('账号已选用');
    if (account.reservedBy !== null && account.reservedBy !== undefined) reasons.push('账号存在任务占用');
    if (links.length) reasons.push('已关联 WorkBuddy');
    if (!account.hasTotp) reasons.push('缺少 TOTP 密钥');
    if (account.publicStatus === 'unchecked' || !account.checkedAt) reasons.push('尚未检测');
    else if (account.publicStatus !== 'reachable') reasons.push('公开检测未确认可访问');
    else if (Date.parse(account.checkedAt) < timestamp - 86400000 || !Number.isFinite(Date.parse(account.checkedAt))) reasons.push('公开检测已过期，请重新检测');
    if (restricted.has(account.id)) reasons.push('WorkBuddy 访问受限；不影响 PAT 候选条件');
    return [account.id, { pat, taskSummary: {
      owner, state, label, message,
      workbuddyLinkedAt: links[0]?.createdAt || null,
      workbuddyRegisteredAt: registeredAt,
      workbuddyFinishedAt: latestFinished.get(account.id) || null,
      workbuddyJobId: item?.jobId || result?.jobId || links[0]?.jobId || null,
      workbuddyLinks: links.map(link => ({ targetId: link.targetId, targetName: targetNames.get(link.targetId) || jobs.get(link.jobId)?.targetName || link.targetId, createdAt: link.createdAt })),
      canWorkbuddy, canPat, candidateReason: reasons.join('；') || (canPat ? '符合 WorkBuddy 和 PAT 候选条件' : '暂不满足候选条件'),
      conflict: (patOwned && workbuddyOwned) || (patOwned && !!account.selectedAt) || (unknownReservation && (patOwned || workbuddyOwned)),
    } }];
  }));
}
