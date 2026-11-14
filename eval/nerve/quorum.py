# -*- coding: utf-8 -*-
"""Вердикты линз и кворум PR (П7). Чистые функции — без сети.

Вердикт — первая непустая строка комментария вне цитаты «>» (первые 500 знаков):
  «<подпись линзы><разделитель> <слово вердикта> [на|at|on|@|голова] <SHA>»,
  например «**Линза «корректность и отказы» (роль 4) — ACCEPT на 1d66762204**», «**Бэкенд: approve на 46b9f87e1.**».
Слово стоит в начале строки или после разделителя (: — – · | , → или « - »). approve, changes, ACCEPT,
«ACCEPT с условиями», REJECT (Т3), «approve with changes», reject (eval/prompts/lens-*.md), APPROVED и CHANGES_REQUESTED
(.claude/agents/code-reviewer.md) дают approve или changes. Условия не записываются: в модели вердикта нет поля.
SHA — токен сразу за словом (между ними — «с условиями», «перенесён», «на голове», скобки, разметка). Слово без SHA за
ним и SHA в другом месте строки — не вердикт (TB-84, HR #478). «… на <sha> отменяю/отозван» — отзыв (withdrawn: линза
выпадает из кворума), «… на <sha> закрыты/учтены» — не вердикт. Несколько вердиктов в строке: changes важнее отзыва,
отзыв важнее approve.
Автор: все сессии Т3 пишут в GitHub под одним аккаунтом владельца, логин линзу не отличает. Поэтому автор — подпись
перед словом вердикта: в ней слово «линза»/lens или имя из github.lens_roles, в ней нет слова «автор», и она не
начинается с «Голова», «Ответ», «Итог», «Сводка». Пределы: подпись — текст, автор PR может подписаться линзой; подпись
без слова «линза» засчитывается по подстрокам lens_roles («Проверка CI» — «провер»).
Ключ линзы — роль команды: N-я роль team.roles, если подпись называет «роль N» (нумерация spawn_session.sh), иначе
роль по github.lens_roles, иначе имя линзы. Так «Линза корректности (роль 4)» и «Линза «корректность и отказы» (роль 4)»
— одна линза backend. Предел: подпись без номера и без имени из lens_roles даёт отдельный ключ.
Кворум: на текущую голову не меньше min_lenses разных линз с approve, ни одного changes, CI ok — каждая проверка
SUCCESS, NEUTRAL или SKIPPED, или проверок нет (ci_state). Висящий, упавший или неизвестный CI кворум не собирает (SE-86).
"""
import re

_G = r"[\s*_`]*"  # пробелы и разметка между словами
_P = r"[\s*_`(\[,@]*"  # то же, плюс скобки, запятая и @ между словом вердикта и SHA
VERDICT_RE = re.compile(
    r"(?:^|[:—–·|,→]|\s-\s)" + _G + r"(?:(?:мой|my|вердикт|verdict)" + _G + r")?"
    r"(approved?|accept(?:ed)?|changes[\s_]requested|request(?:ed)?[\s_]changes|changes|reject(?:ed)?)(?!\w)"
    r"(?:" + _P + r"(?:с\s+условиями|с\s+условием|с\s+оговорками|с\s+оговоркой|with\s+conditions?|with\s+changes"
    r"|перенес[её]н|переносится|переношу|оста[её]тся|сохраняется|holds|stays|на|по|at|on|голов[еау]|head|коммит\w*"
    r"|commit)(?!\w)){0,4}"
    + _P + r"([0-9a-f]{7,40})(?!\w)", re.I)
AFTER_RE = re.compile(r"[\s*_`.,)\]]*(?:(отмен\w*|отозв\w*|отзыв\w*|снима\w*|снят\w*|withdr\w*|revok\w*|retract\w*)"
                      r"|(закрыт\w*|учт[её]н\w*|исправлен\w*|resolved|addressed|fixed))", re.I)
LENS_WORD_RE = re.compile(r"(?<!\w)(?:линз(?:а|е|у|ы|ой)|lens)(?!\w)", re.I)
NOT_LENS_RE = re.compile(r"^(?:голова|новая\s+голова|head|new\s+head|ответ\w*|reply|re|итог\w*|сводк\w*|summary)(?!\w)"
                         r"|(?<!\w)(?:автор\w*|author\w*)", re.I)
ROLE_RE = re.compile(r"(?<!\w)(?:(?:роль|роли|role)\s+|^(?:линза|lens)\s+)(\d{1,2})(?!\w)", re.I)
NAMED_RE = re.compile(r"(?:линз\w*|lens)\s*«([^»]{1,60})»|«([^»]{1,60})»\s*(?:линз\w*|lens)", re.I)
RANK = {"changes": 0, "withdrawn": 1, "approve": 2}
MAX_LINE = 500
_MD = " \t*_#>`"


def _lens_key(label, lens_roles, team_roles):
    """Роль по «роль N» или по lens_roles; иначе имя в «…» рядом со словом «линза», иначе начало подписи."""
    r = ROLE_RE.search(label)
    if r and 1 <= int(r.group(1)) <= len(team_roles):
        return team_roles[int(r.group(1)) - 1]
    role = role_of_lens(label.lower(), lens_roles)
    if role:
        return role
    q = NAMED_RE.search(label)
    if q:
        return (q.group(1) or q.group(2)).strip(_MD).lower()
    name = re.sub(r"^(?:линза|lens)\s+", "", label, flags=re.I)
    return re.split(r"[(,·]", name, maxsplit=1)[0].strip(_MD + ".").lower() or "?"


