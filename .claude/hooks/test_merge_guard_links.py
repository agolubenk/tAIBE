#!/usr/bin/env python3
"""
Проверка merge-guard: второе имя, перенос и удаление защищённого пути или папки над ним (IS-249, линза security на
HR #684). protected_path видит путь, а не файл. Проходили: символьная ссылка на папку законов и запись через неё
(нового имени ещё нет, realpath его не знает), жёсткая ссылка на настройки хуков (другой путь, тот же файл), перенос
папки слоя целиком (законы уехали вместе с ней). Так же файл с защищённым именем в папке-цели (`mv x/<имя> <слой>/`),
удаление папки слоя, копия папки и распаковка поверх неё.

Запуск: python3 -I -B .claude/hooks/test_merge_guard_links.py
Пути собраны из частей (C, SET, RULES, ZE): хук читает этот файл с диска при запуске и иначе откажет на сами строки.
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import D9, HOME, ROOT, TMP, bash, check, finish, repo_on, run  # noqa: E402

C, SET, RULES, ZE = "." + "claude", "settings" + ".json", "ru" + "les", "." + "zsh" + "env"
CL = f"{ROOT}/{C}"
O = TMP / "links"  # чужая папка: не корень и не над ним
(O / "x").mkdir(parents=True)
(O / RULES).mkdir()
(O / "a.txt").write_text("x\n")
(O / "x" / SET).write_text("{}\n")
(ROOT / C / SET).write_text("{}\n")
(ROOT / C / "notes.md").write_text("x\n")
(ROOT / "sub").mkdir()
(HOME.parent / ZE).write_text("")
(O / "src" / C).mkdir(parents=True)  # источник с именем папки слоя
HP = HOME.parent  # домашняя папка песочницы: в ней файлы запуска shell

# --- формы карточки: второе имя и перенос защищённого ---
deny = [
    ("символьная ссылка на rules, запись через неё", f"ln -s {CL}/{RULES} {O}/r && echo x > {O}/r/01-base.md"),
    ("жёсткая ссылка на settings.json", f"ln {CL}/{SET} {O}/h"),
    ("перенос <слой>", f"mv {C} {O}/c2"),
    ("символьная ссылка от cwd", f"ln -s {C}/{RULES} {O}/r2"),
    ("ln без цели", f"cd {O} && ln -s {CL}/{RULES}"),
    # папка над защищённым — тоже второе имя
    ("ссылка на <слой>", f"ln -s {CL} {O}/cl"),
    ("ссылка на корень репозитория", f"ln -s {ROOT} {O}/repo"),
    ("ссылка на /", f"ln -s / {O}/top"),
    ("cp -al", f"cp -al {CL} {O}/copy"),
    ("cp --link", f"cp --link {CL}/{SET} {O}/h2"),
    ("cp -s", f"cp -s {CL}/{SET} {O}/s2"),
    ("link", f"link {CL}/{SET} {O}/h3"),
    ("gln (coreutils)", f"gln -s {CL}/{RULES} {O}/r3"),
    ("gmv (coreutils)", f"gmv {CL} {O}/c3"),
    ("rsync --link-dest", f"rsync -a --link-dest={CL} {O}/x/ {O}/snap/"),
    ("ln -t", f"ln -s -t {O} {CL}/{RULES}"),
    ("mv -t", f"mv -t {O} {CL}"),
    ("mv корня", f"mv {ROOT} {O}/repo2"),
    ("cd и mv", f"cd {ROOT} && mv {C} {O}/c4"),
    ("маска с точкой", f"mv .c* {O}/c5"),
    ("git mv", f"git mv {C} {O}/c6"),
    ("git -C d mv", f"git -C {ROOT} mv {C} {O}/c7"),
    # путь, который разбор не видит
    ("$(…) в ln", f"ln -s \"$(date +%s)\" {O}/r4"),
    ("неизвестная переменная в ln", f"ln -s $IS249_NOPE {O}/r5"),
    ("обратные кавычки в ln", f"ln -s `date` {O}/r6"),
    # символьная ссылка считается от своей папки
    ("относительная ссылка от папки ссылки", f"cd {O}/x && ln -s ../repo/{C}/{RULES} {O}/r7"),  # от {O}: {TMP}/repo
    # домашняя папка: реестр сессий и файлы запуска shell
    ("ссылка на ~/<слой>", f"ln -s {HOME} {O}/hc"),
    ("перенос домашней папки", f"mv {HP} {O}/home2"),
    ("жёсткая ссылка на файл запуска shell", f"ln {HP}/{ZE} {O}/z"),
    # имя в папке-цели
    ("mv settings.json в <слой>/", f"mv {O}/x/{SET} {CL}/"),
    ("cp settings.json в <слой>/", f"cp {O}/x/{SET} {CL}/"),
    ("mv rules в <слой>/", f"mv {O}/{RULES} {CL}/"),
    ("ln -sf rules в <слой>/", f"ln -sf {O}/{RULES} {CL}/"),
    ("cp -t <слой>", f"cp -t {CL} {O}/x/{SET}"),
    # удаление и смена папки (та же причина)
    ("rm -rf <слой>", f"rm -rf {C}"),
    ("grm -rf <слой>", f"grm -rf {C}"),
    ("rm -rf корня", f"rm -rf {ROOT}"),
    ("chmod -R <слой>", f"chmod -R a-w {C}"),
    ("git rm -r <слой>", f"git rm -r -q {C}"),
    # копия папки и распаковка поверх папки с законами
    ("cp -R в <слой>", f"cp -R {O}/x/. {CL}"),
    ("rsync -a в <слой>", f"rsync -a {O}/x/ {CL}/"),
    ("ditto в <слой>", f"ditto {O}/x {CL}"),
    ("tar -x -C <слой>", f"tar -xf {O}/e.tar -C {CL}"),
    ("tar -x в корне", f"cd {ROOT} && tar -xf {O}/e.tar"),
    ("unzip -d корень", f"unzip -o {O}/e.zip -d {ROOT}"),
    ("unzip в корне", f"cd {ROOT} && unzip -o {O}/e.zip"),
    # интерпретатор — как было (MORE_WRITES)
    ("python os.link", f"python3 -c \"import os; os.link('{CL}/{SET}', '{O}/h9')\""),
    # B1 (Контроль, #508): путь, который разбор не видит, у mv и rm/chmod в набранной команде
    ("$(…) в mv", f"mv \"$(printf .cla)ude\" {O}/c8"),
    ("$(…) в rm", f"rm -rf \"$(echo {C})\""),
    ("неизвестная переменная в rm", "rm -rf $IS249_NOPE"),
    ("неизвестная переменная — цель mv", f"mv {O}/x/{SET} \"$IS249_NOPE/\""),
    ("обратные кавычки в chmod", "chmod -R a-w `echo x`"),
    ("$(cat …) в git rm", f"git rm -r \"$(cat {O}/a.txt)\""),
    ("переменная из read", f"read d < {O}/a.txt; rm -rf \"$d\""),
    ("mktemp -u — имя без файла", "D=$(mktemp -d -u); rm -rf \"$D\""),
    ("путь mktemp виден: папка над ним", f"cd {ROOT} && rm -rf \"$(mktemp -d {C}/t.XXXX)/..\""),
    # Б2 (Контроль, c9ab1c1d9): имя из окружения, которое команда меняет сама, — не значение хука
    ("read USER", f"read USER < {O}/a.txt; rm -rf \"$USER\""),
    ("unset TMPDIR", "unset TMPDIR; rm -rf \"${TMPDIR}x\""),
    ("printf -v USER", "printf -v USER x; rm -rf \"$USER\""),
    ("read LOGNAME и mv", f"read LOGNAME < {O}/a.txt; mv \"$LOGNAME\" /tmp/out"),
    ("read HOME", f"read HOME < {O}/a.txt; rm -rf \"$HOME/x\""),
    ("${USER::=x} (zsh)", ": ${USER::=x}; rm -rf \"$USER\""),
    # копия папки поверх: содержимое (`x/.`, `x/`, ditto) или источник с именем защищённой папки (линза frontend)
    ("cp -R папки с именем <слой> в корень", f"cp -R {O}/src/{C} {ROOT}"),
    ("rsync -a содержимого в корень", f"rsync -a {O}/x/ {ROOT}"),
    ("cp -R папки, чьё имя разбор не видит, в корень", f"cp -R \"$IS249_NOPE\" {ROOT}"),
]
for label, cmd in deny:
    bash(f"IS-249, отказ — {label}: {cmd}", cmd, True)
to_control = ("символьная ссылка на rules, запись через неё", "жёсткая ссылка на settings.json", "перенос <слой>",
              "rm -rf <слой>", "mv settings.json в <слой>/")
for label, cmd in [d for d in deny if d[0] in to_control]:  # законы правит только владелец: Контролю тоже отказ
    bash(f"IS-249, отказ Контролю — {label}: {cmd}", cmd, True, who=D9)

# --- обычная работа проходит ---
for label, cmd, cwd in [
    ("ссылка между чужими файлами", f"ln -s {O}/a.txt {O}/b.txt", ROOT),
    ("ссылка на папку", f"ln -sfn {O}/x {O}/cur", ROOT),
    ("ln без цели в чужой папке", f"ln -s {O}/a.txt", O / "x"),
    ("относительная ссылка в репозитории", "ln -s ../shared node_modules", ROOT / "sub"),
    ("rsync --link-dest на чужую папку", f"rsync -a --link-dest={O}/prev {O}/x/ {O}/snap/", ROOT),
    ("переименование", f"mv {O}/a.txt {O}/a2.txt", ROOT),
    ("перенос в папку над корнем", f"mv {O}/a.txt {TMP}/", ROOT),
    ("перенос нового файла из mktemp (sync-agent-skills.sh)", f"mv \"$(mktemp)\" {O}/out.txt", ROOT),
    ("rm папки из mktemp через переменную", "D=$(mktemp -d); rm -rf \"$D\"", ROOT),
    ("mktemp -t и переменная", f"F=$(mktemp -t is249); mv \"$F\" {O}/out2.txt", ROOT),
    ("переменная из той же команды", "tmp=/tmp/is249.x; rm -rf \"$tmp\"", ROOT),
    ("$HOME, $TMPDIR и $$", "rm -rf \"$HOME/is249-x\" \"$TMPDIR/is249-y\" /tmp/is249.$$", ROOT),
    ("цикл по словам", f"for f in a b; do rm -f {O}/$f.orig; done", ROOT),
    ("export TMPDIR — значение из той же команды", "export TMPDIR=/tmp/is249; rm -rf \"$TMPDIR/y\"", ROOT),
    ("незащищённый файл из <слой>", f"mv {CL}/notes.md {O}/", ROOT),
    ("копия чужого файла в <слой>/", f"cp {O}/a.txt {CL}/", ROOT),
    ("копия settings.json наружу", f"cp {CL}/{SET} {O}/bak.json", ROOT),
    ("копия <слой> наружу", f"cp -R {CL} {O}/bak", ROOT),
    ("копия папки в чужую папку", f"cp -R {O}/x {O}/dst", ROOT),
    ("копия папки в корень — новая папка (линза frontend)", f"cp -R {O}/x .", ROOT),
    ("rsync папки в корень — новая папка", f"rsync -a {O}/x {ROOT}/", ROOT),
    ("git mv в репозитории", "git mv src/a.ts src/b.ts", ROOT),
    ("rm чужой папки", f"rm -rf {O}/x", ROOT),
    ("rm worktree-папки", "rm -rf worktrees/fix/x/node_modules", ROOT),
    ("chmod чужого файла", f"chmod +x {O}/a.txt", ROOT),
    ("tar -x в чужую папку", f"tar -xf {O}/e.tar -C {O}/out", ROOT),
    ("tar -c в корне", f"tar -czf {O}/e.tgz {C}", ROOT),
    ("unzip -l в корне", f"unzip -l {O}/e.zip", ROOT),
]:
    bash(f"IS-249, проход — {label}: {cmd}", cmd, False, cwd=cwd)

# --- B1: скрипт, закоммиченный без правки (блоб HEAD своего репозитория, coord 13:10), — прежнее правило; скрипт из
# scratchpad и правленый без коммита — отказ с подсказкой «закоммитьте скрипт или назовите путь словами» ---
G = repo_on("main", "is249-")
for name in ("ok.sh", "edited.sh"):
    (G / name).write_text("rm -rf \"$1\"\n")
(G / "link.sh").write_text("ln -sfn \"$1\" \"$2\"\n")  # как install.sh:32 и agent-comms-link.sh:47 (coord 13:27)
for args in (["add", "ok.sh", "edited.sh", "link.sh"], ["commit", "-q", "-m", "s"]):
    subprocess.run(["git", "-C", str(G), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True)
(G / "edited.sh").write_text("rm -rf \"$1\"  # правка\n")
(O / "scratch.sh").write_text("rm -rf \"$1\"\n")
(O / "link.sh").write_text("ln -sfn \"$1\" \"$2\"\n")
bash("IS-249, проход — скрипт закоммичен без правки: rm -rf \"$1\"", f"bash {G}/ok.sh {O}/x", False)
bash("IS-249, проход — тот же скрипт из своей папки", "bash ./ok.sh /tmp/is249-x", False, cwd=G)
bash("IS-249, проход — закоммиченный скрипт со ссылкой: ln -sfn \"$1\" \"$2\"", f"bash {G}/link.sh {O}/a.txt {O}/l1", False)
for label, path in (("скрипт правлен без коммита", G / "edited.sh"), ("скрипт вне репозитория", O / "scratch.sh"),
                    ("скрипт со ссылкой вне репозитория", O / "link.sh")):
    got = run("Bash", {"command": f"bash {path} {O}/x"})
    check(f"IS-249, отказ с подсказкой — {label}", None if "закоммитьте скрипт" in str(got) else repr(got), False)

# --- маска шире предела — отказ: таймаут хука (10 с) — пропуск; предел — счёт (линза frontend, coord 13:27) ---
import merge_guard_files as mgf  # noqa: E402

(O / "many").mkdir()
for i in range(5):
    (O / "many" / f"f{i}").write_text("")
    for j in range(5):
        (O / "deep" / f"d{i}").mkdir(parents=True, exist_ok=True)
        (O / "deep" / f"d{i}" / f"f{j}").write_text("")
limits = mgf.PATHS_MAX, mgf.SCAN_MAX
for label, cmd, caps in (("путей на слове больше предела", f"rm -f {O}/many/*", (3, 1000)),  # 5 путей
                         ("пустая маска прочла больше предела", f"rm -f {O}/deep/*/zz*", (100, 20))):  # 5 + 25 имён
    mgf.PATHS_MAX, mgf.SCAN_MAX = caps
    got = run("Bash", {"command": cmd})
    check(f"IS-249, отказ — маска: {label}: {cmd}", None if "шире предела" in str(got) else repr(got), False)
mgf.PATHS_MAX, mgf.SCAN_MAX = limits
bash("IS-249, проход — те же маски при пределе по умолчанию", f"rm -f {O}/many/* {O}/deep/*/zz*", False)

finish(", IS-249: ссылки, перенос и удаление папки с законами")
