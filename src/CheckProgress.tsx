import { Activity, X } from "lucide-react";
import { beijingDate, type Job } from "./types";

export function CheckProgress({
  job,
  busy,
  onCancel,
  onDismiss,
  onResume,
}: {
  job: Job;
  busy: boolean;
  onCancel: () => void;
  onDismiss: () => void;
  onResume?: () => void;
}) {
  if (!job.running && !job.message) return null;
  const counts = job.counts || {
    reachable: 0,
    missing: 0,
    limited: 0,
    error: 0,
    skipped: 0,
  };
  return (
    <section
      className={`check-progress ${job.running ? "running" : ""}`}
      aria-label="活性检查进度"
    >
      <div className="check-progress-head">
        <Activity size={18} className={job.running && job.phase !== "waiting" ? "pulse" : ""} />
        <div role="status">
          <strong>{job.message}</strong>
          <span>
            {({all:'全部账号',single:'单个账号',scheduled:'自动检测',filtered:'筛选范围',selected:'选中账号'})[job.scope] || '选中账号'}{" "}
            · {job.done} / {job.total}
            {job.current ? ` · @${job.current}` : ""}
            {job.patUsername ? ` · PAT @${job.patUsername}` : ''}
          </span>
          {job.phase === "waiting" && <span>北京时间恢复：{beijingDate(job.retryAt)} · 等待后重试当前账号</span>}
          {!job.running && job.canResume && <span>保留未完成进度；PAT 浏览器需处理时，请先前往侧栏「PAT 管理」继续。</span>}
        </div>
        {!job.running && job.canResume && <button className="button small-button" disabled={busy} onClick={onResume}>继续检查</button>}
        {job.running ? (
          <button
            className="button small-button"
            disabled={busy || job.cancelled}
            onClick={onCancel}
          >
            {job.cancelled ? "正在取消…" : "取消检查"}
          </button>
        ) : (
          <button
            className="icon-button"
            aria-label="关闭检查结果"
            onClick={onDismiss}
          >
            <X size={16} />
          </button>
        )}
      </div>
      <progress
        aria-label="检查完成比例"
        value={job.done}
        max={Math.max(job.total, 1)}
      />
      <div className="check-counts">
        <span className="count-ok">
          可访问 <b>{counts.reachable}</b>
        </span>
        <span className="count-missing">
          不可访问 <b>{counts.missing}</b>
        </span>
        <span>
          请求受限 <b>{counts.limited}</b>
        </span>
        <span>
          检查失败 <b>{counts.error}</b>
        </span>
        {counts.skipped > 0 && (
          <span>
            已变更 / 跳过 <b>{counts.skipped}</b>
          </span>
        )}
        {!job.running && job.done < job.total && (
          <span>
            未检查 <b>{job.total - job.done}</b>
          </span>
        )}
      </div>
    </section>
  );
}
