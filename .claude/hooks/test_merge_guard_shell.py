#!/usr/bin/env python3
"""
Проверка merge-guard: формы shell — подстановки, stdin, heredoc, комментарии, скрипты с диска и то, что их запускает.

Запуск: python3 -I .claude/hooks/test_merge_guard_shell.py  (только эти формы; все проверки — test_merge_guard.py)
"""
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_gh import alias_tokens, gh_aliases  # noqa: E402
from merge_guard_comments import sure_comments  # noqa: E402
from merge_guard_expand import brace_argv, qualifier_code  # noqa: E402
from merge_guard_shell import command_name, proc_files  # noqa: E402
from merge_guard_testkit import ROOT, TMP, bash, check, finish, repo_on, run  # noqa: E402

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
             "MAKEFILES=m.mk make -C inc2", "npm --script-shell ./merge9.sh run lint",
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
             f'cd "$X" && echo 1 > {w}/out.txt', "node --run lint", "make -C inc2", "awk -F: '{ print $1 }' /etc/passwd",
             "cd pub && npm version patch", "cd ws && npm run build", "cd tw && turbo run lint",
             "NODE_OPTIONS=--max-old-space-size=6144 npm run lint", "NODE_OPTIONS='--import tsx' node -e 1",
             "bash -n merge9.sh", "bash -n -c 'gh pr merge 1'", "bash -o noexec merge9.sh", "make -j4 -C inc2",
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
SURE = ("a # it's\nb", "echo \"$(x \"$f\")\" # it's", "f() { :; } # it's", "a=(1) # it's", "echo ${x#*/} # it's",
        "echo $'\\'' # it's", "echo 'it''s' # it's", "echo $# ${#x} $((16#f)) # it's", "cat <<< 'x' # it's")
LOST = ("echo `a` # it's", "cat <<E\nE\n# it's", "echo $[1] # it's", "x=$(case a in a) :;; esac) # it's",
        "(( 1 # it's\n))", "echo ${x:-'a'} # it's", "( : # it's\n)", "ls (#i)x # it's", "ls !(a) # it's",
        "x=$(: # it's\n)", "(a)# it's", "alias q=\"'\"\n# it's", "echo 'a # it's", "echo \"$(echo \"#\") # it's\"")
for text in SURE:  # комментарий — последний ` # ` строки
    got = sure_comments(text)
    check(f"SE-75 sure_comments — верхний уровень: {text!r}", None if got == {text.rindex(" # ") + 1} else got, False)
for text in LOST:
    check(f"SE-75 sure_comments — уверенности нет: {text!r}", sure_comments(text) or None, False)

if __name__ == "__main__":
    finish(" — формы shell")
