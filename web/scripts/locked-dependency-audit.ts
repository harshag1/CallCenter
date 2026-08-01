import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SeveritySchema = z.enum(["info", "low", "moderate", "high", "critical"]);

const AdvisorySchema = z
  .object({
    source: z.number().int().positive(),
    name: z.string().min(1),
    dependency: z.string().min(1),
    title: z.string().min(1),
    url: z.string().url(),
    severity: SeveritySchema,
    cwe: z.array(z.string().regex(/^CWE-\d+$/)).min(1),
    cvss: z
      .object({
        score: z.number().min(0).max(10),
        vector_string: z.string().min(1),
      })
      .strict(),
    vulnerable_range: z.string().min(1),
  })
  .strict();

const ViaSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("package"),
      name: z.string().min(1),
    })
    .strict(),
  AdvisorySchema.extend({ kind: z.literal("advisory") }).strict(),
]);

const VulnerabilitySchema = z
  .object({
    name: z.string().min(1),
    severity: SeveritySchema,
    is_direct: z.boolean(),
    vulnerable_range: z.string().min(1),
    via: z.array(ViaSchema).min(1),
    effects: z.array(z.string().min(1)),
    nodes: z.array(z.string().min(1)).min(1),
  })
  .strict();

const ManifestSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("hacc_locked_npm_audit_exceptions"),
    package: z
      .object({
        name: z.string().min(1),
        lockfile_version: z.number().int().positive(),
        node_engine: z.string().min(1),
      })
      .strict(),
    audit_policy: z
      .object({
        production_scope: z.literal("no_advisories"),
        development_scope: z.enum(["no_advisories", "exact_reviewed_graph_only"]),
      })
      .strict(),
    exceptions: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            reason: z.string().min(40).max(1000),
            scope: z.literal("development_only"),
            advisory: AdvisorySchema,
            affected_package: z
              .object({
                name: z.string().min(1),
                vulnerable_range: z.string().min(1),
              })
              .strict(),
            direct_dev_dependency_constraints: z
              .record(z.string().min(1), z.string().min(1))
              .refine((value) => Object.keys(value).length > 0),
            dependency_node_constraints: z
              .array(
                z
                  .object({
                    path: z.string().regex(/^node_modules\//),
                    version: z.string().min(1),
                  })
                  .strict(),
              )
              .min(1),
            expected_vulnerability_graph: z.array(VulnerabilitySchema).min(1),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

type Advisory = z.infer<typeof AdvisorySchema>;
type NormalizedVulnerability = z.infer<typeof VulnerabilitySchema>;

type AuditReport = {
  vulnerabilities?: Record<string, unknown>;
  metadata?: {
    vulnerabilities?: Record<string, unknown>;
  };
};

type Lockfile = {
  name?: string;
  lockfileVersion?: number;
  packages?: Record<
    string,
    {
      version?: string;
      engines?: { node?: string };
      devDependencies?: Record<string, string>;
    }
  >;
};

export type AuditGateInput = {
  manifest: unknown;
  packageJson: unknown;
  lockfile: unknown;
  productionAudit: unknown;
  fullAudit: unknown;
  now: Date;
};

export type AuditGateDecision =
  | {
      pass: true;
      policy: "no_advisories";
      exception_id: null;
      expires_on: null;
      advisory_id: null;
      production_advisory_count: 0;
      development_vulnerability_package_count: 0;
      constrained_dependency_node_count: 0;
    }
  | {
      pass: true;
      exception_id: string;
      expires_on: string;
      advisory_id: number;
      production_advisory_count: 0;
      development_vulnerability_package_count: number;
      constrained_dependency_node_count: number;
    };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(object: Record<string, unknown>, field: string, label: string): string {
  const value = object[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function sortedStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...(value as string[])].sort();
}

function normalizeAdvisory(value: unknown, label: string): Advisory {
  const advisory = assertPlainObject(value, label);
  const cvss = assertPlainObject(advisory.cvss, `${label}.cvss`);
  return AdvisorySchema.parse({
    source: advisory.source,
    name: advisory.name,
    dependency: advisory.dependency,
    title: advisory.title,
    url: advisory.url,
    severity: advisory.severity,
    cwe: sortedStrings(advisory.cwe, `${label}.cwe`),
    cvss: {
      score: cvss.score,
      vector_string: cvss.vectorString,
    },
    vulnerable_range: advisory.range,
  });
}

export function normalizeVulnerabilityGraph(reportValue: unknown): NormalizedVulnerability[] {
  const report = assertPlainObject(reportValue, "audit report") as AuditReport;
  const vulnerabilities = assertPlainObject(
    report.vulnerabilities,
    "audit report.vulnerabilities",
  );

  const reportedGraph = Object.entries(vulnerabilities)
    .map(([key, rawValue]) => {
      const raw = assertPlainObject(rawValue, `vulnerabilities.${key}`);
      const viaRaw = raw.via;
      if (!Array.isArray(viaRaw) || viaRaw.length === 0) {
        throw new Error(`vulnerabilities.${key}.via must be a non-empty array`);
      }
      const via = viaRaw
        .map((entry, index) =>
          typeof entry === "string"
            ? ViaSchema.parse({ kind: "package", name: entry })
            : ViaSchema.parse({
                kind: "advisory",
                ...normalizeAdvisory(entry, `vulnerabilities.${key}.via[${index}]`),
              }),
        )
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));

      return VulnerabilitySchema.parse({
        name: stringField(raw, "name", `vulnerabilities.${key}`),
        severity: raw.severity,
        is_direct: raw.isDirect,
        vulnerable_range: raw.range,
        via,
        effects: sortedStrings(raw.effects, `vulnerabilities.${key}.effects`),
        nodes: sortedStrings(raw.nodes, `vulnerabilities.${key}.nodes`),
      });
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  /*
   * npm derives `effects` as the reverse index of the authoritative package
   * references in `via`. Its audit service currently returns nondeterministic
   * reverse attribution when several vulnerable packages share a physical
   * dependency node: otherwise-identical package/advisory/via/node graphs
   * alternate which sibling receives the reverse edge. Rebuild that redundant
   * index from `via`, but reject every reported effect that the forward graph
   * does not prove. Advisory identity, package entries, ranges, forward edges,
   * and physical nodes remain exact-match inputs.
   */
  const graphByName = new Map(reportedGraph.map((entry) => [entry.name, entry]));
  const derivedEffects = new Map<string, Set<string>>();
  for (const entry of reportedGraph) {
    for (const via of entry.via) {
      if (via.kind !== "package") continue;
      const dependency = graphByName.get(via.name);
      if (!dependency) {
        throw new Error(
          `vulnerabilities.${entry.name}.via references absent package ${via.name}`,
        );
      }
      const effects = derivedEffects.get(via.name) ?? new Set<string>();
      effects.add(entry.name);
      derivedEffects.set(via.name, effects);
    }
  }
  for (const entry of reportedGraph) {
    const provenEffects = derivedEffects.get(entry.name) ?? new Set<string>();
    for (const reportedEffect of entry.effects) {
      if (!provenEffects.has(reportedEffect)) {
        throw new Error(
          `vulnerabilities.${entry.name}.effects contains an edge not proven by via: ${reportedEffect}`,
        );
      }
    }
  }

  return reportedGraph.map((entry) => ({
    ...entry,
    effects: [...(derivedEffects.get(entry.name) ?? [])].sort(),
  }));
}

function parseExpiration(expiresOn: string): number {
  const timestamp = Date.parse(`${expiresOn}T23:59:59.999Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`exception expiry is not a real calendar date: ${expiresOn}`);
  }
  const normalized = new Date(timestamp).toISOString().slice(0, 10);
  if (normalized !== expiresOn) {
    throw new Error(`exception expiry is not a real calendar date: ${expiresOn}`);
  }
  return timestamp;
}

function auditVulnerabilityCount(reportValue: unknown): number {
  const report = assertPlainObject(reportValue, "audit report") as AuditReport;
  return Object.keys(assertPlainObject(report.vulnerabilities, "audit vulnerabilities")).length;
}

function exactMatch(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} changed; the reviewed exception does not apply`);
  }
}

