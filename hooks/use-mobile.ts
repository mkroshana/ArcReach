import * as React from "react"

// Below Tailwind's md breakpoint (48rem, 768px), in rem as Tailwind writes it
// so this is true at exactly the widths where md: classes do not apply.
const MOBILE_QUERY = "(width < 48rem)"

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/** Whether the window is narrower than md. False on the server and while hydrating, then the real width. */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  )
}
