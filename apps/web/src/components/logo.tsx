export function Logo({ size = 28, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <defs>
          <linearGradient id="orbix-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7c83ff" />
            <stop offset="1" stopColor="#38d6f0" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="13" fill="none" stroke="url(#orbix-g)" strokeWidth="2.2" />
        <ellipse cx="16" cy="16" rx="13" ry="5.2" fill="none" stroke="url(#orbix-g)" strokeWidth="1.4" opacity="0.55" transform="rotate(-28 16 16)" />
        <circle cx="16" cy="16" r="3.6" fill="url(#orbix-g)" />
        <circle cx="26.2" cy="10.6" r="2" fill="#38d6f0" />
      </svg>
      {withText && <span className="text-[15px] font-semibold tracking-tight">ORBIX<span className="text-indigo"> AI</span></span>}
    </span>
  );
}
