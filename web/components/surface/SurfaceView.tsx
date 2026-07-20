// Author: Harsha Gundala
// SurfaceView.tsx — renders the operator agent's Surface DSL: tables, stats, charts, tabs, forms, transcripts.

"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import type { Surface, Block } from "@/lib/surface-dsl";
import {
  createCredentialSubmissionId,
  submitCredentialToSink,
} from "@/lib/credential-form-client";

type Send = (prompt: string) => void;

const GRAYS = ["#111", "#555", "#999", "#ccc", "#777", "#333"];

function blockInstanceKey(block: Block, index: number): string | number {
  // A newly issued slot at the same surface position is a new security ceremony. Remounting
  // prevents a prior form's saved/error state and submission id from crossing into that slot.
  return block.kind === "credential_form" && typeof block.slotId === "string"
    ? `credential-form:${block.slotId}`
    : index;
}

function template(prompt: string, row: Record<string, unknown>): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (_, k) => String(row[k] ?? ""));
}

function BlockView({ block, send }: { block: Block; send: Send }) {
  switch (block.kind) {
    case "stat_row": {
      const stats = block.stats as { label: string; value: string; delta?: string }[];
      return (
        <div className="flex gap-3">
          {stats.map((s) => (
            <div key={s.label} className="flex-1 rounded-xl border border-[var(--border)] p-4">
              <div className="text-[11px] uppercase tracking-wide text-neutral-400">{s.label}</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight">{s.value}</div>
              {s.delta && <div className="mt-0.5 text-xs text-neutral-500">{s.delta}</div>}
            </div>
          ))}
        </div>
      );
    }
    case "table": {
      const columns = block.columns as { key: string; label: string }[];
      const rows = block.rows as Record<string, unknown>[];
      const rowAction = block.rowAction as { label?: string; prompt: string } | undefined;
      return (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-neutral-400">
                {columns.map((c) => <th key={c.key} className="px-4 py-2.5 font-medium">{c.label}</th>)}
                {rowAction && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  onClick={rowAction ? () => send(template(rowAction.prompt, r)) : undefined}
                  className={`border-b border-[var(--border)] last:border-0 ${rowAction ? "cursor-pointer hover:bg-neutral-50" : ""}`}
                >
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-2.5 text-neutral-700">{String(r[c.key] ?? "—")}</td>
                  ))}
                  {rowAction && <td className="pr-3 text-neutral-300">›</td>}
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={columns.length + 1} className="px-4 py-6 text-center text-xs text-neutral-400">empty</td></tr>
              )}
            </tbody>
          </table>
        </div>
      );
    }
    case "chart": {
      const series = block.series as { name: string; points: { x: string | number; y: number }[] }[];
      const type = block.type as string;
      const data = (series[0]?.points ?? []).map((p, i) => {
        const row: Record<string, unknown> = { x: p.x };
        series.forEach((s) => (row[s.name] = s.points[i]?.y));
        return row;
      });
      const common = { data, margin: { top: 8, right: 8, bottom: 0, left: -18 } };
      return (
        <div className="h-56 rounded-xl border border-[var(--border)] p-3">
          <ResponsiveContainer>
            {type === "bar" ? (
              <BarChart {...common}>
                <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="#ddd" /><YAxis tick={{ fontSize: 11 }} stroke="#ddd" /><Tooltip />
                {series.map((s, i) => <Bar key={s.name} dataKey={s.name} fill={GRAYS[i % 6]} radius={[4, 4, 0, 0]} />)}
              </BarChart>
            ) : type === "area" ? (
              <AreaChart {...common}>
                <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="#ddd" /><YAxis tick={{ fontSize: 11 }} stroke="#ddd" /><Tooltip />
                {series.map((s, i) => <Area key={s.name} dataKey={s.name} stroke={GRAYS[i % 6]} fill={GRAYS[i % 6]} fillOpacity={0.08} />)}
              </AreaChart>
            ) : type === "donut" ? (
              <PieChart>
                <Tooltip />
                <Pie data={series[0]?.points.map((p) => ({ name: String(p.x), value: p.y })) ?? []} dataKey="value" innerRadius="55%" outerRadius="85%">
                  {(series[0]?.points ?? []).map((_, i) => <Cell key={i} fill={GRAYS[i % 6]} />)}
                </Pie>
              </PieChart>
            ) : (
              <LineChart {...common}>
                <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="#ddd" /><YAxis tick={{ fontSize: 11 }} stroke="#ddd" /><Tooltip />
                {series.map((s, i) => <Line key={s.name} dataKey={s.name} stroke={GRAYS[i % 6]} dot={false} strokeWidth={1.8} />)}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      );
    }
    case "tabs": {
      return <Tabs tabs={block.tabs as { label: string; blocks: Block[] }[]} send={send} />;
    }
    case "transcript":
      return <Transcript callId={block.callId as string} />;
    case "audio":
      return <audio controls src={block.src as string} className="w-full" />;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-xl border border-[var(--border)] bg-neutral-50 p-4 font-mono text-xs leading-relaxed text-neutral-800">
          {block.source as string}
        </pre>
      );
    case "form":
      return <Form fields={block.fields as never} submit={block.submit as never} send={send} />;
    case "credential_form":
      return (
        <CredentialForm
          slotId={block.slotId as string}
          label={block.label as string}
          credentialLabel={block.credentialLabel as string | undefined}
          submitLabel={block.submitLabel as string | undefined}
          expiresAt={block.expiresAt as string | undefined}
          destination={block.destination as string | undefined}
          allowedTools={block.allowedTools as "all" | string[] | undefined}
        />
      );
    case "markdown":
      return (
        <div className="prose prose-sm prose-neutral max-w-none text-sm leading-relaxed [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.body as string}</ReactMarkdown>
        </div>
      );
    case "actions": {
      const actions = block.actions as { label?: string; prompt: string }[];
      return (
        <div className="flex flex-wrap gap-2">
          {actions.map((a, i) => (
            <button
              key={i}
              onClick={() => send(a.prompt)}
              className="rounded-full border border-neutral-200 px-3.5 py-1.5 text-xs text-neutral-700 transition-colors hover:border-neutral-900"
            >
              {a.label ?? a.prompt}
            </button>
          ))}
        </div>
      );
    }
    default:
      return null;
  }
}

