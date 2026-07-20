// Source-agnostic reconciliation authority derived only from immutable Flow + catalog metadata.

import {
  ActionReconciliationSpecSchema,
  assertTrustedReconciliationCatalog,
  reconciliationSchemaHash,
  type ReconciliationToolDefinition,
} from "./action-reconciliation";
import {
  actionPolicyFor,
  alwaysActionPolicies,
  listStepRefs,
  type AgentFlow,
  type FlowActionPolicy,
} from "./flow";

export type PinnedRecoveryToolDefinition = ReconciliationToolDefinition & Readonly<{
  description?: string;
}>;

function samePolicy(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(ActionReconciliationSpecSchema.parse(left)) ===
      JSON.stringify(ActionReconciliationSpecSchema.parse(right));
  } catch {
    return false;
  }
}

function effectiveDefinition(
  definition: PinnedRecoveryToolDefinition,
  policy: FlowActionPolicy | undefined
): PinnedRecoveryToolDefinition {
  if (policy?.effect && definition.effect && policy.effect !== definition.effect) {
    throw new Error(`flow policy cannot reclassify the pinned effect of ${definition.name}`);
  }
  if (policy?.reconciliation !== undefined && definition.reconciliation &&
      !samePolicy(policy.reconciliation, definition.reconciliation)) {
    throw new Error(`flow policy cannot replace the pinned reconciliation contract of ${definition.name}`);
  }
  return Object.freeze({
    ...definition,
    ...(definition.effect ? {} : policy?.effect ? { effect: policy.effect } : {}),
    ...(definition.reconciliation
      ? {}
      : policy?.reconciliation !== undefined
        ? { reconciliation: ActionReconciliationSpecSchema.parse(policy.reconciliation) }
        : {}),
  });
}

/** Resolves one receipt's exact step-scoped catalog. Live model arguments never participate. */
export function reconciliationCatalogForReceipt(
  flow: AgentFlow,
  stepPath: string,
  definitions: readonly PinnedRecoveryToolDefinition[]
): readonly PinnedRecoveryToolDefinition[] {
  const catalog = definitions.map((definition) => effectiveDefinition(
    definition,
    actionPolicyFor(flow, stepPath, definition.name)
  ));
  // Some isolated/generated sources intentionally publish only an input contract. The action's
  // immutable recovery policy may pin the exact proof-envelope schema for its named query. A
  // source-published schema remains authoritative and cannot be silently replaced.
  for (const action of catalog) {
    if (!action.reconciliation) continue;
    const spec = ActionReconciliationSpecSchema.parse(action.reconciliation);
    if (!spec.queryOutputSchema) continue;
    const index = catalog.findIndex((candidate) => candidate.name === spec.queryTool);
    if (index < 0) continue;
    const query = catalog[index];
    if (query.outputSchema && reconciliationSchemaHash(query.outputSchema, {
      label: `${query.name} source output schema`,
      // Compare the complete portable schema before the closed-catalog pass
      // applies the stricter proof-envelope object-root rule. This preserves
      // the more precise authority-substitution failure for unequal schemas.
      requireObjectRoot: false,
    }) !== reconciliationSchemaHash(spec.queryOutputSchema, {
      label: `${query.name} proof-envelope fallback schema`,
      requireObjectRoot: true,
    })) {
      throw new Error(`reconciliation policy cannot replace the pinned output schema of ${query.name}`);
    }
    if (!query.outputSchema) {
      catalog[index] = Object.freeze({ ...query, outputSchema: spec.queryOutputSchema });
    }
  }
  return catalog;
}

export type ResolvedReconciliationAuthority = Readonly<{
  action: PinnedRecoveryToolDefinition & {
    effect: "write" | "opaque";
    reconciliation: ReturnType<typeof ActionReconciliationSpecSchema.parse>;
  };
  query: PinnedRecoveryToolDefinition & {
    effect: "read";
    outputSchema: Record<string, unknown>;
  };
}>;

export function resolveReconciliationAuthority(
  flow: AgentFlow,
  stepPath: string,
  actionName: string,
  definitions: readonly PinnedRecoveryToolDefinition[]
): ResolvedReconciliationAuthority | null {
  const catalog = reconciliationCatalogForReceipt(flow, stepPath, definitions);
  assertTrustedReconciliationCatalog(catalog);
  const action = catalog.find((definition) => definition.name === actionName);
  if (!action?.reconciliation || action.effect === "read" || !action.effect) return null;
  const spec = ActionReconciliationSpecSchema.parse(action.reconciliation);
  const query = catalog.find((definition) => definition.name === spec.queryTool);
  if (!query?.outputSchema || query.effect !== "read") return null;
  return Object.freeze({
    action: action as ResolvedReconciliationAuthority["action"],
    query: query as ResolvedReconciliationAuthority["query"],
  });
}

/** Admission-time validation for every executable flow policy, including remote/generated tools. */
export function assertPinnedFlowReconciliationAuthority(
  flow: AgentFlow,
  definitions: readonly PinnedRecoveryToolDefinition[]
): void {
  const scopes = [
    { path: "$flow.always", policies: alwaysActionPolicies(flow) },
    ...listStepRefs(flow).map((ref) => ({ path: ref.path, policies: ref.step.action_policies ?? [] })),
  ];
  for (const scope of scopes) {
    for (const policy of scope.policies) {
      if (policy.effect === undefined && policy.reconciliation === undefined) continue;
      const definition = definitions.find((candidate) => candidate.name === policy.tool);
      // Built-in actions have their own source-of-truth effect catalog and cannot gain generic
      // external reconciliation authority through a Flow policy.
      if (!definition) {
        if (policy.reconciliation !== undefined) {
          throw new Error(`reconciliation policy for ${policy.tool} has no pinned external definition`);
        }
        continue;
      }
      const effective = reconciliationCatalogForReceipt(flow, scope.path, definitions);
      if (policy.reconciliation !== undefined) {
        const resolved = resolveReconciliationAuthority(flow, scope.path, policy.tool, definitions);
        if (!resolved) throw new Error(`reconciliation policy for ${policy.tool} is not closed`);
      } else {
        // Even read-only settlement authority cannot contradict a source extension's own effect.
        void effective.find((candidate) => candidate.name === policy.tool);
      }
    }
  }
}
