import type { ReactNode } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { timeRanges, type TimeRange } from "./filters";

/**
 * One filter strip for every log view: a search box that understands IPs,
 * device names and account labels, a time window, and room for a per-view
 * select (result, action, category). Keeping the shape identical across tabs
 * means the controls sit in the same place whichever list you are reading.
 */
export function FilterBar({
  query,
  onQuery,
  range,
  onRange,
  placeholder = "搜索 IP、设备、账号或详情…",
  shown,
  total,
  onReset,
  children,
}: {
  query: string;
  onQuery: (value: string) => void;
  range?: TimeRange;
  onRange?: (value: TimeRange) => void;
  placeholder?: string;
  shown: number;
  total: number;
  /** Clears the per-view select too; without it only search and range reset. */
  onReset?: () => void;
  children?: ReactNode;
}) {
  const filtered = shown !== total;
  return (
    <div className="filter-bar">
      <label className="filter-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => onQuery(event.target.value)}
        />
        {query && (
          <button type="button" className="filter-clear" aria-label="清空搜索" onClick={() => onQuery("")}>
            <X size={12} />
          </button>
        )}
      </label>

      {range && onRange && (
        <label className="filter-select">
          <SlidersHorizontal size={13} aria-hidden="true" />
          <select
            value={range}
            aria-label="时间范围"
            onChange={(event) => onRange(event.target.value as TimeRange)}
          >
            {timeRanges.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {children}

      <span className={`filter-summary${filtered ? " is-filtered" : ""}`}>
        {filtered ? `筛出 ${shown} / ${total} 条` : `共 ${total} 条`}
      </span>

      {filtered && (
        <button
          type="button"
          className="filter-reset"
          onClick={() => {
            onQuery("");
            if (onRange) onRange("all");
            onReset?.();
          }}
        >
          重置
        </button>
      )}
    </div>
  );
}
