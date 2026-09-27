import fs from "node:fs";
const P = "/data/user/0/com.dsh.launcher/files/usr";
const INFO = P + "/var/lib/dpkg/info";
const OLD = "/data/data/com.termux/files/usr";
let total = 0, phantom = [], partial = [], complete = 0;
for (const f of fs.readdirSync(INFO)) {
  if (!f.endsWith(".list")) continue;
  const pkg = f.slice(0, -5);
  total++;
  let lines;
  try { lines = fs.readFileSync(INFO + "/" + f, "utf8").split("\n").filter(Boolean); } catch { continue; }
  const files = lines.map(l => l.startsWith(OLD) ? P + l.slice(OLD.length) : l)
                     .filter(l => l.startsWith(P + "/"));
  let exists = 0;
  for (const p of files) { try { fs.lstatSync(p); exists++; } catch {} }
  if (files.length === 0) continue;
  if (exists === 0) phantom.push(pkg);
  else if (exists < files.length) partial.push([pkg, exists, files.length]);
  else complete++;
}
console.log(`packages with a ledger : ${total}`);
console.log(`fully present          : ${complete}`);
console.log(`partially present      : ${partial.length}`);
console.log(`completely missing     : ${phantom.length}`);
console.log();
console.log("fully missing:", phantom.join(" "));
console.log();
console.log("partial (pkg present/total):");
for (const [p, e, t] of partial.sort((a,b)=>a[1]/a[2]-b[1]/b[2]).slice(0,15)) console.log(`  ${p.padEnd(24)} ${e}/${t}`);
