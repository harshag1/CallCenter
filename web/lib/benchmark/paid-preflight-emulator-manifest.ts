import { canonicalJson, sha256Hex } from "./artifacts";

export const PAID_PREFLIGHT_EMULATOR_TEST_FILE =
  "lib/benchmark/__tests__/paid-runner.test.ts" as const;

export const PAID_PREFLIGHT_HAPPY_PATH_TEST =
  "orders reserve -> partial -> intent -> client -> opened -> audio -> settlement -> atomic finalize" as const;

export const PAID_PREFLIGHT_TAMPER_TESTS = Object.freeze([
  "rejects a missing Gate 0 packet before credentials, reservation, or provider creation",
  "rejects a tampered Gate 0 packet before credentials, reservation, or provider creation",
  "rejects a stale Gate 0 pricing packet before credentials, reservation, or provider creation",
  "rejects a replacement ledger that reuses the Gate 0 ledger ID before provider creation",
  "rejects a missing or tampered selected pricing proof before provider creation",
  "rejects an execution-plan body mutation with a stale self-hash before spend",
  "rejects a pricing-formula substitution before spend",
  "rejects a provider/model identity substitution before spend",
  "rejects a signer that claims the pinned identity but cannot prove private-key possession before spend",
  "rejects frozen kernel-build substitution before spend",
  "rejects a freeze-lock body mutation before credentials, reservation, or client creation",
  "recomputes the plan-pinned long-horizon PCM authorization before credentials or budget",
  "rejects a forged compiler binding before credentials, reservation, or client creation",
] as const);

export const PAID_PREFLIGHT_REQUIRED_TESTS = Object.freeze([
  PAID_PREFLIGHT_HAPPY_PATH_TEST,
  ...PAID_PREFLIGHT_TAMPER_TESTS,
] as const);

export const PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256 = sha256Hex(
  `hacc/paid-preflight-emulator-manifest/v1\n${canonicalJson({
    test_file: PAID_PREFLIGHT_EMULATOR_TEST_FILE,
    happy_path: PAID_PREFLIGHT_HAPPY_PATH_TEST,
    tamper_tests: PAID_PREFLIGHT_TAMPER_TESTS,
  })}`
);
