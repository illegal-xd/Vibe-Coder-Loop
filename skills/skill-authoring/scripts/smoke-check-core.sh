#!/usr/bin/env bash
# smoke-check-core.sh — 通用 Skill 一致性自检引擎（skill-authoring 协议 · 唯一事实源）
#
# 性质：**被 source 的库**，不单独执行。三个消费者共用本文件，消除"同一份检查逻辑
# 复制三遍"的重复（单一来源 + 生成，不做 duplicate guide）：
#   1. skill-authoring/scripts/smoke-check.sh            （skill-authoring 自身实例）
#   2. skill-authoring/scripts/smoke-check-template.sh   （供外部 Skill 实例化的模板）
#   3. vibe-coder-loop/scripts/smoke-check.sh            （宿主 Skill 实例）
#
# 契约（调用方在 source 本文件**之前**设置）：
#   SKILL_DIR            必填。目标 Skill 根目录（core 会 cd 进去）
#   SMOKE_NAME           可选。报告标题（缺省取 SKILL_DIR basename）
#   DEAD_PTR_WORDS       必填。死指针候选词正则（历史改名轨迹词集中于此）
#   DEAD_PTR_KNOWN       可选。已裁定为合法命中的白名单（数组；键 = "./<相对路径>::<整行内容>"——
#                        路径须与 find 产物同形，含 ./ 前缀；去首尾空白后双精确匹配。内容/文件任一变动
#                        即重新成为候选；条目自身命中不到任何文件行 → HARD（防僵尸条目静默失效））
#   GOV_FILE             可选。governance 映射文件（相对 SKILL_DIR）
#   GOV_KEY_PREFIX       可选。映射表左列 key 前缀（缺省 skill:）
#   SELFTEST_CMD         可选。自测命令（相对 SKILL_DIR），非 0 即 HARD
#   LOAD_PLAN_FILE       可选。加载计划 JSON（相对 SKILL_DIR），校验路径存在性
#   LOAD_PLAN_MENTION    可选。必须提及加载计划内全部路径的文件（如 SKILL.md）
#   CHECKPOINT_FILE       可选。Workflow Checkpoint 文件（相对 SKILL_DIR，如 .state.md），
#                         校验 YAML 单文档可解析 + 13 字段齐全（含 updated_at freshness；pyyaml 缺失则显式跳过）
#   BUDGET_FILE_LINES    可选。单文件行数预算（0 = 关闭；超出 → BUDGET_EXCEEDED）
#   BUDGET_TOTAL_LINES   可选。规则文件总行数预算（0 = 关闭）
#   SCAN_EXCLUDE_PATHS   可选。额外排除的 path glob 片段（数组字符串）
#
# 错误码（结构化输出，见 engine/transition.md「VC 错误码族」的同一套纪律）：
#   RESIDUAL_HIT          日期/版本残留命中（HARD）
#   DEAD_POINTER_CANDIDATE 死指针候选（需裁决，非 HARD）
#   MAP_INCONSISTENT      governance 映射表引用的文件不存在（HARD）
#   STRUCTURAL_INCONSISTENT 结构性缺陷（自测失败 / 表格列数不一致）（HARD）
#   LOAD_PLAN_PATH_MISSING 加载计划内路径在磁盘缺失（HARD）
#   LOAD_PLAN_UNDOCUMENTED 加载计划内路径未被 SKILL.md 提及（HARD）
#   LOAD_PLAN_PATTERN_MISS stage_sections 的匹配串未命中真实章节标题（HARD，改名后成死指针）
#   LOAD_PLAN_STAGE_INVALID level_stages 值域非法（非 S1–S13 规范 token / 空列表 / 重复）（HARD）
#   BUDGET_EXCEEDED      行数预算超限（非 HARD，但退出码 2）
#
# 退出码：0 = 无 HARD 违规；1 = 有 HARD 违规；2 = 仅预算超限；3 = 用法/环境错误
#
# 不做：规则内容正确性判断（那是人工 / Critic 的事）。本脚本只负责"候选是否出现 + 是否漂移 + 是否超预算"。

set -uo pipefail

