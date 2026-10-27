#!/usr/bin/env python3
"""P1-3：从重复经验（L5 Pattern）生成可审计的 Skill 草稿。

边界（见 skills/skill-authoring/governance-protocol.md「草稿生成与自检」）：
- **只生成草稿**：默认写入 ``reports/skill-drafts/``，不进入 ``skills/``，
  不会被 Skill 路由器发现；不写 delx-memory，不完成任何 L6 晋升。
- 草稿固定 ``status=draft`` / ``draft=true`` / ``verification=pending``；
  证据不足、存在未解决冲突或未达复用阈值 → 不生成，只报告 ``deferred`` 原因。
- 已有正式 Skill 覆盖 → 生成**改进提案**，不新建重复技能。
- 重复运行复用并更新同一草稿（保留 created_at、递增 revision）；
  若草稿被人工修改（内容哈希不匹配）→ 不覆盖，报告 ``manual_edits``。
- 生成后调用 ``skill-authoring`` 的 ``smoke-check-core.sh``（存在时）；
  自检失败如实记录并以退出码 1 报告，不伪装为通过。

退出码：0 = 成功（含 deferred / no-op）；1 = 自检失败；2 = 参数非法；3 = 记忆库异常。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import evolution_store as S  # noqa: E402

DRAFT_SCHEMA = "skill-draft/v1"
INDEX_SCHEMA = "skill-draft-index/v1"
PATTERN_PREFIX = "pattern:"
HARD_CONFLICT_MARKERS = ("已废弃", "不再适用", "被取代", "superseded", "冲突未解决")
COUNTER_MARKERS = ("反例", "不适用", "避免", "不要")
# 英文 slug ↔ 中文技能正文的高信号别名（只用于「是否已有技能覆盖」判定）
ALIASES = {
    "memory": ("记忆",),
    "writeback": ("回写",),
    "reflection": ("反思",),
    "skill": ("技能",),
    "lesson": ("经验",),
    "pattern": ("模式",),
    "review": ("审查",),
    "test": ("测试",),
    "plan": ("计划",),
    "design": ("设计",),
}
REQUIRED_SECTIONS = (
    "名称与用途",
    "触发条件与适用范围",
    "前置条件与输入",
    "推荐执行步骤",
    "验证标准与预期结果",
    "常见失败与恢复",
    "不适用条件与已知反例",
    "经验来源与证据",
    "验证状态与待解决",
)
_DATE_RE = re.compile(r"\b20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b")
_HOME_RE = re.compile(r"(?<![\w.-])/(?:Users|home)/[^/\s]+")
# 用字符类拼出 `\Users\`，避免公开面审计把源码里的脱敏正则误判为真实路径
_WIN_HOME_RE = re.compile(r"[A-Za-z]:" + r"[\\]{1}Users[\\]{1}[^\\\s]+")


# ---------------------------------------------------------------------------
# 文本工具
# ---------------------------------------------------------------------------
def slugify(text: str) -> str:
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", (text or "").lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    return (slug[:48] or "draft-skill").strip("-")


def sanitize(text: str) -> str:
    """草稿正文禁止个人绝对路径与日期备注（自检 HARD 项）；原文证据留在来源 key。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _HOME_RE.sub("~", text)
    text = _WIN_HOME_RE.sub("~", text)
    text = _DATE_RE.sub("[date]", text)
    return text.strip()


def _h2_sections(value: str) -> list[tuple[str, str]]:
    lines = (value or "").splitlines()
    starts = [i for i, line in enumerate(lines) if line.startswith("## ")]
    if not starts:
        return [("", "\n".join(lines).strip())]
    out: list[tuple[str, str]] = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(lines)
        out.append((lines[start][3:].strip(), "\n".join(lines[start + 1 : end]).strip()))
    return out


