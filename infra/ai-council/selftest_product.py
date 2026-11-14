#!/usr/bin/env python3
"""AI Council — самопроверка полей продукта (Ф2 OPS-23, `product.py`). Только stdlib, сети и Ollama нет.

1. HR: поля `council` из instances/hr-helper.json дают те же стек, карту модулей, словарь модулей, корни поиска и
   схему Prisma, что были зашиты в коде до Ф2. Значения ниже — копия кода board-agents 117050963
   (`review_prompts.py:150`, `retrieval.py:380-399`, `config.py:32-36`, `retrieval.py:250`, `graph_build.py:48`).
2. Определение продукта: env, хост, worktree внутри основной папки, имя папки (CI), нет продукта.
3. Поле с абсолютным путём или «..» — громкая ошибка, а не поиск вне репозитория.

    python3 infra/ai-council/selftest_product.py
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import product  # noqa: E402

FAILS: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  → {detail}"))
    if not ok:
        FAILS.append(name)


# Код до Ф2 (board-agents 117050963).
HR_FIRST_LINE = ("Ты участник ревью-консилиума проекта HR Helper v2 (NestJS + Prisma, React + Vite, "
                 "Telegram SM, мобильные клиенты). Ревьюируется карточка t-boards в колонке ревью: ")
HR_MODULE_PATHS = {
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
}
HR_CANONICAL_MODULES = {
    "backend", "frontend", "telegram", "extension", "mobile", "ai-tooling/mcp",
    "security/auth", "db/queues", "realtime", "ops/ci", "recruiting/ats",
    "huntflow", "hh.ru", "i18n", "ux", "docs",
}
# До Ф2 корни по умолчанию: ("apps", "packages", "boards", "eval"), отфильтрованные по папкам хоста; у HR есть только
# apps и packages (проверено на Mac 14.11).
HR_DEFAULT_ROOTS = ("apps", "packages")
HR_PRISMA = "apps/backend/prisma/schema.prisma"


def hr_matches_code_before_f2() -> None:
    import review_prompts

    hr = product.load(Path("/nonexistent"), env={product.ENV: "hr-helper"})
    rules = review_prompts.base_rules(hr.stack)
    check("HR: первая строка правил ревью — как до Ф2", rules.startswith(HR_FIRST_LINE), rules[:200])
    check("HR: карта модулей — как до Ф2", {k: list(v) for k, v in hr.modules.items()} == HR_MODULE_PATHS,
          sorted(set(hr.modules) ^ set(HR_MODULE_PATHS)))
    check("HR: словарь модулей карточки — как до Ф2", set(hr.modules) == HR_CANONICAL_MODULES)
    check("HR: корни поиска по умолчанию — как до Ф2", hr.default_roots == HR_DEFAULT_ROOTS, hr.default_roots)
    check("HR: схема Prisma — как до Ф2", hr.prisma_schema == HR_PRISMA, hr.prisma_schema)

    taibe = product.load(Path("/nonexistent"), env={product.ENV: "taibe"})
    check("tAIBE: свой стек, свои модули, схемы Prisma нет",
          bool(taibe.stack) and "HR Helper" not in taibe.stack and {"boards", "kanban", "pipeline"} <= set(taibe.modules)
          and taibe.prisma_schema == "", taibe)
    check("без стека — правила без названия проекта",
          review_prompts.base_rules("").startswith("Ты участник ревью-консилиума. Ревьюируется"))


def instances_copy(tmp: Path, roots: dict[str, Path]) -> str:
    """Копия instances/ с repo_root продуктов, указывающими во временную папку."""
    dst = tmp / "instances"
    shutil.copytree(product.nerve_products.INSTANCES, dst)
    for slug, root in roots.items():
        path = dst / f"{slug}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["repo_root"] = str(root)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(dst)


def resolution() -> None:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        hr, taibe = tmp / "HR_Helper-v2", tmp / "tAIBE"
        wt = taibe / "worktrees" / "feature" / "x"
        ci = tmp / "runner" / "tAIBE"
        lone = tmp / "elsewhere"
        for d in (hr, wt, ci, lone):
            d.mkdir(parents=True)
        inst = instances_copy(tmp, {"hr-helper": hr, "taibe": taibe})

        def how(host, env=None):
            slug, way, _ = product.resolve(host, env or {}, inst)
            return slug, way

        check("хост = repo_root → продукт хоста", how(hr) == ("hr-helper", "host"), how(hr))
        check("worktree внутри основной папки → её продукт", how(wt) == ("taibe", "worktree"), how(wt))
        check("checkout CI с тем же именем папки → продукт", how(ci) == ("taibe", "basename"), how(ci))
        check("чужая папка → продукта нет, поля пустые", how(lone) == ("", "") and
              product.load(lone, {}, inst) == product.Council(), how(lone))
        check("env COUNCIL_PRODUCT сильнее хоста", how(hr, {product.ENV: "taibe"}) == ("taibe", "env"))
        try:
            product.resolve(hr, {product.ENV: "nope"}, inst)
            check("неизвестный COUNCIL_PRODUCT — ошибка", False, "нет исключения")
        except product.ProductError as exc:
            check("неизвестный COUNCIL_PRODUCT — ошибка", "nope" in str(exc), exc)


def bad_paths() -> None:
    for value in ("/etc", "~/x", "apps/../../x", ""):
        try:
            product.council_of("hr-helper", "env", {"council": {"modules": {"x": [value]}}})
            check(f"путь «{value}» в council.modules — ошибка", False, "нет исключения")
        except product.ProductError as exc:
            check(f"путь «{value}» в council.modules — ошибка", "council.modules.x" in str(exc), exc)
    try:
        product.council_of("hr-helper", "env", {"council": {"prisma_schema": "/abs/schema.prisma"}})
        check("абсолютный council.prisma_schema — ошибка", False, "нет исключения")
    except product.ProductError:
        check("абсолютный council.prisma_schema — ошибка", True)


def main() -> int:
    hr_matches_code_before_f2()
    resolution()
    bad_paths()
    print(f"\n{'OK' if not FAILS else 'FAIL'}: {len(FAILS)} провалов")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
