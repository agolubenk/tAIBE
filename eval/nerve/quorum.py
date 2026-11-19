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
перед словом вердикта: в ней слово «линза»/lens, название линзы (корректность, ресурсы, продукт, инструмент — SE-74:
подписи «корректность: approve на <sha>» tAIBE), «роль N» в пределах team.roles (подпись Т3 «<линза> (роль N)», SE-74:
«boards (роль 6)» не узнавалась) или имя из github.lens_roles, в ней нет слова «автор», и она не
начинается с «Голова», «Ответ», «Итог», «Сводка». Пределы: подпись — текст, автор PR может подписаться линзой; подпись
без слова «линза» засчитывается по подстрокам lens_roles («Проверка CI» — «провер»).
Ключ линзы — роль команды: N-я роль team.roles, если подпись называет «роль N» (нумерация spawn_session.sh), иначе
роль по github.lens_roles, иначе имя линзы. Так «Линза корректности (роль 4)» и «Линза «корректность и отказы» (роль 4)»
— одна линза backend. Предел: подпись без номера и без имени из lens_roles даёт отдельный ключ.
Кворум: на текущую голову не меньше min_lenses разных линз с approve, ни одного changes, CI ok — каждая проверка
SUCCESS, NEUTRAL или SKIPPED — или «CI: none» (ci_state). Висящий, упавший или неизвестный CI кворум не собирает:
линзы собраны, а CI упал — автору pr.ci_failed (SE-86).
Approve автора PR (его базовой роли, со вторыми сессиями) в кворум не идёт: автор себя не проверяет (SE-121). Автора
называет только строка тела PR «роль N — автор» (координатор 15.11). Пути файлов автора для кворума не дают: в tAIBE
`boards/` — роль boards, а код `boards/apps/api` и `apps/web` пишут backend и frontend (замер 15.11: из 169 открытых
PR 17 потеряли бы кворум, 13 — с неверным автором). Пути — только адресат pr.changes (author_role, pr_author).
Тело PR (SE-50): каждая строка вне таблицы разбирается так же, как первая строка комментария. Строка таблицы вердиктов
HR («| Линза | Участник | Голова | Вердикт |», «| Линза | Вердикт |») приводится к «Линза «<имя>»: <слово> на <SHA>» и
идёт в тот же parse_verdict. SHA — «на <SHA>» в ячейке вердикта, иначе ячейка «Голова». accept/approve/OK → approve,
fail/changes/reject → changes; «ждём», «—» и прочее — не вердикт. Код в ``` и цитаты пропускаются. Комментарий линзы
на голову главнее тела: строка тела идёт в счёт, только если у этой линзы нет комментария на эту голову. Время правки
тела не сравнивается — иначе любая правка описания автором после «changes» снимала бы его (блокер Контроля на
af1175836). Предел: линза таблицы — по имени в колонке «Линза» (участник не читается), поэтому та же линза под другим
именем в комментарии — второй ключ, и её строка тела тогда не перекрывается. Approve автора из строки тела не идёт
в кворум по тому же правилу SE-121.
"""
import re

import products

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
# Слово «линза» или название линзы: три базовые (.claude/memory/chunks/process/adversarial-review.md) и «инструмент»
# (роль 6). Без них подпись «ресурсы (роль 4): approve на <sha>» не считалась линзой (SE-74: 28 из 134 вердиктов).
LENS_WORD_RE = re.compile(r"(?<!\w)(?:линз(?:а|е|у|ы|ой)|lens|корректн\w*|ресурс\w*|продукт\w*|инструмент\w*"
                          r"|correctness|resources?|product|tooling)(?!\w)", re.I)
NOT_LENS_RE = re.compile(r"^(?:голова|новая\s+голова|head|new\s+head|ответ\w*|reply|re|итог\w*|сводк\w*|summary)(?!\w)"
                         r"|(?<!\w)(?:автор\w*|author\w*)", re.I)
ROLE_RE = re.compile(r"(?<!\w)(?:(?:роль|роли|role)\s+|^(?:линза|lens)\s+)(\d{1,2})(?!\w)", re.I)
NAMED_RE = re.compile(r"(?:линз\w*|lens)\s*«([^»]{1,60})»|«([^»]{1,60})»\s*(?:линз\w*|lens)", re.I)
AUTHOR_LINE_RE = re.compile(r"(?<!\w)(?:роль|role)\s+(\d{1,2})\s*[—–-]\s*(?:автор|author)(?!\w)", re.I)
RANK = {"changes": 0, "withdrawn": 1, "approve": 2}
MAX_LINE = 500
_MD = " \t*_#>`"


