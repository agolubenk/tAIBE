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


def fresh(cur, pdir):
    """Тексты к выдаче. pr.changes выпадает, если его sha не на текущей голове PR или линзы больше нет в changes_by.
    Fail open — выдаётся: нет github.prs в state.json, файл битый, PR нет в prs (демон видит не все открытые PR,
    а закрытие приходит своим событием pr.closed). Строка без записи сверки (старый курсор, другие виды событий)
    выдаётся как есть. Нет записей сверки — state.json (~1 МБ) не читается."""
    if not cur.get("changes_meta"):
        return list(cur["pending"])
    st = load_json(os.path.join(pdir, "state.json"), {})
    gh = st.get("github") if isinstance(st, dict) else None
    prs = gh.get("prs") if isinstance(gh, dict) else None
    drop = Counter()
    if isinstance(prs, dict):
        drop.update(m["text"] for m in cur.get("changes_meta") or [] if isinstance(m, dict) and _stale(m, prs))
    out = []
    for text in cur["pending"]:
        if drop[text] > 0:
            drop[text] -= 1
        else:
            out.append(text)
    return out


def _stale(m, prs):
    p = prs.get(m.get("pr"))
    if not isinstance(p, dict):
        return False
    return not quorum.on_head(m.get("sha"), p.get("head")) or m.get("lens") not in (p.get("changes_by") or [])
