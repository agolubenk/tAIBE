import { useCallback, useEffect, useRef, useState } from "react";
import { i18n } from "@/lib/i18n";
import {
  ReauthCancelledError,
  SessionNotFreshError,
} from "@/lib/reauth/reauth-errors";
import { ReauthDialog, type ReauthRequest } from "./reauth-dialog";

/**
 * TB-31 R-5. `run(action)` runs a guarded action. If the server asks for a
 * fresh sign-in, the window opens. After the person confirms, the action runs
 * once more at once; if the person cancels, it throws ReauthCancelledError.
 * Render `dialog` inside the dialog that runs the action, so Base UI nests it.
 * `confirm(error)` only opens the window: for an action that needs a new
 * press after it, as a passkey ceremony does in Safari (R-6).
 */
export function useFreshSession() {
  const [request, setRequest] = useState<ReauthRequest | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  // A window still open when its owner unmounts counts as cancelled.
  useEffect(() => () => resolveRef.current?.(false), []);

  const ask = useCallback(
    (error: SessionNotFreshError, opener: HTMLElement | null) =>
      new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
        setRequest((prev) => ({
          id: (prev?.id ?? 0) + 1,
          open: true,
          methods: error.methods,
          impersonated: error.impersonated,
          opener,
        }));
      }),
    [],
  );

  const confirm = useCallback(
    (error: SessionNotFreshError) => ask(error, activeElement()),
    [ask],
  );

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      // Taken before the action: a pending button may lose focus.
      const opener = activeElement();
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof SessionNotFreshError)) throw error;
        if (!(await ask(error, opener))) throw new ReauthCancelledError();
      }
      try {
        return await action();
      } catch (again) {
        // Fresh for 5 minutes now; a second refusal is not a reason to ask again.
        if (again instanceof SessionNotFreshError) {
          throw new Error(i18n.t("auth:reauth.errors.stillNotFresh"));
        }
        throw again;
      }
    },
    [ask],
  );

  const done = useCallback((confirmed: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    // Kept rendered while it closes: Base UI animates out and returns focus.
    setRequest((prev) => (prev ? { ...prev, open: false } : prev));
    resolve?.(confirmed);
  }, []);

  return {
    run,
    confirm,
    dialog: <ReauthDialog request={request} onDone={done} />,
  };
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}
