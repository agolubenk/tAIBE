#!/usr/bin/env python3
"""
Проверка merge-guard: инструмент под другим именем по содержимому (SE-90 п. 1–4). Символьная и жёсткая ссылка, копия
git или gh под любым именем; копия, сделанная той же командой (ln/cp/install/ditto/rsync/mv); голое имя после смены PATH
в том же тексте. Настоящий git — из набора идентичности (members): на macOS — CommandLineTools, на ubuntu CI — /usr/bin/git.

Запуск: python3 -I .claude/hooks/test_merge_guard_identity.py  (только эти проверки; все — test_merge_guard.py)
"""
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_alias import (ANY_TOOL, HIDDEN, MARK, PATH_KEY, alias_kind, copy_marks, identify, members,  # noqa: E402
                               note_path)
from merge_guard_testkit import bash, check, finish, repo_on, same  # noqa: E402

real = {t: p for t, p, *_ in reversed(members())}  # первый путь каждого инструмента
git = real["git"]
d = repo_on("main", "se90i")
(d / "bin").mkdir()
os.symlink(git, d / "bin" / "swiftc")
shutil.copy(git, d / "cpgit")
try:
    os.link(git, d / "hl")
except OSError:  # другой том или запрет — жёсткую ссылку проверяет только macOS-проба
    os.symlink(git, d / "hl")
(d / "notes.txt").write_text("x\n")
(d / "run.sh").write_text("#!/bin/sh\necho ok\n")
(d / "run.sh").chmod(0o755)
push, bare = "push origin HEAD:main", "push"
deny = [f"bin/swiftc {push}", f"bin/swiftc {bare}", f"./hl {push}", f"./cpgit {push}",
        f"ln -s {git} t1; ./t1 {push}", f'cp "$(command -v git)" t2; ./t2 {push}', f"install -m 755 {git} t3 && ./t3 {bare}",
        f'ditto "$G" t4; ./t4 {push}', f"rsync -a bin/swiftc t5; ./t5 {push}", f"ln -s {git} t7; mv t7 t8; ./t8 {bare}",
        f'cp "$G" out/; out/x {push}', f"PATH=bin:$PATH swiftc {push}", f"export PATH=$PWD/bin:$PATH; swiftc {push}",
        f"PATH+=:bin; swiftc {push}", f"path+=(bin); swiftc {push}", f"PATH=$D:$PATH swiftc {push}",
        f"PATH=.:$PATH cpgit {push}", f"ln -s {git} bin/tl; PATH=bin:$PATH tl {push}",
        f"typeset -x PATH=bin:$PATH; swiftc {bare}",
        # Линза Контроля на 1b530894f: присваивание после env — смена PATH; копию делает не ln/cp/… — программы при
        # решении хука нет или её переписывает тот же текст, содержимое не видно: догадка.
        f"env PATH=bin:$PATH swiftc {push}", f"env -i PATH=bin swiftc {push}", f"nice env -u X PATH=bin swiftc {push}",
        f"env -P bin swiftc {push}", f"env -S 'PATH=bin swiftc {push}'", f"sudo PATH=bin:$PATH swiftc {push}",
        f"cat {git} > n1; chmod +x n1; ./n1 {push}", f"dd if={git} of=n2 2>/dev/null; chmod +x n2; ./n2 {push}",
        f"python3 -c 'import shutil; shutil.copy(\"{git}\", \"n3\")'; ./n3 {push}", f"tee n4 < {git} >/dev/null; ./n4 {bare}",
        f"cat {git} > run.sh; ./run.sh {push}", f"cat {git} > bin/n5; chmod +x bin/n5; PATH=bin:$PATH n5 {push}"]
if "gh" in real:
    os.symlink(real["gh"], d / "bin" / "view")
    deny += ["bin/view pr merge 1", f"install -m 755 {real['gh']} t6 && ./t6 pr merge 1"]
for form in deny:
    bash(f"SE-90 п.1–4: инструмент под другим именем: {form!r}", form, True, cwd=d)
for form in ("bin/swiftc status", "./cpgit log -1", "PATH=bin:$PATH swiftc log -1", "PATH=/opt/x:$PATH ls",
             "ln -s /bin/echo t9; ./t9 hi", "PATH=$D:$PATH npm test", 'cp "$X" o.txt; cat o.txt', f"swiftc {push}",
             "./notes.txt", "env PATH=bin:$PATH swiftc log -1", "./run.sh push", "env FOO=1 ./run.sh",
             "printf '#!/bin/sh\\necho ok\\n' > build.sh; chmod +x build.sh; ./build.sh test"):
    bash(f"SE-90 п.1–4: проход: {form!r}", form, False, cwd=d)
# Модуль: идентичность, метки копирования, папки PATH.
for path, want in ((d / "bin" / "swiftc", "git"), (d / "cpgit", "git"), (d / "hl", "git"), (d / "notes.txt", None),
                   (d / "nope", None)):
    check(f"SE-90 identify({path.name})", same(identify(str(path)), want), False)
for v, want in ((["cp", git, "g"], {MARK + "g"}), (["ln", "-s", "$G", "bin/"], {ANY_TOOL}), (["cp", "a.txt", "b"], set()),
                (["install", "-m", "755", git, "G2"], {MARK + "g2"}), (["cp", "-t", "out", git], {MARK + "git"}),
                (["mv", "a", "b"], set()), (["ln", "-s", git], {MARK + "git"})):
    got = copy_marks(v, str(d))
    check(f"SE-90 copy_marks({' '.join(v)!r})", same(got, want | {MARK} if want else set()), False)
check("SE-90 copy_marks: цепочка по метке", same(copy_marks(["mv", "a", "b"], None, {MARK + "a"}), {MARK, MARK + "b"}),
      False)
for argv, want in ((["PATH=bin:$PATH"], ["bin"]), (["export", "PATH=/x:$PATH"], ["/x"]), (["PATH+=:b"], ["", "b"]),
                   (["path+="], [HIDDEN]), (["PATH=$D:/y"], [HIDDEN, "/y"]), (["ls"], None),
                   (["env", "PATH=bin:$PATH", "a"], ["bin"]), (["env", "-u", "X", "-P", "b1:b2", "a"], ["b1", "b2"]),
                   (["nice", "env", "-i", "PATH=/x", "a"], ["/x"]), (["env", "-Pb3", "a"], ["b3"]),
                   (["env", "-C", "sub", "PATH=bin:/z", "a"], [HIDDEN, "/z"]), (["env", "-S", "PATH=bin a"], [HIDDEN]),
                   (["a", "PATH=bin"], None), (["sudo", "-P", "PATH=bin", "a"], ["bin"])):
    env = {}
    note_path(argv, env)
    check(f"SE-90 note_path({argv!r})", same(env.get(PATH_KEY), want), False)
# Файла нет или его переписывает тот же текст — догадка; файл виден и не переписан — нет.
for exe, written, dirs, want in (("./nope", set(), (), (None, True)), ("./notes.txt", set(), (), (None, False)),
                                 ("./notes.txt", {"notes.txt"}, (), (None, True)), ("bin/swiftc", set(), (), ("git", False)),
                                 ("n5", set(), ("bin",), (None, True)), ("swiftc", set(), ("bin",), ("git", False)),
                                 ("notes.txt", set(), (".", "bin"), (None, False))):
    check(f"SE-90 alias_kind({exe!r}, {sorted(written)}, {dirs})", same(alias_kind(exe, str(d), written, dirs), want), False)

if __name__ == "__main__":
    finish(" — инструмент под другим именем по содержимому")
