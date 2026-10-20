"""受限 YAML 子集解析器与规范渲染器（零第三方依赖）。

事实源：skills/vibe-coder-loop/engine/state-machine.md「Workflow Checkpoint（.state.md）」
支持的语法面（写端与读端共同拥有）：
- 块映射、块序列（``- item``，空序列 ``[]``）
- 标量：plain / 单引号 / 双引号
- 块字面量 ``|`` / ``|-``（多行文本，``resume`` 用）
- 行注释 ``#``（引号外）

不支持（出现即抛 ``SubsetParseError``，不猜）：
- 锚点/别名（``&a`` / ``*a``）、标签（``!!str``）、指令（``%YAML``）
- 流式集合（非空 ``[a, b]`` / ``{a: b}``）
- 多文档（第二个 ``---``）、复杂键（``? key``）
"""

from __future__ import annotations

import json
import math
import re
from enum import Enum
from typing import Any

__all__ = [
    "ParseQuality",
    "SubsetParseError",
    "parse_subset",
    "render_subset",
    "scan_flat_scalars",
    "parse_scalar",
]


class SubsetParseError(ValueError):
    """输入超出受限 YAML 子集语法。"""


class ParseQuality(str, Enum):
    STRICT = "strict"
    DEGRADED = "degraded"
    CORRUPT = "corrupt"


_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
_PLAIN_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
_INT_RE = re.compile(r"^[+-]?\d+$")
_FLOAT_RE = re.compile(r"^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$")
_FLAT_FIELDS = ("status", "phase", "loop", "level", "updated_at")
_PLAIN_FORBIDDEN_PREFIX = ("&", "*", "!", "%")


class _Line:
    __slots__ = ("indent", "content", "raw", "no")

    def __init__(self, no: int, raw: str) -> None:
        self.no = no
        self.raw = raw
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise SubsetParseError(f"第 {no} 行使用 Tab 缩进（只允许空格）")
        stripped = raw.strip()
        if stripped == "" or stripped.startswith("#"):
            self.indent = -1
            self.content = ""
        else:
            self.indent = len(raw) - len(raw.lstrip(" "))
            self.content = raw.strip()


def _prepare(text: str) -> list[_Line]:
    if text.startswith("\ufeff"):
        text = text[1:]
    raw_lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if len(raw_lines) > 50000:
        raise SubsetParseError("状态文件行数超过 50000 上限")
    lines = [_Line(i + 1, raw) for i, raw in enumerate(raw_lines)]

    # 允许（但不要求）文档以单个 `---` 开始
    first_sig = next((ln for ln in lines if ln.indent >= 0), None)
    if first_sig is not None and first_sig.content == "---" and first_sig.indent == 0:
        first_sig.indent = -1
        first_sig.content = ""
    for ln in lines:
        if ln.indent == 0 and ln.content == "---":
            raise SubsetParseError(f"第 {ln.no} 行出现第二个文档分隔符（多文档不支持）")
    return lines


def _next_sig(lines: list[_Line], i: int) -> int:
    while i < len(lines) and lines[i].indent < 0:
        i += 1
    return i


def _strip_inline_comment(text: str) -> str:
    quote = ""
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\" and quote == '"':
                i += 2
                continue
            if ch == quote:
                quote = ""
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "#" and (i == 0 or text[i - 1] in (" ", "\t")):
            return text[:i].rstrip()
        i += 1
    return text.rstrip()


def _parse_single_quoted(text: str) -> str:
    body = text[1:-1]
    return body.replace("''", "'")


def parse_scalar(text: str) -> Any:
    """解析单个标量（plain / 单引号 / 双引号）。"""
    s = _strip_inline_comment(text).strip()
    if s == "":
        raise SubsetParseError("空标量")
    if s.startswith('"'):
        if not s.endswith('"') or len(s) < 2:
            raise SubsetParseError(f"未闭合的双引号标量: {s!r}")
        try:
            return json.loads(s)
        except json.JSONDecodeError as exc:  # pragma: no cover - 由 json 保证
            raise SubsetParseError(f"非法双引号标量: {s!r}") from exc
    if s.startswith("'"):
        if not s.endswith("'") or len(s) < 2:
            raise SubsetParseError(f"未闭合的单引号标量: {s!r}")
        return _parse_single_quoted(s)
    if s.startswith("["):
        if s == "[]":
            return []
        raise SubsetParseError(f"非空流式序列不支持: {s!r}")
    if s.startswith("{"):
        if s == "{}":
            return {}
        raise SubsetParseError(f"非空流式映射不支持: {s!r}")
    if s.startswith("? "):
        raise SubsetParseError("复杂键不支持")
    if s.startswith(_PLAIN_FORBIDDEN_PREFIX):
        raise SubsetParseError(f"锚点/别名/标签不支持: {s!r}")
    low = s.lower()
    if low in ("null", "~"):
        return None
    if low in ("true", "false"):
        return low == "true"
    if _INT_RE.match(s):
        try:
            return int(s)
        except (ValueError, OverflowError) as exc:
            raise SubsetParseError(f"整数越界或非法: {s[:32]!r}") from exc
    if _FLOAT_RE.match(s):
        try:
            value = float(s)
        except (ValueError, OverflowError) as exc:
            raise SubsetParseError(f"浮点数非法: {s!r}") from exc
        if not math.isfinite(value):
            raise SubsetParseError(f"非有限浮点数: {s!r}")
        return value
    return s


