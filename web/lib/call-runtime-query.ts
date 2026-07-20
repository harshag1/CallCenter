/**
 * Runtime flow/tool state must come from the immutable version stamped on the call.
 * Never replace this join with agents.active_version: doing so invalidates experiments and
 * lets an unrelated activation change a conversation that is already in progress.
 */
export const CALL_RUNTIME_SNAPSHOT_QUERY = `
  SELECT c.status, c.runtime_snapshot, c.runtime_digest,
         COALESCE(c.runtime_snapshot->'flow', v.flow, f.flow) AS flow,
         v.tool_ids
  FROM calls c
  JOIN agents a ON a.id = c.agent_id
  JOIN agent_versions v ON v.agent_id = c.agent_id AND v.version = c.agent_version
  LEFT JOIN flows f ON f.id = c.flow_id AND f.org_id = a.org_id
  WHERE c.agent_id = $1 AND a.org_id = $2 AND c.id = $3
`;