export function evaluateAuditGate(input: AuditGateInput): AuditGateDecision {
  const manifest = ManifestSchema.parse(input.manifest);
  const packageJson = assertPlainObject(input.packageJson, "package.json");
  const lockfile = assertPlainObject(input.lockfile, "package-lock.json") as Lockfile;
  const rootLock = assertPlainObject(lockfile.packages?.[""], "package-lock root");
  const exception = manifest.exceptions[0];

  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("current time is invalid");
  }

  exactMatch(packageJson.name, manifest.package.name, "package name");
  exactMatch(lockfile.name, manifest.package.name, "lockfile package name");
  exactMatch(lockfile.lockfileVersion, manifest.package.lockfile_version, "lockfile version");
  exactMatch(packageJson.engines, { node: manifest.package.node_engine }, "package Node engine");
  exactMatch(rootLock.engines, { node: manifest.package.node_engine }, "lockfile Node engine");

  const productionCount = auditVulnerabilityCount(input.productionAudit);
  if (productionCount !== 0) {
    throw new Error(
      `production dependency audit reported ${productionCount} vulnerable package(s); exceptions are forbidden`,
    );
  }

  const actualGraph = normalizeVulnerabilityGraph(input.fullAudit);
  if (manifest.audit_policy.development_scope === "no_advisories") {
    exactMatch(actualGraph, [], "development vulnerability graph");
    return {
      pass: true,
      policy: "no_advisories",
      exception_id: null,
      expires_on: null,
      advisory_id: null,
      production_advisory_count: 0,
      development_vulnerability_package_count: 0,
      constrained_dependency_node_count: 0,
    };
  }

  if (input.now.getTime() > parseExpiration(exception.expires_on)) {
    throw new Error(`audit exception ${exception.id} expired on ${exception.expires_on}`);
  }
  const packageDevDependencies = assertPlainObject(
    packageJson.devDependencies,
    "package.json devDependencies",
  );
  const lockDevDependencies = assertPlainObject(
    rootLock.devDependencies,
    "package-lock root devDependencies",
  );
  for (const [name, constraint] of Object.entries(
    exception.direct_dev_dependency_constraints,
  )) {
    exactMatch(packageDevDependencies[name], constraint, `dev dependency ${name}`);
    exactMatch(lockDevDependencies[name], constraint, `locked dev dependency constraint ${name}`);
    if (Object.hasOwn(assertPlainObject(packageJson.dependencies ?? {}, "dependencies"), name)) {
      throw new Error(`${name} is no longer development-only`);
    }
  }
  exactMatch(
    actualGraph,
    exception.expected_vulnerability_graph,
    "development vulnerability graph",
  );

  const actualAdvisories = actualGraph
    .flatMap((entry) => entry.via)
    .filter((entry): entry is Advisory & { kind: "advisory" } => entry.kind === "advisory")
    .map((entry) => ({
      source: entry.source,
      name: entry.name,
      dependency: entry.dependency,
      title: entry.title,
      url: entry.url,
      severity: entry.severity,
      cwe: entry.cwe,
      cvss: entry.cvss,
      vulnerable_range: entry.vulnerable_range,
    }));
  exactMatch(actualAdvisories, [exception.advisory], "advisory identity");

  const affected = actualGraph.find((entry) => entry.name === exception.affected_package.name);
  if (!affected) {
    throw new Error(`affected package ${exception.affected_package.name} is absent`);
  }
  exactMatch(
    affected.vulnerable_range,
    exception.affected_package.vulnerable_range,
    "affected package range",
  );

  const constrainedNodes = [...exception.dependency_node_constraints].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const graphNodes = [...new Set(actualGraph.flatMap((entry) => entry.nodes))].sort();
  exactMatch(
    graphNodes,
    constrainedNodes.map((entry) => entry.path),
    "vulnerable dependency node set",
  );
  for (const constraint of constrainedNodes) {
    const lockedNode = lockfile.packages?.[constraint.path];
    if (!lockedNode) {
      throw new Error(`constrained dependency node is absent from lockfile: ${constraint.path}`);
    }
    exactMatch(lockedNode.version, constraint.version, `version at ${constraint.path}`);
  }

  return {
    pass: true,
    exception_id: exception.id,
    expires_on: exception.expires_on,
    advisory_id: exception.advisory.source,
    production_advisory_count: 0,
    development_vulnerability_package_count: actualGraph.length,
    constrained_dependency_node_count: constrainedNodes.length,
  };
}