# 环境守卫：缺配置 → 退出码 3（显式，不用 `:?` 以免退成 1 与 HARD 混淆）
if [ -z "${SKILL_DIR:-}" ] || [ -z "${DEAD_PTR_WORDS:-}" ]; then
  echo "[STRUCTURAL_INCONSISTENT] core 缺少必需配置"
  [ -z "${SKILL_DIR:-}" ] && echo "  - SKILL_DIR 未设置"
  [ -z "${DEAD_PTR_WORDS:-}" ] && echo "  - DEAD_PTR_WORDS 未设置（模板需实例化后使用）"
  echo "[next] 在调用方配置区补全后重跑；模板用法见 smoke-check-template.sh 头部"
  exit 3
fi

SMOKE_NAME="${SMOKE_NAME:-$(basename "$SKILL_DIR")}"
SMOKE_QUIET=0
SMOKE_TABLE=0
SMOKE_MAX_LINES=0
for arg in "$@"; do
  case "$arg" in
    --quiet) SMOKE_QUIET=1 ;;
    --table) SMOKE_TABLE=1 ;;
    --max-lines=*) SMOKE_MAX_LINES="${arg#--max-lines=}" ;;
  esac
done
# 命令行 --max-lines 覆盖调用方默认
[ "$SMOKE_MAX_LINES" -gt 0 ] && BUDGET_FILE_LINES="$SMOKE_MAX_LINES"
: "${BUDGET_FILE_LINES:=0}"
: "${BUDGET_TOTAL_LINES:=0}"

cd "$SKILL_DIR" || { echo "[STRUCTURAL_INCONSISTENT] 无法进入 SKILL_DIR: $SKILL_DIR"; exit 3; }

# 工具选择：有 rg 用 rg，否则 grep（macOS BSD grep 兼容）。
# 死指针等"行号:内容"逐行解析的段必须用 --no-filename / 不带 -r：
# `grep -rn` 对显式单文件仍回显文件名前缀 → `IFS=: read` 会把文件名读进行号。
if command -v rg >/dev/null 2>&1; then
  SEARCH=(rg -n --no-filename)
else
  SEARCH=(grep -n)
fi

# 扫描文件清单：技能规则文件（.md/.yaml），排除历史/实例/工具/快照
_files=()
while IFS= read -r f; do
  _files+=("$f")
done < <(find . -type f \( -name '*.md' -o -name '*.yaml' \) \
  ! -path './.state.md' ! -path './CHANGELOG.md' \
  ! -path './backup/*' ! -path './scripts/*' ! -path './.git/*' \
  | sort)