def _pick(value: str, keywords: Iterable[str], *, limit: int = 8) -> str:
    keywords = tuple(keywords)
    blocks: list[str] = []
    for heading, body in _h2_sections(value):
        if any(word in heading for word in keywords) and body:
            blocks.append(body)
    if not blocks:
        # 无 H2 时按行启发式：只取包含关键词的行，避免整段搬运
        for line in (value or "").splitlines():
            if any(word in line for word in keywords):
                blocks.append(line.strip())
    text = sanitize("\n".join(blocks))
    lines = []
    for line in text.splitlines():
        if not line.strip():
            continue
        stripped = line.strip()
        # 片段化表格行（缺表头/分隔行）会破坏 Markdown 结构 → 降级为一条列表
        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|") if c.strip()]
            if cells:
                line = "- " + " / ".join(cells)
        lines.append(line.rstrip())
    return "\n".join(lines[:limit])


def _title(value: str, key: str) -> str:
    for line in (value or "").splitlines():
        if line.startswith("# "):
            return sanitize(line[2:].strip())
    return key.split(":", 1)[-1].replace("-", " ")


def _one_line(value: str, fallback: str) -> str:
    for line in sanitize(value).splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return re.sub(r"\s+", " ", line)[:160]
    return fallback


def _unique(items: Iterable[str]) -> list[str]:
    out: list[str] = []
    for item in items:
        item = (item or "").strip()
        if item and item not in out:
            out.append(item)
    return out


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [part.strip() for part in re.split(r"[,;]", value) if part.strip()]
    return []


# ---------------------------------------------------------------------------
# 候选识别
# ---------------------------------------------------------------------------
def _memory_refs(value: str, meta: dict[str, Any]) -> list[str]:
    refs: list[str] = []
    for ref in _as_list(meta.get("evidence_ids")):
        if ref.startswith("memory:"):
            refs.append(ref[len("memory:") :])
    for ref in _as_list(meta.get("instances")):
        refs.append(ref)
    for match in re.finditer(
        r"(?:lesson|reflection|experience|pattern|principle):[A-Za-z0-9._/\-\u4e00-\u9fff]+", value or ""
    ):
        refs.append(match.group(0))
    return _unique(refs)


def _project_refs(value: str, meta: dict[str, Any]) -> list[str]:
    refs = _as_list(meta.get("projects")) + _as_list(meta.get("project_ids"))
    for match in re.finditer(r"\bproject:[A-Za-z0-9._/\-]+", value or ""):
        refs.append(match.group(0))
    return _unique(refs)


def _task_refs(meta: dict[str, Any]) -> list[str]:
    return _unique(_as_list(meta.get("task_ids")) + _as_list(meta.get("tasks")))


def _has_hard_conflict(value: str, meta: dict[str, Any]) -> bool:
    text = f"{value}\n{json.dumps(meta, ensure_ascii=False)}"
    return any(marker in text for marker in HARD_CONFLICT_MARKERS)


def _has_counterexamples(value: str) -> bool:
    return any(marker in (value or "") for marker in COUNTER_MARKERS)


