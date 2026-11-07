import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Page sizes offered in the selector. The security centre streams at most 500
 * events and 200 credential rows, so every one of these keeps the DOM small
 * while still letting someone widen the view when hunting a specific entry.
 */
export const pageSizes = [20, 50, 100];

export type PagerState = {
  page: number;
  pages: number;
  size: number;
  total: number;
  rangeStart: number;
  rangeEnd: number;
  go: (page: number) => void;
  resize: (size: number) => void;
};

/**
 * Client-side paging over an already-fetched list. The data volume here is
 * bounded by the API limits, so slicing in memory keeps navigation instant and
 * avoids a round trip (and a flicker) on every page change. The clamp in
 * `page` means a shrinking list can never strand the view on a blank page.
 */
export function usePage<T>(items: T[], initialSize = pageSizes[0], resetKey?: unknown) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initialSize);
  // Changing a filter must not leave you on page 6 of a list that now has two
  // pages. Adjusting during render (rather than in an effect) avoids painting
  // one frame of the stale page before snapping back.
  const [seenKey, setSeenKey] = useState(resetKey);
  if (resetKey !== seenKey) {
    setSeenKey(resetKey);
    setPage(1);
  }
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages);
  const start = (current - 1) * size;
  return {
    page: current,
    pages,
    size,
    total: items.length,
    rows: items.slice(start, start + size),
    rangeStart: items.length ? start + 1 : 0,
    rangeEnd: Math.min(start + size, items.length),
    go(next: number) {
      setPage(Math.min(Math.max(1, next), pages));
    },
    resize(next: number) {
      setSize(next);
      setPage(1);
    },
  };
}

// 1 … 4 5 6 … 24 — keeps the control a fixed width however long the log grows.
function pageButtons(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 4) [2, 3, 4, 5].forEach((n) => keep.add(n));
  if (page >= pages - 3) [pages - 4, pages - 3, pages - 2, pages - 1].forEach((n) => keep.add(n));
  const sorted = [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const output: (number | "gap")[] = [];
  let previous = 0;
  for (const n of sorted) {
    if (previous && n - previous > 1) output.push("gap");
    output.push(n);
    previous = n;
  }
  return output;
}

export function Pager({
  state,
  unit = "条",
  label,
}: {
  state: PagerState;
  unit?: string;
  label?: string;
}) {
  const { page, pages, size, total, rangeStart, rangeEnd } = state;
  if (!total) return null;
  // The controls stay on screen even when everything fits on one page: a footer
  // that silently disappears reads as "this list has no paging", and then the
  // page-size selector is unreachable exactly when the list is about to grow.
  return (
    <nav className="pager" aria-label={label ? `${label}分页` : "分页"}>
      <span className="pager-total">
        共 {total} {unit}
        <span className="pager-range">
          （第 {rangeStart}–{rangeEnd} {unit}）
        </span>
      </span>
      <span className="pager-pages">
        <button
          type="button"
          className="pager-step"
          aria-label="上一页"
          title="上一页"
          disabled={page <= 1}
          onClick={() => state.go(page - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        {pageButtons(page, pages).map((item, index) =>
          item === "gap" ? (
            <span key={`gap-${index}`} className="pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className={`pager-page${item === page ? " is-active" : ""}`}
              aria-current={item === page ? "page" : undefined}
              aria-label={`第 ${item} 页`}
              onClick={() => state.go(item)}
            >
              {item}
            </button>
          ),
        )}
        <button
          type="button"
          className="pager-step"
          aria-label="下一页"
          title="下一页"
          disabled={page >= pages}
          onClick={() => state.go(page + 1)}
        >
          <ChevronRight size={14} />
        </button>
      </span>
      <label className="pager-size">
        每页
        <select
          value={size}
          aria-label="每页条数"
          onChange={(event) => state.resize(Number(event.target.value))}
        >
          {pageSizes.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {unit}
      </label>
    </nav>
  );
}