def _literal_body(lines: list[_Line], start: int, parent_indent: int, chomp: str) -> tuple[str, int]:
    body: list[str] = []
    literal_indent: int | None = None
    i = start
    while i < len(lines):
        ln = lines[i]
        if ln.raw == "":
            if i == len(lines) - 1:
                i += 1
                break  # 文档末尾换行不是内容行
            if body or literal_indent is not None:
                body.append("")
            i += 1
            continue
        raw_indent = len(ln.raw) - len(ln.raw.lstrip(" "))
        if raw_indent <= parent_indent:
            break
        if literal_indent is None:
            literal_indent = raw_indent
        if raw_indent < literal_indent:
            break
        body.append(ln.raw[literal_indent:])
        i += 1
    # 末尾空行按 chomping 语义处理：|+ 保留，| / |- 去掉
    if chomp != "+":
        while body and body[-1] == "":
            body.pop()
    text = "\n".join(body)
    if chomp in ("", "+"):
        text += "\n"
    return text, i


def _split_mapping_entry(content: str, lineno: int) -> tuple[str, str]:
    text = content.strip()
    if text.startswith(("'", '"')):
        quote = text[0]
        i = 1
        escaped = False
        while i < len(text):
            ch = text[i]
            if quote == '"' and ch == "\\" and not escaped:
                escaped = True
                i += 1
                continue
            if ch == quote and not escaped:
                if quote == "'" and i + 1 < len(text) and text[i + 1] == "'":
                    i += 2
                    continue
                break
            escaped = False
            i += 1
        else:
            raise SubsetParseError(f"第 {lineno} 行键名引号未闭合")
        raw_key = text[: i + 1]
        remainder = text[i + 1 :].lstrip()
        if not remainder.startswith(":"):
            raise SubsetParseError(f"第 {lineno} 行引号键后缺少冒号: {content!r}")
        key = parse_scalar(raw_key)
        if not isinstance(key, str) or not key:
            raise SubsetParseError(f"第 {lineno} 行非法键名: {raw_key!r}")
        return key, remainder[1:].lstrip()
    key, sep, rest = text.partition(":")
    if not sep:
        raise SubsetParseError(f"第 {lineno} 行不是 key: value 形式: {content!r}")
    key = key.strip()
    if not _KEY_RE.match(key):
        raise SubsetParseError(f"第 {lineno} 行非法键名: {key!r}")
    return key, rest.lstrip()


def _parse_mapping(lines: list[_Line], start: int, indent: int) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    i = start
    while True:
        i = _next_sig(lines, i)
        if i >= len(lines):
            break
        ln = lines[i]
        if ln.indent < indent:
            break
        if ln.indent > indent:
            raise SubsetParseError(f"第 {ln.no} 行缩进异常（期望 {indent}）")
        if ln.content == "-" or ln.content.startswith("- "):
            break
        key, rest = _split_mapping_entry(ln.content, ln.no)
        if key in result:
            raise SubsetParseError(f"第 {ln.no} 行重复键: {key!r}")
        i += 1
        if rest in ("", None):
            j = _next_sig(lines, i)
            if j < len(lines) and lines[j].indent > indent:
                value, i = _parse_block(lines, j, lines[j].indent)
            else:
                value = None
        elif rest in ("|", "|-", "|+"):
            value, i = _literal_body(lines, i, indent, rest[1:])
        else:
            value = parse_scalar(rest)
        result[key] = value
    return result, i


