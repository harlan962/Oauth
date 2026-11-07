import { useMemo, useState } from "react";
import { Check, Inbox, RefreshCw, X } from "lucide-react";
import { date } from "./types";
import { FilterBar } from "./FilterBar";
import { matchesQuery, withinRange, type TimeRange } from "./filters";
import { Pager, usePage } from "./Pager";
import { eventLabel } from "./event-labels";
import { useNotifyData } from "./notify-data";

type ResultFilter = "all" | "ok" | "fail";

/**
 * Delivery history is its own page: when a push silently fails you come here
 * with one question ("did it leave, and what did the endpoint say?"), and
 * nothing else should be competing for attention.
 */
export function DeliveriesPage() {
  const { channels, deliveries, loading, error, load } = useNotifyData(200);

  const [query, setQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [range, setRange] = useState<TimeRange>("all");

  const names = useMemo(
    () => Object.fromEntries(channels.map((item) => [item.id, item.name])),
    [channels],
  );

  const visible = useMemo(
    () =>
      deliveries.filter((item) => {
        if (resultFilter === "ok" && !item.ok) return false;
        if (resultFilter === "fail" && item.ok) return false;
        if (!withinRange(item.at, range)) return false;
        return matchesQuery(
          [
            names[item.channelId] || "已删除的通道",
            eventLabel(item.kind),
            item.kind,
            item.detail,
            item.ok ? "成功" : "失败",
          ],
          query,
        );
      }),
    [deliveries, resultFilter, range, query, names],
  );

  const page = usePage(visible, 20, `${query}|${resultFilter}|${range}`);

  const stats = useMemo(() => {
    const since = Date.now() - 86400000;
    const recent = deliveries.filter((item) => Date.parse(item.at) >= since);
    return {
      sent: recent.filter((item) => item.ok).length,
      failed: recent.filter((item) => !item.ok).length,
    };
  }, [deliveries]);

  return (
    <div className="notify-page">
      <div className="security-summary">
        <section className="security-stat">
          <span className="security-stat-label">
            <Check size={14} />
            24 小时送达
          </span>
          <strong className="security-stat-value is-ok">{loading ? "—" : stats.sent}</strong>
          <span className="security-stat-note">含测试消息与巡检报告</span>
        </section>
        <section className={`security-stat${stats.failed ? " is-warn" : ""}`}>
          <span className="security-stat-label">
            <X size={14} />
            24 小时失败
          </span>
          <strong className={`security-stat-value${stats.failed ? " is-warn" : " is-ok"}`}>
            {loading ? "—" : stats.failed}
          </strong>
          <span className="security-stat-note">
            {stats.failed ? "表格里带红色结果的那几行" : "没有失败的投递"}
          </span>
        </section>
        <section className="security-stat">
          <span className="security-stat-label">
            <Inbox size={14} />
            保留记录
          </span>
          <strong className="security-stat-value">{loading ? "—" : deliveries.length}</strong>
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
            <h2>发送记录</h2>
            <span className="security-count">{deliveries.length}</span>
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

        {deliveries.length > 0 ? (
          <>
            <FilterBar
              query={query}
              onQuery={setQuery}
              range={range}
              onRange={setRange}
              placeholder="搜索通道、事件或失败原因…"
              shown={visible.length}
              total={deliveries.length}
              onReset={() => setResultFilter("all")}
            >
              <label className="filter-select">
                <select
                  value={resultFilter}
                  aria-label="发送结果"
                  onChange={(event) => setResultFilter(event.target.value as ResultFilter)}
                >
                  <option value="all">全部结果</option>
                  <option value="ok">仅成功</option>
                  <option value="fail">仅失败</option>
                </select>
              </label>
            </FilterBar>

            {visible.length ? (
              <div className="log-table-wrap">
                <table className="log-table">
                  <thead>
                    <tr>
                      <th scope="col">时间</th>
                      <th scope="col">结果</th>
                      <th scope="col">通道</th>
                      <th scope="col">事件</th>
                      <th scope="col">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((item, index) => (
                      <tr key={`${item.at}-${index}`} className={item.ok ? "is-ok" : "is-alert"}>
                        <td className="log-table-time">{date(item.at)}</td>
                        <td>
                          <span className={`table-pill${item.ok ? " is-ok" : " is-alert"}`}>
                            {item.ok ? "成功" : "失败"}
                          </span>
                        </td>
                        <td className="log-table-strong">
                          {names[item.channelId] || <span className="log-table-muted">通道已删除</span>}
                        </td>
                        <td>{eventLabel(item.kind)}</td>
                        <td className="log-table-detail">{item.detail || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="security-empty">没有符合筛选条件的发送记录</p>
            )}

            <Pager state={page} label="发送记录" />
          </>
        ) : (
          <p className="security-empty">
            {loading ? "正在读取…" : "去「推送通道」添加一条通道并点「测试」，这里就会出现第一条记录"}
          </p>
        )}

        <p className="security-hint">
          记录保留最近 2000 条。失败通常来自 Webhook 地址失效、加签密钥不对或 SMTP 被拒，
          回到「推送通道」点「测试」就能看到具体报错。
        </p>
      </section>
    </div>
  );
}
