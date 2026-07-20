import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  clientConfigs: [] as unknown[],
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("pg", () => ({
  Client: class {
    constructor(config: unknown) {
      mocks.clientConfigs.push(config);
    }

    connect() {
      return mocks.connect();
    }

    query(text: string) {
      return mocks.query(text);
    }

    end() {
      return mocks.end();
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      mocks.on(event, listener);
      return this;
    }
  },
}));

import { GET } from "../../app/api/events/stream/route";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

describe("GET /api/events/stream database configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientConfigs.length = 0;
    mocks.getSession.mockResolvedValue({ orgId: ORG_ID });
    mocks.connect.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.end.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("opens the LISTEN client with stock DATABASE_URL and DATABASE_SSL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost/app");
    vi.stubEnv("SUPABASE_DB_URL", "");
    vi.stubEnv("DATABASE_SSL", "disable");

    const response = await GET(new Request("http://localhost/api/events/stream"));

    expect(response.status).toBe(200);
    expect(mocks.clientConfigs).toEqual([{
      connectionString: "postgresql://user:pass@localhost/app",
      ssl: false,
    }]);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith("LISTEN org_events");
    await response.body?.cancel();
  });

  it("keeps the Supabase URL and bundled CA fallback working", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("SUPABASE_DB_URL", "postgresql://user:pass@db.supabase.example/app");
    vi.stubEnv("DATABASE_SSL", "verify-full");
    vi.stubEnv("DATABASE_CA_CERT", undefined);

    const response = await GET(new Request("https://voice.example.test/api/events/stream"));

    expect(response.status).toBe(200);
    expect(mocks.clientConfigs).toEqual([{
      connectionString: "postgresql://user:pass@db.supabase.example/app",
      ssl: {
        rejectUnauthorized: true,
        ca: expect.stringContaining("BEGIN CERTIFICATE"),
      },
    }]);
    await response.body?.cancel();
  });

  it("fails closed before constructing a client when TLS policy is unsafe", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example.test/app");
    vi.stubEnv("DATABASE_SSL", "disable");

    const response = await GET(new Request("https://voice.example.test/api/events/stream"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "stream unavailable" });
    expect(mocks.clientConfigs).toEqual([]);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("authenticates before resolving database credentials", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("SUPABASE_DB_URL", undefined);

    const response = await GET(new Request("https://voice.example.test/api/events/stream"));

    expect(response.status).toBe(401);
    expect(mocks.clientConfigs).toEqual([]);
  });
});
