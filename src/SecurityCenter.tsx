import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Check,
  Globe,
  KeyRound,
  LogIn,
  Monitor,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Trash2,
  Unlock,
} from "lucide-react";
import { api } from "./api";
import { date } from "./types";
import { AuthContext } from "./auth-context";
import { TotpSetup } from "./TotpSetup";
import { PasswordEditor } from "./AdminSession";
import { Pager, usePage } from "./Pager";
import { FilterBar } from "./FilterBar";
import { matchesQuery, withinRange, type TimeRange } from "./filters";
import {
  alertKinds,
  credentialKinds,
  eventLabel,
  goodKinds,
  ipLabel,
  loginKinds,
  methodLabel,
} from "./event-labels";
import { ConfirmDialog } from "./components";

type AdminSessionRow = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  ua: string | null;
  agent: string | null;
  method: string | null;
  current: boolean;
};
type SecurityEvent = {
  kind: string;
  detail: string | null;
  at: string;
  ip: string | null;
  ua: string | null;
  method: string | null;
  target: string | null;
  agent: string | null;
};
type AllowState = {
  enabled: boolean;
  entries: string[];
  source: string;
  updatedAt: string | null;
  alwaysAllowed: string[];
  current: string | null;
};
type CredentialEntry = {
  action: string;
  label: string | null;
  count: number;
  at: string;
  ip: string | null;
  ua: string | null;
  agent: string | null;
};

const tabs = [
  { id: "sessions", label: "登录会话", icon: MonitorSmartphone },
  { id: "logins", label: "登录记录", icon: LogIn },
  { id: "operations", label: "操作日志", icon: Activity },
  { id: "alerts", label: "安全事件", icon: ShieldCheck },
  { id: "access", label: "访问白名单", icon: Globe },
] as const;
type TabId = (typeof tabs)[number]["id"];
type ListTabId = "logins" | "operations" | "alerts";

function groupOf(kind: string): ListTabId {
  if (loginKinds.has(kind)) return "logins";
  if (alertKinds.has(kind)) return "alerts";
  return "operations";
}

function toneOf(kind: string) {
  if (alertKinds.has(kind)) return "alert";
  if (goodKinds.has(kind)) return "ok";
  return "plain";
}

function iconOf(kind: string) {
  if (kind.startsWith("login") || kind === "admin_initialized" || kind === "admin_reset") return LogIn;
  if (kind.startsWith("credential")) return KeyRound;
  if (kind.startsWith("session")) return MonitorSmartphone;
  if (kind.startsWith("totp") || kind === "recovery_code_used" || kind === "reauth_failed") return ShieldAlert;
  if (kind.startsWith("api_") || kind.startsWith("host_") || kind.startsWith("origin_")) return ShieldAlert;
  return Activity;
}

// Alert subtypes, so "someone is probing me" can be split from "I exported a
// batch of passwords" — the two need very different reactions.
function alertGroupOf(kind: string): "verify" | "source" | "api" | "export" {
  if (kind === "credential_export") return "export";
  if (kind.startsWith("api_") || kind === "integration_private_target") return "api";
  if (kind.startsWith("host_") || kind.startsWith("origin_")) return "source";
  return "verify";
}

type ResultFilter = "all" | "ok" | "alert";
type ActionFilter = "all" | "read" | "export" | "other";
type AlertFilter = "all" | "verify" | "source" | "api" | "export";

type TableRow = {
  at: string;
  action: string;
  kind: "read" | "export" | "other";
  tone: "ok" | "alert" | "plain";
  icon: typeof Activity;
  target: string;
  detail: string | null;
  ip: string | null;
  agent: string | null;
};

