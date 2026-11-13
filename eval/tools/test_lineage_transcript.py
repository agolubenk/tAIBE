#!/usr/bin/env python3
"""lineage.py: линия сессии из первого промпта транскрипта (TB-122, как HR #602).

Линию даёт только первая строка первого промпта с текстом, и только если это первое сообщение spawn_session.sh
(SPAWN_HEAD_RE) с хвостом «(поколение N) — метка session». Цитата чужой линии в handoff линию не даёт.
Run: python3 -I eval/tools/test_lineage_transcript.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lineage as L  # noqa: E402

MINE, OTHER = "r.a1.b2", "r.zz9"
TAG = " Линия: {} (поколение {}) — метка session на карточках и в очереди."
ROLE = "Сборка Т3, ключ реестра boards, роль 6. Пусковой файл: /p/6-boards.md — прочитай его первым." + TAG
HEIR = "Сборка Т3, ключ реестра backend, роль 4, наследник. Handoff: /h/H.md — прочитай его первым." + TAG
BARE = "Наследник сессии. Handoff: /h/H.md — прочитай его первым." + TAG


def user(content, meta=False):
    row = {"type": "user", "message": {"role": "user", "content": content}}
    if meta:
        row["isMeta"] = True
    return row


class FirstPromptLineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def line(self, *rows, raw=None):
        path = self.dir / "t.jsonl"
        text = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows)
        path.write_bytes((raw or b"") + text.encode("utf-8"))
        return L.first_prompt_line(path)

    def test_all_spawn_forms(self):
        for form in (ROLE, HEIR, BARE):
            with self.subTest(form=form[:30]):
                self.assertEqual(self.line(user(form.format(MINE, 2))), MINE)

    def test_spawn_session_first_message_matches(self):
        """Первое сообщение spawn_session.sh (--dry-run) во всех трёх формах даёт свою линию по обоим правилам."""
        sh = os.path.join(HERE, "spawn_session.sh")
        forms = {"Сборка Т3, ключ реестра boards, роль 6. ": ["--launch", "--roles", "boards"],
                 "Сборка Т3, ключ реестра boards, роль 6, наследник. ": ["--handoff", "H", "--role", "boards"],
                 "Наследник сессии. ": ["--handoff", "H"]}
        for head, args in forms.items():
            with self.subTest(head=head), tempfile.TemporaryDirectory() as tmp:
                (Path(tmp) / "h.md").write_text("x\n", encoding="utf-8")
                env = {**os.environ, "TMPDIR": tmp, "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "s"),
                       "TAIBE_LINEAGE_DIR": os.path.join(tmp, "l"), "NERVE_PLIST": os.path.join(tmp, "n.plist"),
                       "TAIBE_LINEAGE": ""}
                argv = [os.path.join(tmp, "h.md") if a == "H" else a for a in args]
                out = subprocess.run(["bash", sh, *argv, "--dry-run", "--cwd", tmp], capture_output=True, text=True,
                                     env=env, timeout=60).stdout
                start = out.find(head)
                self.assertGreaterEqual(start, 0, out)
                msg = out[start:].split("\n", 1)[0]
                self.assertTrue(L.SPAWN_HEAD_RE.match(msg), msg)
                self.assertEqual(len(set(L.LINE_ARG_RE.findall(msg))), 1, msg)

    def test_quote_of_other_line_in_first_prompt(self):
        """Вставленный handoff: первая строка — не первое сообщение spawn_session.sh, ниже цитата с якорем."""
        quote = "Продолжай по handoff.\n> " + ROLE.format(OTHER, 7)
        self.assertIsNone(self.line(user(quote)))

    def test_quote_with_spawn_head_not_on_first_line(self):
        self.assertIsNone(self.line(user("Привет\n" + HEIR.format(OTHER, 3))))

    def test_anchor_required(self):
        """Голова есть, хвоста «(поколение N) — метка session» нет — линии нет."""
        self.assertIsNone(self.line(user("Сборка Т3, ключ реестра boards, роль 6. Линия: " + OTHER)))

    def test_only_first_line_of_prompt(self):
        """Первая строка — голова без линии, линия чужой сессии — на второй строке."""
        text = "Сборка Т3, ключ реестра boards, роль 6. Пусковой файл: /p.md\n" + TAG.format(OTHER, 2)
        self.assertIsNone(self.line(user(text)))

    def test_two_lines_on_first_line(self):
        self.assertIsNone(self.line(user(ROLE.format(MINE, 2) + TAG.format(OTHER, 4))))

    def test_meta_and_tool_rows_skipped(self):
        rows = [{"type": "mode"}, user("Линия: r.qq (поколение 1) — метка session", meta=True),
                user([{"type": "tool_result", "content": TAG.format(OTHER, 1)}]), user(ROLE.format(MINE, 2))]
        self.assertEqual(self.line(*rows), MINE)

    def test_only_first_prompt(self):
        self.assertIsNone(self.line(user("продолжай"), user(ROLE.format(MINE, 2))))

    def test_blocks_joined_by_newline(self):
        """Хвост одного блока и начало другого не собирают якорь: блоки идут через перевод строки."""
        head = "Сборка Т3, ключ реестра boards, роль 6. Линия: " + OTHER
        self.assertIsNone(self.line(user([{"type": "text", "text": head},
                                          {"type": "text", "text": " (поколение 2) — метка session."}])))
        self.assertEqual(self.line(user([{"type": "text", "text": ROLE.format(MINE, 2)}])), MINE)

    def test_oversized_row_before_prompt(self):
        big = json.dumps(user("x" * (L.PROMPT_MAX_BYTES + 10))).encode() + b"\n"
        self.assertIsNone(self.line(user(ROLE.format(MINE, 2)), raw=big))

    def test_read_ceiling(self):
        filler = (json.dumps({"type": "assistant", "pad": "y" * 900_000}) + "\n").encode() * 10
        self.assertIsNone(self.line(user(ROLE.format(MINE, 2)), raw=filler))

    def test_session_line_args_need_anchor(self):
        """Путь «Линия: в аргументах» берёт тот же якорь."""
        self.assertIsNone(L.LINE_ARG_RE.search("claude 'см. Линия: r.zz9 в handoff'"))
        self.assertEqual(L.LINE_ARG_RE.search("claude '" + ROLE.format(MINE, 2) + "'").group(1), MINE)


if __name__ == "__main__":
    unittest.main()
