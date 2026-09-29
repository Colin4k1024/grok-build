import type { ReactNode } from "react";
import { InlineNotice, EmptyState, Skeleton } from "./Feedback";
import { Button } from "./Button";

/**
 * AsyncState (R4-09 #242): the shared loading/empty/error renderer for
 * page-level async data. Every surface that fetches data renders one of
 * four consistent states instead of hand-rolled `<p>加载中</p>` / red `<div>`:
 * loading → Skeleton rows, empty → EmptyState with a clear next step,
 * error → InlineNotice (role=alert) with a Retry action, data → children.
 *
 * `offline`/`permission-denied` are expressed through `error`/`empty` copy
 * (there is no separate transport layer to detect them here); callers pass
 * the appropriate message.
 */
export function AsyncState({
  loading,
  error,
  empty,
  onRetry,
  emptyTitle,
  emptyDescription,
  emptyAction,
  skeletonRows = 3,
  children,
}: {
  loading: boolean;
  error?: string | null;
  empty?: boolean;
  onRetry?: () => void;
  emptyTitle: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  skeletonRows?: number;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        {Array.from({ length: skeletonRows }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-gb-md" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <InlineNotice tone="danger" title="加载失败">
        <span className="block">{error}</span>
        {onRetry ? (
          <span className="mt-2 block">
            <Button size="sm" variant="secondary" onClick={onRetry}>
              重试
            </Button>
          </span>
        ) : null}
      </InlineNotice>
    );
  }
  if (empty) {
    return (
      <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
    );
  }
  return <>{children}</>;
}