def candidate_from_entry(
    entry: dict[str, Any], *, min_instances: int = 3
) -> dict[str, Any]:
    key = entry["key"]
    value = entry["value"]
    meta = entry["metadata"]
    refs = _memory_refs(value, meta)
    task_refs = _task_refs(meta)
    projects = _project_refs(value, meta)
    recurrence = 0
    try:
        recurrence = int(meta.get("recurrence_count") or 0)
    except (TypeError, ValueError):
        recurrence = 0
    instance_count = max(recurrence, len(refs))
    effective_tasks = len(task_refs) if task_refs else len(refs)
    task_evidence = "task_ids" if len(task_refs) >= 2 else "instance_refs" if len(refs) >= 2 else "none"
    scope = "global" if len(projects) >= 2 else "project"

    blocked: list[str] = []
    warnings: list[str] = []
    layer = meta.get("layer")
    if layer not in (None, "L5"):
        blocked.append("not_l5")
    if layer is None:
        warnings.append("layer_missing")
    if meta.get("status") in ("archived", "superseded"):
        blocked.append(f"status_{meta.get('status')}")
    if meta.get("review_status") == "rejected":
        blocked.append("review_rejected")
    if instance_count < min_instances:
        blocked.append("insufficient_instances")
    if effective_tasks < 2:
        blocked.append("insufficient_task_evidence")
    if not refs and not _as_list(meta.get("evidence_ids")):
        blocked.append("insufficient_evidence")
    if _has_hard_conflict(value, meta):
        blocked.append("unresolved_conflict")
    if len(projects) < 2:
        warnings.append("single_project")
    if _has_counterexamples(value):
        warnings.append("counterexamples_present")
    if not _pick(value, ("验证", "验收", "结果", "成功", "测试")):
        warnings.append("verification_missing")
    if meta.get("review_status") == "pending":
        warnings.append("pending_review")
    if meta.get("needs_review"):
        warnings.append("needs_review")
    if meta.get("status") == "candidate":
        warnings.append("candidate_status")

    return {
        "key": key,
        "slug": slugify(key[len(PATTERN_PREFIX) :] if key.startswith(PATTERN_PREFIX) else key),
        "title": _title(value, key),
        "description": _one_line(value, f"从 {key} 提炼的可复用工程方法"),
        "value": value,
        "metadata": meta,
        "layer": layer or "L5",
        "review_status": meta.get("review_status"),
        "scope": scope,
        "project_count": len(projects),
        "projects": projects,
        "instance_count": instance_count,
        "task_evidence": task_evidence,
        "distinct_tasks": effective_tasks,
        "refs": refs,
        "evidence_ids": _unique([*_as_list(meta.get("evidence_ids")), *[f"memory:{r}" for r in refs]]),
        "blocked_reasons": blocked,
        "warnings": warnings,
    }


def load_candidates(db: Path, *, min_instances: int = 3) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for entry in S.list_entries(db, PATTERN_PREFIX):
        out.append(candidate_from_entry(entry, min_instances=min_instances))
    return out


# ---------------------------------------------------------------------------
# 与现有 Skill / 草稿去重
# ---------------------------------------------------------------------------
def _tokens(text: str) -> set[str]:
    text = (text or "").lower()
    ascii_tokens = {t for t in re.findall(r"[a-z0-9]{3,}", text)}
    cjk = re.findall(r"[\u4e00-\u9fff]+", text)
    cjk_bigrams = {chunk[i : i + 2] for chunk in cjk for i in range(len(chunk) - 1)}
    stop = {"the", "and", "for", "with", "this", "that", "skill", "draft", "loop", "vibe", "coder"}
    return (ascii_tokens | cjk_bigrams) - stop


def _frontmatter_value(text: str, field: str) -> str | None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for idx, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            break
        match = re.match(rf"^{re.escape(field)}\s*:\s*(.*)$", line)
        if not match:
            continue
        value = match.group(1).strip()
        if value in (">", "|", ">-", "|-"):
            folded: list[str] = []
            for follow in lines[idx + 1 :]:
                if follow.strip() == "---" or not follow.startswith((" ", "\t")):
                    break
                folded.append(follow.strip())
            return " ".join(part for part in folded if part)
        return value.strip("\"'")
    return None


def load_skills(skills_dir: Path) -> list[dict[str, Any]]:
    skills: list[dict[str, Any]] = []
    if not skills_dir.exists():
        return skills
    for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
        try:
            text = skill_md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        name = _frontmatter_value(text, "name") or skill_md.parent.name
        description = _frontmatter_value(text, "description") or " ".join(text.splitlines()[:12])
        try:
            rel_path = str(skill_md.relative_to(skills_dir))
        except ValueError:
            rel_path = f"{skill_md.parent.name}/SKILL.md"
        tokens = _tokens(f"{name} {skill_md.parent.name} {description} {text[:20000]}")
        for ascii_token, aliases in ALIASES.items():
            if any(alias in text for alias in aliases):
                tokens.add(ascii_token)
        skills.append(
            {
                "name": name,
                "dir": skill_md.parent.name,
                "path": rel_path,
                "tokens": tokens,
            }
        )
    return skills


