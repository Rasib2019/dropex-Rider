import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Show an optional free-text reason box; its value is passed to onConfirm. */
  reasonLabel?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

/** In-app bottom-sheet confirmation. Replaces window.confirm / window.prompt. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  reasonLabel,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [reason, setReason] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setReason("");
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={() => (busy ? undefined : onCancel())}>
      <div
        className="dialog-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-msg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dialog-title">{title}</h2>
        <p id="dialog-msg">{message}</p>
        {reasonLabel ? (
          <>
            <label htmlFor="dialog-reason">{reasonLabel}</label>
            <input
              id="dialog-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />
          </>
        ) : null}
        <div className="dialog-actions">
          <button ref={cancelRef} className="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className="danger" onClick={() => onConfirm(reason.trim())} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