def _parse_sequence(lines: list[_Line], start: int, indent: int) -> tuple[list[Any], int]:
    result: list[Any] = []
    i = start
    while True:
        i = _next_sig(lines, i)
        if i >= len(lines):
            break
        ln = lines[i]
        if ln.indent < indent:
            break
        if ln.indent > indent:
            raise SubsetParseError(f"第 {ln.no} 行缩进异常（期望 {indent}）")
        if not (ln.content == "-" or ln.content.startswith("- ")):
            break
        item_text = ln.content[1:].lstrip()
        i += 1
        if item_text == "":
            j = _next_sig(lines, i)
            if j < len(lines) and lines[j].indent > indent:
                value, i = _parse_block(lines, j, lines[j].indent)
            else:
                value = None
        elif item_text in ("|", "|-", "|+"):
            value, i = _literal_body(lines, i, indent, item_text[1:])
        elif _looks_like_mapping(item_text):
            value, i = _parse_mapping_item(lines, i, indent + 2, item_text, ln.no)
        else:
            value = parse_scalar(item_text)
        result.append(value)
    return result, i


def _looks_like_mapping(text: str) -> bool:
    try:
        _split_mapping_entry(text, 0)
        return True
    except SubsetParseError:
        return False


def _parse_mapping_item(
    lines: list[_Line],
    i: int,
    indent: int,
    first_text: str,
    lineno: int,
) -> tuple[dict[str, Any], int]:
    """解析 ``- key: value`` 形式的序列项（后续键缩进到 items 的 indent）。"""
    result: dict[str, Any] = {}
    key, rest = _split_mapping_entry(first_text, lineno)
    if rest in ("", None):
        j = _next_sig(lines, i)
        if j < len(lines) and lines[j].indent > indent:
            value, i = _parse_block(lines, j, lines[j].indent)
        else:
            value = None
    elif rest in ("|", "|-", "|+"):
        value, i = _literal_body(lines, i, indent, rest[1:])
    else:
        value = parse_scalar(rest)
    result[key] = value

    while True:
        i = _next_sig(lines, i)
        if i >= len(lines):
            break
        ln = lines[i]
        if ln.indent != indent or ln.content.startswith("- ") or ln.content == "-":
            break
        key, rest = _split_mapping_entry(ln.content, ln.no)
        if key in result:
            raise SubsetParseError(f"第 {ln.no} 行重复键: {key!r}")
        i += 1
        if rest in ("", None):
            j = _next_sig(lines, i)
            if j < len(lines) and lines[j].indent > indent:
                value, i = _parse_block(lines, j, lines[j].indent)
            else:
                value = None
        elif rest in ("|", "|-", "|+"):
            value, i = _literal_body(lines, i, indent, rest[1:])
        else:
            value = parse_scalar(rest)
        result[key] = value
    return result, i


_MAX_INDENT = 64


def _parse_block(lines: list[_Line], start: int, indent: int) -> tuple[Any, int]:
    if indent > _MAX_INDENT:
        raise SubsetParseError(f"缩进层级超过上限 {_MAX_INDENT}")
    if start >= len(lines):
        raise SubsetParseError("空块")
    ln = lines[start]
    if ln.content == "-" or ln.content.startswith("- "):
        return _parse_sequence(lines, start, indent)
    return _parse_mapping(lines, start, indent)


def _parse_subset_inner(text: str) -> dict[str, Any]:
    lines = _prepare(text)
    i = _next_sig(lines, 0)
    if i >= len(lines):
        raise SubsetParseError("空文档")
    if lines[i].indent != 0:
        raise SubsetParseError(f"第 {lines[i].no} 行顶层缩进必须为 0")
    value, i = _parse_block(lines, i, 0)
    i = _next_sig(lines, i)
    if i < len(lines):
        raise SubsetParseError(f"第 {lines[i].no} 行存在无法归属的游离内容")
    if not isinstance(value, dict):
        raise SubsetParseError("顶层必须是映射")
    return value


def parse_subset(text: str) -> dict[str, Any]:
    """严格解析为顶层映射；任何解析期异常统一转为 ``SubsetParseError``（fail-closed）。"""
    if len(text) > 4 * 1024 * 1024:
        raise SubsetParseError("状态文件超过 4 MiB 上限")
    try:
        return _parse_subset_inner(text)
    except SubsetParseError:
        raise
    except (RecursionError, ValueError, OverflowError, MemoryError) as exc:
        raise SubsetParseError(f"解析失败（{type(exc).__name__}）") from exc


