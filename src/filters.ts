/**
 * Filtering helpers shared by the security lists and the push page.
 *
 * Everything here runs on data that has already been fetched: the API caps each
 * list at a few hundred rows, so narrowing in memory keeps typing instant and
 * avoids a round trip per keystroke. The server stays the source of truth for
 * what exists; this only decides what is worth showing right now.
 */

export type TimeRange = "all" | "today" | "7d" | "30d";

export const timeRanges: { id: TimeRange; label: string }[] = [
  { id: "all", label: "全部时间" },
  { id: "today", label: "今天" },
  { id: "7d", label: "近 7 天" },
  { id: "30d", label: "近 30 天" },
];

/** Cut-off instant for a range, in local time so "今天" matches the clock. */
export function rangeStart(range: TimeRange): number {
  if (range === "all") return 0;
  if (range === "today") {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  return Date.now() - (range === "7d" ? 7 : 30) * 86400000;
}

export function withinRange(at: string | number, range: TimeRange): boolean {
  if (range === "all") return true;
  const value = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(value) && value >= rangeStart(range);
}

/**
 * Every field someone might paste in while hunting a record: an IP, a device
 * name, an account label, or a fragment of the detail text.
 */
export function matchesQuery(fields: (string | null | undefined)[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  // A space-separated query is an AND: "chrome 10.0" narrows instead of widening.
  return needle
    .split(/\s+/)
    .every((part) => fields.some((field) => (field || "").toLowerCase().includes(part)));
}
