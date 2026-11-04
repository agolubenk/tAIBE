"""
`git` для merge-guard (pre-tool-use-merge-guard.py): уйдёт ли команда в защищённую ветку мимо PR — main/master,
основную ветку remote (у tAIBE — board-agents) или ветку из `protected` в .claude/merge-guard.json.

Учитывает `-C`, `-c` (push.default, remote.*.push, remote.*.mirror, alias.*), явные refspec с `+`, `:`, `HEAD`,
масками, голый `git push` по push.default/upstream/remote.*.push/mirror, `send-pack` и псевдонимы git — свои и
заводимые `git config alias.*`. На все вызовы git у одного решения — общий бюджет времени: исчерпан — GitTimeout,
и хук решает по грубому признаку (push — отказ).
"""
import os
import re
import shlex
import subprocess
import time

import merge_guard_identity as identity
from merge_guard_shell import CURRENT, SUBST, is_lost

MAIN_WRITE = "запись в защищённую ветку (main, основная ветка remote) мимо PR"
PROTECTED_BRANCHES = {"main", "master"}
# Встроенные подкоманды: для них псевдоним не ищем (git сам не даёт псевдониму перекрыть встроенную).
GIT_BUILTINS = set("""add am apply archive bisect blame branch bundle cat-file check-ignore checkout cherry cherry-pick
clean clone commit config count-objects describe diff diff-tree difftool fetch for-each-ref format-patch fsck gc grep
hash-object help init log ls-files ls-remote ls-tree maintenance merge merge-base mv notes prune pull push range-diff
read-tree rebase reflog remote repack replace reset restore rev-list rev-parse revert rm shortlog show show-ref
sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit version
whatchanged worktree write-tree""".split())
PUSHERS = {"push", "send-pack", "http-push"}
PUSH_ONLY = {"--force", "--force-with-lease", "--force-if-includes", "-u", "--set-upstream", "--tags", "--follow-tags",
             "--atomic", "--prune", "--delete"}  # догадка `$G $S --force`: флаг, которого у других команд почти нет
TRUE = ("true", "1", "yes", "on")
_deadline = [0.0]
_seen = {}  # ответы git одного решения: тот же вопрос из сценария `pnpm dev` и из догадки — один процесс


class GitTimeout(Exception):
    pass


def start_budget(seconds=6.0):
    """Общий бюджет на вызовы git одного решения: хук упирается в timeout 10 с, а это пропуск, не отказ."""
    _deadline[0] = time.monotonic() + seconds
    _seen.clear()


def git_out(gdir, *args):
    key = (os.path.normpath(gdir), args)
    if key not in _seen:
        _seen[key] = _git_run(gdir, *args)
    return _seen[key]


def _git_run(gdir, *args):
    left = _deadline[0] - time.monotonic() if _deadline[0] else 3.0
    if left <= 0:
        raise GitTimeout()
    try:
        r = subprocess.run(["git", "-C", gdir, *args], capture_output=True, text=True, timeout=min(3.0, left))
    except subprocess.TimeoutExpired as exc:
        raise GitTimeout() from exc
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def conf_get(gdir, conf, key):
    """Значение ключа: последнее `-c key=…` из команды, иначе из git config."""
    for c in reversed(conf):
        k, _, v = c.partition("=")
        if k.lower() == key.lower():
            return v
    return git_out(gdir, "config", key)


def protected_branches(gdir):
    """Защищённые ветки репозитория в gdir: main/master, основная ветка каждого remote (`refs/remotes/<r>/HEAD`;
    с M1 у продукта своя, у tAIBE — board-agents) и `protected` из .claude/merge-guard(.local).json основной папки.
    Один вызов git на решение (кэш git_out); бюджет исчерпан — GitTimeout, как у остальных вызовов."""
    key = ("protected", os.path.normpath(gdir))
    if key not in _seen:
        out = set(PROTECTED_BRANCHES) | identity.load_protected()
        for line in git_out(gdir, "for-each-ref", "--format=%(refname) %(symref)", "refs/remotes/*/HEAD").splitlines():
            ref, _, target = line.partition(" ")
            prefix = ref.removesuffix("HEAD")
            if target.startswith(prefix) and len(target) > len(prefix):
                out.add(target[len(prefix):])
        _seen[key] = out
    return _seen[key]


def is_protected(branch, gdir):
    """Ветка защищена. Не успели спросить git (GitTimeout) — да: так же грубо, как push при исчерпанном бюджете."""
    try:
        return branch.removeprefix("refs/heads/") in protected_branches(gdir)
    except GitTimeout:
        return True