function Tabs({ tabs, send }: { tabs: { label: string; blocks: Block[] }[]; send: Send }) {
  const [active, setActive] = useState(0);
  return (
    <div>
      <div className="mb-3 flex gap-1 border-b border-[var(--border)]">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            onClick={() => setActive(i)}
            className={`px-3 pb-2 text-sm ${i === active ? "border-b-2 border-neutral-900 font-medium" : "text-neutral-400"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="space-y-4">
        {tabs[active]?.blocks.map((b, i) => (
          <BlockView key={blockInstanceKey(b, i)} block={b} send={send} />
        ))}
      </div>
    </div>
  );
}

function Transcript({ callId }: { callId: string }) {
  const [events, setEvents] = useState<{ id: number; type: string; payload: { text?: string; name?: string } }[]>([]);
  const lastId = useRef(0);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/calls/${callId}/events?after=${lastId.current}`);
        const json = await res.json();
        if (live && json.events?.length) {
          lastId.current = json.events[json.events.length - 1].id;
          setEvents((prev) => [...prev, ...json.events]);
        }
      } catch {}
    };
    tick();
    const iv = setInterval(tick, 2500);
    return () => { live = false; clearInterval(iv); };
  }, [callId]);
  return (
    <div className="space-y-2 rounded-xl border border-[var(--border)] p-4">
      {events.filter((e) => ["user_said", "agent_said", "tool_call"].includes(e.type)).map((e) => (
        <div key={e.id} className="flex gap-2 text-sm">
          <span className={`w-12 shrink-0 text-[11px] uppercase tracking-wide ${e.type === "user_said" ? "text-neutral-900" : "text-neutral-400"}`}>
            {e.type === "user_said" ? "caller" : e.type === "agent_said" ? "agent" : "tool"}
          </span>
          <span className={e.type === "tool_call" ? "font-mono text-xs text-neutral-400" : "text-neutral-700"}>
            {e.type === "tool_call" ? `${e.payload.name}(…)` : e.payload.text}
          </span>
        </div>
      ))}
      {!events.length && <div className="text-center text-xs text-neutral-400">no transcript yet</div>}
    </div>
  );
}

function Form({ fields, submit, send }: {
  fields: { name: string; label: string; type: string; options?: string[] }[];
  submit: { label?: string; prompt: string };
  send: Send;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));
  const cls = "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-500";
  return (
    <div className="space-y-3 rounded-xl border border-[var(--border)] p-4">
      {fields.map((f) => (
        <label key={f.name} className="block">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">{f.label}</span>
          {f.type === "textarea" ? (
            <textarea rows={3} className={cls} value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} />
          ) : f.type === "select" ? (
            <select className={cls} value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)}>
              <option value="" />
              {f.options?.map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : (
            <input type={f.type} className={cls} value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} />
          )}
        </label>
      ))}
      <button
        onClick={() => send(`${submit.prompt}\n\n${JSON.stringify(values)}`)}
        className="rounded-lg bg-neutral-900 px-4 py-2 text-xs text-white"
      >
        {submit.label ?? "Submit"}
      </button>
    </div>
  );
}

