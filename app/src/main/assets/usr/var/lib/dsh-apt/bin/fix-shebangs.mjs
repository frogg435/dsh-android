// Rewrite the Termux prefix baked into installed scripts.
//
// Packages ship helper scripts with shebangs like
//     #!/data/data/com.termux/files/usr/bin/python3.14
// which is another app's private dir, so exec fails. Payload scripts are never
// executed *during* installation (only maintainer scripts are), so fixing them
// right after unpack is sufficient.
import fs from "node:fs";
import path from "node:path";

const PREFIX = "/data/user/0/com.dsh.launcher/files/usr";
const OLD = "/data/data/com.termux/files/usr";
const roots = process.argv.slice(2);
const scan = roots.length ? roots
  : [PREFIX + "/bin", PREFIX + "/libexec", PREFIX + "/lib", PREFIX + "/share"];

let fixed = 0, scanned = 0;

/** Fix one script's shebang, if it has one pointing at the old prefix. */
function fixFile(p) {
  let fd;
  try { fd = fs.openSync(p, "r"); } catch { return; }
  const head = Buffer.alloc(4);
  let n = 0;
  try { n = fs.readSync(fd, head, 0, 4, 0); } catch {}
  fs.closeSync(fd);
  if (n < 2 || head[0] !== 0x23 || head[1] !== 0x21) return; // "#!"
  scanned++;
  let st;
  try { st = fs.statSync(p); } catch { return; }
  if (!st.isFile() || st.size > 8 * 1024 * 1024) return;
  let buf;
  try { buf = fs.readFileSync(p); } catch { return; }
  if (!buf.includes(OLD)) return;
  const out = Buffer.from(buf.toString("latin1").split(OLD).join(PREFIX), "latin1");
  try { fs.writeFileSync(p, out, { mode: st.mode & 0o7777 }); fixed++; }
  catch { /* read-only: skip */ }
}

function walk(dir, depth) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (e.isFile()) fixFile(p);
  }
}

// The dpkg wrapper pipes the transaction's changed files in on stdin; a bare
// run still sweeps the default roots. See relocate-elfs.mjs.
const only = fs.readFileSync(0, "utf8");
if (only.trim()) {
  for (const line of only.split("\n")) {
    const rel = line.trim();
    if (!rel) continue;
      // Absolute (find output) or PREFIX-relative (dpkg output); never escape.
      const abs = rel.startsWith("/") ? rel : path.resolve(PREFIX, rel);
      if (abs.startsWith(PREFIX + path.sep)) fixFile(abs);
  }
} else {
  for (const r of scan) walk(r, 0);
}
console.log(`fix-shebangs: scanned ${scanned}, fixed ${fixed}`);
