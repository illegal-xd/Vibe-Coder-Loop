"""L0-L7 分层常量与分类规则（Phase 1 只读审计 / Phase 2+ 回填共用）。

设计约束（见 docs/memory-layers.md）：
- 分层是**知识抽象层级**，不是成熟度分数。
- 分类必须给出 rule id + 理由，禁止无依据归类。
- 无法可靠归类 → layer=None + needs_review=True（不强行归类）。
- L0（原始证据）在 delx-memory 中**没有事件存储**，只能以「证据引用」形式存在；
  本模块绝不臆造 L0 记录。
"""

from __future__ import annotations

import json

LAYERS = ("L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7")

LAYER_NAMES = {
    "L0": "Raw",
    "L1": "Observation",
    "L2": "Episode",
    "L3": "Lesson",
    "L4": "Convention",
    "L5": "Pattern",
    "L6": "Skill",
    "L7": "Principle",
}

# 非知识轴类别：这些记录不进 L0-L7 覆盖率分母（但仍是有效记忆，受保护）。
CATEGORIES = (
    "knowledge",      # 落在 L1-L7
    "state",          # 计数器/指标快照（skill-metrics）
    "environment",    # 机器/工具环境事实（env: tooling:）
    "identity",       # 用户/Agent 身份与画像（user:）
    "preference",     # 用户偏好（preference:）
    "navigation",     # 索引/跳转页/加载包（reference: 导航页、module-index）
    "project_knowledge",  # 项目模块/文档事实（非规范，layer=null）
    "skill_mirror",   # Skill 规则镜像（指针，layer=null）
    "evidence",       # L0 证据引用
)

SCOPES = ("global", "project", "task", "session")

# 本工具链自产的衍生记录前缀：审计/蒸馏**必须忽略**它们，
# 否则二次运行会把衍生记录当成原始语料 → 计划漂移（破坏幂等）。
DERIVED_PREFIXES = ("obs:", "episode:")
# 运行观测账本：不属于原始语料，一次性分层回填必须跳过（否则会被改成 candidate/review）。
OBSERVATION_PREFIXES = ("signal:", "feedback:")


def is_derived_key(key: str) -> bool:
    """派生记录：obs:/episode: 切片，或 ``#`` 分片。不参与原始语料指纹/一次性回填。"""
    key = str(key or "")
    return key.startswith(DERIVED_PREFIXES) or "#" in key


def is_observation_key(key: str) -> bool:
    """运行观测账本（signal/feedback）：不是知识语料，不参与分层回填/蒸馏。"""
    return str(key or "").startswith(OBSERVATION_PREFIXES)


STATUSES = ("candidate", "active", "superseded", "archived")

REVIEW_STATUSES = ("pending", "approved", "rejected")

# 元数据键的权威命名（回填时写入；与现有字段尽量兼容）
# 现有字段：layer(6) / scope(12) / confidence(1) / evidence_level(2) /
#           source(19) / evidence(7) / related(6) / consolidated_from(10) /
#           archived_at(9)
FIELD_LAYER = "layer"
FIELD_SCOPE = "scope"
FIELD_STATUS = "status"
FIELD_REVIEW = "review_status"
FIELD_CONFIDENCE = "confidence"
FIELD_PROTECTED = "protected"
FIELD_NEEDS_REVIEW = "needs_review"
FIELD_EVIDENCE_IDS = "evidence_ids"
FIELD_SUPERSEDED_BY = "superseded_by"
FIELD_LEGACY_ID = "legacy_id"
FIELD_LAYER_BASIS = "layer_basis"        # rule id + 理由（可解释性）
FIELD_CATEGORY = "memory_category"       # knowledge / state / environment / ...

