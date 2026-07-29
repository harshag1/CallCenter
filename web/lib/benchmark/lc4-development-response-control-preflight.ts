import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import type { Lc4DevMunicipalControlPlane } from "./lc4-development-control-plane";
import type { Lc4DevLiveEpisodePlan } from "./lc4-development-live-runner";
import {
  appendLc4DevNativeGatewayContract,
  renderLc4DevHaccResponsePlan,
} from "./lc4-development-gateway-bridge";
import {
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
} from "./lc4-public-development-corpus";
import type { LiveStsProvider } from "./live-sts-development-experiment";

const REPORT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-response-control-preflight/v1\n";

/**
 * Gemini's normalized client has a 4 KiB dynamic-control ceiling. The other
 * normalized clients do not currently expose a smaller local ceiling, so LC4
 * applies its own conservative 16 KiB fail-before-paid ceiling to them.
 */
export const LC4_DEV_HACC_RESPONSE_CONTROL_MAX_BYTES = Object.freeze({
  openai: 16 * 1024,
  gemini: 4 * 1024,
  xai: 16 * 1024,
} satisfies Readonly<Record<LiveStsProvider, number>>);

/**
 * Native gets a small, byte-stable continuation plus the common gateway
 * contract. It must never need a raised provider limit to carry host-derived
 * state, Flow structure, or evaluator criteria.
 */
export const LC4_DEV_NATIVE_RESPONSE_CONTROL_MAX_BYTES = 4 * 1024;

export function lc4DevResponseControlMaximumBytes(
  provider: LiveStsProvider,
  arm: "native" | "hacc",
): number {
  return arm === "native"
    ? LC4_DEV_NATIVE_RESPONSE_CONTROL_MAX_BYTES
    : LC4_DEV_HACC_RESPONSE_CONTROL_MAX_BYTES[provider];
}

export const LC4_DEV_RESPONSE_CONTROL_PREFLIGHT_STRATEGIES = Object.freeze([
  "no_gateway_dispatch",
  "drain_all_registered_gateway_dispatches",
] as const);

export type Lc4DevResponseControlPreflightStrategy =
  (typeof LC4_DEV_RESPONSE_CONTROL_PREFLIGHT_STRATEGIES)[number];

export type Lc4DevResponseControlPreflightCell = Readonly<{
  provider: LiveStsProvider;
  arm: "native" | "hacc";
  strategy: Lc4DevResponseControlPreflightStrategy;
  controls_checked: 60;
  maximum_actual_bytes: number;
  maximum_opportunity_id: string;
  maximum_allowed_bytes: number;
}>;

export type Lc4DevResponseControlPreflightReport = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-DEV-v1";
  control_manifest_sha256: string;
  corpus_sha256: string;
  strategy_count: 2;
  episode_count: 6;
  controls_checked: 720;
  cells: readonly Lc4DevResponseControlPreflightCell[];
  report_sha256: string;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function responseControlText(
  receipt: Awaited<ReturnType<Lc4DevMunicipalControlPlane["next"]>>,
): string {
  return receipt.response_control.kind === "hacc_response_plan"
    ? renderLc4DevHaccResponsePlan(receipt.response_control.plan)
    : appendLc4DevNativeGatewayContract(receipt.response_control.instructions);
}

export function assertLc4DevResponseControlFits(input: Readonly<{
  provider: LiveStsProvider;
  arm: "native" | "hacc";
  opportunity_id: string;
  strategy: Lc4DevResponseControlPreflightStrategy;
  rendered_control: string;
}>): number {
  const actualBytes = Buffer.byteLength(input.rendered_control, "utf8");
  const maximumAllowedBytes = lc4DevResponseControlMaximumBytes(
    input.provider,
    input.arm,
  );
  if (actualBytes > maximumAllowedBytes) {
    throw new Error(
      `LC4-DEV response control exceeds provider client limit: `
      + `provider=${input.provider} arm=${input.arm} `
      + `opportunity=${input.opportunity_id} actual_bytes=${actualBytes} `
      + `max_bytes=${maximumAllowedBytes} strategy=${input.strategy}`,
    );
  }
  return actualBytes;
}

async function drainRegisteredGatewayDispatches(input: Readonly<{
  control: Lc4DevMunicipalControlPlane;
  episode: Lc4DevLiveEpisodePlan;
  opportunity_id: string;
  opportunity_index: number;
}>): Promise<void> {
  let sequence = 0;
  for (;;) {
    const pending = input.control.development_pending_calls(input.episode.episode_id);
    if (pending.length === 0) return;
    if (sequence + pending.length > 64) {
      throw new Error(
        `LC4-DEV response control preflight gateway drain did not converge: `
        + `provider=${input.episode.provider} arm=${input.episode.arm} `
        + `opportunity=${input.opportunity_id}`,
      );
    }
    for (const call of pending) {
      sequence += 1;
      const requestLabel = [
        "lc4-response-control-preflight",
        input.episode.provider,
        input.episode.arm,
        input.opportunity_id,
        sequence,
      ].join(":");
      const result = await input.control.gateway_executor.execute({
        bridge_version: "lc4-dev-gateway-bridge-v2",
        episode_id: input.episode.episode_id,
        opportunity_id: input.opportunity_id,
        opportunity_index: input.opportunity_index,
        provider: input.episode.provider,
        arm: input.episode.arm,
        provider_call_id: `${requestLabel}:call`,
        provider_response_id: `${requestLabel}:response`,
        semantic_intent: call.semantic_intent,
        target_tool: call.target_tool,
        target_arguments: call.target_arguments,
        request_sha256: sha256Hex(`${requestLabel}:request`),
        provider_provenance_sha256: sha256Hex(`${requestLabel}:provenance`),
      });
      if (result.disposition === "rejected") {
        throw new Error(
          `LC4-DEV response control preflight registered gateway dispatch was rejected: `
          + `provider=${input.episode.provider} arm=${input.episode.arm} `
          + `opportunity=${input.opportunity_id} tool=${call.target_tool}`,
        );
      }
    }
  }
}