def _lens_key(label, lens_roles, team_roles):
    """Роль по «роль N» или по lens_roles; иначе имя в «…» рядом со словом «линза», иначе начало подписи."""
    role = _team_role(label, team_roles) or role_of_lens(label.lower(), lens_roles)
    if role:
        return role
    q = NAMED_RE.search(label)
    if q:
        return (q.group(1) or q.group(2)).strip(_MD).lower()
    name = re.sub(r"^(?:линза|lens)\s+", "", label, flags=re.I)
    return re.split(r"[(,·]", name, maxsplit=1)[0].strip(_MD + ".").lower() or "?"


def _team_role(label, team_roles):
    r = ROLE_RE.search(label)
    return team_roles[int(r.group(1)) - 1] if r and 1 <= int(r.group(1)) <= len(team_roles) else None


def is_lens_author(label, lens_roles, team_roles=()):
    """Подпись принадлежит линзе: слово «линза»/lens, название линзы, «роль N» команды или имя из lens_roles; не автор
    PR, не ответ и не сводка."""
    if not label or NOT_LENS_RE.search(label):
        return False
    return bool(LENS_WORD_RE.search(label)) or _team_role(label, team_roles) is not None \
        or role_of_lens(label.lower(), lens_roles) is not None


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
    if not is_lens_author(label, lens_roles, team_roles):
        return None
    verdict, sha = min(found, key=lambda f: RANK[f[0]])
    return {"lens": _lens_key(label, lens_roles, team_roles), "verdict": verdict, "sha": sha}


TABLE_WORDS = {"approve": "approve", "approved": "approve", "accept": "approve", "accepted": "approve",
               "ok": "approve", "ок": "approve", "fail": "changes", "failed": "changes", "changes": "changes",
               "reject": "changes", "rejected": "changes"}
_CELL_WORD_RE = re.compile(r"[\s*_`]*([^\W\d_]+)")
_SHA_RE = re.compile(r"(?<![0-9a-z])([0-9a-f]{7,40})(?![0-9a-z])", re.I)
_ON_SHA_RE = re.compile(r"(?<!\w)(?:на|at|on|@)" + _P + r"([0-9a-f]{7,40})(?![0-9a-z])", re.I)
_COLUMNS = (("lens", r"линз|lens"), ("verdict", r"вердикт|verdict"), ("head", r"голов|head|sha|коммит|commit"))


def _columns(cells):
    """Колонки линзы, вердикта и головы по заголовку таблицы; None — таблица не вердиктов."""
    low = [c.strip(_MD).lower() for c in cells]
    cols = {k: next((i for i, c in enumerate(low) if re.match(pat, c)), None) for k, pat in _COLUMNS}
    return cols if cols["lens"] is not None and cols["verdict"] is not None else None


def _row_line(cells, cols):
    """Строка таблицы вердиктов → «Линза «<имя>»: <approve|changes> на <SHA>»; None — в строке нет вердикта."""
    def cell(key):
        i = cols[key]
        return cells[i] if i is not None and i < len(cells) else ""
    word = _CELL_WORD_RE.match(cell("verdict"))
    word = TABLE_WORDS.get(word.group(1).casefold()) if word else None
    sha = _ON_SHA_RE.search(cell("verdict")) or _SHA_RE.search(cell("head"))
    label = cell("lens").strip(_MD + "«»")
    if not ROLE_RE.search(label):  # «ресурсы (−5 запросов)» и «ресурсы» — одна линза; «(роль N)» остаётся ключом
        label = label.split("(", 1)[0].strip(_MD)
    return f"Линза «{label}»: {word} на {sha.group(1)}" if word and sha and label else None


def body_verdicts(body, lens_roles, team_roles=()):
    """Вердикты тела PR по порядку строк (SE-50): строка — parse_verdict, строка таблицы вердиктов — через _row_line."""
    found, cols, table, fence = [], None, False, False
    for raw in (body or "").splitlines():
        s = raw.strip()
        if s.startswith(("```", "~~~")):
            fence, table = not fence, False
            continue
        if fence or s.startswith(">"):
            continue
        if not s.startswith("|"):
            table = False
            v = parse_verdict(s, lens_roles, team_roles)
        elif not table:
            table, cols, v = True, _columns(s.strip("|").split("|")), None
        else:
            line = _row_line([c.strip() for c in s.strip("|").split("|")], cols) if cols else None
            v = parse_verdict(line, lens_roles, team_roles) if line else None
        if v:
            found.append(v)
    return found


def with_body(body_vs, comment_vs, head):
    """Вердикты тела и комментариев для quorum() (SE-50): строки тела линз без комментария на голову, затем комментарии
    в их порядке. Комментарий линзы на голову перекрывает её строки тела, какое бы ни было время правки тела."""
    said = {v["lens"] for v in comment_vs if on_head(v["sha"], head)}
    return [v for v in body_vs if v["lens"] not in said] + list(comment_vs)


