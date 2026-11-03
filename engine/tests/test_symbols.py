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


def test_csharp_java_kotlin_definitions():
    cs = names(
        "x.cs",
        """namespace N {
public class C : B {
    public int P { get; set; }
    private int f, g;
    public C() {}
    public void M() {}
    public event Handler Ev;
}
interface I { void Q(); }
struct S {}
enum En { A }
record R(int X);
delegate void D();
}
""",
    )
    assert {"C", "P", "f", "g", "M", "Ev", "I", "Q", "S", "En", "A", "R", "D"} <= cs.keys()
    assert cs["M"] == (6, 6)
    java = names(
        "X.java",
        "class C {\n  int f;\n  C() {}\n  void m() {}\n}\ninterface I { void q(); }\nenum E { A }\nrecord R(int x) {}\n",
    )
    assert {"C", "f", "m", "I", "q", "E", "A", "R"} <= java.keys()
    kt = names(
        "x.kt",
        "class C(val p: Int) {\n    val f = 1\n    fun m() {}\n}\nobject O {}\nfun top() {}\ntypealias T = Int\n",
    )
    assert {"C", "f", "m", "O", "top", "T"} <= kt.keys()


def test_c_cpp_definitions():
    c = names(
        "x.c",
        "int f(int a) { return a; }\nchar *g(void) { return 0; }\nint proto(void);\nstruct S { int x; };\n"
        "typedef struct S T;\nenum E { A };\n#define M 1\n#define F(x) x\nint v = 1;\n",
    )
    assert {"f", "g", "S", "T", "E", "A", "M", "F", "v"} <= c.keys()
    assert "proto" not in c  # a prototype isn't the definition
    cpp = names(
        "x.cpp",
        "namespace n {\nclass C {\n public:\n  void m();\n  int f;\n};\nvoid C::m() {}\n"
        "template <class T> T id(T x) { return x; }\nusing A = int;\n}\n",
    )
    assert {"C", "m", "f", "id", "A"} <= cpp.keys()
    assert "S" in names("x.h", "struct S { int x; };\n")


def test_lookup_prefers_the_file_imports(tmp_path):
    files = {
        "web/lib/refs.ts": "export function rowKey() {}\n",
        "web/other/refs.ts": "export function rowKey() {}\n",
        "web/app/view.ts": 'import { rowKey } from "../lib/refs";\nrowKey();\n',
        "web/app/local.ts": "export function rowKey() {}\n",
        "pkg/mod.py": "from .util import helper\nhelper()\n",
        "pkg/util.py": "def helper():\n    return 1\n",
        "pkg/tests/test_util.py": "def helper():\n    pass\n",
        "web/lib/helper.ts": "export const helper = 1;\n",
        "jvm/Helper.java": "class Helper { static int helper() { return 1; } }\n",
        "jvm/Use.kt": "fun use() = Helper.helper()\n",
        "jvm/Box.kt": "class Box {\n    class Helper\n}\n",
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
    # Other languages only answer for files that aren't code.
    assert [d.path for d in index.lookup("helper", "web/app/view.ts")] == ["web/lib/helper.ts"]
    # Kotlin and Java see each other's definitions.
    assert [d.path for d in index.lookup("helper", "jvm/Use.kt")] == ["jvm/Helper.java"]
    # A type is nearest in the file named after it.
    assert [d.path for d in index.lookup("Helper", "jvm/Use.kt")] == ["jvm/Helper.java", "jvm/Box.kt"]
    assert {d.path for d in index.lookup("helper", "README.md")} == {
        "pkg/util.py",
        "pkg/tests/test_util.py",
        "web/lib/helper.ts",
        "jvm/Helper.java",
    }