/**
 * Generates both deterministic response-control horizons before any realtime
 * client is constructed:
 *
 * - no provider-owned gateway calls succeed; and
 * - every registered gateway call succeeds at its first admissible turn.
 *
 * These are the two monotone size extremes for the frozen LC4 control plane:
 * accumulated unresolved authority versus maximally advanced durable state.
 * The realtime clients retain their own per-turn checks as defense in depth.
 */
export async function inspectLc4DevResponseControlSizes(input: Readonly<{
  episodes: readonly Lc4DevLiveEpisodePlan[];
  create_control(): Lc4DevMunicipalControlPlane;
  corpus?: Lc4PublicDevelopmentCorpus;
}>): Promise<Lc4DevResponseControlPreflightReport> {
  const corpus = input.corpus ?? createLc4PublicDevelopmentCorpus();
  if (input.episodes.length !== 6) {
    throw new Error("LC4-DEV response control preflight requires exactly six episodes");
  }
  const identities = new Set(
    input.episodes.map((episode) => `${episode.provider}:${episode.arm}`),
  );
  if (
    identities.size !== 6
    || !["openai", "gemini", "xai"].every(
      (provider) => identities.has(`${provider}:native`) && identities.has(`${provider}:hacc`),
    )
  ) {
    throw new Error(
      "LC4-DEV response control preflight requires one Native and HACC episode per provider",
    );
  }

  const cells: Lc4DevResponseControlPreflightCell[] = [];
  let controlManifestSha256: string | null = null;
  let controlsChecked = 0;
  for (const strategy of LC4_DEV_RESPONSE_CONTROL_PREFLIGHT_STRATEGIES) {
    const control = input.create_control();
    if (
      controlManifestSha256 !== null
      && control.manifest_sha256 !== controlManifestSha256
    ) {
      throw new Error(
        "LC4-DEV response control preflight control manifest is nondeterministic",
      );
    }
    controlManifestSha256 = control.manifest_sha256;
    for (const episode of input.episodes) {
      let previousExchangeSha256: string | null = null;
      let maximumActualBytes = 0;
      let maximumOpportunityId = corpus.opportunities[0]!.id;
      const maximumAllowedBytes = lc4DevResponseControlMaximumBytes(
        episode.provider,
        episode.arm,
      );
      for (const opportunity of corpus.opportunities) {
        const receipt = await control.next({
          episode,
          opportunity,
          previous_exchange_sha256: previousExchangeSha256,
        });
        const expectedKind =
          episode.arm === "hacc" ? "hacc_response_plan" : "native_context";
        if (receipt.response_control.kind !== expectedKind) {
          throw new Error(
            `LC4-DEV response control preflight arm mismatch: `
            + `provider=${episode.provider} arm=${episode.arm} `
            + `opportunity=${opportunity.id} actual_kind=${receipt.response_control.kind} `
            + `expected_kind=${expectedKind}`,
          );
        }
        const actualBytes = assertLc4DevResponseControlFits({
          provider: episode.provider,
          arm: episode.arm,
          opportunity_id: opportunity.id,
          strategy,
          rendered_control: responseControlText(receipt),
        });
        controlsChecked += 1;
        if (actualBytes > maximumActualBytes) {
          maximumActualBytes = actualBytes;
          maximumOpportunityId = opportunity.id;
        }
        if (strategy === "drain_all_registered_gateway_dispatches") {
          await drainRegisteredGatewayDispatches({
            control,
            episode,
            opportunity_id: opportunity.id,
            opportunity_index: opportunity.index,
          });
        }
        previousExchangeSha256 = sha256Hex(
          `lc4-response-control-preflight:${strategy}:${episode.episode_id}:${opportunity.id}`,
        );
      }
      cells.push(
        freeze({
          provider: episode.provider,
          arm: episode.arm,
          strategy,
          controls_checked: 60 as const,
          maximum_actual_bytes: maximumActualBytes,
          maximum_opportunity_id: maximumOpportunityId,
          maximum_allowed_bytes: maximumAllowedBytes,
        }),
      );
    }
  }
  if (controlsChecked !== 720 || controlManifestSha256 === null) {
    throw new Error(
      `LC4-DEV response control preflight horizon is incomplete: `
      + `actual=${controlsChecked} expected=720`,
    );
  }
  const body = freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    control_manifest_sha256: controlManifestSha256,
    corpus_sha256: corpus.artifact_sha256,
    strategy_count: 2 as const,
    episode_count: 6 as const,
    controls_checked: 720 as const,
    cells: freeze(cells),
  });
  return freeze({
    ...body,
    report_sha256: sha256Hex(`${REPORT_DOMAIN}${canonicalJson(body)}`),
  });
}
