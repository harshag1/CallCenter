// Author: Harsha Gundala
// login — email → one-time code, centered card, nothing else.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, ArrowRight, Loader2 } from "lucide-react";

export default function Login() {
  const router = useRouter();
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (stage === "email") {
        const res = await fetch("/api/auth/send-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        setStage("code");
      } else {
        const res = await fetch("/api/auth/verify-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error);
        router.push(json.next);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-screen items-center justify-center bg-white">
      <div className="w-80">
        <div className="mb-8 flex items-center gap-2.5">
          <Phone size={18} strokeWidth={2.4} />
          <span className="text-sm font-semibold tracking-tight">Harsha&apos;s Amazing Call Center</span>
        </div>
        {stage === "email" ? (
          <input
            autoFocus
            type="email"
            value={email}
            placeholder="work email"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && email && submit()}
            className="w-full border-b border-neutral-200 pb-2 text-lg outline-none placeholder:text-neutral-300 focus:border-neutral-900"
          />
        ) : (
          <input
            autoFocus
            inputMode="numeric"
            maxLength={6}
            value={code}
            placeholder="000000"
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && code.length === 6 && submit()}
            className="w-full border-b border-neutral-200 pb-2 text-2xl tracking-[0.5em] outline-none placeholder:text-neutral-200 focus:border-neutral-900"
          />
        )}
        <button
          onClick={submit}
          disabled={busy || (stage === "email" ? !email : code.length !== 6)}
          className="mt-6 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-neutral-900 text-sm text-white transition-opacity disabled:opacity-30"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <>{stage === "email" ? "Send code" : "Sign in"} <ArrowRight size={14} /></>}
        </button>
        {stage === "code" && <p className="mt-3 text-center text-xs text-neutral-400">code sent to {email}</p>}
        {error && <p className="mt-3 text-center text-xs text-red-500">{error}</p>}
      </div>
    </main>
  );
}
