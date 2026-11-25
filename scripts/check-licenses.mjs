import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const inventory = path.join(root, "THIRD-PARTY-LICENSES.txt");
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const reviewed = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause"]);
const counts = new Map();
const lines = [
  "FolioWeft | Locked npm dependencies",
  "Each entry identifies an installation path, package version and declared SPDX license.",
  "Indented entries identify the package's copyright/license files by SHA-256 and path.",
  "Keep the original notices and license texts when redistributing dependencies.",
  "",
];

async function collectNotices(directory, relative = "") {
  const files = [];
  for (const item of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name);
    if (item.isDirectory() && item.name !== "node_modules") {
      files.push(...await collectNotices(directory, name));
    } else if (item.isFile() && /^(licen[sc]es?|copying|notice|copyright)(?:$|[._-])/i.test(item.name)) {
      files.push(name);
    }
  }
  return files;
}

for (const location of Object.keys(lock.packages).filter(Boolean).sort()) {
  const expected = lock.packages[location];
  const directory = path.join(root, location);
  const installed = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  assert.equal(installed.version, expected.version, location);
  assert.equal(installed.license, expected.license, location);
  assert.ok(reviewed.has(installed.license), "Review new license for " + location);
  const files = (await collectNotices(directory)).sort();
  assert.ok(files.length, "Missing license file for " + location);
  lines.push(location + " | " + installed.name + "@" + installed.version + " | " + installed.license);
  for (const file of files) {
    const bytes = await readFile(path.join(directory, file));
    assert.ok(bytes.length, "Empty notice in " + location + "/" + file);
    lines.push("  " + createHash("sha256").update(bytes).digest("hex") + "  " + file);
  }
  counts.set(installed.license, (counts.get(installed.license) || 0) + 1);
}

const rendered = lines.join("\n") + "\n";
if (process.argv[2] === "--write") await writeFile(inventory, rendered);
else assert.equal((await readFile(inventory, "utf8")).replaceAll("\r\n", "\n"), rendered, "License inventory changed");
console.log("Installed dependencies checked:", Object.fromEntries(counts));
