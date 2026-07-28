import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import sharp from "sharp";

import { sha256Hex } from "./artifacts";
import {
  assertLc4LaunchBenchmarkArtifact,
  readLc4LaunchBenchmarkPublicJson,
  type Lc4LaunchBenchmarkArtifact,
} from "./lc4-launch-benchmark";

const PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);
const WIDTH = 1600;
const HEIGHT = 1000;

export const LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES = Object.freeze({
  svg: "hacc-lc4-long-call-recall.svg",
  png: "hacc-lc4-long-call-recall.png",
  webp: "hacc-lc4-long-call-recall.webp",
});

type Provider = typeof PROVIDERS[number];
type PublicCell = Lc4LaunchBenchmarkArtifact["cells"][number];

export type Lc4LaunchBenchmarkVisualBuffers = Readonly<{
  svg: string;
  png: Buffer;
  webp: Buffer;
}>;

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function publicLabel(provider: Provider): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "gemini") return "Gemini";
  return "xAI";
}

function cell(
  artifact: Lc4LaunchBenchmarkArtifact,
  provider: Provider,
  arm: "native" | "hacc",
): PublicCell {
  const found = artifact.cells.find((candidate) =>
    candidate.provider === provider && candidate.arm === arm);
  if (!found) throw new Error(`LC4 launch benchmark visual is missing ${provider}:${arm}`);
  return found;
}

