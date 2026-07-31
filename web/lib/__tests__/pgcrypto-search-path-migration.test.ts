import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const conversationSql = readFileSync(
  resolve(process.cwd(), "migrations/033_voice_conversation_event_log.sql"),
  "utf8"
);
const durableWorkerSql = readFileSync(
  resolve(process.cwd(), "migrations/032_durable_voice_workers.sql"),
  "utf8"
);
const workerSql = readFileSync(
  resolve(process.cwd(), "migrations/034_governed_voice_worker_transitions.sql"),
  "utf8"
);
const upgradeSql = readFileSync(
  resolve(process.cwd(), "migrations/040_pgcrypto_function_search_path.sql"),
  "utf8"
);
const workerAclSql = readFileSync(
  resolve(process.cwd(), "migrations/042_voice_worker_function_acl.sql"),
  "utf8"
);

describe("pgcrypto SECURITY DEFINER search-path upgrade", () => {
  it("supports stock public and hosted extensions pgcrypto layouts on fresh installs", () => {
    expect(conversationSql).toMatch(
      /append_voice_conversation_events[\s\S]*SET search_path = pg_catalog, extensions, public/
    );
    expect(durableWorkerSql.match(/SET search_path = pg_catalog, extensions, public/g))
      .toHaveLength(7);
    expect(workerSql.match(/SET search_path = pg_catalog, extensions, public/g)).toHaveLength(2);
  });

  it("upgrades every existing canonical-event hashing function in place", () => {
    expect(upgradeSql).toMatch(
      /ALTER FUNCTION public\.append_voice_conversation_events\(\s*uuid, uuid, text, text, text\s*\) SET search_path = pg_catalog, extensions, public/
    );
    for (const functionName of [
      "append_voice_worker_event",
      "spawn_voice_worker_job",
      "claim_voice_worker_job",
      "mark_voice_worker_dispatch_started",
      "checkpoint_voice_worker_job",
      "request_voice_worker_cancellation",
      "settle_voice_worker_job",
    ]) {
      expect(upgradeSql).toMatch(new RegExp(
        `ALTER FUNCTION public\\.${functionName}\\([\\s\\S]*?\\) SET search_path = pg_catalog, extensions, public`
      ));
    }
    expect(upgradeSql).toMatch(
      /ALTER FUNCTION public\.spawn_governed_voice_worker\([\s\S]*\) SET search_path = pg_catalog, extensions, public/
    );
    expect(upgradeSql).toMatch(
      /ALTER FUNCTION public\.apply_governed_voice_worker_result\([\s\S]*\) SET search_path = pg_catalog, extensions, public/
    );
  });

  it("removes migration-default backend access before restoring exact worker capabilities", () => {
    expect(workerAclSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.heartbeat_voice_worker_job\(uuid,uuid,integer\) FROM %I/
    );
    expect(workerAclSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.heartbeat_voice_worker_job\(uuid,uuid,integer\) TO hacc_worker/
    );
    expect(workerAclSql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.heartbeat_voice_worker_job\(uuid,uuid,integer\) TO hacc_backend/
    );
    expect(workerAclSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ensure_voice_conversation\(uuid,uuid,uuid,integer,uuid\) TO hacc_backend/
    );
  });
});
