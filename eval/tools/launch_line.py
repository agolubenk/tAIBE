"""Строка запуска сессии (TB-131) для spawn_session.sh: хэши генома и входа, родитель и способ пробуждения.

prompt — версия входа сессии: sha12 от содержимого первого файла (handoff или пусковой файл роли), «\\n» и шаблона
первого сообщения (линия «-», имя <name>), в котором путь этого файла заменён на <file>, а папка инструментов — на
<tools>. Две сессии одной роли дают один prompt; правка пускового файла или текста сообщения — другой. Тексты промптов
не уходят никуда: в строке только хэши. Отдельный модуль — чтобы spawn_session.sh оставался в пределе 500 строк
(01-base).

  launch_line.py --genome G --lineage L --file F --tools T --wake W < шаблон
"""
import argparse
import hashlib
import sys


def sha12(data):
    """Первые 12 знаков sha256 (48 бит: сотни версий генома и промпта без совпадений, строка запуска короче)."""
    return hashlib.sha256(data).hexdigest()[:12]


def launch_line(genome, lineage, first_file, tools, wake, template):
    """« Запуск: parent=… genome=… prompt=… wake=….» — сразу за меткой линии в первом сообщении."""
    g = "-"
    if genome:
        with open(genome, "rb") as fh:
            g = sha12(fh.read())
    parent = lineage.rsplit(".", 1)[0] if "." in lineage else lineage
    if parent == "r":  # поколение 1 (r.xxxx): родителя-сессии нет, корень «r» — не сессия
        parent = "-"
    t = template.replace(first_file, "<file>") if first_file else template
    t = t.replace(tools, "<tools>") if tools else t
    with open(first_file, "rb") as fh:
        prompt = sha12(fh.read() + b"\n" + t.encode("utf-8"))
    return f" Запуск: parent={parent} genome={g} prompt={prompt} wake={wake}."


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--genome", default="", help="файл генома; пусто — без генома")
    ap.add_argument("--lineage", required=True)
    ap.add_argument("--file", required=True, help="первый файл новой сессии: handoff или пусковой файл роли")
    ap.add_argument("--tools", required=True, help="папка eval/tools: в шаблоне заменяется на <tools>")
    ap.add_argument("--wake", required=True)
    a = ap.parse_args(argv)
    sys.stdout.write(launch_line(a.genome, a.lineage, a.file, a.tools, a.wake, sys.stdin.read()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
