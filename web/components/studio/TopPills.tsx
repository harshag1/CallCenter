// Author: Harsha Gundala
// TopPills.tsx — studio overlay row: centered org pills (internet access + files) above the canvas.

"use client";

import OrgPills, { type OrgPillsProps } from "./OrgPills";

export default function TopPills(props: Omit<OrgPillsProps, "compact">) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex items-start justify-center gap-2">
      <OrgPills {...props} />
    </div>
  );
}
