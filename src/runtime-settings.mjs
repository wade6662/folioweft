import os from "node:os";
import path from "node:path";

const home = path.join(os.homedir(), ".team-memory");
export const DEFAULT_CONFIG_PATH = process.env.TEAM_MEMORY_BINDING_FILE || path.join(home, "binding.json");
export const archiveRoot = process.env.TEAM_MEMORY_ARCHIVE_DIR || path.join(home, "archive");
// Service lifecycle belongs to the operator of the configured backend.
export async function ensureServiceUp() { return false; }
