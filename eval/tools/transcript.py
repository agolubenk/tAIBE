"""Транскрипты Claude Code для замеров eval (context_audit.py, spend.py): где они лежат и как их читать. Только чтение.

Сессия — `~/.claude/projects/<папка проекта>/<sid>.jsonl`, её субагенты — `<папка проекта>/<sid>/subagents/*.jsonl`.
Папка проекта — путь checkout, где всё, кроме латиницы и цифр, заменено дефисом; у worktree имя начинается так же.
"""
import glob
import json
import os
import re
from datetime import datetime

COMPACTED = 'This session is being continued'
CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'nerve', 'config.json')


def dir_name(root):
    """Имя папки проекта Claude Code для пути checkout."""
    return re.sub(r'[^A-Za-z0-9]', '-', root)


def project_prefixes(config=CONFIG, fallback=None):
    """Имена папок проектов хоста и слоя (repo_root и родитель layer_home из eval/nerve/config.json)."""
    try:
        with open(config, encoding='utf-8') as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    roots = [cfg.get('repo_root'), os.path.dirname(cfg['layer_home'].rstrip('/')) if cfg.get('layer_home') else None]
    return [dir_name(r) for r in roots if r] or ([fallback] if fallback else [])


def files(prefixes, home=None):
    """[(путь, субагент?)] — сессии папок проектов с этими префиксами и их субагенты, по времени создания файла:
    оригинал раньше своей копии, поэтому запрос из возобновлённой сессии считается там, где его сделали."""
    out = []
    for d in glob.glob(os.path.join(home or os.path.expanduser('~/.claude'), 'projects', '*')):
        if any(os.path.basename(d).startswith(p) for p in prefixes):
            out += [(p, False) for p in glob.glob(os.path.join(d, '*.jsonl'))]
            out += [(p, True) for p in glob.glob(os.path.join(d, '*', 'subagents', '*.jsonl'))]

    def born(item):
        try:
            st = os.stat(item[0])
        except OSError:  # deleted between the glob and the sort; the scan skips it
            return 0
        return getattr(st, 'st_birthtime', st.st_mtime)
    return sorted(out, key=born)


def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for x in content or []:
        if isinstance(x, dict) and isinstance(x.get('text') or x.get('content'), str):
            out.append(x.get('text') or x.get('content'))
    return ' '.join(out)


def local_time(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone().replace(tzinfo=None)
