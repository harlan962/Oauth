export type Account = {
  id: string;
  email: string;
  username: string;
  hasTotp: number;
  notes: string;
  groupId?: string | null;
  tagIds?: string[];
  publicStatus: "unchecked" | "reachable" | "missing" | "limited" | "error";
  checkMessage: string;
  checkedAt: string | null;
  selectedAt: string | null;
  reservedBy?: string | null;
  patDedicated?: number;
  pat?: PatRecord | null;
  taskSummary?: {
    owner: 'unassigned' | 'workbuddy' | 'pat' | 'other';
    state: string;
    label: string;
    message: string;
    workbuddyLinkedAt: string | null;
    workbuddyRegisteredAt?: string | null;
    workbuddyFinishedAt: string | null;
    workbuddyJobId: string | null;
    workbuddyLinks: { targetId: string; targetName: string; createdAt: string }[];
    canWorkbuddy: boolean;
    canPat: boolean;
    candidateReason: string;
    conflict: boolean;
  };
  workbuddyResult?: {
    status: string;
    message: string;
    finishedAt: string | null;
  } | null;
  purpose: string;
  createdAt: string;
  deletedAt: string | null;
};
export const workbuddyOutcomeLabel = (status: string) =>
  ({
    success: "授权成功",
    failed: "授权失败",
    unknown: "结果未知",
    restricted: "访问受限",
    manual: "等待操作",
    linking: "获取链接中",
    browser: "登录检查中",
    polling: "确认结果中",
  })[status] || "未完成";
export type Job = {
  patId?: string | null;
  patUsername?: string | null;
  phase?: "idle" | "checking" | "waiting" | "pat" | "manual" | "interrupted";
  retryAt?: string | null;
  canResume?: boolean;
  running: boolean;
  total: number;
  done: number;
  current: string;
  message: string;
  cancelled: boolean;
  currentId: string;
  scope: string;
  counts: {
    reachable: number;
    missing: number;
    limited: number;
    error: number;
    skipped: number;
  };
};
export type Preview = {
  records: {
    line: number;
    email: string;
    username: string;
    hasTotp: boolean;
    duplicate: boolean;
  }[];
  errors: { line: number; message: string }[];
};
export type Secrets = {
  password: string;
  totp: string;
  otp: { code: string; expiresAt: number } | null;
};
export const statusLabels: Record<Account["publicStatus"], string> = {
  unchecked: "未检测",
  reachable: "公开可访问",
  missing: "公开不可访问",
  limited: "无法判断 · 请求受限",
  error: "无法判断 · 检测失败",
};
export type OrganizationItem = { id: string; name: string; color?: string; count: number };
export type OrganizationData = { groups: OrganizationItem[]; tags: OrganizationItem[] };
export type CheckStatus = 'reachable' | 'missing' | 'unknown' | 'unchecked';
export type CheckRule = {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'interval' | 'staged';
  intervalDays: number;
  stageDays: number[];
  baseline: 'imported' | 'date';
  baselineDate: string | null;
  repeatDays: number;
  statuses: CheckStatus[];
  groupIds: string[] | null;
  tagIds: string[] | null;
};
export type CheckSettingsData = { version: 2; enabled: boolean; rules: CheckRule[] };
export type CheckSettingsPreview = {
  settings: CheckSettingsData;
  matched: number;
  due: number;
  nextDueAt: string | null;
  invalidFilters: string[];
  message: string;
  rules: { id: string; matched: number; due: number; nextDueAt: string | null; invalidFilters: string[] }[];
};
export const emptyOrganization: OrganizationData = { groups: [], tags: [] };
export function eligible(a: Account) {
  return (
    !a.deletedAt &&
    !!a.hasTotp &&
    !a.patDedicated &&
    !a.selectedAt &&
    a.workbuddyResult?.status !== "success" &&
    !a.reservedBy &&
    a.publicStatus === "reachable" &&
    !!a.checkedAt &&
    Date.parse(a.checkedAt) >= Date.now() - 86400000
  );
}
export type PatState = "preparing" | "valid" | "cooling" | "invalid" | "manual" | "disabled" | "verifying";
export type PatRecord = {
  id: string; accountId: string; username: string; status: PatState;
  message: string; createdAt: string | null; expiresAt: string | null;
  remaining: number | null; limit: number | null; resetAt: string | null;
  retryAt: string | null; creationUncertain: boolean;
  hasToken?: boolean;
};
export type PatStatus = { settings: { enabled: boolean; targetCount: number }; records: PatRecord[]; running: boolean; activeId: string | null; message: string };
export const patLabels = {preparing: "准备中", valid: "可用", cooling: "额度冷却", invalid: "已失效", manual: "需处理", disabled: "已停用"} as const;
export function patState(status?: PatState): keyof typeof patLabels { return status === "verifying" ? "manual" : status || "manual"; }
export function beijingDate(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleString("zh-CN", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
}
export function date(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
}
