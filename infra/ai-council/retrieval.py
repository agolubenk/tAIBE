#!/usr/bin/env python3
"""AI Council — сборка «капсулы задачи». Только stdlib.

Канон: docs/specs/ai-council.md §6.

Модели консилиума держат мало контекста, поэтому контекст здесь не расширяют, а ОТБИРАЮТ.
Капсула — то немногое, что модель увидит вместо всего проекта:

    pinned brief   ≤600 ток.  постановка + модуль + правила модуля + комментарии владельца
    evidence      ≤1800 ток.  DAMS RAG (код) + корпус консилиума (история) + соседи по графу
    ────────────────────────
    итого         ≤2400 ток.  влезает даже в 7B с запасом под ответ

Источники, у каждого свой потолок, чтобы один многословный не вытеснил остальные:

* **DAMS RAG** (`.claude/rag/index.db`) — 3054 документа по коду, правилам, спекам. Читаем
  через готовые хелперы `.claude/scripts/dams_common.py`, не дублируя поиск.
* **Корпус консилиума** (`council.db`) — карточки, DONE.md, прошлые вердикты. BM25 плюс,
  когда есть эмбеддинги, косинус; слияние по RRF.
* **graphify** (`graphify-out/graph.json`) — соседи по графу: это и есть «связи с другими
  частями проекта». Нет файла — источник молча выключается, капсула собирается без него.
* **@-упоминания** (Ф1/P2, `linked_card_ids`) — карточки, которые владелец явно назвал
  связанными на главной форме: не тематическое сходство (это `corpus`), а прямая ссылка.
"""
from __future__ import annotations

import json
import math
import re
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / ".claude/scripts"))

from config import REPO_ROOT  # noqa: E402 — поиск идёт по коду хоста

try:
    import dams_common                       # переиспользуем поиск DAMS, не копируем
    HAS_DAMS = True
except ImportError:                          # pragma: no cover
    dams_common = None
    HAS_DAMS = False

from planner_service import latest_done_payload  # тот же SQL, что у планировщика — не дублируем

RRF_K = 60          # константа Reciprocal Rank Fusion; 60 — общепринятая

# Два непересекающихся набора видов документов корпуса, живущих в РАЗНЫХ бюджетах капсулы.
# Опыт отвечает на «как это решали раньше», знания — на «как здесь вообще принято».
# В общем ведре знания выигрывали бы почти всегда (их втрое больше) и вытесняли бы опыт.
EXPERIENCE_KINDS = frozenset({"card", "done_md", "exemplar", "session"})
# 2026-10-09: + единые знания ИИ-сервисов (knowledge_sources.py) — карточки ролей `CLAUDE.md`
# (`role`), правила Continue (`client_rule`), память Claude Code (`memory`), решения claude-mem
# (`mem_obs`).
KNOWLEDGE_KINDS = frozenset({"rule", "agent", "skill", "chunk", "graph_node",
                             "role", "client_rule", "memory", "mem_obs"})
# Множитель RRF-оценки в ведре знаний: правила > карточки ролей > правила клиентов > память >
# наблюдения. Закон проекта сильнее описания роли, роль сильнее правил одного клиента, а
# запись памяти — это мнение одной сессии, не канон. Существующие виды оставлены на 1.0, чтобы
# не сдвигать их взаимный порядок. Множитель w ≈ сдвиг на (61/w − 61) позиций BM25: роль —
# ~3, правило клиента — ~7, память — ~11, наблюдение — ~15. Замер 2026-10-09 на копии корпуса
# (33 карточки, FTS без Ollama, 132 места ведра): без множителя решения claude-mem (длинные,
# плотные на идентификаторы) брали 37 мест и ≥ 2 из 4 на 10 карточках; с 0.65 у `mem_obs` —
# 0 мест, даже прямое решение по той же ошибке; с множителями ниже — 3 места, а новые виды
# (роль 13, память 5, решения 3) попадают в ведро на 15 карточках из 33.
KNOWLEDGE_PRIORITY = {"rule": 1.0, "chunk": 1.0, "agent": 1.0, "skill": 1.0, "graph_node": 1.0,
                      "role": 0.95, "client_rule": 0.9, "memory": 0.85, "mem_obs": 0.8}
# Не больше двух документов одного вида на ведро знаний: иначе самый многочисленный вид
# (скиллы, роли) забирает все четыре места, и закон модуля не доходит до модели.
KNOWLEDGE_PER_KIND = 2

