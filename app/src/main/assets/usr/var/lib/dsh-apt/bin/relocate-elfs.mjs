// In-place relocation of the Termux prefix baked into ELF binaries.
//
// Every Termux binary carries DT_RUNPATH="/data/data/com.termux/files/usr/lib",
// another app's private directory, so the linker cannot find the shared
// libraries and every binary otherwise needs LD_LIBRARY_PATH as a workaround.
//
// "/data/data/com.termux/files/usr" and "/data/data/com.dsh.launcher/dpk" are
// both exactly 31 bytes, so the substitution is length-preserving and can be
// done directly in .dynstr without restructuring the ELF. The dpk directory
// mirrors this prefix (bin, lib, etc, var are symlinks into it).
import fs from "node:fs";
import path from "node:path";

const PREFIX = "/data/user/0/com.dsh.launcher/files/usr";
const OLD = Buffer.from("/data/data/com.termux/files/usr");
const NEW = Buffer.from("/data/data/com.dsh.launcher/dpk");
if (OLD.length !== NEW.length) throw new Error("length mismatch");

let scanned = 0, patched = 0, hits = 0;

/** Relocate one path if it is an ELF carrying the old prefix. */
function patchFile(p) {
  scanned++;
  let fd;
  try { fd = fs.openSync(p, "r"); } catch { return; }
  const magic = Buffer.alloc(4);
  let n = 0;
  try { n = fs.readSync(fd, magic, 0, 4, 0); } catch {}
  fs.closeSync(fd);
  if (n < 4 || magic.toString("latin1") !== "\x7fELF") return;
  let st;
  try { st = fs.statSync(p); } catch { return; }
  let b;
  try { b = fs.readFileSync(p); } catch { return; }
  let i = 0, c = 0;
  while ((i = b.indexOf(OLD, i)) !== -1) { NEW.copy(b, i); i += OLD.length; c++; }
  if (!c) return;
  try { fs.writeFileSync(p, b, { mode: st.mode & 0o7777 }); patched++; hits += c; }
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
    if (e.isFile()) patchFile(p);
  }
}

// A full prefix walk scans ~2400 files and re-reads every ELF, which dominated
// install time when the dpkg wrapper ran this after each package. dpkg already
// knows exactly which files a transaction touched, so it pipes that list in and
// we only touch those. No stdin (run by hand) still does the full sweep.
const only = fs.readFileSync(0, "utf8");
if (only.trim()) {
  for (const line of only.split("\n")) {
    const rel = line.trim();
    if (!rel) continue;
    // Accept both absolute paths (find output) and paths relative to the shim
    // root (dpkg reports), but never escape PREFIX.
    const abs = rel.startsWith("/") ? rel : path.resolve(PREFIX, rel.replace(/^\.\//, ""));
    if (!abs.startsWith(PREFIX + path.sep)) continue;
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile()) patchFile(abs);
  }
} else {
  walk(PREFIX, 0);
}
console.log(`relocate-elfs: scanned ${scanned}, patched ${patched} ELF files, ${hits} substitutions`);
