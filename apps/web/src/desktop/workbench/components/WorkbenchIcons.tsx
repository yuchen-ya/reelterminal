import type { SVGProps } from "react";

/** Dedicated vector icon for Review Tasks (审阅任务): inspection frame with check badge */
export function ReviewTaskIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      <path d="M5 5.5h6" />
      <path d="M5 8.5h2.5" />
      <path d="M8.5 10.2l1.3 1.3 2.4-2.5" />
    </svg>
  );
}

/** Dedicated vector icon for Free Boards (自由画板): infinite canvas artboard with geometric shapes */
export function FreeBoardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="2.2" y="2.2" width="6.2" height="6.2" rx="1.3" />
      <circle cx="11.2" cy="11.2" r="2.8" />
      <path d="M10.8 2.5l2.7 2.7-2.7 2.7-2.7-2.7z" />
      <path d="M3 11.8c1-1.3 2.6-1.3 3.6 0" />
    </svg>
  );
}

/** Dedicated vector icon for the Workspace Directory / New Tab (工作台目录标签页) */
export function WorkspaceDirectoryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="2" y="2" width="5" height="5" rx="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" />
      <path d="M11.5 9.2v4.6M9.2 11.5h4.6" />
    </svg>
  );
}
