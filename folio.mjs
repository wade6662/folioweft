// Local CLI entry point. The current working directory identifies the project.
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`node folio.mjs                            List active topics
node folio.mjs progress --topic NAME      Read the current plan
node folio.mjs progress --state dropped   List abandoned plans
node folio.mjs set-progress --topic NAME --state active --plan TEXT
For updates, add --version N --reason TEXT. States: active, done, dropped.
The default database is ./folioweft.sqlite. Override with --local-db PATH.`);
} else {
  if (!args.length || args[0].startsWith("--")) process.argv.splice(2,0,"progress");
  if (!args.includes("--local-db")) process.argv.push("--local-db","./folioweft.sqlite");
  await import("./src/team-memory-cli.mjs");
}
