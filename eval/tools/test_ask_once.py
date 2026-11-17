#!/usr/bin/env python3
"""ask_once.py on a synthetic tree: answered, open and unknown questions, reworded and in the other language,
and the ledger write. Run: python3 -I <this file>"""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ask_once as a  # noqa: E402


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


class AskOnceTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        ledger = [
            {'id': 'd-locale', 'q': 'Какой язык интерфейса по умолчанию?', 'a': 'Английский, пока пользователь не выберет',
             'kw': 'default language locale english', 'source': 'чат 01.11', 'status': 'answered'},
            {'id': 'd-cache', 'q': 'Включать ли кэш ассетов?', 'a': 'Нет', 'source': 'чат 31.10'},
            {'id': 'd-cache', 'q': 'Включать ли кэш ассетов?', 'a': 'Да, кэш ок', 'source': 'чат 01.11'},  # correction
        ]
        write(self.root, a.LEDGER, ''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in ledger))
        write(self.root, a.DONE_DIR + '/boards.md',
              '# Закрыто\n\n- **Кэш ассетов веба** (закрыто 2026-11-01): nginx отдаёт неизменённые чанки с expires 1y\n')
        write(self.root, a.SPEC, '| R-090 | Импорт карточек из Notion идёт пачками по сто | Q-031 |\n'
                                 '| R-101 | Форма перманентных вопросов владельца на доске | Q-104 |\n')
        write(self.root, 'oq.json', json.dumps([
            {'id': 'c-7', 'data': {'kind': 'decision', 'title': 'Запрещать ли второго родителя у подзадачи?'}},
            {'id': 'c-8', 'data': {'kind': 'decision', 'title': 'Сколько реплик Redis держать?', 'done': True}}],
            ensure_ascii=False))

    def tearDown(self):
        shutil.rmtree(self.root)

    def check(self, question, *extra):
        return a.main(['--root', self.root, 'check', question, *extra])

    def test_answered_reworded_and_other_language(self):
        self.assertEqual(self.check('какой язык выбран по умолчанию в интерфейсе'), 3)
        self.assertEqual(self.check('what is the default UI language?'), 3)
        self.assertEqual(self.check('нужен ли кэш ассетов в nginx'), 3)  # closed item
        self.assertEqual(self.check('импорт карточек из Notion пачками?'), 3)  # spec row with an owner answer

    def test_open_questions_are_not_asked_twice(self):
        oq = ['--oq', os.path.join(self.root, 'oq.json')]
        self.assertEqual(self.check('второй родитель у подзадачи — запрещать?', *oq), 4)  # open in the owner queue
        self.assertEqual(self.check('сколько реплик Redis держать', *oq), 0)  # done in the queue — not «open»
        self.assertEqual(self.check('форма перманентных вопросов владельца'), 4)  # spec Q-1xx

    def test_unknown_and_near_misses_are_asked(self):
        self.assertEqual(self.check('сколько реплик Redis держать в проде'), 0)
        self.assertEqual(self.check('какой язык писать в коммитах'), 0)  # not the UI-language answer

    def test_record_then_found_and_last_line_wins(self):
        self.assertEqual(self.check('сколько реплик Redis держать'), 0)
        entry = a.record(self.root, 'Сколько реплик Redis держать?', 'Одну', 'oq 7', '', '2026-11-01')
        self.assertTrue(entry['id'].startswith('d-20261101-'))
        self.assertNotEqual(entry['id'], a.record(self.root, 'q2', 'a2', 's', '', '2026-11-01')['id'])  # no collisions
        self.assertEqual(self.check('сколько реплик Redis держать'), 3)
        self.assertEqual(a.ledger(self.root)['d-cache'][1]['a'], 'Да, кэш ок')
        texts = [t for _, _, t in a.documents(self.root)]
        self.assertFalse(any(t.startswith('Включать ли кэш ассетов? → Нет') for t in texts))  # superseded
        with self.assertRaises(SystemExit):
            a.record(self.root, 'q', '', 'src', '', '2026-11-01')  # an answer needs its text

    def test_no_sources_is_not_no_answer(self):
        empty = tempfile.mkdtemp()
        try:
            self.assertEqual(a.main(['--root', empty, 'check', 'какой язык по умолчанию']), 5)
        finally:
            shutil.rmtree(empty)

    def test_stem_groups_word_forms(self):
        self.assertEqual(a.stem('вырубленного'), a.stem('вырубленные'))
        self.assertEqual(a.stem('branches'), a.stem('branch'))


if __name__ == '__main__':
    unittest.main()
