#!/usr/bin/env python3
"""spawn_session.sh: a successor starts as a top-level session — inherited child-session markers are dropped
before `claude` runs, so its transcript is saved (hooks, eval measurements and claude-mem read it); every
descendant gets its own lineage id under its parent's.

Run: python3 -I eval/tools/test_spawn_session.py   (exit 1 on mismatch; --dry-run only, nothing is launched)
"""
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "spawn_session.sh"
sys.path.insert(0, str(SCRIPT.parent))
from test_lineage import clean_env  # noqa: E402  # без TAIBE_PRODUCT/TAIBE_LINEAGE живой сессии (SE-130)


def dry_run(env_extra):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("продолжай по handoff\n", encoding="utf-8")
        env = clean_env(**{**env_extra, "TMPDIR": tmp})
        return subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--dry-run", "--cwd", tmp],
                              capture_output=True, text=True, env=env, timeout=30)


failed = 0
# CLAUDE_BIN reaches the launcher (a Terminal window starts with a clean environment); unset -> no export line.
for env_extra, want in [({"CLAUDE_BIN": "/opt/x y/claude-nongene"}, "export CLAUDE_BIN='/opt/x y/claude-nongene'"),
                        ({"CLAUDE_BIN": ""}, None)]:
    got = [ln for ln in dry_run(env_extra).stdout.splitlines() if ln.startswith("export CLAUDE_BIN=")]
    if got != ([want] if want else []):
        failed += 1
        print("FAIL: CLAUDE_BIN in launcher", env_extra, "->", got)
proc = dry_run({"CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDECODE": "1", "TAIBE_LINEAGE": "r.ab12"})
lines = proc.stdout.splitlines()
unset_at = next((i for i, ln in enumerate(lines) if ln.startswith("unset ") and "CLAUDE_CODE_CHILD_SESSION" in ln), None)
# Terminal: claude без exec (окно закроется само после выхода), иначе exec; в обоих случаях — после unset.
exec_at = next((i for i, ln in enumerate(lines) if ln.startswith(("exec ", '"${CLAUDE_BIN:-claude}"'))), None)
for name, ok in [
    ("dry-run succeeds", proc.returncode == 0),
    ("launcher unsets CLAUDE_CODE_CHILD_SESSION and CLAUDECODE",
     unset_at is not None and "CLAUDECODE" in lines[unset_at]),
    ("unset comes before claude starts", unset_at is not None and exec_at is not None and unset_at < exec_at),
    ("Terminal: claude in its own group, window closes only after exit 0",
     "set -m" in lines and any(ln.startswith('[ "$rc" = 0 ] ||') for ln in lines)
     and any(" autoclose --tty " in ln for ln in lines) and lines[-1:] != [] and "exit 0" in lines),
    ("descendant gets its own lineage under the parent's",
     any(re.fullmatch(r"export TAIBE_LINEAGE='r\.ab12\.[a-z0-9]{4}'", ln) for ln in lines)),
    ("first message names the lineage and generation 2", re.search(r"Линия: r\.ab12\.[a-z0-9]{4} \(поколение 2\)", proc.stdout)
     is not None),
]:
    if not ok:
        failed += 1
        print("FAIL:", name)
        print(proc.stdout, proc.stderr, sep="\n")

# OPS-24: --launch в пустом каталоге сессий открывает роли по порядку и печатает итог; --status — «нет» у каждой роли.
with tempfile.TemporaryDirectory() as tmp:
    env = clean_env(TMPDIR=tmp, CLAUDE_SESSIONS_DIR=os.path.join(tmp, "sess"),
                    TAIBE_LINEAGE_DIR=os.path.join(tmp, "lin"), NERVE_PLIST=os.path.join(tmp, "none.plist"))
    launch = subprocess.run(["bash", str(SCRIPT), "--launch", "--roles", "plan,coord", "--dry-run", "--cwd", tmp],
                            capture_output=True, text=True, env=env, timeout=60)
    status = subprocess.run(["bash", str(SCRIPT), "--status", "--cwd", tmp], capture_output=True, text=True, env=env,
                            timeout=60)
out = launch.stdout
for name, ok in [
    ("launch dry-run succeeds", launch.returncode == 0),
    ("nerve is checked before roles", out.find("нерв:") != -1 and out.find("нерв:") < out.find("# plan: вставить")),
    ("roles open in the given order", -1 < out.find("# plan: вставить") < out.find("# coord: вставить")),
    ("summary lists every role", "итог (" in out and "plan — команда напечатана" in out
     and "coord — команда напечатана" in out),
    ("status: every role of ORDER, none alive", status.returncode == 0
     and all(f"{n} {r:<9} нет" in status.stdout for n, r in
             [(1, "coord"), (5, "release"), (4, "backend"), (3, "frontend"), (2, "plan"), (6, "boards")])),
]:
    if not ok:
        failed += 1
        print("FAIL:", name)
        print(launch.stdout, launch.stderr, status.stdout, status.stderr, sep="\n")

