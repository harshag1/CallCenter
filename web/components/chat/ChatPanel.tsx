// Author: Harsha Gundala
// ChatPanel.tsx — operator chat: streamed replies, inline tool activity, one input.

"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowUp, Wrench, Check, X } from "lucide-react";

export type ChatItem =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; name: string; status: "start" | "done" | "error" };

export default function ChatPanel({
  items, streaming, onSend,
}: { items: ChatItem[]; streaming: boolean; onSend: (text: string) => void }) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  function submit() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    onSend(text);
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {!items.length && (
          <div className="mt-8 text-center text-xs leading-5 text-neutral-300">
            ask for anything —<br />dashboards · tools · calls · analysis
          </div>
        )}
        {items.map((item, i) =>
          item.kind === "tool" ? (
            <div key={i} className="flex items-center gap-1.5 pl-1 font-mono text-[11px] text-neutral-400">
              {item.status === "start" ? (
                <Wrench size={11} className="animate-pulse" />
              ) : item.status === "done" ? (
                <Check size={11} className="text-emerald-500" />
              ) : (
                <X size={11} className="text-red-400" />
              )}
              {item.name}
            </div>
          ) : item.role === "user" ? (
            <div key={i} className="ml-8 rounded-2xl rounded-br-md bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800">
              {item.text}
            </div>
          ) : (
            <div key={i} className="pr-4 text-sm leading-relaxed text-neutral-800 [&_code]:font-mono [&_code]:text-xs [&_p]:mb-1.5">
              <ReactMarkdown>{item.text}</ReactMarkdown>
            </div>
          )
        )}
        {streaming && <div className="pl-1 text-xs text-neutral-300">…</div>}
      </div>
      <div className="border-t border-[var(--border)] p-3">
        <div className="flex items-end gap-2 rounded-xl border border-neutral-200 px-3 py-2 focus-within:border-neutral-400">
          <textarea
            rows={1}
            value={input}
            placeholder="ask the operator"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-neutral-300"
          />
          <button
            onClick={submit}
            disabled={!input.trim() || streaming}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white disabled:opacity-20"
          >
            <ArrowUp size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
