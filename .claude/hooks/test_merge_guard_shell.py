#!/usr/bin/env python3
"""
Проверка merge-guard: формы shell — подстановки, stdin, heredoc, комментарии, скрипты с диска и то, что их запускает.

Запуск: python3 -I .claude/hooks/test_merge_guard_shell.py  (только эти формы; все проверки — test_merge_guard.py)
"""
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_gh import GIT_PUSH, alias_tokens, gh_aliases  # noqa: E402
from merge_guard_comments import comment_readings, sure_comments  # noqa: E402
from merge_guard_expand import brace_argv, qualifier_code  # noqa: E402
from merge_guard_files import command_writes  # noqa: E402
from merge_guard_shell import command_name, proc_files  # noqa: E402
from merge_guard_testkit import C4, CONTROL, D9, ROOT, SESSIONS, TMP, bash, check, finish, mg, repo_on, run  # noqa: E402
import merge_guard_git  # noqa: E402
import merge_guard_launch as mg_launch  # noqa: E402

# Правило блоба make (coord 12:36, #402) проверяет свой блок на настоящем репозитории git; фикстуры остальных форм make
# лежат в TMP вне git, поэтому их разбор идёт без правила. До правки (тест до правки) атрибута ещё нет.
blob_rule = getattr(mg_launch, "same_blob", None)
mg_launch.same_blob = lambda p, data: True
on_main, on_branch = repo_on("main"), repo_on("fix/a")
# Псевдонимы gh — из своего конфига, а не с машины: на раннере ~/.config/gh нет, и `gh co` (псевдоним gh по
# умолчанию) там не прочитать — r21 «не запись» падали бы только в CI.
GH_CONF = TMP / "gh-shell"
GH_CONF.mkdir()
(GH_CONF / "config.yml").write_text("aliases:\n    co: pr checkout\n")
os.environ["GH_CONFIG_DIR"] = str(GH_CONF)

# --- автоматическое ревью 4 на f24846b9b: переполнение, деление слов, <(…), <<<, stdin, скрипты, $(…) в цели ---
many = " ".join(f"f/{i}" for i in range(16))
bash("17-й вариант — main", f"for b in {many} main; do git push origin $b; done", True, cwd=on_branch)
bash("17 веток без main", f"for b in {many} f/x; do git status; done", False, cwd=on_branch)
bash("деление слов: команда в переменной", 'C="gh pr merge"; $C 1', True)
bash("деление слов: push в переменной", "P='git push origin main'; $P", True)
bash("неизвестная команда $GH", "$GH pr merge 1", True)
bash("команда из $(…)", "$(echo gh) pr merge 1", True)
bash("неизвестная команда, push ветки", "$G push origin fix/a", False)
bash("<(…) выполняет команду", "cat <(gh pr merge 1)", True)
bash("bash <(echo …)", "bash <(echo 'gh pr merge 1')", True)
bash("diff двух <(…)", "diff <(git show a:x) <(git show b:x)", False)
bash("here-string в bash", "bash <<< 'gh pr merge 1'", True)
bash("here-string в grep", 'grep merge <<< "gh pr merge 1"', False)
bash("echo | bash", "echo 'gh pr merge 1' | bash", True)
bash("echo | bash безобидный", "echo 'ls' | bash", False)
bash("$(…) в цели с ветки", "git push origin $(echo main)", True, cwd=on_branch)
bash("$(rev-parse --abbrev-ref) с ветки", 'git push origin "$(git rev-parse --abbrev-ref HEAD)"', False, cwd=on_branch)
bash("неизвестная переменная с ветки", "git push origin $BRANCH", True, cwd=on_branch)
scripts = TMP / "scripts"
scripts.mkdir()
(scripts / "m.sh").write_text("#!/bin/bash\nset -e\ngh pr merge 1 --squash\n")
(scripts / "m.sh").chmod(0o755)
(scripts / "ok.sh").write_text("#!/bin/bash\necho hi\n")
(scripts / "ok.sh").chmod(0o755)
(scripts / "m.py").write_text("import subprocess\nsubprocess.run(['gh', 'workflow', 'run', 'deploy-contabo.yml'])\n")
(scripts / "idx.py").write_text("rules = open('.claude/rules/01-base.md').read()\nopen('/tmp/index.json', 'w').write(rules)\n")
bash("bash скрипт с мёржем", "bash m.sh", True, cwd=scripts)
bash("./скрипт с мёржем", "./m.sh", True, cwd=scripts)
bash("source скрипта", "source m.sh", True, cwd=scripts)
bash("безобидный скрипт", "bash ok.sh && ./ok.sh", False, cwd=scripts)
bash("python скрипт с деплоем", "python3 m.py", True, cwd=scripts)
bash("python скрипт читает законы и пишет своё", "python3 idx.py", False, cwd=scripts)
bash("скрипт пишется и запускается одной командой", f"cat > {TMP}/new.sh <<'EOF'\ngh pr merge 1\nEOF\nbash {TMP}/new.sh", True)
bash("данные пишутся и скрипт запускается", f"cat > {TMP}/n.md <<'EOF'\nтекст\nEOF\nbash {scripts}/ok.sh", False)

# --- автоматическое ревью 5 на 7abe5bcdb: опции перед скриптом, путь в переменной, большой скрипт, shell через MCP, -C ---
(scripts / "idx.py").write_text(f"rules = open('{ROOT}/.claude/rules/01-base.md').read()\nopen('/tmp/index.json', 'w').write(rules)\n")
(scripts / "var.py").write_text(f"p = '{ROOT}/.claude/settings.json'\nopen(p, 'w').write('{{}}')\n")
(scripts / "join.py").write_text(f"from pathlib import Path\nS = Path('{ROOT}') / '.claude' / 'settings.json'\nS.write_text('{{}}')\n")
(scripts / "m.js").write_text("require('child_process').execSync('gh workflow run deploy-contabo.yml')\n")
(scripts / "m.pl").write_text("system('gh pr merge 1');\n")
(scripts / "big.sh").write_text("#!/bin/bash\n" + "echo x\n" * 700_000)
(scripts / "bin").write_bytes(b"\xcf\xfa\xed\xfe\0\0" + b"gh pr merge 1" * 10)
(scripts / "bin").chmod(0o755)
bash("python читает законы по абсолютному пути и пишет своё", "python3 idx.py", False, cwd=scripts)
bash("путь в переменной, запись строкой ниже", "python3 var.py", True, cwd=scripts)
bash("путь из частей в переменной", "python3 join.py", True, cwd=scripts)
bash("bash -e скрипт", "bash -e m.sh", True, cwd=scripts)
bash("bash -o pipefail скрипт", "bash -o pipefail m.sh", True, cwd=scripts)
bash("bash -eo pipefail скрипт", "bash -eo pipefail m.sh", True, cwd=scripts)
bash("bash -c с опцией перед кодом", "bash -c -x 'gh pr merge 1'", True)
bash("bash скрипт, -c после него", "bash m.sh -c x", True, cwd=scripts)
bash("bash -c, скрипт на месте $0", "bash -c 'echo ok' m.sh", False, cwd=scripts)
bash("python3 -W со значением в связке", "python3 -Wdefault::DeprecationWarning m.py", True, cwd=scripts)
bash("python3 -W со значением отдельно", "python3 -W ignore m.py", True, cwd=scripts)
bash("python3 -m модуль из папки", "python3 -m m", True, cwd=scripts)
(scripts / "pkg").mkdir(exist_ok=True)
(scripts / "pkg" / "__main__.py").write_text("import os\nos.system('gh pr merge 1')\n")
bash("python3 -m пакет с __main__.py", "python3 -m pkg", True, cwd=scripts)
bash("python3 -m чужой модуль", "python3 -m json.tool a.json", False, cwd=scripts)
bash("node -r со значением", "node -r ts-node/register m.js", True, cwd=scripts)
bash("node -e, скрипт аргументом", "node -e 'require(process.argv[1])' m.js", True, cwd=scripts)
bash("perl -M со значением", "perl -Mfeature=say m.pl", True, cwd=scripts)
bash("скрипт больше 4 МБ", "bash big.sh", True, cwd=scripts)
bash("бинарный файл", "./bin --version", False, cwd=scripts)
check("serena execute_shell_command", run("mcp__serena__execute_shell_command", {"command": "gh pr merge 1"}), True)
check("serena execute_shell_command безобидный", run("mcp__serena__execute_shell_command", {"command": "ls"}), False)
bash("-C в другой репо, ветка из $(…) папки shell", f'git -C {on_branch} push origin "$(git branch --show-current)"', True, cwd=on_main)
bash("-C . и ветка из $(…)", 'git -C . push origin "$(git branch --show-current)"', False, cwd=on_branch)

# --- автоматическое ревью 6 на b13b4ab64: опции только в связке, код из stdin при файле, NUL не признак бинарника ---
(scripts / "mpl").write_text("system('gh pr merge 1');\n")
(scripts / "nul.sh").write_bytes(b"echo hi\n\0gh pr merge 1\n")
bash("bash -oe pipefail: -o берёт следующий, связка дальше", "bash -oe pipefail m.sh", True, cwd=scripts)
bash("bash -s: файл — аргумент, код из stdin", "bash -s ok.sh <<< 'gh pr merge 1'", True, cwd=scripts)
bash("pipe в bash -s", "echo 'gh pr merge 1' | bash -s ok.sh", True, cwd=scripts)
bash("bash -s без признака", "bash -s ok.sh <<< 'ls'", False, cwd=scripts)
bash("python3 -i: stdin после скрипта", "echo 'import os; os.system(\"gh pr merge 1\")' | python3 -i ok.py", True, cwd=scripts)
bash("perl -l не берёт следующий аргумент", "perl -l mpl", True, cwd=scripts)
bash("perl -0 не берёт следующий аргумент", "perl -0 mpl", True, cwd=scripts)
bash("perl -C не берёт следующий аргумент", "perl -C mpl", True, cwd=scripts)
bash("perl -Mstrict в связке", "perl -Mstrict mpl", True, cwd=scripts)
bash("perl -I со значением отдельно", "perl -I . mpl", True, cwd=scripts)
bash("perl -lw: связка продолжается после -l", "perl -lw mpl", True, cwd=scripts)
bash("perl -le код, не файл", "perl -le 'print 1'", False, cwd=scripts)
bash("NUL после первой строки — bash выполняет", "bash nul.sh", True, cwd=scripts)

# --- линза d9 на 7a0879cc9: код на stdin из файла, find -exec, комментарии shell, -c у псевдонима ---
(scripts / "f.sh").write_text("gh pr merge 1 --squash\n")
(scripts / "f.py").write_text('import subprocess\nsubprocess.run(["gh", "pr", "merge", "1"])\n')
(scripts / "notes.md").write_text("gh pr merge 1\n")
for form in ("bash < f.sh", "sh < f.sh", "bash -s < f.sh", "bash -s -- a < f.sh", "cat f.sh | bash", "cat f.sh | sh -s",
             "python3 < f.py", "python3 - < f.py", "cat f.py | python3",  # девять форм d9
             "bash 0< f.sh", "bash 0<f.sh", "< f.sh bash", "cat < f.sh | bash", "cat -- f.sh | sudo bash",
             "cat f.sh |\nbash", "cat f.sh | bash 2>/dev/null", "cat ok.sh f.sh | bash", "python3 -i ok.py < f.py"):
    bash(f"stdin из файла: {form!r}", form, True, cwd=scripts)
for form in ("bash < ok.sh", "cat ok.sh | bash", "grep merge < notes.md", "cat notes.md | grep merge",
             "bash ok.sh < notes.md", "python3 idx.py < f.py", "bash < nope.sh"):
    bash(f"stdin — данные или без признака: {form!r}", form, False, cwd=scripts)
bash("find -exec", "find . -exec gh pr merge 1 \\;", True, cwd=scripts)
bash("find -execdir … +", "find . -name x -execdir gh pr merge {} +", True, cwd=scripts)
bash("find -exec безобидный", "find . -type f -exec ls {} \\; -print", False, cwd=scripts)
(scripts / "c1.sh").write_text("#!/bin/bash\n# don't run gh pr merge 1 here\nls\n")
(scripts / "c2.sh").write_text("ls  # then: gh pr merge 1\n")
(scripts / "c3.sh").write_text("# note \\\ngh pr merge 1\n")
bash("апостроф в комментарии с признаком — лишний отказ: снимается только без '\"`(){}", "bash c1.sh", True, cwd=scripts)
bash("комментарий в конце строки — не код", "bash c2.sh", False, cwd=scripts)
bash("`\\` в конце комментария строку не продолжает", "bash c3.sh", True, cwd=scripts)
(scripts / "c4.sh").write_text("# запускать `gh pr merge 1` только Контролю\nls\n")
(scripts / "c5.sh").write_text('# см. .claude/rules/10-db-topology.md\nsource "$ROOT/dev-common.sh"\n')
bash("`…` в комментарии с признаком — лишний отказ: ` закрывает подстановку", "bash c4.sh", True, cwd=scripts)
bash("путь законов в комментарии — не признак «скрипт не записан»", "bash c5.sh", False, cwd=scripts)
bash("# в кавычках — не комментарий", "echo '#'; gh pr merge 1", True)
bash("# внутри слова — не комментарий", "echo a#b; gh pr merge 1", True)
bash("${#x} — не комментарий", 'echo "${#x}"; gh pr merge 1', True)
bash("комментарий в команде", "x=1 # gh pr merge 1", False)

# --- линза 85 и security-review на c54a5be77: `#`, который bash комментарием не считает; смешанный stdin ---
for form in ("touch notes\\ #433.md; gh pr merge 433", "echo a\\;#b; gh pr merge 1", "echo a\\|#b; gh pr merge 1",
             "echo a\\&#b; gh pr merge 1", "echo a\\(#b; gh pr merge 1", "echo a\\>#b; gh pr merge 1",
             "echo a\\\t#b; gh pr merge 1", "echo a\\\n#b; gh pr merge 1", "printf $'don\\'t #1\\n'; gh pr merge 1",
             "echo $'\\' #'; gh pr merge 1", "echo `true #` ; gh pr merge 1", "echo ${x:-a #b}; gh pr merge 1",
             "(( 1 # )) ; gh pr merge 1\n))", 'echo "$(echo "a" " # ")" ; gh pr merge 1'):
    bash(f"# для bash не комментарий: {form!r}", form, True)
bash("`\\`+перевод строки, потом пробел и # — комментарий", "echo a \\\n  # gh pr merge 1", False)
for form in ("printf 'gh pr merge 1\\n' | cat - ok.sh | bash", "cat ok.sh - <<< 'gh pr merge 1' | bash",
             "bash < ok.sh <<< 'gh pr merge 1'", "cat f.sh | cat | bash", "cat f.sh | cat - | bash"):
    bash(f"stdin смешан или через cat: {form!r}", form, True, cwd=scripts)
(scripts / "u.sh").write_text('gh pr merge 1\necho "\n')
(scripts / "u2.sh").write_text("ls\necho \"\n")
bash("скрипт не разобрать, в нём признак — отказ", "bash u.sh", True, cwd=scripts)
bash("скрипт не разобрать, признака нет — проход", "bash u2.sh", False, cwd=scripts)
for form in ('echo "$(echo " # (x)")" ; gh pr merge 1', "x=$( echo # (a) )\n) ; gh pr merge 1",
             "echo $( echo # \\( ) ; gh pr merge 1\n)", "echo ${x:-a # (b)} ; gh pr merge 1",
             "echo $[ 1 # ] ; gh pr merge 1"):
    bash(f"скобки и ] в «комментарии»: {form!r}", form, True)