# OPS-24, линза 7b: проверка живой роли сломалась (копия без lineage_reap.py → трейсбек импорта, rc 1) — роль НЕ
# открывается: вторая сессия живой роли хуже пропуска. Открывает только явный ответ «роли нет».
with tempfile.TemporaryDirectory() as tmp:
    tools = Path(tmp) / "layer" / "tools"
    tools.mkdir(parents=True)
    for f in ("spawn_session.sh", "team_status.py", "lineage.py", "launch_line.py"):
        (tools / f).write_bytes((SCRIPT.parent / f).read_bytes())
    (tools.parent / "pipeline").mkdir()
    (tools.parent / "pipeline" / "genome").symlink_to(SCRIPT.parent.parent / "pipeline" / "genome")
    env = clean_env(TMPDIR=tmp, CLAUDE_SESSIONS_DIR=os.path.join(tmp, "sess"),
                    TAIBE_LINEAGE_DIR=os.path.join(tmp, "lin"), NERVE_PLIST=os.path.join(tmp, "none.plist"))
    prompts = str(SCRIPT.parent.parent / "prompts" / "launch-3010" / "roles")
    broken = subprocess.run(["bash", str(tools / "spawn_session.sh"), "--launch", "--role", "coord", "--dry-run",
                             "--prompt-dir", prompts, "--cwd", tmp], capture_output=True, text=True, env=env, timeout=60)
    typo = subprocess.run(["bash", str(SCRIPT), "--launch", "--roles", "plan,cord", "--dry-run", "--cwd", tmp],
                          capture_output=True, text=True, env=env, timeout=60)
for name, ok in [
    ("broken check: role not opened", broken.returncode == 0 and "# coord: вставить" not in broken.stdout),
    ("broken check: summary says not opened", "coord — НЕ открыта: проверка не прошла" in broken.stdout),
    ("role list checked before anything opens", typo.returncode != 0 and "# plan: вставить" not in typo.stdout
     and "неизвестная роль: cord" in typo.stderr),
]:
    if not ok:
        failed += 1
        print("FAIL:", name)
        print(broken.stdout, broken.stderr, typo.stdout, typo.stderr, sep="\n")

# 06.11: окно Terminal закрывается само; печать команды (--terminal print) и --keep-window — прежний exec без autoclose.
def launcher_lines(*flags):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        run = subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--dry-run", "--cwd", tmp, *flags],
                             capture_output=True, text=True, env=clean_env(TMPDIR=tmp), timeout=30)
        return run.returncode, run.stdout.splitlines()


for name, flags in [("print", ["--terminal", "print"]), ("keep-window", ["--keep-window"])]:
    rc, out = launcher_lines(*flags)
    ok = rc == 0 and any(ln.startswith("exec ") for ln in out) and not any("autoclose" in ln for ln in out)
    if not ok:
        failed += 1
        print("FAIL: %s keeps exec and no autoclose" % name)
        print("\n".join(out))

# d-team-surplus-1711: роль сверх доли владельца (team_plan.py keep — код 3) наследника не открывает, код 5, событие
# координатору продукта; в доле (0) и при сбое проверки (любой другой код) — наследник как раньше.
def surplus_run(keep_rc):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        fake = Path(tmp) / "team_plan_fake.py"
        fake.write_text("import sys\nprint('hr-helper 8 · taibe 4')\nsys.exit(%d)\n" % keep_rc, encoding="utf-8")
        nerve = Path(tmp) / "nerve_fake.py"
        log = Path(tmp) / "nerve.log"
        nerve.write_text("import sys\nopen(%r, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n" % str(log), encoding="utf-8")
        env = clean_env(TMPDIR=tmp, TAIBE_PRODUCT="taibe", SPAWN_SURPLUS_CHECK="on", SPAWN_TEAM_PLAN=str(fake),
                        SPAWN_NERVE=str(nerve))
        run = subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--role", "boards", "--dry-run",
                              "--cwd", tmp], capture_output=True, text=True, env=env, timeout=30)
        return run.returncode, run.stdout + run.stderr, log.read_text(encoding="utf-8") if log.exists() else ""


