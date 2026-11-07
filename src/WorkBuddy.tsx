import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ListChecks,
  LoaderCircle,
  Play,
  RefreshCw,
  Settings2,
  Square,
  Target as TargetIcon,
  Timer,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "./api";
import { Modal } from "./components";
import { WorkBuddyConfig } from "./WorkBuddyConfig";
import {
  fullTime,
  jobLabels,
  type Candidate,
  type RunJob,
  type RunPreview,
  type RunSummary,
  type Target,
} from "./workbuddy-types";

const terminal = new Set(["success", "failed", "unknown", "restricted"]);
const logClearKey = 'account-desk:workbuddy-log-clears:v1';
function loadLogClears(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(logClearKey) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]) && entry[1] > 0,
    ));
  } catch { return {}; }
}
const elapsed = (
  start: string | undefined,
  end: string | null | undefined,
  now: number,
) => {
  if (!start) return "00:00";
  const seconds = Math.max(
    0,
    Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000),
  );
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};

export function RunMetrics({
  job,
  count,
  now,
}: {
  job: RunJob | null;
  count: number;
  now: number;
}) {
  const total = job?.total ?? count;
  const success = job?.items.filter((i) => i.status === "success").length || 0;
  const failed =
    job?.items.filter((i) =>
      ["failed", "restricted", "unknown"].includes(i.status),
    ).length || 0;
  const done = job?.items.filter((i) => terminal.has(i.status)).length || 0;
  const skipped = job?.items.filter((i) => i.status === "skipped").length || 0;
  return (
    <div className="wb-metrics">
      <div>
        <span>
          <TargetIcon size={15} />
          目标
        </span>
        <strong aria-label={`目标账号：${total}`}>{total}</strong>
      </div>
      <div className="wb-metric-success">
        <span>
          <CheckCircle2 size={15} />
          成功
        </span>
        <strong aria-label={`授权成功：${success}`}>{success}</strong>
      </div>
      <div className="wb-metric-failed">
        <span>
          <XCircle size={15} />
          未完成
        </span>
        <strong aria-label={`未完成：${failed}`}>{failed}</strong>
      </div>
      <div>
        <span>
          <ListChecks size={15} />
          进度
        </span>
        <strong aria-label={`已处理：${done}/${total}`}>
          {done}
          <small> / {total}</small>
        </strong>
        {skipped > 0 && <small>未执行：{skipped}</small>}
      </div>
      <div>
        <span>
          <Clock3 size={15} />
          开始时间
        </span>
        <strong className="wb-metric-time" title={fullTime(job?.createdAt)}>
          {job
            ? new Date(job.createdAt).toLocaleTimeString("zh-CN", {
                hour12: false,
              })
            : "—"}
        </strong>
      </div>
      <div>
        <span>
          <Timer size={15} />
          耗时
        </span>
        <strong className="wb-metric-time">
          {elapsed(job?.createdAt, job?.finishedAt, now)}
        </strong>
      </div>
    </div>
  );
}

