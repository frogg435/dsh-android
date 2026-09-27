// Relocate the Termux prefix inside installed *text* files.
//
// Shebangs are only one place the build-time prefix leaks into a package.
// Python for example bakes it into sysconfig data (INCLUDEPY/LIBDIR/LDSHARED),
// the config Makefile, and a few stdlib modules (subprocess' unix_shell,
// tempfile's candidate dirs), which breaks shell=True and C extension builds.
//
// var/ is deliberately excluded: it holds the dpkg database whose ledgers are
// known to work as-is, and rewriting them would change removal semantics.
import fs from "node:fs";
import path from "node:path";

const PREFIX = "/data/user/0/com.dsh.launcher/files/usr";
const OLD = "/data/data/com.termux/files/usr";
const ROOTS = ["bin", "lib", "libexec", "share", "include", "etc"];
const MAX = 8 * 1024 * 1024;

let scanned = 0, fixed = 0, hits = 0;

/** Rewrite the baked-in prefix inside one file, if it is relocatable text. */
function fixFile(p) {
  let st;
  try { st = fs.statSync(p); } catch { return; }
  if (!st.isFile() || st.size === 0 || st.size > MAX) return;
  scanned++;
  let b;
  try { b = fs.readFileSync(p); } catch { return; }
  if (b.includes(0)) return;               // binary: handled by relocate-elfs
  if (!b.includes(OLD)) return;
  const s = b.toString("latin1");
  const n = s.split(OLD).length - 1;
  try { fs.writeFileSync(p, Buffer.from(s.split(OLD).join(PREFIX), "latin1"), { mode: st.mode & 0o7777 }); }
  catch { return; }
  fixed++; hits += n;
}

function walk(dir, depth) {
  if (depth > 14) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (e.isFile()) fixFile(p);
  }
}

// The dpkg wrapper pipes the transaction's changed files in on stdin; the full
// prefix sweep below only runs for a bare invocation. See relocate-elfs.mjs.
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
  for (const r of ROOTS) walk(path.join(PREFIX, r), 0);
}
console.log(`relocate-text: scanned ${scanned}, fixed ${fixed} files, ${hits} substitutions`);