for name, keep_rc, want_rc, marker in [
    ("surplus role: no successor, exit 5", 3, 5, "is surplus over the owner split (hr-helper 8 · taibe 4"),
    ("role in the split: successor as before", 0, 0, "/genome/taibe/boards.json"),
    ("keep check fails: successor as before", 1, 0, "/genome/taibe/boards.json"),
]:
    rc, out, _ = surplus_run(keep_rc)
    if rc != want_rc or marker not in out:
        failed += 1
        print("FAIL:", name, rc)
        print(out)

# OPS-25: продукт — --product, иначе TAIBE_PRODUCT из env (наследник берёт продукт предшественника), иначе по умолчанию.
def product_run(env_extra, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        env = clean_env(**{"TMPDIR": tmp, **env_extra})
        run = subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--role", "boards", "--dry-run",
                              "--cwd", tmp, *flags], capture_output=True, text=True, env=env, timeout=30)
        return run.returncode, run.stdout + run.stderr


for name, env_extra, flags, genome, product in [
    ("successor of a tAIBE role gets the tAIBE genome", {"TAIBE_PRODUCT": "taibe"}, [], "/genome/taibe/boards.json", "taibe"),
    ("--product equal to the inherited product", {"TAIBE_PRODUCT": "taibe"}, ["--product", "taibe"],
     "/genome/taibe/boards.json", "taibe"),
    ("no product — the default product", {"TAIBE_PRODUCT": ""}, [], "/genome/boards.json", "hr-helper"),
]:
    rc, out = product_run(env_extra, *flags)
    ok = rc == 0 and genome in out and f"export TAIBE_PRODUCT='{product}'" in out
    if not ok:
        failed += 1
        print("FAIL:", name)
        print(out)
# Наследник другого продукта через --handoff снял бы живую роль чужого продукта: отказ с подсказкой --launch.
rc, out = product_run({"TAIBE_PRODUCT": ""}, "--product", "taibe")
if rc == 0 or "--launch --product taibe" not in out:
    failed += 1
    print("FAIL: --handoff into another product is refused")
    print(out)
rc, out = product_run({}, "--product", "nope")
if rc == 0 or "нет продукта nope" not in out:
    failed += 1
    print("FAIL: unknown product is refused")
    print(out)

# SE-93: окно открыто, только если пусковой скрипт стартовал — он удаляет свою папку. Terminal вернул -1712, окна не
# было, а скрипт писал «открыто», записывал линию и запускал сторожа retire без наследника. Подмены в копии слоя:
# osascript (FAKE_RC — код, FAKE_START=1 — «окно открылось»: папка скрипта удаляется), lineage.py и team_status.py
# пишут в журнал свой подкоманду — настоящий нерв и launchd не трогаются.
FAKE_OSA = r"""#!/bin/bash
echo osascript >>"$FAKE_LOG"
l="$(printf '%s' "$*" | sed -n "s|.*/bin/bash '\([^']*\)'.*|\1|p")"
if [ "${FAKE_START:-0}" = 1 ] && [ -n "$l" ]; then rm -rf "$(dirname "$l")"; fi
if [ "${FAKE_RC:-0}" = 0 ]; then echo "123 /dev/ttys009"; exit 0; fi
echo "execution error: Terminal got an error: AppleEvent timed out. (-1712)" >&2
exit "$FAKE_RC"
"""
FAKE_PY = """import os, sys
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write((" ".join(sys.argv[1:]) if sys.argv[1] == "seat" else sys.argv[1]) + "\\n")
if sys.argv[1] == "wait":
    sys.exit(int(os.environ.get("FAKE_WAIT", "1")))
print("нерв: подмена")
"""


