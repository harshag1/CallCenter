/**
 * Provider control acknowledgements are a transport boundary, not model work.
 * Keep them bounded, but do not assume every healthy realtime provider returns
 * a manual audio-commit acknowledgement within five seconds. This value is
 * shared by the generic runner, LC4 qualification, Gate D, and both LC4 arms.
 */
export const PROVIDER_CONTROL_OR_COMMIT_ACK_TIMEOUT_MS = 15_000 as const;
