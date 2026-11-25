import { TeamMemoryClient } from "../src/team-memory-client.mjs";

// In-memory subset of the backend used by the regression suite and offline demo.
export function fixture() {
  const c = new TeamMemoryClient({ binding: { team_name: "fixture", team_id: "t", agent_id: "a" } });
  const rows = new Map(), calls = [];
  let core = "[[wiki/team-memory-and-traps]]";
  c.postCore = async (endpoint, p = {}) => {
    calls.push(endpoint);
    switch (endpoint) {
      case "/v3/skill/create":
      case "/v3/skill/update": {
        const id = p.name || p.skill_id;
        const old = rows.get(id);
        if (endpoint.endsWith("update") && old?.version !== p.expected_version) throw Error("HTTP 409");
        if (endpoint.endsWith("create") && old) throw Error("duplicate");
        const description = JSON.parse(p.content.match(/^description: (.+)$/m)[1]);
        const row = { version: (old?.version || 0) + 1, content: p.content, name: id, skill_id: id, description };
        rows.set(id, row);
        return { ...row };
      }
      case "/v3/skill/list": {
        const list = [...rows.values()].filter(r => !p.filters?.name_prefix || r.name.startsWith(p.filters.name_prefix));
        const { limit, offset } = p.pagination;
        return { items: list.slice(offset, offset + limit).map(({ content, ...meta }) => meta), total: list.length };
      }
      case "/v3/skill/search": return { items: [...rows.values()].filter(r => r.content.includes(p.query)).map(r => ({ skill_id: r.skill_id })) };
      case "/v3/skill/get":
      case "/v3/skill/get-by-name": {
        const row = rows.get(p.skill_id || p.skill_name);
        if (!row) throw Error("HTTP 404");
        return { ...row };
      }
      case "/v3/scenario/read": throw Error("HTTP 404");
      case "/v3/skill/delete":
        return { archived: rows.delete(p.skill_id) };
      case "/v3/conversation/add": return { accepted_ids: ["fixture"] };
      case "/v3/core/read": return { content: core, version: "1" };
      case "/v3/core/write": core = p.content; return { version: "2" };
      default: throw Error("Unexpected backend call " + endpoint);
    }
  };
  const put = (recordPath, content, opts = {}) => c.writeRecord({ recordPath, content, ...opts });
  return { c, rows, calls, put };
}
