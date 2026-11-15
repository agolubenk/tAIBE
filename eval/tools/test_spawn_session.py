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
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "spawn_session.sh"


def dry_run(env_extra):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("продолжай по handoff\n", encoding="utf-8")
        env = {**os.environ, **env_extra, "TMPDIR": tmp}
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
    env = {**os.environ, "TMPDIR": tmp, "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "sess"),
           "TAIBE_LINEAGE_DIR": os.path.join(tmp, "lin"), "NERVE_PLIST": os.path.join(tmp, "none.plist")}
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
    for f in ("spawn_session.sh", "team_status.py", "lineage.py"):
        (tools / f).write_bytes((SCRIPT.parent / f).read_bytes())
    (tools.parent / "pipeline").mkdir()
    (tools.parent / "pipeline" / "genome").symlink_to(SCRIPT.parent.parent / "pipeline" / "genome")
    env = {**os.environ, "TMPDIR": tmp, "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "sess"),
           "TAIBE_LINEAGE_DIR": os.path.join(tmp, "lin"), "NERVE_PLIST": os.path.join(tmp, "none.plist")}
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
                             capture_output=True, text=True, env={**os.environ, "TMPDIR": tmp}, timeout=30)
        return run.returncode, run.stdout.splitlines()


for name, flags in [("print", ["--terminal", "print"]), ("keep-window", ["--keep-window"])]:
    rc, out = launcher_lines(*flags)
    ok = rc == 0 and any(ln.startswith("exec ") for ln in out) and not any("autoclose" in ln for ln in out)
    if not ok:
        failed += 1
        print("FAIL: %s keeps exec and no autoclose" % name)
        print("\n".join(out))

# OPS-25: продукт — --product, иначе TAIBE_PRODUCT из env (наследник берёт продукт предшественника), иначе по умолчанию.
def product_run(env_extra, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        env = {**os.environ, "TMPDIR": tmp, **env_extra}
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

# Вторая сессия роли (решения владельца 14.11): ключ backend-2 и роль 7, а геном и пусковой файл — базовой роли.
def second_run(product, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        env = {**os.environ, "TMPDIR": tmp, "TAIBE_PRODUCT": "", "TAIBE_LINEAGE": "r.ab12",
               "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "sess"), "TAIBE_LINEAGE_DIR": os.path.join(tmp, "lin"),
               "NERVE_PLIST": os.path.join(tmp, "none.plist")}
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
for bad in ("backend-3", "boards-2"):
    rc, out = second_run("taibe", "--launch", "--role", bad)
    if rc == 0 or f"неизвестная роль: {bad}" not in out:
        failed += 1
        print("FAIL: unknown second session refused:", bad)
        print(out)
rc, out = second_run("taibe", "--launch", "--roles", "all")
if rc != 0 or "backend-2" in out or "boards — команда напечатана" not in out:
    failed += 1
    print("FAIL: --roles all opens the six base roles only")
    print(out)

# TB-131: строка запуска сразу за меткой линии; хэш генома — от файла --settings, хэш промпта — от сообщения без строки.
LAUNCH_RE = re.compile(r" Запуск: parent=(\S+) genome=([0-9a-f]{12}|-) prompt=([0-9a-f]{12}) wake=(\w+)\.")


def sha12(data):
    return hashlib.sha256(data).hexdigest()[:12]


def launch_run(*flags, lineage="r.ab12"):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        env = {**os.environ, "TMPDIR": tmp, "TAIBE_PRODUCT": "", "TAIBE_LINEAGE": lineage,
               "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "sess"), "TAIBE_LINEAGE_DIR": os.path.join(tmp, "lin"),
               "NERVE_PLIST": os.path.join(tmp, "none.plist")}
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
        tmpl = (msg1.replace(m1.group(0), "", 1).replace(line, "Линия: - (поколение 0)", 1)
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

print("spawn_session: %d failed" % failed)
sys.exit(1 if failed else 0)