# Дополнение к RU_ALIASES из .claude/scripts/dams_common.py. Там доменные существительные
# HR-системы (кандидат, вакансия, воронка); здесь — лексика ИНТЕРФЕЙСА и взаимодействия,
# которой карточки багов полны, а в DAMS-словаре нет.
#
# Почему словарём, а не только моделью: 7B-модель переводит домен нестабильно — на одной и
# той же карточке про «область эмодзи реакций» она выдала то `emojipanel` (в коде нет),
# то `contextmenu` (склейка), но `reaction` — реальное имя из TelegramReactionPickerRow.tsx —
# не выдала ни разу. Детерминированное сопоставление здесь надёжнее вероятностного,
# ровно как верификатор надёжнее голосования в §5.
UI_ALIASES: list[tuple[str, str]] = [
    ("реакци", "reaction"), ("эмодзи", "emoji"), ("смайл", "emoji"),
    ("контекстн", "context"), ("меню", "menu"), ("кнопк", "button"),
    ("панел", "panel"), ("вкладк", "tab"), ("модальн", "modal"),
    ("диалог", "dialog"), ("окно", "window"), ("поповер", "popover"),
    ("подсказк", "tooltip"), ("свернут", "collapse"), ("сверну", "collapse"),
    ("развернут", "expand"), ("разверну", "expand"), ("раскры", "expand"),
    ("список", "list"), ("таблиц", "table"), ("форм", "form"),
    ("поле", "field"), ("фильтр", "filter"), ("сортиров", "sort"),
    ("прокрут", "scroll"), ("скролл", "scroll"), ("пагинац", "pagination"),
    ("загрузк", "loading"), ("ошибк", "error"), ("валидац", "validation"),
    ("сообщени", "message"), ("чат", "chat"), ("черновик", "draft"),
    ("вложени", "attachment"), ("файл", "file"), ("аватар", "avatar"),
    ("ссылк", "link"), ("иконк", "icon"), ("бейдж", "badge"),
    ("счётчик", "counter"), ("счетчик", "counter"), ("уведомлен", "notification"),
    ("шаблон", "template"), ("черновы", "draft"), ("превью", "preview"),
    ("редактор", "editor"), ("композер", "composer"), ("вставк", "paste"),
    ("копирован", "copy"), ("выделени", "selection"), ("перетаскив", "drag"),
    ("виджет", "widget"), ("карточк", "card"), ("боков", "sidebar"),
    ("шапк", "header"), ("подвал", "footer"), ("тем", "theme"),
    ("настройк", "settings"), ("профил", "profile"), ("статус", "status"),
    ("отправк", "send"), ("получен", "receive"), ("ответ", "reply"),
    ("пересылк", "forward"), ("закреп", "pin"), ("архив", "archive"),
    ("поиск", "search"), ("сохранен", "save"), ("удален", "delete"),
]


def ui_aliases(text: str) -> list[str]:
    out: list[str] = []
    lowered = text.lower()
    for token in re.findall(r"[а-яёА-ЯЁ]{3,}", lowered):
        for stem, alias in UI_ALIASES:
            if token.startswith(stem) and alias not in out:
                out.append(alias)
    return out


