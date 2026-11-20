import { lazy, type ReactNode, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { reloadOnce } from "@/lib/chunk-reload";
import { Button } from "./button";
import { ErrorBoundary } from "./error-boundary";

// Errors of the chunk imports themselves, as opposed to render errors of the loaded part.
const loadErrors = new WeakSet<object>();

type Part<P> = (props: P) => ReactNode;

/**
 * A part of the page whose code arrives on its first render (TB-15).
 * - While the chunk loads, the placeholder holds its place.
 * - A chunk missing after a deploy reloads the page once, as route chunks do.
 * - Any other load failure, or the same one after that reload, shows a retry
 *   in place of the part instead of the root crash screen. The first retry
 *   imports again; the next one reloads the page.
 * - Render errors of the loaded part go on to the next boundary as before.
 */
export function lazyPart<P extends object>(
  load: () => Promise<{ default: Part<P> }>,
  placeholder: ReactNode,
) {
  const importPart = () =>
    load().catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // The page is reloading: keep the placeholder until it goes.
      if (reloadOnce(error)) return new Promise<never>(() => {});
      loadErrors.add(error);
      throw error;
    });
  // React.lazy keeps a failed import, so a retry needs a new one.
  const current = { Loaded: lazy(importPart), retried: false };

  function Current(props: P) {
    const Loaded = current.Loaded;
    return <Loaded {...props} />;
  }

  function LoadFailed({
    error,
    resetError,
  }: {
    error: Error;
    resetError: () => void;
  }) {
    const { t } = useTranslation();
    if (!loadErrors.has(error)) throw error;
    const retry = () => {
      if (current.retried) {
        window.location.reload();
        return;
      }
      current.retried = true;
      current.Loaded = lazy(importPart);
      resetError();
    };
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 py-4 text-muted-foreground text-sm"
      >
        <p>{t("common:error.messages.network")}</p>
        <Button size="sm" variant="outline" onClick={retry}>
          {t("common:error.tryAgain")}
        </Button>
      </div>
    );
  }

  function LazyPart(props: P) {
    return (
      <ErrorBoundary fallback={LoadFailed}>
        <Suspense fallback={placeholder}>
          <Current {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return LazyPart;
}
