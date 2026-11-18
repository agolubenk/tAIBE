"""
SE-78: путь команды из переменной с видимым именем (`"$D/swiftc"`) — не догадка «это git». Перенос #271 на базу 17.11:
отдельный файл, хук на пределе 500 строк. Запуск: python3 .claude/hooks/test_merge_guard_se78.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import bash, check, finish, mg, repo_on  # noqa: E402

se78 = repo_on("main", "se78")
(se78 / "tc.sh").write_text(  # apps/mobile-ios/scripts/typecheck.sh (HR_Helper-v2): ложная «запись в main»
    "# Calls the toolchain's swiftc directly; the shims don't run before the license.\n"
    "dev=\"${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}\"\n"
    "if [[ -z \"$dev\" ]]; then\n  dev=/Applications/Xcode.app/Contents/Developer\nfi\n"
    "swiftc=\"$dev/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc\"\nsdk=\"$dev/Platforms/x.sdk\"\nsources=()\n"
    "while IFS= read -r -d '' file; do sources+=(\"$file\"); done < <(find . -name '*.swift' -print0)\n"
    "\"$swiftc\" -typecheck -sdk \"$sdk\" -swift-version 5 \"${sources[@]}\" \"$@\"\n")
for form in ("bash tc.sh", "\"$D/swiftc\" -typecheck \"$@\"", "\"$DEVELOPER_DIR/usr/bin/swiftc\" -sdk \"$sdk\" \"${src[@]}\" \"$@\"",
             "$D/bin/x.sh \"$1\" \"$2\" \"$3\""):
    bash(f"SE-78: имя команды видно — не git: {form!r}", form, False, cwd=se78)
# Значение невидимо (`read D`, `$(…)` в команде, не в скрипте с диска): `D="git -c a.b="` без кавычек делится на слова,
# и видимое имя становится значением опции — догадка остаётся.
for form in ("$D/git push origin HEAD:main", "\"$D/gh\" pr merge 1", "$D/GIT push origin HEAD:main", "$D/Gh pr merge 1",
             "$D/$(echo gh) pr merge 1", "$D/g* push origin HEAD:main", "$D/swiftc gh pr merge 1",
             "read D < d.txt; $D/swiftc push origin HEAD:main", "D=$(cat d.txt); \"$D/swiftc\" \"$1\" \"$2\" \"$3\"",
             "\"$D/curl\" -X PUT https://api.github.com/repos/o/r/pulls/1/merge", "\"$S\" -sdk \"$K\" \"$1\" \"$@\"",
             "S=\"${DEV:-$(xcode-select -p)}/usr/bin/swiftc\"; \"$S\" -sdk \"$K\" \"$@\"",
             # Claude-линза #458 B1: раскрытие делится на слова, а имени переменной VAR не видит
             "read D < d.txt; ${=D}/swiftc push origin HEAD:main", "read D < d.txt; \"${=D}/swiftc\" push origin HEAD:main",
             "read D < d.txt; ${(z)D}/swiftc push origin HEAD:main", "D=$(cat d.txt); ${=D}/swiftc push origin HEAD:main",
             "set -- git -c a.b=; \"$@/swiftc\" push origin HEAD:main",
             "bash -c '$0/swiftc push origin HEAD:main' 'git -c a.b='",
             # B1': имя задаёт сама оболочка, без присваивания в команде
             "read < d.txt; $REPLY/swiftc push origin HEAD:main", "read < d.txt; \"$REPLY/swiftc\" push origin HEAD:main",
             "echo 'git -c a.b='; $_/swiftc push origin HEAD:main", "set -- git -c a.b=; $argv/swiftc push origin HEAD:main",
             "mapfile < d.txt; ${MAPFILE}/swiftc push origin HEAD:main",
             "set -- -a 'git -c a.b='; getopts a: o; $OPTARG/swiftc push origin HEAD:main",
             # B2 (backend): папка с пробелом — bash делит $PWD/$OLDPWD без кавычек
             "mkdir -p 'g -c a.b='; cd 'g -c a.b='; $PWD/swiftc push origin HEAD:main",
             "cd 'g -c a.b='; cd ..; $OLDPWD/swiftc push origin HEAD:main",
             "bash -c 'cd \"g -c a.b=\"; $PWD/swiftc push origin HEAD:main'"):
    bash(f"SE-78: имя git/gh/curl, не видно или значение невидимо — догадка: {form!r}", form, True, cwd=se78)
# Модуль: имя без пути, скрытое и подстановка — не «видимое».
for exe, hidden, want in (("$D/swiftc", False, True), ("$D/GIT", False, False), ("swiftc", False, False),
                          ("$D/swiftc", True, False), ("$D/" + mg.SUBST, False, False)):
    check(f"SE-78 visible_name({exe!r}, {hidden})", mg.visible_name(exe, hidden) != want or None, False)

finish(" — SE-78, имя команды видно")