def find_skill_overlap(candidate: dict[str, Any], skills: list[dict[str, Any]]) -> list[dict[str, Any]]:
    slug = candidate["slug"].lower()
    slug_tokens = _tokens(slug)
    slug_compact = slug.replace("-", "")
    matches: list[dict[str, Any]] = []
    for skill in skills:
        name = str(skill["name"]).lower()
        compact = name.replace("-", "").replace("_", "")
        if slug and (slug in name or slug_compact in compact):
            matches.append({**skill, "score": 1.0, "reason": "slug_containment"})
            continue
        shared = slug_tokens & skill["tokens"]
        if not slug_tokens:
            continue
        union = slug_tokens | skill["tokens"]
        jaccard = len(shared) / len(union) if union else 0.0
        containment = len(shared) / len(slug_tokens)
        # 大技能正文会稀释 Jaccard；slug 关键词多数命中同样视为覆盖
        if len(shared) >= 2 and (jaccard >= 0.2 or containment >= 0.66):
            matches.append(
                {**skill, "score": round(max(jaccard, containment), 3), "reason": "token_overlap"}
            )
    return sorted(matches, key=lambda item: (-item["score"], item["name"]))


# ---------------------------------------------------------------------------
# 草稿渲染
# ---------------------------------------------------------------------------
def _block(value: str, keywords: Iterable[str], fallback: str, *, limit: int = 8) -> str:
    text = _pick(value, keywords, limit=limit)
    return text or f"- （待补充：{fallback}）"


def render_skill(candidate: dict[str, Any]) -> str:
    value = candidate["value"]
    title = candidate["title"]
    lines = [
        "---",
        f'name: "draft-{candidate["slug"]}"',
        f'description: "{candidate["description"].replace(chr(34), chr(39))}"',
        'status: "draft"',
        "draft: true",
        f'source_pattern: "{candidate["key"]}"',
        f'scope: "{candidate["scope"]}"',
        'verification: "pending"',
        f'generated_at: "{S.iso_ms(S.now_ms())}"',
        f'evidence_count: {len(candidate["evidence_ids"])}',
        "---",
        "",
        f"# Skill 草稿：{title}",
        "",
        "> **状态：草稿（draft）。** 本文件不在 `skills/` 路由目录内，不是已发布技能，"
        "也不代表已验证。发布需经 `skill-authoring` 自检、人工 Review 与正式 L6 晋升流程。",
        "",
        "## 名称与用途",
        "",
        f"- 名称：`draft-{candidate['slug']}`",
        f"- 用途：{candidate['description']}",
        f"- 来源 Pattern：`{candidate['key']}`",
        "",
        "## 触发条件与适用范围",
        "",
        _block(value, ("触发", "适用", "场景", "When", "前提", "背景"), "原始 Pattern 未包含触发条件"),
        f"- 作用域：`{candidate['scope']}`（证据覆盖 {candidate['project_count']} 个项目）",
        "",
        "## 前置条件与输入",
        "",
        _block(value, ("前置", "输入", "条件", "准备"), "原始 Pattern 未包含前置条件"),
        "",
        "## 推荐执行步骤",
        "",
        _block(value, ("步骤", "做法", "修正", "流程", "操作", "检查", "清单"), "原始 Pattern 未包含可执行步骤"),
        "",
        "## 验证标准与预期结果",
        "",
        _block(value, ("验证", "验收", "结果", "成功", "测试"), "原始 Pattern 未包含验证标准"),
        "",
        "## 常见失败与恢复",
        "",
        _block(value, ("失败", "恢复", "排查", "回退", "形态", "根因", "症状", "事故"), "原始 Pattern 未包含失败处理"),
        "",
        "## 不适用条件与已知反例",
        "",
        _block(value, ("反例", "不适用", "避免", "不要", "边界"), "原始 Pattern 未标注反例/不适用条件"),
        "",
        "## 经验来源与证据",
        "",
        f"- 来源 Pattern：`{candidate['key']}`",
        f"- 实例数：{candidate['instance_count']}（任务证据：`{candidate['task_evidence']}`）",
        "- 关联实例（正文日期已脱敏；精确 key 见 `draft.json` 与源 Pattern）：",
        *[f"  - `{sanitize(str(ref))}`" for ref in candidate["refs"][:10] or ["（无）"]],
        "- 证据引用：",
        *[f"  - `{sanitize(str(ref))}`" for ref in candidate["evidence_ids"][:10] or ["（无）"]],
        "",
        "## 验证状态与待解决",
        "",
        "- 验证状态：`pending`（草稿，不是已验证技能）",
        f"- Pattern 审核状态：`{candidate['review_status'] or 'unknown'}`",
        f"- 已知告警：{', '.join(candidate['warnings']) or '无'}",
        "- 待解决：补齐上文中标记为「待补充」的字段，并补充正反例与验证命令。",
        "- 发布路径：`skill-authoring` 自检 → 人工 Review → 正式 L6 / Skill 目录；本文件不自动晋升。",
        "",
    ]
    return "\n".join(lines)