def osa_run(terminal, rc, start, launch=False, roles="plan,coord", wait="1", product=False):
    with tempfile.TemporaryDirectory() as tmp:
        tools = Path(tmp) / "layer" / "tools"
        tools.mkdir(parents=True)
        (tools / "spawn_session.sh").write_bytes(SCRIPT.read_bytes())
        (tools / "launch_line.py").write_bytes((SCRIPT.parent / "launch_line.py").read_bytes())
        for f in ("lineage.py", "team_status.py"):
            (tools / f).write_text(FAKE_PY, encoding="utf-8")
        (tools.parent / "pipeline").mkdir()
        (tools.parent / "pipeline" / "genome").symlink_to(SCRIPT.parent.parent / "pipeline" / "genome")
        if product:  # продукт по умолчанию из настоящих instances/ (SE-155: seat зовётся с --product)
            (tools.parent / "nerve").mkdir()
            (tools.parent / "nerve" / "products.py").symlink_to(SCRIPT.parent.parent / "nerve" / "products.py")
            (Path(tmp) / "instances").symlink_to(SCRIPT.parent.parent.parent / "instances")
        fake_bin = Path(tmp) / "bin"
        fake_bin.mkdir()
        (fake_bin / "osascript").write_text(FAKE_OSA, encoding="utf-8")
        (fake_bin / "osascript").chmod(0o755)
        handoff = Path(tmp) / "h.md"
        handoff.write_text("x\n", encoding="utf-8")
        log = Path(tmp) / "fake.log"
        env = clean_env(PATH=f"{fake_bin}:{os.environ['PATH']}", TMPDIR=tmp, TAIBE_LINEAGE="r.ab12", FAKE_RC=str(rc),
                        FAKE_START="1" if start else "0", FAKE_LOG=str(log), SPAWN_START_WAIT="1", FAKE_WAIT=wait)
        if launch:
            args = ["--launch", "--roles", roles, "--force", "--prompt-dir",
                    str(SCRIPT.parent.parent / "prompts" / "launch-3010" / "roles")]
        else:
            args = ["--handoff", str(handoff)]
        run = subprocess.run(["bash", str(tools / "spawn_session.sh"), *args, "--terminal", terminal, "--cwd", tmp],
                             capture_output=True, text=True, env=env, timeout=60)
        calls = log.read_text(encoding="utf-8").split() if log.exists() else []
        return run.returncode, run.stdout + run.stderr, calls, list(Path(tmp).glob("claude-spawn.*"))


for terminal in ("terminal", "iterm"):
    rc, out, calls, left = osa_run(terminal, 1, start=False)
    for name, ok in [
        (f"{terminal}: osascript error -> code 4", rc == 4),
        (f"{terminal}: no «открыто», hint --terminal print", "открыто:" not in out and "--terminal print" in out),
        (f"{terminal}: no lineage record, no retire guard", "record" not in calls and "retire" not in calls),
        (f"{terminal}: launcher folder removed — a late window starts nothing", left == []),
    ]:
        if not ok:
            failed += 1
            print("FAIL:", name, rc, calls, left)
            print(out)
    rc, out, calls, _ = osa_run(terminal, 0, start=True)
    if not (rc == 0 and "открыто:" in out and calls.count("record") == 1 and "retire" in calls):
        failed += 1
        print(f"FAIL: {terminal}: window opened -> record, «открыто», retire", rc, calls)
        print(out)
rc, out, calls, _ = osa_run("terminal", 1, start=True)  # -1712 пришёл, но окно всё же открылось
if not (rc == 0 and "открыто:" in out and "record" in calls and "retire" in calls and "код 1, но пусковой" in out):
    failed += 1
    print("FAIL: osascript error but the launcher started -> opened with a warning", rc, calls)
    print(out)
rc, out, calls, _ = osa_run("terminal", 0, start=False)  # osascript без ошибки, а скрипт не стартовал
if not (rc == 4 and "открыто:" not in out and "record" not in calls and "retire" not in calls):
    failed += 1
    print("FAIL: osascript ok but the launcher never started -> code 4", rc, calls)
    print(out)
rc, out, calls, _ = osa_run("terminal", 1, start=False, launch=True)
if not (rc == 4 and calls.count("osascript") == 1 and "plan — НЕ открыта: окно не открылось" in out
        and "дальше не открывал: окно plan не открылось" in out and "coord —" not in out and "wait" not in calls):
    failed += 1
    print("FAIL: --launch stops after the first window that did not open", rc, calls)
    print(out)
# SE-155: release поднялся — lineage.py seat с продуктом, линией, tty окна и папками списка (решает и отказывает он
# сам); другая роль — без seat; без instances/ продукт не известен — seat не зовётся, итог говорит почему.
rc, out, calls, _ = osa_run("terminal", 0, start=True, launch=True, roles="release", wait="0", product=True)
seat = " ".join(calls[calls.index("seat"):]) if "seat" in calls else ""
if not (rc == 0 and calls.count("seat") == 1 and "--product hr-helper" in seat and "--succ-tty /dev/ttys009" in seat
        and "--line r.ab12." in seat and seat.count("--guard") == 2 and "release — нерв: подмена" in out):
    failed += 1
    print("FAIL: release up -> lineage.py seat with product, line, tty and guard folders", rc, calls)
    print(out)
rc, out, calls, _ = osa_run("terminal", 0, start=True, launch=True, roles="coord", wait="0", product=True)
if not (rc == 0 and "coord — поднята" in out and "seat" not in calls):
    failed += 1
    print("FAIL: coord up -> no seat", rc, calls)
    print(out)
