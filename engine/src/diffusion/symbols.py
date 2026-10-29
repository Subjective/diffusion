"""Where names are defined in the PR head, for go-to-definition in the diff.

Search-based, like GitHub's code navigation: tree-sitter finds definitions in every tracked file, and a lookup
ranks the ones with a matching name by how close they are to the file the name was clicked in. No type
information, so overloaded names come back as several candidates.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from functools import cache
from pathlib import Path, PurePosixPath

import tree_sitter_go
import tree_sitter_javascript
import tree_sitter_python
import tree_sitter_rust
import tree_sitter_typescript
from tree_sitter import Language, Parser, Query, QueryCursor

from .repo import git

MAX_FILE_BYTES = 512_000
MAX_FILES = 30_000
MAX_SNIPPET_LINES = 80

_TS_COMMON = """
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(lexical_declaration (variable_declarator name: (identifier) @name)) @def
(variable_declaration (variable_declarator name: (identifier) @name)) @def
(pair key: (property_identifier) @name value: [(arrow_function) (function_expression)]) @def
"""
_TS = (
    _TS_COMMON
    + """
(class_declaration name: (type_identifier) @name) @def
(abstract_class_declaration name: (type_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(function_signature name: (identifier) @name) @def
(public_field_definition name: (property_identifier) @name) @def
(property_signature name: (property_identifier) @name) @def
(method_signature name: (property_identifier) @name) @def
"""
)
_JS = (
    _TS_COMMON
    + """
(class_declaration name: (identifier) @name) @def
(field_definition property: (property_identifier) @name) @def
"""
)
_PY = """
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
(module (expression_statement (assignment left: (identifier) @name)) @def)
(class_definition body: (block (expression_statement (assignment left: (identifier) @name)) @def))
"""
_GO = """
(function_declaration name: (identifier) @name) @def
(method_declaration name: (field_identifier) @name) @def
(type_spec name: (type_identifier) @name) @def
(const_spec name: (identifier) @name) @def
(var_spec name: (identifier) @name) @def
"""
_RS = """
(function_item name: (identifier) @name) @def
(function_signature_item name: (identifier) @name) @def
(struct_item name: (type_identifier) @name) @def
(enum_item name: (type_identifier) @name) @def
(trait_item name: (type_identifier) @name) @def
(type_item name: (type_identifier) @name) @def
(const_item name: (identifier) @name) @def
(static_item name: (identifier) @name) @def
(mod_item name: (identifier) @name) @def
(macro_definition name: (identifier) @name) @def
"""

_LANGS = {
    "typescript": (tree_sitter_typescript.language_typescript, _TS),
    "tsx": (tree_sitter_typescript.language_tsx, _TS),
    "javascript": (tree_sitter_javascript.language, _JS),
    "python": (tree_sitter_python.language, _PY),
    "go": (tree_sitter_go.language, _GO),
    "rust": (tree_sitter_rust.language, _RS),
}
_EXT = {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
}
# Extensions an import specifier may leave off.
_MODULE_EXT = re.compile(r"(\.d)?\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs)$")
NAME = re.compile(r"^[A-Za-z_$][\w$]*$")


@cache
def _lang(name: str) -> tuple[Language, Parser, Query]:
    # Keep the Language referenced alongside the Parser and Query built from it.
    fn, src = _LANGS[name]
    lang = Language(fn())
    return lang, Parser(lang), Query(lang, src)


@dataclass(frozen=True)
class Definition:
    path: str
    line: int  # 1-based
    end: int


def definitions_in(path: str, source: bytes) -> list[tuple[str, Definition]]:
    lang = _EXT.get(PurePosixPath(path).suffix)
    if not lang:
        return []
    _, parser, query = _lang(lang)
    tree = parser.parse(source)
    out = []
    for _, caps in QueryCursor(query).matches(tree.root_node):
        names, defs = caps.get("name"), caps.get("def")
        if not names or not defs:
            continue
        n, d = names[0], defs[0]
        name = source[n.start_byte : n.end_byte].decode(errors="replace")
        out.append((name, Definition(path, d.start_point.row + 1, d.end_point.row + 1)))
    return out


class SymbolIndex:
    """Definitions in every tracked source file of a checkout, by name."""

    def __init__(self, root: Path):
        self.root = root
        self.by_name: dict[str, list[Definition]] = defaultdict(list)
        files = [f for f in git("ls-files", "-z", cwd=root).split("\0") if PurePosixPath(f).suffix in _EXT]
        for rel in files[:MAX_FILES]:
            p = root / rel
            try:
                if p.stat().st_size > MAX_FILE_BYTES:
                    continue
                source = p.read_bytes()
            except OSError:
                continue
            for name, d in definitions_in(rel, source):
                self.by_name[name].append(d)

    def lookup(self, name: str, from_path: str, limit: int = 8) -> list[Definition]:
        """Definitions of `name`, nearest to `from_path` first: same file, files it imports, same directory."""
        found = self.by_name.get(name, [])
        if not found:
            return []
        imported = _imports(self.root, from_path)
        here = PurePosixPath(from_path).parent

        def rank(d: Definition) -> tuple:
            mod = _MODULE_EXT.sub("", d.path)
            mod = mod.removesuffix("/index").removesuffix("/__init__")
            near = (
                0 if d.path == from_path
                else 1 if any(mod == i or mod.endswith(f"/{i}") for i in imported)
                else 2 if PurePosixPath(d.path).parent == here
                else 3
            )  # fmt: skip
            test = bool(re.search(r"(^|/)(tests?|__tests__)/|[._-]test\.|_test\.|/test_", d.path))
            return (near, test, len(d.path), d.path, d.line)

        return sorted(found, key=rank)[:limit]

    def snippet(self, d: Definition) -> str:
        lines = (self.root / d.path).read_text(errors="replace").splitlines()
        return "\n".join(lines[d.line - 1 : min(d.end, d.line - 1 + MAX_SNIPPET_LINES)])


_SPEC = re.compile(r"""(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"])""")
_PY_FROM = re.compile(r"^\s*from\s+([.\w]+)\s+import\b|^\s*import\s+([\w.]+)", re.M)


def _imports(root: Path, from_path: str) -> list[str]:
    """Module paths `from_path` imports, as repo-relative paths without extension where they can be resolved."""
    try:
        text = (root / from_path).read_text(errors="replace")
    except OSError:
        return []
    here = PurePosixPath(from_path).parent
    out: list[str] = []
    for m in _SPEC.finditer(text):
        spec = next(g for g in m.groups() if g)
        out.append(_resolve(here, spec) if spec.startswith(".") else spec)
    if from_path.endswith((".py", ".pyi")):
        for m in _PY_FROM.finditer(text):
            spec = m.group(1) or m.group(2)
            dots = len(spec) - len(spec.lstrip("."))
            rest = spec[dots:].replace(".", "/")
            if dots:
                base = here
                for _ in range(dots - 1):
                    base = base.parent
                out.append(str(base / rest) if rest else str(base))
            else:
                out.append(rest)
    return [_MODULE_EXT.sub("", o) for o in out if o]


def _resolve(here: PurePosixPath, spec: str) -> str:
    parts: list[str] = list(here.parts) if str(here) != "." else []
    for seg in spec.split("/"):
        if seg == "..":
            if parts:
                parts.pop()
        elif seg not in ("", "."):
            parts.append(seg)
    return "/".join(parts)