(scripts / "c.sh").write_text("# архив (см. .claude/rules/10-db.md §2)\nprintf 'ls' | bash\n")
(scripts / "u3.sh").write_text("# см. (.claude/rules/10-db.md)\nls\necho \"\n")
(scripts / "u4.sh").write_text('python3 <<EOF\nx = """\n# gh pr merge 1\n"""\nEOF\necho "\n')
(scripts / "g.sh").write_text("gh pr merge 1\n")
bash("комментарий со скобками и путём правил — проход", "bash c.sh", False, cwd=scripts)
bash("то же через stdin из файла", "bash < c.sh", False, cwd=scripts)
bash("скрипт не разобрать, признак только в комментарии — проход", "bash u3.sh", False, cwd=scripts)
bash("скрипт не разобрать, признак в теле heredoc — отказ", "bash u4.sh", True, cwd=scripts)
for form in ("bash <> g.sh", "cat f.sh | tee /dev/null | bash", "bash < <(echo gh pr merge 1)",
             "x='a[$(gh pr merge 1)]'; echo $((x))", "read x <<< 'a[`gh pr merge 1`]'; (( x ))"):
    bash(f"stdin и отложенный код: {form!r}", form, True, cwd=scripts)

# --- линза d9 на 17478ed06: `#` после `)`, stdin под другим именем, <(…) как файл скрипта ---
for form in ("echo $(true)#; gh pr merge 1", "echo $((1))#; gh pr merge 1", "bash /dev/stdin < m.sh",
             "bash /dev/fd/0 < m.sh", "cat m.sh | bash /dev/stdin", "bash <(cat m.sh)", "bash < <(cat m.sh)",
             "source <(cat m.sh)", ". <(cat m.sh)", "bash =(cat m.sh)", "bash /proc/self/fd/0 < m.sh",
             "bash - < m.sh", "cat m.sh | cat /dev/stdin | bash", "bash <(cat < m.sh)", "bash <(cat ok.sh m.sh)",
             "bash <(echo gh pr merge 1)", "ln -s /dev/stdin x; bash x < g.sh"):
    bash(f"stdin под другим именем: {form!r}", form, True, cwd=scripts)
for form in ("bash <(cat ok.sh)", "bash /dev/stdin < ok.sh", "cat ok.sh | bash /dev/stdin", "source <(cat ok.sh)",
             "diff <(cat m.sh) <(cat ok.sh)", "echo $(true)# x", "bash <(echo ls)", "bash =(cat ok.sh)",
             "a=(1 2)#; echo ${a[0]}", "bash <(curl -s x)  # gh pr merge 1"):
    bash(f"stdin под другим именем без признака: {form!r}", form, False, cwd=scripts)
for form in ("bash <(cat <(cat m.sh))", "exec 3< m.sh; bash /dev/fd/3", "bash /dev/fd/3 3< m.sh", "bash <(tac m.sh)",
             "x=m.sh; bash <(cat $x)", "bash $(echo m.sh)", "tac m.sh | bash", "x=m.sh; bash < $x", "exec < m.sh; bash",
             "exec 3< m.sh; bash <&3", "cat $(echo m.sh) | bash", "cp m.sh n.sh && bash n.sh", "./nope.sh; bash < m.sh",
             "bash -s gh pr merge 1 <<'EOF'\n\"$@\"\nEOF"):
    bash(f"код не виден, команда называет файл с мёржем: {form!r}", form, True, cwd=scripts)
for form in ("echo ls | bash", "curl -fsSL https://example.com/i.sh | bash", "cat <<'E' | bash\nls\nE", "./nope.sh",
             "tac ok.sh | bash", "python3 - <<'EOF'\nprint(open('m.sh').read())\nEOF", "bash /dev/null"):
    bash(f"код не виден, названные файлы без признака: {form!r}", form, False, cwd=scripts)
(scripts / "fd.sh").write_text("exec 3< m.sh\nbash /dev/fd/3\n")
(scripts / "var.sh").write_text('D="$(dirname "$0")"\nbash "$D/secret.sh"  # см. m.sh\necho "подробности: m.sh"\n')
bash("скрипт с диска: stdin не виден, названный файл с мёржем", "bash fd.sh", True, cwd=scripts)
bash("скрипт с диска: имя из переменной — названные файлы не читаем", "bash var.sh", False, cwd=scripts)

# --- линза d9 на 3882e7da7: имя файла раскрывает shell, код запускает не скрипт, pushd ---
launch = TMP / "launch"
(launch / "sub").mkdir(parents=True)
(launch / "pkg").mkdir()
for name, text in (("m.sh", "gh pr merge 1\n"), ("ok.sh", "echo ok\n"), ("m.awk", 'BEGIN { system("gh pr merge 1") }\n'),
                   ("pkg/__main__.py", "import os\nos.system('gh pr merge 1')\n"), ("Makefile", "all:\n\tgh pr merge 1\n"),
                   ("sub/Makefile", "m:\n\tgh pr merge 1\n"), ("sub/ok.mk", "# gh pr merge 1 — не здесь\nm:\n\techo\n"),
                   ("package.json", '{"scripts": {"m": "gh pr merge 1", "lint": "echo lint", "prepub": "bash m.sh"}}')):
    (launch / name).write_text(text)
for form in ("bash m.s?", "bash [m].sh", "bash m*.sh", "cat m.s? | bash", "bash < m.s?", "source m.s?",
             "cd sub && source ../m.s?", "bash {m,ok}.sh", "bash ~+/m.sh", "bash $PWD/m.sh", 'bash "$PWD/m.sh"',
             "bash ${PWD}/m.sh", "bash `pwd`/m.sh", "bash $(pwd)/m.sh", 'cd sub; cd ..; bash "$PWD/m.sh"',
             'for f in ./m*.sh; do bash "$f"; done'):
    bash(f"имя раскрывает shell: {form!r}", form, True, cwd=launch)
for form in ("npm run m", "npm run -s m", "npm run-script m", "pnpm run m", "yarn m", "cd sub && npm --prefix .. run m",
             "cd sub && npm run m", "npm run pub", "make", "make m -C sub", "make -f Makefile all", "awk -f m.awk",
             "awk 'BEGIN{system(\"gh pr merge 1\")}'", "python3 pkg", "BASH_ENV=m.sh bash -c true",
             "env BASH_ENV=m.sh bash -c true", "export BASH_ENV=m.sh; bash -c true", "ENV=m.sh sh -i"):
    bash(f"код запускает не скрипт: {form!r}", form, True, cwd=launch)
for form in ("pushd sub >/dev/null; source ../m.sh", "pushd sub; popd; source m.sh", "python3 - <<\\PY\nimport os\n"
             "os.system('gh pr merge 1')\nPY"):
    bash(f"pushd/popd и `<<\\\\метка`: {form!r}", form, True, cwd=launch)
for form in ("bash ok.s?", "cd sub && bash ../ok.sh", "npm run lint --if-present", "make -n -f /dev/null",
             'bash "$PWD/ok.sh"', "ls ./*.sh", "pushd sub; popd; bash ok.sh", "awk '{print $1}' m.sh", "npm run",
             "case x in */docker/*) echo;; esac", "NODE_ENV=production node -e 1", "make -C sub -f ok.mk m",
             "npm view m", "pushd sub; bash ../ok.sh"):
    bash(f"раскрытие без признака: {form!r}", form, False, cwd=launch)

# --- r9, security-review 32b0175d0: папка shell, опции, жизненный цикл, include, неявный запуск ---
w = TMP / "r9" / "w"
for name, text in (("merge9.sh", "gh pr merge 1\n"), ("ok.sh", "echo ok\n"), ("sub/.keep", ""),
                   ("package.json", '{"scripts": {"m": "gh pr merge 1", "lint": "echo lint"}}'),
                   ("m.js", "require('child_process').execSync('gh pr merge 1')\n"), ("m.mk", "x:\n\tgh pr merge 1\n"),
                   ("tools/merge9.sh", "gh pr merge 1\n"), ("tools/run.sh", 'bash "$(dirname "$0")/merge9.sh"\n'),
                   ("tools/abs.sh", 'D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nbash "$D/merge9.sh"\n'),
                   ("tools/cd.sh", 'cd "$(dirname "$0")" && bash merge9.sh\n'),
                   ("life/package.json", '{"scripts": {"postinstall": "gh pr merge 1", "lint": "echo"}}'),
                   ("pub/package.json", '{"scripts": {"prepack": "gh pr merge 1"}}'),
                   ("ws/package.json", '{"workspaces": ["packages/*"], "scripts": {"lint": "echo"}}'),
                   ("ws/packages/a/package.json", '{"scripts": {"build": "gh pr merge 1"}}'),
                   ("tw/package.json", '{"workspaces": ["p/*"]}'), ("tw/turbo.json", '{"tasks": {"deploy": '
                   '{"dependsOn": ["^check"]}, "lint": {}}}'), ("tw/p/x/package.json",
                   '{"scripts": {"check": "gh pr merge 1", "deploy": "echo", "lint": "echo"}}'),
                   ("inc/Makefile", "include rules.mk\nall:\n\techo\n"), ("inc/rules.mk", "x:\n\tgh pr merge 1\n"),
                   ("inc2/Makefile", "-include $(X).mk\nall:\n\techo\n"), ("inc3/Makefile", "sinclude lib.mk\n"),
                   ("incdir/lib.mk", "x:\n\tgh pr merge 1\n"), ("lib.awk", 'BEGIN { system("gh pr merge 1") }\n'),
                   ("prog.awk", '@include "lib"\n{ print }\n'), ("gt/.git/HEAD", ""), ("gt/merge9.sh", "gh pr merge 1\n"),
                   ("gt/deep/t.sh", 'cd "$(git rev-parse --show-toplevel)" && bash merge9.sh\n'),
                   ("tools/hub.sh", 'S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nR="$(cd "$S/.." && pwd)"\ncd "$R"\n'
                    "bash merge9.sh\n"), ("tools/hubok.sh", 'R="$(cd "$(dirname "$0")/.." && pwd)"\ncd "$R"\nbash ok.sh\n'),
                   ("tools/lost.sh", 'cd "$UNSET_DIR"\nbash ok.sh\n')):
    (w / name).parent.mkdir(parents=True, exist_ok=True)
    (w / name).write_text(text)
for form in ("cd sub && cd - && bash merge9.sh", "cd sub; cd -; bash merge9.sh", "cd -; bash merge9.sh",
             'cd "$X" && bash merge9.sh', 'cd "$X" && npm run lint', 'cd $(mktemp -d) && make', f'cd "$X"; cd {w}; bash merge9.sh',
             "pushd sub; pushd ..; pushd; bash ../merge9.sh", "pushd sub; pushd +1; bash merge9.sh",
             "pushd -n sub; bash merge9.sh", "pushd -n sub; pushd; bash ../merge9.sh", "(cd sub; bash ../merge9.sh)",
             "(cd sub); bash merge9.sh", "bash tools/run.sh", "bash tools/abs.sh", "bash tools/cd.sh",
             'D=$(cd sub && pwd); bash "$D/../merge9.sh"', 'cd "$X" && echo 1 > .claude/hooks/x.py',
             "npm --foo bar run m", "npm exec -c 'gh pr merge 1'", "npx -c 'gh pr merge 1'",
             "npm exec --call='gh pr merge 1'", "node --run m", "node --run=m", "make -j -f m.mk", "make -sfm.mk",
             "make -Cinc", "make -C inc3 -I ../incdir", "awk -i lib.awk '{ print }'", "awk -f prog.awk",
             "awk -E lib.awk", "awk -vx=1 -f lib.awk", "cd life && npm ci", "cd life && npm i left-pad",
             "cd life && yarn", "cd life && pnpm install", "cd life && bun install", "cd life && npm it",
             "cd pub && npm pack", "cd pub && npm publish", "cd ws && npm run build --workspaces",
             "cd ws && npm run build -w packages/a", "cd ws && pnpm -r build", "cd ws && yarn workspaces foreach run build",
             "cd tw && turbo run deploy", "cd tw && turbo deploy", "NODE_OPTIONS='-r ./m.js' npm run lint",
             'NODE_OPTIONS="--require=./m.js" node -e 1', "NODE_OPTIONS='--import ./m.js' node -e 1",
             "MAKEFILES=m.mk make -C inc2", "make -C inc2", "make -j4 -C inc2",  # include в Makefile — coord 12:06
             "npm --script-shell ./merge9.sh run lint",
             "npm_config_script_shell=./merge9.sh npm run lint", "NPM_CONFIG_SCRIPT_SHELL=./merge9.sh npm test",
             "bash -ni merge9.sh", "bash tools/hub.sh", "cd gt/deep && bash t.sh", "command node; cat merge9.sh",
             'cd gt/deep && cd "$(git rev-parse --show-toplevel)" && bash merge9.sh',
             'D=sub; R="$(cd "$D/.." && pwd)"; bash "$R/merge9.sh"', "bash -n +n merge9.sh",
             "bash -o noexec +o noexec merge9.sh", "bash -n +o noexec merge9.sh", "bash +no noexec merge9.sh",
             'x=$(cd sub 2>$(./merge9.sh) && pwd)', 'cd "$X" && echo 1 > out.txt', 'cd "$X" && touch x.py',
             "cd sub | cat; bash merge9.sh", "cd sub & bash merge9.sh", "true | cd sub; bash merge9.sh",
             "cd sub && ls | grep x; bash ../merge9.sh"):
    bash(f"r9, видно: {form!r}", form, True, cwd=w)
for form in ("cd sub && cd - && bash ok.sh", 'cd "$X" && ls', f'cd "$X" && bash {w}/ok.sh', f'cd "$X"; cd {w}; bash ok.sh',
             "(cd sub); bash ../merge9.sh", "(cd sub) && bash ok.sh", "pushd sub; popd; bash ok.sh",
             f'cd "$X" && echo 1 > {w}/out.txt', "node --run lint", "awk -F: '{ print $1 }' /etc/passwd",
             "cd pub && npm version patch", "cd ws && npm run build", "cd tw && turbo run lint",
             "NODE_OPTIONS=--max-old-space-size=6144 npm run lint", "NODE_OPTIONS='--import tsx' node -e 1",
             "bash -n merge9.sh", "bash -n -c 'gh pr merge 1'", "bash -o noexec merge9.sh",
             "cd life && npm run lint", "bash tools/hubok.sh", "bash tools/lost.sh", "node --version; cat merge9.sh",
             "command -v node; cat merge9.sh", "python3 -V; cat merge9.sh", "perl -v < merge9.sh",
             "bash +n -n merge9.sh", "bash -no noexec merge9.sh", 'D=$(cd sub 2>/dev/null && pwd); bash "$D/../ok.sh"',
             'cd "$X" && ls > /dev/null', "cd sub | cat; bash ok.sh", "cd sub && ls | grep x; bash ../ok.sh"):
    bash(f"r9, без признака: {form!r}", form, False, cwd=w)

# --- опции до файла — по разбору, не по первому совпадению имени (автоматическое ревью на 74a37e732) ---
o = TMP / "r10"
for name in ("noexec", "+n", "-n"):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text("gh pr merge 1\n")
for form in ("bash -n +o noexec noexec", "bash -n +n -- +n", "bash -o noexec +o noexec noexec", "bash -n +n -- -n"):
    bash(f"r10, видно: {form!r}", form, True, cwd=o)
