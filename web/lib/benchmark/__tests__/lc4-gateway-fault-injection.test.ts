import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertLc4GatewayFaultInjectionArtifact,
  renderLc4GatewayFaultInjectionMarkdown,
  runLc4GatewayFaultInjectionBenchmark,
  type Lc4GatewayFaultInjectionArtifact,
} from "../lc4-gateway-fault-injection";

const evidenceRoot = join(
  process.cwd(),
  "..",
  "benchmarks",
  "voice-long-horizon",
  "evidence",
);

describe("LC4 gateway ToolAttempt firewall fault injection", () => {
  it("contains semantic and repair faults and fails closed on security faults across all providers", async () => {
    const artifact = await runLc4GatewayFaultInjectionBenchmark();

    expect(artifact).toMatchObject({
      provider_free: true,
      network_calls_authorized: false,
      provider_api_calls: 0,
      efficacy_claim_eligible: false,
      summary: {
        scenarios: 33,
        control_successes: 3,
        injected_faults: 30,
        contained_recoverable_faults: 15,
        rejected_tool_attempts: 21,
        fatal_security_faults: 15,
        authorized_executor_calls: 3,
        unauthorized_executor_calls: 0,
        expected_authority_projections: 3,
        false_authority_projections: 0,
        provider_result_batches: 18,
        continuation_requests: 18,
        all_scenarios_passed: true,
      },
    });
    expect(new Set(artifact.scenarios.map((row) => row.provider))).toEqual(
      new Set(["openai", "gemini", "xai"]),
    );
    expect(
      artifact.scenarios.filter((row) => row.phase === "repair"),
    ).toHaveLength(3);
    expect(
      artifact.scenarios.filter(
        (row) => row.fault === "atomic_mixed_batch",
      ),
    ).toHaveLength(3);
    expect(
      artifact.scenarios.filter(
        (row) => row.class !== "control" && row.executor_calls !== 0,
      ),
    ).toEqual([]);
    expect(
      artifact.scenarios.filter(
        (row) => row.class !== "control" && row.authority_projections !== 0,
      ),
    ).toEqual([]);
  });

  it("is byte-deterministic and rejects any rewritten scenario evidence", async () => {
    const first = await runLc4GatewayFaultInjectionBenchmark();
    const second = await runLc4GatewayFaultInjectionBenchmark();
    expect(second).toEqual(first);

    const copy = structuredClone(first) as Lc4GatewayFaultInjectionArtifact;
    const rows = copy.scenarios as unknown as Array<{
      unauthorized_executor_calls: number;
    }>;
    rows[1]!.unauthorized_executor_calls = 1;
    expect(() => assertLc4GatewayFaultInjectionArtifact(copy)).toThrow();
  });

  it("keeps checked-in JSON and Markdown bound to the verified artifact", async () => {
    const artifact = await runLc4GatewayFaultInjectionBenchmark();
    const [json, markdown] = await Promise.all([
      readFile(
        join(evidenceRoot, "HACC_LC4_GATEWAY_FAULT_INJECTION.json"),
        "utf8",
      ),
      readFile(
        join(evidenceRoot, "HACC_LC4_GATEWAY_FAULT_INJECTION.md"),
        "utf8",
      ),
    ]);
    expect(JSON.parse(json)).toEqual(artifact);
    expect(markdown).toBe(
      renderLc4GatewayFaultInjectionMarkdown(artifact),
    );
    expect(markdown).toContain(
      "Mechanism evidence only. This is not provider efficacy",
    );
  });
});
