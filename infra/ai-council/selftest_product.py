#!/usr/bin/env python3
"""AI Council — самопроверка полей продукта (Ф2 OPS-23, `product.py`). Только stdlib, сети и Ollama нет.

1. Карта кода HR не лежит в публичном репозитории: в `instances/hr-helper.json` — только `council.file`
   (решение владельца d-taibe-ops23-m1-publish-1411 = B). Поля из файла продукта читаются так же, как из instances.
2. tAIBE: свои поля в instances.
3. Определение продукта: env, хост, worktree внутри основной папки, имя папки (CI), нет продукта; корень для
   `council.file`.
4. Ошибки громкие и с файлом: путь вне репозитория, `file` рядом с полями, неизвестное поле, повтор модуля, не JSON.
5. Ошибка в файлах продукта не останавливает консилиум: `current()` — строка в stderr и пустые поля;
   `product_root` отдаёт свою ошибку, а не ошибку нерва.

    python3 infra/ai-council/selftest_product.py
"""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import product  # noqa: E402

FAILS: list[str] = []
FIXTURE = {"stack": "Продукт X (Go, Vue)", "default_roots": ["svc", "web"], "prisma_schema": "db/schema.prisma",
           "modules": {"Backend": ["svc/api"], "frontend": ["web/src"]}}


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  → {detail}"))
    if not ok:
        FAILS.append(name)


def raises(fn, *needles: str) -> tuple[bool, str]:
    try:
        fn()
    except product.ProductError as exc:
        return all(n in str(exc) for n in needles), str(exc)
    return False, "нет исключения"


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


def public_repo_has_no_hr_map() -> None:
    raw = json.loads((Path(product.nerve_products.INSTANCES) / "hr-helper.json").read_text(encoding="utf-8"))
    check("HR: в instances только council.file — карты кода HR в публичном репозитории нет",
          set(raw.get("council", {})) == {"file"}, raw.get("council"))


def file_fields() -> None:
    import review_prompts

    with tempfile.TemporaryDirectory() as raw:
        repo = Path(raw)
        (repo / "docs/ai").mkdir(parents=True)
        (repo / "docs/ai/council.json").write_text(json.dumps(FIXTURE, ensure_ascii=False), encoding="utf-8")
        data = {"council": {"file": "docs/ai/council.json"}}
        c = product.council_of("x", "host", data, repo)
        check("файл продукта: поля прочитаны, ключи модулей в нижнем регистре",
              c.stack == FIXTURE["stack"] and c.modules == {"backend": ("svc/api",), "frontend": ("web/src",)}
              and c.default_roots == ("svc", "web") and c.prisma_schema == "db/schema.prisma"
              and c.source == "docs/ai/council.json", c)
        check("файл продукта: стек — в первой строке правил ревью",
              review_prompts.base_rules(c.stack).startswith(f"Ты участник ревью-консилиума проекта {FIXTURE['stack']}."))
        inline = product.council_of("x", "host", {"council": FIXTURE})
        check("те же поля в instances дают тот же Council (кроме источника)",
              inline.modules == c.modules and inline.stack == c.stack and inline.source == "instances/x.json")

        gone = product.council_of("x", "host", {"council": {"file": "docs/ai/nope.json"}}, repo)
        check("файла нет → продукт есть, поля пустые, источник «(нет файла)»",
              gone.slug == "x" and not gone.modules and not gone.stack
              and gone.source == "docs/ai/nope.json" + product.NO_FILE, gone)
        check("корня нет (продукт не на этой машине) → поля пустые",
              not product.council_of("x", "env", data, None).modules)

        (repo / "docs/ai/bad.json").write_text("{не json", encoding="utf-8")
        ok, why = raises(lambda: product.council_of("x", "host", {"council": {"file": "docs/ai/bad.json"}}, repo),
                         "docs/ai/bad.json", "не JSON")
        check("файл не JSON → ошибка с файлом и без абсолютного пути", ok and raw not in why, why)
        (repo / "docs/ai/extra.json").write_text(json.dumps({"stack": "s", "module": {}}), encoding="utf-8")
        ok, why = raises(lambda: product.council_of("x", "host", {"council": {"file": "docs/ai/extra.json"}}, repo),
                         "неизвестное поле module")
        check("опечатка в поле файла → ошибка", ok, why)


