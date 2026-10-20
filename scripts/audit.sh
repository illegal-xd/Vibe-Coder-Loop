#!/usr/bin/env bash
# Vibe Kernel 开源就绪性审计工具（只读）
#
# 默认只读取仓库内的文本文件，不访问网络，不修改仓库。
# 仅 `report` 子命令会写入报告文件（可用 --out 指定）。
#
# 兼容性：Bash 3.2+（macOS 自带）、BSD/GNU grep、POSIX find/sort/comm。
# 不使用 mapfile、关联数组、grep -P、readlink -f 或固定 /tmp 路径。

set -uo pipefail
umask 077
LC_ALL=C
export LC_ALL

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
ROOT="${AUDIT_ROOT:-$DEFAULT_ROOT}"
TMPBASE="${TMPDIR:-/tmp}"
TMPBASE="${TMPBASE%/}"
TOOL_VERSION="1.0.0"
TAB="$(printf '\t')"  # IFS 分隔用（避免在源码里写裸 tab）

SCAN_RAW=""
SCAN_ERR=""
CHECK_RAW=""
FILTERED=""
REPORT_TMP=""
TMP_BASE=""
TMP_NEW=""
TMP_ADDED=""
TMP_REMOVED=""
TMP_ADDED_HIGH=""
PATHS=()

cleanup() {
  local f
  for f in "$SCAN_RAW" "$SCAN_ERR" "$CHECK_RAW" "$FILTERED" "$REPORT_TMP" \
           "$TMP_BASE" "$TMP_NEW" "$TMP_ADDED" "$TMP_REMOVED" "$TMP_ADDED_HIGH"; do
    [ -n "$f" ] && rm -f "$f" 2>/dev/null
  done
}
trap cleanup EXIT HUP INT TERM

# ---------------------------------------------------------------------------
# 规则定义
# 格式：规则号|严重度|扩展正则|说明
# 正则中可包含 |，因此按前三个 | 切分。
# ---------------------------------------------------------------------------
RULES=(
  'P001|high|/(Users|home)/[A-Za-z0-9_.-]+#个人主目录绝对路径'
  'P002|high|(Desktop|Documents|Downloads)/#个人目录名'
  'P003|high|[A-Za-z]:\\Users\\[^\\[:space:]]+#Windows 个人用户目录'
  'P005|medium|\\\\(wsl\$|Users)[\\\\/][^[:space:]]+#WSL/UNC 个人路径'
  'P006|low|\\\\[A-Za-z0-9][A-Za-z0-9._-]*\\\\[A-Za-z0-9_$-]+#UNC 网络路径'
  'P007|high|/root/#root 用户绝对路径'
  'H001|medium|~/.pi/agent#特定宿主用户配置目录'
  'H002|info|(^|[[:space:]])Pi([[:space:]]|$)#宿主/运行时引用（需确认适配范围）'
  'S001|critical|(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----)#疑似真实凭证'
  'S002|medium|(^|[^0-9])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)#私有 IP'
  'S003|high|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#邮箱地址'
  'L001|low|readlink -f#非 POSIX readlink -f'
)

