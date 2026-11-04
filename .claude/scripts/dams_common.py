#!/usr/bin/env python3
"""DAMS — общие хелперы (только stdlib). Используются .claude/hooks/* и .claude/scripts/*."""
import json
import re
import sqlite3
import time
from pathlib import Path

from host_root import host_root

# Индекс, капитал, граф и сессии DAMS — данные хоста (TAIBE_HOST_ROOT; без него — этот репозиторий).
REPO_ROOT = host_root()
DB_PATH = REPO_ROOT / ".claude/rag/index.db"
CAPITAL_PATH = REPO_ROOT / ".claude/memory/capital.json"
GRAPH_PATH = REPO_ROOT / ".claude/memory/graph.json"
STATE_PATH = REPO_ROOT / ".claude/rag/.dams-state.json"
SESSION_LATEST = REPO_ROOT / ".claude/memory/session/latest.md"
SESSION_HISTORY = REPO_ROOT / ".claude/memory/session/history"

MAX_TRACKED_SESSIONS = 15

STOPWORDS = {
    "the", "add", "and", "are", "create", "make", "need", "should", "must",
    "this", "that", "with", "from", "into", "for", "not", "can", "will",
    "http", "https", "www", "please", "help", "check", "look", "file",
    "code",
}

# Русские стемы → английские термины индекса (контент индекса преимущественно англоязычный).
RU_ALIASES = [
    ("кандидат", "candidate"), ("ваканси", "vacancy"), ("собеседован", "interview"),
    ("интервью", "interview"), ("воронк", "pipeline"), ("агент", "agent"),
    ("автоматизаци", "automation"), ("очеред", "queue"), ("кэш", "cache"),
    ("кеш", "cache"), ("безопасн", "security"), ("уязвим", "security"),
    ("миграци", "migration"), ("схем", "schema"), ("маршрут", "route"),
    ("роут", "route"), ("эндпоинт", "endpoint"), ("поиск", "search"),
    ("уведомлен", "notification"), ("календар", "calendar"), ("сесси", "session"),
    ("сотрудник", "employee"), ("адаптаци", "onboarding"), ("онбординг", "onboarding"),
    ("обучени", "learning"), ("аналитик", "analytics"), ("телеграм", "telegram"),
    ("вики", "wiki"), ("зарплат", "salary"), ("найм", "hiring"),
    ("подбор", "recruiting"), ("резюме", "resume"), ("опрос", "survey"),
    ("оценк", "evaluation"), ("документ", "document"), ("интеграци", "integration"),
    ("транзакц", "transaction"), ("индекс", "index"), ("реплик", "replica"),
    ("вебхук", "webhook"), ("токен", "token"), ("авториз", "auth"),
    ("аутентиф", "auth"), ("мобильн", "mobile"), ("андроид", "android"),
]


