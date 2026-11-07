import { useEffect, useRef, useId, useState, type ReactNode } from "react";
import { X, CheckCircle2, CircleDashed, CircleAlert } from "lucide-react";
import { statusLabels, type Account } from "./types";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  className = "",
  role,
  describedBy,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  role?: "alertdialog";
  describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[autofocus],[data-autofocus]")?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""} ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        const dialog = ref.current!;
        if (e.key !== "Tab" || (e.target as Element).closest("dialog") !== dialog) return;
        const items = [...dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')].filter(node =>
          node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden",
        );
        const first = items[0], last = items[items.length - 1];
        if (!first) { e.preventDefault(); dialog.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }}
      aria-labelledby={titleId}
      role={role}
      aria-describedby={describedBy}
    >
      <header className="modal-head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Status({ account }: { account: Account }) {
  const status = account.publicStatus;
  const Icon =
    status === "reachable"
      ? CheckCircle2
      : status === "unchecked"
        ? CircleDashed
        : CircleAlert;
  return (
    <span className={`badge ${status}`} title={account.checkMessage || '尚未运行公开检测'}>
      <Icon size={13} />
      {statusLabels[status]}
    </span>
  );
}
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const descriptionId = useId();
  return (
    <Modal
      title={title}
      onClose={onCancel}
      className="confirm-modal"
      role="alertdialog"
      describedBy={descriptionId}
    >
      <div className="modal-body confirmation-body">
        <span className="confirmation-icon">
          <CircleAlert size={24} />
        </span>
        <p id={descriptionId}>{description}</p>
      </div>
      <footer className="modal-footer confirmation-actions">
        <button type="button" className="button" data-autofocus onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="button danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}

export function useDiscardConfirmation(
  dirty: boolean,
  busy: boolean,
  onClose: () => void,
  importing = false,
  description?: string,
) {
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    if (busy) return;
    if (dirty) setConfirming(true);
    else onClose();
  };
  const confirmation = confirming ? (
    <ConfirmDialog
      title={importing ? "放弃本次导入？" : "放弃未保存的修改？"}
      description={
        description ||
        (importing
          ? "尚未导入的内容会被清空，已经保存的账号不受影响。"
          : "关闭后，本次未保存的修改会丢失，已保存的账号资料不会改变。")
      }
      cancelLabel={importing ? "继续导入" : "继续编辑"}
      confirmLabel={importing ? "放弃导入" : "放弃修改"}
      onCancel={() => setConfirming(false)}
      onConfirm={onClose}
    />
  ) : null;
  return { close, confirmation };
}
