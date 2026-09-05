/** ReelTerminal brand mark shared with the main app. */
export function Logo({ className = "", size }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="192 156 640 640"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      width={size}
      height={size}
    >
      <rect x="220" y="330" width="434" height="91" rx="45.5" fill="#34D399" />
      <rect x="340" y="531" width="319" height="91" rx="45.5" fill="#167A5B" />
      <rect x="720" y="270" width="86" height="413" rx="43" fill="#A7F3D0" />
    </svg>
  );
}