# ---------------------------------------------------------------------------
# 分类规则表：rule_id -> (layer, category, needs_review, reason 模板)
# 前缀是**默认初判**，仍须由内容信号复核（见 classify 的 override 分支）。
# ---------------------------------------------------------------------------
PREFIX_RULES = {
    "lesson":     ("L3", "knowledge", False, "lesson 前缀 = 任务级经验（现有实例层）"),
    "reflection": ("L3", "knowledge", False, "reflection 前缀 = 单轮反思经验（现有实例层）"),
    "experience": ("L3", "knowledge", False, "experience 前缀 = 跨项目排坑经验（现有实例层）"),
    "pattern":    ("L5", "knowledge", True, "pattern 前缀 = 疑似跨项目模式，需核验 ≥2 项目独立证据"),
    "principle":  ("L7", "knowledge", True, "principle 前缀 = 元原则，需人工审核"),
    "rule":       ("L4", "knowledge", False, "rule 前缀 = 项目/任务级可执行约定"),
    "project":    ("L4", "knowledge", False, "project 前缀 = 项目级事实与约定"),
    "reference":  ("L4", "knowledge", False, "reference 前缀 = 参考资料"),
    "skill":      ("L6", "knowledge", True, "skill 前缀 = 技能知识镜像，权威源在 skill 文件"),
    "skill-metrics": (None, "state", False, "周期指标快照，非知识条目"),
    "signal":     (None, "state", False, "反思信号账本（运行观测，非知识层）"),
    "feedback":   (None, "state", False, "记忆效用反馈账本（运行观测，非知识层）"),
    "env":        (None, "environment", False, "机器/安装环境事实"),
    "tooling":    (None, "environment", False, "工具链可用性与兜底手段"),
    "user":       (None, "identity", False, "用户画像/人格，非知识条目"),
    "preference": (None, "preference", False, "用户偏好，非知识条目"),
    "agent":      (None, "navigation", False, "Agent 加载包/指针，非独立知识"),
    "global":     ("L4", "knowledge", False, "全局用户约定（显式约束，scope=global）"),
}

# 内容信号：导航页 / 索引页判定（只认强短语，避免 "index.vue" 类误判）
NAV_MARKERS = ("纯导航", "跳转页", "不存实质内容", "记忆图谱", "加载包兜底",
               "Agent 记忆导航", "记忆导航", "本页为")
# key/title 级导航信号（slug 后缀 + 标题词）
NAV_SLUG_SUFFIX = ("-index", "-navigation", ":navigation")
NAV_TITLE_WORDS = ("索引", "导航", "总览目录")

# 内容信号：Episode（L2）叙事结构
EPISODE_MARKERS = ("## 触发", "## 根因", "## 修正", "## 结果", "## 过程", "## 复盘")

# 内容信号：证据强度
EVIDENCE_MARKERS = ("E4", "E3", "E2", "实测", "验证通过", "调用验证", "reproduce", "复现")

# 内容信号：聚合体（单条塞了多条独立经验）→ 需拆分，不得整体升层
AGGREGATE_MARKERS = ("条，", "合并", "聚合", "全景", "清单")

# 内容信号：冲突/取代
CONFLICT_MARKERS = ("已废弃", "不再适用", "superseded_by", "被取代", "已回滚", "反例")

MAX_INSTANCE_CHARS = 2000   # protocol §条目标长与外置
MAX_INSTANCE_LINES = 40


def decode_value(raw: str | None) -> str:
    """delx-memory 的 value 列以 JSON 存储（191 条 JSON 字符串 / 26 条 JSON 对象）。

    文本分析必须先解码，否则 heading/行号/列表类正则全部失效（`\n` 是字面量）。
    """
    try:
        parsed = json.loads(raw or "")
    except (json.JSONDecodeError, TypeError):
        return raw or ""
    if isinstance(parsed, str):
        return parsed
    return json.dumps(parsed, ensure_ascii=False, indent=2)


def value_kind(raw: str | None) -> str:
    try:
        parsed = json.loads(raw or "")
    except (json.JSONDecodeError, TypeError):
        return "raw"
    if isinstance(parsed, str):
        return "json-str"
    if isinstance(parsed, dict):
        return "json-obj"
    return "json-other"


def split_tags(tags_blob: str | None) -> list[str]:
    if not tags_blob:
        return []
    return [t for t in tags_blob.split(",") if t]


def scope_from_tags(tags: list[str]) -> str | None:
    for t in tags:
        if t.startswith("scope:") and t[len("scope:"):] in SCOPES:
            return t[len("scope:"):]
    return None