function CredentialForm({ slotId, label, credentialLabel, submitLabel, expiresAt, destination, allowedTools }: {
  slotId: string;
  label: string;
  credentialLabel?: string;
  submitLabel?: string;
  expiresAt?: string;
  destination?: string;
  allowedTools?: "all" | string[];
}) {
  const [credential, setCredential] = useState("");
  const [state, setState] = useState<
    "idle" | "submitting" | "saved" | "rejected" | "already_used" | "unavailable"
  >("idle");
  const [expired, setExpired] = useState(false);
  const submissionId = useRef<string | null>(null);
  useEffect(() => {
    if (expiresAt === undefined) return;
    const expiresAtMs = Date.parse(expiresAt);
    const delay = Number.isFinite(expiresAtMs)
      ? Math.max(0, Math.min(expiresAtMs - Date.now(), 2_147_483_647))
      : 0;
    const timeout = window.setTimeout(() => setExpired(true), delay);
    return () => window.clearTimeout(timeout);
  }, [expiresAt]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!credential || state === "submitting" || state === "saved" || state === "already_used" || expired) return;
    const secret = credential;
    setState("submitting");
    // Clear the React state before awaiting I/O. The only copy we retain is the
    // request body sent straight to the same-origin sink; it is never passed to send().
    setCredential("");
    try {
      submissionId.current ??= createCredentialSubmissionId();
    } catch {
      setState("unavailable");
      return;
    }
    const result = await submitCredentialToSink({
      slotId,
      submissionId: submissionId.current,
      credential: secret,
    });
    setState(result);
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-[var(--border)] p-4">
      <p className="text-sm leading-relaxed text-neutral-700">{label}</p>
      {destination && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-neutral-800">
          <div>
            <span className="block font-medium text-neutral-600">Authorization destination</span>
            <code className="mt-0.5 block break-all font-mono">{destination}</code>
          </div>
          <div>
            <span className="block font-medium text-neutral-600">Framework remote-tool allowlist</span>
            {allowedTools === "all" ? (
              <span>The framework may call all tools advertised by this server</span>
            ) : (
              <div className="mt-1 max-h-28 overflow-y-auto font-mono">
                {(allowedTools ?? []).map((tool) => <div key={tool}>{tool}</div>)}
              </div>
            )}
            <span className="mt-1 block text-neutral-500">
              This limits later framework calls; the credential itself is sent to the destination above.
            </span>
          </div>
        </div>
      )}
      <label className="block">
        <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
          {credentialLabel ?? "Credential"}
        </span>
        <input
          type="password"
          name="credential"
          value={credential}
          onChange={(event) => {
            setCredential(event.target.value);
            if (state === "rejected" || state === "unavailable") setState("idle");
          }}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={state === "submitting" || state === "saved" || state === "already_used" || expired}
          className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 disabled:bg-neutral-50"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!credential || state === "submitting" || state === "saved" || state === "already_used" || expired}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-xs text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state === "submitting" ? "Saving…" : state === "saved" ? "Saved" : submitLabel ?? "Save securely"}
        </button>
        {state === "saved" && <span role="status" className="text-xs text-emerald-700">Stored securely. The assistant never received it.</span>}
        {state === "rejected" && <span role="alert" className="text-xs text-red-600">The destination rejected this credential. Re-enter it and retry.</span>}
        {state === "unavailable" && <span role="alert" className="text-xs text-red-600">The secure handoff was interrupted. Re-enter the same credential to retry safely.</span>}
        {state === "already_used" && <span role="alert" className="text-xs text-red-600">This form was already used by another submission. Ask the assistant to open a new secure form.</span>}
        {expired && <span role="alert" className="text-xs text-neutral-500">This secure form expired. Ask the assistant to open a new one.</span>}
      </div>
    </form>
  );
}

export default function SurfaceView({ surface, send }: { surface: Surface; send: Send }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">{surface.title}</h2>
      {surface.blocks.map((b, i) => (
        <BlockView key={blockInstanceKey(b, i)} block={b} send={send} />
      ))}
    </div>
  );
}
