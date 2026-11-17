#!/usr/bin/env python3
"""Команда под машинным замком локального инференса (OPS-33). Только stdlib.

    python3 -I infra/scripts/dev-ai/ollama-locked.py [--who КТО] [--wait С] -- КОМАНДА [АРГУМЕНТ...]

Берёт тот же flock, что консилиум и шлюз моделей (`infra/ai-council/ollama.py`, `local_inference_slot`), пишет в файл
замка «pid КТО» (его называют `supervisor.py status` и 503 шлюза) и запускает команду. Код возврата — код команды.
Замок не освободился за `--wait` секунд — 75 (EX_TEMPFAIL), кто держит — в stderr, команда не запускается.

Замок — на один вызов модели. Прогрев берёт его на каждую модель, а не на весь прогрев: иначе консилиум и шлюз ждали
бы все модели подряд. `AI_COUNCIL_LOCAL_LOCK` (тесты) задаёт другой файл замка, как у консилиума.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ai-council"))
import ollama  # noqa: E402

EX_TEMPFAIL = 75


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ollama-locked.py", description="Команда под машинным замком Ollama")
    parser.add_argument("--who", default="script", help="отметка держателя в файле замка (по умолчанию script)")
    parser.add_argument("--wait", type=float, default=300.0, help="сколько ждать замок, с (по умолчанию 300)")
    parser.add_argument("cmd", nargs=argparse.REMAINDER, help="-- команда и её аргументы")
    args = parser.parse_args(argv)
    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    if not cmd:
        parser.error("нужна команда после --")
    try:
        with ollama.local_inference_slot(args.wait, who=args.who):
            code = subprocess.run(cmd).returncode
    except TimeoutError as exc:
        print(f"ollama-locked: {exc}", file=sys.stderr)
        return EX_TEMPFAIL
    except FileNotFoundError as exc:
        print(f"ollama-locked: нет команды {cmd[0]}: {exc.strerror}", file=sys.stderr)
        return 127
    except KeyboardInterrupt:
        return 130
    return code if code >= 0 else 128 - code   # убит сигналом N — 128+N, как в shell


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