for form in ("bash -n noexec", "bash -n -- +n", "bash -o noexec noexec", "bash +n -n -- -n"):
    bash(f"r10, только синтаксис: {form!r}", form, False, cwd=o)

# --- SE-128: длинные опции make — как у getopt_long (точное имя или однозначный префикс); строка --eval/-E ---
o = TMP / "se128"
for name, text in (("Makefile", "all:\n\techo\n"), ("sub/Makefile", "x:\n\tgh pr merge 1\n"),
                   ("i/Makefile", "-include lib.mk\nall:\n\techo\n"), ("i/inc/lib.mk", "x:\n\tgh pr merge 1\n"),
                   ("sub/mk", "x:\n\tgh pr merge 1\n"), ("inc/lib.mk", "x:\n\tgh pr merge 1\n"),
                   ("ok/Makefile", "x:\n\techo\n"), ("ok.mk", "x:\n\techo\n"), ("--dir", "x:\n\tgh pr merge 1\n"),
                   ("j/Makefile", "x:\n\tgh pr merge 1\n"), ("j/ok.mk", "x:\n\techo\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
for form in ("make --dir=sub x", "make --direc sub x", "make --fil=sub/mk x", "make --makef=sub/mk x",
             "make -C i --include=inc x", "gmake --ev 'x:;gh pr merge 1' x", "make --eval='x:;gh pr merge 1'",
             "make -E 'x:;gh pr merge 1' x", "make -sE'x:;gh pr merge 1'", "make --eval 'include sub/mk' x",
             "make -C j --jobserver-auth -f ok.mk x", "make --d x", "make --o -f ok.mk x", "make --frob x",
             # как сейчас: целые опции и значение `-f`, похожее на опцию (файл `--dir`), не раскрывается
             "make -C sub x", "make --directory=sub x", "make --directory sub x", "make -f --dir x"):
    bash(f"SE-128, видно: {form!r}", form, True, cwd=o)
for form in ("make x", "make --dir=ok x", "make --fil=ok.mk x", "make -C j -f ok.mk x", "make --no-print x",
             "make --jobs=4 --keep x", "gmake --eval='x: y' x", "make --ev 'x: y' x", "make -- --dir=sub",
             "make --dry-run x"):
    bash(f"SE-128, без признака: {form!r}", form, False, cwd=o)
why = run("Bash", {"command": "make --o -f ok.mk x"}, cwd=o) or ""
check(f"SE-128: причина — опция make, а не папка: {why[:90]!r}", why if "длинная опция make" in why else None, True)
# SE-133: MAKEFLAGS/GNUMAKEFLAGS — опции make из окружения (`-I`, `MAKEFILES=` сверены с make 3.81); первое слово без
# `-` — связка. Папку make разбор не знает (`-C` команды, `cd`), поэтому опция чтения или MAKEFILES=/SHELL= — отказ.
for form in ("MAKEFLAGS='-I inc' make x", "MAKEFLAGS=-Iinc make x", "MAKEFLAGS=Iinc make x", "MAKEFLAGS=sIinc make x",
             "GNUMAKEFLAGS=--include-dir=inc make x", "env MAKEFLAGS=--incl=inc make x", "export MAKEFLAGS=-Iinc; make x",
             "MAKEFLAGS='--eval=x:;gh\\ pr\\ merge\\ 1' make x", "MAKEFLAGS='-sE x:;gh\\ pr\\ merge\\ 1' make x",
             "MAKEFLAGS=-Cj make x", "MAKEFLAGS=--frob make x",  # -C из окружения make не слушает — с запасом
             "MAKEFLAGS=-Iok make x", "MAKEFLAGS=-Iinc make -C sub x", "export MAKEFLAGS=-Iinc; cd sub; make x",
             "MAKEFLAGS='MAKEFILES=ok.mk' make x", "MAKEFLAGS='-- MAKEFILES=ok.mk' make x",
             "GNUMAKEFLAGS=MAKEFILES=ok.mk make x", "MAKEFLAGS='-s SHELL=./ok.sh' make x",
             "MAKEFLAGS='-- SHELL=./ok.sh' make x", "MAKEFLAGS='-- .SHELLFLAGS=-ec' make x",
             "make MAKEFLAGS=-Iinc x"):
    bash(f"SE-133, отказ: {form!r}", form, True, cwd=o)
for form in ("MAKEFLAGS=-s make x", "MAKEFLAGS='-j4 --no-print-directory' make x", "GNUMAKEFLAGS=-k make x",
             "MAKEFLAGS= make x", "MAKEFLAGS='-- V=1' make x", "MAKEFLAGS='-s -- CFLAGS=-O2' make x"):
    bash(f"SE-133, без признака: {form!r}", form, False, cwd=o)
why = run("Bash", {"command": "MAKEFLAGS='-- MAKEFILES=ok.mk' make x"}, cwd=o) or ""
check(f"SE-133: причина — MAKEFLAGS: {why[:90]!r}", why if "MAKEFLAGS или GNUMAKEFLAGS" in why else None, True)
# B2 (backend, #398): `-I` из MAKEFLAGS make берёт от папки после `-C`/`cd` — признак только в sub/inc/lib.mk
o = TMP / "se133"
for name, text in (("Makefile", "-include lib.mk\nx:\n\techo\n"), ("inc/lib.mk", "y:\n\techo\n"),
                   ("sub/Makefile", "-include lib.mk\nx:\n\techo\n"), ("sub/inc/lib.mk", "x:\n\tgh pr merge 1\n"),
                   ("ok/Makefile", "x:\n\techo\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
for form in ("MAKEFLAGS=-Iinc make -C sub x", "export MAKEFLAGS=-Iinc; cd sub; make x",
             "cd sub; MAKEFLAGS=-Iinc make x"):
    bash(f"SE-133 B2, отказ: {form!r}", form, True, cwd=o)
for form in ("make -C sub x", "make -Iinc x"):  # coord 12:06 (#402): include в Makefile — отказ, папка `-I` не важна
    bash(f"SE-133 B2, include в Makefile — отказ: {form!r}", form, True, cwd=o)
bash("SE-133 B2, без признака: Makefile без include", "make -C ok x", False, cwd=o)
# Вторая линза backend (#398, 9c8f9f02e): make делит MAKEFLAGS только по пробелам (кавычка — обычный символ, `\ ` —
# склейка) и раскрывает `$(Y)` из окружения — сверено с make 3.81; `ИМЯ+=` shell тоже отдаёт в окружение
for form in ("MAKEFLAGS=\"-s 'a MAKEFILES=ok.mk'\" make x", "MAKEFLAGS=\"-s 'a -Iinc'\" make -C sub x",
             "Y=-Iinc MAKEFLAGS='$(Y)' make -C sub x", "MAKEFLAGS='-s\\ Iinc' make -C sub x",
             "MAKEFLAGS+=-Iinc make -C sub x", "export MAKEFLAGS+='MAKEFILES=ok.mk'; make x",
             "MAKEFILES+=sub/inc/lib.mk make x"):
    bash(f"SE-133 линза 2, отказ: {form!r}", form, True, cwd=o)
for form in ("MAKEFLAGS='-j4 -s' make -C ok x", "MAKEFLAGS+= make -C ok x"):
    bash(f"SE-133 линза 2, без признака: {form!r}", form, False, cwd=o)
why = run("Bash", {"command": "MAKEFLAGS=\"-s 'a -Iinc'\" make x"}, cwd=o) or ""
check(f"SE-133 линза 2: причина — MAKEFLAGS: {why[:90]!r}", why if "MAKEFLAGS или GNUMAKEFLAGS" in why else None, True)
# Линза backend (#398, cc5db25db): `ИМЯ+=` склеивает с прежним значением без пробела, части по отдельности чисты —
# make 3.81 читает inc/ (sub/inc/lib.mk). Любое `ИМЯ+=` с непустым значением у этих имён — отказ (APPEND_WHY).
for form in ("MAKEFLAGS=\"-s --\"; MAKEFLAGS+=\"include-dir=inc\" make -C sub x",
             "MAKEFLAGS=\"-s MAKEFI\"; MAKEFLAGS+=\"LES=inc/lib.mk\" make -C sub x", "MAKEFLAGS+=-k make -C ok x",
             "GNUMAKEFLAGS+=-k make -C ok x", "MAKEFILES=sub/inc/li; MAKEFILES+=b.mk make x",
             "BASH_ENV=a; BASH_ENV+=b.sh bash -c true", "export ENV+=b.sh; sh -c true",
             "NODE_OPTIONS+=' -r ./m.js' node -e 1", "npm_config_script_shell+=sh npm test"):
    bash(f"SE-133 линза backend +=, отказ: {form!r}", form, True, cwd=o)
why = run("Bash", {"command": "MAKEFLAGS=\"-s --\"; MAKEFLAGS+=\"include-dir=inc\" make -C sub x"}, cwd=o) or ""
check(f"SE-133 +=: причина — склейка: {why[:90]!r}", why if "ИМЯ+=" in why else None, True)
# --- SE-135: старые пробелы make (линза Claude #396). Сверено с make 3.81: `-l` берёт остаток связки (`-lf ok.mk` —
# ./Makefile), `-f -` и `-f /dev/stdin` читают stdin, MAKEFILES (окружение и строка) — от папки после `-C`,
# `SHELL=` в строке — shell рецептов. `--eval` — make 4.x (assumed, по документации).
o = TMP / "se135"
for name, text in (("Makefile", "x:\n\techo\n"), ("ok.mk", "x:\n\techo\n"), ("sub/Makefile", "x:\n\techo\n"),
                   ("sub/mk", "x:\n\tgh pr merge 1\n"), ("s.sh", "gh pr merge 1\n"), ("inc/lib.mk", "y:\n\techo\n"),
                   ("sub/inc/lib.mk", "x:\n\tgh pr merge 1\n"), ("l/Makefile", "x:\n\tgh pr merge 1\n"),
                   ("l/ok.mk", "x:\n\techo\n"), ("l/ok/Makefile", "x:\n\techo\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
(o / "in.mk").symlink_to("/dev/stdin")
os.mkfifo(o / "p.mk")
for form in ("make -lf ok.mk x", "make -klC ok x", "make -l2f ok.mk x"):  # 1: связка с `-l`
    bash(f"SE-135 связка, отказ: {form!r}", form, True, cwd=o / "l")
for form in ("make -l -f ok.mk x", "make -l 2 -f ok.mk x", "make -j4 -f ok.mk x", "make -sl -f ok.mk x", "make -C ok x"):
    bash(f"SE-135 связка, без признака: {form!r}", form, False, cwd=o / "l")
for form in ("make -f - x", "make --file=- x", "make --fil=- x", "make -f /dev/stdin x", "make -f /dev/fd/0 x",
             "cat ok.mk | make -f - x", "make -f in.mk x", "make -f p.mk x", "make -C sub -f ../in.mk x",
             "make --eval 'include /dev/stdin' x", "make -E '-include /dev/fd/0' x",  # 2: Makefile из stdin
             "make X=sub/mk --eval 'include $(X)' x", "make --eval '$(eval include sub/mk)' x",  # 3: `$` в --eval
             "make --eval='x:;bash s.sh' x", "make -E 'x: ; bash s.sh' x", "make --eval 'x:\n\tbash s.sh' x",
             "make --eval '.RECIPEPREFIX=>' x", "make --eval 'A != bash s.sh' x",  # 4: рецепт и запуск в --eval
             "make --eval 'SHELL=./s.sh' x", "make --eval 'x: SHELL=./s.sh' x", "make --eval 'MAKEFILES=sub/mk' x",
             "make --eval 'override .SHELLFLAGS=-c ./s.sh' x", "make --eval 'export BASH_ENV=./s.sh' x",
             "make --eval 'define SHELL\n./s.sh\nendef' x",
             "make SHELL=./s.sh x", "make SHELL:=./s.sh x", "make .SHELLFLAGS=-ec x",  # SHELL=/MAKEFILES= в строке
             "make -C sub MAKEFILES=inc/lib.mk x", "MAKEFILES=inc/lib.mk make -C sub x",
             "env MAKEFILES=inc/lib.mk make -C sub x", "export MAKEFILES=inc/lib.mk; make -C sub x"):
    bash(f"SE-135, отказ: {form!r}", form, True, cwd=o)
for form in ("make -f ok.mk x", "make -f sub/Makefile x", "make -n -f /dev/null x", "make --eval 'include ok.mk' x",
             "make --eval 'V=1' x", "make --eval 'x: y' x", "make V=1 x", "make CC=clang -C sub x",
             "MAKEFLAGS=-s make -C sub x"):
    bash(f"SE-135, без признака: {form!r}", form, False, cwd=o)
for form, part in (("make -f - x", "Makefile из потока"), ("make --eval 'include $(X)' x", "строка `--eval`"),
                   ("make SHELL=./s.sh x", "переменная make в командной строке"),
                   ("MAKEFILES=inc/lib.mk make -C sub x", "MAKEFILES, MAKEFLAGS или GNUMAKEFLAGS")):
    why = run("Bash", {"command": form}, cwd=o) or ""
    check(f"SE-135: причина {form!r}: {why[:90]!r}", why if part in why else None, True)
# SE-135 линза backend (B1, issuecomment-6891500801): поток за файлом на диске — include в Makefile и Makefile по
# умолчанию как ссылка на /dev/stdin или FIFO. make 3.81 читает stdin в обоих случаях (проба линзы).
for name, text in (("d1/Makefile", "include /dev/stdin\nall: ; @true\n"), ("d2/Makefile", "-include /dev/fd/0\n"),
                   ("d3/Makefile", "sinclude /dev/stdin\n"), ("d4/Makefile", "include two.mk\nall: ; @true\n"),
                   ("d4/two.mk", "include /dev/stdin\n"), ("d7/Makefile", "all: ; @true\n"),
                   ("d8/Makefile", "include in.mk\nall: ; @true\n"), ("n1/Makefile", "all: ; @true\n"),
                   ("n2/Makefile", "include /dev/null\nall: ; @true\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
for name in ("d5/Makefile", "d7/GNUmakefile", "d8/in.mk"):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).symlink_to("/dev/stdin")
(o / "d6").mkdir(exist_ok=True)
os.mkfifo(o / "d6" / "Makefile")
for form in ("make -C d1 all", "make -C d2 all", "make -C d3 all", "make -C d4 all", "make -C d5 all", "make -C d6 all",
             "make -C d7 all", "make -C d8 all", "make -f d1/Makefile all", "cd d5 && make all",
             "make -C n2 all"):  # n2: `include /dev/null` — отказ по правилу coord 12:06 (#402)
    bash(f"SE-135 B1, отказ: {form!r}", form, True, cwd=o)
for form in ("make -C n1 all", "make -C sub x"):
    bash(f"SE-135 B1, без признака: {form!r}", form, False, cwd=o)
for form in ("make -C d1 all", "make -C d5 all", "make -C d6 all"):
    why = run("Bash", {"command": form}, cwd=o) or ""
    check(f"SE-135 B1: причина {form!r}: {why[:90]!r}", why if "Makefile из потока" in why else None, True)
# SE-135 линза backend (#402, Нерв 11:35): `\` + перевод строки продолжает строку include. Сверено с make 3.81:
# нечётное число `\` — продолжение, чётное и `\#` — нет; комментарий с `\` в конце глотает следующую строку.
for name, text in (("c1/Makefile", "include \\\n/dev/stdin\nall: ; @true\n"),
                   ("c2/Makefile", "-include \\\n   \\\n/dev/stdin\nall: ; @true\n"),
                   ("c3/Makefile", "foo = a\\\\\ninclude /dev/stdin\nall: ; @true\n"),
                   ("c4/Makefile", "foo = a\\#\ninclude /dev/stdin\nall: ; @true\n"),
                   ("c5/Makefile", "sinclude \\\n  lib.mk\nall: ; @true\n"), ("c5/lib.mk", "x:\n\tgh pr merge 1\n"),
                   ("c6/Makefile", "# c \\\ninclude /dev/stdin\nall: ; @true\n"),
                   ("c7/Makefile", "foo = a\\\\\\\ninclude /dev/stdin\nall: ; @true\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
for form in ("make -C c1 all", "make -C c2 all", "make -C c3 all", "make -C c4 all", "make -C c5 x",
             "make -C c6 all", "make -C c7 all"):  # c6, c7 make не читает stdin, но слово include — отказ (coord 12:06)
    bash(f"SE-135 продолжение строки, отказ: {form!r}", form, True, cwd=o)
# Правило coord 11:46 (#402): экранирование make разбор не моделирует — строка include с `\` или `#` после склейки
# продолжений — отказ. Форма линзы backend (issuecomment-6891872344, make 3.81): `-include x\#y /dev/stdin` читает stdin.
for name, text in (("e1/Makefile", "-include x\\#y /dev/stdin\nall: ; @true\n"),
                   ("e2/Makefile", "include a.mk # note\nall: ; @true\n"), ("e2/a.mk", "y: ; @true\n"),
                   ("e3/Makefile", "include a\\ b.mk\nall: ; @true\n"),
                   ("e4/Makefile", "# include x\\#y /dev/stdin\nall: ; @true\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
for form in ("make -C e1 all", "make -C e2 all", "make -C e3 all", "make -C n1 --eval 'include x\\#y' all",
             "make -C e4 all"):  # e4 — строка-комментарий: слово include в любой строке — отказ (coord 12:06)
    bash(f"SE-135 include с \\ или #, отказ: {form!r}", form, True, cwd=o)
why = run("Bash", {"command": "make -C e1 all"}, cwd=o) or ""
check(f"SE-135 include с \\ или #: причина: {why[:90]!r}", why if "строка include" in why else None, True)
# Правило coord 11:47 (#402): подстановка shell в любом слове make — отказ всего вызова. Линза release
# (issuecomment-6891879848): B1 `--eval "$(cat evil.mk)"` — метка без `$`, EVAL_RUNS её не видит; B2 `-f <(…)` — пути
# нет на диске, _read_tree его молча отбрасывает.
for form in ('make --eval "$(cat evil.mk)" all', "make -f <(printf 'x: ; @true') x", 'make -f "$(echo Makefile)" all',
             "make -C $(git branch --show-current) all", "make -f =(printf x) x", "make -C n1 X=$(date) all",
             "make -C n1 -I `cat f` all", "make -C n1 all >(cat)"):
    bash(f"SE-135 подстановка в слове make, отказ: {form!r}", form, True, cwd=o)
for form in ("make -C n1 V=1 all", "make -C $(pwd)/n1 all"):  # `$(pwd)` разбор сводит к ${PWD} — не метка
    bash(f"SE-135 подстановка в слове make, без признака: {form!r}", form, False, cwd=o)
why = run("Bash", {"command": "make -f <(printf 'x: ; @true') x"}, cwd=o) or ""
check(f"SE-135 подстановка в слове make: причина: {why[:90]!r}",
      why if "подстановка shell в слове make" in why else None, True)
# Правило coord 11:55 (#402): знак вне \x20-\x7e, кроме таба, в слове make (аргумент, `-f`, `--eval`) и в строке
# include — отказ. Линза Claude #398: в локали kk_KZ.PT154 make 3.81 считает 0xA0 пробелом, `à` — C3 A0, поэтому
# `-include xà/dev/stdin` для него — два слова, и второе — поток.
for name, text in (("a1/Makefile", "-include xà/dev/stdin\nall: ; @true\n"),
                   ("a2/Makefile", "all: ; @echo à\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
# Байт 0xA0 сам по себе: разбор читает Makefile как UTF-8 с заменой (U+FFFD), и MAKE_INCLUDE строку не находит —
# нет `[ \t]` после слова или перед ним, а make в kk_KZ.PT154 видит `include /dev/stdin`.
for name, raw in (("a3/Makefile", b"include\xa0/dev/stdin\nall: ; @true\n"),
                  ("a4/Makefile", b"\xa0include /dev/stdin\nall: ; @true\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_bytes(raw)
for form in ("make -C n1 V=à all", "make -C n1 --eval 'V=à' all", "make -f n1/Mà all", "make -C dà all",
             "make -C a1 all", "make -C a3 all", "make -C a4 all"):
    bash(f"SE-135 не ASCII в слове make, отказ: {form!r}", form, True, cwd=o)
bash("SE-135 не ASCII вне include, без признака: рецепт с à", "make -C a2 all", False, cwd=o)
for form, part in (("make -C n1 V=à all", "вне печатного ASCII"), ("make -C a1 all", "Makefile со словом include")):
    why = run("Bash", {"command": form}, cwd=o) or ""
    check(f"SE-135 не ASCII: причина {form!r}: {why[:90]!r}", why if part in why else None, True)
# Правило coord 12:06/12:07 (#402): Makefile, который make прочтёт (`-f`, по умолчанию от `-C` или cwd, их include), со
# словом include/-include/sinclude в любой строке, с `$(eval`, `${eval`, `$(file`, `${file`, `$(shell`, `${shell` или
# с `/dev/` в начале слова-пути — отказ; Makefile, который разбор не прочёл, — тоже. Формы backend (Нерв 12:02, 12:03,
# make 3.81): `$(eval -include /dev/stdin)` читает stdin из группы, подоболочки, цикла и fd 3.
for name, text in (("evl/Makefile", "$(eval -include /dev/stdin)\nall: ; @true\n"),
                   ("fd3/Makefile", "$(eval -include /dev/fd/3)\nx: ; @true\n"),
                   ("t1/Makefile", "$(eval X := 1)\nall: ; @true\n"), ("t2/Makefile", "${eval X := 1}\nall: ; @true\n"),
                   ("t3/Makefile", "X := $(file <f)\nall: ; @true\n"),
                   ("t4/Makefile", "X := ${shell true}\nall: ; @true\n"),
                   ("t5/Makefile", "X := $(wildcard /dev/fd/*)\nall: ; @true\n"),
                   ("t6/Makefile", "all: ; @true\n# sinclude x.mk\n"), ("t7/two.mk", "include x.mk\n"),
                   ("t7/Makefile", "all: ; @true\n"), ("evil.mk", "x: ; @echo FROM_STREAM\n"),
                   ("p1/Makefile", "X := scripts/dev/a.sh infra/scripts/dev/*.sh $(SHELL) --include-dir includes\n"
                    "all: ; @echo $(X)\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
(o / "big").mkdir(exist_ok=True)
(o / "big" / "Makefile").write_text("all: ; @true\n" + "#" * (4 * 1024 * 1024))  # больше TEXT_MAX — разбор не читает
for form in ("make -C evl x", "{ make -C evl x; } < evil.mk", "cat evil.mk | (cd evl && make x)",
             "for i in 1; do make -C evl x; done < evil.mk", "make -C fd3 x 3<evil.mk", "make -C t1 all",
             "make -C t2 all", "make -C t3 all", "make -C t4 all", "make -C t5 all", "make -C t6 all",
             "make -f t7/two.mk -f t7/Makefile all", "make -f t1/Makefile all", "make -C n1 -f ../t4/Makefile all",
             "make -C big all"):
    bash(f"SE-135 текст Makefile, отказ: {form!r}", form, True, cwd=o)
for form in ("make -C p1 all", "make -C t7 all", "make -C n1 --eval 'include ../t7/Makefile' all"):
    bash(f"SE-135 текст Makefile, без признака: {form!r}", form, False, cwd=o)
for form in ("make -C evl x", "make -C big all"):
    why = run("Bash", {"command": form}, cwd=o) or ""
    check(f"SE-135 текст Makefile: причина {form!r}: {why[:90]!r}",
          why if "Makefile со словом include" in why else None, True)
# Приёмка coord 12:07: правило текста не задевает корневой Makefile репозитория (копия в папке теста). Сам вызов
# отказывает и на board-agents: грубый признак (FALLBACK) находит `.claude/rules` (строка 2) и `.claude/hooks` (строка
# 90) — это не причина этого правила.
(o / "root").mkdir(exist_ok=True)
(o / "root" / "Makefile").write_text((Path(__file__).resolve().parents[2] / "Makefile").read_text(encoding="utf-8"))
for form in ("make check", "make wt-add TRACK=fix NAME=x", "make wt-deps TRACK=fix NAME=x",
             "make wt-check TRACK=fix NAME=x"):
    why = run("Bash", {"command": form}, cwd=o / "root") or ""
    check(f"SE-135 корневой Makefile, не правило текста: {form!r}: {why[:90]!r}",
          why if "Makefile со словом include" in why else None, False)
# Решение coord 12:19 (#402): make пересобирает Makefile встроенными правилами. Сверено на make 3.81: Makefile старше
# Makefile.sh — make делает `cat Makefile.sh >Makefile` и читает новый текст; без Makefile — так же. Отказ: рядом с
# Makefile дерева `имя.*`, `имя,v`, `s.имя`, папка RCS/ или SCCS/; make не находит Makefile (`-f`, по умолчанию,
# include из `--eval`).
for name, text in (("r1/Makefile", "x: ; @true\n"), ("r1/Makefile.sh", "x: ; @echo FROM_SH\n"),
                   ("r2/Makefile.sh", "x: ; @echo FROM_SH\n"), ("r3/Makefile", "x: ; @true\n"), ("r3/RCS/.keep", ""),
                   ("r4/Makefile", "x: ; @true\n"), ("r4/SCCS/.keep", ""), ("r5/Makefile", "x: ; @true\n"),
                   ("r5/Makefile,v", ""), ("r6/Makefile", "x: ; @true\n"), ("r6/s.Makefile", ""),
                   ("r7/mk.mk", "x: ; @true\n"), ("r7/mk.mk.sh", "x: ; @echo FROM_SH\n"), ("r8/.keep", ""),
                   ("r9/Makefile", "x: ; @true\n"), ("r9/Makefile-old", "x: ; @true\n"), ("r9/README", "x\n")):
    (o / name).parent.mkdir(parents=True, exist_ok=True)
    (o / name).write_text(text)
for form in ("make -C r1 x", "make -C r2 x", "make -C r3 x", "make -C r4 x", "make -C r5 x", "make -C r6 x",
             "make -C r7 -f mk.mk x", "make -C r8 x", "make -C n1 -f missing.mk all",
             "make -C n1 --eval 'include missing.mk' all"):
    bash(f"SE-135 пересборка Makefile, отказ: {form!r}", form, True, cwd=o)
for form in ("make -C r9 x", "make -C n1 all", "make -n -f /dev/null x"):
    bash(f"SE-135 пересборка Makefile, без признака: {form!r}", form, False, cwd=o)
why = run("Bash", {"command": "make -C r1 x"}, cwd=o) or ""
check(f"SE-135 пересборка Makefile: причина: {why[:90]!r}", why if "пересоберёт" in why else None, True)
o = TMP / "se133"
# Линза Claude (#398, issuecomment-6891590096). B1: `$(…)` и `` `…` `` в значении разбор режет в метку без `$`.
# B2: make делит слова только по пробелу и табу (`isblank`), `\v`, `\f`, `\r`, `\n` — часть слова. B3: опции make 4.x
# со значением, которых нет в 3.81: getopt 3.81 следующее слово не забирает, и `-I` проходит.
for form in ("MAKEFLAGS=\"-s $(printf %s -Iinc)\" make -C sub x", "MAKEFLAGS=\"-s `printf %s -Iinc`\" make -C sub x",
             "MAKEFLAGS=\"-s $(git branch --show-current)\" make -C sub x",
             "export MAKEFLAGS=\"-s $(cat f)\"; make -C sub x", "GNUMAKEFLAGS=\"-s $(cat f)\" make -C sub x",
             "MAKEFLAGS=-s\vIinc make -C sub x", "MAKEFLAGS='-s\fIinc' make -C sub x",
             "MAKEFLAGS='-s\rIinc' make -C sub x", "MAKEFLAGS='-s\nIinc' make -C sub x",
             "MAKEFLAGS='-s -Iinc' make -C sub x",
             "MAKEFLAGS='--jobserver-auth -Iinc' make -C sub x", "MAKEFLAGS='--jobserver-style -Iinc' make -C sub x",
             "MAKEFLAGS='--sync-mutex -Iinc' make -C sub x", "MAKEFLAGS='--sync -Iinc' make -C sub x"):
    bash(f"SE-133 линза Claude, отказ: {form!r}", form, True, cwd=o)
for form in ("MAKEFLAGS='-s\t-k' make -C ok x", "MAKEFLAGS='  -s  -k ' make -C ok x",  # ok — без include (coord 12:06)
             "MAKEFLAGS='--jobserver-fds=3,4 -s' make -C ok x"):
    bash(f"SE-133 линза Claude, без признака: {form!r}", form, False, cwd=o)
why = run("Bash", {"command": "MAKEFLAGS=\"-s $(printf %s -Iinc)\" make -C sub x"}, cwd=o) or ""
check(f"SE-133 линза Claude: причина — MAKEFLAGS: {why[:90]!r}", why if "MAKEFLAGS или GNUMAKEFLAGS" in why else None,
      True)
# `-O` (make 4.x) в связке: разбор отдаёт ему остаток (`Iinc`), а make 3.81 `-O` не знает, пропускает букву и
# применяет `-I inc` (сверено: `MAKEFLAGS=-OIinc make y` читает inc/lib.mk). В командной строке make 3.81 на `-O` падает.
for form in ("MAKEFLAGS=-OIinc make -C sub x", "MAKEFLAGS=-sOIinc make -C sub x", "MAKEFLAGS=OIinc make -C sub x",
             "GNUMAKEFLAGS=-OIinc make -C sub x"):
    bash(f"SE-133 -O в связке, отказ: {form!r}", form, True, cwd=o)
# Линза Claude (#398, issuecomment-6891964594), остаток B2: make 3.81 зовёт setlocale, и в локали kk_KZ.PT154 байт
# 0xA0 — пробел; `à` (C3 A0) Python пробелом не считает. Правило (coord 11:55): знак вне \x20-\x7e и таба — отказ.
for form in ("MAKEFLAGS='-sà--include-dir=inc' make -C sub x", "MAKEFLAGS=-sà-Iinc make -C sub x",
             "GNUMAKEFLAGS='-sà--include-dir=inc' make -C sub x", "MAKEFLAGS='-s\x7f-Iinc' make -C sub x",
             "MAKEFLAGS='-s\x01-Iinc' make -C sub x"):
    bash(f"SE-133 не ASCII в MAKEFLAGS, отказ: {form!r}", form, True, cwd=o)
why = run("Bash", {"command": "MAKEFLAGS='-sà--include-dir=inc' make -C sub x"}, cwd=o) or ""
check(f"SE-133 не ASCII в MAKEFLAGS: причина: {why[:90]!r}", why if "MAKEFLAGS или GNUMAKEFLAGS" in why else None, True)


# --- Решение coord 12:35, 12:36, 12:38 (#402): make — только по тексту, который прошёл ревью. Каждый Makefile дерева
# совпадает с блобом того же пути на основной ветке origin (refs/remotes/origin/HEAD) репозитория хука; VPATH, GPATH,
# MAKEFILES нет ни в окружении, ни в строке make. Формы линзы backend (issuecomment-6892387638, сверено на make 3.81):
# make пересобирает Makefile через VPATH и через правило с целью Makefile, потом читает текст, которого разбор не видел.
def git(d, *args):
    subprocess.run(["git", "-C", str(d), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True,
                   capture_output=True)


def put(d, files, commit=None):
    for name, text in files:
        (d / name).parent.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(text)
    if commit:
        git(d, "add", "-A")
        git(d, "commit", "-q", "-m", commit)


def origin_here(d):  # основная ветка origin — текущий HEAD, как после fetch
    git(d, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(d, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")


mg_launch.same_blob = blob_rule
o, noo, other = repo_on("main", prefix="blob-"), repo_on("main", prefix="blob-noo-"), repo_on("main", prefix="blob-o-")
merge_guard_git.HOME_REPOS = [str(o), str(noo)]
ROOT_MK = (Path(__file__).resolve().parents[2] / "Makefile").read_text(encoding="utf-8")
put(o, (("Makefile", "x: ; @true\n"), ("ok/Makefile", "x: ; @true\n"), ("mod/Makefile", "x: ; @true\n"),
        ("root/Makefile", ROOT_MK)), commit="base")
origin_here(o)
put(o, (("br/Makefile", "x: ; @true\n"),), commit="только в ветке")  # линза backend 12:34: закоммичен, не на origin
git(o, "worktree", "add", "-q", str(TMP / "blob-wt"))
put(o, (("vp/a/Makefile", "VPATH = ../src\nall: ; @echo original\n"), ("vp/src/Makefile.sh", "all: ; @echo REMADE\n"),
        ("ex/Makefile", "Makefile: stamp\n\tcp new.mk Makefile\nstamp: ;\nall: ; @echo original\n"),
        ("ex/new.mk", "all: ; @echo REMADE\n"), ("extra.mk", "x: ; @true\n"), ("mod/Makefile", "x: ; @echo changed\n"),
        ("nest/Makefile", "x: ; @true\n")))
git(o / "nest", "init", "-q", "-b", "main")  # вложенный репозиторий со своей основной веткой
git(o / "nest", "add", "-A")
git(o / "nest", "commit", "-q", "-m", "nest")
origin_here(o / "nest")
put(noo, (("Makefile", "x: ; @true\n"),), commit="без origin")
put(other, (("Makefile", "x: ; @true\n"),), commit="другой репозиторий")
origin_here(other)
for form in ("make x", "make -C ok x", f"make -C {TMP / 'blob-wt'} x", "make -f ok/Makefile x", "make -n -f /dev/null x",
             "make -C ok V=1 x"):
    bash(f"блоб, без признака: {form!r}", form, False, cwd=o)
for form in ("make -C vp/a all", "make -C ex all", "make -C mod x", "make -C br x", "make -f extra.mk x",
             "make -f ok/Makefile -f extra.mk x", "make -C nest x", f"make -C {other} x", f"make -C {noo} x",
             "make VPATH=src x", "make GPATH=src x", "make -C ok VPATH:=../vp/src x", "VPATH=src make x",
             "export VPATH=src; make x", "env GPATH=src make x", "VPATH+=src make x", "make --eval 'VPATH=src' x",
             "make --eval 'vpath %.sh src' x", "MAKEFLAGS='VPATH=src' make x", "MAKEFLAGS='-- GPATH=src' make x"):
    bash(f"блоб, отказ: {form!r}", form, True, cwd=o)
for form, part in (("make -C ex all", "отличается от основной ветки origin"),
                   ("make -C vp/a all", "отличается от основной ветки origin"),
                   ("make VPATH=src x", "переменная make в командной строке"),
                   ("VPATH=src make x", "MAKEFLAGS или GNUMAKEFLAGS")):
    why = run("Bash", {"command": form}, cwd=o) or ""
    check(f"блоб: причина {form!r}: {why[:90]!r}", why if part in why else None, True)
for name in ("VPATH", "GPATH", "MAKEFILES"):  # окружение самого хука: его наследует shell команды
    os.environ[name] = "src"
    why = run("Bash", {"command": "make x"}, cwd=o) or ""
    os.environ.pop(name)
    check(f"блоб: {name} в окружении — отказ: {why[:90]!r}", why if "MAKEFLAGS или GNUMAKEFLAGS" in why else None, True)
# Линза backend B1 (#402, 6892659274), правило coord 12:59: блоб — того файла, что прочёл хук, по realpath. `link/..`
# ядро проходит по ссылке (папка вне репозитория), а abspath убрал бы его по тексту — к корневому Makefile.
OUT = TMP / "blob-out"
(OUT / "d").mkdir(parents=True)
(OUT / "Makefile").write_text("x: ; @true\n")
(o / "link").symlink_to(OUT / "d")
for form in ("make -C link/.. x", "make -f link/../Makefile x"):
    why = run("Bash", {"command": form}, cwd=o) or ""
    check(f"блоб: ссылка из репозитория наружу {form!r}: {why[:90]!r}",
          why if "отличается от основной ветки origin" in why else None, True)
bash("блоб, без признака: 'make -C ok/../ok x'", "make -C ok/../ok x", False, cwd=o)
RAW = b"x: ; @true\n# \xff\xfe\r\n"  # не UTF-8: хеш — от байтов, а не от текста после decode
GIT_ID = subprocess.run(["git", "hash-object", "--no-filters", "--stdin"], input=RAW, capture_output=True,
                        check=True).stdout.decode().strip()
check("блоб: blob_id = git hash-object --no-filters --stdin",
      None if merge_guard_git.blob_id(RAW) == GIT_ID else (merge_guard_git.blob_id(RAW), GIT_ID), False)
# Приёмка coord 12:36: корневой Makefile, который совпадает с основной веткой, правило блоба не задевает. Вызов и так
# отказывает по грубому признаку (FALLBACK, `.claude/rules` и `.claude/hooks` в тексте) — это не причина правила.
for form in ("make check", "make wt-add TRACK=fix NAME=x", "make wt-check TRACK=fix NAME=x"):
    why = run("Bash", {"command": form}, cwd=o / "root") or ""
    check(f"блоб: корневой Makefile, не правило блоба: {form!r}: {why[:90]!r}",
          why if "отличается от основной ветки" in why or "Makefile со словом include" in why else None, False)
mg_launch.same_blob = lambda p, data: True

# --- файл переписывает та же команда: хук прочёл бы не то, что выполнится (автоматическое ревью на ca50900d7) ---
o = TMP / "r11"
o.mkdir()
(o / "ok.sh").write_text("echo ok\n")
(o / "m.sh").write_text("gh pr merge 1\n")
(o / "package.json").write_text('{"scripts": {"x": "echo ok"}}')
(o / "Makefile").write_text("all:\n\techo ok\n")
(o / "d").mkdir()
(o / "d" / "m.sh").write_text("echo ok\n")
for form in ("printf 'gh pr merge 1\\n' > ok.sh; bash ok.sh", "cat > ok.sh <<'EOF'\ngh pr merge 1\nEOF\nbash ok.sh",
             "cp m.sh ok.sh && bash ok.sh", "cp m.sh d/ && bash d/m.sh", "echo 'gh pr merge 1' | tee ok.sh > /dev/null; bash ok.sh",
             "sed -i '' 's/echo ok/gh pr merge 1/' ok.sh && ./ok.sh", 'D=.; cp m.sh "$D/ok.sh"; bash ok.sh',
             "printf '{\"scripts\":{\"x\":\"gh pr merge 1\"}}' > package.json; npm run x",
             "npm pkg set scripts.x='gh pr merge 1' && npm run x", "printf 'all:\\n\\tgh pr merge 1\\n' > Makefile; make"):
    bash(f"r11, переписан той же командой: {form[:60]!r}", form, True, cwd=o)
for form in ("chmod +x ok.sh && ./ok.sh", "echo 1 > notes.txt; bash ok.sh", "echo 1 > notes.txt; npm run x", "make",
             "cp ok.sh b.sh && bash ok.sh", "npm run x > out.log"):
    bash(f"r11, пишет другое: {form!r}", form, False, cwd=o)

# --- запись видна до разбора `$(…)` и heredoc; запись вслепую — до запуска кода (автоматическое ревью на 46914be6a) ---
o = TMP / "r12"
o.mkdir()
(o / "ok.sh").write_text("echo ok\n")
(o / "m.sh").write_text("gh pr merge 1\n")
(o / "package.json").write_text('{"scripts": {"x": "echo ok", "y": "git pull && bash ok.sh"}}')
(o / "Makefile").write_text("all:\n\techo ok\n")
(o / "read.json").write_text('{"query": "{viewer{login}}"}')
for form in ("printf 'gh pr merge 1\\n' > ok.sh; echo $(bash ok.sh)", "cp m.sh ok.sh; echo $(bash ok.sh)",
             "printf 'gh pr merge 1\\n' > ok.sh; bash <<'EOF'\nbash ok.sh\nEOF",
             "bash <<'EOF'\ncp m.sh ok.sh\nEOF\necho $(bash ok.sh)", "bash -c 'cp m.sh ok.sh'; echo \"$(bash ok.sh)\"",
             "eval 'cp m.sh ok.sh'; echo $(./ok.sh)", "bash <<'EOF'\ncp m.sh Makefile\nEOF\nmake"):
    bash(f"r12, запись раньше подстановки: {form[:60]!r}", form, True, cwd=o)
for form in ("git switch feat && bash ok.sh", "git stash pop && bash ok.sh", "git -C . checkout feat && ./ok.sh",
             "git pull && npm run x", "tar xzf a.tgz && bash ok.sh", "tar -xf a.tar; make", "cp -r d/ . && bash ok.sh",
             "git apply p.patch && make", "git stash pop; gh api graphql --input read.json", "unzip -o a.zip && bash ok.sh",
             "git checkout feat -- ok.sh && bash ok.sh", "git restore --source=feat ok.sh; ./ok.sh",
             "git reset --hard origin/feat && npm run x", "git checkout -b n origin/feat && bash ok.sh",
             "curl -sSLo ok.sh https://x/y && bash ok.sh", "curl -sO https://x/ok.sh && bash ok.sh",
             "wget https://x/ok.sh && bash ok.sh", "gunzip ok.sh.gz && bash ok.sh"):
    bash(f"r12, вслепую: {form!r}", form, True, cwd=o)
for form in ("git status && bash ok.sh", "git log -1 && npm run x", "git checkout -- notes.md && npm run x",
             "git checkout -b fresh && bash ok.sh", "git stash list && bash ok.sh", "git reset HEAD notes.md && bash ok.sh",
             "curl -s https://x | jq .", "curl -o /dev/null -s https://x; bash ok.sh", "curl -so out.json https://x && bash ok.sh",
             "git archive HEAD d | tar -x -C ../elsewhere", "npm run y", "git switch feat"):
    bash(f"r12, видно: {form!r}", form, False, cwd=o)

# --- папка, маска и `.` в pathspec; gh и git, пишущие дерево (автоматическое ревью на b5c9e9e56) ---
o = TMP / "r13"
(o / "scripts").mkdir(parents=True)
(o / "ok.sh").write_text("echo ok\n")
(o / "scripts" / "ok.sh").write_text("echo ok\n")
(o / "scripts" / "Makefile").write_text("all:\n\techo ok\n")
(o / "package.json").write_text('{"scripts": {"x": "echo ok"}}')
(o / "Makefile").write_text("all:\n\techo ok\n")
for form in ("git restore --source=feat . && bash ok.sh", "git checkout feat -- . && bash ok.sh",
             "git checkout feat -- scripts && bash scripts/ok.sh", "git restore -s feat 'scripts/*.sh' && bash scripts/ok.sh",
             "git restore --source feat :/ && bash ok.sh", "git checkout feat -- scripts/ && ./scripts/ok.sh",
             "git restore --pathspec-from-file=l.txt --source=feat && bash ok.sh", "gh pr checkout 5 && bash ok.sh",
             "gh co 5 && bash ok.sh", "gh repo clone o/r d && bash d/ok.sh", "gh run download 1 && bash ok.sh",
             "gh release download v1 && make", "git co feat && bash ok.sh", "git lfs pull && npm run x",
             "git clone https://x/r d && bash d/ok.sh", "git worktree add ../w feat && bash ../w/ok.sh",
             "git checkout feat -- scripts && make -C scripts"):
    bash(f"r13, вслепую: {form!r}", form, True, cwd=o)
for form in ("gh pr view 5 && bash ok.sh", "gh run view 1 && bash ok.sh", "git restore notes.md && bash ok.sh",
             "git checkout -- notes.md pages/a.md && bash scripts/ok.sh", "git worktree list && bash ok.sh",
             "gh release list && make", "git restore --source=feat docs && bash scripts/ok.sh", "git -C . status && bash ok.sh"):
    bash(f"r13, видно: {form!r}", form, False, cwd=o)

# --- имя команды не видно: git — лишь догадка (security-review на cd5f43161 и 3961d9085) ---
for form, want in (("$G $S origin HEAD:main", True), ("\"$G\" \"$S\" x:main", True), ("\"$PY\" \"$1\"", False),
                   ("\"$PY\" \"$1\" \"$2\" \"$3\"", True), ("$RUN $CMD --branch feat main.py", False),
                   ("$G $S origin \"$B\"", True), ("source e.sh; $G $S origin \"$B\"", True), ("\"$X\" \"$1\" \"$2\"", False),
                   ("\"${DC[@]}\" up -d \"$svc\"", False),
                   ("$RUN $CMD --glob='*.py' x", False), ("$(echo git) $(echo push) origin $(echo HEAD:main)", True),
                   ("$G $S origin \"$(cat b.txt)\"", True), ("$G $S --all", True), ("\"$G\" \"$S\" --mirror origin", True),
                   ("$G $S --branches", True), ("\"$X\" \"$1\" \"$(cat a.txt)\"", False), ("\"$PY\" \"$(dirname \"$0\")/x.py\"", False),
                   ("$RUN $CMD --all-tests x", False)):
    for where in (on_main, on_branch):  # отказ — явная цель main, цель из `$…`/`$(…)`, --all/--mirror/--branches
        bash(f"r18, догадка: {form!r}", form, want, cwd=where)

# --- QA роли 1 на 3961d9085: два мутанта выживали, потому что отказ давал другой слой; здесь — без подстраховки ---
for label, got in (("табуляция в значении псевдонима", gh_aliases("aliases:\n    v: pr\tmerge\n")),
                   ("shell-псевдоним `!…`", alias_tokens("!gh pr merge", ["1"]))):
    check(f"r19, юнит: {label} — None", got, False)

# --- линза роли 5 на 5176136e3: скобки shell раскрывает до git и gh — решает и раскрытая форма ---
for form, want in (("gh pr {merge,} 1", True), ("git push origin HEAD:{main,x}", True), ("git push origin HEAD:ma{in,}", True),
                   ("git push origin {HEAD:main,x}", True), ("git push origin HEAD:ma{i..i}n", True),
                   ("$G $S origin HEAD:{main,x}", True), ("git push origin feat/{a,b}", False),
                   ("git push origin HEAD:{x,y}", False), ("git push origin \"HEAD:{main,x}\"", True),  # кавычки уже сняты
                   ("git push origin HEAD:x{1..99}", True), ("gh pr view {1..99}", True), ("git log --format={%H,%s} -1", False),
                   ("gh pr view 1 --json title,body --jq '{title,body}'", False),
                   ("gh api graphql -f query='query { viewer { login, name } }'", False)):
    bash(f"r20, скобки: {form!r}", form, want, cwd=on_branch)  # на ветке: отказ даёт только цель main из скобок
for word, want in (("x{1..5..2}", ["x1", "x3", "x5"]), ("{c..a}", ["c", "b", "a"]), ("{1..ab}", ["{1..ab}"]),
                   ("${a,b}", ["${a,b}"]), ("a b{c,d}", ["a b{c,d}"]), ("{,HEAD:main}", ["HEAD:main"])):
    check(f"r20, юнит: brace_argv({word!r})", None if brace_argv([word]) == want else brace_argv([word]), False)

# --- линза роли 2 на 5176136e3 (probe7, probe8, probe3) и узкая догадка на main: круг 12 ---
for form in ("{gh,pr,merge,1}", "g{h,} pr merge 1", "{git,push,origin,HEAD:main}", "gh pr {{merge,},} 1"):
    bash(f"r21, скобки в имени и argv: {form!r}", form, True, cwd=on_branch)  # A: раскрытие — до имени команды
for form in ("=gh pr merge 1", "=git push origin HEAD:main", "repeat 1 gh pr merge 1", "repeat 1 git push origin HEAD:main",
             "nocorrect gh pr merge 1", "- gh pr merge 1", "ls *(e:'gh pr merge 1':)", "ls *(e+'git push origin HEAD:main'+)",
             "ls *(e{'git push origin HEAD:main'})", "ls *(e'.gh pr merge 1.')", "ls *(.e\".git push origin HEAD:main.\")",
             "emulate sh -c \"gh pr merge 1\"", "`gh pr merge 1`"):
    bash(f"r21, формы zsh: {form!r}", form, True, cwd=on_branch)  # B; `e:…HEAD:main…:` zsh 5.9 режет по `:` и не исполняет
for form in ("ln -sfn /tmp/e ~/.config/gh && gh co 1", "rm -rf ~/.config/gh && mv /tmp/e ~/.config/gh && gh co 1",
             "cp -R /tmp/e ~/.config/gh && gh co 1", "rsync -a /tmp/e/ ~/.config/gh/ && gh co 1",
             "tar -xf e.tar -C ~/.config && gh co 1", "unzip e.zip -d ~/.config && gh co 1",
             "cd ~/.config && cp -R /tmp/e gh && gh co 1", "mv ~/.config/gh /tmp/o; mv /tmp/e ~/.config/gh; gh co 1",
             "tar -xf e.tar -C ~ && gh co 1", "unzip e.zip -d $HOME && gh co 1"):
    bash(f"r21, каталог конфига gh: {form!r}", form, True)  # C: псевдонимы gh прочитаны до подмены каталога
for form in ("cp -R ~/.config/gh /tmp/bak && gh co 1", "tar -xf e.tar -C /tmp/x && gh co 1", "ls ~/.config/gh && gh co 1",
             "unzip e.zip -d /tmp/x && gh co 1"):
    bash(f"r21, каталог конфига gh — не запись: {form!r}", form, False)  # источник копии и чтение — проход
r_main, r_branch = repo_on("main", "r21m"), repo_on("fix/a", "r21b")
for d in (r_main, r_branch):
    subprocess.run(["git", "-C", str(d), "remote", "add", "origin", "https://x"], check=True)
for form, want in (("$G $S origin", True), ("$G $S -u origin", True), ("$G $S --force", True), ("$G $S --tags", True),
                   ("$G $S origin --force-with-lease", True), ("$G $S --force-with-lease=origin/x", True),
                   ("$G $S origin HEAD", True), ("$G $S origin feat", False), ("\"$G\" \"$S\"", False), ("\"$G\" \"$S\" \"$R\"", False),
                   ("\"$PY\" \"$1\"", False), ("\"$PY\" -u x.py", False)):
    bash(f"r21, догадка на main без цели: {form!r}", form, want, cwd=r_main)  # D: голый push с main пишет в main
for form in ("$G $S origin", "$G $S -u origin", "\"$PY\" -u x.py"):
    bash(f"r21, догадка на ветке без цели: {form!r}", form, False, cwd=r_branch)
for word, want in (("`gh", "gh"), ("=gh", "gh"), ("/usr/bin/gh", "gh"), ("gh", "gh"), ("=", "=")):
    check(f"r21, юнит: command_name({word!r})", None if command_name(word) == want else command_name(word), False)
for cmd, want in (("ls *(e:'x':)", ["x"]), ("node -e \"require('a.json')\"", []),
                  ("python3 -c 'open(os.path.join(a))'", []), ("python3 -c 'open(os.path.join(base, x), \"r\")'", []),
                  ("node -e \"require('./e.json').a\"", []), ("awk '{print f(e\"X\")}'", []),
                  ("ls *(.e{'gh pr merge 1'})", ["gh pr merge 1"]), ("ls *(e+'x:y'+)", ["x:y"]), ("ls *(e'.x.')", ["x"]),
                  ("ls *(e:'x':) # it's", ["x"])):  # кавычка без пары — слов нет, решает сырая строка
    check(f"r21, юнит: qualifier_code({cmd!r})", None if qualifier_code(cmd) == want else qualifier_code(cmd), False)
# r22 (QA роли 1 на 8e6609611): имя команды задано невидимо в той же команде — голый push на main тоже отказ
HID = ("source e.sh; \"$G\" \"$S\"", ". ./e.sh && $G $S", "eval \"$(cat e.sh)\"; $G $S", "$(cat g.txt) $(cat s.txt)",
       "read G S < gs.txt; $G $S", "export $(cat e.env | xargs); $G $S", "G=$(cat g.txt); S=$(cat s.txt); $G $S",
       "source e.sh; \"$PY\" \"$1\"", "read G S < gs.txt; $SUDO $G $S")
for form in HID:
    bash(f"r22, невидимое имя на main: {form!r}", form, True, cwd=r_main)
    bash(f"r22, невидимое имя на ветке: {form!r}", form, False, cwd=r_branch)
(r_main / "run.sh").write_text("source e.sh\n\"$G\" \"$S\"\n")  # скрипт с диска: `source common.sh; "$X" "$1"` обычен
for form in ("\"$G\" \"$S\"; echo ok", "( source e.sh ); \"$G\" \"$S\"", "source e.sh; \"$G\" \"$S\" origin feat",
             "source e.sh; \"$PY\" x.py", "source e.sh; $G status", "while read -r l; do echo \"$l\"; done < f; \"$X\" \"$1\"",
             "bash run.sh"):  # `"$G" "$S"` — из окружения (остаток); подоболочка; `read l` не задаёт X; скрипт с диска
    bash(f"r22, видимое или чужое имя на main: {form!r}", form, False, cwd=r_main)
# r23 (QA роли 1 на d9d2f9647): eval и `sh -c` выполняют вывод `$(cat f)`/`$(< f)` — текст f, как `source f`
e_main, e_branch = repo_on("main", "r23m"), repo_on("fix/a", "r23b")
for d in (e_main, e_branch):
    subprocess.run(["git", "-C", str(d), "remote", "add", "origin", "https://x"], check=True)
    for name, text in (("e.sh", "git push\n"), ("v.sh", "G=git S=push\n"), ("ok.sh", "echo hi\n"), ("c.txt", "gh pr merge 1\n")):
        (d / name).write_text(text)
for form in ("eval \"$(cat e.sh)\"", "x=$(cat e.sh); eval \"$x\"", "bash -c \"$(cat e.sh)\"", "bash -c \"$(cat v.sh); \\$G \\$S\"",
             "eval \"$(< e.sh)\"", "sh -c \"`cat e.sh`\"", "emulate sh -c \"$(cat e.sh)\"", "x=\"$(cat e.sh)\"; bash -c \"$x\"",
             "eval \"$(cat ok.sh e.sh)\"", "$(cat e.sh)", "x=$(cat e.sh); $x"):  # и на месте имени команды
    bash(f"r23, текст файла в eval/-c на main: {form!r}", form, True, cwd=e_main)
    bash(f"r23, текст файла в eval/-c на ветке: {form!r}", form, False, cwd=e_branch)
for form in ("printf 'git push' > n.sh; eval \"$(cat n.sh)\"", "printf 'git push' > ok.sh; eval \"$(cat ok.sh)\"",
             "bash -c \"$(printf git) push origin HEAD:main\"", "$(cat c.txt)", "`cat c.txt`", "sudo $(< c.txt)",
             "printf 'gh pr merge 1' > c2.txt; $(cat c2.txt)"):  # файл переписан той же командой; вывод не виден, цель — main
    bash(f"r23, eval/-c — отказ и на ветке: {form!r}", form, True, cwd=e_branch)
for form in ("bash -c \"npm test\"", "eval \"$(ssh-agent -s)\"", "eval \"$(cat ok.sh)\"", "bash -c \"$(cat ok.sh)\"",
             "echo \"$(cat e.sh)\"", "eval \"$(cat nope.sh)\"", "$(cat ok.sh)", "echo $(cat c.txt)", "$(which python3) x.py"):  # вывод не из файла — не виден, как прежде (остаток)
    bash(f"r23, eval/-c на main — проход: {form!r}", form, False, cwd=e_main)
for body, want in (("< e.sh", ["e.sh"]), ("cat a b", ["a", "b"]), ("ssh-agent -s", [None])):
    check(f"r23, юнит: proc_files({body!r})", None if proc_files(body, ".") == want else proc_files(body, "."), False)
# r24 (безопасность роли 2 на 1d19a0268): `eval --` и `emulate -c --` — bash и zsh пропускают `--`, код после него виден
for form in ("eval -- gh pr merge 1", "eval -- 'gh pr merge 1'", "eval -- git push origin HEAD:main",
             "emulate sh -c -- \"gh pr merge 1\"", "builtin eval -- 'gh pr merge 1'"):
    bash(f"r24, `--` после eval/-c на main: {form!r}", form, True, cwd=e_main)
    bash(f"r24, `--` после eval/-c на ветке: {form!r}", form, True, cwd=e_branch)
for form in ("builtin eval -- git push", "eval -- \"$(cat e.sh)\"", "emulate sh -c -- \"$(cat e.sh)\""):
    bash(f"r24, `--` и текст файла на main: {form!r}", form, True, cwd=e_main)
for form in ("eval -- echo hi", "eval -- \"$(cat ok.sh)\"", "emulate sh -c -- \"echo hi\"", "emulate sh -c --", "eval --",
             "eval -- -- git push", "builtin eval -- git push"):  # второй `--` shell запустит как команду `--`
    bash(f"r24, `--` на ветке или безвредно на main: {form!r}", form, False,
         cwd=e_branch if form.startswith("builtin") else e_main)

# --- SE-105: make с признаком в Makefile — отказ, как в board-agents; в отказе — прямые команды цели ---
CHECKOUT = Path(__file__).resolve().parents[2]  # чистый checkout ветки: Makefile и скрипты, которые зовут его цели
mk = TMP / "se105"
mk.mkdir(parents=True, exist_ok=True)
(mk / "Makefile").write_bytes((CHECKOUT / "Makefile").read_bytes())
WT_FIX = 'git worktree add "worktrees/fix/x" -b "fix/x" board-agents'
DEPS_FIX = 'infra/scripts/dev/wt-deps.sh install "worktrees/fix/x"'
EVAL_NERVE = "python3 -I -m unittest discover -s eval/nerve -p 'test_*.py'"
for form, want, absent in (
        ("make wt-fix NAME=x", ["mkdir -p worktrees/fix", WT_FIX, DEPS_FIX], []),
        ("make wt-fix NAME=x WT_DEPS=0", [WT_FIX], [DEPS_FIX]),
        ("make wt-add TRACK=spike NAME=y", ['git worktree add "worktrees/spike/y" -b "spike/y" board-agents'], []),
        ("make wt-feature NAME=x", ['"worktrees/feature/x"'], []), ("make wt-refactor NAME=x", ['"refactor/x"'], []),
        ("make wt-spike NAME=x", ['"spike/x"'], []), ("make wt-review NAME=x", ['"review/x"'], []),
        ("make wt-fix NAME='x;y'", ['"worktrees/fix/<NAME>"'], ["x;y"]),
        ("make wt-fix NAME=x WT_BASE=main", ['-b "fix/x" main'], []),
        ("make wt-list", ["git worktree list"], []), ("make wt-help", ["cat worktrees/README.md"], []),
        ("make wt-deps TRACK=fix NAME=x", [DEPS_FIX], []), ("make wt-rm TRACK=fix NAME=x", ['git worktree remove "worktrees/fix/x"'], []),
        ("make wt-check TRACK=fix NAME=x", ['infra/scripts/dev/wt-deps.sh check "worktrees/fix/x/boards"'], []),
        ("make check-repo", ["python3 -I infra/checks/test_checks.py", "python3 -I infra/checks/run.py"], []),
        ("make check-eval", [EVAL_NERVE, "-s eval/pipeline/reflex ", "-s eval/evolve "], []),
        ("make -s wt-list check-repo", ["git worktree list", "infra/checks/run.py"], []),
        ("make check-layer", [], ["прямые команды"]), ("make", [], ["прямые команды"])):
    got = run("Bash", {"command": form}, cwd=mk) or ""
    check(f"SE-105, make под отказом, как в board-agents: {form!r}", got or None, True)
    lost = [w for w in want if w not in got] + [w for w in absent if w in got]
    check(f"SE-105, прямые команды в отказе: {form!r}", None if not lost else f"{lost!r} в {got!r}", False)
bash("SE-105, make у Контроля — как в board-agents", "make wt-fix NAME=x", False, who=D9, cwd=mk)
(mk / "Makefile").write_text("wt-fix:\n\tgh pr merge 1\n")
(mk / "m.awk").write_text('BEGIN { system("gh pr merge 1") }\n')
for form in ("make wt-list", "awk -f m.awk"):
    got = run("Bash", {"command": form}, cwd=mk) or ""
    check(f"SE-105, отказ без подсказки (цели нет в Makefile, не make): {form!r}",
          None if got and "прямые команды" not in got else got or "проход", False)


def in_checkout(cmd):  # корень для защиты — сам checkout, как у живого хука в основном checkout
    data = {"tool_name": "Bash", "tool_input": {"command": cmd}, "session_id": C4["sessionId"], "cwd": str(CHECKOUT)}
    return mg.decide(data, lambda: SESSIONS, lambda: CONTROL, roots=[str(CHECKOUT)])


hint = in_checkout("make wt-fix NAME=x check-repo check-eval") or ""
direct = [ln.strip().split("  #")[0] for ln in hint.splitlines() if ln.startswith("  ")]
check("SE-105, отказ на make в checkout даёт прямые команды (в Makefile нет признака — make проходит, поправить "
      "проверку)", None if WT_FIX in direct and EVAL_NERVE in direct else hint or "проход", False)
for form in direct:
    check(f"SE-105, прямая форма проходит в чистом checkout: {form!r}", in_checkout(form), False)

# --- SE-145 (координатор 22:05): глобальные опции git до push (`-c`, `-C`, `--git-dir`, `--config-env`) и `GIT`
# не прячут push от правила base: push и цель (защищённая ветка, --all/--mirror) в тексте скрипта — отказ. Формы B/K
# из #427 (SE-138) на base — отказ; тест закрепляет это. Прохода по «чистому» тексту (clean() из #427) здесь нет.
fp = TMP / "se145"
fp.mkdir()
B1_PUSH = (
    ("push_default.py", 'import subprocess\n\n\ndef push(branch="main"):\n'
                        '    subprocess.run(["git", "push", "origin", branch])\n\n\npush()\n'),
    ("push_tuple.py", 'import subprocess\nremote, branch = "origin", "main"\n'
                      'subprocess.run(["git", "push", remote, branch])\n'),
    ("push_hop.py", 'import subprocess\ncfg = {"branch": "main"}\ntarget = cfg["branch"]\n'
                    'subprocess.run(["git", "push", "origin", target])\n'),
    ("push_append.py", 'import subprocess\nrest = ["origin"]\nrest.append("main")\n'
                       'subprocess.run(["git", "push"] + rest)\n'),
    ("push_return.py", 'import subprocess\n\n\ndef target():\n    return "main"\n\n\n'
                       'subprocess.run(["git", "push", "origin", target()])\n'),
    ("push_star.py", 'import subprocess\nflags = []\nflags.append("--all")\n'
                     'subprocess.run(["git", "push", "origin", *flags])\n'),
    ("push_fstr.py", 'import subprocess\n\n\ndef br():\n    return "main"\n\n\n'
                     'subprocess.run(f"git push origin {br()}", shell=True)\n'),
    ("push_cmd_hop.py", 'import subprocess\ncfg = {"x": "main"}\nb = cfg["x"]\ncmd = ["git", "push", "origin"]\n'
                        'subprocess.run(cmd + [b])\n'),
    ("push_template.py", 'import subprocess\nfrom string import Template\n\n\ndef go(b="main"):\n'
                         '    subprocess.run(Template("git push origin $b").substitute(b=b), shell=True)\n\n\ngo()\n'),
)
B1_ENV = (
    ("push_env_set.py", 'import os\nimport subprocess\nos.environ["B"] = "main"\n'
                        'subprocess.run("git push origin $B", shell=True)\n'),
    ("push_env_update.py", 'import os\nimport subprocess\nos.environ.update(B="main")\n'
                           'subprocess.run(["bash", "-c", "git push origin $B"])\n'),
    ("push_env_dict.py", 'import os\nimport subprocess\nenv = {\n    **os.environ,\n    "B": "main",\n}\n'
                         'subprocess.run("git push origin $B", shell=True, env=env)\n'),
    ("push_env_refspec.py", 'import os\nimport subprocess\nos.environ["B"] = "main"\n'
                            'subprocess.run("git push origin HEAD:${B}", shell=True)\n'),
    ("push_env.js", 'const { execSync } = require("child_process");\nprocess.env.B = "main";\n'
                    'execSync("git push origin $B");\n'),
    ("push_putenv.py", 'import os\nos.putenv("B", "main")\nos.system("git push origin $B")\n'),
    ("push_env_concat.py", 'import os\nimport subprocess\nos.environ["B"] = "main"\n'
                           'subprocess.run("git push origin " + "$B", shell=True)\n'),
)
# B2: ветку задаёт другой оператор — checkout, switch, upstream; push без назначения или в HEAD
B2_IMPLICIT = (
    ("push_checkout.py", 'import subprocess\nsubprocess.run(["git", "checkout", "main"])\n'
                         'subprocess.run(["git", "commit", "-am", "x"])\nsubprocess.run(["git", "push"])\n'),
    ("push_upstream.py", 'import subprocess\n'
                         'subprocess.run(["git", "config", "branch.fix/a.merge", "refs/heads/main"])\n'
                         'subprocess.run(["git", "push"])\n'),
    ("push_switch_head.py", 'import subprocess\nsubprocess.run(["git", "switch", "main"])\n'
                            'subprocess.run(["git", "push", "origin", "HEAD"])\n'),
    ("push_checkout.js", 'const { execFileSync } = require("child_process");\n'
                         'execFileSync("git", ["checkout", "main"]);\nexecFileSync("git", ["push"]);\n'),
)
# B3: назначение задаёт настройка git — `remote.<имя>.push`, `symbolic-ref` — или matching-refspec `:`
B3_MAP = (
    ("push_map_config.py", 'import subprocess\nsubprocess.run(["git", "config", "remote.origin.push", '
                           '"refs/heads/feat:refs/heads/main"])\n'
                           'subprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_map_case.py", 'import subprocess\nsubprocess.run("git config --add Remote.Origin.Push '
                         'refs/heads/feat:refs/heads/main", shell=True)\n'
                         'subprocess.run("git push origin feat", shell=True)\n'),
    ("push_matching.py", 'import subprocess\nsubprocess.run(["git", "checkout", "main"])\n'
                         'subprocess.run(["git", "push", "origin", ":"])\n'),
    ("push_matching_plus.py", 'import subprocess\nsubprocess.run(["git", "checkout", "main"])\n'
                              'subprocess.run("git push origin +:", shell=True)\n'),
    ("push_symref.py", 'import subprocess\n'
                       'subprocess.run(["git", "symbolic-ref", "refs/heads/feat", "refs/heads/main"])\n'
                       'subprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_symref.js", 'const { execFileSync } = require("child_process");\n'
                       'execFileSync("git", ["symbolic-ref", "refs/heads/feat", "refs/heads/main"]);\n'
                       'execFileSync("git", ["push", "origin", "feat"]);\n'),
)
# B4: то же состояние git без слов команды — ключ из частей, `.git/config`, ссылка файлом, include, GIT_CONFIG_*,
# push строкой shell на несколько строк
B4_STATE = (
    ("push_key_parts.py", 'import subprocess\nk = "remote.origin." + "push"\n'
                          'subprocess.run(["git", "config", k, "refs/heads/feat:refs/heads/main"])\n'
                          'subprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_key_concat.py", 'import subprocess\nr = "origin"\nsubprocess.run(["git", "config", "remote." + r + '
                           '".push", "refs/heads/feat:refs/heads/main"])\n'
                           'subprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_ini.py", 'import subprocess\nwith open(".git/config", "a") as f:\n'
                    '    f.write(\'[remote "origin"]\\n\\tpush = refs/heads/feat:refs/heads/main\\n\')\n'
                    'subprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_symref_file.py", 'import subprocess\nfrom pathlib import Path\n'
                            'Path(".git/refs/heads/feat").write_text("ref: refs/heads/main\\n")\n'
                            'subprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_include.py", 'import subprocess\nfrom pathlib import Path\nPath("x.cfg").write_text('
                        '\'[remote "origin"]\\n\\tpush = refs/heads/feat:refs/heads/main\\n\')\n'
                        'subprocess.run(["git", "config", "include.path", "../x.cfg"])\n'
                        'subprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_env_config.py", 'import os\nimport subprocess\nos.environ["GIT_CONFIG_COUNT"] = "1"\n'
                           'os.environ["GIT_CONFIG_KEY_0"] = "remote.origin.push"\n'
                           'os.environ["GIT_CONFIG_VALUE_0"] = "refs/heads/feat:refs/heads/main"\n'
                           'subprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_heredoc_var.py", 'import subprocess\nscript = """\nB=main\ngit push origin $B\n"""\n'
                            'subprocess.run(script, shell=True)\n'),
    ("push_heredoc_bare.py", 'import subprocess\n# release to main\nscript = """\ngit push\n"""\n'
                             'subprocess.run(script, shell=True)\n'),
)
# K1–K8: маска и dst `HEAD`, `GIT`, имя git из частей, escape в назначении, программа из данных, обёртка запуска
K_CFG = ('"config", "remote.origin.push", "refs/heads/feat:refs/heads/main"])\n'
         'subprocess.run(["git", "push", "origin", "feat"])\n')
B4_K = (
    ("push_glob.py", 'import subprocess\nsubprocess.run(["git", "checkout", "main"])\n'
                     'subprocess.run(["git", "push", "origin", "refs/heads/*:refs/heads/*"])\n'),
    ("push_glob_tidy.py", 'import subprocess\nBASE = "main"\nprint(BASE)\n'
                          'subprocess.run(["git", "push", "origin", "refs/heads/*:refs/heads/*"])\n'),
    ("push_dst_head.py", 'import subprocess\nBASE = "main"\nprint(BASE)\n'
                         'subprocess.run(["git", "push", "origin", "feat:HEAD"])\n'),
    ("push_git_shell.py", 'import subprocess\nsubprocess.run("g\'\'it config remote.origin.push '
                          'refs/heads/feat:refs/heads/main", shell=True)\n'
                          'subprocess.run(["git", "push", "origin", "feat"])\n'),
) + tuple((name, f"import subprocess\n{pre}subprocess.run([{tool}, {K_CFG}") for name, pre, tool in (
    ("push_git_upper.py", "", '"GIT"'),
    ("push_git_parts.py", "", '"g" + "it"'),
    ("push_git_vars.py", 'a = "g"\nb = "it"\n', "a + b"),
    ("push_git_join.py", "", '"".join(["g", "it"])'),
    ("push_git_fstr.py", 'a = "g"\n', 'f"{a}it"'),
    ("push_git_escape.py", "", '"\\x67it"'),
    ("push_git_slice.py", 's = "tig"\n', "s[::-1]"),
    ("push_prog_glob.py", "import glob\n", 'glob.glob("/usr/bin/g?t")[0]'),
    ("push_prog_argv.py", "import sys\n", "sys.argv[1]"),
    ("push_prog_input.py", "", "input()"),
    ("push_prog_file.py", "", 'open("tool.txt").read().strip()'))) + (
    ("push_dst_escape.py", 'import subprocess\nsubprocess.run(["git", "log", "--oneline", "main"])\n'
                           'subprocess.run(["git", "push", "origin", "feat:refs/heads/ma\\x69n"])\n'),
    ("push_dst_octal.py", 'import subprocess\nsubprocess.run(["git", "log", "--oneline", "main"])\n'
                          'subprocess.run("git push origin feat:refs/heads/ma\\151n", shell=True)\n'),
    ("push_prog_alias.py", 'import subprocess\nimport sys\nr = subprocess.run\n'
                           f'r([sys.argv[1], {K_CFG}'),
    ("push_prog_as.py", 'import subprocess\nimport sys\nfrom subprocess import run as r\n'
                        f'r([sys.argv[1], {K_CFG}'),
    ("push_prog_shell_glob.py", 'import subprocess\nsubprocess.run("/usr/bin/g?t config remote.origin.push '
                                'refs/heads/feat:refs/heads/main", shell=True)\n'
                                'subprocess.run(["git", "push", "origin", "feat"])\n'),
) + tuple((name, f"import subprocess\n{pre}subprocess.run([{tool}, {K_CFG}") for name, pre, tool in (
    ("push_k6_env_argv.py", "import sys\n", '"env", sys.argv[1]'),
    ("push_k6_env_listdir.py", 'import os\ntool = sorted(os.listdir("/usr/bin"))[0]\n', '"env", tool'),
    ("push_k6_nice_input.py", "", '"nice", input()'),
    ("push_prog_q.py", "import sys\nQ = sys.argv[1]\n", "Q"),
    ("push_k8_node_eval.py", "", '"node", "--eval=0"'),
    ("push_k8_deno_eval.py", "", '"deno", "eval", "0"'),
    ("push_k8_timeit.py", "", '"python3", "-m", "timeit", "-n1", "0"'),
    ("push_k8_exe_timeit.py", "import sys\n", 'sys.executable, "-m", "timeit", "-n1", "0"'),
    ("push_k8_php.py", "", '"php", "-r", "0"'),
    ("push_k8_sh_file.py", "", '"sh", "cfg.sh"'),
    ("push_k8_exe_file.py", "import sys\n", 'sys.executable, "-I", "cfg.py"'))) + tuple(
    (name, f'import subprocess\nimport sys\nBASE = "main"\nprint(BASE)\n{run}\n'
           'subprocess.run(["git", "push", "origin", "feat"])\n') for name, run in (
        ("push_k6_sh_argv.py", 'subprocess.run(["sh", "-c", sys.argv[1]])'),
        ("push_k6_sh_var.py", 'cmd = sys.argv[1]\nsubprocess.run(["sh", "-c", cmd])'),
        ("push_k6_sh_stdin.py", 'subprocess.run(["sh", "-c", sys.stdin.read()])'),
        ("push_k6_bash_file.py", 'subprocess.run(["bash", "-c", open("cmd.txt").read()])'),
        ("push_k6_py_argv.py", 'subprocess.run(["python3", "-c", sys.argv[1]])'),
        ("push_k6_exe_argv.py", 'subprocess.run([sys.executable, "-c", sys.argv[1]])'),
        ("push_k6_node_file.py", 'subprocess.run(["node", "-e", open("x.js").read()])'),
        ("push_k6_sh_input.py", 'subprocess.run(["sh"], input=open("cmd.txt").read(), text=True)'),
        ("push_k6_xargs.py", 'subprocess.run(["xargs", "-a", "args.txt"])'))) + (
    ("push_k6_spawn.js", 'const { spawnSync, execFileSync } = require("child_process");\nconst BASE = "main";\n'
                         'spawnSync("sh", ["-c", process.argv[2]]);\n'
                         'execFileSync("git", ["push", "origin", "feat"]);\n'),
    ("push_k6_bash.js", 'const fs = require("fs");\nconst { execFileSync } = require("child_process");\n'
                        'const BASE = "main";\nexecFileSync("bash", ["-c", fs.readFileSync("cmd.txt", "utf8")]);\n'
                        'execFileSync("git", ["push", "origin", "feat"]);\n'),
    ("push_k7_vars.py", f'import subprocess\nimport sys\nvars(subprocess)["run"]([sys.argv[1], {K_CFG}'),
    ("push_k7_globals.py", 'import subprocess\nimport sys\nfrom subprocess import run\n'
                           f'globals()["run"]([sys.argv[1], {K_CFG}'),
    ("push_k7_static.py", 'import inspect\nimport subprocess\nimport sys\n'
                          f'inspect.getattr_static(subprocess, "run")([sys.argv[1], {K_CFG}'),
    ("push_k8_capture.py", 'import subprocess\nimport sys\nOpen3.capture2(sys.argv[1], "config", "remote.origin.push", '
                           '"refs/heads/feat:refs/heads/main")\nsubprocess.run(["git", "push", "origin", "feat"])\n'),
    ("push_k8_eval.js", 'const cp = require("child_process");\ncp.execFileSync("node", ["--eval=0", "config", '
                        '"remote.origin.push", "refs/heads/feat:refs/heads/main"]);\n'
                        'cp.execFileSync("git", ["push", "origin", "feat"]);\n'),
    ("push_k7_index.js", 'const cp = require("child_process");\ncp["execFileSync"](process.argv[2], '
                         '["config", "remote.origin.push", "refs/heads/feat:refs/heads/main"]);\n'
                         'cp.execFileSync("git", ["push", "origin", "feat"]);\n'),
)
# Формы Контроля C4–C10, E1–E4 и формы backend со значением опции (пробел, запятая, скобка, shell `'…'`)
SE145_MAP = '"remote.origin.push=refs/heads/feat:refs/heads/main"'
SE145_DENY = (
    ("se145_c4.py", 'import subprocess\nsubprocess.run("git -c remote.origin.push=refs/heads/feat:refs/heads/main '
                    'push origin feat", shell=True)\n'),
    ("se145_c6.py", 'import subprocess\nsubprocess.run(["git", "-c", "include.path=/tmp/x.cfg", "push", "origin", '
                    '"feat"])\nassert "main" not in ["feat"]\n'),
    ("se145_c7.py", f'import subprocess\nsubprocess.run(["git", "-c", {SE145_MAP}, "push", "origin", "feat"])\n'),
    ("se145_c9.js", "const { execFileSync } = require('child_process');\n"
                    f"execFileSync('git', ['-c', {SE145_MAP}, 'push', 'origin', 'feat']);\n"),
    ("se145_c10.py", 'import os\nimport subprocess\nos.environ["V"] = "refs/heads/feat:refs/heads/main"\n'
                     'subprocess.run(["git", "--config-env=remote.origin.push=V", "push", "origin", "feat"])\n'),
    ("se145_e1.py", 'import subprocess\nsubprocess.run(["git", "-c", "x.y=z", "push", "origin", "HEAD:main"])\n'),
    ("se145_e2.py", 'import subprocess\nsubprocess.run(["git", "-C", ".", "push", "origin", "HEAD:main"])\n'),
    ("se145_e3.py", 'import subprocess\nsubprocess.run("git --git-dir=.git push origin HEAD:main", shell=True)\n'),
    ("se145_e4.js", "const { execFileSync } = require('child_process');\n"
                    "execFileSync('git', ['-c', 'x.y=z', 'push', 'origin', 'HEAD:main']);\n"),
    ("se145_upper.py", 'import subprocess\nsubprocess.run(["GIT", "push", "origin", "main"])\n'),
) + tuple((name, f'import subprocess\nsubprocess.run([{opts}, "push", "origin", "HEAD:main"])\n') for name, opts in (
    ("se145_val_space.py", '"git", "-c", "user.name=Release Bot"'),
    ("se145_val_comma.py", '"git", "-c", "x.y=a,b"'),
    ("se145_val_dir.py", '"git", "-C", "/tmp/my repo"'),
    ("se145_val_bracket.py", '"git", "-c", "x.y=[a]"'))) + (
    ("se145_val_shell.py", 'import subprocess\n'
                           'subprocess.run("git -c \'user.name=Release Bot\' push origin HEAD:main", shell=True)\n'),
)
# Проход: цели в тексте нет — глобальная опция сама по себе не отказ
SE145_PASS = (
    ("se145_no_target.py", 'import subprocess\n'
                           'subprocess.run(["git", "-c", "x.y=z", "push", "origin", "feat:feat"])\n'),
)
DENY = ((B1_PUSH + B1_ENV, on_main), (B2_IMPLICIT + B3_MAP + B4_STATE + B4_K + SE145_DENY, on_branch))
for group, _ in DENY:
    for name, text in group:
        (fp / name).write_text(text)
for name, text in SE145_PASS:
    (fp / name).write_text(text)
for group, where in DENY:
    for name, _ in group:
        interp = "node" if name.endswith(".js") else "python3 -I"
        bash(f"SE-145, push и цель в тексте скрипта — отказ: {name}", f"{interp} {fp / name}", True, cwd=where)
for name, _ in SE145_PASS:
    bash(f"SE-145, цели в тексте нет — проход: {name}", f"python3 -I {fp / name}", False, cwd=on_branch)
# Линза backend на 5a0b1b7b8: разбор глобальных опций укладывается в таймаут хука; цепочка длиннее GIT_OPTS_MAX — push
for label, text, limit in (("60 × -c", "git" + " -c" * 60 + " x", 0.1),
                           ("60 × -c k=v", "git" + " -c k=v" * 60 + " x", 0.1),
                           ("10 000 × git -c", "git -c " * 10000 + "x", 1.0)):
    t0 = time.perf_counter()
    GIT_PUSH.search(text)
    took = time.perf_counter() - t0
    check(f"SE-145, GIT_PUSH на {label}: {took:.3f} с, предел {limit} с", took if took >= limit else None, False)
check("SE-145, 40 опций до push — push", GIT_PUSH.search("git" + " -c a=b" * 40 + " push origin HEAD:main"), True)

# --- SE-75: `'` в комментарии скрипта сдвигал разбор кавычек — ложная «запись в main» или спрятанный код ---
se75 = repo_on("main", "se75")
MEM = "\n".join((  # mem-stats.sh из TB-124, сокращённый: прежний разбор давал «запись в защищённую ветку» на main
    "# A decimal point in numbers whatever the SSH session's locale (ru_RU prints «307,0»).",
    "sample_once() {", "    awk -F'\\t' -v now=\"$now\" -v project=\"$PROJECT\" \"$AWK_MIB\"'", "      }'",
    "  while :; do", "    sleep \"$step\"", "  done", "}", "report() {", "  if [ -z \"$file\" ]; then",
    "    file=\"$(find \"$DIR\" -maxdepth 1 -name 'mem-*.tsv' 2>/dev/null | sort | tail -n 1)\"", "  fi",
    "  [ -n \"$file\" ] && [ -s \"$file\" ] || {", "    exit 1", "  }",
    "  echo \"$file: $(cut -f1 \"$file\" | sort -u | wc -l | tr -d ' ') samples, $(head -n 1 \"$file\" | cut -f1)\"",
    "  printf '%-10s %8s %8s %8s %8s %10s\\n' service samples p95_MiB peak_MiB limit suggested",
    "  for id in $(containers); do", "    docker inspect -f '{{.Name}} restarts={{.RestartCount}}' \"$id\"", "  done",
    "  # OOM kills from the kernel log: Docker's State.OOMKilled forgets a kill once the container restarts.",
    "  if ! command -v journalctl >/dev/null 2>&1; then", "    return 0", "  fi", "}", "case \"${1:-}\" in", "esac",
    ""))
(se75 / "mem.sh").write_text(MEM)
(se75 / "mem-push.sh").write_text(MEM + "git push origin HEAD:main\n")
(se75 / "mem-sign.sh").write_text(MEM.replace("Docker's", "Docker's gh pr merge 1"))
(se75 / "tail.sh").write_text("echo x # don't\ngh pr merge 1\necho 'it's'\n")  # bash выполнит строку 2 до ошибки
(se75 / "tail2.sh").write_text("G=gh\necho x # don't\n$G pr merge 1\necho 'it'\n")
bash("SE-75: `'` в комментариях скрипта — не запись в main", "bash mem.sh", False, cwd=se75)
bash("SE-75: тот же скрипт с настоящей записью в main", "bash mem-push.sh", True, cwd=se75)
bash("SE-75: признак в комментарии с `'` — лишний отказ, как c1.sh", "bash mem-sign.sh", True, cwd=se75)
bash("SE-75: кавычка не закрылась после комментария с `'`", "bash tail.sh", True, cwd=se75)
bash("SE-75: комментарий с `'` не прячет $G", "bash tail2.sh", True, cwd=se75)
for form in (": # it's\n$G pr merge 1\n: # it's", "echo \"$(echo \"a\")\" # it's\n$G pr merge 1",
             "echo $(( 16#ff )) # it's\n$G pr merge 1", "f() { echo; } # it's\n$G pr merge 1",
             "echo ${#x} $# # it's\n$G pr merge 1", "echo \"it's\" # it's\n$G pr merge 1",
             "cat <<< 'x' # it's\n$G pr merge 1", "echo \"a # it's\"\n$G pr merge 1"):
    bash(f"SE-75: `'` в комментарии или рядом не прячет код: {form!r}", "G=gh\n" + form, True)
# Контроль на 439e47b9f: маска чисел zsh `<1-2>`, `<1->`, `<->` — часть слова, `#` за ней — тоже (zsh 5.9 выполняет код)
for form in ("setopt nonomatch\nG=gh\n: <1-2>#'\n'; $G pr merge 1; : '\n'", "G=gh\nnoglob : <1-2>#'\n'; $G pr merge 1; : '\n'",
             "setopt nonomatch\nG=gh\n: <->#'\n'; $G pr merge 1; : '\n'"):
    bash(f"SE-75: `#` за маской чисел zsh — не комментарий: {form!r}", form, True)
SURE = ("a # it's\nb", "echo \"$(x \"$f\")\" # it's", "f() { :; } # it's", "a=(1) # it's", "echo ${x#*/} # it's",
        "echo $'\\'' # it's", "echo 'it''s' # it's", "echo $# ${#x} $((16#f)) # it's", "cat <<< 'x' # it's")
LOST = ("echo `a` # it's", "cat <<E\nE\n# it's", "echo $[1] # it's", "x=$(case a in a) :;; esac) # it's",
        "(( 1 # it's\n))", "echo ${x:-'a'} # it's", "( : # it's\n)", "ls (#i)x # it's", "ls !(a) # it's",
        "x=$(: # it's\n)", "(a)# it's", "alias q=\"'\"\n# it's", "echo 'a # it's", "echo \"$(echo \"#\") # it's\"",
        "<1-2>#'", ": <1->#'", ": <->#'")
for text in SURE:  # комментарий — последний ` # ` строки
    got = sure_comments(text)
    check(f"SE-75 sure_comments — верхний уровень: {text!r}", None if got == {text.rindex(" # ") + 1} else got, False)
for text in LOST:
    check(f"SE-75 sure_comments — уверенности нет: {text!r}", sure_comments(text) or None, False)

# --- SE-76: bash (файл, stdin, source, `-c`, eval) выполняет команды до синтаксической ошибки в конце — их разбор ---
se76 = repo_on("main", "se76")
TAILS = {"quote.sh": 'G=gh\n$G pr merge 1\necho "\n', "esc.sh": "G=gh\n$G pr merge 1\necho \\",
         "dq.sh": '# say "hi\nG=gh\n$G pr merge 1\necho "\n',  # `"` в комментарии сошёлся бы с кавычкой в конце
         "dq-odd.sh": "# say \"hi\nG=gh\n$G pr merge 1\necho 'x\n", "push.sh": "git push origin main\necho \"\n",
         "late.sh": 'echo "\n$G pr merge 1\n', "ok.sh": 'echo hi\necho "\n'}  # late — кавычка раньше: bash не выполнит
for name, text in TAILS.items():
    (se76 / name).write_text(text)
    for form in (f"bash {name}", f"source {name}", f"bash < {name}"):
        bash(f"SE-76: {form} — строки до ошибки выполнятся", form, name not in ("late.sh", "ok.sh"), cwd=se76)
for form in ('G=gh\n$G pr merge 1\necho "', "bash -c 'G=gh\n$G pr merge 1\necho \"'", "eval 'G=gh; $G pr merge 1; echo \"'"):
    bash(f"SE-76: команда с ошибкой в конце: {form!r}", form, True)
bash("SE-76: Контролю мёрж из скрипта с ошибкой в конце можно", "bash quote.sh", False, who=D9, cwd=se76)
(se76 / "dq-ok.sh").write_text('# say "hi\necho ok\n')
bash("SE-76: `\"` в комментарии безобидного скрипта — проход", "bash dq-ok.sh", False, cwd=se76)

# --- SE-82: после heredoc, обратных кавычек, `$[…]` sure_comments не уверен — `"` комментария прятала код ---
se82 = repo_on("main", "se82")
LOSS = {"hd": "cat <<E\nx\nE\n", "tick": "echo `true`\n", "arith": "echo $[1]\n"}
for key, head in LOSS.items():
    for name, text in ((f"{key}.sh", '# say "hi\ngh pr merge 1\necho "\n'),
                       (f"{key}-var.sh", '# say "hi\nG=gh\n$G pr merge 1\necho "\n'),
                       (f"{key}-odd.sh", "# say \"hi\nG=gh\n$G pr merge 1\necho \"x\"\necho '\n")):
        (se82 / name).write_text(head + text)
        bash(f"SE-82: {name} — `\"` комментария не прячет код", f"bash {name}", True, cwd=se82)
    (se82 / f"{key}-ok.sh").write_text(head + '# say "hi\necho ok\necho "x"\n')
    bash(f"SE-82: {key}-ok.sh — безобидный скрипт с `\"` в комментарии — проход", f"bash {key}-ok.sh", False, cwd=se82)
bash("SE-82: та же форма командой", 'cat <<E\nx\nE\n# say "hi\nG=gh\n$G pr merge 1\necho "', True)
bash("SE-82: Контролю мёрж из такого скрипта можно", "bash hd-var.sh", False, who=D9, cwd=se82)
REDO = 'cat <<E\nx\nE\n# say "hi\nG=gh\n$G pr merge 1\nE\necho "\n'  # второе прочтение не режет heredoc снова
(se82 / "redo.sh").write_text(REDO)
bash("SE-82: строка `E` ниже не делает код телом heredoc — скрипт", "bash redo.sh", True, cwd=se82)
bash("SE-82: строка `E` ниже не делает код телом heredoc — команда", REDO, True)
(se82 / "m.sh").write_text("echo hi\n")  # старый безобидный файл: хук прочёл бы его, не зная, что команда его пишет
HIDDEN = "printf '%s\\n' 'gh pr merge 1' > m.sh\nbash m.sh\n"
for name, text in (("hw.sh", f'cat <<E\nx\nE\n# say "hi\n{HIDDEN}echo "\n'),
                   ("hw-redo.sh", f'cat <<E\nx\nE\n# say "hi\n{HIDDEN}E\necho "\n')):
    (se82 / name).write_text(text)
    bash(f"SE-82: {name} — запись, спрятанная `\"` комментария, видна: старый m.sh не читается", f"bash {name}", True,
         cwd=se82)
    bash(f"SE-82: {name} командой", text, True, cwd=se82)
for run_ in ("bash", "source"):  # второе прочтение видит тела heredoc первого: m.sh пишет heredoc
    WRITTEN = f"cat > m.sh <<'E'\ngh pr merge 1\nE\n# say \"hi\n{run_} m.sh\n\"\n"
    (se82 / f"hdw-{run_}.sh").write_text(WRITTEN)
    bash(f"SE-82: heredoc пишет m.sh, `{run_} m.sh` спрятан `\"` комментария — скрипт", f"bash hdw-{run_}.sh", True,
         cwd=se82)
    bash(f"SE-82: heredoc пишет m.sh, `{run_} m.sh` спрятан `\"` комментария — команда", WRITTEN, True, cwd=se82)
bash("SE-82: комментарий с признаком и записью остаётся и для имён записи (zsh с другим histchars прочтёт его как код)",
     "echo a # ; printf '%s\\n' 'gh pr merge 1' > m.sh; bash m.sh", True, cwd=se82)
check("SE-82 command_writes: имя из второго прочтения и из слов до ошибки",
      None if "w.sh" in command_writes('cat <<E\nx\nE\n# say "hi\necho x > w.sh\necho "') else "нет", False)
NONE = lambda text: False  # noqa: E731 — признака нет: снимается всё, в чём sure_comments уверен
check("SE-82 comment_readings: все комментарии точно — второго прочтения нет",
      comment_readings('a # say "hi\nb', NONE)[1], False)
check("SE-82 comment_readings: второе прочтение — без комментария, в котором нет уверенности",
      None if comment_readings('echo `a`\n# say "hi\nb', NONE)[1] == "echo `a`\n\nb" else "нет", False)
check("SE-82 comment_readings: в самом втором прочтении третьего нет",
      comment_readings('echo `a`\n# say "hi\nb', NONE, True)[1], False)

if __name__ == "__main__":
    finish(" — формы shell")
