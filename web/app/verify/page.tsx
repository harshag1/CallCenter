// Author: Harsha Gundala
// verify — staged email then phone verification before the describe-agent builder.

"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Loader2, Mail, Phone, RotateCw } from "lucide-react";

type Stage = "email" | "phone" | "done";

function readParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get(name) ?? "";
}

function CodeInput({
  inputRef,
  onEnter,
  disabled,
  shaking,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onEnter: () => void;
  disabled?: boolean;
  shaking?: boolean;
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
      className={`w-full bg-transparent text-center text-[26px] font-semibold tracking-[0.18em] outline-none placeholder:text-neutral-200 disabled:text-neutral-300 ${shaking ? "animate-jiggle" : ""}`}
    />
  );
}

function StatusIcon({ done, active, type }: { done: boolean; active: boolean; type: "email" | "phone" }) {
  if (done) {
    return <Check size={18} strokeWidth={2.3} className="shrink-0 text-emerald-600" />;
  }
  const Icon = type === "email" ? Mail : Phone;
  return <Icon size={18} strokeWidth={2} className={`shrink-0 ${active ? "text-neutral-950" : "text-neutral-300"}`} />;
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
  const [shaking, setShaking] = useState<"email" | "phone" | null>(null);
  const emailDone = stage === "phone" || stage === "done";
  const phoneDone = stage === "done";

  function jiggle(which: "email" | "phone") {
    setShaking(which);
    window.setTimeout(() => setShaking(null), 450);
  }

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
      if (!res.ok) {
        if (res.status === 401) { jiggle("email"); return; }
        throw new Error(json.error ?? "verification failed");
      }
      setStage("phone");
      // Kick the full background prep: favicon, demo flow, agent, phone number.
      void fetch("/api/onboarding/prepare", { method: "POST" }).catch(() => {});
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
      if (!res.ok) {
        if (res.status === 401) { jiggle("phone"); return; }
        throw new Error(json.error ?? "verification failed");
      }
      setStage("done");
      router.push(json.next ?? "/studio");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (stage !== "done") setBusy(null);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-[#f8f8f8] px-5 text-neutral-950">
      <header className="flex items-center justify-center gap-2.5 pt-10">
        <Phone size={17} strokeWidth={2.35} />
        <h1 className="text-[15px] font-semibold tracking-tight">Harsha&apos;s Amazing Call Center</h1>
      </header>

      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-[440px]">
          <div className="space-y-2.5">
            <section className={`rounded-[16px] border bg-white p-4 shadow-[0_8px_24px_rgba(15,15,15,0.025)] transition-all ${stage === "email" ? "border-neutral-300" : "border-neutral-200"}`}>
              <div className="flex items-center gap-3">
                <StatusIcon done={emailDone} active={stage === "email"} type="email" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">{emailDone ? "Verified email" : "Verify email"}</div>
                  {!emailDone && (
                    <div className="truncate text-[12px] leading-5 text-neutral-400">{email || "work email"}</div>
                  )}
                </div>
              </div>

              <div
                aria-hidden={stage !== "email"}
                className={`grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out ${stage === "email" ? "mt-3 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"}`}
              >
                <div className="min-h-0 overflow-hidden">
                  {stage === "email" && (
                    <>
                      <CodeInput inputRef={emailCodeRef} onEnter={verifyEmail} disabled={busy !== null} shaking={shaking === "email"} />
                      <button
                        onClick={verifyEmail}
                        disabled={busy !== null}
                        className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-neutral-950 text-[14px] font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
                      >
                        {busy === "email" || busy === "resend" ? <Loader2 size={15} className="animate-spin" /> : <>Verify email <ArrowRight size={15} strokeWidth={2} /></>}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>

            <section className={`rounded-[16px] border bg-white p-4 shadow-[0_8px_24px_rgba(15,15,15,0.02)] transition-all ${stage === "phone" ? "border-neutral-300" : "border-neutral-200"} ${stage === "email" ? "opacity-45" : "opacity-100"}`}>
              <div className="flex items-center gap-3">
                <StatusIcon done={phoneDone} active={stage === "phone"} type="phone" />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[14px] font-medium ${stage === "email" ? "text-neutral-400" : "text-neutral-950"}`}>
                    {phoneDone ? "Verified phone" : `Verify ${phone || "phone"}`}
                  </div>
                </div>
              </div>

              <div
                aria-hidden={stage !== "phone"}
                className={`grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out ${stage === "phone" ? "mt-3 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"}`}
              >
                <div className="min-h-0 overflow-hidden">
                  {stage === "phone" && (
                    <>
                      <CodeInput inputRef={phoneCodeRef} onEnter={verifyPhone} disabled={busy !== null} shaking={shaking === "phone"} />
                      <button
                        onClick={verifyPhone}
                        disabled={busy !== null}
                        className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-neutral-950 text-[14px] font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
                      >
                        {busy === "phone" ? <Loader2 size={15} className="animate-spin" /> : <>Verify phone <ArrowRight size={15} strokeWidth={2} /></>}
                      </button>
                      <button
                        onClick={sendPhoneCode}
                        disabled={busy !== null}
                        className="mt-2 flex w-full items-center justify-center gap-1.5 text-center text-[12px] text-neutral-400 transition-colors hover:text-neutral-900 disabled:opacity-40"
                      >
                        <RotateCw size={11} className={busy === "resend" ? "animate-spin" : ""} /> Resend
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>
          </div>

          {error && <p className="mt-4 text-center text-xs text-red-500">{error}</p>}
        </div>
      </div>
    </main>
  );
}
