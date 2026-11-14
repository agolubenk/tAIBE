#!/usr/bin/env python3
"""
Проверка merge-guard: смена видимости репозитория (IS-124) — отказ всем, и Контролю тоже. Формы: `gh repo edit
--visibility` и `--accept-visibility-change-consequences`, `gh api` PATCH `repos/<o>/<r>` с полем visibility или private
(и тело `--input`, в том числе с `\\u`-ключом и не JSON), `repositories/<id>`, GraphQL `updateRepository` с visibility,
любой не-GET curl/wget/httpie к самому репозиторию (тело из файла и stdin, хост с портом и в верхнем регистре), PATCH
к репозиторию из кода python/node и тот же gh из кода интерпретатора (SE-91). Обычная правка, ресурсы репозитория
и чтение проходят.

Запуск: python3 -I .claude/hooks/test_merge_guard_visibility.py  (только эти проверки; все — test_merge_guard.py)
Имя gh собрано из частей (G): хук читает этот файл с диска при запуске и иначе откажет на сами строки проверок.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import D9, TMP, bash, finish  # noqa: E402

G = "g" + "h"
H, P = "api.github" + ".com", "PA" + "TCH"  # хост и метод тоже из частей: хук ищет их в коде этого файла (SE-91)
R = f"https://{H}/repos/o/r"
d = Path(tempfile.mkdtemp(dir=TMP))
(d / "vis.json").write_text('{"visibility": "public"}')
(d / "esc.json").write_text('{"\\u0076isibility": "public"}')  # JSON декодирует `\u` в ключе — текстом не найти
(d / "raw.txt").write_text("visibility=public")
(d / "desc.json").write_text('{"description": "x"}')
v, e, w = d / "vis.json", d / "esc.json", d / "raw.txt"
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
    ("curl PATCH private", f"curl -X {P} {R} -d '{{\"private\":false}}'"),
    ("curl PATCH visibility", f"curl -sX {P} -H 'Authorization: token x' {R} --data '{{\"visibility\": \"public\"}}'"),
    # SE-91, пять форм Контроля на 1c8772d1f
    ("1 api --input с \\u-ключом", f"{G} api -X {P} repos/o/r --input {e}"),
    ("1 api --input не JSON", f"{G} api -X {P} repos/o/r --input {w}"),
    ("2 api repositories/<id>", f"{G} api -X {P} repositories/123 -f visibility=public"),
    ("3 curl -d @файл", f"curl -X {P} {R} -d @{v}"),
    ("3 curl --data-binary @- < файл", f"curl -X {P} {R} --data-binary @- < {v}"),
    ("3 wget --body-file", f"wget --method={P} --body-file={v} {R}"),
    ("4 curl хост :443", f"curl https://{H}:443/repos/o/r -d '{{\"private\":false}}'"),
    ("4 curl хост в верхнем регистре", f"curl -X {P} https://{H.upper()}/repos/o/r -d @{v}"),
    ("4 curl repositories/<id>", f"curl -X{P} https://{H}/repositories/123 -d @{v}"),
    ("5 python urllib", f"python3 -c \"import urllib.request as u; u.urlopen(u.Request('{R}', data=b'{{}}', "
                        f"method='{P}'))\""),
    ("5 python http.client", f"python3 -c \"import http.client as h; c=h.HTTPSConnection('{H}'); "
                             f"c.request('{P}','/repos/o/r','{{}}')\""),
    ("5 node fetch", f"node -e \"fetch('{R}',{{method:'{P}',body:JSON.stringify({{visibility:'public'}})}})\""),
    ("httpie PATCH", f"http {P} {R} private:=false"),
    ("httpie данные без метода", f"http {R} visibility=public"),
    ("python subprocess", f"python3 -c \"import subprocess as s; s.run(['{G}','repo','edit','--visibility','public'])\""),
    ("вместе с мёржем", f"{G} pr merge 1 && {G} repo edit --visibility public"),
)
ALLOW = (
    ("repo edit описание", f"{G} repo edit o/r --description x"),
    ("repo view с полем visibility", f"{G} repo view o/r --json visibility"),
    ("api GET repos", f"{G} api repos/o/r --jq .visibility"),
    ("api PATCH описание со словом private", f"{G} api -X PATCH repos/o/r -f description=private"),
    ("api --input без visibility", f"{G} api -X PATCH repos/o/r --input {d / 'desc.json'}"),
    ("curl GET repos", f"curl -s {R}"),
    ("curl -X GET repos", f"curl -s -X GET {R}"),
    ("curl GET со склеенным заголовком", f"curl -s -HX-GitHub-Api-Version:2022-11-28 {R}"),
    ("curl POST issue со словом private", f"curl -X POST {R}/issues -d '{{\"title\":\"private\"}}'"),
    ("api GET repositories/<id>", f"{G} api repositories/123 --jq .private"),
    ("python чтение поля private", f"python3 -c \"import json,urllib.request as u; "
                                   f"print(json.load(u.urlopen('{R}'))['private'])\""),
    ("httpie GET с параметром", f"http {R} per_page==1"),
)
for label, cmd in DENY:
    bash(label, cmd, True)
    bash(label + " — Контроль", cmd, True, who=D9)
for label, cmd in ALLOW:
    bash(label, cmd, False)

if __name__ == "__main__":
    finish(" — смена видимости репозитория")