def mentions_protected(text, gdir):
    """В тексте (GraphQL, код python/node) есть имя защищённой ветки словом. GitTimeout — да."""
    try:
        names = protected_branches(gdir)
    except GitTimeout:
        return True
    return bool(re.search(r"\b(" + "|".join(sorted(map(re.escape, names))) + r")\b", text))


def hits_main(refspec, gdir):
    """Цель refspec — защищённая ветка (protected_branches). Пустая цель (`:`) — matching, маска — может задеть
    main: тоже да. Цель из `$(…)` или неизвестной переменной не видна — тоже да. `$(git branch --show-current)` и
    подобные classify_git заранее заменяет на HEAD (push в папке shell) или на SUBST (`-C` в другую папку)."""
    dst = refspec.lstrip("+").split(":", 1)[-1]
    if SUBST in dst or "$" in dst:
        return True
    if dst in ("HEAD", "@"):
        dst = git_out(gdir, "symbolic-ref", "--short", "-q", "HEAD")
        if not dst:
            return True  # ветку не видно (detached HEAD, нет папки) — как защищённую
    short = dst.removeprefix("refs/").removeprefix("heads/")  # git сам дописывает refs/ и heads/ (DWIM)
    return not dst or "*" in dst or short in protected_branches(gdir)


def remote_config(gdir):
    """remote.*.push, .mirror и .url одним вызовом git: голому push — первые два, догадке — имена remote."""
    return git_out(gdir, "config", "--get-regexp", r"^remote\..*\.(push|mirror|url)$").splitlines()


def remote_names(gdir):
    return {k[len("remote."):k.rfind(".")] for k, _, _ in (ln.partition(" ") for ln in remote_config(gdir))
            if k.lower().endswith(".url")}


def implicit_push(gdir, conf):
    """Голый `git push`: True — может уйти в main (или не понять куда). remote.*.mirror — зеркало всех веток."""
    pairs = [(k.lower(), v or "true") for k, _, v in (c.partition("=") for c in conf)]
    pairs += [(k.lower(), v) for k, _, v in (ln.partition(" ") for ln in remote_config(gdir))]
    if any(k.startswith("remote.") and k.endswith(".mirror") and v.strip().lower() in TRUE for k, v in pairs):
        return True
    pushes = [v for k, v in pairs if k.startswith("remote.") and k.endswith(".push") and v]
    if pushes:
        return any(hits_main(r, gdir) for r in pushes)
    branch = git_out(gdir, "symbolic-ref", "--short", "-q", "HEAD")
    if not branch:
        return True
    mode = conf_get(gdir, conf, "push.default") or "simple"
    if mode == "nothing":
        return False
    if mode == "matching":
        return True
    if mode in ("upstream", "tracking"):
        branch = conf_get(gdir, conf, f"branch.{branch}.merge").removeprefix("refs/heads/")
    return not branch or branch in protected_branches(gdir)


CONFIG_VALUE_OPTS = {"-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--worktree-file"}
# Ключи, через которые git push или псевдоним меняют смысл; значение из окружения или чужого файла не проверить.
RISKY_KEY = re.compile(r"alias\.|include\.|includeif\.|remote\..+\.(push|mirror)$|push\.default$|branch\..+\.merge$",
                       re.I)


def config_bypass(args, gdir="."):
    """`git config` пишет заготовку обхода: псевдоним-скрипт или с push, include, remote.*.push в защищённую ветку."""
    pos, i = [], 0
    while i < len(args):
        if args[i] in CONFIG_VALUE_OPTS:
            i += 2
            continue
        if not args[i].startswith("-"):
            pos.append(args[i])
        i += 1
    if pos[:1] == ["set"]:
        pos = pos[1:]
    if len(pos) < 2 or pos[0] in ("get", "list", "unset", "edit", "rename-section", "remove-section"):
        return None
    key, value = pos[0].lower(), " ".join(pos[1:])
    if key.startswith("alias.") and (value.lstrip().startswith("!") or "push" in value):
        return MAIN_WRITE
    if key.startswith(("include.", "includeif.")):
        return MAIN_WRITE
    if re.fullmatch(r"remote\..+\.push", key) and any(hits_main(v, gdir) for v in pos[1:]):
        return MAIN_WRITE
    if re.fullmatch(r"remote\..+\.mirror", key) and value.strip().lower() in TRUE:
        return MAIN_WRITE
    return None