export function RunConfirmation({
  preview,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  preview: RunPreview;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="确认开始 GitHub 授权？"
      subtitle="请核对部署地址和本次账号。"
      role="alertdialog"
      describedBy="wb-confirm-description"
      className="wb-confirm"
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <div className="modal-body">
        <dl className="wb-facts">
          <div>
            <dt>目标部署</dt>
            <dd>{preview.target.name}</dd>
          </div>
          <div>
            <dt>部署地址</dt>
            <dd>
              <code>{preview.target.baseUrl}</code>
            </dd>
          </div>
          <div>
            <dt>版本 / 数量</dt>
            <dd>国际版 Global · {preview.count} 个账号，逐一执行</dd>
          </div>
        </dl>
        <div className="wb-preview-list" aria-label="本次账号">
          {preview.accounts.map((a, i) => (
            <div key={a.id}>
              <span>{i + 1}</span>
              <strong>@{a.username}</strong>
              <small>{a.hasTotp ? "自动填写 TOTP" : "未保存 TOTP 密钥"}</small>
            </div>
          ))}
        </div>
        <p id="wb-confirm-description" className="wb-help">
          将在本机打开独立的可见浏览器，选择 GitHub 并填写当前账号和已保存的
          TOTP
          验证码。需要邮箱验证码的账号会立即跳过；其他无法自动完成的验证或页面异常会限时重试后继续后续账号。仅在远端确认授权成功后标记本地账号已使用。
        </p>
        <div className="wb-notice">
          <CircleAlert size={18} />
          <span>
            远端确认接口会将账号加入账号池；该项目源码还会执行注册激活（可能自动补地区）及
            trial
            领取。请只操作你有权使用的账号，并确认接受这些远端行为。停止任务不能撤销已发生的授权。
          </span>
        </div>
        {error && (
          <p className="wb-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-footer wb-actions">
        <button className="button" autoFocus disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="button primary" disabled={busy} onClick={onConfirm}>
          {busy && <LoaderCircle size={16} className="spin" />}
          {busy ? "正在启动…" : "确认开始"}
        </button>
      </footer>
    </Modal>
  );
}

export function WorkBuddy({
  active,
  notify,
  onAccountsChanged,
  requestedJob,
}: {
  requestedJob?: {id:string} | null;
  active: boolean;
  notify: (s: string) => void;
  onAccountsChanged: () => Promise<void>;
}) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reserved, setReserved] = useState(0);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [job, setJob] = useState<RunJob | null>(null);
  const [count, setCount] = useState("1");
  const [config, setConfig] = useState(false);
  const [preview, setPreview] = useState<
    (RunPreview & { requestId: string }) | null
  >(null);
  const [confirm, setConfirm] = useState<"stop" | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [logClears, setLogClears] = useState(loadLogClears);
  const clearThrough = job ? logClears[job.id] || 0 : 0;
  const [now, setNow] = useState(Date.now());
  const logBox = useRef<HTMLDivElement>(null);
  const selectedJob = useRef("");
  const appliedRequest = useRef<{id:string} | null>(null);
  const selectedTarget = useRef("");
  const sequence = useRef(0);
  const operation = useRef(false);
  const running = history.find((j) => j.running);
  const runningId = job?.running ? job.id : running?.id;
  const target = targets.find((t) => t.id === targetId);
  const number = Number(count);
  const validCount = Number.isInteger(number) && number >= 1 && number <= 100;
  const refresh = useCallback(async () => {
    const token = ++sequence.current;
    const [saved, available, jobs] = await Promise.all([
      api<Target[]>("/integrations/targets"),
      api<{ accounts: Candidate[]; reserved: number }>("/workbuddy/candidates"),
      api<RunSummary[]>("/workbuddy/jobs"),
    ]);
    const id =
      selectedJob.current || jobs.find((j) => j.running)?.id || jobs[0]?.id;
    const current = id ? await api<RunJob>("/workbuddy/jobs/" + id) : null;
    if (token !== sequence.current) return;
    setTargets(saved);
    setCandidates(available.accounts);
    setReserved(available.reserved);
    setHistory(jobs);
    if (!saved.some((t) => t.id === selectedTarget.current))
      selectedTarget.current = saved[0]?.id || "";
    setTargetId(selectedTarget.current);
    selectedJob.current = id || "";
    setJob(current);
    setLoaded(true);
    setError("");
    setSyncError("");
  }, []);
  useEffect(() => {
    if (!active) return;
    if (requestedJob && appliedRequest.current !== requestedJob) {
      selectedJob.current = requestedJob.id;
      appliedRequest.current = requestedJob;
    }
    let live = true;
    refresh().catch((e) => {
      if (live) {
        setError(e.message);
        setLoaded(true);
      }
    });
    return () => {
      live = false;
      sequence.current++;
    };
  }, [active, refresh, requestedJob]);
  useEffect(() => {
    if (!runningId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const [state, available] = await Promise.all([
          api<RunJob>("/workbuddy/jobs/" + runningId),
          api<{ accounts: Candidate[]; reserved: number }>(
            "/workbuddy/candidates",
          ),
        ]);
        if (stopped) return;
        setSyncError("");
        setCandidates(available.accounts);
        setReserved(available.reserved);
        if (selectedJob.current === state.id) setJob(state);
        setHistory((rows) =>
          rows.map((row) => (row.id === state.id ? state : row)),
        );
        if (!state.running) {
          await Promise.all([refresh(), onAccountsChanged()]);
          return;
        }
      } catch (e) {
        if (!stopped)
          setSyncError(
            "任务状态暂时无法同步：" +
              (e as Error).message +
              "。请勿重复启动。",
          );
      }
      if (!stopped) timer = setTimeout(tick, 1200);
    };
    timer = setTimeout(tick, 800);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runningId, refresh, onAccountsChanged]);
  useEffect(() => {
    if (!active || !job?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, job?.running]);
  useEffect(() => {
    if (autoScroll && logBox.current)
      logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [job?.logs.length, autoScroll, clearThrough]);
  useEffect(() => {
    if (!runningId) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [runningId]);
  async function act(key: string, action: () => Promise<void>, modal = false) {
    if (operation.current) return;
    operation.current = true;
    setBusy(key);
    if (modal) setConfirmError("");
    else setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      if (modal) setConfirmError((e as Error).message);
    } finally {
      operation.current = false;
      setBusy("");
    }
  }
  function selectJob(id: string) {
    selectedJob.current = id;
    void act("load", refresh);
  }
  function clearLogs() {
    if (!job?.logs.length) return;
    const next = { ...loadLogClears(), ...logClears, [job.id]: job.logs.at(-1)!.id };
    setLogClears(next);
    try { localStorage.setItem(logClearKey, JSON.stringify(next)); }
    catch { notify('当前日志已隐藏，但浏览器无法保存清空位置，刷新后可能恢复。'); }
  }
  function saved(target: Target) {
    setTargets((rows) =>
      rows.some((r) => r.id === target.id)
        ? rows.map((r) => (r.id === target.id ? target : r))
        : [...rows, target],
    );
    selectedTarget.current = target.id;
    setTargetId(target.id);
  }
  function prepare() {
    if (!target || !validCount) return;
    void act("preview", async () => {
      const result = await api<RunPreview>("/workbuddy/preview", "POST", {
        targetId: target.id,
        targetRevision: target.revision,
        count: number,
        realm: "global",
      });
      setConfirmError("");
      setPreview({ ...result, requestId: crypto.randomUUID() });
    });
  }
  function start() {
    if (!preview) return;
    void act(
      "start",
      async () => {
        const result = await api<RunJob>("/workbuddy/jobs", "POST", {
          targetId: preview.target.id,
          targetRevision: preview.target.revision,
          realm: "global",
          count: preview.count,
          accountIds: preview.accounts.map((a) => a.id),
          requestId: preview.requestId,
        });
        selectedJob.current = result.id;
        setJob(result);
        setHistory((rows) => [
          result,
          ...rows.filter((r) => r.id !== result.id),
        ]);
        setPreview(null);
        setNow(Date.now());
        await refresh();
        await onAccountsChanged();
      },
      true,
    );
  }
  function confirmAction() {
    if (!job || !confirm) return;
    void act(
      "confirm",
      async () => {
        const result = await api<RunJob>(
          "/workbuddy/jobs/" + job.id + "/cancel",
          "POST",
          { acknowledge: true },
        );
        setJob(result);
        setConfirm(null);
        await refresh();
        await onAccountsChanged();
      },
      true,
    );
  }
  const logs = job?.logs.filter((l) => l.id > clearThrough) || [];
  return (
    <section
      className="wb-page"
      hidden={!active}
      aria-label="WorkBuddy2api 授权工作台"
    >
      <div className="wb-page-toolbar">
        <button
          className="button"
          onClick={() => setConfig(true)}
          disabled={!loaded || !!busy}
        >
          <Settings2 size={17} />
          配置
        </button>
      </div>
      <RunMetrics job={job} count={validCount ? number : 0} now={now} />
      <div className="wb-control">
        <div className="wb-count">
          <label htmlFor="wb-count">账号数量</label>
          <div>
            <button
              aria-label="减少账号数量"
              disabled={!!runningId || !!busy || number <= 1 || !validCount}
              onClick={() => setCount(String(number - 1))}
            >
              −
            </button>
            <input
              id="wb-count"
              type="number"
              min={1}
              max={100}
              step={1}
              value={count}
              disabled={!!runningId || !!busy}
              onChange={(e) => setCount(e.target.value)}
            />
            <button
              aria-label="增加账号数量"
              disabled={!!runningId || !!busy || number >= 100 || !validCount}
              onClick={() => setCount(String(number + 1))}
            >
              +
            </button>
          </div>
        </div>
        <div className="wb-ready">
          <strong>{candidates.length}</strong> 个可选
          {reserved > 0 && <span>{reserved} 个任务占用</span>}
        </div>
        <div className="wb-controls-right">
          <button
            className="button primary"
            disabled={
              !loaded ||
              !!busy ||
              !!runningId ||
              !target ||
              !validCount ||
              number > candidates.length
            }
            onClick={prepare}
          >
            {busy === "preview" ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Play size={16} />
            )}
            开始
          </button>
          <button
            className="button danger"
            disabled={!job?.running || !!busy}
            onClick={() => {
              setConfirmError("");
              setConfirm("stop");
            }}
          >
            <Square size={15} />
            停止
          </button>
        </div>
        {loaded && target && !runningId && candidates.length === 0 && (
          <p className="wb-help">
            暂无可用账号，请先在账号管理中检测并补充 TOTP。
          </p>
        )}
        {!validCount && <p className="wb-error">请输入 1–100 之间的整数。</p>}
        {validCount && number > candidates.length && candidates.length > 0 && (
          <p className="wb-help">可选账号不足，请减少数量或先检查更多账号。</p>
        )}
      </div>
      {(error || syncError) && (
        <div className="wb-error wb-error-banner" role="alert">
          <span>{error || syncError}</span>
          <button
            className="button small"
            disabled={!!busy}
            onClick={() => void act("load", refresh)}
          >
            <RefreshCw size={14} />
            刷新状态
          </button>
        </div>
      )}
      {job?.running && (
        <div className="wb-notice" role="status" aria-live="polite">
          <Activity size={20} aria-hidden="true" />
          <div>
            <strong>正在处理</strong>
            <p>{job.items.find((item) => ["linking", "browser", "polling"].includes(item.status))?.message || "正在准备下一个账号"}</p>
          </div>
        </div>
      )}
      {job && !job.running && job.message && (
        <div className="wb-notice" role="status">
          {job.status === "completed" ? (
            <CheckCircle2 size={20} aria-hidden="true" />
          ) : (
            <CircleAlert size={20} aria-hidden="true" />
          )}
          <div>
            <strong>{jobLabels[job.status]}</strong>
            <p>{job.message}</p>
          </div>
        </div>
      )}
      {runningId && job?.id !== runningId && (
        <div className="wb-notice">
          另一个任务正在执行。
          <button className="link-button" onClick={() => selectJob(runningId)}>
            查看运行任务
          </button>
        </div>
      )}
      <div className="wb-log-panel">
        <div className="wb-log-toolbar">
          <span className={`wb-live ${job?.running ? "is-active" : ""}`}>
            <Activity size={14} />
            {job ? jobLabels[job.status] : "准备就绪"}
          </span>
          <div className="wb-log-tools">
            <label>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              自动滚动
            </label>
            <button
              className="button small"
              disabled={!logs.length}
              onClick={clearLogs}
            >
              <Trash2 size={14} />
              清空显示
            </button>
          </div>
        </div>
        <div
          className="wb-console"
          ref={logBox}
          tabIndex={0}
          aria-label="执行日志"
          aria-live="off"
        >
          {logs.length ? (
            logs.map((log) => (
              <div className={`wb-log-line ${log.level}`} key={log.id}>
                <time>
                  {new Date(log.createdAt).toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })}
                </time>
                <span className="wb-log-level">
                  {log.level === "error"
                    ? "错误"
                    : log.level === "success"
                      ? "成功"
                      : log.level === "warn"
                        ? "提示"
                        : "信息"}
                </span>
                <span>
                  {log.position ? `#${log.position} ` : ""}
                  {log.message}
                </span>
              </div>
            ))
          ) : (
            <div className="wb-log-empty">
              <Activity size={28} />
              <strong>
                {!loaded
                  ? "正在读取工作台…"
                  : clearThrough
                    ? "日志显示已清空"
                    : "等待开始授权"}
              </strong>
            </div>
          )}
        </div>
      </div>
      {config && (
        <WorkBuddyConfig
          targets={targets}
          selectedId={targetId}
          lockedId={job?.running ? job.targetId : running?.targetId}
          onSaved={saved}
          onClose={() => setConfig(false)}
        />
      )}
      {preview && (
        <RunConfirmation
          preview={preview}
          busy={busy === "start"}
          error={confirmError}
          onCancel={() => {
            setPreview(null);
            void refresh().catch((e) => setError(e.message));
          }}
          onConfirm={start}
        />
      )}
      {confirm && job && (
        <Modal
          title="停止当前授权任务？"
          role="alertdialog"
          describedBy="wb-action-description"
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          <div className="modal-body">
            <p id="wb-action-description" className="wb-action-description">
              将停止后续账号并关闭任务浏览器；等待正在发送的请求结束后，自动释放未确认成功的账号。成功账号保留已使用标记，不再自动选中。失败或未知结果保留记录；若远端实际已成功，再次选择可能重复操作。
            </p>
            {confirmError && (
              <p className="wb-error" role="alert">
                {confirmError}
              </p>
            )}
          </div>
          <footer className="modal-footer wb-actions">
            <button
              autoFocus
              className="button"
              disabled={!!busy}
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={!!busy}
              onClick={confirmAction}
            >
              {busy ? "正在停止并释放…" : "确认停止"}
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}

