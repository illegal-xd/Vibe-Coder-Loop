#!/usr/bin/env bash
# verify-symlinks.sh — 校验仓库资源与宿主软链
#
# 默认只检查仓库内资源，不要求宿主安装。
# 使用 --host 额外检查 ~/.agents/skills、OpenCode skills/agents 的软链。
# 兼容 macOS / Linux / Windows Git Bash / WSL；不使用非 POSIX 的 readlink 解析选项。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJ="${VIBE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"
CHECK_HOST=0
QUIET=0
PASS=0
FAIL=0
WARN=0

ok()   { PASS=$((PASS + 1)); [ "$QUIET" -eq 1 ] || printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1" >&2; }
warn() { WARN=$((WARN + 1)); [ "$QUIET" -eq 1 ] || printf 'WARN  %s\n' "$1"; }

usage() {
  cat <<'EOF'
用法: bash scripts/verify-symlinks.sh [--host] [--quiet] [--root <dir>]

默认检查：
  - 仓库关键文件存在
  - 仓库内没有断链

--host 额外检查：
  - ~/.agents/skills/<skill> 指向本仓库（或为可读复制）
  - ~/.config/opencode/skills/<skill> 可达
  - OpenCode agents 中的 Vibe Coder.md 可达

环境变量：
  AGENTS_SKILLS_DIR       默认 $HOME/.agents/skills
  OPENCODE_SKILLS_DIR     默认 $HOME/.config/opencode/skills
  OPENCODE_AGENTS_DIR     默认 $HOME/.config/opencode/agents
  VIBE_ROOT               默认脚本上级目录

退出码：0 无失败；1 存在失败；2 参数错误。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) CHECK_HOST=1 ;;
    --quiet) QUIET=1 ;;
    --root) shift; PROJ="${1:-}" ;;
    --root=*) PROJ="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$PROJ" ] || [ ! -d "$PROJ" ]; then
  printf '仓库目录不存在：%s\n' "${PROJ:-<empty>}" >&2
  exit 2
fi
PROJ="$(cd "$PROJ" && pwd -P)" || exit 2

# 解析软链（兼容 POSIX）；目标不存在时仍返回物理路径。
resolve_path() {
  local p="$1" target dir n=0
  while [ -L "$p" ]; do
    n=$((n + 1))
    [ "$n" -gt 40 ] && return 1
    target="$(readlink "$p" 2>/dev/null)" || return 1
    case "$target" in
      /*) p="$target" ;;
      *) p="$(dirname "$p")/$target" ;;
    esac
  done
  dir="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s' "$dir" "$(basename "$p")"
}

check_repo_files() {
  local f
  for f in \
    "kernel/Vibe Coder.md" \
    "skills/vibe-coder-loop/SKILL.md" \
    "skills/vibe-coder-loop/manifest.yaml" \
    "skills/vibe-coder-loop/kernel.md" \
    "skills/vibe-coder-loop/policy/safety.md" \
    "skills/vibe-coder-loop/engine/state-machine.md" \
    "skills/vibe-coder-loop/.state.template.md" \
    "skills/delx-memory-protocol/SKILL.md" \
    "skills/delx-memory-protocol/protocol.md" \
    "skills/skill-authoring/SKILL.md" \
    "skills/skill-authoring/scripts/smoke-check-core.sh" \
    "scripts/audit.sh" \
    "docs/installation.md" \
    "docs/audits/compatibility.md"; do
    if [ -f "$PROJ/$f" ]; then ok "存在: $f"; else bad "缺失: $f"; fi
  done
}

check_repo_symlinks() {
  local link target count=0
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    count=$((count + 1))
    if [ ! -e "$link" ]; then
      target="$(readlink "$link" 2>/dev/null || true)"
      bad "仓库内断链: ${link#"$PROJ"/} -> ${target:-<unreadable>}"
    else
      ok "仓库内软链有效: ${link#"$PROJ"/}"
    fi
  done < <(find "$PROJ" -path "$PROJ/.git" -prune -o -type l -print 2>/dev/null)
  [ "$count" -eq 0 ] && ok "仓库内无软链"
}

check_host_link() {
  local link="$1" expected="$2" label="$3" resolved
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    warn "$label 未安装: $link"
    return 0
  fi
  if [ ! -L "$link" ]; then
    warn "$label 不是软链（复制安装可忽略）: $link"
    [ -r "$link" ] && ok "$label 可读: $link"
    return 0
  fi
  if [ ! -e "$link" ]; then
    bad "$label 断链: $link"
    return 0
  fi
  resolved="$(resolve_path "$link" 2>/dev/null || true)"
  if [ -n "$expected" ] && [ "$resolved" = "$expected" ]; then
    ok "$label -> $resolved"
  elif [ -n "$resolved" ]; then
    warn "$label 指向 $resolved（期望 $expected）"
  else
    bad "$label 无法解析: $link"
  fi
}

check_host() {
  local agents skills agents_dir name core
  if [ -z "${HOME:-}" ] && [ -z "${AGENTS_SKILLS_DIR:-}" ] && [ -z "${OPENCODE_SKILLS_DIR:-}" ] && [ -z "${OPENCODE_AGENTS_DIR:-}" ]; then
    warn "HOME 未设置，跳过宿主检查"
    return 0
  fi

  agents="${AGENTS_SKILLS_DIR:-${HOME:-}/.agents/skills}"
  skills="${OPENCODE_SKILLS_DIR:-${HOME:-}/.config/opencode/skills}"
  agents_dir="${OPENCODE_AGENTS_DIR:-${HOME:-}/.config/opencode/agents}"

  if [ ! -d "$agents" ] && [ ! -d "$skills" ] && [ ! -d "$agents_dir" ]; then
    warn "未检测到宿主目录，跳过 --host 检查"
    return 0
  fi

  for name in vibe-coder-loop delx-memory-protocol skill-authoring; do
    check_host_link "$agents/$name" "$PROJ/skills/$name" "Skill $name"
    check_host_link "$skills/$name" "$PROJ/skills/$name" "OpenCode Skill $name"
  done
  check_host_link "$agents_dir/Vibe Coder.md" "$PROJ/kernel/Vibe Coder.md" "Agent Prompt"

  core="$agents/skill-authoring/scripts/smoke-check-core.sh"
  if [ -f "$core" ]; then ok "smoke-check-core 可达: $core"; else warn "smoke-check-core 不可达（未安装或复制路径不同）"; fi
}

printf '=== Vibe Kernel 资源校验 ===\n'
printf '项目根: %s\n' "$PROJ"
check_repo_files
check_repo_symlinks
[ "$CHECK_HOST" -eq 1 ] && check_host

printf '\n=== 汇总 ===\n'
printf 'PASS=%s  FAIL=%s  WARN=%s\n' "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -eq 0 ]; then
  printf '结论: 通过\n'
  exit 0
else
  printf '结论: 存在失败项，请排查\n'
  exit 1
fi
