import { createHash } from "node:crypto";
import { parseRecordDocument } from "./team-memory-client.mjs";

export const progressStates = ["active", "done", "dropped"];
const prefix = "decisions-project-progress-";

function topicName(topic) {
  if (typeof topic !== "string" || !topic.trim() || /[\r\n]/.test(topic) || topic.length > 100)
    throw Error("Provide a single-line topic of 1 to 100 characters");
  return topic.trim().normalize("NFC");
}

function recordId(topic) {
  return prefix + createHash("sha256").update(topic.toLowerCase()).digest("hex").slice(0,24);
}

function decode(row) {
  return { ...JSON.parse(parseRecordDocument(row.content).body), version:row.version ?? row.current_version };
}

export async function getProgress(client, {topic, state, version} = {}) {
  if (state !== undefined && ![...progressStates,"all"].includes(state)) throw Error("Invalid progress state");
  if (topic !== undefined) {
    if (state !== undefined) throw Error("Use state to filter the topic list");
    const id = recordId(topicName(topic));
    const head = await client._findSkillBySlug(id);
    if (!head) throw Error("Unknown progress topic");
    const latest = decode(head);
    if (version === undefined || version === latest.version) return {...latest,is_current:true,current_version:latest.version};
    if (!Number.isInteger(version) || version < 1) throw Error("Invalid progress revision");
    const row = await client.postCore("/v3/skill/get",{team_id:client.teamId,agent_id:head.owner_agent_id || client.agentId,
      skill_id:head.skill_id, version, include_content:true});
    if (row.skill_id !== head.skill_id || row.version !== version) throw Error("Requested progress revision unavailable");
    return {...decode(row),is_current:false,current_version:latest.version};
  }
  if (version !== undefined) throw Error("Select a topic to read a revision");
  const filter = state ?? "active";
  const catalog = await client.listRecords(prefix,{teamOnly:true});
  const items = [];
  for (const item of catalog.items) {
    const match = /^\[(active|done|dropped)\] (.+)$/.exec(item.description);
    if (match && (filter === "all" || filter === match[1]))
      items.push({topic:match[2],state:match[1],version:item.version});
  }
  return {items};
}

export async function setProgress(client, {topic, state, plan, reason = "", expected_version} = {}) {
  const label = topicName(topic);
  if (!progressStates.includes(state) || typeof plan !== "string" || !plan.trim() || typeof reason !== "string")
    throw Error("Supply a state and a non-empty plan");
  const id = recordId(label);
  const head = await client._findSkillBySlug(id);
  const current = head && decode(head);
  const entry = {topic:current?.topic ?? label,state,plan:plan.trim(),reason:reason.trim()};
  if (current && current.state === state && current.plan === entry.plan && current.reason === entry.reason) return current;
  if ((expected_version ?? 0) !== (current?.version ?? 0)) throw Error("Read current progress and supply expected_version");
  if ((current || state === "dropped") && !entry.reason) throw Error("Explain why the progress changed");
  const saved = await client.writeRecord({recordPath:id, snapshot:head ? {...head,version:current.version} : null,
    summary:"["+state+"] "+entry.topic, content:JSON.stringify(entry), status:"confirmed"});
  return {...entry,version:saved.core_version};
}
