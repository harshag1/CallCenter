// Author: Harsha Gundala
// nodes.tsx — custom React Flow nodes: incoming call (live number), topics (icons), editable fallback.

"use client";

import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Phone, PhoneForwarded, LifeBuoy, Package, CreditCard, Calendar, User, Settings,
  ShoppingCart, Truck, RotateCcw, Shield, Zap, BookOpen, Wrench, Gift, Pencil, Check,
} from "lucide-react";

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

export const IncomingCallNode = memo(function IncomingCallNode({ data }: NodeProps) {
  const number = data.number as string | null;
  const status = data.numberStatus as string | undefined;
  return (
    <div className={`${shell(data.active as boolean)} min-w-[190px]`}>
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-950 text-white">
          <Phone size={15} strokeWidth={2.2} />
        </span>
        <div>
          <div className="text-[13px] font-semibold">Incoming Call</div>
          {number ? (
            <div className="text-[12px] tabular-nums text-neutral-500">{number}</div>
          ) : status === "failed" ? (
            <div className="text-[11px] text-red-400">provisioning failed</div>
          ) : (
            <div className="mt-0.5 h-3.5 w-24 animate-pulse rounded bg-neutral-100" />
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-300" />
    </div>
  );
});

export const TopicNode = memo(function TopicNode({ data }: NodeProps) {
  const Icon = ICONS[(data.icon as string) ?? "life-buoy"] ?? LifeBuoy;
  const steps = (data.steps as { label: string }[]) ?? [];
  return (
    <div className={`${shell(data.active as boolean)} min-w-[170px]`}>
      <Handle type="target" position={Position.Top} className="!bg-neutral-300" />
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-neutral-100 bg-neutral-50 text-neutral-700">
          <Icon size={14} strokeWidth={2} />
        </span>
        <div className="text-[13px] font-semibold">{data.label as string}</div>
      </div>
      {steps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {steps.map((s, i) => (
            <span
              key={i}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                data.activeStep === i ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-150 border-neutral-200 text-neutral-500"
              }`}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export const FallbackNode = memo(function FallbackNode({ data }: NodeProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const number = data.supportNumber as string | null;
  const save = data.onSaveNumber as (n: string) => Promise<boolean>;

  return (
    <div className={`${shell(data.active as boolean)} min-w-[190px]`}>
      <Handle type="target" position={Position.Top} className="!bg-neutral-300" />
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-neutral-100 bg-neutral-50 text-neutral-700">
          <PhoneForwarded size={14} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Other</div>
          <div className="text-[11px] text-neutral-400">contact support</div>
        </div>
      </div>
      {editing ? (
        <div className="mt-2 flex items-center gap-1">
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
          onClick={() => { setValue(number ?? ""); setEditing(true); }}
          className="mt-2 flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] tabular-nums text-neutral-600 transition-colors hover:border-neutral-900"
        >
          {number ?? "set number"} <Pencil size={10} className="text-neutral-300" />
        </button>
      )}
    </div>
  );
});

export const nodeTypes = {
  incoming_call: IncomingCallNode,
  topic: TopicNode,
  fallback: FallbackNode,
};
