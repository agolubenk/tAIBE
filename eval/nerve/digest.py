"""Нерв: дайджест роли не выдаёт устаревший pr.changes (SE-106). Вынесено из nerve.py (лимит 500 строк).

pr.changes попадает в дайджест, когда вердикт стоит на голове PR, а выдаётся через digest_minutes. За это время голова
могла смениться или линза могла снять changes. Поэтому tap кладёт рядом с текстом PR, sha и линзу и перед выдачей
сверяет их с состоянием демона (`<pdir>/state.json`, `github.prs`; пишется через os.replace, читать безопасно).

Совместимость курсора tap-<роль>.json: `pending` остаётся списком строк, сверка лежит отдельным ключом
`changes_meta`. tap на старом коде (откат, другой checkout) ключ не знает и выдаёт `pending` как раньше."""
import os
from collections import Counter

import quorum
from state_io import load_json


def pend(cur, rec):
    """Ставит событие в очередь дайджеста. У pr.changes с полем pr — ещё запись для сверки при выдаче."""
    cur["pending"].append(rec["text"])
    if rec.get("kind") == "pr.changes" and rec.get("pr") is not None:
        cur.setdefault("changes_meta", []).append({"text": rec["text"], "pr": str(rec["pr"]),
                                                   "sha": str(rec.get("sha") or ""), "lens": str(rec.get("lens") or "")})


def line(texts, most):
    """Строка дайджеста без времени: «дайджест (n): a · b · ещё k». Пусто — все события выпали, строки нет."""
    if not texts:
        return ""
    more = f" · ещё {len(texts) - most}" if len(texts) > most else ""
    return f"дайджест ({len(texts)}): {' · '.join(texts[:most])}{more}"


def fresh(cur, pdir):
    """Тексты к выдаче. pr.changes выпадает, если его sha не на текущей голове PR, линзы больше нет в changes_by
    или PR снят с учёта как влитый или закрытый (github.closed, SE-153: о нём уже пришло pr.closed).
    Fail open — выдаётся: нет github.prs в state.json, файл битый, PR нет ни в prs, ни в closed (демон видит не все
    открытые PR; closed держит сутки). Строка без записи сверки (старый курсор, другие виды событий)
    выдаётся как есть. Нет записей сверки — state.json (~1 МБ) не читается."""
    if not cur.get("changes_meta"):
        return list(cur["pending"])
    st = load_json(os.path.join(pdir, "state.json"), {})
    gh = st.get("github") if isinstance(st, dict) else None
    prs = gh.get("prs") if isinstance(gh, dict) else None
    gone = gh.get("closed") if isinstance(gh, dict) else None
    gone = gone if isinstance(gone, dict) else {}   # демон до SE-153 поля не пишет — сверка как раньше
    drop = Counter()
    if isinstance(prs, dict):
        drop.update(m["text"] for m in cur.get("changes_meta") or [] if isinstance(m, dict) and _stale(m, prs, gone))
    out = []
    for text in cur["pending"]:
        if drop[text] > 0:
            drop[text] -= 1
        else:
            out.append(text)
    return out


def _stale(m, prs, gone):
    p = prs.get(m.get("pr"))
    if not isinstance(p, dict):
        return m.get("pr") in gone   # снят как влитый или закрытый после вердикта (SE-153)
    return not quorum.on_head(m.get("sha"), p.get("head")) or m.get("lens") not in (p.get("changes_by") or [])