def est_tokens(text: str) -> int:
    """~3 символа на токен (смесь кириллицы и кода) — та же оценка, что в DAMS."""
    return max(1, len(text) // 3)


def clip_to_tokens(text: str, budget: int) -> str:
    limit = budget * 3
    if len(text) <= limit:
        return text
    return text[:limit].rsplit("\n", 1)[0].rstrip() + "\n…"


@dataclass
class Evidence:
    source: str          # rag | corpus | graph
    kind: str            # api_route | prisma_model | done_md | neighbor | …
    ref: str
    title: str
    content: str
    score: float = 0.0

    def render(self) -> str:
        head = f"[{self.source}:{self.kind}] {self.title}"
        if self.ref and self.ref not in self.title:
            head += f"  ({self.ref})"
        return head + ("\n" + self.content if self.content else "")


@dataclass
class Capsule:
    card_id: str
    pinned: str
    evidence: list[Evidence] = field(default_factory=list)
    terms: list[str] = field(default_factory=list)
    dropped: dict = field(default_factory=dict)     # источник → сколько отброшено по бюджету

    def evidence_text(self) -> str:
        return "\n\n".join(e.render() for e in self.evidence)

    def tokens(self) -> dict:
        return {"pinned": est_tokens(self.pinned),
                "evidence": est_tokens(self.evidence_text()),
                "total": est_tokens(self.pinned) + est_tokens(self.evidence_text())}


# ── векторы: храним как float32 BLOB, косинус полным перебором ──────────────
# На тысячах записей это микросекунды — ANN-индекс был бы преждевременной сложностью.
def pack_vec(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def unpack_vec(blob: bytes) -> list[float]:
    return list(struct.unpack(f"{len(blob) // 4}f", blob))


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def rrf_merge(*ranked_lists: list[str]) -> dict[str, float]:
    """Reciprocal Rank Fusion: сливает BM25 и векторный ранг без калибровки шкал —
    сравнивать сырой bm25-score с косинусом бессмысленно, ранги сравнимы."""
    scores: dict[str, float] = {}
    for ranked in ranked_lists:
        for rank, doc_id in enumerate(ranked, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (RRF_K + rank)
    return scores


class Retriever:
    def __init__(self, cfg, store, ollama_client=None):
        self.cfg = cfg
        self.store = store
        self.ollama = ollama_client
        self.rag_conn = None
        if HAS_DAMS:
            rag_path = cfg.path_of("sources.rag.db")
            if rag_path.is_file():
                import sqlite3
                self.rag_conn = sqlite3.connect(str(rag_path), timeout=5.0)
                self.rag_conn.row_factory = sqlite3.Row
        self._graph = None
        self._graph_mtime = 0.0

    def close(self) -> None:
        if self.rag_conn is not None:
            self.rag_conn.close()

    # ── термины поиска ───────────────────────────────────────────────────────
    TERM_PROMPT = (
        "Ты преобразуешь описание задачи/бага HR-системы в поисковые термины для поиска по "
        "кодовой базе (NestJS, Prisma, PostgreSQL, Redis, BullMQ, Connect RPC/proto, React, "
        "Vite, Telegram MTProto). Описание обычно на русском — термины нужны АНГЛИЙСКИЕ.\n"
        "Правила:\n"
        "- только ОДИНОЧНЫЕ слова, как они встречаются в идентификаторах кода "
        "(reaction, picker, collapse, message, draft);\n"
        "- НЕ склеивай слова (emojiPanel, contextMenu — запрещено, пиши emoji, panel, context);\n"
        "- переводи доменные существительные из описания, не придумывай новых сущностей.\n"
        "Ответь ТОЛЬКО 4-8 терминами через запятую. Без пояснений, без markdown."
    )

    def _term_hit_counts(self, terms: list[str], roots: list[str]) -> dict[str, int]:
        """Сколько файлов содержит каждый термин. Служит двум целям сразу: отсев
        выдуманных моделью слов (0 файлов) и IDF-взвешивание (термин в 1000 файлов
        не несёт информации)."""
        import subprocess

        counts: dict[str, int] = {}
        for term in terms:
            try:
                proc = subprocess.run(
                    ["git", "grep", "-l", "-i", "--", term, *roots],
                    cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=15,
                )
            except (OSError, subprocess.SubprocessError):
                counts[term] = 0
                continue
            counts[term] = sum(1 for line in proc.stdout.splitlines() if line.strip())
        return counts

    @staticmethod
    def _default_roots() -> list[str]:
        # Корни кода по умолчанию: монорепо продукта-хоста (apps/, packages/) или дом слоя (boards/, eval/).
        return [r for r in ("apps", "packages", "boards", "eval") if (REPO_ROOT / r).is_dir()] or ["."]

    def _roots_for(self, modules: list[str]) -> list[str]:
        roots: list[str] = []
        for module in modules:
            for path in self.MODULE_PATHS.get(module, []):
                if path not in roots and (REPO_ROOT / path).exists():
                    roots.append(path)
        return roots

    def _llm_terms(self, card: dict) -> list[str]:
        """Расширение терминов локальной моделью. Русскоязычная карточка сама по себе даёт
        1-2 латинских слова, и BM25 по англоязычному индексу возвращает шум — это главная
        причина нерелевантных улик. Кэш по content_hash: текст не менялся → второй раз
        модель не дёргаем."""
        if self.ollama is None:
            return []
        card_hash = card.get("content_hash") or ""
        if card_hash:
            cached = self.store.q1("SELECT terms FROM term_cache WHERE card_hash = ?",
                                   (card_hash,))
            if cached:
                return json.loads(cached["terms"])

        profile = self.cfg.get("models.profile", "fast")
        model = self.cfg.roles("fast" if profile == "adaptive" else profile)["extractor"]
        prompt = "\n".join(filter(None, [
            card.get("title") or "",
            (card.get("body") or "")[:1200],
            "Модули: " + ", ".join(json.loads(card.get("modules") or "[]")),
        ]))
        result = self.ollama.chat(
            model,
            [{"role": "system", "content": self.TERM_PROMPT},
             {"role": "user", "content": prompt}],
            temperature=0.1, max_tokens=80, retries=0,
        )
        if not result.ok or not result.text:
            return []

        terms: list[str] = []
        for raw in re.split(r"[,\n;]+", result.text):
            token = re.sub(r"^\d+[.)]\s*", "", raw.strip()).strip("*_`'\". ").lower()
            if not re.fullmatch(r"[a-z][a-z0-9_.\- ]{1,30}", token):
                continue
            token = token.split()[0] if " " in token else token
            if token not in terms:
                terms.append(token)
        terms = terms[:8]

        # Отсев выдуманного: модель охотно возвращает правдоподобные, но несуществующие
        # идентификаторы (наблюдалось `emojipanel` при реальном `reaction`). Термин,
        # которого нет в коде, не улучшает поиск — он его засоряет.
        roots = self._roots_for(json.loads(card.get("modules") or "[]")) or self._default_roots()
        counts = self._term_hit_counts(terms, roots)
        rejected = [t for t in terms if counts.get(t, 0) == 0]
        terms = [t for t in terms if counts.get(t, 0) > 0]
        if rejected:
            self.store.event("retrieval.terms_rejected", card.get("card_id", ""),
                             json.dumps(rejected, ensure_ascii=False))

        if card_hash and terms:
            import time
            self.store.x(
                "INSERT OR REPLACE INTO term_cache (card_hash, terms, model, created_at) "
                "VALUES (?,?,?,?)",
                (card_hash, json.dumps(terms), model, int(time.time())),
            )
        return terms

    def terms_for(self, card: dict, expand: bool = True) -> list[str]:
        text = " ".join(filter(None, [
            card.get("title") or "", card.get("body") or "", card.get("report") or ""]))
        terms = dams_common.extract_search_terms(text, limit=10) if HAS_DAMS else []
        # Интерфейсная лексика — детерминированно и до модели: это самый надёжный
        # источник терминов для русскоязычной карточки про UI.
        for alias in ui_aliases(text):
            if alias not in terms:
                terms.append(alias)
        # Модули карточки — сильные термины сами по себе (совпадают с полем module в индексе).
        for module in json.loads(card.get("modules") or "[]"):
            head = module.split("/")[0]
            if head not in terms:
                terms.append(head)
        # Явные упоминания путей/идентификаторов в тексте — самое ценное для верификации.
        for match in re.findall(r"[a-zA-Z0-9_\-/]+\.(?:ts|tsx|py|prisma|proto|sql|md)", text):
            leaf = Path(match).stem
            if leaf and leaf not in terms:
                terms.append(leaf)
        if expand:
            for token in self._llm_terms(card):
                if token not in terms:
                    terms.append(token)
        return terms[:14]

    # ── источник 1: DAMS RAG ─────────────────────────────────────────────────
    def rag_evidence(self, terms: list[str], modules: list[str]) -> list[Evidence]:
        if self.rag_conn is None or not terms:
            return []
        per_type = self.cfg.get("sources.rag.hits_per_type", 4)
        by_type: list[list[Evidence]] = []
        for doc_type in self.cfg.get("sources.rag.types", []):
            rows = dams_common.search(self.rag_conn, terms, limit=per_type, doc_type=doc_type)
            # Фильтр по модулю карточки — если он вообще что-то оставляет.
            if modules:
                heads = {m.split("/")[0] for m in modules}
                narrowed = [r for r in rows if (r.get("module") or "") in heads]
                rows = narrowed or rows
            by_type.append([
                Evidence(source="rag", kind=doc_type,
                         ref=row.get("file_path") or row.get("doc_id", ""),
                         title=row.get("title") or row.get("doc_id", ""),
                         content=clip_to_tokens(row.get("content") or "", 120))
                for row in rows
            ])
        # Round-robin по типам, а не подряд: `api_route` в индексе 1471 документ против
        # 19 у `openapi_endpoint`, и при последовательной укладке он один выбирал весь
        # бюджет — до спек и правил очередь не доходила никогда. Порядок итерации
        # не должен решать, что увидит модель.
        out: list[Evidence] = []
        for i in range(per_type):
            for bucket in by_type:
                if i < len(bucket):
                    out.append(bucket[i])
        return out

    # ── источник 1б: прямой поиск по файлам ──────────────────────────────────
    # DAMS-индекс покрывает роуты/Prisma/proto/правила/спеки, но НЕ фронтовые компоненты
    # и не произвольный код. Для карточки про UI в нём нет ни одного релевантного
    # документа — без этого источника «улики» для фронта были бы бэкендовым шумом.
    MODULE_PATHS = {
        "frontend": ["apps/frontend/src"],
        "backend": ["apps/backend/src"],
        "telegram": ["apps/backend/src/modules/integrations/telegram",
                     "apps/telegram-sessions/src", "apps/frontend/src/features/telegram"],
        "extension": ["apps/extension"],
        "mobile": ["apps/mobile", "apps/mobile-android", "apps/mobile-ios"],
        "recruiting/ats": ["apps/backend/src/modules/recruiting",
                           "apps/frontend/src/features/recruiting"],
        "security/auth": ["apps/backend/src/modules/auth", "apps/backend/src/common/guards"],
        "db/queues": ["apps/backend/prisma", "apps/backend/src/common/queues"],
        "realtime": ["apps/backend/src/modules/realtime"],
        "ai-tooling/mcp": ["apps/backend/src/modules/mcp", "infra/ai-council"],
        "huntflow": ["apps/backend/src/modules/integrations/huntflow"],
        "hh.ru": ["apps/backend/src/modules/integrations/hh"],
        "i18n": ["apps/frontend/src/shared/i18n"],
        "ops/ci": ["infra"],
        "docs": ["docs"],
        "ux": ["apps/frontend/src/shared/components"],
        # Канонический дом слоя (tAIBE): доски, eval-пайплайн, сам слой.
        "boards": ["boards/apps/api/src", "boards/apps/web/src", "boards/packages"],
        "eval": ["eval"],
        "process": ["process", ".claude"],
    }

    def file_evidence(self, terms: list[str], modules: list[str], limit: int = 6) -> list[Evidence]:
        import subprocess

        # Модули на карточке не проставлены (в снапшоте таких 11 из 126) — не повод
        # оставлять её без файловых улик: ищем по всему коду, IDF отсеет общие термины.
        roots = self._roots_for(modules) or self._default_roots()

        probes = [t for t in terms if len(t) >= 4 and t not in
                  {"react", "vite", "code", "type", "file"}][:8]
        if not probes:
            return []

        counts = self._term_hit_counts(probes, roots)
        probes = [t for t in probes if 0 < counts[t] <= 400]      # 0 = выдумка, 400+ = шум
        if not probes:
            return []

        file_terms: dict[str, list[str]] = {}
        for probe in probes:
            try:
                proc = subprocess.run(
                    ["git", "grep", "-l", "-i", "--", probe, *roots],
                    cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=15,
                )
            except (OSError, subprocess.SubprocessError):
                break
            for line in proc.stdout.splitlines():
                if line.strip():
                    file_terms.setdefault(line.strip(), []).append(probe)

        def score_of(path: str) -> float:
            # IDF-подобный вес: редкий термин информативнее частого. Без этого файл,
            # совпавший по трём общеупотребительным словам, обгоняет файл, совпавший
            # по единственному точному имени сущности.
            score = sum(1.0 / math.log(2 + counts[t]) for t in file_terms[path])
            # Совпадение термина в самом имени файла — сильнейший сигнал.
            stem = Path(path).stem.lower()
            score += sum(0.8 for t in file_terms[path] if t in stem)
            return score

        out: list[Evidence] = []
        for path in sorted(file_terms, key=lambda p: (-score_of(p), len(p)))[:limit]:
            try:
                head = (REPO_ROOT / path).read_text(encoding="utf-8", errors="replace")[:600]
            except OSError:
                head = ""
            out.append(Evidence(
                source="files", kind=Path(path).suffix.lstrip(".") or "file",
                ref=path, title=Path(path).name,
                content=clip_to_tokens(head, 90), score=score_of(path)))
        return out

    # ── источник 2: корпус консилиума ────────────────────────────────────────
    def corpus_evidence(self, card: dict, terms: list[str], limit: int = 6,
                        kinds: set[str] | None = None, priority: dict | None = None,
                        per_kind: int | None = None) -> list[Evidence]:
        """Улики из собственного корпуса. `kinds` сужает выборку до нужных видов.

        Сужение существует, чтобы развести два разных по смыслу набора в РАЗНЫЕ бюджеты:
        опыт проекта (карточки, закрытое, принятые образцы) и его правила (rule/agent/
        skill/chunk/graph). В одном ведре правила выигрывали бы по BM25 почти всегда —
        их 463 против 146 карточек — и вытесняли бы прошлые решения, ради которых корпус
        и заводился.

        Фильтр по виду — в SQL, ДО `LIMIT`: при фильтре после выборки каждая новая порция
        знаний (2026-10-09: роли, правила клиентов, память) отъедала бы кандидатов у опыта.
        `priority` — множитель оценки по виду, `per_kind` — потолок документов одного вида.
        """
        if not terms:
            return []
        query = " OR ".join(f'"{t}"' for t in terms if t)
        bm25_ids: list[str] = []
        kind_sql, kind_params = "", ()
        if kinds is not None:
            kind_params = tuple(sorted(kinds))
            kind_sql = f" AND kind IN ({','.join('?' * len(kind_params))})"
        try:
            rows = self.store.q(
                "SELECT doc_id, kind, title, content FROM corpus "
                "WHERE corpus MATCH ?" + kind_sql + " ORDER BY rank LIMIT ?",
                (query,) + kind_params + (limit * 6,))
            bm25_ids = [r["doc_id"] for r in rows]
            by_id = {r["doc_id"]: r for r in rows}
        except Exception:                                   # noqa: BLE001
            return []                                       # корпус пуст/не готов — не падаем

        vec_ids: list[str] = []
        if self.ollama is not None:
            probe = f"{card.get('title', '')}\n{(card.get('body') or '')[:800]}"
            model = self.cfg.roles(self.cfg.get("models.profile", "fast")
                                   if self.cfg.get("models.profile") != "adaptive"
                                   else "fast")["embed"]
            embedded = self.ollama.embed(model, [probe])
            if embedded:
                target = embedded[0]
                scored = []
                for row in self.store.q("SELECT doc_id, vec FROM corpus_vec"):
                    scored.append((cosine(target, unpack_vec(row["vec"])), row["doc_id"]))
                scored.sort(reverse=True)
                vec_ids = [doc_id for _, doc_id in scored[:limit * 3]]
                if kinds is not None:
                    vec_ids = [d for d in vec_ids if d in by_id or self._kind_of(d) in kinds]

        merged = rrf_merge(bm25_ids, vec_ids) if vec_ids else \
            {doc_id: 1.0 / (RRF_K + i) for i, doc_id in enumerate(bm25_ids, 1)}
        if priority:
            for doc_id in merged:
                kind = by_id[doc_id]["kind"] if doc_id in by_id else self._kind_of(doc_id)
                merged[doc_id] *= float(priority.get(kind, 1.0))

        out: list[Evidence] = []
        taken: dict[str, int] = {}
        for doc_id, score in sorted(merged.items(), key=lambda kv: -kv[1]):
            if len(out) >= limit:
                break
            row = by_id.get(doc_id) or self.store.q1(
                "SELECT doc_id, kind, title, content FROM corpus WHERE doc_id = ?", (doc_id,))
            if not row or row["doc_id"] == card.get("card_id"):
                continue                                    # карточка сама себе не улика
            if per_kind and taken.get(row["kind"], 0) >= per_kind:
                continue
            taken[row["kind"]] = taken.get(row["kind"], 0) + 1
            out.append(Evidence(
                source="corpus", kind=row["kind"], ref=doc_id,
                title=row["title"] or doc_id,
                content=clip_to_tokens(row["content"] or "", 100), score=score))
        return out

    def _kind_of(self, doc_id: str) -> str:
        row = self.store.q1("SELECT kind FROM corpus_meta WHERE doc_id = ?", (doc_id,))
        return (row or {}).get("kind") or ""

    # ── источник 3: graphify ─────────────────────────────────────────────────
    def _load_graph(self) -> dict | None:
        if not self.cfg.get("sources.graph.enabled", True):
            return None
        path = self.cfg.path_of("sources.graph.path")
        if not path.is_file():
            return None
        mtime = path.stat().st_mtime
        if self._graph is None or mtime != self._graph_mtime:
            try:
                self._graph = json.loads(path.read_text(encoding="utf-8"))
                self._graph_mtime = mtime
            except (OSError, ValueError):
                self._graph = None
        return self._graph

    def graph_evidence(self, terms: list[str], limit: int | None = None) -> list[Evidence]:
        graph = self._load_graph()
        if not graph:
            return []
        limit = limit or self.cfg.get("sources.graph.max_neighbors", 12)
        nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
        lowered = [t.lower() for t in terms]

        seeds = [nid for nid, node in nodes.items()
                 if any(t in str(nid).lower() or t in str(node.get("label", "")).lower()
                        for t in lowered)][:8]
        if not seeds:
            return []

        adjacency: dict[str, set[str]] = {}
        # graphify пишет рёбра под ключом `links` (node-link формат networkx), старые
        # выгрузки — `edges`; читать оба, как graph_index.py и context_service.py. До
        # 2026-10-09 здесь был только `edges`, и граф-улики капсулы были пусты всегда.
        for edge in graph.get("edges") or graph.get("links") or []:
            a, b = edge.get("source"), edge.get("target")
            if a and b:
                adjacency.setdefault(a, set()).add(b)
                adjacency.setdefault(b, set()).add(a)

        seen, frontier = set(seeds), list(seeds)
        for _ in range(max(int(self.cfg.get("sources.graph.max_hops", 2)), 1)):
            nxt = []
            for nid in frontier:
                for neighbour in adjacency.get(nid, ()):
                    if neighbour not in seen:
                        seen.add(neighbour)
                        nxt.append(neighbour)
            frontier = nxt
            if len(seen) >= limit * 3:
                break

        out: list[Evidence] = []
        for nid in list(seen - set(seeds))[:limit]:
            node = nodes.get(nid, {})
            out.append(Evidence(
                source="graph", kind="neighbor", ref=str(nid),
                title=str(node.get("label") or nid),
                content=str(node.get("community_name") or node.get("community") or ""),
            ))
        return out

    # ── источник 4: связанные карточки (@-упоминания, Ф1/P2) ────────────────────
    @staticmethod
    def _linked_ids(card: dict) -> list[str]:
        """`linked_card_ids` только из одного места пишется валидным JSON-списком строк
        (`gateway.py::create_task`), но источник — колонка БД, а не типизированный вход:
        битый JSON, валидный-но-не-список JSON (`null`, `{}`), И список с не-строковыми
        элементами (`[[1,2]]` — `store.get_card()` падает на bind параметра не-str/int)
        не должны ронять сборку капсулы — источник должен молча выключаться, как остальные."""
        try:
            parsed = json.loads(card.get("linked_card_ids") or "[]")
        except (ValueError, TypeError):
            return []
        if not isinstance(parsed, list):
            return []
        return [x for x in parsed if isinstance(x, str)]

    def linked_evidence(self, card: dict) -> list[Evidence]:
        """@[упоминания] с главной формы — не «похожие по теме» (это уже делает `corpus`),
        а карточки, которые владелец явно назвал связанными. Даём последний done-итог,
        а не всю карточку — тот же принцип клипа, что и у остальных источников."""
        out: list[Evidence] = []
        for linked_id in self._linked_ids(card)[:5]:
            linked = self.store.get_card(linked_id)
            if not linked:
                continue
            payload = latest_done_payload(self.store, linked_id)
            bits = []
            statement = payload.get("statement") or {}
            if statement.get("goal"):
                bits.append(f"цель: {statement['goal']}")
            headers = [step.get("what") for step in (payload.get("decomposition") or [])
                       if isinstance(step, dict) and step.get("what")]
            if headers:
                bits.append("шаги: " + ", ".join(headers[:3]))
            if payload.get("open_questions"):
                bits.append("открыто: " + "; ".join(payload["open_questions"][:2]))
            notes = self.store.card_notes(linked_id, active_only=True)
            if notes:
                bits.append(f"указание владельца: {notes[0]['note']}")
            if not bits:
                bits.append("проработки пока нет")
            out.append(Evidence(
                source="linked", kind="card", ref=linked.get("url") or linked_id,
                title=linked.get("title") or linked_id,
                content=clip_to_tokens(" · ".join(bits), 80),
            ))
        return out

    # ── правила проекта, релевантные модулю ──────────────────────────────────
    def rules_for(self, modules: list[str]) -> list[str]:
        if self.rag_conn is None or not modules:
            return []
        heads = [m.split("/")[0] for m in modules]
        rows = dams_common.search(self.rag_conn, heads, limit=6, doc_type="rule_chunk")
        out: list[str] = []
        for row in rows:
            body = re.sub(r"\s+", " ", (row.get("content") or "")).strip()
            title = re.sub(r"\s+", " ", (row.get("title") or "")).strip()
            # В индексе встречаются вырожденные чанки (заголовок секции без тела) — они
            # съедали бы pinned-бюджет строками вида «# Frontend React + Vite : # Frontend…».
            if len(body) < 40 or body.replace(title, "").strip(" :#") == "":
                continue
            out.append(f"{title}: {clip_to_tokens(body, 60)}")
            if len(out) == 3:
                break
        return out

    # ── контекст предыдущей сессии (P4/Ф2, план §P4 «Жизненный цикл») ────────
    def session_context_block(self) -> str:
        """Свёртка последней ЗАКРЫТОЙ сессии — как pinned-улика новой сессии,
        а не результат поиска: она всегда попадает в капсулу (если гейт включён и
        свёртка есть), в отличие от дальних сессий, которые ищутся обычной RAG-
        выдачей через corpus kind='session' (EXPERIENCE_KINDS выше)."""
        ctx = self.cfg.get("council.session_context", {}) or {}
        if not ctx.get("enabled", False):
            return ""
        session = self.store.latest_closed_session()
        if not session or not session.get("summary"):
            return ""
        import time
        closed_at = session.get("closed_at") or 0
        delta = max(0, int(time.time()) - int(closed_at))
        if delta < 3600:
            ago = f"{max(1, delta // 60)} мин назад"
        elif delta < 86400:
            ago = f"{delta // 3600} ч назад"
        else:
            ago = f"{delta // 86400} дн назад"
        n_cards = len(self.store.session_runs(session["id"]))
        budget = int(ctx.get("session_tokens", 200))
        summary = clip_to_tokens(session["summary"], budget)
        return (f"КОНТЕКСТ ПРЕДЫДУЩЕЙ СЕССИИ ({ago}, {n_cards} "
                f"{'карточка' if n_cards == 1 else 'карточек'}):\n{summary}")

    # ── сборка капсулы ───────────────────────────────────────────────────────
    def build(self, card: dict, user_constraints: str = "") -> Capsule:
        ctx = self.cfg.get("council.context", {}) or {}
        pinned_budget = ctx.get("pinned_tokens", 600)
        evidence_budget = ctx.get("evidence_tokens", 1800)
        per_source = ctx.get("per_source_tokens", 600)

        modules = json.loads(card.get("modules") or "[]")
        terms = self.terms_for(card)

        kind = "Ошибка" if card["db"] == "bugs" else "Задача"
        weight = card.get("severity") or card.get("priority") or "—"
        head = [
            f"{kind} · {weight} · статус: {card.get('status') or '—'}"
            + (" · HALF-BAKED (сырая идея владельца)" if card.get("half_baked") else ""),
            f"Заголовок: {card.get('title') or ''}",
            f"Модули: {', '.join(modules) if modules else 'не указаны'}",
        ]
        if card.get("backlog_id"):
            head.append(f"Backlog ID: {card['backlog_id']}")
        if card.get("report"):
            head.append(f"Report: {card['report']}")
        linked_ids = self._linked_ids(card)
        if linked_ids:
            names = []
            for linked_id in linked_ids[:5]:
                linked = self.store.get_card(linked_id)
                if linked:
                    names.append(f"{linked.get('title') or linked_id} "
                                 f"({linked.get('url') or linked_id})")
            if names:
                head.append("Связанные задачи: " + "; ".join(names))
        # Хвостовые блоки: правила модулей и указание владельца. Обрезка идёт с КОНЦА
        # (clip_to_tokens), поэтому всё, что нельзя потерять, должно быть учтено в
        # бюджете ДО обрезки, а не просто дописано последним. Раньше указание владельца
        # добавлялось в конец «с приоритетом по позиции» и на любой длинной карточке
        # срезалось первым же клипом — то есть приоритетный по замыслу блок доходил до
        # модели реже всех прочих.
        tail: list[str] = []
        rules = self.rules_for(modules)
        if rules:
            tail.append("Правила проекта для этих модулей:\n"
                        + "\n".join(f"- {r}" for r in rules))
        session_block = self.session_context_block()
        if session_block:
            tail.append(session_block)
        if user_constraints.strip():
            # У слабых моделей позиция в промпте влияет сильнее любых слов «важно»,
            # поэтому блок остаётся последним — но теперь он гарантированно помещается.
            tail.append("КОММЕНТАРИИ ВЛАДЕЛЬЦА (приоритет выше любых выводов из кода):\n"
                        + user_constraints.strip())

        # Переменная часть — постановка и обсуждение: они и должны ужиматься, когда
        # карточка длинная. Им достаётся то, что осталось от бюджета после хвоста.
        variable: list[str] = []
        body = (card.get("body") or "").strip()
        if body:
            variable.append("Постановка из карточки:\n" + body)
        comments = json.loads(card.get("comments") or "[]")
        if comments:
            variable.append("Обсуждение на карточке:\n" + "\n".join(
                f"- {c.get('text', '')}" for c in comments[:5]))

        fixed_cost = est_tokens("\n\n".join(head))
        tail_cost = est_tokens("\n\n".join(tail)) if tail else 0
        variable_budget = max(120, pinned_budget - fixed_cost - tail_cost)
        variable_text = clip_to_tokens("\n\n".join(variable), variable_budget)

        pinned = "\n\n".join(filter(None, ["\n\n".join(head), variable_text,
                                           "\n\n".join(tail)]))

        buckets = {
            "files": self.file_evidence(terms, modules),
            "rag": self.rag_evidence(terms, modules),
            # Опыт проекта: прошлые карточки, закрытое, принятые образцы.
            "corpus": self.corpus_evidence(card, terms, kinds=EXPERIENCE_KINDS),
            # Правила проекта и единые знания ИИ-сервисов — отдельным бюджетом с приоритетом
            # по виду и потолком на вид, см. corpus_evidence и KNOWLEDGE_PRIORITY.
            "knowledge": self.corpus_evidence(card, terms, limit=4, kinds=KNOWLEDGE_KINDS,
                                              priority=KNOWLEDGE_PRIORITY,
                                              per_kind=KNOWLEDGE_PER_KIND),
            "graph": self.graph_evidence(terms),
            # @-упоминания с главной формы (Ф1/P2) — явные связи, а не тематическое сходство.
            "linked": self.linked_evidence(card),
        }
        evidence, dropped = [], {}
        for name, items in buckets.items():
            spent, kept = 0, 0
            for item in items:
                cost = est_tokens(item.render())
                if spent + cost > per_source:
                    break
                evidence.append(item)
                spent += cost
                kept += 1
            dropped[name] = len(items) - kept

        # Общий потолок поверх пер-источниковых: сумма трёх бюджетов может его превысить.
        total, trimmed = 0, []
        for item in evidence:
            cost = est_tokens(item.render())
            if total + cost > evidence_budget:
                dropped["overflow"] = dropped.get("overflow", 0) + 1
                continue
            trimmed.append(item)
            total += cost

        return Capsule(card_id=card["card_id"], pinned=pinned, evidence=trimmed,
                       terms=terms, dropped=dropped)


if __name__ == "__main__":
    # Диагностика: python3 infra/ai-council/retrieval.py [card_id]
    import config as config_mod
    import ollama as ollama_mod
    from store import Store

    cfg = config_mod.load(strict=False)
    with Store() as store:
        if len(sys.argv) > 1:
            card = store.get_card(sys.argv[1])
        else:
            card = store.q1("SELECT * FROM cards WHERE origin = 'tboards' ORDER BY fetched_at DESC LIMIT 1") \
                or store.q1("SELECT * FROM cards LIMIT 1")
        if not card:
            print("Карточек нет — прочитать из t-boards: python3 infra/ai-council/tboards.py card <ключ>")
            sys.exit(1)

        retriever = Retriever(cfg, store, ollama_mod.build(cfg, store))
        capsule = retriever.build(card)
        retriever.close()

        print(f"=== капсула: {card['title'][:70]} ===")
        print(f"термины: {', '.join(capsule.terms)}")
        print(f"бюджет:  {capsule.tokens()}")
        print(f"отброшено по бюджету: {capsule.dropped}")
        print(f"улик: {len(capsule.evidence)} "
              f"({', '.join(sorted({e.source for e in capsule.evidence})) or '—'})")
        print("\n--- PINNED ---")
        print(capsule.pinned)
        print("\n--- EVIDENCE (первые 3) ---")
        for item in capsule.evidence[:3]:
            print(item.render()[:400], "\n")
