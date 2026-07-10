import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { providerCatalog } from "@/lib/realtime/registry";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    providers: providerCatalog().map((provider) => ({
      ...provider,
      configured: provider.env.every((name) => Boolean(process.env[name])),
      missingEnv: provider.env.filter((name) => !process.env[name]),
    })),
  });
}
