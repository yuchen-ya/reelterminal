import type { JSX } from "react";
import { useTranslation } from "react-i18next";

export function ReelTerminalMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const dimension = Number.isFinite(size) && size > 0 ? size : 24;

  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="12 9.75 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={t("desktop.appName")}
    >
      <rect x="13.75" y="20.625" width="27.125" height="5.6875" rx="2.84375" fill="#34D399" />
      <rect x="21.25" y="33.1875" width="19.9375" height="5.6875" rx="2.84375" fill="#167A5B" />
      <rect x="45" y="16.875" width="5.375" height="25.8125" rx="2.6875" fill="#A7F3D0" />
    </svg>
  );
}
