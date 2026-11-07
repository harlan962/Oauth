export type Target = {
  id: string;
  name: string;
  baseUrl: string;
  revision: string;
  hasApiKey: boolean;
  browserProxy?: {
    server: string;
    username: string;
    hasPassword: boolean;
  } | null;
};
export type Candidate = {
  id: string;
  username: string;
  email: string;
  hasTotp: boolean | number;
};
export type RunPreview = {
  target: Target;
  accounts: Candidate[];
  count: number;
};
export type RunItem = {
  position: number;
  accountId: string;
  username: string;
  email: string;
  status:
    | "queued"
    | "linking"
    | "browser"
    | "manual"
    | "restricted"
    | "polling"
    | "success"
    | "failed"
    | "unknown"
    | "skipped";
  message: string;
  createdAt: string | null;
  finishedAt: string | null;
  uid?: string;
  url?: string;
  reserved: boolean;
};
export type RunSummary = {
  id: string;
  targetId: string;
  targetName: string;
  baseUrl: string;
  total: number;
  status: "running" | "paused" | "completed" | "stopped";
  running: boolean;
  createdAt: string;
  finishedAt: string | null;
  message: string;
};
export type RunJob = RunSummary & {
  items: RunItem[];
  logs: {
    id: number;
    createdAt: string;
    level: string;
    message: string;
    position?: number;
  }[];
};
export const runLabels: Record<RunItem["status"], string> = {
  queued: "等待执行",
  linking: "获取链接",
  browser: "浏览器授权",
  manual: "验证未完成（旧记录）",
  restricted: "WorkBuddy 访问受限",
  polling: "确认入池结果",
  success: "授权成功",
  failed: "执行失败",
  unknown: "结果未确认",
  skipped: "未执行",
};
export const jobLabels = {
  running: "运行中",
  paused: "已暂停",
  completed: "已结束",
  stopped: "已停止",
};
export const fullTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
