import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

export const MAIN_CONTENT_ID = "main-content";

// The first stop of Tab: without it a keyboard user walks the whole sidebar
// before the page (TB-226). Hidden until it has focus.
export function SkipToContent() {
  const { t } = useTranslation();

  // Move focus by hand: a bare hash link would change the address and leave
  // focus where it was in some browsers.
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.getElementById(MAIN_CONTENT_ID);
    if (!main) return;
    event.preventDefault();
    main.focus();
  };

  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={handleClick}
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:font-medium focus:text-sm focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {t("navigation:sidebar.skipToContent")}
    </a>
  );
}
