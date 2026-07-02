// Author: Harsha Gundala
// verify — staged email then phone verification before the describe-agent builder.

"use client";

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Loader2, Mail, Phone } from "lucide-react";

type Stage = "email" | "phone" | "done";

function readParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get(name) ?? "";
}

function CodeInput({
  inputRef,
  onEnter,
  disabled,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onEnter: () => void;
  disabled?: boolean;
}) {
  return (
    <input
      inputMode="numeric"
      maxLength={6}
      ref={inputRef}
      disabled={disabled}
      placeholder="000000"
      onInput={(e) => { e.currentTarget.value = e.currentTarget.value.replace(/\D/g, ""); }}
      onKeyDown={(e) => e.key === "Enter" && onEnter()}
      className="w-full bg-transparent text-center text-[34px] font-semibold tracking-[0.32em] outline-none placeholder:text-neutral-200 disabled:text-neutral-300"
    />
  );
}

function StatusIcon({ done, active, type }: { done: boolean; active: boolean; type: "email" | "phone" }) {
  if (done) {
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
        <Check size={17} strokeWidth={2.5} />
      </span>
    );
  }
  const Icon = type === "email" ? Mail : Phone;
  return (
    <span className={`flex h-9 w-9 items-center justify-center rounded-full ring-1 ${active ? "bg-neutral-950 text-white ring-neutral-950" : "bg-neutral-50 text-neutral-300 ring-neutral-100"}`}>
      <Icon size={16} strokeWidth={2.3} />
    </span>
  );
}

export default function VerifyPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [stage, setStage] = useState<Stage>("email");
  const emailCodeRef = useRef<HTMLInputElement>(null);
  const phoneCodeRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"email" | "phone" | "resend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const emailDone = stage === "phone" || stage === "done";
  const phoneDone = stage === "done";

  useEffect(() => {
    const nextEmail = readParam("email") || sessionStorage.getItem("onboarding:email") || "";
    const nextPhone = readParam("phone") || sessionStorage.getItem("onboarding:phone") || "";
    if (nextEmail || nextPhone) {
      window.setTimeout(() => {
        if (nextEmail) setEmail(nextEmail);
        if (nextPhone) setPhone(nextPhone);
      }, 0);
      return;
    }

    if (!nextEmail || !nextPhone) {
      fetch("/api/auth/verification-state")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!j) {
            router.replace("/login");
            return;
          }
          setEmail(j.email ?? "");
          setPhone(j.phone ?? "");
          if (j.phoneVerified) router.replace(j.next ?? "/onboarding");
          else setStage("phone");
        })
        .catch(() => router.replace("/login"));
    }
  }, [router]);

  const sendPhoneCode = useCallback(async () => {
    if (!phone) return;
    setBusy("resend");
    setError(null);
    try {
      const res = await fetch("/api/auth/send-phone-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "could not send phone code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [phone]);

  async function verifyEmail() {
    const code = emailCodeRef.current?.value ?? "";
    if (code.length !== 6 || busy) return;
    setBusy("email");
    setError(null);
    try {
      const res = await fetch("/api/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, phone }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "wrong code");
      setStage("phone");
      void fetch("/api/onboarding/scrape").catch(() => {});
      await sendPhoneCode();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function verifyPhone() {
    const code = phoneCodeRef.current?.value ?? "";
    if (code.length !== 6 || busy) return;
    setBusy("phone");
    setError(null);
    try {
      const res = await fetch("/api/auth/verify-phone-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "wrong code");
      setStage("done");
      router.push(json.next ?? "/onboarding");
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  const caption = useMemo(() => {
    if (stage === "email") return "Email first. Phone unlocks right after.";
    if (stage === "phone") return "Company research is running in the background now.";
    return "Verified.";
  }, [stage]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f7] px-5 text-neutral-950">
      <div className="w-full max-w-[470px]">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-neutral-900 shadow-[0_10px_34px_rgba(0,0,0,0.06)] ring-1 ring-neutral-200">
            <Phone size={17} strokeWidth={2.4} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Verify your builder</h1>
          <p className="mt-1 text-xs text-neutral-400">{caption}</p>
        </div>

        <div className="space-y-3">
          <section className={`rounded-[28px] border bg-white p-4 shadow-[0_18px_70px_rgba(15,15,15,0.055)] transition-all ${stage === "email" ? "border-neutral-200" : "border-neutral-100"}`}>
            <div className="flex items-center gap-3">
              <StatusIcon done={emailDone} active={stage === "email"} type="email" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold tracking-tight">Verify email</div>
                <div className="truncate text-xs text-neutral-400">{email || "work email"}</div>
              </div>
              {emailDone && <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-emerald-600">done</span>}
            </div>

            <div
              aria-hidden={stage !== "email"}
              className={`grid transition-[grid-template-rows,opacity,margin] duration-500 ease-out ${stage === "email" ? "mt-5 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"}`}
            >
              <div className="min-h-0 overflow-hidden">
                {stage === "email" && (
                  <>
                    <CodeInput inputRef={emailCodeRef} onEnter={verifyEmail} disabled={busy !== null} />
                    <button
                      onClick={verifyEmail}
                      disabled={busy !== null}
                      className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-[17px] bg-neutral-950 text-sm font-medium text-white transition-all hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
                    >
                      {busy === "email" || busy === "resend" ? <Loader2 size={15} className="animate-spin" /> : <>Verify email <ArrowRight size={15} /></>}
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className={`rounded-[28px] border bg-white p-4 shadow-[0_18px_70px_rgba(15,15,15,0.045)] transition-all ${stage === "phone" ? "border-neutral-200" : "border-neutral-100"} ${stage === "email" ? "opacity-45" : "opacity-100"}`}>
            <div className="flex items-center gap-3">
              <StatusIcon done={phoneDone} active={stage === "phone"} type="phone" />
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-semibold tracking-tight ${stage === "email" ? "text-neutral-400" : "text-neutral-950"}`}>Verify phone number</div>
                <div className="truncate text-xs text-neutral-400">{phone || "phone number"}</div>
              </div>
              {phoneDone && <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-emerald-600">done</span>}
            </div>

            <div
              aria-hidden={stage !== "phone"}
              className={`grid transition-[grid-template-rows,opacity,margin] duration-500 ease-out ${stage === "phone" ? "mt-5 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"}`}
            >
              <div className="min-h-0 overflow-hidden">
                {stage === "phone" && (
                  <>
                    <CodeInput inputRef={phoneCodeRef} onEnter={verifyPhone} disabled={busy !== null} />
                    <button
                      onClick={verifyPhone}
                      disabled={busy !== null}
                      className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-[17px] bg-neutral-950 text-sm font-medium text-white transition-all hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
                    >
                      {busy === "phone" ? <Loader2 size={15} className="animate-spin" /> : <>Verify phone <ArrowRight size={15} /></>}
                    </button>
                    <button
                      onClick={sendPhoneCode}
                      disabled={busy !== null}
                      className="mt-3 w-full text-center text-xs text-neutral-400 transition-colors hover:text-neutral-900 disabled:opacity-40"
                    >
                      Send a new phone code
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>

        {error && <p className="mt-4 text-center text-xs text-red-500">{error}</p>}
      </div>
    </main>
  );
}
