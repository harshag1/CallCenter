import { canonicalJson, sha256Hex } from "./artifacts";

const PROVIDER_SESSION_SCHEDULE_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-provider-session-schedule/v2\n";

/** Leaf-module schedule shared by the runner and gateway without an init cycle. */
export const LC4_DEV_PROVIDER_SESSION_SCHEDULE = Object.freeze(
  ([1, 2, 3, 4, 5, 6] as const).map((ordinal) => Object.freeze({
    ordinal,
    opportunity_start: (ordinal - 1) * 10 + 1,
    opportunity_end: ordinal * 10,
    opportunity_count: 10 as const,
    provider_session_rotation_required_after: ordinal < 6,
  })),
);

export const LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256 = sha256Hex(
  `${PROVIDER_SESSION_SCHEDULE_DOMAIN}${canonicalJson(
    LC4_DEV_PROVIDER_SESSION_SCHEDULE,
  )}`,
);
