export type ColumnId = 'identity' | 'group' | 'tags' | 'totp' | 'status' | 'createdAt' | 'checkedAt' | 'selectedAt' | 'task' | 'workbuddyFinishedAt' | 'workbuddyLinkedAt' | 'patExpiresAt' | 'notes' | 'deletedAt' | 'actions';
export type ColumnView = 'accounts' | 'workbuddy' | 'pat' | 'occupied' | 'trash';
export type ColumnSection = '基本信息' | '检测' | '任务与时间';
export type AccountColumn = { id: ColumnId; label: string; section: ColumnSection; fixed?: boolean };

export const accountColumns: readonly AccountColumn[] = [
  { id: 'identity', label: '账号信息', section: '基本信息', fixed: true },
  { id: 'group', label: '来源分组', section: '基本信息' },
  { id: 'tags', label: '标签', section: '基本信息' },
  { id: 'totp', label: 'TOTP', section: '基本信息' },
  { id: 'status', label: '检测状态', section: '检测' },
  { id: 'createdAt', label: '入库时间', section: '任务与时间' },
  { id: 'checkedAt', label: '最近检测时间', section: '检测' },
  { id: 'selectedAt', label: '选用时间', section: '任务与时间' },
  { id: 'task', label: '任务状态', section: '任务与时间' },
  { id: 'workbuddyFinishedAt', label: '最近 WorkBuddy 处理结束时间', section: '任务与时间' },
  { id: 'workbuddyLinkedAt', label: 'WorkBuddy 关联时间', section: '任务与时间' },
  { id: 'patExpiresAt', label: 'PAT 到期时间', section: '任务与时间' },
  { id: 'notes', label: '备注', section: '基本信息' },
  { id: 'deletedAt', label: '移除时间', section: '任务与时间' },
  { id: 'actions', label: '操作', section: '基本信息', fixed: true },
];

export function availableColumns(view: ColumnView) {
  return accountColumns.filter(column => column.id !== 'deletedAt' || view === 'trash');
}

function orderedColumns(view: ColumnView, visible: readonly ColumnId[]): ColumnId[] {
  const chosen = new Set(visible);
  return availableColumns(view).filter(column => column.fixed || chosen.has(column.id)).map(column => column.id);
}

export function defaultColumns(view: ColumnView): ColumnId[] {
  const defaults: ColumnId[] = ['identity', 'group', 'tags', 'totp', 'status', 'createdAt', 'actions'];
  if (view === 'workbuddy' || view === 'pat' || view === 'occupied') defaults.push('task');
  if (view === 'pat') defaults.push('patExpiresAt');
  if (view === 'trash') defaults.push('deletedAt');
  return orderedColumns(view, defaults);
}

export function toggleColumn(view: ColumnView, visible: readonly ColumnId[], id: ColumnId): ColumnId[] {
  const column = availableColumns(view).find(entry => entry.id === id);
  if (!column || column.fixed) return orderedColumns(view, visible);
  return orderedColumns(view, visible.includes(id) ? visible.filter(entry => entry !== id) : [...visible, id]);
}

type ColumnStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const columnStorageKey = (view: ColumnView) => `account-desk:columns:v1:${view}`;

function browserStorage(): ColumnStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function loadColumns(view: ColumnView, storage: Pick<ColumnStorage, 'getItem'> | undefined = browserStorage()): ColumnId[] {
  try {
    const raw = storage?.getItem(columnStorageKey(view));
    if (!raw) return defaultColumns(view);
    const config: unknown = JSON.parse(raw);
    if (!config || typeof config !== 'object' || !('version' in config) || config.version !== 1 || !('visible' in config) || !Array.isArray(config.visible)) return defaultColumns(view);
    const allowed = new Set<string>(availableColumns(view).map(column => column.id));
    if (!config.visible.every(id => typeof id === 'string' && allowed.has(id))) return defaultColumns(view);
    return orderedColumns(view, config.visible as ColumnId[]);
  } catch { return defaultColumns(view); }
}

export function saveColumns(view: ColumnView, visible: readonly ColumnId[], storage: Pick<ColumnStorage, 'setItem'> | undefined = browserStorage()): void {
  try { storage?.setItem(columnStorageKey(view), JSON.stringify({ version: 1, visible: orderedColumns(view, visible) })); }
  catch { /* Column preferences are optional; storage must never block account management. */ }
}

export type AccountSort = 'newest' | 'oldest' | 'checked-newest' | 'checked-oldest' | 'username';
type SortableAccount = { id: string; username: string; createdAt?: string | null; checkedAt?: string | null };
const timestamp = (value?: string | null) => value ? Date.parse(value) : NaN;
const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function sortAccounts<T extends SortableAccount>(rows: readonly T[], sort: AccountSort): T[] {
  return [...rows].sort((left, right) => {
    const tie = () => compareIds(left.id, right.id);
    if (sort === 'username') return left.username.localeCompare(right.username) || tie();
    const field = sort.startsWith('checked-') ? 'checkedAt' : 'createdAt';
    const a = timestamp(left[field]), b = timestamp(right[field]);
    if (!Number.isFinite(a)) return Number.isFinite(b) ? 1 : tie();
    if (!Number.isFinite(b)) return -1;
    const direction = sort === 'oldest' || sort === 'checked-oldest' ? 1 : -1;
    return (a - b) * direction || tie();
  });
}

const beijingTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function fullAccountTime(value?: string | null): string {
  const time = timestamp(value);
  if (!Number.isFinite(time)) return '—';
  const parts = Object.fromEntries(beijingTime.formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function accountTime(value?: string | null): string {
  return fullAccountTime(value).slice(0, 16);
}
