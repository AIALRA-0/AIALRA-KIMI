import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function DialogShell({
  labelledBy,
  describedBy,
  busy = false,
  onClose,
  children,
}: {
  labelledBy: string;
  describedBy?: string;
  busy?: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const first = dialog.current?.querySelector<HTMLElement>(
      "[data-dialog-initial-focus]," + FOCUSABLE_SELECTOR,
    );
    first?.focus();
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      if (!busy) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...((dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
        []) as NodeListOf<HTMLElement>),
    ];
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.current?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialog}
        className="dialog-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
