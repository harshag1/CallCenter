// Author: Harsha Gundala
// onboarding — one textbox; personalized bot suggestions stream in from the background company scrape.

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

type Suggestion = { label: string; purpose: string; prompt: string };

export default function Onboarding() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [company, setCompany] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/onboarding/scrape")
      .then((r) => r.json())
      .then((j) => {
        if (j.scrape) {
          setSuggestions(j.scrape.suggestions ?? []);
          setCompany(j.scrape.company ?? null);
        }
      })
      .catch(() => {});
  }, []);

  async function build() {
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      router.push("/workspace");
    } catch (e) {
      setError((e as Error).message);
      setBuilding(false);
    }
  }

  return (
    <main className="flex h-screen items-center justify-center bg-white">
      <div className="w-[560px] px-6">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight">Describe your bot</h1>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={company ? `What should your ${company} agent handle?` : "A voice agent that..."}
          className="w-full resize-none rounded-xl border border-neutral-200 p-4 text-[15px] leading-relaxed outline-none placeholder:text-neutral-300 focus:border-neutral-400"
        />
        <div className="mt-3 flex min-h-8 flex-wrap justify-center gap-2">
          {suggestions.map((s) => (
            <button
              key={s.label}
              onClick={() => setText(s.prompt)}
              className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              <Sparkles size={11} /> {s.label}
            </button>
          ))}
        </div>
        <div className="mt-6 flex justify-center">
          <button
            onClick={build}
            disabled={building || text.trim().length < 10}
            className="flex h-10 items-center gap-2 rounded-lg bg-neutral-900 px-5 text-sm text-white transition-opacity disabled:opacity-30"
          >
            {building ? <><Loader2 size={14} className="animate-spin" /> Building…</> : "Build my first agent"}
          </button>
        </div>
        {error && <p className="mt-3 text-center text-xs text-red-500">{error}</p>}
      </div>
    </main>
  );
}