def est_tokens(text: str) -> int:
    """Грубая оценка: ~3 символа/токен (смесь кириллицы и кода)."""
    return max(1, len(text) // 3)


# Частые русские слова запроса, у которых нет доменного смысла: в префиксный поиск не идут.
RU_STOP = {
    "нужно", "нужен", "нужна", "нужны", "надо", "сделать", "сделай", "сделаем", "давай", "давайте", "можно",
    "можешь", "который", "которая", "которое", "которые", "чтобы", "через", "после", "перед", "сейчас",
    "теперь", "будет", "будут", "может", "этого", "этому", "также", "потом", "очень", "просто", "только",
    "когда", "почему", "какой", "какие", "какая", "какое", "вообще", "пожалуйста", "посмотри", "проверь",
    "проверить", "исправь", "исправить", "работает", "работать", "должен", "должна", "должно", "должны",
    "делали", "сделали", "решили", "уже", "было", "была", "были", "найди", "найти", "покажи",
}
SHA_RE = re.compile(r"\b[0-9a-f]{7,40}\b")


def _ru_prefix(token: str) -> str:
    """Грубый стем для FTS-префикса: окончание отрезается, 5–6 букв (`бандла` → `бандл`, `оптимизация` → `оптими`)."""
    return token[:min(6, max(5, len(token) - 1))]


def extract_search_terms(prompt: str, limit: int = 8, ru_prefix: bool = False) -> list:
    """SHA коммитов, латинские идентификаторы и английские алиасы русских доменных слов.

    ru_prefix — ещё и префиксы прочих русских слов (`"бандл"*`): офлайн-путь, когда алиасов не хватило
    (контент docs/ и записей done/ — русский, алиасы его не покрывают)."""
    terms = []
    # SHA целиком: латинская регулярка ниже начинает слово с буквы и превращала `4597ebfbe` в `ebfbe`
    for sha in SHA_RE.findall(prompt):
        if re.search(r"\d", sha) and re.search(r"[a-f]", sha) and sha not in terms:
            terms.append(sha)
    text = SHA_RE.sub(" ", prompt) if terms else prompt
    for t in re.findall(r"[A-Za-z][A-Za-z0-9_\-./]{2,}", text):
        tl = t.lower().strip("./-")
        if tl and tl not in STOPWORDS and tl not in terms:
            terms.append(tl)
    for tok in re.findall(r"[а-яёА-ЯЁ]{4,}", prompt.lower()):
        matched = False
        for stem, alias in RU_ALIASES:
            if tok.startswith(stem):
                matched = True
                if alias not in terms:
                    terms.append(alias)
        if not matched and ru_prefix and len(tok) >= 5 and tok not in RU_STOP:
            prefix = _ru_prefix(tok) + "*"
            if prefix not in terms:
                terms.append(prefix)
    return terms[:limit]


def fts_query(terms: list) -> str:
    safe = []
    for t in terms:
        is_prefix = t.endswith("*")
        t = t.rstrip("*").replace('"', "").strip()
        if t:
            safe.append('"%s"%s' % (t, "*" if is_prefix else ""))
    return " OR ".join(safe)


# Источники типов, которые индексатор берёт из файлов docs/: для предупреждения «индекс старше файлов».
FRESHNESS_SOURCES = {"done_entry": ("docs/plans/done", "*.md")}


def freshness_hint(conn, doc_type):
    """Пустой тип или файлы новее индекса: без подсказки «ничего не найдено» неотличимо от «совпадений нет»
    (индекс локальный, после pull и для новых файлов сам не обновляется)."""
    if not doc_type:
        return ""
    try:
        if not conn.execute("SELECT 1 FROM rag_meta WHERE doc_type = ? LIMIT 1", (doc_type,)).fetchone():
            return ("в индексе нет документов типа %s — python3 .claude/scripts/index_rebuild.py --type %s"
                    % (doc_type, doc_type))
        source = FRESHNESS_SOURCES.get(doc_type)
        if not source:
            return ""
        indexed = dict(conn.execute(
            "SELECT file_path, MAX(last_indexed_at) FROM rag_meta WHERE doc_type = ? GROUP BY file_path",
            (doc_type,)).fetchall())
    except sqlite3.Error:
        return ""
    behind = []
    for path in sorted((REPO_ROOT / source[0]).rglob(source[1])):
        rel = path.relative_to(REPO_ROOT).as_posix()
        ts = indexed.get(rel)
        if ts is None or path.stat().st_mtime > ts + 1:
            behind.append(rel)
    if not behind:
        return ""
    shown = ", ".join(behind[:3]) + (" …" if len(behind) > 3 else "")
    return ("индекс старше файлов (%d: %s) — python3 .claude/scripts/index_rebuild.py --type %s"
            % (len(behind), shown, doc_type))


def open_db():
    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH), timeout=2.0)
    conn.row_factory = sqlite3.Row
    return conn


class SearchResult(list):
    """Rows of a search, plus how the search went — so «nothing found» is never confused with «search broken»
    (bug E9, 01.11: an SQLite error used to come back as an empty list, and sessions re-asked the owner).

    status: `found` — rows; `no_match` — the index answered, nothing matched; `no_terms` — nothing to search for;
    `index_stale` — rows, but some are marked stale; `query_error` — the index failed (`error` says why).
    It is still a list, so callers that iterate rows keep working."""

    def __init__(self, rows=(), status="no_match", error=None):
        super().__init__(rows)
        self.status = status
        self.error = error

    @property
    def failed(self):
        return self.status == "query_error"


