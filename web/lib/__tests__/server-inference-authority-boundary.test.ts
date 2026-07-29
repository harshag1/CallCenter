import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type ImportedBoundary = Readonly<{
  imported: "createServerInferenceAuthority" | "createServerInferenceRuntime";
  local: string;
}>;

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

function boundaryImports(source: ts.SourceFile): ImportedBoundary[] {
  const imports: ImportedBoundary[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.endsWith("server-inference")
      || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const specifier of statement.importClause.namedBindings.elements) {
      const imported = specifier.propertyName?.text ?? specifier.name.text;
      if (
        imported === "createServerInferenceAuthority"
        || imported === "createServerInferenceRuntime"
      ) {
        imports.push({ imported, local: specifier.name.text });
      }
    }
  }
  return imports;
}

function hasObjectProperty(call: ts.CallExpression, name: string): boolean {
  const argument = call.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return false;
  return argument.properties.some((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && property.name.getText() === name
  );
}

describe("server inference authority architecture", () => {
  it("allows authority creation and raw budgets only at reviewed operation roots", () => {
    const productionRoots = [
      resolve(process.cwd(), "lib"),
      resolve(process.cwd(), "app"),
    ];
    const authorityCreators = new Set<string>();
    const rawBudgetCallers = new Set<string>();

    for (const path of productionRoots.flatMap(productionFiles)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const imported = boundaryImports(source);
      const authorityNames = new Set(
        imported
          .filter(({ imported: name }) => name === "createServerInferenceAuthority")
          .map(({ local }) => local),
      );
      const runtimeNames = new Set(
        imported
          .filter(({ imported: name }) => name === "createServerInferenceRuntime")
          .map(({ local }) => local),
      );
      const file = relative(process.cwd(), path);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (authorityNames.has(node.expression.text)) authorityCreators.add(file);
          if (
            runtimeNames.has(node.expression.text)
            && hasObjectProperty(node, "budget")
          ) {
            rawBudgetCallers.add(file);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect([...authorityCreators].sort()).toEqual([
      "lib/agent/operator-turn-inference-authority.ts",
      "lib/governed-call-worker-executor.ts",
      "lib/tasks.ts",
    ]);
    expect([...rawBudgetCallers].sort()).toEqual([
      "app/api/onboarding/build/route.ts",
      "app/api/onboarding/scrape/route.ts",
      "lib/analysis.ts",
      "lib/onboarding.ts",
    ]);
  });
});
