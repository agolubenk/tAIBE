#!/usr/bin/env python3
"""AI Council — детерминированная проверка фактов. Только stdlib, БЕЗ LLM.

Канон: docs/specs/ai-council.md §5, пункт 3 «вето верификатора».

Самый сильный рычаг качества во всей подсистеме — и самый дешёвый. Однородные модели,
ревьюящие друг друга, сходятся к согласию, а не к правильности: уверенно сформулированную
ссылку на несуществующий файл они принимают. Поэтому всё, что проверяемо машиной, машина
и проверяет, а голосованию остаётся только субъективное (формулировки, декомпозиция,
порядок).

Проверяется по точному ключу, не нечётким поиском — форматы `doc_id` в DAMS-индексе
детерминированные:

    route:GET /api/v1/a2a/agents          prisma:PlatformAdmin
    proto:AccountsService.GetProfile

Непрошедшая ссылка обнуляет `grounded` предложения и попадает в отчёт. Где возможно,
рядом кладётся «похоже, имелось в виду X» — арбитру это полезнее голого отказа, а автору
предложения даёт шанс починиться в раунде опровержения.
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass, field
from difflib import get_close_matches
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from config import REPO_ROOT  # noqa: E402 — сверяем код хоста, а не слоя

HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")


@dataclass
class Check:
    # file | route | prisma_model | rpc | command | card | symbol
    #   + malformed_ref | ambiguous_ref — результаты check_file, которые НЕ являются
    #     выдумкой (см. FABRICATION_KINDS): мусор вместо пути и неоднозначное имя.
    kind: str
    ref: str
    ok: bool
    via: str = ""      # чем проверено: fs | git | rag | workspace | store
    hint: str = ""     # «похоже, имелось в виду …»

    def as_dict(self) -> dict:
        return {"kind": self.kind, "ref": self.ref, "ok": self.ok,
                "via": self.via, "hint": self.hint}


# Виды ссылок, провал которых означает ВЫДУМАННУЮ сущность. Только они дают вето:
# именно фабрикация делает предложение непригодным. `command` сюда не входит — кривой
# `verification_cmd` это дефект проверки, а не ложь о коде: план может быть верным, а
# команда написана с ошибкой. Смешивать их в один счётчик значит воздерживаться по
# карточкам, где выдумок нет вовсе.
#
# По той же причине сюда не входят `malformed_ref` и `ambiguous_ref` (замер 2026-08-13,
# 6 воздержаний из 8 прогонов — почти все по этим двум причинам):
#   • malformed_ref — модель положила в `files` не путь, а команду или обрывок shebang
#     (`turbo run test:run --filter=…`, `usr/bin/env python3`). Это дефект оформления,
#     а не утверждение о несуществующем файле;
#   • ambiguous_ref — имя разрешается в НЕСКОЛЬКО файлов репозитория (`types.ts` → 25).
#     Файл существует, неоднозначен лишь адрес. Вето здесь — обвинение во лжи там,
#     где модель сказала правду неточно.
# Обе категории остаются в отчёте как дефекты и режут `grounded_ratio` — они не
# «прощаются», они просто не дают права вето.
FABRICATION_KINDS = frozenset({"file", "route", "prisma_model", "rpc", "card", "symbol"})

# Слова, с которых начинается команда, а не путь. Нужны, чтобы отличить дефект
# оформления от выдумки: `npm run …` в поле files — это не несуществующий файл.
# Всё, что может вернуть check_file — нужно для дедупликации ссылок из декомпозиции.
_FILE_CHECK_KINDS = frozenset({"file", "malformed_ref", "ambiguous_ref"})

_COMMAND_HEADS = frozenset({
    "npm", "npx", "pnpm", "yarn", "turbo", "node", "python", "python3", "pytest",
    "bash", "sh", "zsh", "git", "docker", "make", "curl", "prisma", "tsc", "eslint",
})


def looks_like_path(ref: str) -> bool:
    """Похоже ли на путь к файлу — до всякой проверки существования.

    Отвечает на вопрос «модель вообще пыталась назвать файл?», а не «файл есть?».
    Разделение важно: несуществующий путь — это ложь о коде (вето), а команда в поле
    `files` — кривое оформление (дефект). Один и тот же счётчик для них означает
    воздержание по карточкам, где выдумок нет вовсе.
    """
    clean = (ref or "").strip().strip("`'\"").lstrip("./")
    if not clean or len(clean) > 200:
        return False
    if "--" in clean or clean.startswith("-"):
        return False
    # Пробел — главный признак команды (`turbo run … --filter=…`, `usr/bin/env python3`).
    # Допустим только если такой путь реально существует: имена с пробелами в репозитории
    # редки, но запрещать их из-за эвристики нельзя.
    if re.search(r"\s", clean) and not (REPO_ROOT / clean).exists():
        return False
    # Голое имя команды без разделителя пути и без расширения. Проверка намеренно
    # не применяется к `prisma/schema.prisma` и `infra/docker/…`: `prisma`, `docker`,
    # `make`, `node` — одновременно команды И реальные каталоги репозитория, поэтому
    # отбрасывать по первому сегменту пути нельзя (замер: schema.prisma отсекался как
    # «не путь», хотя это самый цитируемый файл бэкенда).
    if "/" not in clean and "." not in clean and clean.lower() in _COMMAND_HEADS:
        return False
    return True


@dataclass
class Verification:
    proposal_id: str = ""
    checks: list[Check] = field(default_factory=list)

    @property
    def hallucinations(self) -> list[Check]:
        """Только выдуманные сущности — то, что даёт право вето (§5)."""
        return [c for c in self.checks if not c.ok and c.kind in FABRICATION_KINDS]

    @property
    def defects(self) -> list[Check]:
        """Провалы, которые снижают качество, но не делают предложение ложным."""
        return [c for c in self.checks if not c.ok and c.kind not in FABRICATION_KINDS]

    @property
    def passed(self) -> bool:
        return not self.hallucinations and not self.defects

    @property
    def grounded_ratio(self) -> float:
        """Доля подтверждённых ссылок. Нет ссылок вообще — 0.0, а не 1.0: предложение
        без единой проверяемой привязки не «безупречно», оно бездоказательно."""
        if not self.checks:
            return 0.0
        return sum(1 for c in self.checks if c.ok) / len(self.checks)

    def as_dict(self) -> dict:
        return {
            "checked": [c.as_dict() for c in self.checks],
            "hallucinations": [c.as_dict() for c in self.hallucinations],
            "passed": self.passed,
            "grounded_ratio": round(self.grounded_ratio, 3),
        }

    def summary(self) -> str:
        if not self.checks:
            return "проверяемых ссылок нет — предложение бездоказательно"
        if self.passed:
            return f"все {len(self.checks)} ссылок подтверждены"
        confirmed = sum(1 for c in self.checks if c.ok)
        lines = [f"подтверждено {confirmed} из {len(self.checks)}"]
        if self.hallucinations:
            lines.append("НЕ СУЩЕСТВУЕТ (в финал не попадает):")
            for check in self.hallucinations:
                lines.append(f"  - {check.kind}: {check.ref}"
                             + (f" (похоже, имелось в виду: {check.hint})" if check.hint else ""))
        if self.defects:
            lines.append("ДЕФЕКТЫ (не вето, но исправить):")
            for check in self.defects:
                lines.append(f"  - {check.kind}: {check.ref}"
                             + (f" — {check.hint}" if check.hint else ""))
        return "\n".join(lines)


class Verifier:
    def __init__(self, cfg, store):
        self.cfg = cfg
        self.store = store
        self.rag = None
        rag_path = cfg.path_of("sources.rag.db")
        if rag_path.is_file():
            self.rag = sqlite3.connect(str(rag_path), timeout=5.0)
            self.rag.row_factory = sqlite3.Row
        self._git_files: set[str] | None = None
        self._workspaces: set[str] | None = None
        self._doc_ids: dict[str, set[str]] = {}
        self._schema_models: set[str] | None = None

    def close(self) -> None:
        if self.rag is not None:
            self.rag.close()

    # ── справочники, загружаются один раз ────────────────────────────────────
    def git_files(self) -> set[str]:
        if self._git_files is None:
            try:
                proc = subprocess.run(["git", "ls-files"], cwd=str(REPO_ROOT),
                                      capture_output=True, text=True, timeout=30)
                self._git_files = {line.strip() for line in proc.stdout.splitlines() if line.strip()}
            except (OSError, subprocess.SubprocessError):
                self._git_files = set()
        return self._git_files

    def workspaces(self) -> set[str]:
        """Имена пакетов монорепо — для проверки `turbo run … --filter=<pkg>`."""
        if self._workspaces is None:
            names: set[str] = set()
            for pattern in ("apps/*/package.json", "packages/*/package.json"):
                for path in REPO_ROOT.glob(pattern):
                    try:
                        names.add(json.loads(path.read_text(encoding="utf-8"))["name"])
                    except (OSError, ValueError, KeyError):
                        continue
            self._workspaces = names
        return self._workspaces

    def doc_ids(self, doc_type: str) -> set[str]:
        """ВАЖНО: `status` здесь НЕ фильтруется, в отличие от `dams_common.search()`.

        DAMS помечает записи `stale`, когда исходный файл изменился и срез индекса не
        пересобран. Для поиска это разумно (не выдавать устаревший текст), но для
        верификации катастрофично: `stale` значит «возможно, содержимое устарело», а не
        «сущности не существует». Замер 2026-08-12: все 438 `prisma_model` были `stale`
        после правки schema.prisma — с фильтром по active верификатор объявлял бы
        галлюцинацией любую корректную ссылку на модель Prisma и обнулял `grounded`
        у всех верных бэкенд-предложений.
        """
        if doc_type not in self._doc_ids:
            if self.rag is None:
                self._doc_ids[doc_type] = set()
            else:
                rows = self.rag.execute(
                    "SELECT doc_id FROM rag_docs WHERE doc_type = ?", (doc_type,)).fetchall()
                self._doc_ids[doc_type] = {r["doc_id"] for r in rows}
        return self._doc_ids[doc_type]

    def _prisma_models_from_schema(self) -> set[str]:
        """Последний рубеж, если индекс отсутствует или отстал: читаем schema.prisma.
        Файл — источник правды, индекс лишь его отражение."""
        if self._schema_models is None:
            models: set[str] = set()
            for path in REPO_ROOT.glob("apps/*/prisma/schema.prisma"):
                try:
                    text = path.read_text(encoding="utf-8")
                except OSError:
                    continue
                models |= set(re.findall(r"^\s*model\s+(\w+)\s*\{", text, re.M))
                models |= set(re.findall(r"^\s*enum\s+(\w+)\s*\{", text, re.M))
            self._schema_models = models
        return self._schema_models

    # ── отдельные проверки ───────────────────────────────────────────────────
    def check_file(self, ref: str) -> Check:
        clean = ref.strip().strip("`'\"").lstrip("./")
        clean = re.sub(r":\d+(-\d+)?$", "", clean)          # «file.ts:42» → «file.ts»
        if not clean:
            return Check("file", ref, False, "fs")
        if (REPO_ROOT / clean).exists():
            via = "git" if clean in self.git_files() else "fs"
            return Check("file", clean, True, via)

        # Не путь вовсе (команда, обрывок shebang) — дефект оформления, не выдумка.
        if not looks_like_path(clean):
            return Check("malformed_ref", clean, False, "fs",
                         hint="это не путь к файлу — команда или мусор в поле files")

        # Модель почти всегда ошибается директорией, а не именем файла. Если имя
        # разрешается в РОВНО ОДИН файл репозитория — это не выдумка, а неточная ссылка:
        # адресат однозначен. Считать её галлюцинацией — калибровочная ошибка, из-за
        # которой консилиум воздерживается почти на каждой карточке (замер 2026-08-13:
        # 4 «несуществующих» ссылки на одной карточке, все 4 файла существуют).
        base = Path(clean).name
        same_name = [f for f in self.git_files() if Path(f).name == base]
        if len(same_name) == 1:
            return Check("file", same_name[0], True, "basename", hint=f"указано как {clean}")
        if len(same_name) > 1:
            # Неоднозначность — проблема адресации, но не выдумка: файл существует,
            # непонятно лишь который. Вето здесь обвиняет модель во лжи там, где она
            # сказала правду неточно, — и именно это давало основную массу воздержаний.
            return Check("ambiguous_ref", clean, False, "git",
                         hint=f"{len(same_name)} файлов с таким именем: "
                              f"{', '.join(same_name[:3])}")

        near = get_close_matches(clean, self.git_files(), n=1, cutoff=0.75)
        return Check("file", clean, False, "git", hint=near[0] if near else "")

    def check_route(self, ref: str) -> Check:
        raw = ref.strip().strip("`'\"")
        match = re.match(r"^(%s)\s+(\S+)" % "|".join(HTTP_METHODS), raw, re.I)
        if match:
            method, path = match.group(1).upper(), match.group(2)
        else:
            method, path = "", raw
        path = "/" + path.lstrip("/")
        known = self.doc_ids("api_route")

        if method and f"route:{method} {path}" in known:
            return Check("route", f"{method} {path}", True, "rag")
        # Метод не указан — засчитываем, если путь существует хоть под каким-то методом.
        same_path = [d for d in known if d.split(" ", 1)[-1] == path]
        if same_path:
            if not method:
                return Check("route", path, True, "rag",
                             hint=", ".join(sorted(d[6:] for d in same_path)))
            return Check("route", f"{method} {path}", False, "rag",
                         hint=", ".join(sorted(d[6:] for d in same_path)))
        near = get_close_matches(f"route:{method} {path}".strip(), known, n=1, cutoff=0.7)
        return Check("route", raw, False, "rag", hint=near[0][6:] if near else "")

    def check_prisma_model(self, ref: str) -> Check:
        name = ref.strip().strip("`'\"")
        known = self.doc_ids("prisma_model")
        if f"prisma:{name}" in known:
            return Check("prisma_model", name, True, "rag")
        # Индекс может отставать от schema.prisma — файл важнее индекса.
        schema_models = self._prisma_models_from_schema()
        if name in schema_models:
            return Check("prisma_model", name, True, "schema.prisma")
        candidates = {d[7:] for d in known} | schema_models
        lowered = {c.lower(): c for c in candidates}
        if name.lower() in lowered:
            return Check("prisma_model", name, False, "schema.prisma", hint=lowered[name.lower()])
        near = get_close_matches(name, list(candidates), n=1, cutoff=0.75)
        return Check("prisma_model", name, False, "schema.prisma", hint=near[0] if near else "")

    def check_rpc(self, ref: str) -> Check:
        name = ref.strip().strip("`'\"")
        known = self.doc_ids("proto_rpc")
        if f"proto:{name}" in known:
            return Check("rpc", name, True, "rag")
        short = name.split(".")[-1]
        same_method = [d[6:] for d in known if d.split(".")[-1] == short]
        if same_method:
            return Check("rpc", name, False, "rag", hint=", ".join(sorted(same_method)[:3]))
        near = get_close_matches(name, [d[6:] for d in known], n=1, cutoff=0.7)
        return Check("rpc", name, False, "rag", hint=near[0] if near else "")

    def check_command(self, ref: str) -> Check:
        """Проверяем не «команда сработает», а «пакет из --filter существует» —
        несуществующий фильтр это самая частая и самая тихая ошибка в verification_cmd."""
        cmd = (ref or "").strip()
        if not cmd:
            return Check("command", "", False, "workspace", hint="verification_cmd не указан")
        filters = re.findall(r"--filter[= ]([^\s]+)", cmd)
        if not filters:
            ok = bool(re.search(r"\b(npm|turbo|python3|bash|node|pytest)\b", cmd))
            return Check("command", cmd, ok, "workspace",
                         hint="" if ok else "не похоже на исполняемую команду")
        known = self.workspaces()
        bad = [f for f in filters if f.strip("'\"") not in known]
        if not bad:
            return Check("command", cmd, True, "workspace")
        near = get_close_matches(bad[0].strip("'\""), list(known), n=1, cutoff=0.6)
        return Check("command", cmd, False, "workspace",
                     hint=f"нет пакета {bad[0]}" + (f", близко: {near[0]}" if near else ""))

    def check_card(self, ref: str) -> Check:
        card_id = ref.strip()
        found = self.store.q1("SELECT title FROM cards WHERE card_id = ?", (card_id,))
        if found:
            return Check("card", card_id, True, "store", hint=found["title"][:60])
        # Модель могла сослаться по Backlog ID вместо UUID — это не галлюцинация.
        by_backlog = self.store.q1(
            "SELECT card_id, title FROM cards WHERE backlog_id = ?", (card_id,))
        if by_backlog:
            return Check("card", card_id, True, "store", hint=by_backlog["title"][:60])
        return Check("card", card_id, False, "store")

    # ── проверка предложения целиком ─────────────────────────────────────────
    def verify(self, proposal: dict, proposal_id: str = "") -> Verification:
        result = Verification(proposal_id=proposal_id)
        touched = proposal.get("touched") or {}
        relations = proposal.get("relations") or {}

        for ref in _as_list(touched.get("files")):
            result.checks.append(self.check_file(ref))
        for ref in _as_list(touched.get("routes")):
            result.checks.append(self.check_route(ref))
        for ref in _as_list(touched.get("prisma_models")):
            result.checks.append(self.check_prisma_model(ref))
        for ref in _as_list(touched.get("rpcs")):
            result.checks.append(self.check_rpc(ref))

        # Файлы, названные внутри пунктов декомпозиции, — тоже утверждения о коде.
        # Дедуп идёт по ВСЕМ видам, которые возвращает check_file: он отдаёт не только
        # `file`, но и `malformed_ref`/`ambiguous_ref`, и сверка лишь с `file` заводила
        # один и тот же кривой путь в отчёт дважды, удваивая счётчик дефектов.
        seen_refs = {c.ref for c in result.checks if c.kind in _FILE_CHECK_KINDS}
        for step in proposal.get("decomposition") or []:
            if isinstance(step, dict):
                for ref in _as_list(step.get("files")):
                    check = self.check_file(ref)
                    if check.ref not in seen_refs:
                        seen_refs.add(check.ref)
                        result.checks.append(check)

        if "verification_cmd" in proposal:
            result.checks.append(self.check_command(proposal.get("verification_cmd") or ""))

        for key in ("blocks", "blocked_by", "related_cards"):
            for ref in _as_list(relations.get(key)):
                result.checks.append(self.check_card(ref))

        return result


def _as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    return []


if __name__ == "__main__":
    # Диагностика: проверяем сам верификатор на заведомо верных и заведомо ложных ссылках.
    import config as config_mod
    from store import Store

    cfg = config_mod.load(strict=False)
    with Store() as store:
        verifier = Verifier(cfg, store)

        real_card = store.q1("SELECT card_id, title FROM cards LIMIT 1")
        good = {
            "touched": {
                "files": ["apps/frontend/src/features/telegram/TelegramReactionPickerRow.tsx"],
                "routes": ["GET /api/v1/a2a/agents"],
                "prisma_models": ["PlatformAdmin"],
                "rpcs": ["AccountsService.GetProfile"],
            },
            "verification_cmd": "turbo run typecheck --filter=@hr-helper/web",
            "relations": {"related_cards": [real_card["card_id"]] if real_card else []},
        }
        bad = {
            "touched": {
                "files": ["apps/frontend/src/features/telegram/ReactionPanel.tsx"],
                "routes": ["GET /api/v1/telegram/reactions"],
                "prisma_models": ["TelegramReaction"],
                "rpcs": ["TelegramService.SetReaction"],
            },
            "verification_cmd": "turbo run typecheck --filter=@hr-helper/frontend",
            "relations": {"related_cards": ["00000000-0000-0000-0000-000000000000"]},
        }

        for label, proposal in (("ПРАВДИВОЕ предложение", good),
                                ("ГАЛЛЮЦИНИРУЮЩЕЕ предложение", bad)):
            v = verifier.verify(proposal, label)
            print(f"\n=== {label} ===")
            print(f"grounded_ratio = {v.grounded_ratio:.2f}, passed = {v.passed}")
            print(v.summary())

        verifier.close()
