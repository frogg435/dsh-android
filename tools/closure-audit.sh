#!/data/data/com.termux/files/usr/bin/bash
# Fixed-point shared-library audit for the baked prefix.
# Every DT_NEEDED of every ELF must resolve to a shipped file, a manifest
# symlink whose target ships, a runtime/lib entry, or a system library.
A="${1:-/data/data/com.termux/files/home/dsh-apk/app/src/main/assets}"
declare -A AVAIL      # name -> path (assets/usr/lib or runtime/lib)
for d in "$A/usr/lib" "$A/runtime/lib"; do
  for f in "$d"/*; do [ -e "$f" ] && AVAIL[$(basename "$f")]="$f"; done
done
declare -A LINKS      # link name -> target
while IFS=$'\t' read -r p t; do
  case "$p" in lib/*) LINKS[$(basename "$p")]="$t" ;; esac
done < "$A/usr-links.txt"

SYS="libc.so libdl.so libm.so liblog.so libandroid.so libstdc++.so libc++_shared.so libz.so.1"
is_sys() { for s in $SYS; do [ "$1" = "$s" ] && return 0; done; return 1; }

declare -A SEEN MISSING
queue=()
for f in "$A"/usr/bin/* "$A"/usr/lib/* "$A"/usr/libexec/*/*; do
  [ -f "$f" ] || continue
  case "$(head -c4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' ')" in 7f454c46) queue+=("$f");; esac
done
echo "  起点 ELF: ${#queue[@]}"

while [ ${#queue[@]} -gt 0 ]; do
  f="${queue[0]}"; queue=("${queue[@]:1}")
  for lib in $(readelf -d "$f" 2>/dev/null | grep NEEDED | sed 's/.*\[\(.*\)\]/\1/'); do
    [ -n "${SEEN[$lib]:-}" ] && continue
    SEEN[$lib]=1
    if [ -n "${AVAIL[$lib]:-}" ]; then queue+=("${AVAIL[$lib]}"); continue; fi
    if [ -n "${LINKS[$lib]:-}" ]; then
      tgt="${LINKS[$lib]}"
      if [ -n "${AVAIL[$tgt]:-}" ]; then queue+=("${AVAIL[$tgt]}"); else MISSING["$lib (link→$tgt 目标不存在)"]=1; fi
      continue
    fi
    is_sys "$lib" && continue
    MISSING["$lib"]=1
  done
done
echo "  解析到 ${#SEEN[@]} 个唯一 so 名"
if [ ${#MISSING[@]} -eq 0 ]; then echo "  ✅ 闭包完整"; else
  echo "  ❌ 缺失 ${#MISSING[@]} 个:"
  for m in "${!MISSING[@]}"; do echo "    $m"; done
fi

# aapt2 treats "x" and "x.gz" as the same asset, so a snapshot containing both
# fails the build with "Duplicate resources". Only one may ship.
A="${1:-/data/data/com.termux/files/home/dsh-apk/app/src/main/assets}"
conflicts=0
while IFS= read -r g; do
  b="${g%.gz}"
  [ -f "$b" ] && { echo "  ⚠️ gz 冲突: ${b#$A/} (与 $g)"; conflicts=$((conflicts+1)); }
done < <(find "$A/usr" -type f -name '*.gz' 2>/dev/null)
[ "$conflicts" -eq 0 ] && echo "  ✅ 无 .gz 资源冲突"
