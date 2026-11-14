#!/usr/bin/env python3
"""
Проверка merge-guard (pre-tool-use-merge-guard.py): кому отказ, кому проход, что не путается с упоминанием; git, API,
MCP, защищённые файлы, реестр, список Контроля, matcher и формат ответа. Формы shell — test_merge_guard_shell.py,
защищённые ветки — test_merge_guard_branches.py, склейка строк — test_merge_guard_lines.py, интерактивный zsh —
test_merge_guard_zsh.py; они
запускаются отсюда же; общее — merge_guard_testkit.py.

Запуск: python3 -I .claude/hooks/test_merge_guard.py  (все проверки; exit 1 при расхождении)
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import (C4, CONTROL, D9, HOME, ROOT, SESSIONS, TMP, bash, check, checked,  # noqa: E402,F401
                                 failures, finish, mg, repo_on, run)


# --- кто вливает ---
bash("мёрж чужой сессией", "gh pr merge 412 --squash", True)
bash("мёрж Контролем", "gh pr merge 412 --squash --match-head-commit abc", False, who=D9)
bash("--help тоже мёрж (живая проба)", "gh pr merge 999999 --help", True)
bash("сессии нет в реестре", "gh pr merge 1", True, who={"sessionId": "nope"})
bash("два живых d9 — по имени не пускать", "gh pr merge 1", True, who=D9, sessions=SESSIONS + [dict(D9, sessionId="ffff")])
bash("sessionId в списке — пускать и при двойнике", "gh pr merge 1", False, who=D9,
     sessions=SESSIONS + [dict(D9, sessionId="ffff")], control=(["d9d9d9d9"], None))
bash("короткий префикс id не считается", "gh pr merge 1", True, who=D9, control=(["d9d9"], None))
bash("испорченный список — никому", "gh pr merge 1", True, who=D9, control=([], "испорчен"))

# --- упоминание не путать с вызовом ---
bash("grep по тексту", 'grep -rn "gh pr merge" docs/', False)
bash("echo", "echo gh pr merge 1", False)
bash("коммит с текстом", "git commit -m 'gh pr merge и git push origin main'", False)
bash("просмотр PR", "gh pr view 412 --json headRefOid", False)
bash("список прогонов", "gh run list --workflow deploy-contabo.yml --limit 1", False)
bash("GET merge-статуса", "gh api repos/o/r/pulls/412/merge", False)

# --- обёртки ---
bash("после cd", "cd /tmp && gh pr merge 1", True)
bash("bash -c", "bash -lc 'gh pr merge 1'", True)
bash("env и переменные", "GH_DEBUG=1 env GH_TOKEN=x gh pr merge 1", True)
bash("полный путь", "/opt/homebrew/bin/gh pr merge 1", True)
bash("подстановка", "x=$(gh pr merge 2)", True)
bash("перевод строки", "git status\ngh pr merge 1", True)
bash("xargs -I", "echo 1 | xargs -I{} gh pr merge {}", True)
bash("timeout -s", "timeout -s KILL 30 gh pr merge 1", True)
bash("eval", "eval 'gh pr merge 1'", True)
bash("-R перед pr", "gh -R agolubenk/HR_Helper-v2 pr merge 1", True)
bash("псевдоним", "gh alias set mm 'pr merge'", True)
bash("python subprocess", "python3 -c \"import subprocess; subprocess.run(['gh','pr','merge','1'])\"", True)
bash("не разобрать, но мёрж", 'gh pr merge 1 "unclosed', True)
bash("не разобрать, без признака", 'echo "unclosed', False)

# --- API и GraphQL ---
bash("api PUT merge", "gh api -X PUT repos/o/r/pulls/412/merge", True)
bash("api merge с полями", "gh api repos/o/r/pulls/412/merge -f merge_method=squash", True)
bash("graphql mergePullRequest", "gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", True)
bash("graphql чтение", "gh api graphql -f query='{viewer{login}}'", False)
bash("curl merge", "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/1/merge", True)
bash("api комментарий PR", "gh api repos/o/r/issues/412/comments -f body=ok", False)

# --- деплой руками ---
bash("workflow run", "gh workflow run deploy-contabo.yml -f ref=abc", True)
bash("workflow run Контролем", "gh workflow run deploy-contabo.yml -f ref=abc", False, who=D9)
bash("run rerun", "gh run rerun 123 --failed", True)
bash("api dispatches", "gh api -X POST repos/o/r/actions/workflows/deploy.yml/dispatches -f ref=main", True)
bash("workflow list", "gh workflow list", False)

# --- запись в main мимо PR ---
bash("push main", "git push origin main", True)
bash("push HEAD:main", "git push origin HEAD:main", True)
bash("push +x:refs/heads/main", "git push origin +feature:refs/heads/main", True)
bash("push :main", "git push origin :main", True)
bash("push --delete main", "git push origin --delete main", True)
bash("push --all", "git push --all origin", True)
bash("push -C", "git -C /tmp push origin master", True)
bash("push своей ветки", "git push -u origin fix/merge-guard", False)
bash("удаление своей ветки", "git push origin --delete tmp/332-rebased", False)
bash("api запись в refs main", "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc", True)
bash("api contents без ветки", "gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=x", True)
bash("api contents в ветку", "gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=x -f branch=fix/a", False)
bash("push main Контролем — пропуск", "git push origin main", False, who=D9)



bash("голый push на main", "git push", True, cwd=repo_on("main"))
bash("голый push с ветки", "git push", False, cwd=repo_on("fix/a"))
bash("push origin HEAD с main", "git push origin HEAD", True, cwd=repo_on("main"))
bash("-c push.default=matching с ветки", "git -c push.default=matching push", True, cwd=repo_on("fix/a"))
bash("-c remote.origin.push в main", "git -c remote.origin.push=HEAD:refs/heads/main push", True, cwd=repo_on("fix/a"))
bash("маска refspec", "git push origin 'refs/heads/*:refs/heads/*'", True)
bash("-c alias с push", "git -c alias.p=push p origin main", True)
bash("завести alias с push", "git config --global alias.sync 'push origin HEAD:main'", True)
bash("завести remote.push в main", "git config remote.origin.push refs/heads/x:refs/heads/main", True)
bash("обычный config", "git config user.name x", False)
bash("DWIM heads/main", "git push origin x:heads/main", True)
bash("DWIM refs/main", "git push origin x:refs/main", True)
bash("matching через :", "git push origin :", True)
bash("--config-env alias", "git --config-env=alias.p=EVIL p origin", True)
bash("--config-env раздельно", "git --config-env alias.p=EVIL p", True)
bash("--config-env безобидный", "git --config-env=user.name=N status", False)
bash("GIT_CONFIG_* + push", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push", True)
bash("export GIT_CONFIG + push ветки", "export GIT_CONFIG_GLOBAL=/tmp/x; git push origin fix/a", True)
bash("GIT_CONFIG + status", "GIT_CONFIG_GLOBAL=/tmp/x git status", False)
bash("-c include.path + push", "git -c include.path=/tmp/x push origin fix/a", True)
bash("config --file alias", "git config --file /tmp/x alias.p push", True)
bash("config set alias", "git config set --global alias.p 'push origin main'", True)
bash("alias-скрипт без слова push", "git config alias.x '!sh -c \"git pu\"\"sh\"'", True)
bash("config include.path", "git config --global include.path /tmp/x", True)
bash("config get alias", "git config get alias.p", False)
bash("глубокая вложенность", "bash -c \"bash -c 'bash -c \\\"bash -c gh\\\\ pr\\\\ merge\\\\ 1\\\"'\"", True)
aliased = repo_on("fix/a")
subprocess.run(["git", "-C", str(aliased), "config", "alias.pm", "push origin HEAD:main"], check=True)
subprocess.run(["git", "-C", str(aliased), "config", "alias.sh", "!git push origin main"], check=True)
subprocess.run(["git", "-C", str(aliased), "config", "alias.st2", "status -s"], check=True)
bash("свой alias на push в main", "git pm", True, cwd=aliased)
bash("alias-скрипт с push", "git sh", True, cwd=aliased)
bash("безобидный alias", "git st2", False, cwd=aliased)
pushed = repo_on("fix/a")
subprocess.run(["git", "-C", str(pushed), "config", "remote.origin.push", "refs/heads/*:refs/heads/*"], check=True)
bash("голый push при remote.push-маске", "git push", True, cwd=pushed)

# --- формы shell (ревью 85 на 69477c5e9) ---
bash("if … then push", "if git push origin main; then echo ok; fi", True)
bash("if true; then merge", "if true; then gh pr merge 1; fi", True)
bash("while … do merge", "while true; do gh pr merge 1; done", True)
bash("! merge", "! gh pr merge 1", True)
bash("for по PR", "for p in 429 430; do gh pr merge $p --squash; done", True)
bash("группа { }", "{ gh pr merge 1 --squash; } 2>&1 | tail -3", True)
bash("$(…) в кавычках — merge", 'out="$(gh pr merge 431 --squash 2>&1)"', True)
bash("$(…) в кавычках — push", 'r="$(git push origin main 2>&1)"', True)
bash("обратные кавычки", "x=`gh pr merge 1`", True)
bash("$(…) в refspec", "git push origin $(git rev-parse HEAD):refs/heads/main", True)
bash("python heredoc subprocess", "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['gh','pr','merge','1'])\nPY", True)
bash("python heredoc пишет settings", f"python3 - <<'PY'\nopen('{ROOT}/.claude/settings.json','w').write('{{}}')\nPY", True)
bash("python heredoc, путь из частей", "python3 - <<'PY'\nimport os\nopen(os.path.join(R, '.claude', 'settings.json'), 'w')\nPY", True)
bash("bash heredoc", "bash <<'SH'\ngh pr merge 1\nSH", True)
bash("heredoc в | bash", "cat <<'EOF' | bash\ngh pr merge 1\nEOF", True)
bash("heredoc без кавычек выполняет $(…)", "cat > /tmp/x <<EOF\n$(gh pr merge 1)\nEOF", True)
bash("heredoc-данные с текстом merge", "cat > /tmp/pr.md <<'EOF'\nне делать gh pr merge и git push origin main\nEOF", False)
bash("коммит через $(cat <<EOF)", "git commit -m \"$(cat <<'EOF'\nfix: gh pr merge и git push origin main\nEOF\n)\"", False)
bash("$(…) в одинарных кавычках с признаком — лишний отказ: так выглядит и `x='a[$(…)]'; echo $((x))`",
     "echo '$(gh pr merge 1)'", True)
bash("$(…) в одинарных кавычках без признака", "echo '$(git status)'", False)
bash("python heredoc читает правила", "python3 - <<'PY'\nprint(open('.claude/rules/01-base.md').read())\nPY", False)
bash("переменная = main", "B=main; git push origin HEAD:$B", True)
bash("переменная = ветка", "B=fix/a; git push origin HEAD:\"$B\"", False)
bash("цикл по веткам", "for b in fix/a main; do git push origin $b; done", True)
bash("export переменной", "export B=main && git push origin HEAD:${B}", True)
on_main, on_branch = repo_on("main"), repo_on("fix/a")
bash("push $(текущая) с ветки", 'git push -u origin "$(git branch --show-current)"', False, cwd=on_branch)
bash("push $(текущая) с main", 'git push -u origin "$(git branch --show-current)"', True, cwd=on_main)
bash("push неизвестной переменной с main", "git push origin $BRANCH", True, cwd=on_main)
bash("sponge", "jq . a.json | sponge .claude/settings.json", True)
bash("git send-pack", "git send-pack origin main", True)
bash("env -S", "env -S 'gh pr merge 1'", True)
Path(TMP / "q.graphql").write_text('mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}')
bash("graphql -F query=@файл", f"gh api graphql -F query=@{TMP}/q.graphql", True)
# --- тело gh api из файла и stdin (автоматическое ревью на 74a37e732) ---
Path(TMP / "q.json").write_text('{"query": "mutation{mergePullRequest(input:{pullRequestId:\\"x\\"}){clientMutationId}}"}')
Path(TMP / "big.json").write_text('{"query": "' + " " * (1024 * 1024) + 'mutation{mergePullRequest}"}')
Path(TMP / "read.json").write_text('{"query": "{viewer{login}}"}')
bash("graphql --input файл", f"gh api graphql --input {TMP}/q.json", True)
bash("graphql --input файл, путь от cwd", "gh api graphql --input q.json", True, cwd=TMP)
bash("graphql --input -", "echo x | gh api graphql --input -", True)
bash("graphql -F query=@-", "echo x | gh api graphql -F query=@-", True)
bash("graphql --input файла ещё нет", f"cp {TMP}/q.json n.json && gh api graphql --input n.json", True, cwd=TMP)
bash("graphql -F query=@файл больше 1 МБ", f"gh api graphql -F query=@{TMP}/big.json", True)
bash("graphql --input чтение", f"gh api graphql --input {TMP}/read.json", False)
bash("graphql --input чтение, путь от cwd", "gh api graphql --input read.json", False, cwd=TMP)
bash("graphql -f query=@x — строка, не файл", "gh api graphql -f query=@x", False)
# --- флаги gh api по разбору pflag, FIFO и устройства, тело и ветка contents (автоматическое ревью на ca50900d7) ---
for form in ("-Fquery=@q.json", "--input=q.json", "--field=query=@q.json", "-iF query=@q.json", "-F=query=@q.json"):
    bash(f"r11, форма флага: {form}", f"gh api graphql {form}", True, cwd=TMP)
for form in ("-Fquery=@read.json", "--input=read.json", "-iF query=@read.json", "-f=query=@q.json"):
    bash(f"r11, форма флага, чтение: {form}", f"gh api graphql {form}", False, cwd=TMP)
os.mkfifo(TMP / "fifo")  # без писателя: open() без O_NONBLOCK повесил бы хук до тайм-аута, а тайм-аут — пропуск
for form in ("--input fifo", "-F query=@fifo", "--input /dev/stdin < q.json", "-F query=@/dev/fd/0 < q.json"):
    bash(f"r11, не обычный файл: {form}", f"gh api graphql {form}", True, cwd=TMP)
M = '{"query":"mutation{mergePullRequest(input:{pullRequestId:\\"x\\"}){clientMutationId}}"}'
for form in (f"printf '%s' '{M}' > read.json; gh api graphql --input read.json",
             f"cat > read.json <<'EOF'\n{M}\nEOF\ngh api graphql --input read.json",
             "cp q.json read.json && gh api graphql -F query=@read.json", "mv q.json read.json; gh api graphql --input=read.json"):
    bash(f"r11, тело переписывает та же команда: {form[:60]!r}", form, True, cwd=TMP)
Path(TMP / "b.txt").write_text("main")
for form in ("-f message='x branch=feat'", "-F branch=@b.txt", "-F branch={branch}", "-f branch=feat --raw-field=branch=main",
             "--input body.json", "-fbranch=main"):
    bash(f"r11, contents — ветка main или не видна: {form}", f"gh api -X PUT repos/o/r/contents/a {form} -f content=eA==", True)
for form in ("-F branch=feat", "-f branch=main -f branch=feat", "--raw-field=branch=fix/a", "-fbranch=fix/a"):
    bash(f"r11, contents — в ветку: {form}", f"gh api -X PUT repos/o/r/contents/a {form} -f content=eA==", False)
# --- подкоманда gh так, как её ищет cobra: флаг до подкоманды и значение неизвестного флага (автоматическое ревью на 46914be6a) ---
for form in ("gh api -q -R -X PUT repos/o/r/pulls/1/merge", "gh -X PUT api repos/o/r/pulls/1/merge", "gh pr --subject x merge 1",
             "gh --subject x pr merge 1", "gh -R o/r pr merge 1", "gh workflow --ref main run d.yml",
             "gh alias set m --clobber 'pr merge'", "gh alias import a.yml", "gh api graphql -q -R -F query=@q.json"):
    bash(f"r12, gh: {form!r}", form, True, cwd=TMP)
for form in ("gh pr --json number view 433", "gh --jq .rate.limit api rate_limit", "gh pr view 1 --json title",
             "gh api repos/o/r/pulls -q .title", "gh alias set co 'pr checkout'", "gh api graphql -q -R -F query=@read.json"):
    bash(f"r12, gh чтение: {form!r}", form, False, cwd=TMP)

# --- псевдонимы gh: вызов — по раскрытию из config.yml, `alias set` — закрыто (автоматическое ревью на b5c9e9e56) ---
gh_conf = TMP / "gh13"
gh_conf.mkdir()
(gh_conf / "config.yml").write_text("aliases:\n    co: pr checkout\n    m: pr merge\n    p: pr\n    d: 'workflow run d.yml'\n"
                                    "    a: api\n    sh: '!gh pr merge \"$1\"'\n    pm: pr $1\n    v: pr view\n    chain: m\n"
                                    "    any: $1\n    hc: 'pr #c'\n    bs: 'pr \"\\merge\"'\n    cm: pr view # c\n    q: \"pr view\"\n    cs: pr checkout $1\n"
                                    "    ext: pr view\nother: 1\neditor:\n")
(TMP / "gh13data" / "extensions" / "gh-ext").mkdir(parents=True)
os.environ["GH_CONFIG_DIR"], os.environ["GH_DATA_DIR"] = str(gh_conf), str(TMP / "gh13data")
for form in ("gh m 1", "gh p merge 1", "gh d", "gh a -X PUT repos/o/r/pulls/1/merge", "gh sh 1", "gh pm merge 1",
             "gh chain 1", "gh alias set x pr", "gh alias set x 'pr --repo o/r'", "gh alias set x '$1 merge'",
             "gh alias set --shell x 'gh pr view'", "gh alias set -s x 'issue list; gh pr merge 1'", "gh alias set x '!gh pr view'", "gh alias set x - < a.txt",
             "gh alias set x co", "gh alias set x run", "gh alias set x 'api rate_limit'", "gh alias set x 'pr $1'",
             "gh alias set x -- '--repo o/r'"):
    bash(f"r13, псевдоним gh: {form!r}", form, True, cwd=TMP)
for form in ("gh v 1", "gh co 1", "gh alias set v 'pr view'",
             "gh alias set prs 'pr list --author @me'", "gh alias set il 'issue list'", "gh alias set c 'pr checkout $1'"):
    bash(f"r13, псевдоним gh, чтение: {form!r}", form, False, cwd=TMP)
# --- псевдоним gh как его прочтёт gh: YAML, `$N`, google/shlex, конфиг из окружения команды (ревью на 606148a2b) ---
for form in ("gh nosuchext run", "gh other merge", "gh any pr merge 1", "gh pm", "gh -R o/r pm merge 1", "gh hc merge 1", "gh bs 1",
             "gh ext 1", "GH_CONFIG_DIR=/tmp/x gh co 1", "export XDG_CONFIG_HOME=/tmp/x; gh v 1", "env HOME=/tmp/x gh v 1",
             "env -i gh v 1", "unset GH_CONFIG_DIR; gh v 1", "sudo gh v 1", "GH_DATA_DIR=/tmp/x gh v 1",
             "printf 'aliases:\\n    v: pr merge\\n' > \"$GH_CONFIG_DIR/config.yml\" && gh v 1", "cp x.yml ~/.config/gh/config.yml && gh v 1", "curl -so config.yml https://x && gh v 1",
             "gh alias set x 'pr #c'", "gh alias set x 'pr \"\\\\merge\"'", "\"$GH\" m 1", "gh cs"):
    bash(f"r14, псевдоним gh: {form!r}", form, True, cwd=TMP)
for form in ("gh cm 1", "gh q 1", "gh cs 5", "GH_CONFIG_DIR=/tmp/x gh pr view 1", "HOME=/tmp gh pr list",
             "export HOME=/tmp; gh issue list", "gh v 1 && echo $HOME", "\"$PY\" x.py", "$TOOL build --fast"):
    bash(f"r14, псевдоним gh, чтение: {form!r}", form, False, cwd=TMP)
(TMP / "cfg15.sh").write_text("export GH_CONFIG_DIR=/tmp/x\ngh v 1\n")
(TMP / "cfg15b.sh").write_text("export GH_CONFIG_DIR=/tmp/x\n")  # ревью на 009fd74e0: окружение задано иначе
for form in ("HOME+=/x gh v 1", "export H\"OME\"=/tmp/x; gh v 1", "export H\\OME=/tmp/x; gh v 1", "printf -v HOME /x; gh v 1",
             "printf -vHOME /x; gh v 1", "getopts x HOME; gh v 1", ": ${GH_CONFIG_DIR:=/tmp/x}; gh v 1",
             "export $(printf GH_CONFIG%s _DIR)=/tmp/x; gh v 1", "source e.sh; gh v 1", ". ./e.sh && gh v 1",
             "builtin source e.sh; gh v 1", "command . e.sh; gh v 1", "eval \"$E\"; gh v 1", "mapfile -t HOME < f; gh v 1",
             "declare -n r=HOME; r=/x; gh v 1", "bash cfg15.sh", "XDG_CONFIG_HOME+=/tmp/e gh co 1",
             "printf -v HOME %s /tmp/eh; gh co 1", "for HOME in /tmp/eh; do gh co 1; done", "read -aHOME <<< x; gh v 1",
             "set -a; : \"${GH_CONFIG_DIR:=/tmp/e}\"; gh co 1", "set -a; : \"${XDG_CONFIG_HOME=/tmp/e}\"; gh co 1",
             ": ${HOME::=/x}; gh v 1", ": ${(P)n::=/x}; gh v 1", ". ./cfg15b.sh; gh v 1", "n=HO; n+=ME; declare -n r=$n; r=/x; gh v 1", "export $'HOME'=/x; gh v 1"):
    bash(f"r15, псевдоним gh: {form!r}", form, True, cwd=TMP)
for form in ("gh v 1 && echo ${HOME}/x", "git add . && gh v 1", "printf '%s' x > out.txt && gh v 1",
             "echo $XDG_CONFIG_HOME; gh v 1", "MYHOME=1 gh v 1", "export FOO=1; gh pr view 1", "gh co 1 > $HOME/co.log",
             "export PY=python3; $PY x.py", "$(echo ls) -la", "$(echo gh) zz 1",
             "env FOO=1 docker compose -f a.yml config; gh v 1", "env \"${envs[@]}\" docker compose -f a.yml config",
             "source e.sh; \"$PY\" x.py", "printf x > config.yml; $TOOL build", "sudo true; $TOOL build",
             "GH_CONFIG_DIR=/tmp/e $(echo gh) co 1", ". ./cfg15b.sh; $(echo gh) v 1"):  # догадка: смена конфига не в счёт
    bash(f"r15, псевдоним gh, чтение: {form!r}", form, False, cwd=TMP)
# --- значения переменных: присваивания `+=`/`a[1]=`, смена тем, что разбор не повторяет, операторы `${…}` (ревью r15) ---
for form in ("A+=1 gh pr merge 1", "a[1]=1 gh pr merge 1", "A+=1 git push origin HEAD:main", "env X.Y=1 gh pr merge 1",
             "env 'a b=1' gh pr merge 1", "Aж=1 gh pr merge 1", "G=g; G+=h; $G pr merge 1", "G=g; export G+=h; $G pr merge 1",
             "B=HEAD:mai; B+=n; git push origin $B", "G=x; read G <<< gh; $G pr merge 1", "G=x; printf -vG gh; $G pr merge 1",
             "G=; : ${G:=gh}; $G pr merge 1", "G=x; eval G=gh; $G pr merge 1", "G=x; source e.sh; $G pr merge 1",
             "G=x; declare -n r=G; r=gh; $G pr merge 1", "G=x; unset G; $G pr merge 1", "G=GH; typeset -l G; $G pr merge 1",
             "B=x; read B <<< HEAD:main; git push origin $B", "G=x; select G in gh; do $G pr merge 1; done",
             "G=x; read $n <<< gh; $G pr merge 1", "G=x; export $(echo G)=gh; $G pr merge 1",
             "if true; then B=HEAD:main; else B=feat; fi; git push origin $B", "f() { G=gh; }; G=x; f; $G pr merge 1",
             "G=GH; ${G:l} pr merge 1", "G=GH; $G:l pr merge 1", "G=xgh; $G[2,3] pr merge 1", "G=ghx; ${G%x} pr merge 1",
             "G=GH; ${(L)G} pr merge 1", "H=G; G=gh; ${(P)H} pr merge 1", "B=HEAD:mainx; git push origin ${B%x}",
             "G=x; ${G/x/gh} pr merge 1", "G=x; G=${G/x/gh}; $G pr merge 1", "G=x; : ${(P)n::=gh}; $G pr merge 1",
             "G=; export X=${G:=gh}; $G pr merge 1", "G=x; builtin source e.sh; $G pr merge 1", "$X gh pr merge 1",
             "env $X gh pr merge 1", "${DRY:+echo} gh pr merge 1", "$X git push origin HEAD:main", "$A $B gh pr merge 1",
             "$(true) gh pr merge 1", "\"${A[@]}\" gh pr merge 1", "$SUDO env FOO=1 gh pr merge 1",
             "git $X origin HEAD:main", "git $(echo push) origin HEAD:main", "git \"$SUB\" origin main",
             "git $X origin HEAD:$B", "git $X --mirror origin", "gh pr $X 1", "gh workflow $(echo run) d.yml",
             "gh run $X 5", "gh alias $X"):
    bash(f"r15, переменная: {form!r}", form, True, cwd=TMP)
for form in ("B=feat; git push origin $B", "B=feat; git push origin \"$B:$B\"", "TOOL=npm; $TOOL run build", "G=gh; $G pr view 1",
             "D=$PWD; cd /tmp; cd $D; git status", "X=${X:-3}; echo $X", "B=feat; echo B; git push origin feat",
             "export A=1 B=2; $A x", "read -r line <<< x; echo $line", "for f in a b; do git push origin $f; done",
             "B=feat; printf '%s\\n' \"$X\"; git push origin $B", "B=feat; git push origin $B:dev", "$X ls -la",
             "\"$PY\" -m pytest", "$DOCKER compose up -d", 
             "gh pr view $X", "gh pr list --author $X"):
    bash(f"r15, переменная, проход: {form!r}", form, False, cwd=TMP)
# security-review на 57ada1a11: скрытая подкоманда с целью-переменной или без цели; запись config.yml при скрытом имени gh
for form in ("git $X origin \"$B\"", "git $(echo push) origin $B", "git $X origin $(cat b.txt)", "git $X \"$R\" \"$B\"", "git $X push origin \"$B\"",
             "printf 'aliases:\\n    zz: pr merge\\n' > \"$GH_CONFIG_DIR/config.yml\"; $G zz 1", "cp x.yml ~/.config/gh/config.yml && \"$GH\" zz 1"):
    bash(f"r17, скрыто: {form!r}", form, True, cwd=TMP)
for form in ("export GH_CONFIG_DIR=/tmp/x; \"$PY\" x.py", "cp x.yml config.yml && $TOOL zz 1"):
    bash(f"r17, скрыто, проход: {form!r}", form, False, cwd=TMP)
# security-review на 57ada1a11 и cd5f43161: подкоманда git не видна — отказ всегда, `git $X status` тоже (`X="push origin"`)
for form in ("git $X status", "git $X diff main...HEAD", "git $X log --oneline -5", "git $X origin feat", "git $X push origin feat",
             "git $X status HEAD:main", "git $X add x:main", "git $X HEAD:main", "git $X add \"$f\" \"$g\"", "git $X \"$R\" feat",
             "git \"${A[@]}\"", "git $X", "git $X -q", "git $(echo status)"):
    for where in (TMP, on_main, on_branch):
        bash(f"r18, скрыто: {form!r}", form, True, cwd=where)
for form in ("X=status; git $X", "git -C \"$D\" status"):
    bash(f"r18, видно: {form!r}", form, False, cwd=on_branch)
for name, text, want in (("block", "aliases:\n    v: pr view\n    b: |\n      pr merge\n", True),
                         ("plain2", "aliases:\n    v: pr\n      merge\n", True),
                         ("escape", 'aliases:\n    v: "pr \\x6derge"\n', True),
                         ("dup", "aliases:\n    v: pr merge\n    v: pr view\n", True),
                         ("anchor", "aliases:\n    v: &a pr view\n", True),
                         ("quoted", '"aliases":\n    v: pr view\n', True),
                         ("tab", "aliases:\n\tv: pr view\n", True),
                         ("string", 'editor: "x\naliases:\n    v: pr view\nother: y"\n', True),
                         ("flow", "editor: [x,\naliases:\n    v: pr view\nother: y]\n", True),
                         ("two", "aliases:\n    v: pr view\naliases:\n    m: pr merge\n", True),
                         ("nel", "aliases:\n    v: pr view\x85merge\n", True),
                         ("ls", "aliases:\n    v: pr view\N{LINE SEPARATOR}merge\n", True),
                         ("ps", "aliases:\n    v: pr view\N{PARAGRAPH SEPARATOR}merge\n", True),
                         ("colon", "aliases:\n    v: pr view: x\n", True),
                         ("anchor2", "editor: &e vim\naliases:\n    v: pr merge\n", True),
                         ("crlf", "aliases:\r\n    v: pr view\r\n", False)):
    (TMP / f"gh14{name}").mkdir()
    (TMP / f"gh14{name}" / "config.yml").write_bytes(text.encode())
    os.environ["GH_CONFIG_DIR"] = str(TMP / f"gh14{name}")
    bash(f"r14, config.yml не в простом виде ({name}): gh v 1", "gh v 1", want, cwd=TMP)
    bash(f"r15, config.yml не в простом виде ({name}): $(echo gh) v 1", "$(echo gh) v 1", want, cwd=TMP)
(TMP / "gh15none").mkdir()  # config.yml нет: псевдонимов нет; не обычный файл — не узнать
(TMP / "gh15dir" / "config.yml").mkdir(parents=True)
for d, form, want in (("gh15none", "$TOOL build --fast", False), ("gh15none", "gh zz 1", True), ("gh15dir", "$TOOL build", True)):
    os.environ["GH_CONFIG_DIR"] = str(TMP / d)
    bash(f"r15, {d}: {form}", form, want, cwd=TMP)
del os.environ["GH_CONFIG_DIR"], os.environ["GH_DATA_DIR"]
bash("claude без хуков", "claude -p x --settings '{\"disableAllHooks\":true}'", True, who=D9)
bash("claude --setting-sources user", "claude --setting-sources user -p x", True)
bash("claude обычный", "claude -p 'привет' --setting-sources user,project,local", False)

# --- конфиг git из окружения и mirror (автоматическое ревью 3) ---
bash("config remote.mirror", "git config remote.origin.mirror true", True)
bash("-c remote.mirror + голый push", "git -c remote.origin.mirror=true push origin", True, cwd=on_branch)
bash("--config-env mirror", "git --config-env=remote.origin.mirror=X push origin fix/a:fix/a", True)
mirrored = repo_on("fix/a")
subprocess.run(["git", "-C", str(mirrored), "config", "remote.origin.mirror", "true"], check=True)
bash("голый push при mirror в конфиге", "git push origin", True, cwd=mirrored)
bash("GIT_DIR + push ветки", "GIT_DIR=/tmp/x/.git git push origin fix/a", True)
bash("HOME + push", "HOME=/tmp git push origin fix/a", True)
bash("--git-dir + push", "git --git-dir=/tmp/x/.git push origin fix/a", True)
bash("GIT_TERMINAL_PROMPT безобиден", "GIT_TERMINAL_PROMPT=0 git push origin fix/a:fix/a", False)

# --- законы и настройки в основной папке ---
rules = str(ROOT / ".claude" / "rules" / "01-base.md")
check("Edit правила", run("Edit", {"file_path": rules}), True)
check("Edit правила даже Контролем", run("Edit", {"file_path": rules}, who=D9), True)
check("Write settings.json", run("Write", {"file_path": str(ROOT / ".claude" / "settings.json")}), True)
check("Write локального списка", run("Write", {"file_path": str(ROOT / ".claude" / "merge-guard.local.json")}), True)
check("Edit правила в worktree", run("Edit", {"file_path": str(ROOT / "worktrees/fix/x/.claude/rules/01-base.md")}), False)
WT = ROOT / "worktrees" / "fix" / "x"
roots_wt = mg.main_roots(WT)
if roots_wt != sorted({os.path.realpath(ROOT), os.path.realpath(WT)}):
    failures.append(f"main_roots из worktree: ждали основную папку и worktree, получили {roots_wt}")
in_wt = {"tool_name": "Edit", "session_id": C4["sessionId"], "cwd": str(WT)}
for rel, want in ((".claude/hooks/x.py", True), (".claude/merge-guard.local.json", True), (".claude/rules/a.md", True)):
    got = mg.decide(dict(in_wt, tool_input={"file_path": str(WT / rel)}), lambda: SESSIONS, lambda: CONTROL, roots=roots_wt)
    check(f"сессия из worktree: свой {rel}", got, want)
got = mg.decide(dict(in_wt, tool_input={"file_path": str(ROOT / "worktrees/fix/y/.claude/rules/a.md")}),
                lambda: SESSIONS, lambda: CONTROL, roots=roots_wt)
check("сессия из worktree: соседний worktree", got, False)
if mg.load_control.__defaults__[0] != mg.MAIN_ROOT:
    failures.append("load_control по умолчанию должен читать список из основной папки")
check("Edit памяти DAMS", run("Edit", {"file_path": str(ROOT / ".claude" / "memory" / "a.md")}), False)
check("Edit кода", run("Edit", {"file_path": str(ROOT / "apps" / "a.ts")}), False)
check("пользовательский settings.json", run("Edit", {"file_path": str(HOME / "settings.json")}), True)
check("реестр сессий", run("Write", {"file_path": str(HOME / "sessions" / "1.json")}), True)
check("относительный путь", run("Edit", {"file_path": ".claude/hooks/x.py"}), True)
bash("перенаправление", "echo '{}' > .claude/settings.json", True)
bash("дописать в правило", "echo x >> .claude/rules/01-base.md", True)
bash("sed -i", "sed -i '' 's/a/b/' .claude/rules/01-base.md", True)
bash("cp в хуки", "cp /tmp/x.py .claude/hooks/x.py", True)
bash("cp из хуков", "cp .claude/hooks/x.py /tmp/x.py", False)
bash("tee", "echo x | tee .claude/settings.local.json", True)
bash("rm реестра", f"rm {HOME}/sessions/1.json", True)
bash("python пишет настройки", "python3 -c \"open('.claude/settings.json','w').write('{}')\"", True)
bash("heredoc с апострофом", "cat > .claude/settings.json <<'EOF'\nit's\nEOF", True)
bash("чтение правил", "cat .claude/rules/01-base.md && grep -n x .claude/settings.json", False)
bash("git checkout файла правил", "git checkout -- .claude/rules/01-base.md", True)
bash("git checkout ветки", "git checkout main", False)
bash("2>&1 не цель записи", "ls 2>&1 | head", False)

# --- MCP ---
check("MCP merge чужой", run("mcp__github__merge_pull_request", {"pullNumber": 1}), True)
check("MCP merge Контроль", run("mcp__github__merge_pull_request", {"pullNumber": 1}, who=D9), False)
check("MCP push_files в main", run("mcp__github__push_files", {"branch": "main"}), True)
check("MCP push_files в ветку", run("mcp__github__push_files", {"branch": "fix/a"}), False)
check("MCP файл без ветки", run("mcp__github__create_or_update_file", {"path": "a"}), True)
check("MCP чтение PR", run("mcp__github__pull_request_read", {"pullNumber": 1}), False)
check("oq: своё имя", run("mcp__owner-queue__oq_agent_status", {"id": "d-1", "session": "hr-helper-v2-4c"}), False)
check("oq: короткое своё", run("mcp__owner-queue__oq_agent_status", {"id": "d-1", "session": "4c"}), False)
check("oq: чужое имя", run("mcp__owner-queue__oq_agent_status", {"id": "d-1", "session": "hr-helper-v2-d9"}), True)
check("oq: без session", run("mcp__owner-queue__oq_agent_status", {"id": "d-1", "status": "doing"}), False)
check("oq: put не проверяется", run("mcp__owner-queue__oq_put", {"collection": "items", "data": {"source": "e1"}}), False)
check("прочие инструменты", run("Read", {"file_path": rules}), False)
check("MCP merge через хаб", run("mcp__hub__github_1mcp_merge_pull_request", {"pullNumber": 1}), True)
check("oq через хаб: чужое имя", run("mcp__hub__owner-queue_1mcp_oq_agent_status", {"session": "hr-helper-v2-d9"}), True)

# --- обходы d9 на f24846b9b: shell мимо Bash, вердикт в очереди, правка файлов через MCP ---
CTX = "mcp__plugin_context-mode_context-mode__"
check("Monitor с мёржем", run("Monitor", {"command": "gh pr merge 999999 --squash"}), True)
check("Monitor с tail", run("Monitor", {"command": "tail -f /tmp/x.log | grep --line-buffered ERROR"}), False)
check("ctx_execute shell", run(CTX + "ctx_execute", {"language": "shell", "code": "gh pr merge 1"}), True)
check("ctx_execute python", run(CTX + "ctx_execute", {"language": "python", "code": "import subprocess\nsubprocess.run(['gh','pr','merge','1'])"}), True)
check("ctx_execute javascript", run(CTX + "ctx_execute", {"language": "javascript", "code": "execSync('gh workflow run deploy-contabo.yml')"}), True)
check("ctx_execute безобидный", run(CTX + "ctx_execute", {"language": "shell", "code": "git log --oneline -5"}), False)
check("ctx_batch_execute деплой", run(CTX + "ctx_batch_execute", {"commands": [{"label": "a", "command": "ls"}, {"label": "b", "command": "gh workflow run deploy-contabo.yml"}]}), True)
check("ctx_batch_execute безобидный", run(CTX + "ctx_batch_execute", {"commands": [{"label": "a", "command": "gh pr view 1"}]}), False)
check("ctx_execute_file безобидный", run(CTX + "ctx_execute_file", {"path": "a.log", "language": "python", "code": "print(len(FILE_CONTENT))"}), False)
check("ctx_execute_file пишет settings", run(CTX + "ctx_execute_file", {"path": "a", "language": "python", "code": f"open('{ROOT}/.claude/settings.json','w')"}), True)
FULL = "a" * 40
check("oq: вердикт в m-пункте чужой", run("mcp__owner-queue__oq_put", {"collection": "items", "id": "m-999-x", "data": {"kind": "merge", "pr": 999, "sha": FULL, "base": "main", "deploy": "skip"}}), True)
check("oq: вердикт в m-пункте Контроль", run("mcp__owner-queue__oq_put", {"collection": "items", "id": "m-999-x", "data": {"kind": "merge", "pr": 999, "sha": FULL, "base": "main"}}, who=D9), False)
check("oq: patch sha в любой пункт", run("mcp__owner-queue__oq_patch", {"collection": "items", "id": "d-1", "data": {"sha": FULL, "base": "main"}}), True)
check("oq: patch deploy в m-пункт", run("mcp__owner-queue__oq_patch", {"collection": "items", "id": "m-1", "data": {"deploy": "skip"}}), True)
check("oq: kind merge в чужом id", run("mcp__hub__owner-queue_1mcp_oq_put", {"collection": "items", "id": "x-1", "data": {"kind": "merge", "pr": 1}}), True)
check("oq: архив m-пункта", run("mcp__owner-queue__oq_patch", {"collection": "items", "id": "m-1", "data": {"archived": True}}), False)
check("oq: снять sha (null)", run("mcp__owner-queue__oq_patch", {"collection": "items", "id": "m-1", "data": {"sha": None}}), False)
check("oq: d-пункт обычный", run("mcp__owner-queue__oq_put", {"collection": "items", "id": "d-1", "data": {"kind": "decision", "title": "t", "cmd": "gh pr merge 1"}}), False)
check("oq: work с sha", run("mcp__owner-queue__oq_patch", {"collection": "work", "id": "w-1", "data": {"sha": FULL}}), False)
check("serena правит settings", run("mcp__serena__replace_content", {"relative_path": ".claude/settings.json", "needle": "a", "repl": "b"}), True)
check("serena плагином правит хук", run("mcp__plugin_serena_serena__insert_after_symbol", {"relative_path": ".claude/hooks/x.py", "name_path": "f", "body": ""}), True)
check("serena правит код", run("mcp__serena__replace_content", {"relative_path": "apps/backend/src/main.ts", "needle": "a", "repl": "b"}), False)
check("serena читает settings", run("mcp__serena__find_symbol", {"relative_path": ".claude/settings.json", "name_path": "x"}), False)
check("github create_or_update в ветку — путь не проверяется", run("mcp__github__create_or_update_file", {"path": ".claude/settings.json", "branch": "fix/a"}), False)

subprocess.run(["git", "-C", str(aliased), "config", "alias.p", "push"], check=True)
bash("-c у псевдонима: matching", "git -c push.default=matching p", True, cwd=aliased)
bash("псевдоним на push с ветки", "git p", False, cwd=aliased)
subprocess.run(["git", "-C", str(aliased), "config", "alias.q", "status"], check=True)
bash("кэш git: псевдоним до смены", "git q origin HEAD:main", False, cwd=aliased)
subprocess.run(["git", "-C", str(aliased), "config", "alias.q", "push"], check=True)
bash("кэш git: новое решение — заново", "git q origin HEAD:main", True, cwd=aliased)  # кэш живёт одно решение
spaced = repo_on("fix/a", prefix="a b'")  # $PWD с пробелом и кавычкой: значение в кавычках shlex
bash("$PWD с пробелом: путь — одно слово", "git -C $PWD push origin HEAD:main", True, cwd=spaced)
bash("$PWD с пробелом, через переменную", "X=$PWD; git -C $X push origin HEAD:main", True, cwd=spaced)

import test_merge_guard_shell  # noqa: E402,F401  — формы shell, те же счётчики
import test_merge_guard_branches  # noqa: E402,F401  — защищённые ветки (origin/HEAD, protected)
import test_merge_guard_lines  # noqa: E402,F401  — склейка строк `\`⏎ (SE-83)
import test_merge_guard_zsh  # noqa: E402,F401  — интерактивный zsh, `-oимя` (SE-85)

# --- бюджет git ---
mg_git = sys.modules["merge_guard_git"]
real_run = mg_git.subprocess.run


def hang(*a, **kw):
    raise subprocess.TimeoutExpired(a[0], kw.get("timeout"))


mg_git.subprocess.run = hang
bash("git завис — голый push отказ", "git push", True, cwd=on_branch)
bash("git завис — status проходит", "git status", False, cwd=on_branch)
mg_git.subprocess.run = real_run

# --- реестр и список с диска ---
(HOME / "sessions" / "live.json").write_text(json.dumps({"pid": os.getpid(), "sessionId": "live", "name": "n"}))
(HOME / "sessions" / "dead.json").write_text(json.dumps({"pid": 2 ** 22 + 12345, "sessionId": "dead", "name": "n"}))
(HOME / "sessions" / "bad.json").write_text("{")
got = [s["sessionId"] for s in mg.live_sessions(HOME / "sessions")]
if got != ["live"]:
    failures.append(f"live_sessions: ждали ['live'], получили {got}")

proj = TMP / "proj"
(proj / ".claude").mkdir(parents=True)
if mg.load_control(proj)[0] != []:
    failures.append("load_control без файла — ждали пустой список")
(proj / ".claude" / "merge-guard.json").write_text(json.dumps({"control": ["a"]}))
if mg.load_control(proj) != (["a"], None):
    failures.append("load_control: общий файл не прочитан")
(proj / ".claude" / "merge-guard.local.json").write_text(json.dumps({"control": ["b"]}))
if mg.load_control(proj) != (["b"], None):
    failures.append("load_control: локальный файл не заменил общий")
(proj / ".claude" / "merge-guard.local.json").write_text('{"control": "b"}')
c, err = mg.load_control(proj)
if c or not err:
    failures.append("load_control: испорченный локальный файл должен давать пустой список и ошибку")

# --- матчер в settings.json: хук вызывается на всех инструментах, которые разбирает ---
dup_keys = []


def no_dup(pairs):
    """json.loads молча оставляет последний из повторных ключей — второй "PreToolUse" стёр бы первый (мёрж ec2491433)."""
    seen = [k for k, _ in pairs]
    dup_keys.extend(sorted({k for k in seen if seen.count(k) > 1}))
    return dict(pairs)


settings = json.loads((Path(__file__).resolve().parents[1] / "settings.json").read_text(encoding="utf-8"),
                      object_pairs_hook=no_dup)
if dup_keys:
    failures.append(f"settings.json: повторные ключи {dup_keys} — JSON оставит только последний")
matchers = [m["matcher"] for m in settings["hooks"]["PreToolUse"]
            if any("merge-guard" in h.get("command", "") for h in m["hooks"])]
covered = ["Bash", "Monitor", "Edit", "Write", "MultiEdit", "NotebookEdit", "mcp__github__merge_pull_request",
           "mcp__owner-queue__oq_put", "mcp__hub__owner-queue_1mcp_oq_patch", CTX + "ctx_execute", CTX + "ctx_batch_execute",
           CTX + "ctx_execute_file", "mcp__serena__replace_content", "mcp__plugin_serena_serena__create_text_file"]
if len(matchers) != 1:
    failures.append(f"settings.json: ждали одну запись merge-guard в PreToolUse, нашли {len(matchers)}")
else:
    missed = [t for t in covered if not re.fullmatch(matchers[0], t)]
    if missed:
        failures.append(f"settings.json: матчер merge-guard не ловит {missed}")

# --- хук целиком: формат ответа ---
hook = Path(__file__).resolve().parent / "pre-tool-use-merge-guard.py"
out = subprocess.run([sys.executable, "-I", str(hook)], input=json.dumps(
    {"tool_name": "Bash", "tool_input": {"command": "gh pr merge 1"}, "session_id": "no-such", "cwd": "/tmp"}),
    capture_output=True, text=True)
try:
    decision = json.loads(out.stdout)["hookSpecificOutput"]
    assert decision["hookEventName"] == "PreToolUse" and decision["permissionDecision"] == "deny"
except Exception as exc:  # noqa: BLE001
    failures.append(f"хук целиком: ждали deny JSON, получили {out.stdout!r} {out.stderr[-300:]!r} ({exc})")
quiet = subprocess.run([sys.executable, "-I", str(hook)], input=json.dumps(
    {"tool_name": "Bash", "tool_input": {"command": "ls"}, "session_id": "x", "cwd": "/tmp"}), capture_output=True, text=True)
if quiet.stdout or quiet.returncode:
    failures.append(f"хук целиком: обычная команда должна проходить молча, получили {quiet.stdout!r} rc={quiet.returncode}")

finish(" + проверки реестра, списка, matcher и формата")
