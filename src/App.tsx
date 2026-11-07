import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Github,
  LayoutGrid,
  Trash2,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  SlidersHorizontal,
  ShieldCheck,
  CircleAlert,
  LockKeyhole,
  X,
  RotateCcw,
  Check,
  Activity,
  FolderCheck,
  Info,
  Upload,
  Download,
  PlugZap,
  Clock3,
  Folder,
  Tags,
  KeyRound,
  Bell,
} from "lucide-react";
import { api } from "./api";
import {
  statusLabels,
  type PatStatus,
  type Account,
  type Job,
  emptyOrganization,
  type OrganizationData,
} from "./types";
import { Modal } from "./components";
import { ImportDialog } from "./ImportDialog";
import { AccountDetail } from "./AccountDetail";
import { CreateAccount } from "./CreateAccount";
import { CheckProgress } from "./CheckProgress";
import { CheckSettings } from "./CheckSettings";
import { WorkBuddy } from "./WorkBuddy";
import { PatConfig } from "./PatConfig";
import { PatPage } from "./PatPage";
import { AccountCategories, matchesCategory, matchesTaskFilter, taskFilterOptions, taskOwner, type Category } from "./AccountCategories";
import { AccountTable } from "./AccountTable";
import { ColumnSettings, useAccountColumns } from "./AccountColumns";
import { sortAccounts, type AccountSort, type ColumnView } from "./account-columns-model";
import { OrganizationManager, OrganizeDialog } from "./Organization";
import { ApiAccess } from './ApiAccess';
import {AdminSession} from './AdminSession';
import {SecurityCenter} from './SecurityCenter';
import {NotifyPage} from './NotifyPage';
import {AuthContext} from './auth-context';
import {ExportAccounts, type ExportScope} from './ExportAccounts';

type View =
  | "accounts"
  | "trash"
  | "integrations"
  | "pat"
  | "groups"
  | "tags"
  | "api"
  | "security"
  | "notify";
type Tab = Category;
const initialJob: Job = {
  running: false,
  total: 0,
  done: 0,
  current: "",
  message: "",
  cancelled: false,
  currentId: "",
  scope: "selected",
  counts: { reachable: 0, missing: 0, limited: 0, error: 0, skipped: 0 },
};

