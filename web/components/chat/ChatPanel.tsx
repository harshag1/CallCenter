// Author: Harsha Gundala
// ChatPanel.tsx — operator chat: dark-ink user bubbles, bare assistant prose, shimmer tool lines.

"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, ChevronRight, MessageSquare, Wrench } from "lucide-react";
import { toolDisplay } from "./tool-display";

export type ChatItem =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; name: string; status: "start" | "done" | "error" };

/** Bare single-line tool activity: pulsing icon + shimmering label while running. */
export function ToolLine({ name, status }: { name: string; status: "start" | "done" | "error" }) {
  const d = toolDisplay(name);
  const Icon = d.icon;
  const running = status === "start";
  return (
    <div className="my-1 ml-0.5">
      <span className="inline-flex max-w-full items-center gap-2 whitespace-nowrap py-0.5 text-[14px] font-semibold text-neutral-500">
        <Icon
          size={15}
          strokeWidth={2.25}
          aria-hidden
          className={`shrink-0 text-neutral-500 ${running ? "animate-tool-pulse" : ""}`}
        />
        <span className={`max-w-[56ch] truncate ${running ? "tool-shimmer" : ""}`}>
          {running ? d.running : d.done}
        </span>
        {status === "error" && (
          <span
            aria-label="Error"
            className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_0_2px_rgba(255,255,255,0.92)]"
          />
        )}
      </span>
    </div>
  );
}

/** Three blinking cells — the streaming indicator. */
export function PixelLoader() {
  return (
    <span className="pixel-loader" aria-label="Thinking">
      <span className="pixel-loader-cell" />
      <span className="pixel-loader-cell" style={{ animationDelay: "0.3s" }} />
      <span className="pixel-loader-cell" style={{ animationDelay: "0.6s" }} />
    </span>
  );
}

export const USER_BUBBLE =
  "max-w-[76%] select-text whitespace-pre-wrap rounded-[18px] rounded-br-[8px] bg-neutral-900 px-3.5 py-2 text-[12.5px] leading-[1.5] text-white border border-neutral-900/10 shadow-[0_8px_24px_rgba(0,0,0,0.05)]";

export const ASSISTANT_PROSE =
  "max-w-[92%] select-text px-1 py-0.5 text-[13px] leading-[1.62] font-[450] text-neutral-800 " +
  "[&_p]:my-[0.52em] [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
  "[&_strong]:font-extrabold [&_strong]:text-neutral-900 " +
  "[&_code]:font-mono [&_code]:text-[11.5px] " +
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-[10px] [&_pre]:bg-neutral-50 [&_pre]:p-3 " +
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-neutral-200 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-neutral-400 [&_td]:border-b [&_td]:border-neutral-100 [&_td]:px-2 [&_td]:py-1";

type TextItem = Extract<ChatItem, { kind: "text" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type Grouped =
  | { kind: "single"; item: TextItem | ToolItem }
  | { kind: "toolgroup"; items: ToolItem[]; live: boolean };

/** Consecutive tool calls collapse into one expandable group once the turn has moved on. */
export function groupItems(items: ChatItem[], streaming: boolean): Grouped[] {
  const out: Grouped[] = [];
  let run: ToolItem[] = [];
  const flush = (isTail: boolean) => {
    if (!run.length) return;
    const live = isTail && streaming;
    if (run.length === 1 && live) out.push({ kind: "single", item: run[0] });
    else out.push({ kind: "toolgroup", items: run, live });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") run.push(item);
    else { flush(false); out.push({ kind: "single", item }); }
  }
  flush(true);
  return out;
}

/** Live groups show every line; finished groups condense to "Ran N toolcalls". */
export function ToolGroup({ items, live }: { items: ToolItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (live || open) {
    return (
      <div>
        {!live && (
          <button onClick={() => setOpen(false)} className="mb-0.5 flex items-center gap-1.5 text-[12px] font-medium text-neutral-400 hover:text-neutral-700">
            <ChevronRight size={12} className="rotate-90 transition-transform" /> Ran {items.length} toolcall{items.length === 1 ? "" : "s"}
          </button>
        )}
        {items.map((t, i) => <ToolLine key={i} name={t.name} status={t.status} />)}
      </div>
    );
  }
  const errors = items.filter((t) => t.status === "error").length;
  return (
    <button onClick={() => setOpen(true)} className="my-1 flex items-center gap-1.5 text-[12px] font-medium text-neutral-400 transition-colors hover:text-neutral-700">
      <ChevronRight size={12} className="transition-transform" />
      <Wrench size={12} />
      Ran {items.length} toolcall{items.length === 1 ? "" : "s"}
      {errors > 0 && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500" />}
    </button>
  );
}

const MAX_INPUT_PX = 330; // ~15 lines before scrolling

export default function ChatPanel({
  items, streaming, onSend,
}: { items: ChatItem[]; streaming: boolean; onSend: (text: string) => void }) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_INPUT_PX ? "auto" : "hidden";
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  function submit() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    onSend(text);
    requestAnimationFrame(() => autoGrow());
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {!items.length && (
          <div className="mt-10 flex justify-center">
            <MessageSquare size={18} strokeWidth={1.8} className="text-neutral-200" />
          </div>
        )}
        {groupItems(items, streaming).map((g, i) =>
          g.kind === "toolgroup" ? (
            <ToolGroup key={i} items={g.items} live={g.live} />
          ) : g.item.kind === "tool" ? (
            <ToolLine key={i} name={g.item.name} status={g.item.status} />
          ) : g.item.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className={USER_BUBBLE}>{g.item.text}</div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className={ASSISTANT_PROSE}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{g.item.text}</ReactMarkdown>
              </div>
            </div>
          )
        )}
        {streaming && (
          <div className="pl-1 pt-1">
            <PixelLoader />
          </div>
        )}
      </div>
      <div className="shrink-0 bg-white/85 px-3 pb-3 pt-2">
        <div className="relative rounded-2xl border border-neutral-200/75 bg-white/70 px-2.5 py-2 transition-[background-color,border-color,box-shadow] duration-[160ms] focus-within:border-neutral-900/25 focus-within:bg-white focus-within:shadow-[0_0_0_1px_rgba(0,0,0,0.07)]">
          <div className="flex items-end gap-2">
            <textarea
              rows={1}
              ref={inputRef}
              value={input}
              placeholder="Create or modify voice agents"
              onChange={(e) => { setInput(e.target.value); autoGrow(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
              className="min-w-0 flex-1 resize-none bg-transparent px-1 py-[7px] text-[14px] leading-[1.55] text-neutral-900 outline-none placeholder:text-neutral-400"
            />
            <button
              aria-label="Send"
              onClick={submit}
              disabled={!input.trim() || streaming}
              className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-neutral-900 bg-neutral-900 text-white transition duration-[160ms] hover:-translate-y-px hover:bg-neutral-800 disabled:translate-y-0 disabled:opacity-40"
            >
              <ArrowUp size={16} strokeWidth={2.1} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
