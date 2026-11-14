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
from merge_guard_alias import ANY_TOOL, HIDDEN, MARK, PATH_KEY, copy_marks, identify, members, note_path  # noqa: E402
from merge_guard_testkit import bash, check, finish, repo_on  # noqa: E402

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
push, bare = "push origin HEAD:main", "push"
deny = [f"bin/swiftc {push}", f"bin/swiftc {bare}", f"./hl {push}", f"./cpgit {push}",
        f"ln -s {git} t1; ./t1 {push}", f'cp "$(command -v git)" t2; ./t2 {push}', f"install -m 755 {git} t3 && ./t3 {bare}",
        f'ditto "$G" t4; ./t4 {push}', f"rsync -a bin/swiftc t5; ./t5 {push}", f"ln -s {git} t7; mv t7 t8; ./t8 {bare}",
        f'cp "$G" out/; out/x {push}', f"PATH=bin:$PATH swiftc {push}", f"export PATH=$PWD/bin:$PATH; swiftc {push}",
        f"PATH+=:bin; swiftc {push}", f"path+=(bin); swiftc {push}", f"PATH=$D:$PATH swiftc {push}",
        f"PATH=.:$PATH cpgit {push}", f"ln -s {git} bin/tl; PATH=bin:$PATH tl {push}",
        f"typeset -x PATH=bin:$PATH; swiftc {bare}"]
if "gh" in real:
    os.symlink(real["gh"], d / "bin" / "view")
    deny += ["bin/view pr merge 1", f"install -m 755 {real['gh']} t6 && ./t6 pr merge 1"]
for form in deny:
    bash(f"SE-90 п.1–4: инструмент под другим именем: {form!r}", form, True, cwd=d)
for form in ("bin/swiftc status", "./cpgit log -1", "PATH=bin:$PATH swiftc log -1", "PATH=/opt/x:$PATH ls",
             "ln -s /bin/echo t9; ./t9 hi", "PATH=$D:$PATH npm test", 'cp "$X" o.txt; cat o.txt', f"swiftc {push}",
             "./notes.txt"):
    bash(f"SE-90 п.1–4: проход: {form!r}", form, False, cwd=d)
# Модуль: идентичность, метки копирования, папки PATH.
for path, want in ((d / "bin" / "swiftc", "git"), (d / "cpgit", "git"), (d / "hl", "git"), (d / "notes.txt", None),
                   (d / "nope", None)):
    check(f"SE-90 identify({path.name})", None if identify(str(path)) == want else identify(str(path)), False)
for v, want in ((["cp", git, "g"], {MARK + "g"}), (["ln", "-s", "$G", "bin/"], {ANY_TOOL}), (["cp", "a.txt", "b"], set()),
                (["install", "-m", "755", git, "G2"], {MARK + "g2"}), (["cp", "-t", "out", git], {MARK + "git"}),
                (["mv", "a", "b"], set()), (["ln", "-s", git], {MARK + "git"})):
    got = copy_marks(v, str(d))
    check(f"SE-90 copy_marks({' '.join(v)!r})", None if got == (want | {MARK} if want else set()) else sorted(got), False)
check("SE-90 copy_marks: цепочка по метке", None if copy_marks(["mv", "a", "b"], None, {MARK + "a"}) == {
      MARK, MARK + "b"} else "нет метки", False)
for argv, want in ((["PATH=bin:$PATH"], ["bin"]), (["export", "PATH=/x:$PATH"], ["/x"]), (["PATH+=:b"], ["", "b"]),
                   (["path+="], [HIDDEN]), (["PATH=$D:/y"], [HIDDEN, "/y"]), (["ls"], None)):
    env = {}
    note_path(argv, env)
    check(f"SE-90 note_path({argv!r})", None if env.get(PATH_KEY) == want else env.get(PATH_KEY), False)

if __name__ == "__main__":
    finish(" — инструмент под другим именем по содержимому")