def scan_flat_scalars(text: str) -> dict[str, Any] | None:
    """三层降级的第二层：只抽扁平标量，不尝试理解结构。"""
    if text.startswith("\ufeff"):
        text = text[1:]
    found: dict[str, Any] = {}
    pattern = re.compile(r"^(" + "|".join(_FLAT_FIELDS) + r"):[ \t]*(.*)$")
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        m = pattern.match(raw)
        if not m:
            continue
        key, rest = m.group(1), m.group(2)
        try:
            found[key] = parse_scalar(rest)
        except (SubsetParseError, ValueError, OverflowError):
            continue
    if not found:
        return None
    if "phase" not in found and "status" not in found:
        return None
    return found


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------
def _scalar_text(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    raise SubsetParseError(f"不支持的标量类型: {type(value).__name__}")


def _render_multiline(value: str, indent: int, prefix: str) -> list[str]:
    if value.endswith("\n\n"):
        header = "|+"
        body = value[:-1]
    elif value.endswith("\n"):
        header = "|"
        body = value[:-1]
    else:
        header = "|-"
        body = value
    out = [f"{' ' * indent}{prefix}{header}"]
    if body != "":
        for line in body.split("\n"):
            out.append(f"{' ' * (indent + 2)}{line}")
    return out


def _render_mapping_item(item: dict[str, Any], indent: int) -> list[str]:
    out: list[str] = []
    first = True
    for key, value in item.items():
        rendered_key = key if _PLAIN_KEY_RE.match(key) else json.dumps(key, ensure_ascii=False)
        if first:
            lead = " " * indent + "- "
            first = False
        else:
            lead = " " * (indent + 2)
        if isinstance(value, dict):
            if not value:
                out.append(f"{lead}{rendered_key}: {{}}")
            else:
                out.append(f"{lead}{rendered_key}:")
                out.extend(_render_mapping(value, indent + 4))
        elif isinstance(value, list):
            if not value:
                out.append(f"{lead}{rendered_key}: []")
            else:
                out.append(f"{lead}{rendered_key}:")
                out.extend(_render_sequence(value, indent + 4))
        elif isinstance(value, str) and "\n" in value:
            rendered = _render_multiline(value, indent + 2, f"{rendered_key}: ")
            if first is False and lead.startswith(" " * indent + "- "):
                rendered[0] = " " * indent + "- " + rendered[0].lstrip()
            elif len(out) == 0 and lead.startswith(" " * indent + "- "):
                rendered[0] = " " * indent + "- " + rendered[0].lstrip()
            out.extend(rendered)
        else:
            out.append(f"{lead}{rendered_key}: {_scalar_text(value)}")
    return out


def _render_sequence(items: list[Any], indent: int) -> list[str]:
    out: list[str] = []
    for item in items:
        if isinstance(item, dict):
            if not item:
                out.append(" " * indent + "- {}")
            else:
                out.extend(_render_mapping_item(item, indent))
        elif isinstance(item, list):
            if not item:
                out.append(" " * indent + "- []")
            else:
                out.append(" " * indent + "-")
                out.extend(_render_sequence(item, indent + 2))
        elif isinstance(item, str) and "\n" in item:
            out.extend(_render_multiline(item, indent, "- "))
        else:
            out.append(" " * indent + "- " + _scalar_text(item))
    return out


def _render_mapping(data: dict[str, Any], indent: int) -> list[str]:
    out: list[str] = []
    for key, value in data.items():
        rendered_key = key if _PLAIN_KEY_RE.match(key) else json.dumps(key, ensure_ascii=False)
        if isinstance(value, dict):
            if not value:
                out.append(f"{' ' * indent}{rendered_key}: {{}}")
            else:
                out.append(f"{' ' * indent}{rendered_key}:")
                out.extend(_render_mapping(value, indent + 2))
        elif isinstance(value, list):
            if not value:
                out.append(f"{' ' * indent}{rendered_key}: []")
            else:
                out.append(f"{' ' * indent}{rendered_key}:")
                out.extend(_render_sequence(value, indent + 2))
        elif isinstance(value, str) and "\n" in value:
            out.extend(_render_multiline(value, indent, f"{rendered_key}: "))
        else:
            out.append(f"{' ' * indent}{rendered_key}: {_scalar_text(value)}")
    return out


def render_subset(data: dict[str, Any], *, front_matter: bool = True) -> str:
    """规范渲染：所有字符串标量一律加引号；输出幂等。"""
    if not isinstance(data, dict):
        raise SubsetParseError("顶层必须是映射")
    lines = _render_mapping(data, 0)
    body = "\n".join(lines)
    if front_matter:
        return "---\n" + body + "\n"
    return body + "\n"