export function SecurityCenter({ notify }: { notify: (message: string) => void }) {
  const auth = useContext(AuthContext);
  const [sessions, setSessions] = useState<AdminSessionRow[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [credentials, setCredentials] = useState<CredentialEntry[]>([]);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [tab, setTab] = useState<TabId>("sessions");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [totpOpen, setTotpOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [allow, setAllow] = useState<AllowState | null>(null);
  const [allowEnabled, setAllowEnabled] = useState(false);
  const [allowEntries, setAllowEntries] = useState<string[]>([]);
  const [allowDraft, setAllowDraft] = useState("");

  // Each tab keeps its own filters: hunting an IP in the login log should not
  // quietly narrow the alert list you switch to next.
  const [sessionQuery, setSessionQuery] = useState("");
  const [loginQuery, setLoginQuery] = useState("");
  const [loginRange, setLoginRange] = useState<TimeRange>("all");
  const [loginResult, setLoginResult] = useState<ResultFilter>("all");
  const [opQuery, setOpQuery] = useState("");
  const [opRange, setOpRange] = useState<TimeRange>("all");
  const [opAction, setOpAction] = useState<ActionFilter>("all");
  const [alertQuery, setAlertQuery] = useState("");
  const [alertRange, setAlertRange] = useState<TimeRange>("all");
  const [alertGroup, setAlertGroup] = useState<AlertFilter>("all");

  const load = useCallback(async () => {
    try {
      const [sessionList, eventList, credentialList, status, allowState] = await Promise.all([
        api<{ sessions: AdminSessionRow[] }>("/auth/sessions"),
        api<{ events: SecurityEvent[] }>("/auth/events?limit=500"),
        api<{ entries: CredentialEntry[] }>("/auth/credentials?limit=200"),
        api<{ totpEnabled?: boolean }>("/auth/status"),
        api<AllowState>("/security/ip-allow"),
      ]);
      setSessions(sessionList.sessions);
      setEvents(eventList.events);
      setCredentials(credentialList.entries);
      setTotpEnabled(!!status.totpEnabled);
      setAllow(allowState);
      setAllowEnabled(allowState.enabled);
      setAllowEntries(allowState.entries);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const buckets: Record<ListTabId, SecurityEvent[]> = {
      logins: [],
      operations: [],
      alerts: [],
    };
    for (const item of events) buckets[groupOf(item.kind)].push(item);
    return buckets;
  }, [events]);

  const alertsToday = useMemo(() => {
    const since = Date.now() - 86400000;
    return events.filter((item) => alertKinds.has(item.kind) && Date.parse(item.at) >= since).length;
  }, [events]);

  const filteredSessions = useMemo(
    () => sessions.filter((item) => matchesQuery([item.ip, item.agent, item.method], sessionQuery)),
    [sessions, sessionQuery],
  );

  const filteredLogins = useMemo(
    () =>
      grouped.logins.filter((item) => {
        if (!withinRange(item.at, loginRange)) return false;
        if (loginResult !== "all" && toneOf(item.kind) !== loginResult) return false;
        return matchesQuery([item.ip, item.agent, item.detail, eventLabel(item.kind), item.target], loginQuery);
      }),
    [grouped.logins, loginRange, loginResult, loginQuery],
  );

  // One table shape for both sources: credential reads carry an account label,
  // everything else carries an event kind and an optional target.
  const operationRows = useMemo<TableRow[]>(() => {
    const rows: TableRow[] = credentials.map((item) => ({
      at: item.at,
      action: item.action === "export" ? "导出明文" : "读取凭据",
      kind: item.action === "export" ? ("export" as const) : ("read" as const),
      tone: item.action === "export" ? ("alert" as const) : ("plain" as const),
      icon: KeyRound,
      target:
        item.action === "export" ? `${item.count} 个账号` : item.label || "未知账号",
      detail: null,
      ip: item.ip,
      agent: item.agent,
    }));
    for (const item of grouped.operations) {
      if (credentialKinds.has(item.kind)) continue;
      rows.push({
        at: item.at,
        action: eventLabel(item.kind),
        kind: "other",
        tone: toneOf(item.kind) === "ok" ? "ok" : "plain",
        icon: iconOf(item.kind),
        target: item.target || item.detail || "—",
        detail: item.target ? item.detail : null,
        ip: item.ip,
        agent: item.agent,
      });
    }
    return rows.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  }, [credentials, grouped.operations]);

  const filteredOperations = useMemo(
    () =>
      operationRows.filter((row) => {
        if (!withinRange(row.at, opRange)) return false;
        if (opAction !== "all" && row.kind !== opAction) return false;
        return matchesQuery([row.action, row.target, row.detail, row.ip, row.agent], opQuery);
      }),
    [operationRows, opRange, opAction, opQuery],
  );

  const filteredAlerts = useMemo(
    () =>
      grouped.alerts.filter((item) => {
        if (!withinRange(item.at, alertRange)) return false;
        if (alertGroup !== "all" && alertGroupOf(item.kind) !== alertGroup) return false;
        return matchesQuery([item.ip, item.agent, item.detail, eventLabel(item.kind), item.target], alertQuery);
      }),
    [grouped.alerts, alertRange, alertGroup, alertQuery],
  );

  // Each list keeps its own page so switching tabs returns you where you were;
  // changing a filter drops you back to page 1 instead of a blank page 4.
  const sessionKey = sessionQuery;
  const loginKey = `${loginQuery}|${loginRange}|${loginResult}`;
  const operationKey = `${opQuery}|${opRange}|${opAction}`;
  const alertKey = `${alertQuery}|${alertRange}|${alertGroup}`;

  const sessionPage = usePage(filteredSessions, 20, sessionKey);
  const loginPage = usePage(filteredLogins, 20, loginKey);
  const operationPage = usePage(filteredOperations, 20, operationKey);
  const alertPage = usePage(filteredAlerts, 20, alertKey);

  function tabCount(id: TabId): number {
    if (id === "sessions") return sessions.length;
    if (id === "access") return allowEntries.length;
    if (id === "operations") return operationRows.length;
    return grouped[id].length;
  }

  async function saveAllow(next: { enabled: boolean; entries: string[] }) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const saved = await api<AllowState>("/security/ip-allow", "PUT", next);
      setAllow(saved);
      setAllowEnabled(saved.enabled);
      setAllowEntries(saved.entries);
      setNotice(
        saved.enabled
          ? `白名单已启用，共 ${saved.entries.length} 条`
          : "白名单已关闭，任何能连到端口的人都能打开登录页",
      );
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function addEntry() {
    const value = allowDraft.trim();
    if (!value) return;
    if (allowEntries.includes(value)) {
      setAllowDraft("");
      return;
    }
    setAllowEntries([...allowEntries, value]);
    setAllowDraft("");
  }

  async function revokeOthers() {
    setBusy(true);
    setNotice("");
    try {
      const result = await api<{ removed: number }>("/auth/sessions", "DELETE");
      setNotice(result.removed ? `已下线 ${result.removed} 个其他会话` : "没有其他会话");
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
      setRevoking(false);
    }
  }

  async function revokeOne(id: string) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await api(`/auth/sessions/${id}`, "DELETE");
      setNotice("该会话已下线，对应设备需要重新登录");
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
      setRevokingId(null);
    }
  }

  async function unlock() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await api<{ removed: number }>("/auth/unlock", "POST");
      setNotice(result.removed ? `已解除 ${result.removed} 个来源的登录锁定` : "当前没有锁定的来源");
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="security-page">
      <div className="security-summary">
        <section className="security-stat">
          <span className="security-stat-label">
            <MonitorSmartphone size={14} />
            登录会话
          </span>
          <strong className="security-stat-value">{loading ? "—" : sessions.length}</strong>
          <span className="security-stat-note">12 小时到期，闲置 2 小时自动失效</span>
        </section>
        <section className={`security-stat${totpEnabled ? "" : " is-warn"}`}>
          <span className="security-stat-label">
            {totpEnabled ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
            两步验证
          </span>
          <strong className={`security-stat-value${totpEnabled ? " is-ok" : " is-warn"}`}>
            {totpEnabled ? "已启用" : "未启用"}
          </strong>
          <span className="security-stat-note">
            {totpEnabled ? "登录与查看明文都需要动态码" : "开启后，仅凭密码无法登录后台"}
          </span>
          <button type="button" className="security-action" onClick={() => setTotpOpen(true)}>
            {totpEnabled ? "关闭" : "立即启用"}
          </button>
        </section>
        <section className={`security-stat${alertsToday ? " is-warn" : ""}`}>
          <span className="security-stat-label">
            <Activity size={14} />
            24 小时内异常
          </span>
          <strong className={`security-stat-value${alertsToday ? " is-warn" : " is-ok"}`}>
            {loading ? "—" : alertsToday}
          </strong>
          <span className="security-stat-note">被拒域名、密钥错误、验证码失败等</span>
        </section>
      </div>

      <div className="security-toolbar">
        <div className="security-tabs" role="tablist" aria-label="安全中心分类">
          {tabs.map((item) => {
            const Icon = item.icon;
            const count = tabCount(item.id);
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`security-tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls="security-tabpanel"
                className={`security-tab${tab === item.id ? " is-active" : ""}${
                  item.id === "alerts" && alertsToday ? " has-alert" : ""
                }`}
                onClick={() => setTab(item.id)}
              >
                <Icon size={14} />
                {item.label}
                <span className="security-tab-count">{loading ? "—" : count}</span>
              </button>
            );
          })}
        </div>
        <div className="security-toolbar-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="刷新"
            title="刷新"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={16} />
          </button>
          <button type="button" className="button" onClick={() => setPasswordOpen(true)}>
            修改登录密码
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="inline-error security-error">
          {error}
          <button type="button" className="text-button" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}
      {notice && <p className="security-notice">{notice}</p>}

      <div id="security-tabpanel" role="tabpanel" aria-labelledby={`security-tab-${tab}`}>
        {/* Sessions read as devices, not log lines: one card per signed-in window. */}
        {tab === "sessions" && (
          <>
            <section className="security-card">
              <header className="security-card-head">
                <div>
                  <MonitorSmartphone size={16} />
                  <h2>登录会话</h2>
                  <span className="security-count">{sessions.length}</span>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={busy || sessions.length < 2}
                  onClick={() => setRevoking(true)}
                >
                  下线其他会话
                </button>
              </header>

              <FilterBar
                query={sessionQuery}
                onQuery={setSessionQuery}
                placeholder="搜索 IP 或设备…"
                shown={filteredSessions.length}
                total={sessions.length}
              />

              {filteredSessions.length ? (
                <ul className="device-grid">
                  {sessionPage.rows.map((item) => (
                    <li key={item.id} className={`device-card${item.current ? " is-current" : ""}`}>
                      <header className="device-head">
                        <span className="device-icon" aria-hidden="true">
                          {item.agent && /iOS|Android/i.test(item.agent) ? <Smartphone size={17} /> : <Monitor size={17} />}
                        </span>
                        <div className="device-title">
                          <strong>{item.current ? "当前窗口" : "其他设备"}</strong>
                          <span>{item.agent || "未知设备"}</span>
                        </div>
                        {item.current && (
                          <span className="log-badge">
                            <Check size={11} />
                            本窗口
                          </span>
                        )}
                      </header>

                      <dl className="device-facts">
                        <div>
                          <dt>来源</dt>
                          <dd>{ipLabel(item.ip)}</dd>
                        </div>
                        <div>
                          <dt>通过方式</dt>
                          <dd>{methodLabel(item.method) || "未记录"}</dd>
                        </div>
                        <div>
                          <dt>创建</dt>
                          <dd>{date(item.createdAt)}</dd>
                        </div>
                        <div>
                          <dt>最后活动</dt>
                          <dd>{date(item.lastSeenAt)}</dd>
                        </div>
                      </dl>

                      <footer className="device-foot">
                        <span>到期 {date(item.expiresAt)}</span>
                        {!item.current && (
                          <button
                            type="button"
                            className="security-action"
                            disabled={busy}
                            onClick={() => setRevokingId(item.id)}
                          >
                            下线
                          </button>
                        )}
                      </footer>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="security-empty">
                  {loading ? "正在读取…" : sessionQuery ? "没有匹配的会话" : "暂无会话"}
                </p>
              )}

              <Pager state={sessionPage} unit="个" label="登录会话" />
              <p className="security-hint">
                会话按最后活动保留最近 8 个，其余自动回收。发现陌生设备或 IP 时，先下线那一条，再改密码。
              </p>
            </section>

            <section className="security-card">
              <header className="security-card-head">
                <div>
                  <Unlock size={16} />
                  <h2>登录锁定</h2>
                </div>
                <button type="button" className="button" disabled={busy} onClick={() => void unlock()}>
                  {busy ? "处理中…" : "解除锁定"}
                </button>
              </header>
              <p className="security-hint">
                密码错误次数按来源分别累计，本机来源连续失败后会进入冷却，等待期内即使密码正确也无法登录。
                这里可以从已登录的会话直接清零，不必等到冷却结束。锁定事件会记在「安全事件」里。
              </p>
            </section>
          </>
        )}

        {/* Logins read as a timeline: the shape of "what happened, in order". */}
        {tab === "logins" && (
          <section className="security-card">
            <header className="security-card-head">
              <div>
                <LogIn size={16} />
                <h2>登录记录</h2>
                <span className="security-count">{grouped.logins.length}</span>
              </div>
            </header>

            <FilterBar
              query={loginQuery}
              onQuery={setLoginQuery}
              range={loginRange}
              onRange={setLoginRange}
              placeholder="搜索 IP、设备或详情…"
              shown={filteredLogins.length}
              total={grouped.logins.length}
              onReset={() => setLoginResult("all")}
            >
              <label className="filter-select">
                <select
                  value={loginResult}
                  aria-label="登录结果"
                  onChange={(event) => setLoginResult(event.target.value as ResultFilter)}
                >
                  <option value="all">全部结果</option>
                  <option value="ok">仅成功</option>
                  <option value="alert">仅失败</option>
                </select>
              </label>
            </FilterBar>

            {filteredLogins.length ? (
              <ol className="timeline">
                {loginPage.rows.map((item, index) => {
                  const tone = toneOf(item.kind);
                  const Icon = iconOf(item.kind);
                  return (
                    <li key={`${item.at}-${index}`} className={`timeline-item is-${tone}`}>
                      <span className="timeline-dot" aria-hidden="true">
                        <Icon size={12} />
                      </span>
                      <div className="timeline-body">
                        <div className="timeline-head">
                          <span className="timeline-title">{eventLabel(item.kind)}</span>
                          {item.method && <span className="log-chip">{methodLabel(item.method)}</span>}
                          <time className="log-time">{date(item.at)}</time>
                        </div>
                        <div className="log-line log-meta">
                          {item.ip ? (
                            <span className="log-fact">
                              <Globe size={12} />
                              {ipLabel(item.ip)}
                            </span>
                          ) : null}
                          {item.agent ? (
                            <span className="log-fact">
                              <Monitor size={12} />
                              {item.agent}
                            </span>
                          ) : null}
                          {!item.ip && !item.agent && <span className="log-fact is-quiet">来源未记录</span>}
                          {item.detail && <span className="log-fact log-detail">{item.detail}</span>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="security-empty">
                {loading ? "正在读取…" : "没有符合筛选条件的登录记录"}
              </p>
            )}

            <Pager state={loginPage} label="登录记录" />
            <p className="security-hint">
              每条都记录来源 IP、设备与通过方式。时间均为北京时间，按由近到远排列。
              自动清理旧会话属于日常维护，记在「操作日志」里。
            </p>
          </section>
        )}

        {/* Operations read as a table: aligned columns are faster to scan than
            stacked rows when you are looking for one account among many. */}
        {tab === "operations" && (
          <section className="security-card">
            <header className="security-card-head">
              <div>
                <Activity size={16} />
                <h2>操作日志</h2>
                <span className="security-count">{operationRows.length}</span>
              </div>
            </header>

            <FilterBar
              query={opQuery}
              onQuery={setOpQuery}
              range={opRange}
              onRange={setOpRange}
              placeholder="搜索账号、IP 或详情…"
              shown={filteredOperations.length}
              total={operationRows.length}
              onReset={() => setOpAction("all")}
            >
              <label className="filter-select">
                <select
                  value={opAction}
                  aria-label="操作类型"
                  onChange={(event) => setOpAction(event.target.value as ActionFilter)}
                >
                  <option value="all">全部操作</option>
                  <option value="read">读取凭据</option>
                  <option value="export">导出明文</option>
                  <option value="other">其它操作</option>
                </select>
              </label>
            </FilterBar>

            {filteredOperations.length ? (
              <div className="log-table-wrap">
                <table className="log-table">
                  <thead>
                    <tr>
                      <th scope="col">时间</th>
                      <th scope="col">动作</th>
                      <th scope="col">对象</th>
                      <th scope="col">来源</th>
                      <th scope="col">设备</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operationPage.rows.map((row, index) => {
                      const Icon = row.icon;
                      return (
                        <tr key={`${row.at}-${index}`} className={`is-${row.tone}`}>
                          <td className="log-table-time">{date(row.at)}</td>
                          <td>
                            <span className="table-action">
                              <Icon size={13} />
                              {row.action}
                            </span>
                          </td>
                          <td className="log-table-strong">
                            {row.target}
                            {row.detail && <em className="log-table-note">{row.detail}</em>}
                          </td>
                          <td className="log-table-mono">{ipLabel(row.ip)}</td>
                          <td className="log-table-device">{row.agent || "未记录"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="security-empty">
                {loading ? "正在读取…" : "没有符合筛选条件的操作记录"}
              </p>
            )}

            <Pager state={operationPage} label="操作日志" />
            <p className="security-hint">
              每次查看密码、TOTP 或导出都会留痕，只记动作、账号、来源与时间，不记凭据内容。
              导出明文的行会标成琥珀色，方便事后核查。
            </p>
          </section>
        )}

        {/* Alerts read as warnings: a colour bar carries the severity, the
            detail line carries the evidence. */}
        {tab === "alerts" && (
          <section className="security-card">
            <header className="security-card-head">
              <div>
                <ShieldCheck size={16} />
                <h2>安全事件</h2>
                <span className="security-count">{grouped.alerts.length}</span>
              </div>
            </header>

            <FilterBar
              query={alertQuery}
              onQuery={setAlertQuery}
              range={alertRange}
              onRange={setAlertRange}
              placeholder="搜索 IP、设备或详情…"
              shown={filteredAlerts.length}
              total={grouped.alerts.length}
              onReset={() => setAlertGroup("all")}
            >
              <label className="filter-select">
                <select
                  value={alertGroup}
                  aria-label="事件类别"
                  onChange={(event) => setAlertGroup(event.target.value as AlertFilter)}
                >
                  <option value="all">全部类别</option>
                  <option value="verify">验证失败</option>
                  <option value="source">来源与域名拦截</option>
                  <option value="api">API 鉴权</option>
                  <option value="export">明文导出</option>
                </select>
              </label>
            </FilterBar>

            {filteredAlerts.length ? (
              <ul className="alert-list">
                {alertPage.rows.map((item, index) => (
                  <li key={`${item.at}-${index}`} className="alert-card">
                    <span className="alert-bar" aria-hidden="true" />
                    <div className="alert-main">
                      <div className="alert-head">
                        <span className="alert-title">{eventLabel(item.kind)}</span>
                        <span className="alert-tag">{alertGroupLabel(item.kind)}</span>
                        {item.method && <span className="log-chip">{methodLabel(item.method)}</span>}
                        <time className="log-time">{date(item.at)}</time>
                      </div>
                      <div className="log-line log-meta">
                        {item.ip ? (
                          <span className="log-fact">
                            <Globe size={12} />
                            {ipLabel(item.ip)}
                          </span>
                        ) : null}
                        {item.agent ? (
                          <span className="log-fact">
                            <Monitor size={12} />
                            {item.agent}
                          </span>
                        ) : null}
                        {!item.ip && !item.agent && <span className="log-fact is-quiet">来源未记录</span>}
                        {item.detail && <span className="log-fact log-detail">{item.detail}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="security-empty">
                {loading ? "正在读取…" : "没有符合筛选条件的安全事件"}
              </p>
            )}

            <Pager state={alertPage} label="安全事件" />
            <p className="security-hint">
              这些记录表示有人在尝试访问服务：伪造域名、跨站来源、错误的 API 密钥、超频写入或验证码错误。
              条目多说明正在被探测，但不代表已经进入；高频来源 5 秒内只记一条。
            </p>
          </section>
        )}
        {/* The allowlist reads as a rule, not a log: one switch, the addresses
            that survive it, and a reminder that loopback is exempt. */}
        {tab === "access" && (
          <section className="security-card">
            <header className="security-card-head">
              <div>
                <Globe size={16} />
                <h2>访问白名单</h2>
                <span className="security-count">{allowEntries.length}</span>
              </div>
              <div className="security-head-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !allow}
                  onClick={() => void saveAllow({ enabled: allowEnabled, entries: allowEntries })}
                >
                  {busy ? "保存中…" : "保存"}
                </button>
              </div>
            </header>

            <label className="allow-switch">
              <input
                type="checkbox"
                checked={allowEnabled}
                disabled={busy}
                onChange={(event) => setAllowEnabled(event.target.checked)}
              />
              <span>
                <strong>{allowEnabled ? "已启用：只允许白名单内的地址" : "未启用：任何能连到端口的人都能打开登录页"}</strong>
                <em>
                  在应用这一层拦截，不依赖反向代理。被拒的来源返回 403，并记一条「来源地址不在白名单」的安全事件。
                </em>
              </span>
            </label>

            <div className="allow-block">
              <h3>始终放行</h3>
              <p className="allow-note">
                本机回环永不拦截：解锁命令、设置码文件和本地浏览器都从这里进来，把这条路关掉就等于把门焊死。
              </p>
              <div className="allow-chips">
                {(allow?.alwaysAllowed || []).map((item) => (
                  <span key={item} className="allow-chip">
                    {item}
                  </span>
                ))}
                {allow?.current && <span className="allow-chip is-current">当前：{allow.current}</span>}
              </div>
            </div>

            <div className="allow-block">
              <h3>允许的地址</h3>
              {allowEntries.length ? (
                <ul className="allow-list">
                  {allowEntries.map((item) => (
                    <li key={item}>
                      <code>{item}</code>
                      <button
                        type="button"
                        className="security-action is-danger"
                        aria-label={`移除 ${item}`}
                        title="移除"
                        onClick={() => setAllowEntries(allowEntries.filter((value) => value !== item))}
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="security-empty">还没有条目。启用前至少需要一条。</p>
              )}

              <div className="allow-add">
                <input
                  value={allowDraft}
                  placeholder="203.0.113.7 或 10.0.0.0/8 或 2001:db8::/32"
                  aria-label="要加入白名单的地址"
                  onChange={(event) => setAllowDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addEntry();
                    }
                  }}
                />
                <button type="button" className="button" disabled={!allowDraft.trim()} onClick={addEntry}>
                  <Plus size={14} />
                  添加
                </button>
              </div>
              <p className="allow-note">
                支持单个地址或 CIDR。最后一次保存后改动才会生效，保存本身也会记一条安全事件。
                {allow?.source === "env" && " 当前列表来自环境变量 ACCOUNT_DESK_ADMIN_ALLOW，保存后以页面为准。"}
              </p>
            </div>

            <p className="security-hint">
              白名单是最后一道门，不是唯一一道：登录仍需密码与动态码，接口仍校验域名与来源。
              如果放在 nginx 后面，记得同时把 <code>ACCOUNT_DESK_TRUST_PROXY=1</code> 打开，否则这里看到的永远是 127.0.0.1。
            </p>
          </section>
        )}
      </div>

      {totpOpen && (
        <TotpSetup
          enabled={totpEnabled}
          onClose={() => setTotpOpen(false)}
          onChanged={() => {
            notify(totpEnabled ? "两步验证已关闭" : "两步验证已启用");
            void load();
          }}
        />
      )}
      {passwordOpen && auth && (
        <PasswordEditor
          onClose={() => setPasswordOpen(false)}
          onSaved={(value) => {
            auth.install(value);
            setPasswordOpen(false);
            notify("登录密码已更新");
            void load();
          }}
        />
      )}
      {revoking && (
        <ConfirmDialog
          title="下线所有其他会话？"
          description="除当前窗口外的登录都会立即失效，其他设备需要重新输入密码。本窗口保持登录。"
          confirmLabel={busy ? "处理中…" : "确认下线"}
          onCancel={() => {
            if (!busy) setRevoking(false);
          }}
          onConfirm={() => void revokeOthers()}
        />
      )}
      {revokingId && (
        <ConfirmDialog
          title="下线这个会话？"
          description="该设备上的登录会立即失效，需要重新输入密码。当前窗口不受影响。"
          confirmLabel={busy ? "处理中…" : "确认下线"}
          onCancel={() => {
            if (!busy) setRevokingId(null);
          }}
          onConfirm={() => void revokeOne(revokingId)}
        />
      )}
    </div>
  );
}

function alertGroupLabel(kind: string) {
  const group = alertGroupOf(kind);
  if (group === "source") return "来源拦截";
  if (group === "api") return "API 鉴权";
  if (group === "export") return "明文导出";
  return "验证失败";
}
