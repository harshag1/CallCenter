import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateAuditGate,
  type AuditGateInput,
} from "../../scripts/locked-dependency-audit";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const manifest = JSON.parse(
  readFileSync(`${repositoryRoot}.security/npm-audit-exceptions.json`, "utf8"),
);
const packageJson = JSON.parse(readFileSync(`${webRoot}package.json`, "utf8"));
const lockfile = JSON.parse(readFileSync(`${webRoot}package-lock.json`, "utf8"));

type AuditAdvisory = {
  source: number;
  name: string;
  dependency: string;
  title: string;
  url: string;
  severity: string;
  cwe: string[];
  cvss: { score: number; vectorString: string };
  range: string;
};

type AuditVulnerability = {
  name: string;
  severity: string;
  isDirect: boolean;
  range: string;
  via: Array<string | AuditAdvisory>;
  effects: string[];
  nodes: string[];
};

type AuditFixture = {
  auditReportVersion: number;
  vulnerabilities: Record<string, AuditVulnerability>;
};

type ReviewedGraphEntry = {
  name: string;
  severity: string;
  is_direct: boolean;
  vulnerable_range: string;
  via: Array<
    | { kind: "package"; name: string }
    | {
        kind: "advisory";
        source: number;
        name: string;
        dependency: string;
        title: string;
        url: string;
        severity: string;
        cwe: string[];
        cvss: { score: number; vector_string: string };
        vulnerable_range: string;
      }
  >;
  effects: string[];
  nodes: string[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function npmAuditFromReviewedGraph(): AuditFixture {
  const graph = manifest.exceptions[0].expected_vulnerability_graph as ReviewedGraphEntry[];
  const report: AuditFixture = {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      graph.map((entry) => [
        entry.name,
        {
          name: entry.name,
          severity: entry.severity,
          isDirect: entry.is_direct,
          range: entry.vulnerable_range,
          via: entry.via.map((via) => {
            if (via.kind === "package") return via.name;
            return {
              source: via.source,
              name: via.name,
              dependency: via.dependency,
              title: via.title,
              url: via.url,
              severity: via.severity,
              cwe: [...via.cwe],
              cvss: {
                score: via.cvss.score,
                vectorString: via.cvss.vector_string,
              },
              range: via.vulnerable_range,
            };
          }),
          effects: [...entry.effects],
          nodes: [...entry.nodes],
        },
      ]),
    ),
  };
  // One of the two reverse-effect variants observed from repeated npm audits.
  report.vulnerabilities["eslint-plugin-react"].effects = [];
  return report;
}

function fullReport(input: AuditGateInput): AuditFixture {
  return input.fullAudit as AuditFixture;
}

function leafAdvisory(report: AuditFixture): AuditAdvisory {
  const via = report.vulnerabilities["brace-expansion"].via[0];
  if (typeof via === "string") throw new Error("fixture leaf advisory is malformed");
  return via;
}

function validInput(): AuditGateInput {
  return {
    manifest: clone(manifest),
    packageJson: clone(packageJson),
    lockfile: clone(lockfile),
    productionAudit: { auditReportVersion: 2, vulnerabilities: {} },
    fullAudit: npmAuditFromReviewedGraph(),
    now: new Date("2026-07-28T12:00:00.000Z"),
  };
}

function expectRejected(input: AuditGateInput, message: RegExp): void {
  expect(() => evaluateAuditGate(input)).toThrow(message);
}

describe("locked dependency audit exception gate", () => {
  it("accepts only the exact reviewed development graph with a clean production graph", () => {
    expect(evaluateAuditGate(validInput())).toEqual({
      pass: true,
      exception_id: "eslint-brace-expansion-ghsa-mh99-v99m-4gvg",
      expires_on: "2026-08-15",
      advisory_id: 1124334,
      production_advisory_count: 0,
      development_vulnerability_package_count: 9,
      constrained_dependency_node_count: 15,
    });
  });

  it("accepts semantically equivalent npm reverse-effect attribution", () => {
    const input = validInput();
    const report = fullReport(input);
    report.vulnerabilities["eslint-plugin-import"].effects = [];
    report.vulnerabilities["eslint-plugin-react"].effects = ["eslint-config-next"];

    expect(evaluateAuditGate(input)).toMatchObject({
      pass: true,
      development_vulnerability_package_count: 9,
      constrained_dependency_node_count: 15,
    });
  });

  it("fails closed after the exception expires", () => {
    const input = validInput();
    input.now = new Date("2026-08-16T00:00:00.000Z");
    expectRejected(input, /expired on 2026-08-15/);
  });

  it("rejects every production advisory, even one below npm's old high threshold", () => {
    const input = validInput();
    input.productionAudit = {
      vulnerabilities: {
        runtime: {
          name: "runtime",
          severity: "low",
          isDirect: true,
          range: "*",
          via: ["runtime-leaf"],
          effects: [],
          nodes: ["node_modules/runtime"],
        },
      },
    };
    expectRejected(input, /production dependency audit reported 1 vulnerable package/);
  });

  it("rejects a malformed production report instead of treating it as clean", () => {
    const input = validInput();
    input.productionAudit = {};
    expectRejected(input, /audit vulnerabilities must be an object/);
  });
});

describe("locked dependency audit mutation resistance", () => {
  const graphMutations: Array<[string, (report: AuditFixture) => void]> = [
    ["advisory source", (report) => {
      leafAdvisory(report).source += 1;
    }],
    ["advisory title", (report) => {
      leafAdvisory(report).title += "!";
    }],
    ["advisory severity", (report) => {
      leafAdvisory(report).severity = "critical";
    }],
    ["advisory range", (report) => {
      leafAdvisory(report).range = "<=5.0.8";
    }],
    ["wrapper package range", (report) => {
      report.vulnerabilities.minimatch.range = "<=10.0.3";
    }],
    ["dependency edge", (report) => {
      report.vulnerabilities.eslint.via.pop();
    }],
    ["affected node path", (report) => {
      report.vulnerabilities.minimatch.nodes.pop();
    }],
  ];

  it.each(graphMutations)("rejects a changed %s", (_label, mutate) => {
    const input = validInput();
    mutate(fullReport(input));
    expectRejected(input, /development vulnerability graph changed|edge not proven by via/);
  });

  it("rejects a reverse effect that is not proven by the forward via graph", () => {
    const input = validInput();
    fullReport(input).vulnerabilities["eslint-plugin-import"].effects.push("eslint");
    expectRejected(input, /effects contains an edge not proven by via: eslint/);
  });

  it("rejects a forward edge to an absent vulnerability package", () => {
    const input = validInput();
    fullReport(input).vulnerabilities["eslint-config-next"].via.push("missing-package");
    expectRejected(input, /via references absent package missing-package/);
  });

  it("rejects a newly reported development vulnerability", () => {
    const input = validInput();
    fullReport(input).vulnerabilities["new-dev-advisory"] = {
      name: "new-dev-advisory",
      severity: "high",
      isDirect: false,
      range: "*",
      via: ["some-package"],
      effects: [],
      nodes: ["node_modules/new-dev-advisory"],
    };
    expectRejected(input, /via references absent package some-package/);
  });

  it("rejects a clean full audit until the now-stale exception is removed", () => {
    const input = validInput();
    input.fullAudit = { vulnerabilities: {} };
    expectRejected(input, /development vulnerability graph changed/);
  });

  it("rejects a lockfile node version change", () => {
    const input = validInput();
    const mutableLock = input.lockfile as {
      packages: Record<string, { version: string }>;
    };
    mutableLock.packages["node_modules/eslint/node_modules/minimatch"].version = "3.1.6";
    expectRejected(input, /version at node_modules\/eslint\/node_modules\/minimatch changed/);
  });

  it("rejects promotion of an excepted tool into production dependencies", () => {
    const input = validInput();
    const mutablePackage = input.packageJson as {
      dependencies: Record<string, string>;
    };
    mutablePackage.dependencies.eslint = "^9";
    expectRejected(input, /eslint is no longer development-only/);
  });

  it("rejects manifest schema drift and additional exceptions", () => {
    const input = validInput();
    const mutableManifest = input.manifest as { exceptions: unknown[] };
    mutableManifest.exceptions.push(clone(mutableManifest.exceptions[0]));
    expectRejected(input, /expected array to have <=1 items|Too big/);
  });
});