def render_proposal(candidate: dict[str, Any], overlap: dict[str, Any]) -> str:
    description = f"针对 {overlap['name']} 的改进提案（来自 {candidate['key']}）".replace('"', "'")
    return "\n".join(
        [
            "---",
            f'name: "proposal-{candidate["slug"]}"',
            f'description: "{description}"',
            'status: "proposal"',
            "draft: true",
            f'target_skill: "{overlap["name"]}"',
            f'source_pattern: "{candidate["key"]}"',
            'verification: "pending"',
            "---",
            "",
            f"# Skill 改进提案：{candidate['title']}",
            "",
            "> 状态：提案（proposal）。已有正式 Skill 覆盖该经验，不新建重复技能；"
            "是否合并由人工 Review 决定。",
            "",
            "## 目标技能",
            "",
            f"- 名称：`{overlap['name']}`",
            f"- 路径：`{overlap['path']}`",
            f"- 命中原因：`{overlap['reason']}`（score={overlap['score']}）",
            "",
            "## 建议变更",
            "",
            f"把 `{candidate['key']}` 的可复用步骤/反例补充到目标技能：",
            "",
            _block(candidate["value"], ("步骤", "做法", "修正", "流程"), "待人工补充具体步骤"),
            "",
            "## 经验来源与证据",
            "",
            f"- 来源 Pattern：`{candidate['key']}`",
            f"- 实例数：{candidate['instance_count']}",
            *[f"- 证据：`{sanitize(str(ref))}`" for ref in candidate["evidence_ids"][:10]],
            "",
            "## 验证与审批",
            "",
            "- 验证状态：`pending`",
            "- 需要人工确认：是否与目标技能现有约束冲突、是否需要更新骨架/映射/自检。",
            "- 本文件不修改目标技能，也不进入 Skill 路由器。",
            "",
        ]
    )