hard=0
budget_violations=0
smoke_section() { [ "$SMOKE_QUIET" -eq 1 ] || printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
smoke_hit() { printf '  \033[31m✗\033[0m [%s] %s:%s: %s\n' "$1" "$2" "$3" "$4"; hard=$((hard+1)); }
smoke_cand() { printf '  \033[33m?\033[0m %s:%s: %s\n' "$1" "$2" "$3"; }
smoke_warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

if [ "$SMOKE_QUIET" -eq 0 ]; then
  printf '\033[1m# %s 一致性自检\033[0m（core = skill-authoring/scripts/smoke-check-core.sh）\n' "$SMOKE_NAME"
fi

# ---------- 1. 日期残留（HARD） ----------
smoke_section "1. 日期残留（正文禁止；frontmatter/chip/示例业务日期除外）"
date_hits=0
for f in "${_files[@]}"; do
  in_fm=0; lineno=0
  while IFS= read -r line; do
    lineno=$((lineno+1))
    if [[ "$line" == "---" ]]; then in_fm=$((1-in_fm)); continue; fi
    [[ "$in_fm" -eq 1 ]] && continue
    if [[ "$line" =~ 20[0-9]{2}-[0-9]{2}-[0-9]{2} ]]; then
      if [[ "$line" =~ 📅 ]] || [[ "$line" =~ @Iteration ]] || [[ "$line" =~ 业务 ]]; then continue; fi
      smoke_hit RESIDUAL_HIT "$f" "$lineno" "日期残留: $line"; date_hits=$((date_hits+1))
    fi
  done < "$f"
done
[ "$date_hits" -eq 0 ] && { [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ 0 日期残留"; }

# ---------- 2. 版本残留（HARD） ----------
smoke_section "2. 版本残留（正文禁止 vN/vN.N/协议 vN/（vX 引入））"
ver_hits=0
for f in "${_files[@]}"; do
  in_fm=0; lineno=0
  while IFS= read -r line; do
    lineno=$((lineno+1))
    if [[ "$line" == --- ]]; then in_fm=$((1-in_fm)); continue; fi
    [[ "$in_fm" -eq 1 ]] && continue
    if [[ "$line" =~ (协议 v[0-9]|v[0-9]+ 版|（v[0-9]+\.[0-9]+\.[0-9]+ 引入）|\(v[0-9]+\.[0-9]+\.[0-9]+ 引入\)) ]]; then
      smoke_hit RESIDUAL_HIT "$f" "$lineno" "版本残留: $line"; ver_hits=$((ver_hits+1))
    fi
  done < "$f"
done
[ "$ver_hits" -eq 0 ] && { [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ 0 版本残留"; }

# ---------- 3. 死指针候选（需人工裁决，非 HARD） ----------
# DEAD_PTR_KNOWN（可选数组）：已裁定为合法命中的白名单，键 = "./<相对路径>::<整行内容>"。
# 双精确（文件 + 内容）——任一变动即重新成为候选；跨文件复用不继承豁免。
smoke_section "3. 死指针候选词（人工裁决：引用须改 / 节标题合法保留）"
ptr_cands=0
known_ptr=0
for f in "${_files[@]}"; do
  while IFS=: read -r ln content; do
    [ -z "$ln" ] && continue
    trimmed="${content#"${content%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    is_known=0
    for known in ${DEAD_PTR_KNOWN[@]+"${DEAD_PTR_KNOWN[@]}"}; do
      # 键形态 = "<文件路径>::<整行内容>"：文件域 + 内容双精确——同一行内容出现在别的文件
      # 不会被一并豁免（跨文件复用不该继承豁免）；文件改名 → 条目失效 → 该行重新成为候选（安全方向）
      [ "$f::$trimmed" = "$known" ] && { is_known=1; break; }
    done
    if [ "$is_known" -eq 1 ]; then
      known_ptr=$((known_ptr+1))
    else
      smoke_cand "$f" "$ln" "$content"
      ptr_cands=$((ptr_cands+1))
    fi
  done < <("${SEARCH[@]}" -e "$DEAD_PTR_WORDS" "$f" 2>/dev/null)
done
# 死条目检测：白名单条目自身必须仍然有效（文件在、行内容在）。
# 不做此检测则白名单失效只表现为「候选重现」，而候选非 HARD → 静默通道
# （与 _unmapped_ok 的僵尸条目检测对称，见 backup/test_memory_tool.py）。
for known in ${DEAD_PTR_KNOWN[@]+"${DEAD_PTR_KNOWN[@]}"}; do
  kf="${known%%::*}"
  kc="${known#*::}"
  if [ "$kf" = "$known" ]; then
    smoke_hit STRUCTURAL_INCONSISTENT "${SMOKE_NAME} 配置区" 0 "DEAD_PTR_KNOWN 条目缺 \"文件::内容\" 分隔符: $known"
  elif [ ! -f "$kf" ]; then
    smoke_hit STRUCTURAL_INCONSISTENT "$kf" 0 "DEAD_PTR_KNOWN 条目失效（文件不存在）: $kf"
  elif ! awk -v c="$kc" '{ sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); if ($0 == c) found = 1 } END { exit !found }' "$kf" 2>/dev/null; then
    smoke_hit STRUCTURAL_INCONSISTENT "$kf" 0 "DEAD_PTR_KNOWN 条目失效（行内容已变，应重新裁决）: ${kc:0:50}…"
  fi
done
if [ "$ptr_cands" -eq 0 ]; then
  if [ "$known_ptr" -gt 0 ]; then
    echo "  ✓ 0 死指针候选（已知合法白名单 $known_ptr 处；内容一经修改即重新成为候选）"
  else
    echo "  ✓ 0 死指针候选"
  fi
else
  echo "  → [DEAD_POINTER_CANDIDATE] 共 $ptr_cands 处候选，需逐条裁决（引用=改 / 节标题=保留；裁定后记入 DEAD_PTR_KNOWN）"
fi

# ---------- 4. governance 映射一致性（HARD） ----------
if [ -n "${GOV_FILE:-}" ]; then
  smoke_section "4. governance 映射一致性（映射表左列 SKILL 文件路径存在）"
  gov_missing=0
  if [ ! -f "$GOV_FILE" ]; then
    smoke_hit MAP_INCONSISTENT "$GOV_FILE" 0 "映射文件不存在"
  else
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      [ -f "$p" ] || { smoke_hit MAP_INCONSISTENT "$GOV_FILE" 0 "映射表引用的文件不存在: $p"; gov_missing=$((gov_missing+1)); }
    done < <(grep -oE '^\| \`[a-z]+/[a-z/_-]+\.md\`' "$GOV_FILE" 2>/dev/null | tr -d '`| ' | sort -u)
  fi
  [ "$gov_missing" -eq 0 ] && [ -f "$GOV_FILE" ] && { [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ 映射表左列文件全部存在"; }
fi

# ---------- 4b. 映射表声明的 key 是否真实存在（HARD） ----------
# 把「映射表里写的 key」从声明变成可校验事实。缺 KEYS_CHECK_CMD 时跳过。
if [ -n "${KEYS_CHECK_CMD:-}" ] && [ -n "${GOV_FILE:-}" ] && [ -f "$GOV_FILE" ]; then
  smoke_section "4b. 映射表 key 存在性（声明的 key 是否在记忆库中真实存在）"
  # key 抽取。两种模式：
  #   MAP_TABLE_MODE=1 → 解析 Markdown 映射表行，输出 `<key>\t<canonical 类型>`（类型可校验 TTL 不变量）
  #   否则             → 抽取行内代码 span 中的完整 key（通用回退；防 prose 占位符被误抓）
  KEYS_TMP="$(mktemp "${TMPDIR:-/tmp}/smokekeys.XXXXXX")" || KEYS_TMP=""
  if [ -z "$KEYS_TMP" ]; then
    smoke_hit STRUCTURAL_INCONSISTENT "$GOV_FILE" 0 "无法创建临时文件（检查 TMPDIR）"
  else
  python3 - "${KEYS_PREFIX:-skill:}" "$GOV_FILE" "${MAP_TABLE_MODE:-0}" > "$KEYS_TMP" <<'PY'
import re, sys

prefix, path, mode = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
text = open(path, encoding='utf-8').read()
TYPES = ('A', 'C', '数据')  # B（Memory Canonical：rule:/project: 等）不进 skill:* 映射表；若出现即映射错误
found = {}

def keep(k):
    k = k.rstrip('.,;:')
    if '<' in k or '*' in k or k.endswith('/') or k.endswith(':'):
        return None
    return k

if mode:
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith('|') or not s.endswith('|'):
            continue
        cells = [c.strip() for c in s.strip('|').split('|')]
        if len(cells) < 4:
            continue
        m = re.search(re.escape(prefix) + r'[A-Za-z0-9/_.:-]+', cells[1])
        if not m:
            continue
        k = keep(m.group(0))
        if k:
            found[k] = cells[-1] if cells[-1] in TYPES else ''
else:
    for span in re.findall(r'`([^`\n]+)`', text):
        for k in re.findall(re.escape(prefix) + r'[A-Za-z0-9/_.:-]+', span):
            k = keep(k)
            if k:
                found.setdefault(k, '')

for k, t in sorted(found.items()):
    print(f"{k}\t{t}" if t else k)
PY
  if [ ! -s "$KEYS_TMP" ]; then
    [ "$SMOKE_QUIET" -eq 1 ] || echo "  ⚠ 映射文件中未抽到 key，跳过"
  else
    missing="$($KEYS_CHECK_CMD "$KEYS_TMP" 2>&1)" && keys_rc=0 || keys_rc=$?
    if [ "$keys_rc" -eq 4 ]; then
      while IFS= read -r mk; do
        [ -z "$mk" ] && continue
        smoke_hit MAP_INCONSISTENT "$GOV_FILE" 0 "声明的 key 在记忆库中不存在: $mk"
      done <<< "$missing"
    elif [ "$keys_rc" -ne 0 ]; then
      smoke_hit MAP_INCONSISTENT "$GOV_FILE" 0 "key 校验命令失败（退出码 $keys_rc）: $missing"
    else
      [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ $(wc -l < "$KEYS_TMP" | tr -d ' ') 个声明 key 全部存在"
    fi
  fi
  rm -f "$KEYS_TMP"
  fi
fi

# ---------- 5. 自测命令（HARD） ----------
smoke_section "5. 自测"
SMOKE_SELFTEST_LOG=""
if [ -n "${SELFTEST_CMD:-}" ] && command -v python3 >/dev/null 2>&1; then
  SMOKE_SELFTEST_LOG="$(mktemp "${TMPDIR:-/tmp}/smoke_selftest.XXXXXX")" || SMOKE_SELFTEST_LOG=""
  if [ -z "$SMOKE_SELFTEST_LOG" ]; then
    smoke_hit STRUCTURAL_INCONSISTENT "$SELFTEST_CMD" 0 "无法创建自测临时文件（检查 TMPDIR）"
  elif eval "$SELFTEST_CMD" >"$SMOKE_SELFTEST_LOG" 2>&1; then
    [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ SELFTEST_CMD PASS"
  else
    smoke_hit STRUCTURAL_INCONSISTENT "$SELFTEST_CMD" 0 "自测 FAIL（见 $SMOKE_SELFTEST_LOG）"
  fi
else
  echo "  ⚠ 跳过（未配置 SELFTEST_CMD 或 python3 不可用）"
fi

# ---------- 6. 加载计划一致性（HARD） ----------
if [ -n "${LOAD_PLAN_FILE:-}" ]; then
  smoke_section "6. 加载计划一致性（路径存在 + 已被文档提及）"
  if [ ! -f "$LOAD_PLAN_FILE" ]; then
    smoke_hit LOAD_PLAN_PATH_MISSING "$LOAD_PLAN_FILE" 0 "加载计划文件不存在"
  else
    plan_missing=0; plan_undoc=0
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      if [ ! -f "$p" ]; then
        smoke_hit LOAD_PLAN_PATH_MISSING "$LOAD_PLAN_FILE" 0 "计划内路径在磁盘缺失: $p"
        plan_missing=$((plan_missing+1))
      elif [ -n "${LOAD_PLAN_MENTION:-}" ] && [ -f "$LOAD_PLAN_MENTION" ]; then
        # 匹配「全路径」或「basename」：宿主文档惯用相对子目录的短写（如 memory/architecture.md）
        base="${p##*/}"
        if ! grep -qF "$p" "$LOAD_PLAN_MENTION" && ! grep -qF "$base" "$LOAD_PLAN_MENTION"; then
          smoke_hit LOAD_PLAN_UNDOCUMENTED "$LOAD_PLAN_FILE" 0 "计划内路径未被 $LOAD_PLAN_MENTION 提及: $p"
          plan_undoc=$((plan_undoc+1))
        fi
      fi
    done < <(python3 - "$LOAD_PLAN_FILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for v in (d.get('core') or []):
    out.append(v)
for v in (d.get('levels') or {}).values():
    out.extend(v or [])
for v in (d.get('profiles') or {}).values():
    out.extend(v or [])
seen = set()
for p in out:
    if p not in seen:
        seen.add(p)
        print(p)
PY
)
    [ $((plan_missing + plan_undoc)) -eq 0 ] && { [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ 加载计划路径全部存在且已被文档提及"; }

    # stage_sections 的每个「章节标题子串」必须能在该文件里命中真实 H2 ——
    # 命中不到即映射失效（改名后成死指针）。运行时虽有 fail-safe（回退整文件），
    # 但静默降级会把"按阶段裁剪"悄悄变成"整文件读"，故此处按 HARD 报告。
    # 输出格式："<行号>\t<消息>"（行号 = 违规项在加载计划里的真实行，定位用）；
    # 无任何 stage_sections 映射时输出 __NONE__（调用方据此显式声明"跳过"，
    # 不打 ✓——空集上的"全部命中"是假绿）。
    pattern_out="$(python3 - "$LOAD_PLAN_FILE" <<'PY'
import json, sys, re, pathlib
plan_path = pathlib.Path(sys.argv[1])
raw_lines = plan_path.read_text(encoding='utf-8').splitlines()
d = json.loads("\n".join(raw_lines))
root = plan_path.parent
ss = {k: v for k, v in (d.get('stage_sections') or {}).items() if not k.startswith('_')}
if not ss:
    print("__NONE__")
    raise SystemExit
def find_line(needle):
    for i, l in enumerate(raw_lines, 1):
        if needle in l:
            return i
    return 0
def h2s(rel):
    try:
        lines = (root / rel).read_text(encoding='utf-8').splitlines()
    except OSError:
        return None
    body = 0
    if lines and lines[0].strip() == '---':
        for i in range(1, min(len(lines), 40)):
            if lines[i].strip() == '---':
                body = i + 1
                break
    out, fence = [], False
    for i, l in enumerate(lines):
        if i < body:
            continue
        s = l.strip()
        if s.startswith('```'):
            fence = not fence
            continue
        if fence:
            continue
        if l.startswith('## '):
            out.append(l[3:].strip())
    return out
bad = []
for rel, smap in ss.items():
    secs = h2s(rel)
    if secs is None:
        bad.append((find_line(f'"{rel}"'), f"{rel}: 文件不存在"))
        continue
    for stage, pats in smap.items():
        if stage.startswith('_'):
            continue  # per-file 注释键（约定：_ 前缀），非阶段键
        if not re.fullmatch(r'S\d+', stage):
            bad.append((find_line(f'"{stage}"'), f"{rel}: 非法阶段键 {stage!r}"))
            continue
        for p in (pats or []):
            if not any(p in s for s in secs):
                bad.append((find_line(f'"{p}"'), f"{rel}[{stage}]: 匹配串 {p!r} 未命中任何 H2 章节标题"))
for ln, msg in bad:
    print(f"{ln}\t{msg}")
PY
)"
    stage_domain_out="$(python3 - "$LOAD_PLAN_FILE" <<'PYX'
import json, re, sys, pathlib
plan = pathlib.Path(sys.argv[1])
raw = plan.read_text(encoding="utf-8").splitlines()
d = json.loads("\n".join(raw))
def find_line(needle):
    for i, l in enumerate(raw, 1):
        if needle in l:
            return i
    return 0
ok_stage = re.compile(r"^S([1-9]|1[0-3])$")
bad = []
for lvl, val in (d.get("level_stages") or {}).items():
    if lvl.startswith("_"):
        continue
    if not isinstance(val, list) or not val:
        kind = type(val).__name__ if val is not None else "null"
        bad.append((find_line('"%s"' % lvl), "level_stages[%s] 必须是非空列表（得到 %s）" % (lvl, kind)))
        continue
    for tok in val:
        if not isinstance(tok, str) or not ok_stage.match(tok):
            bad.append((find_line('"%s"' % lvl), "level_stages[%s] 含非法阶段 token %r（合法 S1–S13 规范写法）" % (lvl, tok)))
    if len(set(val)) != len(val):
        bad.append((find_line('"%s"' % lvl), "level_stages[%s] 含重复阶段" % lvl))
for ln, msg in bad:
    print("%d\t%s" % (ln, msg))
PYX
    )"
    if [ -n "$stage_domain_out" ]; then
      while IFS=$'\t' read -r sline smsg; do
        [ -z "$smsg" ] && continue
        smoke_hit LOAD_PLAN_STAGE_INVALID "$LOAD_PLAN_FILE" "$sline" "$smsg"
      done <<< "$stage_domain_out"
    fi

    if [ "$pattern_out" = "__NONE__" ]; then
      [ "$SMOKE_QUIET" -eq 1 ] || echo "  （无 stage_sections 映射——本 Skill 未配置节级裁剪，跳过）"
    elif [ -n "$pattern_out" ]; then
      while IFS=$'\t' read -r pline pmsg; do
        [ -z "$pmsg" ] && continue
        smoke_hit LOAD_PLAN_PATTERN_MISS "$LOAD_PLAN_FILE" "$pline" "$pmsg"
      done <<< "$pattern_out"
    else
      [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ stage_sections 匹配串全部命中真实章节标题"
    fi
  fi
fi

# ---------- 6b. Workflow Checkpoint 可解析性（HARD，机器可判定） ----------
# 恢复协议（engine/state-machine.md「Workflow Checkpoint」）要求"YAML 可解析 + 12 字段齐全"，
# 历史上该判定只存在于 prose —— 尾随 `---` 会让文件变成多文档，safe_load 直接抛错（已实际发生）。
# 此处把它变成机械判定；pyyaml 缺失时显式跳过（不静默通过）。
if [ -n "${CHECKPOINT_FILE:-}" ] && [ -f "$CHECKPOINT_FILE" ]; then
  smoke_section "6b. Checkpoint YAML 可解析性（单文档 + 13 字段）"
  if python3 -c "import yaml" >/dev/null 2>&1; then
    if python3 - "$CHECKPOINT_FILE" <<'PY'
import sys, yaml
req = ["status", "phase", "loop", "level", "goal", "current_step",
       "completed", "pending", "decisions", "review", "user_decisions", "resume",
       "updated_at"]  # freshness：缺失/陈旧曾是零检测（审查 P2）
try:
    d = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
if not isinstance(d, dict) or [k for k in req if k not in d]:
    sys.exit(1)
PY
    then
      [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ Checkpoint 单文档可解析且 13 字段齐全（含 updated_at freshness）"
    else
      smoke_hit STRUCTURAL_INCONSISTENT "$CHECKPOINT_FILE" 0 "Checkpoint YAML 不可解析（多为多文档/尾随 ---）或 13 字段缺失 —— 按恢复协议会被降级为仅参考"
    fi
  else
    echo "  ⚠ 跳过（python3 可用但 pyyaml 缺失；恢复协议的解析性判定无法机械化）"
  fi
fi

# ---------- 7.（可选）Markdown 表格列数一致性（HARD） ----------
if [ "$SMOKE_TABLE" -eq 1 ]; then
  smoke_section "7. Markdown 表格列数一致性"
  bad_tables=0
  for f in "${_files[@]}"; do
    python3 - "$f" <<'PY' || { smoke_hit STRUCTURAL_INCONSISTENT "$f" 0 "表格列数不一致"; bad_tables=$((bad_tables+1)); }
import sys, re
f = sys.argv[1]
rows = []
for line in open(f, encoding='utf-8'):
    s = line.rstrip('\n')
    if s.startswith('|') and s.endswith('|'):
        rows.append(s)
    else:
        if rows:
            cols = {len(r.split('|')) for r in rows if not re.match(r'^\|[\s:|-]+\|$', r)}
            if len(cols) > 1:
                sys.exit(1)
            rows = []
PY
  done
  [ "$bad_tables" -eq 0 ] && { [ "$SMOKE_QUIET" -eq 1 ] || echo "  ✓ 表格列数一致"; }
fi

# ---------- 8. 行数预算（非 HARD，退出码 2） ----------
total_lines=0
for f in "${_files[@]}"; do
  n=$(wc -l < "$f" 2>/dev/null | tr -d ' ')
  n=${n:-0}
  total_lines=$((total_lines + n))
  if [ "$BUDGET_FILE_LINES" -gt 0 ] && [ "$n" -gt "$BUDGET_FILE_LINES" ]; then
    printf '  \033[33m!\033[0m [BUDGET_EXCEEDED] %s: %s 行 > 单文件预算 %s\n' "$f" "$n" "$BUDGET_FILE_LINES"
    budget_violations=$((budget_violations+1))
  fi
done
if [ "$BUDGET_TOTAL_LINES" -gt 0 ] && [ "$total_lines" -gt "$BUDGET_TOTAL_LINES" ]; then
  printf '  \033[33m!\033[0m [BUDGET_EXCEEDED] 规则文件合计 %s 行 > 总预算 %s\n' "$total_lines" "$BUDGET_TOTAL_LINES"
  budget_violations=$((budget_violations+1))
fi

# ---------- 汇总 ----------
smoke_section "汇总"
echo "  HARD 违规: $hard"
echo "  死指针候选（待裁决）: $ptr_cands"
echo "  [DEAD_POINTER_CANDIDATE] 计数: $ptr_cands"
[ "$BUDGET_FILE_LINES" -gt 0 ] || [ "$BUDGET_TOTAL_LINES" -gt 0 ] && {
  echo "  规则文件合计: $total_lines 行"
  echo "  [BUDGET_EXCEEDED] 计数: $budget_violations"
}
[ -n "${SMOKE_SELFTEST_LOG:-}" ] && rm -f "$SMOKE_SELFTEST_LOG"

if [ "$hard" -gt 0 ]; then
  echo "  → [next] 修复上述 HARD 项后重跑；不得带残留收尾"
  exit 1
elif [ "$budget_violations" -gt 0 ]; then
  echo "  → [next] 预算超限：拆分文件 或 调整 BUDGET_FILE_LINES 后再评估"
  exit 2
else
  if [ "$ptr_cands" -gt 0 ]; then
    echo "  → [next] 无 HARD 违规；死指针候选逐条裁决后记入 DEAD_PTR_KNOWN"
  else
    echo "  → [next] 无 HARD 违规；死指针候选 0（已裁定项在 DEAD_PTR_KNOWN，内容改动即重新告警）"
  fi
  exit 0
fi