def taibe_fields() -> None:
    taibe = product.load(Path("/nonexistent"), env={product.ENV: "taibe"})
    check("tAIBE: свой стек, модули досок и меток, корни с infra, схемы Prisma нет",
          bool(taibe.stack) and "HR Helper" not in taibe.stack
          and {"boards", "kanban", "pipeline", "security", "secret", "vpn", "context"} <= set(taibe.modules)
          and "infra" in taibe.default_roots and taibe.prisma_schema == "" and taibe.source == "instances/taibe.json",
          taibe)
    import review_prompts
    check("без стека — правила без названия проекта",
          review_prompts.base_rules("").startswith("Ты участник ревью-консилиума. Ревьюируется"))


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
        ok, why = raises(lambda: product.resolve(hr, {product.ENV: "nope"}, inst), "nope")
        check("неизвестный COUNCIL_PRODUCT — ошибка", ok, why)

        data = {"repo_root": str(hr)}
        hr_wt = hr / "worktrees" / "fix" / "y"
        hr_wt.mkdir(parents=True)
        check("council.file читается от хоста-worktree, а не от основной папки",
              product.code_root(hr_wt, "worktree", data) == hr_wt.resolve())
        check("env и хост вне продукта → council.file от repo_root",
              product.code_root(lone, "env", data) == hr.resolve())
        check("env и хост внутри продукта → council.file от хоста",
              product.code_root(hr_wt, "env", data) == hr_wt.resolve())
        check("продукта нет → корня нет", product.code_root(lone, "", {}) is None)

        (hr / "docs/ai").mkdir(parents=True)
        (hr / "docs/ai/council.json").write_text(json.dumps(FIXTURE), encoding="utf-8")
        got = product.load(hr, {}, inst)
        check("HR на своём хосте читает карту из своего репозитория",
              got.slug == "hr-helper" and got.source == "docs/ai/council.json" and "backend" in got.modules, got)


def bad_paths() -> None:
    for value in ("/etc", "~/x", "apps/../../x", ""):
        ok, why = raises(lambda: product.council_of("hr-helper", "env", {"council": {"modules": {"x": [value]}}}),
                         "council.modules.x")
        check(f"путь «{value}» в council.modules — ошибка", ok, why)
    ok, why = raises(lambda: product.council_of("hr-helper", "env", {"council": {"prisma_schema": "/abs/s.prisma"}}),
                     "council.prisma_schema")
    check("абсолютный council.prisma_schema — ошибка", ok, why)
    ok, why = raises(lambda: product.council_of("x", "env", {"council": {"file": "../x.json"}}, Path("/")),
                     "council.file")
    check("council.file вне репозитория — ошибка", ok, why)
    ok, why = raises(lambda: product.council_of("x", "env", {"council": {"file": "a.json", "stack": "s"}}),
                     "council.file", "council.stack")
    check("council.file рядом с полями — ошибка, одно место", ok, why)
    ok, why = raises(lambda: product.council_of("x", "env", {"council": {"modules": {"UX": [], "ux ": []}}}),
                     "уже есть")
    check("повтор модуля после нижнего регистра — ошибка, а не тихая замена", ok, why)


def failures_do_not_stop_council() -> None:
    saved = product.load

    def broken(*_a, **_k):
        raise product.ProductError("instances/x.json: не JSON")

    product.load = broken
    product.current.cache_clear()
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            got = product.current()
    finally:
        product.load = saved
        product.current.cache_clear()
    lines = [x for x in err.getvalue().splitlines() if x.strip()]
    check("current(): ошибка файлов → пустые поля и одна строка в stderr, без исключения",
          got == product.Council() and len(lines) == 1 and "instances/x.json" in lines[0], (got, lines))

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        inst = instances_copy(tmp, {})
        (Path(inst) / "taibe.json").write_text("{битый", encoding="utf-8")
        ok, why = raises(lambda: product.product_root("taibe", inst))
        check("product_root: битый instances → ProductError консилиума (doctor её ловит)", ok, why)


def main() -> int:
    public_repo_has_no_hr_map()
    file_fields()
    taibe_fields()
    resolution()
    bad_paths()
    failures_do_not_stop_council()
    print(f"\n{'OK' if not FAILS else 'FAIL'}: {len(FAILS)} провалов")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
