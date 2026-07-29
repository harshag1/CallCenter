import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  listToolsForAudience: vi.fn(),
  callToolForAudience: vi.fn(),
  inferenceComplete: vi.fn(),
  inferenceAuthority: Object.freeze({ budgetSnapshot: vi.fn() }),
  createInferenceAuthority: vi.fn(),
  createInferenceRuntime: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("../mcp", () => ({
  listToolsForAudience: mocks.listToolsForAudience,
  callToolForAudience: mocks.callToolForAudience,
}));
vi.mock("../server-inference", () => ({
  createServerInferenceAuthority: mocks.createInferenceAuthority,
  createServerInferenceRuntime: mocks.createInferenceRuntime,
}));
vi.mock("../log", () => ({
  log: () => ({ info: mocks.info, error: mocks.error }),
}));

import { runCallTask } from "../tasks";

const task = {
  id: "8916eb0a-5332-4f4c-a330-746c516e83c1",
  call_id: "8916eb0a-5332-4f4c-a330-746c516e83c2",
  org_id: "8916eb0a-5332-4f4c-a330-746c516e83c3",
  agent_id: "8916eb0a-5332-4f4c-a330-746c516e83c4",
  command: "Read the approved records and report.",
  attempts: 1,
};

function arrangeTask(): void {
  mocks.qOne
    .mockResolvedValueOnce(task)
    .mockResolvedValueOnce({
      direction: "inbound",
      from_number: null,
      to_number: null,
      status: "completed",
      summary: null,
    })
    .mockResolvedValueOnce({ name: "Fixture Org" });
  mocks.q.mockResolvedValue([]);
  mocks.listToolsForAudience.mockResolvedValue([{
    name: "search_knowledge",
    description: "Search approved knowledge.",
    inputSchema: { type: "object", properties: {} },
  }]);
  mocks.createInferenceAuthority.mockReturnValue(mocks.inferenceAuthority);
  mocks.createInferenceRuntime.mockReturnValue({ complete: mocks.inferenceComplete });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("legacy background task spend boundary", () => {
  it("terminalizes the first execution failure and never authorizes a scheduler retry", async () => {
    arrangeTask();
    mocks.inferenceComplete.mockRejectedValue(new Error("provider request failed"));

    await expect(runCallTask(task.id)).resolves.toBeUndefined();

    expect(String(mocks.qOne.mock.calls[0]?.[0])).toContain(
      "WHERE id = $1 AND status = 'pending'",
    );
    expect(String(mocks.qOne.mock.calls[0]?.[0])).not.toContain("status IN");
    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      [task.id, "provider request failed"],
    );
    expect(mocks.q.mock.calls.some(([sql, params]) =>
      String(sql).includes("UPDATE call_tasks")
      && Array.isArray(params)
      && params.includes("pending")
    )).toBe(false);
    expect(mocks.inferenceComplete).toHaveBeenCalledOnce();
  });

  it("shares one authority with nested reads and admits at most twelve tool calls", async () => {
    arrangeTask();
    mocks.callToolForAudience.mockResolvedValue({ results: [] });
    mocks.inferenceComplete
      .mockResolvedValueOnce({
        message: {
          content: null,
          tool_calls: Array.from({ length: 64 }, (_, index) => ({
            id: `call-${index}`,
            type: "function",
            function: { name: "search_knowledge", arguments: "{}" },
          })),
        },
      })
      .mockResolvedValueOnce({ message: { content: "bounded report" } });

    await expect(runCallTask(task.id)).resolves.toBeUndefined();

    expect(mocks.createInferenceAuthority).toHaveBeenCalledWith({
      purpose: "background_task",
      budget: {
        maxProviderRequests: 12,
        maxReservedOutputTokens: 11_400,
        maxInputBytesPerRequest: 512 * 1024,
        requestTimeoutMs: 60_000,
        operationTimeoutMs: 120_000,
        lanes: {
          generation: {
            maxProviderRequests: 6,
            maxReservedOutputTokens: 9_000,
          },
          research: {
            maxProviderRequests: 6,
            maxReservedOutputTokens: 2_400,
          },
        },
      },
    });
    expect(mocks.createInferenceRuntime).toHaveBeenCalledWith({
      purpose: "background_task",
      workload: "generation",
      authority: mocks.inferenceAuthority,
    });
    expect(mocks.callToolForAudience).toHaveBeenCalledTimes(12);
    for (const call of mocks.callToolForAudience.mock.calls) {
      expect(call[4]).toEqual({
        serverInferenceAuthority: mocks.inferenceAuthority,
      });
    }
  });
});
