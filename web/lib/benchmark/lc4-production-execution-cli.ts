import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LC4_EXECUTION_TIMEOUTS,
  LC4_PAID_PROVIDER_EXECUTION_BUILD_FROZEN,
  createLc4FilesystemReservationVerification,
  createLc4ExecutionPreflight,
  executeLc4AuthorizedProductionEpisode,
  type Lc4ExecutionAuthorizationArtifact,
} from "./lc4-production-execution";
import type { Lc4FrozenProductionRealtimeAdapter } from "./lc4-production-provider-adapter";
import type { Lc4EpisodeManifest } from "./lc4-production-runner-foundation";

const SHA256 = /^[a-f0-9]{64}$/;

type CliIo = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}>;

type QualificationBinding = Readonly<{
  plan_sha256: string;
  source_commit: string;
  configuration_matrix_sha256: string;
  credential_set_sha256: string;
}>;

type TrustRoot = Readonly<{
  schema_version: 1;
  authority_public_key_fingerprint_sha256: string;
}>;

function parseFlags(args: readonly string[]): Readonly<Record<string, string>> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error("LC4 execution CLI requires --flag value pairs");
    if (flags[flag] !== undefined) throw new Error(`LC4 execution CLI flag is duplicated: ${flag}`);
    flags[flag] = value;
  }
  return Object.freeze(flags);
}

function exactFlagSet(flags: Readonly<Record<string, string>>, expected: readonly string[]): void {
  const actual = Object.keys(flags).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`LC4 execution CLI requires exactly: ${wanted.join(", ")}`);
  }
}

async function readJson<T>(path: string, label: string): Promise<T> {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  if (bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) throw new Error(`${label} has an invalid size`);
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

const validationOnlyAdapter: Lc4FrozenProductionRealtimeAdapter = Object.freeze({
  kind: "production-realtime-frozen" as const,
  async openSegment() {
    throw new Error("LC4 validation-only CLI adapter cannot open a provider connection");
  },
});

export async function runLc4ProductionExecutionCli(
  args: readonly string[],
  io: CliIo = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
    now: () => new Date(),
  },
): Promise<number> {
  try {
    const command = args[0];
    if (command === "status") {
      if (args.length !== 1) throw new Error("LC4 execution status accepts no flags");
      io.stdout(JSON.stringify({
        protocol_id: "HACC-LC4-v1",
        paid_provider_execution_build_frozen: LC4_PAID_PROVIDER_EXECUTION_BUILD_FROZEN,
        environment_override_supported: false,
        authorization_mechanism: "pinned-ed25519-artifact",
        timeout_policy: LC4_EXECUTION_TIMEOUTS,
      }));
      return 0;
    }
    if (command !== "preflight" && command !== "run") {
      throw new Error("usage: lc4-production-execution <status|preflight|run>");
    }
    const flags = parseFlags(args.slice(1));
    exactFlagSet(flags, ["--manifest", "--authorization", "--trust-root", "--qualification-binding", "--budget-ledger"]);
    const [manifest, authorization, trustRoot, qualificationBinding] = await Promise.all([
      readJson<Lc4EpisodeManifest>(flags["--manifest"], "LC4 episode manifest"),
      readJson<Lc4ExecutionAuthorizationArtifact>(flags["--authorization"], "LC4 execution authorization"),
      readJson<TrustRoot>(flags["--trust-root"], "LC4 authority trust root"),
      readJson<QualificationBinding>(flags["--qualification-binding"], "LC4 qualification binding"),
    ]);
    if (trustRoot.schema_version !== 1 || !SHA256.test(trustRoot.authority_public_key_fingerprint_sha256)) {
      throw new Error("LC4 authority trust root is invalid");
    }
    const now = io.now();
    const reservationVerification = await createLc4FilesystemReservationVerification({
      ledgerPath: flags["--budget-ledger"],
      manifest,
      checkedAt: now,
    });
    const preflight = createLc4ExecutionPreflight({
      manifest,
      authorization,
      expected_authority_public_key_fingerprint_sha256: trustRoot.authority_public_key_fingerprint_sha256,
      qualification_binding: qualificationBinding,
      adapter: validationOnlyAdapter,
      reservation_verification: reservationVerification,
      now,
    });
    io.stdout(JSON.stringify(preflight));
    if (command === "run") {
      await executeLc4AuthorizedProductionEpisode({ preflight, adapter: validationOnlyAdapter });
    }
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "LC4 execution CLI failed");
    return 1;
  }
}
