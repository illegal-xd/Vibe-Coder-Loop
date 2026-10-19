#!/usr/bin/env bash
# verify-symlinks.sh — 校验 Vibe Kernel 软链链路与资源可达性
# 用法: bash scripts/verify-symlinks.sh
set -uo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0; WARN=0

ok()   { echo "✅ $1"; PASS=$((PASS+1)); }
fail() { echo "❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "⚠️  $1"; WARN=$((WARN+1)); }

echo "=== Vibe Kernel 软链校验 ==="
echo "项目根: $PROJ"
echo

# 1. 直接软链（~/.agents/skills/* 与 ~/.config/opencode/agents/Vibe Coder.md）
LINKS=(
  "$HOME/.agents/skills/vibe-coder-loop|$PROJ/skills/vibe-coder-loop"
  "$HOME/.agents/skills/delx-memory-protocol|$PROJ/skills/delx-memory-protocol"
  "$HOME/.agents/skills/skill-authoring|$PROJ/skills/skill-authoring"
  "$HOME/.config/opencode/agents/Vibe Coder.md|$PROJ/kernel/Vibe Coder.md"
)
for entry in "${LINKS[@]}"; do
  link="${entry%%|*}"; exp="${entry#*|}"
  if [ ! -L "$link" ]; then fail "非软链: $link"; continue; fi
  real="$(readlink -f "$link" 2>/dev/null)"
  if [ "$real" = "$exp" ]; then ok "$link → $real"
  else fail "$link 解析到 '$real'，期望 '$exp'"; fi
done

# 2. opencode 二级相对软链（应解析到本项目）
for name in vibe-coder-loop delx-memory-protocol skill-authoring; do
  link="$HOME/.config/opencode/skills/$name"
  if [ ! -L "$link" ]; then fail "非软链: $link"; continue; fi
  real="$(readlink -f "$link" 2>/dev/null)"
  case "$real" in "$PROJ/skills/$name") ok "$link → $real";; *) fail "$link 解析到 '$real'";; esac
done

# 3. 关键文件经软链可读
for f in "$HOME/.agents/skills/vibe-coder-loop/SKILL.md" \
         "$HOME/.agents/skills/delx-memory-protocol/SKILL.md" \
         "$HOME/.agents/skills/skill-authoring/SKILL.md" \
         "$HOME/.config/opencode/agents/Vibe Coder.md"; do
  if [ -r "$f" ]; then ok "可读: $f"; else fail "不可读: $f"; fi
done

# 4. smoke-check-core 经 \$HOME 软链可达
core="$HOME/.agents/skills/skill-authoring/scripts/smoke-check-core.sh"
if [ -f "$core" ]; then ok "smoke-check-core 可达: $core"; else fail "smoke-check-core 不可达"; fi

# 5. 项目内关键文件存在
for f in "$PROJ/kernel/Vibe Coder.md" \
         "$PROJ/skills/vibe-coder-loop/SKILL.md" \
         "$PROJ/skills/vibe-coder-loop/manifest.yaml" \
         "$PROJ/skills/vibe-coder-loop/kernel.md" \
         "$PROJ/skills/vibe-coder-loop/policy/safety.md" \
         "$PROJ/skills/delx-memory-protocol/SKILL.md" \
         "$PROJ/skills/delx-memory-protocol/protocol.md" \
         "$PROJ/skills/skill-authoring/SKILL.md" \
         "$PROJ/skills/skill-authoring/scripts/smoke-check-core.sh"; do
  if [ -f "$f" ]; then ok "存在: ${f#$PROJ/}"; else fail "缺失: ${f#$PROJ/}"; fi
done

# 6. 项目内无断链（排除与本次无关的 gork-gen-images）
echo
echo "--- 项目内软链检查 ---"
broken=$(find "$PROJ" -type l ! -exec test -e {} \; -print 2>/dev/null)
if [ -z "$broken" ]; then ok "项目内无断链"; else fail "项目内断链: $broken"; fi

# 7. 本次相关软链无断链
echo
echo "--- 本次相关软链断链检查 ---"
related_broken=$(find "$HOME/.agents/skills/vibe-coder-loop" "$HOME/.agents/skills/delx-memory-protocol" "$HOME/.agents/skills/skill-authoring" "$HOME/.config/opencode/skills/vibe-coder-loop" "$HOME/.config/opencode/skills/delx-memory-protocol" "$HOME/.config/opencode/skills/skill-authoring" -maxdepth 0 -type l ! -exec test -e {} \; -print 2>/dev/null)
if [ -z "$related_broken" ]; then ok "本次相关软链均有效"; else fail "相关断链: $related_broken"; fi

# 预存在的无关断链（仅提示）
if [ ! -e "$HOME/.agents/skills/gork-gen-images" ] && [ -L "$HOME/.config/opencode/skills/gork-gen-images" ]; then
  warn "预存在无关断链（非本次）: ~/.config/opencode/skills/gork-gen-images"
fi

echo
echo "=== 汇总 ==="
echo "PASS=$PASS  FAIL=$FAIL  WARN=$WARN"
[ "$FAIL" -eq 0 ] && echo "结论: 迁移校验通过" || echo "结论: 存在失败项，请排查"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