def is_lens_author(label, lens_roles):
    """Подпись принадлежит линзе: слово «линза»/lens или имя из lens_roles; не автор PR, не ответ и не сводка."""
    if not label or NOT_LENS_RE.search(label):
        return False
    return bool(LENS_WORD_RE.search(label)) or role_of_lens(label.lower(), lens_roles) is not None


def _first_line(body):
    for line in (body or "").splitlines():
        s = line.strip()
        if s and not s.startswith(">"):
            return s[:MAX_LINE]
    return ""


def parse_verdict(body, lens_roles, team_roles=()):
    """Возвращает {"lens", "verdict", "sha"} или None. lens_roles — github.lens_roles, team_roles — team.roles.
    verdict — approve, changes или withdrawn (линза отозвала свой вердикт на этот SHA)."""
    first = _first_line(body)
    found, start = [], None
    for m in VERDICT_RE.finditer(first):
        start = m.start() if start is None else start
        after = AFTER_RE.match(first, m.end())
        if after and after.group(2):
            continue
        word = m.group(1).casefold()
        verdict = "withdrawn" if after else ("approve" if word[0] == "a" else "changes")
        found.append((verdict, m.group(2).lower()))
    if not found:
        return None
    label = first[:start].strip(_MD)
    if not is_lens_author(label, lens_roles):
        return None
    verdict, sha = min(found, key=lambda f: RANK[f[0]])
    return {"lens": _lens_key(label, lens_roles, team_roles), "verdict": verdict, "sha": sha}


def on_head(sha, head):
    return bool(sha) and bool(head) and head.lower().startswith(sha.lower())


CI_OK = ("SUCCESS", "NEUTRAL", "SKIPPED")
CI_FAILED = ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE")


def ci_state(checks):
    """checks — выводы и статусы проверок (CheckConclusionState, CheckStatusState, StatusState GitHub). failure — есть
    провал из CI_FAILED (он окончателен, даже если другие ещё идут); ok — каждая проверка в CI_OK или проверок нет;
    иначе pending: идёт, ждёт, REQUESTED, COMPLETED без вывода, пусто, неизвестное значение. Список разрешённых — новое
    значение GitHub не даст ни ложного кворума, ни ложного pr.ci_failed (SE-86)."""
    states = [str(c or "").upper() for c in checks]
    if any(s in CI_FAILED for s in states):
        return "failure"
    return "ok" if all(s in CI_OK for s in states) else "pending"


def quorum(verdicts, head, checks, min_lenses=3):
    """verdicts — разобранные вердикты по порядку. Последний вердикт линзы на голову перекрывает её прежние.
    Возвращает (собран ли, одобрившие линзы, линзы с changes, состояние CI). Собран — только при CI ok: проваленный
    CI кворум не собирает (SE-86); PR без проверок — ok, как и раньше (ci_state)."""
    last = {}
    for v in verdicts:
        if v and on_head(v["sha"], head):
            last[v["lens"]] = v["verdict"]
    approved = sorted(k for k, x in last.items() if x == "approve")
    changes = sorted(k for k, x in last.items() if x == "changes")
    ci = ci_state(checks)
    return (len(approved) >= min_lenses and not changes and ci == "ok"), approved, changes, ci


def pr_event(n, head, approved, changes, ci, min_lenses, quorum_to, author):
    """Событие PR после разбора вердиктов: ((ключ, вид, кому, текст) или None, ждёт ли PR только CI). Линз мало или
    есть changes — ничего. Линзы собраны: CI ok — pr.quorum в quorum_to; CI упал — pr.ci_failed автору, кворума нет
    (SE-86); CI идёт — await_ci, PR опрашивается заново. Ключ — один на голову: журнал событие не повторяет."""
    if len(approved) < min_lenses or changes or ci == "pending":
        return None, len(approved) >= min_lenses and not changes
    lenses, short = ", ".join(approved), head[:9]
    if ci == "ok":
        return (f"gh:quorum:{n}:{head}", "pr.quorum", quorum_to,
                f"#{n} собран: approve {lenses} на {short}, CI ok"), False
    return (f"gh:cifail:{n}:{head}", "pr.ci_failed", [author],
            f"#{n}: линзы собраны ({lenses}), CI упал на {short}"), False


def role_of_lens(lens, lens_roles, team_roles=()):
    """Роль линзы: ключ, который уже роль из team_roles, иначе первое совпадение в lens_roles."""
    if lens in team_roles:
        return lens
    for pat, role in lens_roles:
        if pat in lens:
            return role
    return None


def author_role(files, path_roles, default="coord"):
    """Роль автора — по большинству изменённых файлов PR."""
    votes = {}
    for f in files:
        for prefix, role in path_roles:
            if f.startswith(prefix):
                votes[role] = votes.get(role, 0) + 1
                break
    if not votes:
        return default
    return max(sorted(votes), key=lambda r: votes[r])