function percent(ratePpm: number | null): string {
  if (ratePpm === null) throw new Error("LC4 launch benchmark visual refuses a recall metric without a denominator");
  const value = ratePpm / 10_000;
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function bar(
  cellValue: PublicCell,
  label: "Native API" | "HACC",
  y: number,
  fill: string,
): string {
  const metric = cellValue.metrics.registered_recall_probes;
  if (metric.rate_ppm === null || metric.total <= 0) {
    throw new Error("LC4 launch benchmark visual requires registered recall probes in every cell");
  }
  const width = Math.max(0, Math.min(820, (metric.rate_ppm / 1_000_000) * 820));
  return [
    `<text x="386" y="${y + 29}" text-anchor="end" class="arm">${label}</text>`,
    `<rect x="430" y="${y}" width="820" height="40" rx="7" fill="#F0F1F3"/>`,
    `<rect x="430" y="${y}" width="${width.toFixed(2)}" height="40" rx="7" fill="${fill}"/>`,
    `<text x="1490" y="${y + 29}" text-anchor="end" class="value">${percent(metric.rate_ppm)} <tspan class="count">· ${metric.passed}/${metric.total}</tspan></text>`,
  ].join("\n");
}

function providerGroup(
  artifact: Lc4LaunchBenchmarkArtifact,
  provider: Provider,
  index: number,
): string {
  const native = cell(artifact, provider, "native");
  const hacc = cell(artifact, provider, "hacc");
  if (native.model !== hacc.model) {
    throw new Error(`LC4 launch benchmark visual ${provider} pair has different models`);
  }
  const top = 235 + index * 210;
  const nativeStrict = native.metrics.strict_episode_outcome;
  const haccStrict = hacc.metrics.strict_episode_outcome;
  return [
    `<g aria-label="${xml(publicLabel(provider))}, ${xml(native.model)}">`,
    `<text x="90" y="${top + 18}" class="provider">${xml(publicLabel(provider))}</text>`,
    `<text x="90" y="${top + 49}" class="model">${xml(native.model)}</text>`,
    bar(native, "Native API", top, "#B9BEC5"),
    bar(hacc, "HACC", top + 64, "#4453E2"),
    `<text x="430" y="${top + 145}" class="strict">Strict episode</text>`,
    `<text x="566" y="${top + 145}" class="strict-value">Native API ${nativeStrict.passed}/${nativeStrict.total}</text>`,
    `<text x="690" y="${top + 145}" class="strict-dot">·</text>`,
    `<text x="716" y="${top + 145}" class="strict-value hacc">HACC ${haccStrict.passed}/${haccStrict.total}</text>`,
    `</g>`,
  ].join("\n");
}

export function renderLc4LaunchBenchmarkSvg(
  artifact: Lc4LaunchBenchmarkArtifact,
): string {
  assertLc4LaunchBenchmarkArtifact(artifact);
  const groups = PROVIDERS.map((provider, index) =>
    providerGroup(artifact, provider, index)).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title description">
<title id="title">Long-call recall: Native API versus HACC</title>
<desc id="description">Exact registered recall probe pass rates for OpenAI, Gemini, and xAI, comparing one Native API and one HACC call per provider. Strict episode outcomes are also shown.</desc>
<metadata>HACC LC4 benchmark ${artifact.benchmark_sha256}</metadata>
<rect width="${WIDTH}" height="${HEIGHT}" fill="#FFFFFF"/>
<style>
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #101114; }
  .title { font-size: 54px; font-weight: 650; letter-spacing: -1.6px; }
  .subtitle { font-size: 24px; font-weight: 400; fill: #6B7078; }
  .legend { font-size: 20px; font-weight: 500; fill: #4D5158; }
  .provider { font-size: 29px; font-weight: 650; letter-spacing: -0.3px; }
  .model { font-size: 17px; font-weight: 400; fill: #7A7F87; }
  .arm { font-size: 20px; font-weight: 500; fill: #555A62; }
  .value { font-size: 27px; font-weight: 650; letter-spacing: -0.3px; }
  .count { font-size: 20px; font-weight: 400; fill: #777C84; }
  .strict { font-size: 17px; font-weight: 500; fill: #777C84; }
  .strict-value { font-size: 17px; font-weight: 500; fill: #484C53; }
  .strict-value.hacc { fill: #3947C8; }
  .strict-dot { font-size: 17px; fill: #ADB1B7; }
  .axis { font-size: 15px; fill: #92969D; }
  .caveat { font-size: 17px; fill: #73777E; }
  .footer { font-size: 20px; font-weight: 500; fill: #2B2E33; }
</style>
<text id="heading" x="90" y="94" class="title">Long-call recall</text>
<text x="90" y="137" class="subtitle">Registered recall probes · 1 call per arm</text>
<g aria-label="Legend">
  <rect x="1218" y="72" width="21" height="21" rx="4" fill="#B9BEC5"/>
  <text x="1251" y="90" class="legend">Native API</text>
  <rect x="1392" y="72" width="21" height="21" rx="4" fill="#4453E2"/>
  <text x="1425" y="90" class="legend">HACC</text>
</g>
<g aria-hidden="true">
  <line x1="430" y1="190" x2="430" y2="810" stroke="#E4E6E9" stroke-width="1"/>
  <line x1="840" y1="190" x2="840" y2="810" stroke="#ECEDEF" stroke-width="1"/>
  <line x1="1250" y1="190" x2="1250" y2="810" stroke="#E4E6E9" stroke-width="1"/>
  <text x="430" y="181" text-anchor="middle" class="axis">0%</text>
  <text x="840" y="181" text-anchor="middle" class="axis">50%</text>
  <text x="1250" y="181" text-anchor="middle" class="axis">100%</text>
</g>
${groups}
<line x1="90" y1="866" x2="1510" y2="866" stroke="#E4E6E9" stroke-width="1"/>
<text x="800" y="912" text-anchor="middle" class="caveat">One registered development scenario per provider · descriptive, not an efficacy estimate</text>
<text x="800" y="955" text-anchor="middle" class="footer">360 registered opportunities across 6 calls</text>
</svg>
`;
}

export async function createLc4LaunchBenchmarkVisualBuffers(
  artifact: Lc4LaunchBenchmarkArtifact,
): Promise<Lc4LaunchBenchmarkVisualBuffers> {
  const svg = renderLc4LaunchBenchmarkSvg(artifact);
  const bytes = Buffer.from(svg, "utf8");
  const [png, webp] = await Promise.all([
    sharp(bytes).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
    sharp(bytes).webp({ quality: 94, effort: 6 }).toBuffer(),
  ]);
  return Object.freeze({ svg, png, webp });
}

async function absent(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
    throw new Error("LC4 launch benchmark visual output already exists; overwrite is forbidden");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function publishBuffers(
  outputRoot: string,
  buffers: Lc4LaunchBenchmarkVisualBuffers,
  artifactSha256: string,
): Promise<void> {
  await mkdir(outputRoot, { recursive: true, mode: 0o755 });
  const metadata = await lstat(outputRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("LC4 launch benchmark visual output root must be a real directory");
  }
  const entries = [
    [LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES.svg, Buffer.from(buffers.svg, "utf8")],
    [LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES.png, buffers.png],
    [LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES.webp, buffers.webp],
  ] as const;
  const finals = entries.map(([filename]) => resolve(outputRoot, filename));
  await Promise.all(finals.map(absent));
  const nonce = `${sha256Hex(`${artifactSha256}\n${sha256Hex(buffers.svg)}`)}.${randomUUID()}`;
  const temps = entries.map(([filename]) => resolve(dirname(outputRoot), `.${filename}.${nonce}.tmp`));
  const linked: string[] = [];
  try {
    await Promise.all(entries.map(([, value], index) =>
      writeFile(temps[index]!, value, { flag: "wx", mode: 0o444 })));
    for (let index = 0; index < entries.length; index += 1) {
      await link(temps[index]!, finals[index]!);
      linked.push(finals[index]!);
    }
    await Promise.all(finals.map((path) => chmod(path, 0o444)));
  } catch (error) {
    await Promise.all(linked.map((path) => unlink(path).catch(() => undefined)));
    throw error;
  } finally {
    await Promise.all(temps.map((path) => unlink(path).catch(() => undefined)));
  }
}

export async function publishLc4LaunchBenchmarkVisual(input: Readonly<{
  public_json: string;
  output_root: string;
}>): Promise<Readonly<{
  benchmark_sha256: string;
  files: typeof LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES;
}>> {
  const publicJson = absolute(input.public_json, "LC4 launch benchmark visual public JSON");
  const outputRoot = absolute(input.output_root, "LC4 launch benchmark visual output root");
  const artifact = await readLc4LaunchBenchmarkPublicJson({ public_json: publicJson });
  const buffers = await createLc4LaunchBenchmarkVisualBuffers(artifact);
  await publishBuffers(outputRoot, buffers, artifact.benchmark_sha256);
  return Object.freeze({
    benchmark_sha256: artifact.benchmark_sha256,
    files: LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES,
  });
}
