import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "../../lib/utils";

// Destructive/default alert in the existing ui-component style (hand-rolled,
// no new deps). Motion reuses the repo's tw-animate-css classes with
// motion-reduce:animate-none, matching the prefers-reduced-motion scoping
// pattern already used across the app.
const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm animate-in fade-in slide-in-from-top-1 motion-reduce:animate-none",
  {
    variants: {
      variant: {
        default: "border-border bg-background text-card-foreground",
        destructive:
          "border-destructive/50 bg-destructive/5 text-destructive [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface AlertProps extends VariantProps<typeof alertVariants> {
  title?: string;
  children?: React.ReactNode;
  /** Dismiss control; renders the close button when provided. */
  onDismiss?: () => void;
  /** Accessible label for the dismiss button (localized copy). */
  dismissLabel?: string;
  /** Auto-dismiss delay in ms. Transient attachment notices ONLY — send,
   *  wallet, model, save and reconnect alerts must stay persistent. */
  autoDismissMs?: number;
  className?: string;
}

export function Alert({
  variant,
  title,
  children,
  onDismiss,
  dismissLabel,
  autoDismissMs,
  className,
}: AlertProps) {
  // Latest-callback ref: the deadline is armed once per (duration, armed)
  // change — NOT per parent render. Inline closures from the parent change
  // identity on every render, which would restart the timer and defer
  // auto-dismiss indefinitely while the parent streams/types.
  const onDismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    onDismissRef.current = onDismiss;
  });
  const armed = autoDismissMs !== undefined && onDismiss !== undefined;
  React.useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => onDismissRef.current?.(), autoDismissMs);
    return () => clearTimeout(timer);
  }, [armed, autoDismissMs]);

  return (
    <div role="alert" className={cn(alertVariants({ variant }), "pr-10", className)}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cn(title && "mt-0.5 text-[0.8rem]")}>{children}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="absolute right-2 top-2 rounded-sm p-1 text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