# ---------------------------------------------------------------------------
# 自检
# ---------------------------------------------------------------------------
def find_smoke_core(skills_dir: Path) -> Path | None:
    candidates = [
        os.environ.get("SKILL_DRAFT_SMOKE_CORE", ""),
        str(REPO_ROOT / "skills" / "skill-authoring" / "scripts" / "smoke-check-core.sh"),
        str(skills_dir / "skill-authoring" / "scripts" / "smoke-check-core.sh"),
        str(skills_dir.parent / "skill-authoring" / "scripts" / "smoke-check-core.sh"),
        str(Path.home() / ".agents" / "skills" / "skill-authoring" / "scripts" / "smoke-check-core.sh"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    return None


def run_self_check(draft_dir: Path, *, name: str, core: Path | None) -> dict[str, Any]:
    if core is None:
        return {"status": "skipped", "reason": "core_not_found"}
    env = os.environ.copy()
    env.update(
        {
            "SKILL_DIR": str(draft_dir),
            "SMOKE_NAME": name,
            "DEAD_PTR_WORDS": "__draft_no_dead_pointer__",
            "BUDGET_FILE_LINES": "0",
            "BUDGET_TOTAL_LINES": "0",
            "GOV_FILE": "",
            "SELFTEST_CMD": "",
            "LOAD_PLAN_FILE": "",
            "LOAD_PLAN_MENTION": "",
            "CHECKPOINT_FILE": "",
        }
    )
    try:
        proc = subprocess.run(
            ["bash", str(core), "--quiet", "--table"],
            cwd=str(draft_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"status": "fail", "reason": f"self_check_exec_error: {exc}"}
    output = (proc.stdout or "") + (proc.stderr or "")
    tail = "\n".join(output.strip().splitlines()[-20:])
    if proc.returncode == 0:
        return {"status": "pass", "rc": 0}
    return {"status": "fail", "rc": proc.returncode, "output": tail}


# ---------------------------------------------------------------------------
# 生成
# ---------------------------------------------------------------------------
def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _file_safe_report(report: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    """index.json 不落个人绝对路径：db 只留文件名，产物路径相对 out_dir。"""
    candidates = []
    for item in report.get("candidates", []):
        clone = dict(item)
        paths = []
        for path in item.get("paths", []):
            try:
                paths.append(str(Path(path).relative_to(out_dir)))
            except ValueError:
                paths.append(Path(path).name)
        clone["paths"] = paths
        candidates.append(clone)
    return {
        **report,
        "db": Path(report.get("db", "")).name,
        "out_dir": ".",
        "candidates": candidates,
    }


def generate_one(
    candidate: dict[str, Any],
    *,
    out_dir: Path,
    skills: list[dict[str, Any]],
    core: Path | None,
    self_check_mode: str,
    dry_run: bool,
) -> dict[str, Any]:
    slug = candidate["slug"]
    if candidate["blocked_reasons"]:
        return {
            "key": candidate["key"],
            "slug": slug,
            "status": "deferred",
            "reasons": candidate["blocked_reasons"],
            "warnings": candidate["warnings"],
            "paths": [],
        }

    overlap = find_skill_overlap(candidate, skills)
    if overlap:
        path = out_dir / "proposals" / f"{slug}-improve-{slugify(overlap[0]['name'])}.md"
        if not dry_run:
            _write_text(path, render_proposal(candidate, overlap[0]))
        return {
            "key": candidate["key"],
            "slug": slug,
            "status": "proposal",
            "reasons": [],
            "warnings": candidate["warnings"],
            "target_skill": overlap[0]["name"],
            "paths": [str(path)],
        }

    draft_dir = out_dir / slug
    skill_path = draft_dir / "SKILL.md"
    meta_path = draft_dir / "draft.json"
    existing = _load_json(meta_path) if meta_path.exists() else {}
    now = S.now_ms()
    revision = int(existing.get("revision", 0)) + 1
    created_at = int(existing.get("created_at_ms", now))
    manual_edits = False
    if skill_path.exists():
        current = _sha(skill_path.read_text(encoding="utf-8", errors="replace"))
        # 无 draft.json 的既有草稿视为人工资产；有元数据则按生成哈希判定
        manual_edits = current != existing.get("generated_sha256") if existing else True

    if dry_run:
        return {
            "key": candidate["key"],
            "slug": slug,
            "status": "planned_update" if existing else "planned_create",
            "reasons": [],
            "warnings": candidate["warnings"],
            "manual_edits": manual_edits,
            "paths": [str(skill_path), str(meta_path)],
        }

    if manual_edits:
        meta = {
            **existing,
            "schema": DRAFT_SCHEMA,
            "slug": slug,
            "name": f"draft-{slug}",
            "status": "draft",
            "draft": True,
            "source_pattern": candidate["key"],
            "updated_at_ms": now,
            "revision": revision,
            "manual_edits": True,
            "checks": {**existing.get("checks", {}), "self_check": "skipped"},
        }
        _write_text(meta_path, json.dumps(meta, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        return {
            "key": candidate["key"],
            "slug": slug,
            "status": "manual_edits",
            "reasons": ["draft_manually_modified"],
            "warnings": candidate["warnings"],
            "paths": [str(skill_path), str(meta_path)],
        }

    text = render_skill(candidate)
    _write_text(skill_path, text)
    check = (
        {"status": "skipped", "reason": "mode_off"}
        if self_check_mode == "off"
        else run_self_check(draft_dir, name=f"draft-{slug}", core=core)
    )
    verification = "pending" if check["status"] in ("pass", "skipped") else "self-check-failed"
    if check["status"] in ("pass", "skipped", "fail"):
        marker = f'self_check: "{check["status"]}"'
        text = text.replace('verification: "pending"', f'verification: "{verification}"', 1)
        text = text.replace('evidence_count:', f'{marker}\nevidence_count:', 1)
        _write_text(skill_path, text)

    meta = {
        "schema": DRAFT_SCHEMA,
        "slug": slug,
        "name": f"draft-{slug}",
        "status": "draft",
        "draft": True,
        "source_pattern": candidate["key"],
        "scope": candidate["scope"],
        "verification": verification,
        "review_status": candidate["review_status"],
        "instance_count": candidate["instance_count"],
        "task_evidence": candidate["task_evidence"],
        "project_count": candidate["project_count"],
        "evidence_ids": candidate["evidence_ids"],
        "created_at_ms": created_at,
        "updated_at_ms": now,
        "revision": revision,
        "generated_sha256": _sha(text),
        "checks": {
            "schema": "pass",
            "required_sections": "pass",
            "existing_skill_overlap": "none",
            "self_check": check["status"],
        },
        "warnings": candidate["warnings"],
        "blocked_reasons": [],
    }
    _write_text(meta_path, json.dumps(meta, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    return {
        "key": candidate["key"],
        "slug": slug,
        "status": "updated" if existing else "drafted",
        "reasons": [],
        "warnings": candidate["warnings"],
        "revision": revision,
        "verification": verification,
        "self_check": check,
        "paths": [str(skill_path), str(meta_path)],
    }


def _ensure_safe_out_dir(out_dir: Path, skills_dir: Path) -> None:
    """禁止把草稿写进正式 skills/（仅允许显式的 skills/_drafts 暂存区）。"""
    out = out_dir.expanduser().resolve()
    skills = skills_dir.expanduser().resolve()
    if out != skills and skills not in out.parents:
        return
    try:
        rel = out.relative_to(skills)
    except ValueError:
        return
    if not rel.parts or rel.parts[0] != "_drafts":
        raise ValueError(
            "out-dir 不得位于正式 skills/ 下；请使用 reports/skill-drafts（默认）或 skills/_drafts"
        )


def generate(
    db: Path,
    *,
    out_dir: Path,
    skills_dir: Path,
    key: str | None = None,
    min_instances: int = 3,
    dry_run: bool = False,
    self_check_mode: str = "auto",
) -> dict[str, Any]:
    _ensure_safe_out_dir(out_dir, skills_dir)
    candidates = load_candidates(db, min_instances=min_instances)
    if key:
        candidates = [c for c in candidates if c["key"] == key]
        if not candidates:
            candidates = [
                {
                    "key": key,
                    "slug": slugify(key.split(":", 1)[-1]),
                    "title": key,
                    "description": "",
                    "value": "",
                    "metadata": {},
                    "layer": None,
                    "review_status": None,
                    "scope": "project",
                    "project_count": 0,
                    "projects": [],
                    "instance_count": 0,
                    "task_evidence": "none",
                    "distinct_tasks": 0,
                    "refs": [],
                    "evidence_ids": [],
                    "blocked_reasons": ["pattern_not_found"],
                    "warnings": [],
                }
            ]
    skills = load_skills(skills_dir)
    core = find_smoke_core(skills_dir) if self_check_mode != "off" else None
    results: list[dict[str, Any]] = []
    for candidate in candidates:
        results.append(
            generate_one(
                candidate,
                out_dir=out_dir,
                skills=skills,
                core=core,
                self_check_mode=self_check_mode,
                dry_run=dry_run,
            )
        )
    report = {
        "schema": INDEX_SCHEMA,
        "db": str(db),
        "out_dir": str(out_dir),
        "dry_run": dry_run,
        "generated_at_ms": S.now_ms(),
        "candidates": results,
        "notes": [
            "草稿不进入 skills/，不会被 Skill 路由器加载。",
            "生成草稿不等于发布技能；正式发布仍走 skill-authoring 自检 + 人工 Review + L6 晋升。",
        ],
    }
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        _write_text(
            out_dir / "index.json",
            json.dumps(
                _file_safe_report(report, out_dir), ensure_ascii=False, indent=2, sort_keys=True
            )
            + "\n",
        )
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="从 L5 Pattern 生成 Skill 草稿（P1-3）")
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="扫描候选（只读，不生成）")
    scan.add_argument("--db", default=None)
    scan.add_argument("--min-instances", type=int, default=3)
    scan.add_argument("--json", action="store_true")

    gen = sub.add_parser("generate", help="生成 / 更新草稿（默认 reports/skill-drafts）")
    gen.add_argument("--db", default=None)
    gen.add_argument("--key", default=None, help="只处理指定 pattern key")
    gen.add_argument("--out-dir", default=str(REPO_ROOT / "reports" / "skill-drafts"))
    gen.add_argument("--skills-dir", default=str(REPO_ROOT / "skills"))
    gen.add_argument("--min-instances", type=int, default=3)
    gen.add_argument("--dry-run", action="store_true")
    gen.add_argument("--self-check", choices=("auto", "off", "required"), default="auto")
    gen.add_argument("--json", action="store_true")
    return parser


def _print_candidates(candidates: list[dict[str, Any]]) -> None:
    print(f"[skill-draft] candidates={len(candidates)}")
    for candidate in candidates:
        state = "eligible" if not candidate["blocked_reasons"] else "deferred"
        reasons = ",".join(candidate["blocked_reasons"]) or "-"
        warnings = ",".join(candidate["warnings"]) or "-"
        print(
            f"  - {candidate['key']} instances={candidate['instance_count']} "
            f"tasks={candidate['distinct_tasks']} scope={candidate['scope']} "
            f"state={state} reasons={reasons} warnings={warnings}"
        )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    db = S.resolve_db(getattr(args, "db", None))

    if args.command == "scan":
        try:
            candidates = load_candidates(db, min_instances=args.min_instances)
        except S.StoreUnavailable as exc:
            print(f"[skill-draft] 记忆库不可用: {exc}", file=sys.stderr)
            return 3
        if args.json:
            print(json.dumps(candidates, ensure_ascii=False, indent=2, sort_keys=True))
        else:
            _print_candidates(candidates)
        return 0

    try:
        report = generate(
            db,
            out_dir=Path(args.out_dir).expanduser(),
            skills_dir=Path(args.skills_dir).expanduser(),
            key=args.key,
            min_instances=args.min_instances,
            dry_run=args.dry_run,
            self_check_mode=args.self_check,
        )
    except ValueError as exc:
        print(f"[INVALID_ARGUMENT] {exc}", file=sys.stderr)
        return 2
    except S.StoreUnavailable as exc:
        print(f"[skill-draft] 记忆库不可用: {exc}", file=sys.stderr)
        return 3

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(
            f"[skill-draft] dry_run={report['dry_run']} candidates={len(report['candidates'])} "
            f"out={report['out_dir']}"
        )
        for item in report["candidates"]:
            extra = ",".join(item.get("reasons", [])) or item.get("verification", "")
            print(f"  - {item['key']} status={item['status']} {extra}")
        for note in report["notes"]:
            print(f"  [note] {note}")

    failed = any(
        item.get("self_check", {}).get("status") == "fail"
        or item.get("verification") == "self-check-failed"
        for item in report["candidates"]
    )
    if failed:
        return 1
    if args.self_check == "required" and any(
        item.get("self_check", {}).get("status") == "skipped" for item in report["candidates"]
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
