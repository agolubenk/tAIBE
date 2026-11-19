#!/usr/bin/env python3
"""cm.py — рецепты code mode (SE-71, `docs/specs/code-mode.md`): один вызов вместо цепочки, модели — только итог.

    python3 -I eval/tools/cm.py pr <n> [--json] [--product <slug>] [--repo owner/repo]

`pr <n>` — голова, сводка проверок и вердикт каждой линзы на голове (C-1, SE-159). Текст — до 1000 символов (R-3);
`--json` — полный итог для скриптов. Код выхода: 0 — готово; 3 — источник недоступен, одна строка
«<источник>: недоступно (<причина>)» без traceback (R-7): повтори прямым вызовом только этот источник; 2 — аргументы
или продукт. Только чтение (R-1), только stdlib (R-8)."""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from codemode import SourceDown, out, pr  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(prog="cm.py", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="recipe", required=True)
    p = sub.add_parser("pr", help="голова, проверки и вердикты линз на голове")
    p.add_argument("n", type=int)
    p.add_argument("--json", action="store_true", help="полный итог JSON, без потолка вывода")
    p.add_argument("--product", help="slug продукта (по умолчанию $TAIBE_PRODUCT, иначе продукт по умолчанию)")
    p.add_argument("--repo", help="owner/repo вместо github.repo продукта")
    a = ap.parse_args(argv)
    try:
        result = pr.recipe(a.n, product=a.product, repo=a.repo)
    except SourceDown as e:
        print(e, file=sys.stderr)
        return 3
    except pr.products.ProductError as e:
        print(f"cm.py: {e}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=1) if a.json else out.cap(pr.render(result)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