rc, out, calls, _ = osa_run("terminal", 0, start=True, launch=True, roles="release", wait="0")
if not (rc == 0 and "seat" not in calls and "release — Контроль: продукт не известен" in out):
    failed += 1
    print("FAIL: release up without instances/ -> no seat, reason in the summary", rc, calls)
    print(out)

# Вторая сессия роли (решения владельца 14.11): ключ backend-2 и роль 7, а геном и пусковой файл — базовой роли.
def second_run(product, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        env = clean_env(TMPDIR=tmp, TAIBE_LINEAGE="r.ab12", CLAUDE_SESSIONS_DIR=os.path.join(tmp, "sess"),
                        TAIBE_LINEAGE_DIR=os.path.join(tmp, "lin"), NERVE_PLIST=os.path.join(tmp, "none.plist"))
        flags = [str(handoff) if a == "HANDOFF" else a for a in flags]
        run = subprocess.run(["bash", str(SCRIPT), *flags, "--product", product, "--dry-run", "--cwd", tmp],
                             capture_output=True, text=True, env=env, timeout=60)
        return run.returncode, run.stdout + run.stderr


for name, product, flags, want in [
    ("tAIBE backend-2: own key, base genome and launch file", "taibe", ["--launch", "--role", "backend-2"],
     ["ключ реестра backend-2, роль 7. Пусковой файл: ", "/prompts/taibe/roles/4-backend.md",
      "/genome/taibe/backend.json", "вторая сессия роли backend (роль 4)", "тап Нерва", "source пунктов очереди", "«(роль 7)»",
      "backend-2 — команда напечатана"]),
    ("HR frontend-2: base genome and launch file of frontend", "hr-helper", ["--launch", "--role", "frontend-2"],
     ["ключ реестра frontend-2, роль 8.", "/prompts/launch-3010/roles/3-frontend.md", "/genome/frontend.json",
      "вторая сессия роли frontend (роль 3)"]),
    ("successor of backend-2 keeps the key and the alias note", "hr-helper",
     ["--handoff", "HANDOFF", "--role", "backend-2", "--no-retire"],
     ["ключ реестра backend-2, роль 7, наследник", "/genome/backend.json", "вторая сессия роли backend"]),
    ("base role has no alias note", "taibe", ["--launch", "--role", "backend"],
     ["ключ реестра backend, роль 4. Пусковой файл: ", "/prompts/taibe/roles/4-backend.md"]),
]:
    rc, out = second_run(product, *flags)
    missing = [w for w in want if w not in out]
    if rc != 0 or missing or (flags[-1] == "backend" and "вторая сессия" in out):
        failed += 1
        print("FAIL:", name, rc, missing)
        print(out)
for bad in ("backend-4", "boards-2"):
    rc, out = second_run("taibe", "--launch", "--role", bad)
    if rc == 0 or f"неизвестная роль: {bad}" not in out:
        failed += 1
        print("FAIL: unknown second session refused:", bad)
        print(out)
rc, out = second_run("taibe", "--launch", "--roles", "all")
# Вторая сессия — строка итога «backend-2 —» или имя «…-backend-2-<хвост>»; подстрока «backend-2» ловила и хвост линии
# базовой роли («taibe-backend-2wvk»: CI #457, прогон 44140212836).
if rc != 0 or re.search(r"^\s+backend-2 —|-backend-2-", out, re.M) or "boards — команда напечатана" not in out:
    failed += 1
    print("FAIL: --roles all opens the six base roles only")
    print(out)

# TB-131: строка запуска сразу за меткой линии; хэш генома — от файла --settings, хэш промпта — от сообщения без строки.
LAUNCH_RE = re.compile(r" Запуск: parent=(\S+) genome=([0-9a-f]{12}|-) prompt=([0-9a-f]{12}) wake=(\w+)\.")
NAME_RE = re.compile(r" Твоё имя в списке сессий и в заголовке окна — (\S+)\.")


def sha12(data):
    return hashlib.sha256(data).hexdigest()[:12]


def launch_run(*flags, lineage="r.ab12"):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        env = clean_env(**{"TMPDIR": tmp, "TAIBE_PRODUCT": "", "TAIBE_LINEAGE": lineage,
                           "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "sess"),
                           "TAIBE_LINEAGE_DIR": os.path.join(tmp, "lin"),
                           "NERVE_PLIST": os.path.join(tmp, "none.plist")})
        flags = [str(handoff) if a == "HANDOFF" else a for a in flags]
        run = subprocess.run(["bash", str(SCRIPT), *flags, "--dry-run", "--cwd", tmp],
                             capture_output=True, text=True, env=env, timeout=60)
    msg = next((ln for ln in run.stdout.splitlines() if "Линия: " in ln), "")
    genome = re.search(r"--settings '([^']+)'", run.stdout)
    return run.returncode, msg, genome.group(1) if genome else None, run.stdout + run.stderr


# Корень «r» — не сессия: у поколения 1 (r.xxxx) parent «-».
for name, flags, wake, has_genome, lineage, parent in [
    ("launch: wake human by default", ["--launch", "--role", "backend", "--product", "taibe"], "human", True,
     "r.ab12", "r.ab12"),
    ("launch --wake timer", ["--launch", "--role", "backend", "--product", "taibe", "--wake", "timer"], "timer", True,
     "r.ab12", "r.ab12"),
    ("handoff with a role: wake peer by default", ["--handoff", "HANDOFF", "--role", "boards", "--no-retire"], "peer",
     True, "r.ab12", "r.ab12"),
    ("handoff without a role: no genome", ["--handoff", "HANDOFF", "--no-retire"], "peer", False, "r.ab12", "r.ab12"),
    ("generation 1: no parent session", ["--launch", "--role", "backend", "--product", "taibe"], "human", True, "r", "-"),
]:
    rc, msg, genome, out = launch_run(*flags, lineage=lineage)
    m = LAUNCH_RE.search(msg)
    problems = []
    if rc != 0 or not m:
        problems.append("no launch line")
    else:
        if "в очереди." + m.group(0) not in msg:
            problems.append("launch line is not right after the lineage tag")
        if m.group(1) != parent:
            problems.append("parent %s, want %s" % (m.group(1), parent))
        want_genome = sha12(Path(genome).read_bytes()) if (has_genome and genome) else "-"
        if m.group(2) != want_genome:
            problems.append("genome %s, want %s" % (m.group(2), want_genome))
        if m.group(4) != wake:
            problems.append("wake " + m.group(4))
        if len(m.group(0)) > 120:
            problems.append("launch line longer than 120 chars")
    if problems:
        failed += 1
        print("FAIL:", name, problems)
        print(out)
for bad in (["--wake", "cron"], ["--wake"]):
    rc, msg, _, out = launch_run("--launch", "--role", "backend", "--product", "taibe", *bad)
    if rc == 0 or "--wake: human, peer или timer" not in out:
        failed += 1
        print("FAIL: --wake refused:", bad)
        print(out)

# prompt — версия входа, а не сессии (линзы release и plan #381): sha12(пусковой файл + "\n" + шаблон сообщения, где
# линия «-», поколение 0, пути — <file> и <tools>). Одна роль и файл — один prompt; правка файла — другой.
with tempfile.TemporaryDirectory() as pdir:
    launch_file = Path(pdir) / "4-backend.md"

    def prompt_of(lineage, role="backend"):
        rc, msg, _, out = launch_run("--launch", "--role", role, "--product", "taibe", "--prompt-dir", pdir,
                                     lineage=lineage)
        m = LAUNCH_RE.search(msg)
        return (m.group(3) if rc == 0 and m else None), msg, m, out

    launch_file.write_text("пусковой файл v1\n", encoding="utf-8")
    p1, msg1, m1, out1 = prompt_of("r.ab12")
    p2, _, _, _ = prompt_of("r.cd34")
    p_alias, _, _, _ = prompt_of("r.ab12", role="backend-2")
    launch_file.write_text("пусковой файл v2\n", encoding="utf-8")
    p3, _, _, _ = prompt_of("r.ab12")
    want = None
    if m1:
        line = re.search(r"Линия: (r\.ab12\.[a-z0-9]{4}) \(поколение 2\)", msg1).group(0)
        named = NAME_RE.search(msg1)
        # имя сессии (#407) несёт хвост линии: в шаблоне оно — <name>, иначе у каждой сессии свой prompt
        tmpl = (msg1.replace(m1.group(0), "", 1).replace(line, "Линия: - (поколение 0)", 1)
                .replace(named.group(0) if named else "\0", " Твоё имя в списке сессий и в заголовке окна — <name>.", 1)
                .replace(str(launch_file), "<file>").replace(str(SCRIPT.parent), "<tools>"))
        want = sha12("пусковой файл v1\n".encode("utf-8") + b"\n" + tmpl.encode("utf-8"))
    for name, ok in [
        ("prompt: two sessions of one role and file share it", p1 is not None and p1 == p2),
        ("prompt: an edit of the launch file changes it", p1 is not None and p3 is not None and p1 != p3),
        ("prompt: the alias note of backend-2 changes it", p_alias is not None and p_alias != p1),
        ("prompt = sha12(file + \\n + template)", want is not None and p1 == want),
    ]:
        if not ok:
            failed += 1
            print("FAIL:", name, p1, p2, p3, p_alias, want)
            print(out1)

# 15.11: имя сессии (claude --name) — продукт, роль, хвост линии; в заголовке окна, строке ввода и ListAgents.
def name_run(handoff_dir, env_extra, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / handoff_dir
        folder.mkdir(parents=True)
        handoff = folder / "HANDOFF.md"
        handoff.write_text("x\n", encoding="utf-8")
        env = clean_env(**{"TMPDIR": tmp, "TAIBE_LINEAGE": "r.ab12", **env_extra})
        run = subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--dry-run", "--cwd", tmp, *flags],
                             capture_output=True, text=True, env=env, timeout=30)
        return run.returncode, run.stdout + run.stderr


TAIL = r"[a-z0-9]{4}"
for name, handoff_dir, env_extra, flags, want in [
    ("role successor: product, role and lineage tail", "2026-11-15/boards", {"TAIBE_PRODUCT": ""}, ["--role", "boards"],
     rf"--name 'hr-helper-boards-{TAIL}'"),
    ("tAIBE successor keeps its product in the name", "2026-11-15", {"TAIBE_PRODUCT": "taibe"}, ["--role", "coord"],
     rf"--name 'taibe-coord-{TAIL}'"),
    ("second session: own key in the name", "x", {"TAIBE_PRODUCT": ""}, ["--role", "backend-2", "--no-retire"],
     rf"--name 'hr-helper-backend-2-{TAIL}'"),
    ("no role: topic from the handoff folder", "handoff/2026-11-15/queue-lane", {"TAIBE_PRODUCT": "taibe"}, [],
     rf"--name 'taibe-queue-lane-{TAIL}'"),
    ("no role, date folder: session", "handoff/2026-11-15", {"TAIBE_PRODUCT": "taibe"}, [],
     rf"--name 'taibe-session-{TAIL}'"),
    ("exec launcher (--keep-window) passes the name too", "2026-11-15/boards", {"TAIBE_PRODUCT": ""},
     ["--role", "boards", "--keep-window"], rf"exec \"\$\{{CLAUDE_BIN:-claude\}}\" --settings '[^']+/genome/boards\.json' --name 'hr-helper-boards-{TAIL}' \"\$m\""),
]:
    rc, out = name_run(handoff_dir, env_extra, *flags)
    got = re.search(want, out)
    # имя в первом сообщении то же, что в --name: наследник называет себя, не гадая по ListAgents
    said = got and re.search(r"Твоё имя в списке сессий и в заголовке окна — %s\." % re.escape(
        re.search(r"--name '([^']+)'", got.group(0)).group(1)), out)
    if rc != 0 or not got or not said:
        failed += 1
        print("FAIL:", name, rc, bool(got), bool(said))
        print(out)

# OPS-82: окно tmux. Пусковой скрипт без autoclose — панель закрывается сама; код ≠ 0, Enter и --keep-window оставляют
# оболочку. Без --terminal и SPAWN_TERMINAL — system.terminal из instances/_shared.json.
def tmux_launcher(env_extra, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        run = subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--dry-run", "--cwd", tmp, *flags],
                             capture_output=True, text=True, env=clean_env(TMPDIR=tmp, **env_extra), timeout=30)
        return run.returncode, run.stdout.splitlines()


for name, env_extra, flags, last in [
    ("tmux: exit 0 closes the pane", {}, ["--terminal", "tmux"], "exit 0"),
    ("tmux --keep-window: shell stays", {}, ["--terminal", "tmux", "--keep-window"],
     'keep "claude вышел — окно оставлено (--keep-window)"'),
    ("default terminal is system.terminal (tmux)", {"SPAWN_TERMINAL": ""}, [], "exit 0"),
]:
    rc, out = tmux_launcher(env_extra, *flags)
    body = out[out.index("set -m"):] if "set -m" in out else []
    body = body[:-1] if body and body[-1].startswith("Наследник") else body  # dry-run печатает и первое сообщение
    ok = (rc == 0 and body[-1:] == [last] and any(ln.startswith("keep() {") for ln in body)
          and any(ln.startswith('[ "$rc" = 0 ] || keep ') for ln in body)
          and not any("autoclose" in ln or ln.startswith("exec ") for ln in out))
    if not ok:
        failed += 1
        print("FAIL:", name)
        print("\n".join(out))

# Открытие окна tmux: подмены tmux_host.py (open — «стартует» пусковой скрипт), lineage.py и team_status.py в копии слоя.
FAKE_HOST = r"""import os, shutil, sys
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write("host-" + sys.argv[1] + "\n")
if sys.argv[1] == "ensure":
    sys.exit(int(os.environ.get("FAKE_ENSURE", "0")))
if sys.argv[1] == "default-terminal":
    print("tmux")
if sys.argv[1] == "open":
    if os.environ.get("FAKE_OPEN_RC"):
        sys.exit(int(os.environ["FAKE_OPEN_RC"]))
    shutil.rmtree(os.path.dirname(sys.argv[sys.argv.index("--launcher") + 1]), ignore_errors=True)
    print("@3 %7 /dev/ttys021 4242 100:200")
    if os.environ.get("FAKE_ATTACH"):
        print("tmux -L agents attach -t '=x'")
"""
FAKE_ARGV = """import os, sys
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
"""


def tmux_run(ensure_rc=0, attach=False, open_rc=""):
    with tempfile.TemporaryDirectory() as tmp:
        tools = Path(tmp) / "layer" / "tools"
        tools.mkdir(parents=True)
        (tools / "spawn_session.sh").write_bytes(SCRIPT.read_bytes())
        (tools / "launch_line.py").write_bytes((SCRIPT.parent / "launch_line.py").read_bytes())
        for f, text in (("tmux_host.py", FAKE_HOST), ("lineage.py", FAKE_ARGV), ("team_status.py", FAKE_PY)):
            (tools / f).write_text(text, encoding="utf-8")
        fake_bin = Path(tmp) / "bin"
        fake_bin.mkdir()
        (fake_bin / "osascript").write_text(FAKE_OSA, encoding="utf-8")
        (fake_bin / "osascript").chmod(0o755)
        handoff = Path(tmp) / "h.md"
        handoff.write_text("x\n", encoding="utf-8")
        log = Path(tmp) / "fake.log"
        env = clean_env(PATH=f"{fake_bin}:{os.environ['PATH']}", TMPDIR=tmp, TAIBE_LINEAGE="r.ab12", FAKE_LOG=str(log),
                        FAKE_RC="0", FAKE_START="1", SPAWN_TERMINAL="",
                        FAKE_ENSURE=str(ensure_rc), FAKE_ATTACH="1" if attach else "", FAKE_OPEN_RC=open_rc,
                        SPAWN_START_WAIT="30")  # отказ open — сразу, а не через 30 с ожидания скрипта
        run = subprocess.run(["bash", str(tools / "spawn_session.sh"), "--handoff", str(handoff), "--cwd", tmp],
                             capture_output=True, text=True, env=env, timeout=60)
        calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
        return run.returncode, run.stdout + run.stderr, calls


rc, out, calls = tmux_run()
record = next((c for c in calls if c.startswith("record ")), "")
retire = next((c for c in calls if c.startswith("retire ")), "")
for name, ok in [
    ("tmux: window opened", rc == 0 and "host-open" in calls and "открыто:" in out),
    ("tmux: record has pane, launcher pid and server",
     "--terminal tmux --window-id @3 --tty /dev/ttys021" in record
     and "--pane %7 --pane-pid 4242 --server 100:200" in record),
    ("tmux: retire guard gets the pane tty", "--succ-tty /dev/ttys021" in retire),
    ("tmux: owner attached — no Terminal window", "osascript" not in calls),
]:
    if not ok:
        failed += 1
        print("FAIL:", name, rc, calls)
        print(out)
rc, out, calls = tmux_run(attach=True)
if not (rc == 0 and calls.count("osascript") == 1):
    failed += 1
    print("FAIL: tmux: nobody attached — one Terminal window with attach", rc, calls)
    print(out)
rc, out, calls = tmux_run(ensure_rc=1)
if not (rc == 0 and "host-open" not in calls and "osascript" in calls
        and any(c.startswith("record ") and "--terminal terminal" in c for c in calls)
        and "сервер tmux не отвечает" in out):
    failed += 1
    print("FAIL: tmux server down -> Terminal window as before", rc, calls)
    print(out)
t0 = time.monotonic()
rc, out, calls = tmux_run(open_rc="1")
if not (rc == 4 and time.monotonic() - t0 < 20 and not any(c.startswith(("record ", "retire ")) for c in calls)
        and "--terminal terminal" in out):
    failed += 1
    print("FAIL: tmux open failed -> code 4 at once, no record, hint --terminal terminal", rc, calls)
    print(out)

print("spawn_session: %d failed" % failed)
sys.exit(1 if failed else 0)