def on_head(sha, head):
    return bool(sha) and bool(head) and head.lower().startswith(sha.lower())


CI_OK = ("SUCCESS", "NEUTRAL", "SKIPPED")
CI_FAILED = ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE")


def ci_state(checks):
    """checks — выводы и статусы проверок (CheckConclusionState, CheckStatusState, StatusState GitHub). none — маркер
    NONE от gh_source: у головы нет проверок дольше NO_CHECKS_AFTER. failure — есть провал из CI_FAILED (он побеждает,
    даже если другие ещё идут; повтор job на той же голове gh_source замечает сам); ok — каждая проверка в CI_OK;
    иначе pending: идёт, ждёт, REQUESTED, COMPLETED без вывода, неизвестное значение. Пустой список — тоже pending: сразу после push GitHub какое-то время не отдаёт ни
    одной проверки, и кворум ушёл бы Контролю раньше CI (SE-126). Список разрешённых — новое значение GitHub не даст ни
    ложного кворума, ни ложного pr.ci_failed (SE-86)."""
    states = [str(c or "").upper() for c in checks]
    if states == ["NONE"]:
        return "none"   # маркер gh_source: у головы нет проверок дольше NO_CHECKS_AFTER — CI у PR нет
    if any(s in CI_FAILED for s in states):
        return "failure"
    return "ok" if states and all(s in CI_OK for s in states) else "pending"


def last_on_head(verdicts, head):
    """{линза: последний вердикт на голову}: поздний вердикт линзы перекрывает её прежние."""
    last = {}
    for v in verdicts:
        if v and on_head(v["sha"], head):
            last[v["lens"]] = v["verdict"]
    return last


def quorum(verdicts, head, checks, min_lenses=3, author=None):
    """verdicts — разобранные вердикты по порядку. Последний вердикт линзы на голову перекрывает её прежние.
    Возвращает (собран ли, одобрившие линзы, линзы с changes, состояние CI).
    Линза — роль: approve второй сессии (backend-2) и основной (backend) — одна линза, геном и пусковой файл у них
    общие. changes — по точному ключу: newhead и changes_by адресуют ту сессию, что просила правку.
    author — роль из строки тела «роль N — автор» (body_author): её approve не считается (SE-121).
    Собран — только при CI ok или none: упавший CI кворум не собирает (SE-86), ждущий — тоже."""
    approved, changes = tally(last_on_head(verdicts, head), author)
    ci = ci_state(checks)
    return (len(approved) >= min_lenses and not changes and ci in ("ok", "none")), approved, changes, ci


def tally(last, author=None):
    """{линза: последний вердикт на голову} → (одобрившие линзы по базовой роли, линзы с changes по точному ключу).
    Approve базовой роли автора выпадает (SE-121); changes автора остаётся. Один подсчёт для Нерва и
    eval/tools/release_status.py."""
    own = products.base_role(author) if author else None
    approved = sorted({products.base_role(k) for k, x in last.items() if x == "approve"} - {own})
    changes = sorted(k for k, x in last.items() if x == "changes")
    return approved, changes


def author_approved(last, author):
    """Автор одобрил свой PR на этой голове — approve не засчитан: Нерв и release_status называют его (SE-121)."""
    own = products.base_role(author) if author else None
    return bool(own) and any(x == "approve" and products.base_role(k) == own for k, x in last.items())


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


def body_author(body, team_roles):
    """Роль из строки тела PR «роль N — автор» (N — номер в team.roles), иначе None. Цитата «>» не в счёт."""
    for line in (body or "").splitlines():
        if line.lstrip().startswith(">"):
            continue
        m = AUTHOR_LINE_RE.search(line)
        if m and 1 <= int(m.group(1)) <= len(team_roles):
            return team_roles[int(m.group(1)) - 1]
    return None


def pr_author(body, files, path_roles, team_roles, default="coord"):
    """Адресат pr.changes: строка тела «роль N — автор», иначе большинство путей. Для кворума — только строка
    (body_author): путь на сквозном PR ошибается."""
    return body_author(body, team_roles) or author_role(files, path_roles, default)


def author_roles(author, team_roles):
    """Адресаты pr.changes: роль автора и её вторые сессии из team.roles (backend → backend, backend-2). Автор по
    путям файлов — всегда базовая роль, а PR могла открыть вторая сессия; чужой PR каждая сессия пропускает сама.
    Строка тела «роль 7 — автор» называет саму сессию: changes идёт только ей (backend-2 → backend-2)."""
    return [author] + [r for r in team_roles if r != author and products.base_role(r) == author]
