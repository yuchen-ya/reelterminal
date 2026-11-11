import type { JSX } from "react";

import "./boot-loader.css";

/**
 * Branded startup loader: a playhead sweeps in the ReelTerminal mark's
 * timeline tracks, then settles and swells into the terminal bar (the same
 * element), which blinks like a cursor before the loop restarts.
 * Markup mirrors the pre-JS splash in index.html (keep the two in sync).
 */
export function BootLoader({
  message,
  standalone = false,
  className,
}: {
  message?: string;
  /** Use fixed dark colours instead of theme tokens (before the theme loads). */
  standalone?: boolean;
  className?: string;
}): JSX.Element {
  const classes = ["rt-boot", standalone ? "rt-boot--standalone" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} role="status" aria-live="polite" data-testid="boot-loader">
      <div className="rt-boot__stage" aria-hidden="true">
        <svg
          className="rt-boot__mark"
          viewBox="12 9.75 40 40"
          width={64}
          height={64}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect className="rt-boot__track rt-boot__track--a" x="13.75" y="20.625" width="27.125" height="5.6875" rx="2.84375" fill="#34D399" />
          <rect className="rt-boot__track rt-boot__track--b" x="21.25" y="33.1875" width="19.9375" height="5.6875" rx="2.84375" fill="#167A5B" />
          <rect className="rt-boot__cursor" x="45" y="16.875" width="5.375" height="25.8125" rx="2.6875" fill="#A7F3D0" />
        </svg>
      </div>
      <div className="rt-boot__wordmark" aria-hidden="true">
        Reel<span>Terminal</span>
      </div>
      <div className="rt-boot__bar" aria-hidden="true">
        <span />
      </div>
      {message ? (
        <p className="rt-boot__message">{message}</p>
      ) : (
        <span className="rt-boot__sr">ReelTerminal</span>
      )}
    </div>
  );
}
