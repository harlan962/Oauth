import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Clock, Play, RefreshCw, Send } from "lucide-react";
import { api } from "./api";
import { Switch } from "./Switch";

type Settings = {
  enabled: boolean;
  dailyAt: string;
  checkBefore: boolean;
  staleDays: number;
  lastRunAt: string | null;
};
type Payload = { settings: Settings; nextRunAt: string | null; stale: number };

function stamp(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Daily patrol lives on its own page: it is a schedule, not a chat feature and
 * not a delivery channel. Splitting it out keeps the bot page about commands and
 * the channel page about destinations.
 */
export function PatrolPage({ notify }: { notify: (message: string) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api<Payload>("/bot?messages=1");
      setData(result);
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

  async function patchSettings(patch: Partial<Settings>) {
    if (!data) return;
    setBusy("settings");
    setError("");
    try {
      await api("/bot/settings", "PUT", { ...data.settings, ...patch });
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function run(kind: "report" | "check") {
    setBusy(kind);
    setError("");
    try {
      const result = await api<{ started?: boolean; count?: number; empty?: boolean; channels?: number }>(
        kind === "report" ? "/bot/report" : "/bot/check",
        "POST",
        {},
      );
      if (kind === "report")
        notify(
          result.channels
            ? `报告已推送到 ${result.channels} 个通道`
            : "没有通道订阅「巡检与播报」，去「推送通道」里打开订阅",
        );
      else if (result.empty) notify(`没有超过 ${data?.settings.staleDays ?? 7} 天未检查的账号`);
      else if (result.count) notify(`已开始检活：${result.count} 个账号`);
      else notify("检活已在进行中");
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy("");
    }
  }

  const settings = data?.settings;
  const enabled = !!settings?.enabled;

  return (
    <div className="notify-page">
      <div className="security-summary">
        <section className="security-stat">
          <span className="security-stat-label">
            <Clock size={14} />
            自动巡检
          </span>
          <strong className={`security-stat-value${enabled ? " is-ok" : " is-warn"}`}>
            {loading ? "—" : enabled ? settings?.dailyAt : "未开启"}
          </strong>
          <span className="security-stat-note">
            {loading ? "正在读取…" : enabled ? "每天这个时间自动跑一次" : "打开下面开关后才会执行"}
          </span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <Play size={14} />
            下次运行
          </span>
          <strong className="security-stat-value">{loading ? "—" : enabled ? stamp(data?.nextRunAt ?? null) : "—"}</strong>
          <span className="security-stat-note">
            {settings?.lastRunAt ? `上次运行 ${stamp(settings.lastRunAt)}` : "还没有自动运行过"}
          </span>
        </section>
        <section className={`security-stat${data?.stale ? " is-warn" : ""}`}>
          <span className="security-stat-label">
            <AlertTriangle size={14} />
            过期未检查
          </span>
          <strong className={`security-stat-value${data?.stale ? " is-warn" : " is-ok"}`}>
            {loading ? "—" : (data?.stale ?? 0)}
          </strong>
          <span className="security-stat-note">
            超过 {settings?.staleDays ?? 7} 天没检查的账号
          </span>
        </section>
      </div>

      {error && (
        <p role="alert" className="inline-error security-error">
          {error}
          <button type="button" className="text-button" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}

      <section className="security-card">
        <header className="security-card-head">
          <div>
            <Clock size={16} />
            <h2>每日巡检</h2>
          </div>
          <div className="security-head-actions">
            <button
              type="button"
              className="icon-button"
              aria-label="刷新"
              title="刷新"
              disabled={loading || !!busy}
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </button>
            <button
              type="button"
              className="button"
              disabled={loading || !!busy}
              onClick={() => void run("check")}
            >
              <Play size={14} />
              {busy === "check" ? "启动中…" : "立即检活"}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={loading || !!busy}
              onClick={() => void run("report")}
            >
              <Send size={14} />
              {busy === "report" ? "发送中…" : "立即播报"}
            </button>
          </div>
        </header>

        <label className="patrol-switch">
          <Switch
            checked={enabled}
            disabled={loading || !!busy}
            label={enabled ? "关闭每日自动巡检" : "开启每日自动巡检"}
            onChange={(next) => void patchSettings({ enabled: next })}
          />
          <span>
            <strong>{enabled ? "每天自动巡检一次" : "每日自动巡检已关闭"}</strong>
            <em>
              {enabled
                ? "到点先检查过期账号，再推一份报告；没有新结果也会播报当前状态。"
                : "打开后每天在设定时间检查过期账号并播报，不需要任何人在群里发指令。"}
            </em>
          </span>
        </label>

        <div className="patrol-grid">
          <label className="field">
            时间（北京时间）
            <input
              type="time"
              value={settings?.dailyAt || "09:00"}
              disabled={loading || !!busy}
              onChange={(event) => void patchSettings({ dailyAt: event.target.value })}
            />
            <span className="auth-field-help">按东八区换算，服务器时区不影响。</span>
          </label>
          <label className="field">
            超过多少天算过期
            <input
              type="number"
              min={1}
              max={365}
              value={settings?.staleDays ?? 7}
              disabled={loading || !!busy}
              onChange={(event) => void patchSettings({ staleDays: Number(event.target.value) })}
            />
            <span className="auth-field-help">只检查超过这个天数的账号，不碰刚查过的。</span>
          </label>
        </div>

        <label className="patrol-switch is-compact">
          <Switch
            checked={!!settings?.checkBefore}
            disabled={loading || !!busy}
            label={settings?.checkBefore ? "关闭播报前检活" : "开启播报前检活"}
            onChange={(next) => void patchSettings({ checkBefore: next })}
          />
          <span>
            <strong>播报前先检活</strong>
            <em>先跑一批过期账号再出报告，当前有 {data?.stale ?? 0} 个过期。</em>
          </span>
        </label>
      </section>

      <section className="security-card">
        <header className="security-card-head">
          <div>
            <Send size={16} />
            <h2>报告内容</h2>
          </div>
        </header>
        <ul className="patrol-report">
          <li>
            <Check size={12} />
            账号总数与可访问 / 失联 / 待确认 / 未检测的分布，以及上次检查时间
          </li>
          <li>
            <Check size={12} />
            两步验证缺口：还有多少账号没有配置 TOTP
          </li>
          <li>
            <Check size={12} />
            近 24 小时：登录失败、来源被拒、凭据读取、明文导出的条数
          </li>
          <li>
            <Check size={12} />
            推送通道健康度：多少个通道、有没有最近失败的
          </li>
        </ul>
        <p className="security-hint">
          报告只发给订阅了「巡检与播报」的通道，不和登录告警混在一条时间线里。
          一条通道都没订阅时，「立即播报」会提示你去「推送通道」里补上。
        </p>
      </section>
    </div>
  );
}
