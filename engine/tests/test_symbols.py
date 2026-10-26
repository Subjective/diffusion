import subprocess

from diffusion.symbols import SymbolIndex, definitions_in


def names(path, src):
    return {n: (d.line, d.end) for n, d in definitions_in(path, src.encode())}


def test_typescript_definitions():
    src = """export function a() {}
const b = () => 1;
class C { m() {} }
interface I { p: number; q(): void }
type T = number;
const o = { f() {}, g: () => 2 };
"""
    found = names("x.ts", src)
    assert {"a", "b", "C", "m", "I", "p", "q", "T", "f", "g"} <= found.keys()
    assert found["a"] == (1, 1)


def test_python_go_rust_definitions():
    assert {"f", "K", "X", "attr"} <= names(
        "x.py", "def f():\n    pass\nclass K:\n    attr = 1\nX = 2\n"
    ).keys()
    assert {"F", "M", "T"} <= names(
        "x.go", "package p\nfunc F() {}\nfunc (t T) M() {}\ntype T struct{}\n"
    ).keys()
    assert {"f", "S", "Tr"} <= names("x.rs", "fn f() {}\nstruct S;\ntrait Tr {}\n").keys()
    assert names("x.txt", "def f(): pass") == {}


def test_lookup_prefers_the_file_imports(tmp_path):
    files = {
        "web/lib/refs.ts": "export function rowKey() {}\n",
        "web/other/refs.ts": "export function rowKey() {}\n",
        "web/app/view.ts": 'import { rowKey } from "../lib/refs";\nrowKey();\n',
        "web/app/local.ts": "export function rowKey() {}\n",
        "pkg/mod.py": "from .util import helper\nhelper()\n",
        "pkg/util.py": "def helper():\n    return 1\n",
        "pkg/tests/test_util.py": "def helper():\n    pass\n",
    }
    for p, text in files.items():
        (tmp_path / p).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / p).write_text(text)
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    index = SymbolIndex(tmp_path)

    ts = [d.path for d in index.lookup("rowKey", "web/app/view.ts")]
    assert ts == ["web/lib/refs.ts", "web/app/local.ts", "web/other/refs.ts"]
    assert [d.path for d in index.lookup("rowKey", "web/lib/refs.ts")][0] == "web/lib/refs.ts"
    assert [d.path for d in index.lookup("helper", "pkg/mod.py")] == ["pkg/util.py", "pkg/tests/test_util.py"]
    assert index.snippet(index.lookup("helper", "pkg/mod.py")[0]) == "def helper():\n    return 1"
    assert index.lookup("missing", "pkg/mod.py") == []