CHECK_RULES=(
  'C001|low|仓库内跟踪的软链接'
  'C002|high|仓库内断链'
  'C003|high|宿主软链接目标不存在'
  'C004|low|宿主路径不是软链（复制安装可忽略）'
  'C005|info|宿主 Skill/Prompt 未安装'
  'C006|low|Markdown 相对链接目标不存在'
  'C007|info|未检测到宿主 Skill 目录'
  'C008|high|敏感运行时/凭证文件被 Git 跟踪'
  'C009|high|记忆快照被 Git 跟踪'
  'C010|info|非 Git 工作区，跳过跟踪面检查'
)

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
is_scan_excluded() {
  case "$1" in
    .git|.git/*|.codegraph|.codegraph/*|*/node_modules/*|node_modules/*|*/dist/*|dist/*|*/build/*|build/*|*/__pycache__/*|__pycache__/*) return 0 ;;
    .DS_Store|*/Thumbs.db|Thumbs.db|*.pyc|*.pyo) return 0 ;;
    skills/vibe-coder-loop/.state.md) return 0 ;;
    skills/vibe-coder-loop/backup/snapshots/*) return 0 ;;
    docs/audits/scan-report*.md|docs/audits/*.tsv|docs/audits/*.jsonl) return 0 ;;
  esac
  return 1
}

severity_rank() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    critical) printf '5' ;;
    high) printf '4' ;;
    medium) printf '3' ;;
    low) printf '2' ;;
    info) printf '1' ;;
    *) return 1 ;;
  esac
}

severity_of_line() {
  local rest
  rest="${1#*:}"
  rest="${rest#*:}"
  rest="${rest#*:}"
  printf '%s' "${rest%%:*}"
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g'
}

redact_text() {
  sed -E \
    -e 's#/Users/[^/[:space:]]+#/Users/<user>#g' \
    -e 's#/home/[^/[:space:]]+#/home/<user>#g' \
    -e 's#([A-Za-z]:[\\/]Users[\\/])[^\\/[:space:]]+#\1<user>#g' \
    -e 's#([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})#<email>#g' \
    -e 's#(10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}#<private-ip>#g' \
    -e 's#(AKIA|gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]+#<credential>#g'
}

count_lines() {
  awk 'END{print NR+0}' "$1" 2>/dev/null
}

display_path() {
  local p="$1"
  if [ -n "${HOME:-}" ]; then
    case "$p" in
      "$HOME"/*) printf '~/%s' "${p#"$HOME"/}" ; return 0 ;;
    esac
  fi
  printf '%s' "$p"
}

add_check() {
  printf '%s:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" "$5" >> "$CHECK_RAW"
}

# ---------------------------------------------------------------------------
# 文件面
# ---------------------------------------------------------------------------
has_git() {
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

surface() {
  if has_git; then
    git -C "$ROOT" ls-files
    git -C "$ROOT" ls-files --others --exclude-standard
  else
    find "$ROOT" -type f -print0 2>/dev/null | while IFS= read -r -d '' f; do
      rel="${f#"$ROOT"/}"
      case "$rel" in
        .git/*|*/node_modules/*|node_modules/*|*/dist/*|dist/*|*/build/*|build/*|*/__pycache__/*|__pycache__/*) continue ;;
      esac
      printf '%s\n' "$rel"
    done
  fi
}

ignored_surface() {
  if has_git; then
    git -C "$ROOT" ls-files --others --ignored --exclude-standard
  fi
}

# ---------------------------------------------------------------------------
# 扫描
# ---------------------------------------------------------------------------
scan_one_rule() {
  local rule="$1"
  local sev="$2"
  local pat="$3"
  shift 3
  [ "$#" -eq 0 ] && return 0

  printf '%s\0' "$@" | xargs -0 grep -HInoE -e "$pat" 2>>"$SCAN_ERR" | \
  awk '!seen[$0]++' | \
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="${line%%:*}"
    rest="${line#*:}"
    lineno="${rest%%:*}"
    match="${rest#*:}"

    case "$rule" in
      P001|P002|P003|P005|P006|P007|H001|L001)
        case "$path" in
          scripts/audit.sh|docs/audits/audit-tool.md) continue ;;
        esac
        ;;
    esac

    case "$rule" in
      S001) reason='疑似真实凭证（值已隐藏）' ;;
      P003|P005) reason='Windows 用户路径（值已脱敏）' ;;
      P006) reason='UNC 网络路径（值已脱敏）' ;;
      S002) reason='<private-ip>' ;;
      *) reason="$(printf '%s' "$match" | redact_text | cut -c1-160)" ;;
    esac

    printf '%s:%s:%s:%s:%s\n' "$path" "$lineno" "$rule" "$sev" "$reason" >> "$SCAN_RAW"
  done
}

run_scan() {
  local all="$1"
  local rel

  SCAN_RAW="$(mktemp "$TMPBASE/vibe-audit-scan.XXXXXX")" || return 2
  SCAN_ERR="$(mktemp "$TMPBASE/vibe-audit-err.XXXXXX")" || return 2
  : > "$SCAN_RAW"
  : > "$SCAN_ERR"

  PATHS=()
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    is_scan_excluded "$rel" && continue
    [ -e "$ROOT/$rel" ] || continue
    PATHS+=("$rel")
  done < <(surface)

  if [ "$all" -eq 1 ]; then
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      is_scan_excluded "$rel" && continue
      [ -e "$ROOT/$rel" ] || continue
      PATHS+=("$rel")
    done < <(ignored_surface)
  fi

  local entry rule sev pat desc
  for entry in "${RULES[@]}"; do
    rule="${entry%%|*}"
    rest="${entry#*|}"
    sev="${rest%%|*}"
    rest="${rest#*|}"
    pat="${rest%%#*}"
    desc="${rest#*#}"
    scan_one_rule "$rule" "$sev" "$pat" ${PATHS[@]+"${PATHS[@]}"}
  done

  if [ -s "$SCAN_ERR" ]; then
    printf '[WARN] 部分文件无法读取，已跳过；前 5 条错误：\n' >&2
    sed -n '1,5p' "$SCAN_ERR" >&2
  fi
  return 0
}

filter_findings() {
  local src="$1" dest="$2" min="$3"
  local minrank sev rank line
  minrank="$(severity_rank "$min")" || { printf '[ERROR] 未知严重度：%s\n' "$min" >&2; return 2; }
  : > "$dest"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    sev="$(severity_of_line "$line")"
    rank="$(severity_rank "$sev" 2>/dev/null)" || rank=0
    if [ "$rank" -ge "$minrank" ]; then
      printf '%s\n' "$line" >> "$dest"
    fi
  done < "$src"
  return 0
}

print_findings() {
  local file="$1" format="$2"
  local line p rest ln rule sev reason
  if [ "$format" = "json" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      p="${line%%:*}"
      rest="${line#*:}"
      ln="${rest%%:*}"
      rest="${rest#*:}"
      rule="${rest%%:*}"
      rest="${rest#*:}"
      sev="${rest%%:*}"
      reason="${rest#*:}"
      printf '{"path":"%s","line":%s,"rule":"%s","severity":"%s","reason":"%s"}\n' \
        "$(json_escape "$p")" "$ln" "$(json_escape "$rule")" \
        "$(json_escape "$sev")" "$(json_escape "$reason")"
    done < "$file"
  else
    cat "$file"
  fi
}

count_at_or_above() {
  local file="$1" threshold="$2"
  local t sev rank line
  t="$(severity_rank "$threshold")" || return 2
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    sev="$(severity_of_line "$line")"
    rank="$(severity_rank "$sev" 2>/dev/null)" || rank=0
    [ "$rank" -ge "$t" ] && return 0
  done < "$file"
  return 1
}

# ---------------------------------------------------------------------------
# 结构检查
# ---------------------------------------------------------------------------
host_check_link() {
  local p="$1" label="$2" shown
  shown="$(display_path "$p")"
  if [ -L "$p" ]; then
    if [ ! -e "$p" ]; then
      add_check "$shown" 0 C003 high '软链目标不存在'
    fi
  elif [ -e "$p" ]; then
    add_check "$shown" 0 C004 low "$label 不是软链（复制安装可忽略）"
  else
    add_check "$shown" 0 C005 info "$label 未安装"
  fi
}

check_repo_symlinks() {
  local mode rest path tab
  command -v git >/dev/null 2>&1 || return 0
  has_git || return 0
  tab="$(printf '\t')"
  while IFS= read -r line; do
    mode="${line%% *}"
    [ "$mode" = "120000" ] || continue
    rest="${line#*"$tab"}"
    [ "$rest" = "$line" ] && continue
    path="$rest"
    if [ -L "$ROOT/$path" ] && [ ! -e "$ROOT/$path" ]; then
      add_check "$path" 0 C002 high '仓库内软链目标不存在'
    else
      add_check "$path" 0 C001 low '仓库内跟踪的软链接'
    fi
  done < <(git -C "$ROOT" ls-files -s)
}

check_host_links() {
  local agents skills agents_prompt name d host_any
  agents="${AGENTS_SKILLS_DIR:-${HOME:-}/.agents/skills}"
  skills="${OPENCODE_SKILLS_DIR:-${HOME:-}/.config/opencode/skills}"
  agents_prompt="${OPENCODE_AGENTS_DIR:-${HOME:-}/.config/opencode/agents}/Vibe Coder.md"

  if [ -z "${HOME:-}" ] && [ -z "${AGENTS_SKILLS_DIR:-}" ] && [ -z "${OPENCODE_SKILLS_DIR:-}" ] && [ -z "${OPENCODE_AGENTS_DIR:-}" ]; then
    add_check '~' 0 C007 info 'HOME 未设置，跳过宿主检查'
    return 0
  fi

  host_any=0
  for d in "$agents" "$skills" "${OPENCODE_AGENTS_DIR:-${HOME:-}/.config/opencode/agents}"; do
    [ -d "$d" ] && host_any=1
  done
  if [ "$host_any" -eq 0 ]; then
    add_check '~/.agents/skills' 0 C007 info '未检测到宿主 Skill 目录，跳过宿主检查'
    return 0
  fi

  for name in vibe-coder-loop delx-memory-protocol skill-authoring; do
    host_check_link "$agents/$name" "Skill $name"
    host_check_link "$skills/$name" "OpenCode Skill $name"
  done
  host_check_link "$agents_prompt" 'Agent Prompt'
}

check_markdown_links() {
  local rel link target base cand lineno
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    is_scan_excluded "$rel" && continue
    case "$rel" in *.md) ;; *) continue ;; esac
    base="$(dirname "$ROOT/$rel")"
    # 单文件一次 awk 提取「围栏外」的行内链接（行号 + 链接）：复杂度 O(文件数 × fork)，
    # 而非 O(行数 × fork)。逐行 fork 一个 grep 会在真实仓库规模下耗尽进程资源
    # （macOS Bash 3.2 实测 SIGILL + 70s+ 挂起），故一律在本文件内批量处理。
    while IFS="$TAB" read -r lineno link; do
      [ -n "$link" ] || continue
      target="${link#']('}"
      target="${target%)}"
      target="${target%%#*}"
      case "$target" in
        ''|'#'*|http://*|https://*|mailto:*|tel:*|data:*|javascript:*|//*) continue ;;
      esac
      target="${target#<}"
      target="${target%>}"
      case "$target" in /*) continue ;; esac
      cand="$base/$target"
      if [ ! -e "$cand" ]; then
        add_check "$rel" "$lineno" C006 low "相对链接目标不存在：$target"
      fi
    done < <(awk '
      /^```/ || /^~~~/ { in_fence = !in_fence; next }
      in_fence { next }
      {
        rest = $0
        while (match(rest, /\]\([^)]+\)/)) {
          printf "%d\t%s\n", NR, substr(rest, RSTART, RLENGTH)
          rest = substr(rest, RSTART + RLENGTH)
        }
      }
    ' "$ROOT/$rel" 2>/dev/null)
  done < <(surface)
}

# 本机脱敏规则集（export-rules 生成）的脱敏兜底：
# 规则内容按隐私约束不入库（gitignore），故「不存在」只作 info 提示；一旦存在却含个人路径 → high。
check_canonical_rules() {
  local rel base
  base='skills/vibe-coder-loop'
  [ -d "$ROOT/$base" ] || return 0
  rel="$base/backup/rules/skill_memory_canonical.json"
  if [ ! -f "$ROOT/$rel" ]; then
    add_check "$rel" 0 C011 info '未生成本机脱敏规则集（规则内容不入库；需要时运行 export-rules）'
    return 0
  fi
  if grep -qE '/(Users|home)/[A-Za-z0-9_.-]+' "$ROOT/$rel" 2>/dev/null; then
    add_check "$rel" 0 C011 high '规则集含个人主目录路径（应导出为 ~ / <USERPROFILE>）'
  fi
  return 0
}

check_tracked_sensitive() {
  local f base
  if ! has_git; then
    add_check '.' 0 C010 info '非 Git 工作区，跳过跟踪面检查'
    return 0
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    base="${f##*/}"
    case "$base" in
      .state.md|*.sqlite|*.sqlite3|*.db|.env|.env.*|*.pem|*.key|id_rsa|skill_memory_latest.json)
        add_check "$f" 0 C008 high '敏感运行时/凭证文件被 Git 跟踪'
        ;;
    esac
    case "$f" in
      skills/vibe-coder-loop/backup/snapshots/*)
        case "$base" in
          .gitignore) ;;
          *) add_check "$f" 0 C009 high '记忆快照被 Git 跟踪' ;;
        esac
        ;;
    esac
  done < <(git -C "$ROOT" ls-files)
}

run_check() {
  CHECK_RAW="$(mktemp "$TMPBASE/vibe-audit-check.XXXXXX")" || return 2
  : > "$CHECK_RAW"
  check_repo_symlinks
  check_host_links
  check_markdown_links
  check_tracked_sensitive
  check_canonical_rules
  return 0
}

# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------
validate_format() {
  case "$1" in
    text|json) return 0 ;;
    *) printf '[ERROR] 未知格式：%s（可选 text|json）\n' "$1" >&2; return 2 ;;
  esac
}

validate_severity_option() {
  case "$1" in
    critical|high|medium|low|info) return 0 ;;
    *) printf '[ERROR] 未知严重度：%s（可选 critical|high|medium|low|info）\n' "$1" >&2; return 2 ;;
  esac
}

cmd_scan() {
  local format="text" min_sev="info" fail_on="none" all=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --format=*) format="${1#*=}" ;;
      --format) shift; format="${1:-}" ;;
      --min-severity=*) min_sev="${1#*=}" ;;
      --min-severity) shift; min_sev="${1:-}" ;;
      --fail-on=*) fail_on="${1#*=}" ;;
      --fail-on) shift; fail_on="${1:-}" ;;
      --all) all=1 ;;
      -h|--help) cmd_help; return 0 ;;
      *) printf '[ERROR] scan 未知参数：%s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  validate_format "$format" || return 2
  validate_severity_option "$min_sev" || return 2
  if [ "$fail_on" != "none" ]; then validate_severity_option "$fail_on" || return 2; fi

  run_scan "$all" || return 2
  FILTERED="$(mktemp "$TMPBASE/vibe-audit-filtered.XXXXXX")" || return 2
  filter_findings "$SCAN_RAW" "$FILTERED" "$min_sev" || return 2
  print_findings "$FILTERED" "$format"

  if [ "$fail_on" != "none" ]; then
    if count_at_or_above "$FILTERED" "$fail_on"; then
      printf '[FAIL] 存在 %s 及以上严重度发现\n' "$fail_on" >&2
      return 1
    fi
  fi
  return 0
}

cmd_check() {
  local format="text" min_sev="info" fail_on="none"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --format=*) format="${1#*=}" ;;
      --format) shift; format="${1:-}" ;;
      --min-severity=*) min_sev="${1#*=}" ;;
      --min-severity) shift; min_sev="${1:-}" ;;
      --fail-on=*) fail_on="${1#*=}" ;;
      --fail-on) shift; fail_on="${1:-}" ;;
      -h|--help) cmd_help; return 0 ;;
      *) printf '[ERROR] check 未知参数：%s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  validate_format "$format" || return 2
  validate_severity_option "$min_sev" || return 2
  if [ "$fail_on" != "none" ]; then validate_severity_option "$fail_on" || return 2; fi

  run_check || return 2
  FILTERED="$(mktemp "$TMPBASE/vibe-audit-filtered.XXXXXX")" || return 2
  filter_findings "$CHECK_RAW" "$FILTERED" "$min_sev" || return 2
  print_findings "$FILTERED" "$format"

  if [ "$fail_on" != "none" ]; then
    if count_at_or_above "$FILTERED" "$fail_on"; then
      printf '[FAIL] 存在 %s 及以上严重度发现\n' "$fail_on" >&2
      return 1
    fi
  fi
  return 0
}

cmd_report() {
  local out="docs/audits/scan-report.md" baseline=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --out=*) out="${1#*=}" ;;
      --out) shift; out="${1:-}" ;;
      -b|--baseline) shift; baseline="${1:-}" ;;
      --baseline=*) baseline="${1#*=}" ;;
      -h|--help) cmd_help; return 0 ;;
      *) printf '[ERROR] report 未知参数：%s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  [ -n "$out" ] || { printf '[ERROR] --out 不能为空\n' >&2; return 2; }

  run_scan 1 || return 2
  run_check || return 2
  REPORT_TMP="$(mktemp "$TMPBASE/vibe-audit-report.XXXXXX")" || return 2

  local combined total c h m l i high_warn
  combined="$(mktemp "$TMPBASE/vibe-audit-combined.XXXXXX")" || return 2
  cat "$SCAN_RAW" "$CHECK_RAW" | sort -u > "$combined"
  total="$(count_lines "$combined")"
  c="$(awk -F: '$4=="critical"{n++} END{print n+0}' "$combined")"
  h="$(awk -F: '$4=="high"{n++} END{print n+0}' "$combined")"
  m="$(awk -F: '$4=="medium"{n++} END{print n+0}' "$combined")"
  l="$(awk -F: '$4=="low"{n++} END{print n+0}' "$combined")"
  i="$(awk -F: '$4=="info"{n++} END{print n+0}' "$combined")"
  high_warn=""
  if [ "$c" -gt 0 ] || [ "$h" -gt 0 ]; then high_warn='> **警告**：存在严重/高危发现，发布前必须处理。'; fi

  {
    printf '# 开源就绪扫描报告（自动生成）\n\n'
    printf -- '- 生成时间（UTC）：%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf -- '- 仓库：`%s`（仅显示目录名）\n' "$(basename "$ROOT")"
    printf -- '- 工具版本：v%s\n' "$TOOL_VERSION"
    printf -- '- 扫描范围：Git 跟踪 + 未忽略的未跟踪文件 + 被忽略文件（只读）\n'
    printf -- '- 结果已脱敏：路径显示为仓库相对路径，匹配文本中的用户名/邮箱/私有 IP/凭证已替换。\n'
    if [ -n "$baseline" ]; then
      printf -- '- 基线文件：`%s`（本报告不自动比对，请用 `verify`）\n' "$(basename "$baseline")"
    else
      printf -- '- 基线文件：无\n'
    fi
    if [ -n "$high_warn" ]; then printf '\n%s\n' "$high_warn"; fi
    printf '\n## 汇总\n\n'
    printf '| 项目 | 数量 |\n|---|---|\n'
    printf '| 总发现 | %s |\n' "$total"
    printf '| critical | %s |\n' "$c"
    printf '| high | %s |\n' "$h"
    printf '| medium | %s |\n' "$m"
    printf '| low | %s |\n' "$l"
    printf '| info | %s |\n' "$i"
    printf '\n## 发现（最多 50 条，按严重度排序）\n\n'
    if [ "$total" -eq 0 ]; then
      printf '未发现匹配项。\n'
    else
      printf '```text\n'
      awk -F: 'BEGIN{r["critical"]=5;r["high"]=4;r["medium"]=3;r["low"]=2;r["info"]=1} {print r[$4] "\t" $0}' "$combined" \
        | sort -rn -k1,1 | head -50 | cut -f2-
      printf '```\n'
    fi
    printf '\n## 说明\n\n'
    printf -- '- 规则与限制见 `docs/audits/audit-tool.md`；本报告不替代人工判断。\n'
    printf -- '- 扫描不覆盖 Git 历史、二进制文件、运行时数据、加密内容或网络资源。\n'
  } > "$REPORT_TMP" || { rm -f "$combined"; printf '[ERROR] 生成报告失败\n' >&2; return 2; }

  rm -f "$combined"
  if [ "$out" = "-" ]; then
    cat "$REPORT_TMP"
  else
    mkdir -p "$(dirname "$out")" 2>/dev/null || true
    cat "$REPORT_TMP" > "$out" || { printf '[ERROR] 无法写入：%s\n' "$out" >&2; return 2; }
    printf '报告已写入：%s\n' "$out"
  fi
  return 0
}

cmd_verify() {
  local baseline="" all=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -b|--baseline) shift; baseline="${1:-}" ;;
      --baseline=*) baseline="${1#*=}" ;;
      --all) all=1 ;;
      -h|--help) cmd_help; return 0 ;;
      *) printf '[ERROR] verify 未知参数：%s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  [ -n "$baseline" ] || { printf '[ERROR] verify 需要 -b/--baseline <file>\n' >&2; return 2; }
  [ -f "$baseline" ] || { printf '[ERROR] 基线文件不存在：%s\n' "$baseline" >&2; return 2; }

  run_scan "$all" || return 2
  TMP_BASE="$(mktemp "$TMPBASE/vibe-audit-base.XXXXXX")" || return 2
  TMP_NEW="$(mktemp "$TMPBASE/vibe-audit-new.XXXXXX")" || return 2
  TMP_ADDED="$(mktemp "$TMPBASE/vibe-audit-added.XXXXXX")" || return 2
  TMP_REMOVED="$(mktemp "$TMPBASE/vibe-audit-removed.XXXXXX")" || return 2
  TMP_ADDED_HIGH="$(mktemp "$TMPBASE/vibe-audit-added-high.XXXXXX")" || return 2

  awk '{sub(/\r$/,""); if ($0 != "" && $0 !~ /^#/) print}' "$baseline" | sort -u > "$TMP_BASE"
  sort -u "$SCAN_RAW" > "$TMP_NEW"
  comm -13 "$TMP_BASE" "$TMP_NEW" > "$TMP_ADDED"
  comm -23 "$TMP_BASE" "$TMP_NEW" > "$TMP_REMOVED"

  local added removed added_high line sev rank
  added="$(count_lines "$TMP_ADDED")"
  removed="$(count_lines "$TMP_REMOVED")"
  : > "$TMP_ADDED_HIGH"
  added_high=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    sev="$(severity_of_line "$line")"
    rank="$(severity_rank "$sev" 2>/dev/null)" || rank=0
    if [ "$rank" -ge 4 ]; then
      added_high=$((added_high + 1))
      printf '%s\n' "$line" >> "$TMP_ADDED_HIGH"
    fi
  done < "$TMP_ADDED"

  printf '基线比对：新增 %s，消失 %s，新增严重/高危 %s\n' "$added" "$removed" "$added_high"
  if [ "$added_high" -gt 0 ]; then
    printf '新增严重/高危（前 20 条）：\n' >&2
    sed -n '1,20p' "$TMP_ADDED_HIGH" >&2
    return 1
  fi
  return 0
}

cmd_rules() {
  local entry rule sev rest pat desc
  printf '规则\t严重度\t范围\t说明\n'
  for entry in "${RULES[@]}"; do
    rule="${entry%%|*}"
    rest="${entry#*|}"
    sev="${rest%%|*}"
    rest="${rest#*|}"
    desc="${rest#*#}"
    printf '%s\t%s\tscan\t%s\n' "$rule" "$sev" "$desc"
  done
  for entry in "${CHECK_RULES[@]}"; do
    rule="${entry%%|*}"
    rest="${entry#*|}"
    sev="${rest%%|*}"
    desc="${rest#*|}"
    printf '%s\t%s\tcheck\t%s\n' "$rule" "$sev" "$desc"
  done
}

cmd_help() {
  cat <<'EOF'
Vibe Kernel 开源就绪审计工具（只读）

用法：
  audit.sh [--root <dir>] <command> [options]

命令：
  scan       扫描个人路径、宿主/运行时引用、私有 IP、邮箱、凭证、非 POSIX 命令
  check      检查仓库/宿主软链、Markdown 相对链接、被跟踪的敏感文件
  report     生成 Markdown 报告（默认 docs/audits/scan-report.md）
  verify     与基线比对；新增 critical/high 时退出码 1
  rules      列出规则
  help       显示帮助

scan / check 选项：
  --format=text|json        输出格式（默认 text；json 为 JSONL）
  --min-severity=<level>    最低严重度：critical|high|medium|low|info（默认 info）
  --fail-on=<level>         存在该级别及以上发现时退出 1（默认 none）
  --all                     scan 额外扫描被 .gitignore 忽略的文件（运行时数据仍排除）

verify 选项：
  -b, --baseline <file>     基线文件（scan 的 text 输出，或 # 注释开头的文件）
  --all                     同 scan --all

report 选项：
  --out <path|->            输出路径；- 表示 stdout
  -b, --baseline <file>     仅记录基线文件名（不自动比对）

全局：
  --root <dir>              指定仓库根目录（默认脚本上级目录；也可用 AUDIT_ROOT）

退出码：
  0  成功；无 fail-on 命中
  1  fail-on 命中，或 verify 发现新增 critical/high
  2  参数/运行时错误

示例：
  bash scripts/audit.sh scan
  bash scripts/audit.sh scan --format=json > /tmp/findings.jsonl
  bash scripts/audit.sh scan --fail-on=high
  bash scripts/audit.sh check --fail-on=high
  bash scripts/audit.sh scan > docs/audits/baseline.tsv
  bash scripts/audit.sh verify -b docs/audits/baseline.tsv
  bash scripts/audit.sh report --out docs/audits/scan-report.md

限制：
  - 只做文本匹配，不追踪别名、间接路径、加密内容或网络资源。
  - 不扫描 Git 历史；历史清理需单独处理。
  - 路径中的换行/冒号、Markdown 代码块内链接、URL 编码可能造成漏报或误报。
  - 不把“未检出”当作“绝对安全”。
EOF
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root) shift; ROOT="${1:-}" ;;
      --root=*) ROOT="${1#*=}" ;;
      *) break ;;
    esac
    shift
  done

  if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
    printf '[ERROR] 仓库根目录不存在：%s\n' "${ROOT:-<empty>}" >&2
    return 2
  fi
  ROOT="$(cd "$ROOT" && pwd -P)" || return 2
  cd "$ROOT" || return 2

  local cmd="${1:-help}"
  [ "$#" -gt 0 ] && shift
  case "$cmd" in
    scan) cmd_scan "$@" ;;
    check) cmd_check "$@" ;;
    report) cmd_report "$@" ;;
    verify) cmd_verify "$@" ;;
    rules) cmd_rules ;;
    help|-h|--help) cmd_help ;;
    version|-V|--version) printf 'vibe-audit %s\n' "$TOOL_VERSION" ;;
    *)
      printf '[ERROR] 未知命令：%s\n' "$cmd" >&2
      cmd_help >&2
      return 2
      ;;
  esac
}

main "$@"