def search(conn, terms, limit=8, doc_type=None, module=None, include_stale=True):
    """FTS5-поиск по индексу.

    stale-документы по умолчанию НЕ прячем: между правкой файла и ручным
    index_rebuild целый срез (например, все prisma_model) помечен stale, и
    фильтр по status='active' превращал поиск в пустой ответ, неотличимый от
    «ничего релевантного нет». Устаревший текст полезнее пустоты — вызывающий
    видит поле status и решает сам. Активные всегда ранжируются выше stale.

    Возвращает SearchResult: список строк с полем `status` (found / no_match / no_terms / index_stale /
    query_error). Ошибка SQLite — `query_error`, а не пустой «ничего не найдено».
    """
    q = fts_query(terms)
    if not q:
        return SearchResult(status="no_terms")
    if conn is None:
        return SearchResult(status="query_error", error="index missing (no database)")
    sql = (
        "SELECT d.doc_id, d.doc_type, d.module, d.title, d.content, d.status, m.file_path "
        "FROM rag_docs d LEFT JOIN rag_meta m ON m.doc_id = d.doc_id "
        "WHERE rag_docs MATCH ?"
    )
    params = [q]
    if not include_stale:
        sql += " AND d.status = 'active'"
    if doc_type:
        sql += " AND d.doc_type = ?"
        params.append(doc_type)
    if module:
        sql += " AND d.module = ?"
        params.append(module)
    # Веса колонок bm25 (doc_id, doc_type, module, title, content, metadata, tags, status): совпадение в заголовке
    # весит больше — запись «TG-SM-5 — …» выше короткой записи, где TG-SM-5 лишь упомянут; doc_type/status не
    # ранжируют (иначе `route` поднимал любой api_route по имени типа).
    sql += (" ORDER BY (d.status <> 'active'), "
            "bm25(rag_docs, 1.0, 0.0, 1.0, 4.0, 1.0, 0.0, 2.0, 0.0) LIMIT ?")
    params.append(limit)
    try:
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    except sqlite3.Error as e:
        return SearchResult(status="query_error", error="%s: %s" % (type(e).__name__, e))
    if not rows:
        return SearchResult(status="no_match")
    stale = any(r.get("status") == "stale" for r in rows)
    return SearchResult(rows, status="index_stale" if stale else "found")


def stale_counts(conn, doc_type=None):
    """{doc_type: N} по помеченным stale документам (пусто — индекс актуален)."""
    sql = "SELECT doc_type, COUNT(*) FROM rag_docs WHERE status = 'stale'"
    params = []
    if doc_type:
        sql += " AND doc_type = ?"
        params.append(doc_type)
    sql += " GROUP BY doc_type"
    try:
        return {row[0]: row[1] for row in conn.execute(sql, params).fetchall()}
    except sqlite3.Error:
        return {}


def rebuild_hint(counts):
    """Человекочитаемая подсказка по устаревшим срезам индекса."""
    if not counts:
        return ""
    types = ",".join(sorted(counts))
    detail = ", ".join("%s: %d" % (t, counts[t]) for t in sorted(counts))
    return ("DAMS: индекс устарел (%s) — результаты помечены [stale]. "
            "Обновить: `python3 .claude/scripts/index_rebuild.py --type %s`"
            % (detail, types))


def log_query(conn, query, source, results, session_id):
    try:
        conn.execute(
            "INSERT INTO rag_query_log (query, source, results_count, top_doc_id, session_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (query, source, len(results),
             results[0]["doc_id"] if results else None,
             session_id, int(time.time())),
        )
        conn.commit()
    except sqlite3.Error:
        pass


def load_state():
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state):
    # Прунинг: держим только последние N сессий (dict сохраняет порядок вставки).
    if len(state) > MAX_TRACKED_SESSIONS:
        for key in list(state.keys())[: len(state) - MAX_TRACKED_SESSIONS]:
            state.pop(key, None)
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        # атомарная запись: параллельная сессия не увидит недописанный JSON
        tmp = Path(str(STATE_PATH) + ".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STATE_PATH)
    except OSError:
        pass


def rel_path(p):
    try:
        return str(Path(p).resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(p)
