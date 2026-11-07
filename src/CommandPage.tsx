import { RefreshCw, ShieldCheck, Terminal, Timer } from "lucide-react";
import { useBotData } from "./bot-data";

/**
 * Reference page: what you can type in the group. It is read-only and lives
 * apart from the bot list so the list stays about "which groups are connected".
 */
export function CommandPage() {
  const { data, loading, error, load } = useBotData(1);
  const commands = data?.commands || [];

  return (
    <div className="notify-page">
      <div className="security-summary">
        <section className="security-stat">
          <span className="security-stat-label">
            <Terminal size={14} />
            可用指令
          </span>
          <strong className="security-stat-value">{loading ? "—" : commands.length}</strong>
          <span className="security-stat-note">在群里直接发，不用加前缀</span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <ShieldCheck size={14} />
            权限
          </span>
          <strong className="security-stat-value is-ok">只读</strong>
          <span className="security-stat-note">不返回密码与两步验证密钥</span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <Timer size={14} />
            频率
          </span>
          <strong className="security-stat-value">20 / 分</strong>
          <span className="security-stat-note">每个机器人单独计算</span>
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
            <Terminal size={16} />
            <h2>可用指令</h2>
            <span className="security-count">{commands.length}</span>
          </div>
          <div className="security-head-actions">
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
          </div>
        </header>

        <ul className="bot-commands">
          {commands.map((item) => (
            <li key={item.command}>
              <code>
                {item.command}
                {item.argv ? ` ${item.argv}` : ""}
              </code>
              <span>{item.hint}</span>
            </li>
          ))}
        </ul>

        <p className="security-hint">
          机器人是只读的：能触发检活和播报，看不到任何密码或两步验证密钥。
          检活 5 分钟内只启动一次，避免群里连点把检测排满。
        </p>
      </section>
    </div>
  );
}