def classify_git(a, cwd, depth=0, env_config=False, guess=False):
    """env_config — конфиг git задан окружением (GIT_CONFIG_*, GIT_DIR, HOME…): его не проверить, push и псевдонимы —
    отказ. То же при `--git-dir`: конфиг другого репозитория. Скобки shell (`HEAD:{main,x}`) раскрыты до вызова."""
    i, gdir, conf, opaque = 1, cwd, [], env_config
    while i < len(a) and a[i].startswith("-"):
        if a[i] == "-C" and i + 1 < len(a):
            gdir = os.path.join(gdir, os.path.expanduser(a[i + 1]))
            i += 2
        elif a[i] == "-c" and i + 1 < len(a):
            conf.append(a[i + 1])
            i += 2
        elif a[i] == "--config-env" or a[i].startswith("--config-env="):
            key = (a[i + 1] if a[i] == "--config-env" and i + 1 < len(a) else a[i].split("=", 1)[-1]).split("=", 1)[0]
            opaque = opaque or bool(RISKY_KEY.match(key))
            i += 2 if a[i] == "--config-env" else 1
        elif a[i] == "--git-dir" or a[i].startswith("--git-dir="):
            opaque = True
            i += 2 if a[i] == "--git-dir" else 1
        elif a[i] in ("--work-tree", "--namespace"):
            i += 2
        else:
            i += 1
    if any(re.match(r"(alias|include|includeif)\.", c, re.I) for c in conf) or is_lost(gdir):
        opaque = True  # папку не видно — не видно и её конфига, ветки и псевдонимов
    if i >= len(a):
        return None
    here = os.path.normpath(gdir) == os.path.normpath(cwd)  # ветку из $(…) shell берёт в своей папке, а не в -C
    sub, rest = a[i], [r.replace(CURRENT, "HEAD" if here else SUBST) for r in a[i + 1:]]
    if sub == "config":
        return config_bypass(rest, gdir)
    if opaque and (sub in PUSHERS or sub not in GIT_BUILTINS):
        return MAIN_WRITE
    if SUBST in sub or "$" in sub:  # `git $X …`: подкоманда не видна, в $X может быть `push origin HEAD:main`
        if not guess:
            return MAIN_WRITE
        pos = [r for r in rest if not r.startswith("-")]  # `"$PY" "$1"`: и git — лишь догадка
        if any(f in ("--all", "--mirror", "--branches") for f in rest) or any(SUBST in r or "$" in r for r in pos[1:]):
            return MAIN_WRITE  # `$G $S --all`, `$(echo git) $(echo push) origin $(echo HEAD:main)`: цель не видна
        lit = [r for r in pos if SUBST not in r and "$" not in r]
        if any(hits_main(r, gdir) for r in lit):
            return MAIN_WRITE
        # Без цели: `$G $S origin`, `$G $S --force` уйдут туда же, куда голый push, — если есть флаг, который бывает
        # только у push, или слово — имя remote. `"$G" "$S"` без них — остаток, `"$PY" "$1"` — проход.
        bare = len(pos) <= 1 and (guess == "blind" or PUSH_ONLY & {f.split("=", 1)[0] for f in rest if f.startswith("-")} or
                                  lit[:1] and lit[0] in remote_names(gdir))
        return MAIN_WRITE if bare and implicit_push(gdir, conf) else None
    if sub not in PUSHERS:
        if sub in GIT_BUILTINS or not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*", sub):
            return None  # имя псевдонима — буквы, цифры и `-`: `git код` git сам отклонит
        alias = git_out(gdir, "config", "--get", f"alias.{sub}")
        if not alias:
            return None  # нет такой команды — git сам откажет
        if alias.lstrip().startswith("!") or depth > 2:
            return MAIN_WRITE  # псевдоним-скрипт или цепочка псевдонимов — не разбираем, отказ
        conf_args = [x for c in conf for x in ("-c", c)]  # `git -c push.default=matching p`: -c действует и на псевдоним
        return classify_git(["git"] + conf_args + shlex.split(alias) + rest, gdir, depth + 1)
    flags, pos, j = [], [], 0
    while j < len(rest):
        t = rest[j]
        if t in ("-o", "--push-option", "--repo", "--receive-pack", "--exec"):
            j += 2
            continue
        (flags if t.startswith("-") else pos).append(t)
        j += 1
    if any(f in ("--all", "--mirror", "--branches") for f in flags):
        return MAIN_WRITE
    refspecs = pos[1:]
    if not refspecs:
        if any(f in ("-d", "--delete") for f in flags):
            return None
        return MAIN_WRITE if implicit_push(gdir, conf) else None
    return MAIN_WRITE if any(hits_main(r, gdir) for r in refspecs) else None