function runNpmAudit(omitDev: boolean): { report: unknown; exitCode: number } {
  const args = ["audit", "--package-lock-only", "--json"];
  if (omitDev) args.push("--omit=dev");
  const result = spawnSync("npm", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, npm_config_audit_level: "info" },
  });
  if (result.error) {
    throw new Error(`could not execute npm audit: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`npm audit terminated by signal ${result.signal}`);
  }
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `npm audit did not return valid JSON (exit ${result.status ?? "unknown"})`,
    );
  }
  return { report, exitCode: result.status ?? 1 };
}

export function main(): void {
  const webRoot = process.cwd();
  const manifestPath = resolve(webRoot, "../.security/npm-audit-exceptions.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const packageJson = JSON.parse(readFileSync(resolve(webRoot, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(resolve(webRoot, "package-lock.json"), "utf8"));

  const production = runNpmAudit(true);
  if (production.exitCode !== 0) {
    throw new Error(`production npm audit failed with exit code ${production.exitCode}`);
  }
  const full = runNpmAudit(false);
  if (full.exitCode !== 0 && full.exitCode !== 1) {
    throw new Error(
      `complete npm audit returned unexpected exit code ${full.exitCode}; expected 0 or 1`,
    );
  }

  const decision = evaluateAuditGate({
    manifest,
    packageJson,
    lockfile,
    productionAudit: production.report,
    fullAudit: full.report,
    now: new Date(),
  });

  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Locked dependency audit failed: ${message}\n`);
    process.exitCode = 1;
  }
}
