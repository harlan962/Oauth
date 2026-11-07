import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Inbox, RefreshCw } from "lucide-react";
import { date } from "./types";
import { FilterBar } from "./FilterBar";
import { matchesQuery, withinRange, type TimeRange } from "./filters";
import { Pager, usePage } from "./Pager";
import { useBotData } from "./bot-data";

type Direction = "all" | "in" | "out";

/**
 * The transcript: every instruction a group sent and every reply the desk gave.
 * Kept separate from the bot list because it grows every day and the bot list
 * does not.
 */
export function BotMessagesPage() {
  const { data, loading, error, load } = useBotData(300);

  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState<Direction>("all");
  const [range, setRange] = useState<TimeRange>("all");

  const names = useMemo(
    () => Object.fromEntries((data?.bots || []).map((item) => [item.id, item.name])),
    [data],
  );

  const messages = data?.messages || [];

  const visible = useMemo(
    () =>
      messages.filter((item) => {
        if (direction !== "all" && item.direction !== direction) return false;
        if (!withinRange(item.at, range)) return false;
        return matchesQuery([names[item.botId] || "已删除的机器人", item.text, item.actor], query);
      }),
    [messages, direction, range, query, names],
  );

  const page = usePage(visible, 20, `${query}|${direction}|${range}`);

  const stats = useMemo(() => {
    const since = Date.now() - 86400000;
    const recent = messages.filter((item) => Date.parse(item.at) >= since);
    return {
      received: recent.filter((item) => item.direction === "in").length,
      replied: recent.filter((item) => item.direction === "out").length,
    };
  }, [messages]);

  return (
    <div className="notify-page">
      <div className="security-summary">
        <section className="security-stat">
          <span className="security-stat-label">
            <ArrowDownLeft size={14} />
            24 小时收到
          </span>
          <strong className="security-stat-value">{loading ? "—" : stats.received}</strong>
          <span className="security-stat-note">群里发来的指令</span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <ArrowUpRight size={14} />
            24 小时回复
          </span>
          <strong className="security-stat-value">{loading ? "—" : stats.replied}</strong>
          <span className="security-stat-note">机器人答出去的消息</span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <Inbox size={14} />
            保留记录
          </span>
          <strong className="security-stat-value">{loading ? "—" : messages.length}</strong>
          <span className="security-stat-note">最多保留最近 2000 条</span>
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
            <Inbox size={16} />
            <h2>消息记录</h2>
            <span className="security-count">{messages.length}</span>
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

        {messages.length > 0 ? (
          <>
            <FilterBar
              query={query}
              onQuery={setQuery}
              range={range}
              onRange={setRange}
              placeholder="搜索内容、机器人或操作人…"
              shown={visible.length}
              total={messages.length}
              onReset={() => setDirection("all")}
            >
              <label className="filter-select">
                <select
                  value={direction}
                  aria-label="消息方向"
                  onChange={(event) => setDirection(event.target.value as Direction)}
                >
                  <option value="all">收发全部</option>
                  <option value="in">仅收到</option>
                  <option value="out">仅回复</option>
                </select>
              </label>
            </FilterBar>

            {visible.length ? (
              <div className="log-table-wrap">
                <table className="log-table">
                  <thead>
                    <tr>
                      <th scope="col">时间</th>
                      <th scope="col">方向</th>
                      <th scope="col">机器人</th>
                      <th scope="col">内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((item, index) => (
                      <tr key={`${item.at}-${index}`} className={item.direction === "in" ? "is-ok" : ""}>
                        <td className="log-table-time">{date(item.at)}</td>
                        <td>
                          <span className={`table-pill${item.direction === "in" ? " is-ok" : ""}`}>
                            {item.direction === "in" ? "收到" : "回复"}
                          </span>
                        </td>
                        <td className="log-table-strong">{names[item.botId] || "已删除的机器人"}</td>
                        <td className="log-table-detail bot-message">
                          {item.text}
                          {item.actor && <span className="bot-actor">{item.actor}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="security-empty">没有符合筛选条件的消息</p>
            )}

            <Pager state={page} label="消息记录" />
          </>
        ) : (
          <p className="security-empty">
            {loading ? "正在读取…" : "机器人收到指令后，问答都会记录在这里，方便回看谁问过什么"}
          </p>
        )}

        <p className="security-hint">
          记录只保存问答正文，不含任何凭据。回看历史不影响机器人本身，也不会让已经发出去的消息消失。
        </p>
      </section>
    </div>
  );
}
