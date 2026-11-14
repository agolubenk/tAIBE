#!/usr/bin/env python3
"""
Проверка merge-guard: смена видимости репозитория (IS-124) — отказ всем, и Контролю тоже. Формы: `gh repo edit
--visibility` и `--accept-visibility-change-consequences`, `gh api` PATCH `repos/<o>/<r>` с полем visibility или private
(и тело `--input`), GraphQL `updateRepository` с visibility, curl к api.github.com, тот же gh из кода интерпретатора.
Обычная правка и чтение репозитория проходят.

Запуск: python3 -I .claude/hooks/test_merge_guard_visibility.py  (только эти проверки; все — test_merge_guard.py)
Имя gh собрано из частей (G): хук читает этот файл с диска при запуске и иначе откажет на сами строки проверок.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import D9, TMP, bash, finish  # noqa: E402

G = "g" + "h"
d = Path(tempfile.mkdtemp(dir=TMP))
(d / "vis.json").write_text('{"visibility": "public"}')
(d / "desc.json").write_text('{"description": "x"}')
gql = "mutation{updateRepository(input:{repositoryId:\\\"x\\\",visibility:PUBLIC}){clientMutationId}}"

DENY = (
    ("repo edit --visibility public", f"{G} repo edit o/r --visibility public --accept-visibility-change-consequences"),
    ("repo edit --visibility=private", f"{G} repo edit --visibility=private"),
    ("repo edit, только согласие", f"{G} repo edit o/r --accept-visibility-change-consequences"),
    ("-R до repo", f"{G} -R o/r repo edit --visibility public"),
    ("api PATCH visibility", f"{G} api -X PATCH repos/o/r -f visibility=public"),
    ("api PATCH private=false", f"{G} api -X PATCH repos/o/r -F private=false"),
    ("api --method=patch, -fk=v", f"{G} api --method=patch /repos/{{owner}}/{{repo}} -fvisibility=public"),
    ("api --input с visibility", f"{G} api -X PATCH repos/o/r --input {d / 'vis.json'}"),
    ("api --input из stdin", f"echo x | {G} api -X PATCH repos/o/r --input -"),
    ("graphql updateRepository", f"{G} api graphql -f query=\"{gql}\""),
    ("curl PATCH private", "curl -X PATCH https://api.github.com/repos/o/r -d '{\"private\":false}'"),
    ("curl PATCH visibility", "curl -sX PATCH -H 'Authorization: token x' https://api.github.com/repos/o/r "
                              "--data '{\"visibility\": \"public\"}'"),
    ("python subprocess", f"python3 -c \"import subprocess as s; s.run(['{G}','repo','edit','--visibility','public'])\""),
    ("вместе с мёржем", f"{G} pr merge 1 && {G} repo edit --visibility public"),
)
ALLOW = (
    ("repo edit описание", f"{G} repo edit o/r --description x"),
    ("repo view с полем visibility", f"{G} repo view o/r --json visibility"),
    ("api GET repos", f"{G} api repos/o/r --jq .visibility"),
    ("api PATCH описание со словом private", f"{G} api -X PATCH repos/o/r -f description=private"),
    ("api --input без visibility", f"{G} api -X PATCH repos/o/r --input {d / 'desc.json'}"),
    ("curl GET repos", "curl -s https://api.github.com/repos/o/r"),
)
for label, cmd in DENY:
    bash(label, cmd, True)
    bash(label + " — Контроль", cmd, True, who=D9)
for label, cmd in ALLOW:
    bash(label, cmd, False)

if __name__ == "__main__":
    finish(" — смена видимости репозитория")