export default function App() {
  const auth = useContext(AuthContext);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [organization, setOrganization] = useState<OrganizationData>(emptyOrganization);
  const [groupFilter, setGroupFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [totpFilter, setTotpFilter] = useState('all');
  const [pageSize, setPageSize] = useState(25);
  const [organizing, setOrganizing] = useState<{ids:string[];initial?:Account} | null>(null);
  const [job, setJob] = useState<Job>(initialJob);
  const [dismissedCheckResult, setDismissedCheckResult] = useState<string | null>(null);
  const checkResultKey = JSON.stringify(job);
  const [pat, setPat] = useState<PatStatus>({settings:{enabled:false,targetCount:1},records:[],running:false,activeId:null,message:""});
  const [patConfig, setPatConfig] = useState(false);
  const [checkSettingsOpen, setCheckSettingsOpen] = useState(false);
  const [taskFilter, setTaskFilter] = useState("all");
  const loadingRequest = useRef<Promise<void> | null>(null);
  const readGeneration = useRef(0);
  const mounted = useRef(true);
  const [view, setView] = useState<View>("accounts");
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<AccountSort>("newest");
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [requestedJob, setRequestedJob] = useState<{id:string} | null>(null);
  const columnView: ColumnView = view==='trash'?'trash':tab==='workbuddy'?'workbuddy':tab==='pat'?'pat':tab==='pending'?'occupied':'accounts';
  const columnSettings = useAccountColumns(columnView);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<ExportScope | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletion, setDeletion] = useState<{
    ids: string[];
    restore: boolean;
    permanent?: boolean;
  } | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<"view" | "edit">("view");
  const [selection, setSelection] = useState<Account | "auto" | null>(null);
  const [purpose, setPurpose] = useState("");
  const [selectError, setSelectError] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState(Date.now());
  const notify = useCallback((message: string) => setToast(message), []);
  const load = useCallback(async function readAccounts(refreshAfterPending = false): Promise<void> {
    if (loadingRequest.current) {
      if (!refreshAfterPending) return loadingRequest.current;
      await loadingRequest.current.catch(() => {});
      if (!mounted.current) return;
      return readAccounts();
    }
    const generation = readGeneration.current;
    const request = (async () => {
    const [rows, state, patState, org] = await Promise.all([
      api<Account[]>("/accounts"),
      api<Job>("/checks"),
      api<PatStatus>("/pat"),
      api<OrganizationData>('/organization'),
    ]);
    if (!mounted.current || generation !== readGeneration.current) return;
    setAccounts(rows);
    setOrganization(org);
    setJob(state);
    setPat(patState);
    setError("");
    setChecked(
      (prev) =>
        new Set([...prev].filter((id) => rows.some((r) => r.id === id))),
    );
    })();
    const trackedRequest = request.finally(() => {
      if (loadingRequest.current === trackedRequest) loadingRequest.current = null;
    });
    loadingRequest.current = trackedRequest;
    return trackedRequest;
  }, []);
  function installMutation(next: { job?: Job; pat?: PatStatus }) {
    readGeneration.current++;
    if (next.job) { setDismissedCheckResult(null); setJob(next.job); }
    if (next.pat) setPat(next.pat);
    void load(true).catch(() => setError("操作已提交，暂时无法刷新账号状态，请重试连接。"));
  }
  useEffect(() => {mounted.current=true;return ()=>{mounted.current=false;};},[]);
  useEffect(() => {
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    if (view === "accounts" || view === "trash" || view === "pat") {
      load().catch((e) => setError(e.message));
    }
  }, [view, load]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if(job.running) { setDismissedCheckResult(null); return; }
    if(dismissedCheckResult===checkResultKey || !job.message || job.canResume || job.cancelled || job.done<job.total || (job.phase && job.phase!=='idle'))return;
    const timer=setTimeout(()=>setDismissedCheckResult(checkResultKey),5000);
    return ()=>clearTimeout(timer);
  }, [checkResultKey, dismissedCheckResult]);
  const workbuddyRunning = accounts.some(a=>a.taskSummary?.owner==='workbuddy' && ['queued','running'].includes(a.taskSummary.state));
  useEffect(() => {
    const pollDelay = job.running || pat.running || workbuddyRunning || view==="pat" ? 1400 : 15000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!stopped) await load();
      } catch {
        if (!stopped) setError("暂时无法连接本地服务，正在重试…");
      } finally {
        if (!stopped) timer = setTimeout(poll, pollDelay);
      }
    };
    timer = setTimeout(poll, pollDelay);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job.running, pat.running, workbuddyRunning, view, load]);
  const active = useMemo(
    () => accounts.filter((a) => !a.deletedAt),
    [accounts],
  );
  const trashed = accounts.filter((a) => a.deletedAt);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = (
      view === "trash" ? accounts.filter((a) => a.deletedAt) : active
    ).filter(
      (a) =>
        !q ||
        [a.username, a.email, a.notes, a.purpose, organization.groups.find(g=>g.id===a.groupId)?.name || '', ...organization.tags.filter(t=>a.tagIds?.includes(t.id)).map(t=>t.name)].some((v) =>
          v.toLowerCase().includes(q),
        ),
    );
    if (view !== "trash") {
      rows = rows.filter(a=>matchesCategory(a,tab));
      rows = rows.filter(a=>matchesTaskFilter(a,tab,taskFilter));
      if (totpFilter === "totp") rows = rows.filter((a) => a.hasTotp);
      else if (totpFilter === "no-totp") rows = rows.filter((a) => !a.hasTotp);
      if (filter === 'unknown') rows = rows.filter(a=>['limited','error'].includes(a.publicStatus));
      else if (filter !== "all")
        rows = rows.filter((a) => a.publicStatus === filter);
    }
    if (groupFilter !== 'all') rows = rows.filter(a=>groupFilter==='none' ? !a.groupId : a.groupId===groupFilter);
    if (tagFilter !== 'all') rows = rows.filter(a=>tagFilter==='none' ? !a.tagIds?.length : a.tagIds?.includes(tagFilter));
    return sortAccounts(rows,sort);
  }, [accounts, active, organization, query, tab, taskFilter, filter, groupFilter, tagFilter, totpFilter, view, sort, clock]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const displayed = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const detail = accounts.find((a) => a.id === detailId && !a.deletedAt);

  useEffect(() => setPage(1), [query, tab, taskFilter, filter, groupFilter, tagFilter, totpFilter, pageSize, view, sort]);
  useEffect(() => setChecked(new Set()), [query, tab, taskFilter, filter, groupFilter, tagFilter, totpFilter, view]);
  useEffect(() => {
    const visible = new Set(filtered.map(a=>a.id));
    setChecked(previous => {
      const next = new Set([...previous].filter(id=>visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [filtered]);

  function resetFilters() { setQuery(''); setFilter('all'); setTab('all'); setGroupFilter('all'); setTagFilter('all'); setTotpFilter('all'); setTaskFilter('all'); }

  function chooseCategory(next:Category) { setTab(next); setFilter('all'); setTaskFilter('all'); setChecked(new Set()); }
  function openTask(account:Account) {
    if(taskOwner(account)==='pat')navigate('pat');
    else { setRequestedJob(account.taskSummary?.workbuddyJobId ? {id:account.taskSummary.workbuddyJobId} : null); navigate('integrations'); }
  }
  function navigate(next: View) {
    setView(next);
    setQuery("");
    setGroupFilter('all');
    setTagFilter('all');
    setChecked(new Set());
  }
  function openAccount(id: string, mode: "view" | "edit" = "view") {
    setDialogMode(mode);
    setDetailId(id);
  }
  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function startCheck(target: string[] | "all", scope?: 'filtered') {
    const result =
      target === "all"
        ? await api<Job>("/checks", "POST", { scope: "all" })
        : target.length === 1 && scope !== 'filtered'
          ? await api<Job>(`/accounts/${target[0]}/check`, "POST")
          : await api<Job>("/checks", "POST", { ids: target, ...(scope ? {scope} : {}) });
    installMutation({ job: result });
    notify(`已开始检查 ${result.total} 个账号`);
  }
  function confirmTrash(ids: string[], restore = false) {
    setDeleteError("");
    setDeletion({ ids, restore });
  }
  function openSelect(account: Account | "auto") {
    setSelection(account);
    setPurpose("");
    setSelectError("");
  }

  function openExport(initial: 'selected' | 'filtered') {
    setExporting({initial,filteredIds:filtered.map(a=>a.id),selectedIds:filtered.filter(a=>checked.has(a.id)).map(a=>a.id)});
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        跳转到主内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Github size={25} />
          </span>
          <div>
            Account Desk<small>GITHUB 账号工作台</small>
          </div>
        </div>
        <div className="workspace-label">
          我的工作空间
          <span className="local-dot" />
        </div>
        <nav aria-label="主导航">
          <button
            className={view === "accounts" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("accounts")}
          >
            <LayoutGrid size={18} />
            账号管理<span className="nav-count">{active.length}</span>
          </button>
          <button className={`nav-item ${view==='groups'?'active':''}`} aria-current={view==='groups'?'page':undefined} onClick={()=>navigate('groups')}><Folder size={18}/>分组管理<span className="nav-count">{organization.groups.length}</span></button>
          <button className={`nav-item ${view==='tags'?'active':''}`} aria-current={view==='tags'?'page':undefined} onClick={()=>navigate('tags')}><Tags size={18}/>标签管理<span className="nav-count">{organization.tags.length}</span></button>
          <button
            className={view === "integrations" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("integrations")}
          >
            <PlugZap size={18} />
            WorkBuddy2api
          </button>
          <button className={view === "pat" ? "nav-item active" : "nav-item"} aria-current={view === "pat" ? "page" : undefined} onClick={() => navigate("pat")}>
            <ShieldCheck size={18} />PAT 管理
          </button>
          <button className={view==='api'?'nav-item active':'nav-item'} aria-current={view==='api'?'page':undefined} onClick={()=>navigate('api')}><KeyRound size={18}/>API 管理</button>
          <button
            className={view === "trash" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("trash")}
          >
            <Trash2 size={18} />
            回收站
            {trashed.length > 0 && (
              <span className="nav-count">{trashed.length}</span>
            )}
          </button>
          <div className="nav-divider" role="presentation" />
          <button
            className={view === "security" ? "nav-item active" : "nav-item"}
            aria-current={view === "security" ? "page" : undefined}
            onClick={() => navigate("security")}
          >
            <ShieldCheck size={18} />
            安全中心
            {auth?.state.totpEnabled === false && (
              <span className="nav-dot" title="两步验证未启用" aria-label="两步验证未启用" />
            )}
          </button>
          <button
            className={view === "notify" ? "nav-item active" : "nav-item"}
            aria-current={view === "notify" ? "page" : undefined}
            onClick={() => navigate("notify")}
          >
            <Bell size={18} />
            通知推送
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="phase-note">
            <span className="phase-icon">
              <FolderCheck size={19} />
            </span>
            <strong>先整理，再使用</strong>
            <p>
              集中管理账号与状态，
              <br />
              让每一次选用都有记录。
            </p>
            <span className="phase-tag">账号管理 · OAuth 授权</span>
          </div>
          <div className="local-footer">
            <LockKeyhole size={14} />
            <span>本地存储</span>
            <span className="version">v1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="breadcrumb">工作空间</span>
            <ChevronRight size={13} />
            <span>
              {
                {
                  accounts: "账号管理",
                  groups: "分组管理",
                  tags: "标签管理",
                  integrations: "WorkBuddy2api",
                  pat: "PAT 管理",
                  api: "API 管理",
                  trash: "回收站",
                  security: "安全中心",
                  notify: "通知推送",
                }[view]
              }
            </span>
          </div>
          <AdminSession/>
        </header>
        <main id="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">GITHUB ACCOUNT WORKSPACE</div>
              <h1>
                {
                  {
                    accounts: "账号管理",
                    groups: "分组管理",
                    tags: "标签管理",
                    integrations: "WorkBuddy2api",
                    pat: "PAT 管理",
                    api: "API 管理",
                    trash: "回收站",
                    security: "安全中心",
                    notify: "通知推送",
                  }[view]
                }
              </h1>
            </div>
            {view === "accounts" && (
              <div className="heading-actions">
                <button className="button" disabled={loading || !filtered.length} onClick={()=>openExport(checked.size?'selected':'filtered')} aria-haspopup="dialog"><Download size={16}/>导出账号</button>
                <button className="button" onClick={() => setImporting(true)}>
                  <Upload size={16} />
                  批量导入
                </button>
                <button
                  className="button primary"
                  onClick={() => setCreating(true)}
                >
                  <Plus size={17} />
                  新增账号
                </button>
              </div>
            )}
            {view === "pat" && <div className="heading-actions"><button className="button" disabled={loading} onClick={()=>setPatConfig(true)}><SlidersHorizontal size={16}/>PAT 配置</button></div>}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={18} />
              <span>{error}</span>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => run(load)}
              >
                重试连接
              </button>
              <button
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <WorkBuddy
            active={view === "integrations"}
            requestedJob={requestedJob}
            notify={notify}
            onAccountsChanged={load}
          />
          {(view==='groups' || view==='tags') && <OrganizationManager key={view} kind={view} data={organization} onChanged={()=>load(true)} onBrowse={id=>{resetFilters();navigate('accounts');if(view==='groups')setGroupFilter(id);else setTagFilter(id);}}/>}
          {view === "pat" && <PatPage status={pat} accounts={accounts} loading={loading} onStatus={(next)=>installMutation({pat:next})} onAccounts={()=>navigate("accounts")}/>}
          {view === 'api' && <ApiAccess notify={notify} organization={organization}/>}
          {view === 'security' && <SecurityCenter notify={notify}/>}
          {view === 'notify' && <NotifyPage notify={notify}/>}
          {view === "accounts" && (
            <>
              <section className="detection-overview" aria-label="检测状态概览">
                <div className="overview-title"><Activity size={16}/><strong>公开检测</strong><span>{active.length} 个账号</span></div>
                <div className="detection-counts">
                  {[['all','全部'],['reachable','公开可访问'],['missing','公开不可访问'],['unknown','无法判断'],['unchecked','未检测']].map(([value,label])=><button key={value} className={`detection-count ${filter===value?'active':''} ${value}`} aria-pressed={filter===value} onClick={()=>{setFilter(value);setTab('all');setTaskFilter('all');}}><span className="status-dot"/>{label}<strong>{loading?'—':active.filter(a=>value==='all'||(value==='unknown'?['limited','error'].includes(a.publicStatus):a.publicStatus===value)).length}</strong></button>)}
                </div>
                <p className="detection-note"><Info size={14}/>公开不可访问可能是更名、删除或受限；请求失败不代表封号。</p>
              </section>
              {(job.running || dismissedCheckResult!==checkResultKey) && <CheckProgress
                job={job}
                busy={busy}
                onDismiss={() => setDismissedCheckResult(checkResultKey)}
                onResume={()=>run(async()=>{installMutation({job:await api<Job>("/checks/resume","POST")});})}
                onCancel={() =>
                  run(async () => {
                    installMutation({ job: await api<Job>("/checks/cancel", "POST") });
                  })
                }
              />}
            </>
          )}
          {(view === "accounts" || view === "trash") && (
            <section className="account-panel">
              {view === "accounts" && (
                <div className="panel-top">
                  <AccountCategories accounts={active} value={tab} onChange={chooseCategory}/>
                </div>
              )}
              <div className="toolbar">
                <label className="search-box">
                  <Search size={17} />
                  <input
                    aria-label="搜索账号"
                    placeholder="搜索账号、来源、标签…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      className="icon-button"
                      aria-label="清除搜索"
                      onClick={() => setQuery("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </label>
                <div className="toolbar-actions">
                  {view==='trash' && <button className="button danger-quiet" disabled={busy || job.running || !trashed.length} onClick={()=>{setDeleteError('');setDeletion({ids:trashed.map(a=>a.id),restore:false,permanent:true});}}><Trash2 size={15}/>清空回收站 ({trashed.length})</button>}
                  <button className="button" onClick={()=>setColumnsOpen(true)} aria-haspopup="dialog"><SlidersHorizontal size={15}/>显示列</button>
                  {view === "accounts" && (
                    <>
                      <button className="button" disabled={loading} onClick={()=>setCheckSettingsOpen(true)} aria-haspopup="dialog"><Clock3 size={15}/>检测设置</button>
                      <label className="select-wrap">
                        <SlidersHorizontal size={15} />
                        <select
                          aria-label="筛选账号状态"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                        >
                          <option value="all">全部检测结果</option><option value="unknown">无法判断（全部原因）</option>
                          {Object.entries(statusLabels).map(
                            ([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ),
                          )}

                        </select>
                      </label>
                      <button className="button" disabled={busy || job.running || !filtered.length} onClick={()=>run(()=>startCheck(filtered.map(account=>account.id),'filtered'))} title="检测所有符合当前搜索与筛选条件的账号，包含其他分页"><RefreshCw size={15}/>检测筛选结果 ({filtered.length})</button>
                      <button
                        className="button"
                        disabled={busy || job.running || !active.length}
                        onClick={() => run(() => startCheck("all"))}
                        title="检查账号库全部账号，不受搜索、筛选和分页影响；不包含回收站"
                      >
                        <RefreshCw
                          size={15}
                          className={job.running ? "spin" : ""}
                        />
                        检查全部 ({active.length})
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="organization-filters">
                {view==='accounts' && taskFilterOptions[tab] && <label><select aria-label="任务状态筛选" value={taskFilter} onChange={e=>setTaskFilter(e.target.value)}>{Object.entries(taskFilterOptions[tab]!).map(([value,label])=><option key={value} value={value}>{label} ({active.filter(a=>matchesCategory(a,tab)&&matchesTaskFilter(a,tab,value)).length})</option>)}</select></label>}
                <label><Folder size={14}/><select aria-label="筛选来源分组" value={groupFilter} onChange={e=>setGroupFilter(e.target.value)}><option value="all">全部分组</option><option value="none">未分组</option>{organization.groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
                <label><Tags size={14}/><select aria-label="筛选用途标签" value={tagFilter} onChange={e=>setTagFilter(e.target.value)}><option value="all">全部标签</option><option value="none">无标签</option>{organization.tags.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
                {view==='accounts' && <label><ShieldCheck size={14}/><select aria-label="筛选两步验证" value={totpFilter} onChange={e=>setTotpFilter(e.target.value)}><option value="all">全部两步验证</option><option value="totp">已设置 TOTP</option><option value="no-totp">未设置 TOTP</option></select></label>}
                <label className="sort-select"><select aria-label="账号排序" value={sort} onChange={e=>setSort(e.target.value as AccountSort)}><option value="newest">入库时间 · 最新优先</option><option value="oldest">入库时间 · 最早优先</option><option value="checked-newest">检测时间 · 最新优先</option><option value="checked-oldest">检测时间 · 最早优先</option><option value="username">用户名 · A–Z</option></select></label>
                <span className="filter-count">{filtered.length} 个筛选结果</span>
                {(query || filter!=='all' || groupFilter!=='all' || tagFilter!=='all' || totpFilter!=='all' || tab!=='all' || taskFilter!=='all') && <button className="text-button" onClick={resetFilters}><RotateCcw size={13}/>重置筛选</button>}
              </div>
              {checked.size > 0 && (
                <div className="selection-bar">
                  <Check size={15} />
                  <span>已勾选 {checked.size} 个账号</span>
                  {checked.size < filtered.length && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        setChecked(new Set(filtered.map((a) => a.id)))
                      }
                    >
                      全选筛选结果 ({filtered.length})
                    </button>
                  )}
                  <div className="batch-actions">
                    {view==='accounts' && <button className="button small-button" disabled={busy} onClick={()=>openExport('selected')} aria-haspopup="dialog"><Download size={14}/>导出选中</button>}
                    {view==='trash' && <button className="button small-button danger-quiet" disabled={busy || job.running} onClick={()=>{setDeleteError('');setDeletion({ids:[...checked],restore:false,permanent:true});}}>永久删除选中</button>}
                    {view==='accounts' && <button className="button small-button" disabled={busy} onClick={()=>setOrganizing({ids:[...checked]})}><Tags size={14}/>分组 / 标签</button>}
                    {view === "accounts" && (
                      <button
                        className="button small-button"
                        disabled={busy || job.running}
                        onClick={() => run(() => startCheck([...checked]))}
                      >
                        <RefreshCw size={14} />
                        检查选中
                      </button>
                    )}
                    <button
                      className={`button small-button ${view === "accounts" ? "danger-quiet" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        confirmTrash([...checked], view === "trash")
                      }
                    >
                      {view === "trash" ? (
                        <RotateCcw size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}{" "}
                      {view === "trash" ? "批量恢复" : "批量移入回收站"}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setChecked(new Set())}
                    >
                      取消勾选
                    </button>
                  </div>
                </div>
              )}
              {loading ? (
                <div className="loading-state">
                  <RefreshCw className="spin" />
                  正在读取本地账号…
                </div>
              ) : !filtered.length ? (
                <div className="empty-state">
                  <div className="empty-illustration">
                    <div className="mini-account rear">
                      <Github size={22} />
                      <span />
                    </div>
                    <div className="mini-account">
                      <div className="empty-avatar">
                        <Github size={28} />
                      </div>
                      <div>
                        <i />
                        <i />
                      </div>
                      <span className="mini-plus">
                        <Plus size={17} />
                      </span>
                    </div>
                    <span className="empty-shield">
                      <ShieldCheck size={21} />
                    </span>
                  </div>
                  <h2>
                    {view === "trash"
                      ? "回收站是空的"
                      : active.length
                        ? "没有符合条件的账号"
                        : "从你的第一批账号开始"}
                  </h2>
                  <p>
                    {view === "trash"
                      ? "移除的账号会保留在这里，不会直接删除。"
                      : active.length
                        ? "试试其他关键词，或调整上方的筛选条件。"
                        : "粘贴账号信息或导入 TXT 文件，建立你的专属账号库。"}
                  </p>
                  {view === "accounts" &&
                    (!active.length ? (
                      <>
                        <button
                          className="button primary"
                          onClick={() => setImporting(true)}
                        >
                          <Plus size={17} />
                          导入第一批账号
                        </button>
                        <code className="empty-format">
                          邮箱 ---- 密码 ---- 用户名 ---- TOTP 密钥（可选）
                        </code>
                      </>
                    ) : (
                      <button
                        className="button"
                        onClick={() => {
                          resetFilters();
                        }}
                      >
                        清除筛选
                      </button>
                    ))}
                </div>
              ) : (
                <>
                  <AccountTable rows={displayed} columns={columnSettings.visible} checked={checked} onToggle={toggle}
                    onTogglePage={()=>setChecked(previous=>{const next=new Set(previous);const all=displayed.every(a=>previous.has(a.id));displayed.forEach(a=>all?next.delete(a.id):next.add(a.id));return next;})}
                    organization={organization} trash={view==='trash'} busy={busy} job={job} sort={sort} onSort={value=>setSort(value as AccountSort)}
                    onOpen={openAccount} onOrganize={a=>setOrganizing({ids:[a.id],initial:a})} onCheck={id=>void run(()=>startCheck([id]))}
                    onTrash={id=>confirmTrash([id])} onRestore={id=>void run(async()=>{await api(`/accounts/${id}/restore`,'POST');await load(true);notify('账号已恢复');})}
                    onTask={openTask}/>
                  <footer className="table-footer">
                    <span>共 {filtered.length} 个账号</span><label className="page-size">每页 <select aria-label="每页条数" value={pageSize} onChange={e=>setPageSize(Number(e.target.value))}>{[15,25,50,100].map(n=><option key={n} value={n}>{n} 条</option>)}</select></label>
                    <div>
                      <button
                        className="icon-button"
                        aria-label="上一页"
                        disabled={safePage <= 1}
                        onClick={() => setPage(safePage - 1)}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span>
                        {safePage} / {pages}
                      </span>
                      <button
                        className="icon-button"
                        aria-label="下一页"
                        disabled={safePage >= pages}
                        onClick={() => setPage(safePage + 1)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </footer>
                </>
              )}
            </section>
          )}
          {view === "accounts" && (
            <div className="bottom-caption">
              <span>
                <LockKeyhole size={13} />
                密码与 TOTP 密钥加密保存于本机
              </span>
              <span>WorkBuddy2api 支持国际版 GitHub OAuth 授权</span>
            </div>
          )}

        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircleIcon />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="关闭通知"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {columnsOpen && <ColumnSettings view={columnView} visible={columnSettings.visible} onToggle={columnSettings.toggle} onReset={columnSettings.reset} onClose={()=>setColumnsOpen(false)}/>}
      {organizing && <OrganizeDialog ids={organizing.ids} initial={organizing.initial} data={organization} onClose={()=>setOrganizing(null)} onSaved={async()=>{await load(true);notify('分组与标签已更新');}}/>}
      {exporting && <ExportAccounts scope={exporting} onClose={()=>setExporting(null)} onComplete={message=>{setExporting(null);notify(message);}}/>}
      {creating && (
        <CreateAccount
          organization={organization}
          onClose={() => setCreating(false)}
          onCreated={(row) => {
            setCreating(false);
            notify(`已新增 @${row.username}`);
            load()
              .then(() => openAccount(row.id))
              .catch((e) => setError(e.message));
          }}
        />
      )}
      {checkSettingsOpen && <CheckSettings organization={organization} checking={job.running} onClose={()=>setCheckSettingsOpen(false)} onSaved={result=>notify(result.settings.enabled?'检测设置已保存，自动检测已启用':'检测设置已保存，自动检测已关闭')} onJob={result=>installMutation({job:result})}/>}
      {importing && (
        <ImportDialog
          organization={organization}
          onClose={() => setImporting(false)}
          onComplete={(message) => {
            setImporting(false);
            notify(message);
            load().catch((e) => setError(e.message));
          }}
        />
      )}
      {detail && (
        <AccountDetail
          organization={organization}
          onTask={()=>{setDetailId(null);openTask(detail);}}
          onOrganize={()=>setOrganizing({ids:[detail.id],initial:detail})}
          key={`${detail.id}-${dialogMode}`}
          mode={dialogMode}
          account={detail}
          checking={job.running}
          waiting={job.running && job.phase === "waiting"}
          onClose={() => setDetailId(null)}
          onUpdate={load}
          onSelect={openSelect}
          onCheck={(id) => startCheck([id])}
          onTrash={(id) => confirmTrash([id])}
          notify={notify}
        />
      )}
      {patConfig && <PatConfig status={pat} onClose={()=>setPatConfig(false)} onStatus={(next)=>installMutation({pat:next})}/>}
      {deletion && (
        <Modal
          title={deletion.permanent ? "永久删除账号" : deletion.restore ? "恢复选中的账号" : "移入回收站"}
          subtitle={`本次将${deletion.permanent ? "永久删除" : deletion.restore ? "恢复" : "移除"} ${deletion.ids.length} 个账号。`}
          onClose={() => {
            if (!busy) setDeletion(null);
          }}
        >
          <div className="modal-body">
            <div className="confirm-accounts">
              {accounts
                .filter((a) => deletion.ids.includes(a.id))
                .slice(0, 5)
                .map((a) => (
                  <span key={a.id}>@{a.username}</span>
                ))}
              {deletion.ids.length > 5 && (
                <span>以及另外 {deletion.ids.length - 5} 个账号</span>
              )}
            </div>
            <p className="muted small">
              {deletion.permanent
                ? "将彻底删除账号、密码、TOTP、标签关联及本地任务关联，无法从回收站恢复。不会撤销远端授权。"
                : deletion.restore
                ? "账号资料、检查结果和选用标记都会保留。"
                : "移除后不会参与检查和选用。资料会保留，可以在回收站恢复。"}
            </p>
            {deleteError && (
              <p role="alert" className="inline-error">
                {deleteError}
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setDeletion(null)}
            >
              取消
            </button>
            <button
              className={`button ${deletion.restore ? "primary" : "danger"}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setDeleteError("");
                try {
                  const result = await api<{ changed: number }>(
                    deletion.permanent ? "/accounts/trash" : "/accounts/batch",
                    deletion.permanent ? "DELETE" : "POST",
                    {
                      ids: deletion.ids,
                      confirmed: deletion.permanent === true,
                      action: deletion.restore ? "restore" : "trash",
                    },
                  );
                  await load();
                  if (detailId && deletion.ids.includes(detailId))
                    setDetailId(null);
                  setChecked(new Set());
                  setDeletion(null);
                  notify(
                    `已${deletion.permanent ? "永久删除" : deletion.restore ? "恢复" : "移入回收站"} ${result.changed} 个账号`,
                  );
                } catch (e) {
                  setDeleteError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? "处理中…"
                : deletion.permanent
                  ? "确认永久删除"
                  : deletion.restore
                  ? "确认恢复"
                  : "确认移入回收站"}
            </button>
          </footer>
        </Modal>
      )}
      {selection && (
        <Modal
          title="选用账号"
          subtitle={
            selection === "auto"
              ? "自动选择已保存 TOTP 密钥、24 小时内公开可访问且未选用的候选账号。"
              : `将 @${selection.username} 标记为已选用。`
          }
          onClose={() => {
            if (!busy) setSelection(null);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setSelectError("");
              try {
                const row = await api<Account>(
                  selection === "auto"
                    ? "/select"
                    : `/accounts/${selection.id}/select`,
                  "POST",
                  { purpose },
                );
                setSelection(null);
                await load();
                openAccount(row.id);
                notify(`已选用 @${row.username}，后续自动选择会跳过该账号`);
              } catch (e) {
                setSelectError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="modal-body">
              <div className="notice">
                <Info size={17} />
                <p>此操作会登记选用标记，不会登录 GitHub 或执行 OAuth 授权。</p>
              </div>
              <label className="field">
                用途或目标网站（选填）
                <input
                  maxLength={200}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="例如：项目名称 / 网站地址"
                />
              </label>
              <p className="muted small">
                公开状态不能保证登录正常。使用前请自行确认账号情况。
              </p>
              {selectError && (
                <p className="inline-error" role="alert">
                  {selectError}
                </p>
              )}
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setSelection(null)}
              >
                取消
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? "正在登记…" : "确认选用"}
                <Check size={16} />
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
function CheckCircleIcon() {
  return (
    <span className="toast-icon">
      <Check size={17} />
    </span>
  );
}
