#!/usr/bin/env python3
"""Команда под машинными замками локальной модели (OPS-33, OPS-59). Только stdlib.

    python3 -I infra/scripts/dev-ai/ollama-locked.py [--who КТО] [--wait С] [--model ИМЯ] [--large] -- КОМАНДА [АРГУМЕНТ...]

Берёт тот же flock, что консилиум и шлюз моделей (`infra/ai-council/ollama.py`, `local_inference_slot`), пишет в файл
замка «pid КТО» (его называют `supervisor.py status` и 503 шлюза) и запускает команду. Код возврата — код команды.
Замок не освободился за `--wait` секунд — 75 (EX_TEMPFAIL), кто держит — в stderr, команда не запускается.

`--model ИМЯ` — команда грузит эту модель. L-модель (правило консилиума: `[models.large]` его config.toml или модель не
легче `models.large_threshold_gb`) идёт ещё и под машинным локом L-модели (`machine_model_slot`, OPS-29): он снаружи,
замок инференса внутри, как у консилиума и шлюза. `--large` — L-тир без проверки (модели ещё нет в Ollama и в списке). Оба замка
ждут в пределах одного `--wait`.

Замок — на один вызов модели. Прогрев берёт его на каждую модель, а не на весь прогрев: иначе консилиум и шлюз ждали
бы все модели подряд. `AI_COUNCIL_LOCAL_LOCK` (тесты) задаёт другой файл замка, как у консилиума; лок L-модели тогда
лежит рядом с ним.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ai-council"))
import ollama  # noqa: E402

EX_TEMPFAIL = 75


def is_large(model: str) -> bool:
    """L-тир по правилу консилиума. Конфиг не прочитан — только порог по размеру из /api/tags (как у консилиума).
    Любой сбой конфига — не отказ команды: неверный TAIBE_HOST_ROOT (HostRootError на импорте), Python 3.10 без
    tomllib, ошибка TOML. Иначе прогрев пропускал бы каждую модель с чужой причиной (линза boards, #268)."""
    try:
        import config as config_mod
        client = ollama.build(config_mod.load(strict=False))
    except Exception as exc:  # noqa: BLE001 — любой сбой конфига ведёт к порогу по размеру
        print(f"ollama-locked: конфиг консилиума не прочитан ({type(exc).__name__}: {exc}) — L-тир только по размеру",
              file=sys.stderr)
        client = ollama.OllamaClient()
    return client.is_large(model)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ollama-locked.py", description="Команда под машинным замком Ollama")
    parser.add_argument("--who", default="script", help="отметка держателя в файле замка (по умолчанию script)")
    parser.add_argument("--wait", type=float, default=300.0, help="сколько ждать замки, с (по умолчанию 300)")
    parser.add_argument("--model", default="", help="модель команды: L-модель — ещё и под локом L-модели")
    parser.add_argument("--large", action="store_true", help="L-тир без проверки: взять и лок L-модели")
    parser.add_argument("cmd", nargs=argparse.REMAINDER, help="-- команда и её аргументы")
    args = parser.parse_args(argv)
    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    if not cmd:
        parser.error("нужна команда после --")
    who = " ".join(args.who.split()) or "script"
    deadline = time.time() + args.wait
    try:
        with ExitStack() as held:
            if args.large or (args.model and is_large(args.model)):
                held.enter_context(ollama.machine_model_slot(args.model or "L-модель", who, args.wait, who=who))
            held.enter_context(ollama.local_inference_slot(max(0.0, deadline - time.time()), who=who))
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
