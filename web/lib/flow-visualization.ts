import type { AgentFlow, FlowStep } from "@/lib/flow";
import { alwaysTools } from "@/lib/flow";
import { inspectFlow } from "@/lib/flow-inspector";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tools(values: readonly string[] | undefined): string {
  if (!values?.length) return "";
  return `<div class="tools" aria-label="Available tools">${values
    .map((tool) => `<code>${escapeHtml(tool)}</code>`)
    .join("")}</div>`;
}

function transitions(step: FlowStep): string {
  if (!step.transitions?.length && !step.on_failure) return "";
  const routes = [
    ...(step.transitions ?? []).map((route) =>
      `<li><span>${escapeHtml(route.label ?? "next")}</span><a href="#step-${escapeHtml(route.to)}"><code>${escapeHtml(route.to)}</code></a></li>`
    ),
    ...(step.on_failure
      ? [`<li><span>failure</span><a href="#step-${escapeHtml(step.on_failure)}"><code>${escapeHtml(step.on_failure)}</code></a></li>`]
      : []),
  ];
  return `<ul class="routes" aria-label="Step routes">${routes.join("")}</ul>`;
}

function renderStep(step: FlowStep, path: string, depth: number): string {
  const stepPath = `${path}.${step.id}`;
  const nested = (step.steps ?? [])
    .map((child) => renderStep(child, stepPath, depth + 1))
    .join("");
  const flags = [
    step.checkpoint ? '<span class="flag">checkpoint</span>' : "",
    step.entry ? '<span class="flag">entry</span>' : "",
  ].join("");
  return [
    `<li class="step" id="step-${escapeHtml(stepPath)}" style="--depth:${depth}">`,
    `<div class="step-head"><span class="step-index">${escapeHtml(stepPath)}</span>${flags}</div>`,
    `<strong>${escapeHtml(step.label)}</strong>`,
    tools(step.tools),
    transitions(step),
    nested ? `<ol class="steps">${nested}</ol>` : "",
    "</li>",
  ].join("");
}

/** A script-free, self-contained Flow v2 topology for local/offline inspection. */
export function renderFlowVisualizationHtml(flow: AgentFlow, sourceLabel: string): string {
  const inspection = inspectFlow(flow);
  const nodeLabels = new Map(flow.nodes.map((node) => [node.id, node.label]));
  const incoming = new Map(flow.nodes.map((node) => [node.id, 0]));
  for (const edge of flow.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  const cards = flow.nodes.map((node) => {
    const outgoing = flow.edges.filter((edge) => edge.from === node.id);
    const routeList = outgoing.length
      ? `<ul class="node-routes" aria-label="Outgoing routes">${outgoing.map((edge) =>
          `<li><span>${escapeHtml(edge.label ?? "next")}</span><b>→</b><a href="#node-${escapeHtml(edge.to)}">${escapeHtml(nodeLabels.get(edge.to) ?? edge.to)}</a></li>`
        ).join("")}</ul>`
      : '<p class="terminal">terminal</p>';
    const stepList = (node.steps ?? [])
      .map((step) => renderStep(step, node.id, 1))
      .join("");
    return [
      `<article class="node" id="node-${escapeHtml(node.id)}">`,
      `<div class="node-head"><div><span class="kind">${escapeHtml(node.kind)}</span><h2>${escapeHtml(node.label)}</h2></div><span class="node-id">${escapeHtml(node.id)}</span></div>`,
      tools(node.tools),
      stepList ? `<ol class="steps root-steps">${stepList}</ol>` : "",
      routeList,
      "</article>",
    ].join("");
  }).join("");

  const permanentTools = alwaysTools(flow);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(sourceLabel)} · HACC flow</title>
  <style>
    :root{color-scheme:light;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#fff}*{box-sizing:border-box}body{margin:0;background-color:#fafafa;background-image:radial-gradient(#ddd 1px,transparent 1px);background-size:18px 18px}main{max-width:1600px;margin:0 auto;padding:44px 36px 64px}header{display:flex;align-items:flex-end;justify-content:space-between;gap:28px;margin-bottom:28px}.eyebrow,.kind,.node-id,.step-index{font-size:11px;letter-spacing:.04em;color:#737373}.eyebrow{text-transform:uppercase;font-weight:700}h1{font-size:28px;letter-spacing:-.04em;margin:7px 0 0}h2{font-size:16px;letter-spacing:-.02em;margin:4px 0 0}.metrics{display:flex;gap:18px;flex-wrap:wrap}.metric{min-width:72px}.metric b{display:block;font-size:18px}.metric span{font-size:11px;color:#737373}.always{display:flex;align-items:center;gap:10px;margin:0 0 22px;font-size:12px;color:#525252}.canvas{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start;gap:18px}.node{min-width:0;padding:18px;border:1px solid #dedede;border-radius:10px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.03)}.node-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:1px solid #eee}.kind{text-transform:uppercase;font-weight:700}.node-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.steps{list-style:none;margin:0;padding:0}.root-steps{padding-top:14px}.step{margin-left:calc((var(--depth) - 1) * 13px);padding:11px 0 11px 13px;border-left:1px solid #ddd;scroll-margin:18px}.step:target,.node:target{outline:2px solid #171717;outline-offset:3px}.step+.step{border-top:1px solid #f0f0f0}.step-head{display:flex;align-items:center;gap:7px;margin-bottom:4px}.step strong{font-size:13px}.step-index{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.flag{padding:2px 5px;border:1px solid #d4d4d4;border-radius:999px;font-size:9px;color:#525252}.tools{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.tools code{padding:3px 6px;border:1px solid #e5e5e5;border-radius:5px;background:#fafafa;color:#404040;font-size:10px;overflow-wrap:anywhere}.routes,.node-routes{list-style:none;padding:0;margin:9px 0 0}.routes li,.node-routes li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;font-size:10px;color:#737373}.routes code{font-size:9px;color:#525252;overflow-wrap:anywhere}a{color:#262626;text-decoration:none}a:hover,a:focus-visible{text-decoration:underline}.node-routes{margin-top:15px;padding-top:10px;border-top:1px solid #eee}.node-routes li a{text-align:right}.terminal{margin:15px 0 0;padding-top:10px;border-top:1px solid #eee;font-size:10px;color:#a3a3a3}.note{margin-top:20px;font-size:11px;color:#737373}@media(max-width:680px){main{padding:28px 18px}header{align-items:flex-start;flex-direction:column}.canvas{grid-template-columns:1fr}}@media print{body{background:#fff}main{max-width:none;padding:18px}.node{break-inside:avoid;box-shadow:none}}
  </style>
</head>
<body><main>
  <header><div><div class="eyebrow">Harsha's Amazing Call Center</div><h1>${escapeHtml(sourceLabel)}</h1></div><div class="metrics" aria-label="Flow summary"><div class="metric"><b>${inspection.nodeCount}</b><span>nodes</span></div><div class="metric"><b>${inspection.stepCount}</b><span>steps</span></div><div class="metric"><b>${inspection.maxStepDepth}</b><span>depth</span></div><div class="metric"><b>${inspection.checkpointCount}</b><span>checkpoints</span></div></div></header>
  <div class="always"><span>Always available</span>${tools(permanentTools) || "<span>none</span>"}</div>
  <section class="canvas" aria-label="Flow topology">${cards}</section>
  <p class="note">Offline structural view · no provider, database, or application connection.</p>
</main></body></html>`;
}
