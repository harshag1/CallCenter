// Author: Harsha Gundala
// ThreeFlow.tsx — shared Three.js flow renderer: orthographic 2D scene, DOM cards via drei Html,
// sampled-bezier edges, shader dot grid, drag-to-pan camera with fit-to-bounds.

"use client";

import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import type { Line2, LineMaterial } from "three-stdlib";
import {
  Phone, PhoneForwarded, PhoneOutgoing, LifeBuoy, Package, CreditCard, Calendar, User, Settings,
  ShoppingCart, Truck, RotateCcw, Shield, Zap, BookOpen, Wrench, Gift, Pencil, Check,
  Database, FlaskConical,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Card components — visual twins of the studio React Flow nodes       */
/* (Handles dropped: edges attach by coordinate in the Three scene).   */
/* ------------------------------------------------------------------ */

export type CardData = Record<string, unknown>;

const ICONS: Record<string, typeof LifeBuoy> = {
  "life-buoy": LifeBuoy, package: Package, "credit-card": CreditCard, calendar: Calendar,
  user: User, settings: Settings, "shopping-cart": ShoppingCart, truck: Truck,
  "rotate-ccw": RotateCcw, shield: Shield, zap: Zap, "book-open": BookOpen,
  wrench: Wrench, gift: Gift, "phone-forwarded": PhoneForwarded,
};

function shell(active: boolean | undefined) {
  return `rounded-2xl border bg-white px-4 py-3 shadow-[0_4px_16px_rgba(15,15,15,0.04)] transition-all ${
    active ? "border-neutral-900 shadow-[0_0_0_2px_rgba(17,17,17,0.9)]" : "border-neutral-200"
  }`;
}

/** Variant-diff accent: when set, the node border adopts the variant's color with a soft ring. */
function diffStyle(data: CardData): CSSProperties | undefined {
  const c = data.diffColor as string | undefined;
  return c ? { borderColor: c, boxShadow: `0 0 0 1.5px ${c}33, 0 4px 16px rgba(15,15,15,0.04)` } : undefined;
}

export const IncomingCallCard = memo(function IncomingCallCard({ data }: { data: CardData }) {
  const number = data.number as string | null;
  const status = data.numberStatus as string | undefined;
  const label = (data.label as string | undefined) ?? "Incoming call";
  const outbound = Boolean(data.outbound) || /outgoing|outbound/i.test(label);
  const CallIcon = outbound ? PhoneOutgoing : Phone;
  return (
    <div className={`${shell(data.active as boolean)} min-w-[180px]`} style={diffStyle(data)}>
      <div className="flex items-center gap-3">
        <CallIcon size={17} strokeWidth={2.2} className="shrink-0 text-neutral-950" />
        <div>
          <div className="text-[13px] font-semibold">{label}</div>
          {number ? (
            <div className="text-[12px] tabular-nums text-neutral-500">{number}</div>
          ) : status === "failed" ? (
            <div className="text-[11px] text-red-400">provisioning failed</div>
          ) : status === "none" ? null : (
            <div className="mt-0.5 h-3.5 w-24 animate-pulse rounded bg-neutral-100" />
          )}
        </div>
      </div>
    </div>
  );
});

export const TopicCard = memo(function TopicCard({ data }: { data: CardData }) {
  const Icon = ICONS[(data.icon as string) ?? "life-buoy"] ?? LifeBuoy;
  const steps = (data.steps as { label: string }[]) ?? [];
  const table = data.table as string | undefined;
  return (
    <div className={`${shell(data.active as boolean)} min-w-[170px] max-w-[200px]`} style={diffStyle(data)}>
      <div className="flex items-center gap-2.5">
        <Icon size={16} strokeWidth={2.1} className="shrink-0 text-neutral-950" />
        <div className="text-[13px] font-semibold">{data.label as string}</div>
      </div>
      {steps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {steps.map((s, i) => (
            <span
              key={i}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                data.activeStep === i ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 text-neutral-500"
              }`}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
      {table && (
        <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
          <Database size={10} strokeWidth={1.8} className="shrink-0 text-neutral-400" />
          {table}
        </div>
      )}
    </div>
  );
});

export const FallbackCard = memo(function FallbackCard({ data }: { data: CardData }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const number = data.supportNumber as string | null;
  const save = data.onSaveNumber as ((n: string) => Promise<boolean>) | undefined;

  return (
    <div className={`${shell(data.active as boolean)} min-w-[180px]`} style={diffStyle(data)}>
      <div className="flex items-center gap-2.5">
        <PhoneForwarded size={16} strokeWidth={2.1} className="shrink-0 text-neutral-950" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Other</div>
          <div className="text-[11px] text-neutral-400">contact support</div>
        </div>
      </div>
      {!save ? (
        number && <div className="mt-2 text-[11px] tabular-nums text-neutral-500">{number}</div>
      ) : editing ? (
        <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && (await save(value))) setEditing(false);
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="+1 415 555 0123"
            className="w-32 rounded-lg border border-neutral-200 px-2 py-1 text-[11px] tabular-nums outline-none focus:border-neutral-500"
          />
          <button
            onClick={async () => { if (await save(value)) setEditing(false); }}
            className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-white"
          >
            <Check size={11} />
          </button>
        </div>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); setValue(number ?? ""); setEditing(true); }}
          className="mt-2 flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] tabular-nums text-neutral-600 transition-colors hover:border-neutral-900"
        >
          {number ?? "set number"} <Pencil size={10} className="text-neutral-300" />
        </button>
      )}
    </div>
  );
});

/** Running A/B test badge hung off the entry node — click-through to the experiment screen. */
export const ExperimentCard = memo(function ExperimentCard({ data }: { data: CardData }) {
  const onOpen = data.onOpen as (() => void) | undefined;
  return (
    <button
      onClick={onOpen}
      className={`min-w-[170px] rounded-2xl border border-violet-500 bg-white px-4 py-3 text-left
                  shadow-[0_4px_16px_rgba(139,92,246,0.12)] transition-transform duration-[160ms]
                  ${onOpen ? "cursor-pointer hover:-translate-y-px" : "cursor-default"}`}
    >
      <div className="flex items-center gap-2.5">
        <FlaskConical size={16} strokeWidth={2.1} className="shrink-0 text-violet-500" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{data.label as string}</div>
          <div className="text-[11px] text-neutral-400">A/B test</div>
        </div>
      </div>
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Renderer types                                                      */
/* ------------------------------------------------------------------ */

export type ThreeFlowNode = {
  id: string;
  /** Top-left corner, pixel space (y down) — same convention as React Flow positions. */
  x: number;
  y: number;
  element: ReactNode;
};

export type ThreeFlowEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  fromAnchor?: "right" | "bottom";
  toAnchor?: "left" | "top";
  color?: string;
  width?: number;
  dashed?: boolean;
  animated?: boolean;
  labelStyle?: { fontSize?: number; color?: string };
};

type Props = {
  nodes: ThreeFlowNode[];
  edges: ThreeFlowEdge[];
  onNodeClick?: (id: string) => void;
  /** false = static mini render: no panning. */
  interactive?: boolean;
  fitPadding?: number;
  minZoom?: number;
  maxZoom?: number;
};

type Size = { w: number; h: number };
type View = { x: number; y: number; zoom: number };
type Pt = { x: number; y: number };

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const SEGMENTS = 32;
const CURVATURE = 0.4;
const DASH_SPEED = 20; // world units / s — matches React Flow's dashdraw pace

/** Cubic bezier sampled to world points; horizontal-out / vertical-out control offsets. */
function cubicPoints(sp: Pt, tp: Pt, sa: "right" | "bottom", ta: "left" | "top") {
  const c1 = sa === "bottom"
    ? { x: sp.x, y: sp.y + Math.abs(tp.y - sp.y) * CURVATURE }
    : { x: sp.x + Math.abs(tp.x - sp.x) * CURVATURE, y: sp.y };
  const c2 = ta === "top"
    ? { x: tp.x, y: tp.y - Math.abs(tp.y - sp.y) * CURVATURE }
    : { x: tp.x - Math.abs(tp.x - sp.x) * CURVATURE, y: tp.y };
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS, u = 1 - t;
    const x = u * u * u * sp.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * tp.x;
    const y = u * u * u * sp.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * tp.y;
    pts.push([x, -y, 0]); // scene is y-up; pixel space is y-down
  }
  return pts;
}

/* ------------------------------------------------------------------ */
/* Scene pieces                                                        */
/* ------------------------------------------------------------------ */

/** World-space dot grid (bg #f7f7f6, dots #d4d4d4, gap 18, dot diameter 1.4) on one shader plane. */
function DotGrid() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uBg: { value: [247 / 255, 247 / 255, 246 / 255] },
          uDot: { value: [212 / 255, 212 / 255, 212 / 255] },
        },
        vertexShader: /* glsl */ `
          varying vec2 vW;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vW = wp.xy;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          varying vec2 vW;
          uniform vec3 uBg;
          uniform vec3 uDot;
          void main() {
            vec2 q = mod(vW, 18.0) - 9.0;
            float d = length(q);
            float aa = fwidth(d);
            float m = 1.0 - smoothstep(0.7 - aa, 0.7 + aa, d);
            gl_FragColor = vec4(mix(uBg, uDot, m), 1.0);
          }`,
      }),
    []
  );
  return (
    <mesh position={[0, 0, -10]} material={material}>
      <planeGeometry args={[40000, 40000]} />
    </mesh>
  );
}

/** Fits the camera to node bounds once per flow identity, then applies the pan view every frame. */
function FitController({
  nodes, sizes, identity, padding, minZoom, maxZoom, viewRef, onFitted,
}: {
  nodes: ThreeFlowNode[];
  sizes: Record<string, Size>;
  identity: string;
  padding: number;
  minZoom: number;
  maxZoom: number;
  viewRef: React.MutableRefObject<View>;
  onFitted: (zoom: number) => void;
}) {
  const size = useThree((s) => s.size);
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (fitted.current === identity || !nodes.length || size.width === 0) return;
    if (!nodes.every((n) => sizes[n.id])) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const s = sizes[n.id];
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + s.w);
      maxY = Math.max(maxY, n.y + s.h);
    }
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const zoom = Math.max(
      Math.min(size.width / (bw * (1 + padding)), size.height / (bh * (1 + padding)), maxZoom),
      minZoom
    );
    viewRef.current = { x: minX + bw / 2, y: minY + bh / 2, zoom };
    fitted.current = identity;
    onFitted(zoom);
  }, [identity, nodes, sizes, size.width, size.height, padding, minZoom, maxZoom, viewRef, onFitted]);

  useFrame(({ camera }) => {
    const v = viewRef.current;
    const cam = camera as THREE.OrthographicCamera;
    if (cam.position.x !== v.x || cam.position.y !== -v.y || cam.zoom !== v.zoom) {
      cam.position.set(v.x, -v.y, 100);
      cam.zoom = v.zoom;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

type EdgeSpec = {
  key: string;
  points: [number, number, number][];
  color: string;
  width: number;
  dashed: boolean;
  animated: boolean;
  label?: string;
  labelStyle?: { fontSize?: number; color?: string };
};

function EdgeLine({ spec, zoom }: { spec: EdgeSpec; zoom: number }) {
  const ref = useRef<Line2>(null);
  useFrame((_, dt) => {
    if (!spec.animated || !ref.current) return;
    const m = ref.current.material as LineMaterial;
    m.dashOffset = (m.dashOffset - DASH_SPEED * dt) % 10;
  });
  return (
    <Line
      ref={ref}
      points={spec.points}
      color={spec.color}
      lineWidth={spec.width * zoom}
      dashed={spec.dashed || spec.animated}
      dashSize={spec.dashed ? 4 : 5}
      gapSize={spec.dashed ? 4 : 5}
      transparent
      depthWrite={false}
    />
  );
}

/** DOM card anchored by its top-left corner at (x, y) pixel space; measured by the container observer. */
function NodeHtml({
  node, hidden, onClick,
}: {
  node: ThreeFlowNode;
  hidden: boolean;
  onClick?: (id: string) => void;
}) {
  return (
    <Html transform occlude={false} distanceFactor={400} position={[node.x, -node.y, 0]} zIndexRange={[2, 0]}>
      <div style={{ width: 0, height: 0, position: "relative" }}>
        <div
          data-tf-node={node.id}
          onClick={onClick ? () => onClick(node.id) : undefined}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "max-content",
            pointerEvents: "auto",
            visibility: hidden ? "hidden" : "visible",
          }}
        >
          {node.element}
        </div>
      </div>
    </Html>
  );
}

function EdgeLabel({ spec }: { spec: EdgeSpec }) {
  if (!spec.label) return null;
  const [mx, my] = spec.points[SEGMENTS / 2];
  return (
    <Html transform occlude={false} distanceFactor={400} position={[mx, my, 0]} zIndexRange={[1, 0]}>
      <div
        style={{
          fontSize: spec.labelStyle?.fontSize ?? 10,
          color: spec.labelStyle?.color ?? "#222",
          background: "#ffffff",
          padding: "1px 3px",
          borderRadius: 2,
          whiteSpace: "nowrap",
        }}
      >
        {spec.label}
      </div>
    </Html>
  );
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

export default function ThreeFlow({
  nodes, edges, onNodeClick, interactive = true, fitPadding = 0.1, minZoom = 0.5, maxZoom = 2,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, zoom: 1 });
  const [zoom, setZoom] = useState<number | null>(null); // set at first fit; pan never changes it
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const identity = useMemo(() => nodes.map((n) => n.id).sort().join("|"), [nodes]);

  const onSize = useCallback((id: string, w: number, h: number) => {
    if (w <= 0 || h <= 0) return; // detached / not-yet-laid-out reports
    setSizes((s) => (s[id]?.w === w && s[id]?.h === h ? s : { ...s, [id]: { w, h } }));
  }, []);

  // Measure cards from the container: drei Html renders children into detached React roots,
  // so sizes are observed on the live DOM (border-box, like React Flow's node measurements).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const t = entry.target as HTMLElement;
        const id = t.getAttribute("data-tf-node");
        if (id) onSize(id, t.offsetWidth, t.offsetHeight);
      }
    });
    const attach = () => el.querySelectorAll("[data-tf-node]").forEach((n) => ro.observe(n)); // re-observe is a no-op
    attach();
    const mo = new MutationObserver(attach);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [identity, onSize]);

  // Drag-to-pan: pointer deltas move the camera; drags starting on a card are left to the DOM.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !interactive) return;
    let dragging = false;
    let last = { x: 0, y: 0 };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-tf-node]")) return;
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      el.style.cursor = "grabbing";
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const v = viewRef.current;
      v.x -= (e.clientX - last.x) / v.zoom;
      v.y -= (e.clientY - last.y) / v.zoom;
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      dragging = false;
      el.style.cursor = "grab";
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [interactive]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edgeSpecs: EdgeSpec[] = useMemo(() => {
    if (zoom == null) return [];
    const specs: EdgeSpec[] = [];
    for (const e of edges) {
      const s = nodeMap.get(e.source), t = nodeMap.get(e.target);
      const ss = sizes[e.source], ts = sizes[e.target];
      if (!s || !t || !ss || !ts) continue;
      const sa = e.fromAnchor ?? "right";
      const ta = e.toAnchor ?? "left";
      const sp = sa === "right" ? { x: s.x + ss.w, y: s.y + ss.h / 2 } : { x: s.x + ss.w / 2, y: s.y + ss.h };
      const tp = ta === "left" ? { x: t.x, y: t.y + ts.h / 2 } : { x: t.x + ts.w / 2, y: t.y };
      specs.push({
        key: `${e.id}:${e.animated ? 1 : 0}`,
        points: cubicPoints(sp, tp, sa, ta),
        color: e.color ?? "#d9d9d9",
        width: e.width ?? 1.2,
        dashed: !!e.dashed,
        animated: !!e.animated,
        label: e.label,
        labelStyle: e.labelStyle,
      });
    }
    return specs;
  }, [edges, nodeMap, sizes, zoom]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ background: "#f7f7f6", isolation: "isolate", cursor: interactive ? "grab" : "default" }}
    >
      <Canvas
        orthographic
        flat
        dpr={[1, 2]}
        camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 1000 }}
      >
        <color attach="background" args={["#f7f7f6"]} />
        <DotGrid />
        <FitController
          nodes={nodes}
          sizes={sizes}
          identity={identity}
          padding={fitPadding}
          minZoom={minZoom}
          maxZoom={maxZoom}
          viewRef={viewRef}
          onFitted={setZoom}
        />
        {edgeSpecs.map((spec) => (
          <EdgeLine key={spec.key} spec={spec} zoom={zoom ?? 1} />
        ))}
        {edgeSpecs.map((spec) => (
          <EdgeLabel key={`${spec.key}:label`} spec={spec} />
        ))}
        {nodes.map((n) => (
          <NodeHtml key={n.id} node={n} hidden={zoom == null} onClick={onNodeClick} />
        ))}
      </Canvas>
    </div>
  );
}
