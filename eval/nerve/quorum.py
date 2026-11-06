# -*- coding: utf-8 -*-
"""Вердикты линз и кворум PR (П7). Чистые функции — без сети.

Вердикт — первая непустая строка комментария: «<линза><разделитель> <слово вердикта> [на|at|on|@] <SHA>».
  «**Линза «корректность и отказы» (роль 4) — ACCEPT на 1d66762204**», «**Бэкенд: approve на 46b9f87e1.**».
Слово вердикта стоит в начале строки или сразу после разделителя (: — – · | или « - »). Слова: approve и changes
(прежний формат), ACCEPT, «ACCEPT с условиями», REJECT (Т3), «approve with changes» и reject (шаблоны линз
eval/prompts/lens-*.md). ACCEPT с условиями и без — approve, REJECT — changes. Условия не записываются: в модели
вердикта и кворума для них нет поля.
SHA — токен сразу за словом вердикта (между ними — «с условиями», «перенесён», «на голове» и разметка). SHA до
слова вердикта или в другом месте строки не берётся: такая строка — не вердикт (TB-84, HR #478).
Автор: все сессии Т3 пишут в GitHub под одним аккаунтом владельца, логин линзу не отличает. Поэтому автор — подпись
перед словом вердикта: в ней слово «линза»/lens или имя линзы из github.lens_roles, и она не начинается с «Автор» или
«Голова» (так пишет автор PR). Предел: подпись — текст, автор PR может подписаться линзой.
Кворум: на текущую голову не меньше min_lenses разных линз с approve, ни одного changes, проверки CI не висят.
"""
import re

VERDICTS = {"approve": "approve", "accept": "approve", "changes": "changes", "reject": "changes"}
_G = r"[\s*_`]*"  # пробелы и разметка между словами
VERDICT_RE = re.compile(
    r"(?:^|[:—–·|]|\s-\s)" + _G + r"(approve|accept|changes|reject)\b"
    r"(?:\s+(?:с\s+условиями|с\s+условием|with\s+conditions?|with\s+changes)\b)?"
    r"(?:" + _G + r"(?:перенес[её]н|переносится|переношу|оста[её]тся|сохраняется|holds|stays)\b)?"
    r"(?:" + _G + r"(?:на|at|on)\b|" + _G + r"@)?"
    r"(?:" + _G + r"(?:голов[еау]|head)\b)?"
    + _G + r"([0-9a-f]{7,40})\b", re.I)
LENS_WORD_RE = re.compile(r"\b(?:линз|lens)", re.I)
NOT_LENS_RE = re.compile(r"^(?:автор|author|голова|новая\s+голова|head|new\s+head)\b", re.I)
QUOTED_RE = re.compile(r"«([^»]{1,60})»")
_MD = " \t*_#>`"


def _lens_name(label):
    """Имя линзы — ключ кворума: текст в «…», иначе подпись без «Линза» до скобки или запятой."""
    q = QUOTED_RE.search(label)
    if q:
        return q.group(1).strip(_MD).lower()
    name = re.sub(r"^(?:линза|lens)\s+", "", label, flags=re.I)
    return re.split(r"[(,·]", name, maxsplit=1)[0].strip(_MD + ".").lower() or "?"


def is_lens_author(label, lens_roles):
    """Подпись принадлежит линзе: слово «линза»/lens или имя из lens_roles; не «Автор …» и не «Голова …»."""
    if not label or NOT_LENS_RE.match(label):
        return False
    return bool(LENS_WORD_RE.search(label)) or role_of_lens(label.lower(), lens_roles) is not None


def parse_verdict(body, lens_roles):
    """Возвращает {"lens", "verdict", "sha"} или None. lens_roles — config.json → github.lens_roles."""
    first = ""
    for line in (body or "").splitlines():
        if line.strip():
            first = line.strip()
            break
    if not first:
        return None
    m = VERDICT_RE.search(first)
    if not m:
        return None
    label = first[:m.start()].strip(_MD)
    if not is_lens_author(label, lens_roles):
        return None
    return {"lens": _lens_name(label), "verdict": VERDICTS[m.group(1).lower()], "sha": m.group(2).lower()}


def on_head(sha, head):
    return bool(sha) and bool(head) and head.lower().startswith(sha.lower())


def ci_state(checks):
    """checks — список статусов/выводов. pending, если что-то не завершено; failure, если есть провал; иначе ok."""
    states = [str(c or "").upper() for c in checks]
    if any(s in ("PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING") for s in states):
        return "pending"
    if any(s in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED") for s in states):
        return "failure"
    return "ok"


def quorum(verdicts, head, checks, min_lenses=3):
    """verdicts — разобранные вердикты по порядку. Последний вердикт линзы на голову перекрывает её прежние.
    Возвращает (собран ли, одобрившие линзы, линзы с changes, состояние CI)."""
    last = {}
    for v in verdicts:
        if v and on_head(v["sha"], head):
            last[v["lens"]] = v["verdict"]
    approved = sorted(k for k, x in last.items() if x == "approve")
    changes = sorted(k for k, x in last.items() if x == "changes")
    ci = ci_state(checks)
    return (len(approved) >= min_lenses and not changes and ci != "pending"), approved, changes, ci


def role_of_lens(lens, lens_roles):
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
