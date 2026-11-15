# infra/checks — automatic checks without a model

> **Status (2026-11-01):** working; CI is `.github/workflows/checks-ci.yml`, plus the `api-integration` job in
> `boards-ci.yml`. Source of truth: the code in this folder and those workflows.

Every check here is deterministic and runs in seconds to minutes. It spends no model tokens, and the same input
always gives the same verdict. AI review (the council, the lenses) comes after these gates. It looks for what a
rule cannot express; it does not repeat what a rule already caught.

## What is checked

| Area | Tool | Fails on | Runs |
|---|---|---|---|
| Secrets | `run.py` → `secrets_scan.py` | Provider key formats (AWS, GitHub, GitLab, Slack, Anthropic, OpenAI, OpenRouter, Google, Telegram, Stripe, the board's own `tbk_`), private keys and PGP key blocks, JWTs, credentials in URLs, `Authorization: Bearer`, high-entropy base64, and literal credentials with high entropy — also env style (`*_API_KEY=`, `*_TOKEN:`) and the `x-api-key` header. Code-shaped values (`options.apiKey`, `z.string()`, words joined by `_`) and placeholders are skipped. In tests and fixtures a finding is a warning. Mark a line `checks: allow-secret` for a documented fake. Every kind of `boards/packages/redact/fixtures/secrets-corpus.json` must be caught here and by `@kaneo/redact` (TB-136). | every PR, all files |
| Hygiene | `hygiene.py` | Files `01-base` forbids (archives, dumps, `.env`, keys, databases), merge-conflict markers, files > 1 MB, CRLF in scripts. It warns when changed code grows past 500 lines. | every PR |
| Data completeness | `data.py` | Invalid JSON/JSONL. Board plans: unknown status or priority, links to cards that do not exist, subtask cycles. Decision ledger: a missing field or a non-ISO date. Drizzle journal: `idx` gaps, a `when` that does not grow (drizzle silently skips such a migration on existing databases), a journal entry without its `.sql`, a `.sql` missing from the journal. | every PR |
| Syntax | `syntax.py` | Python that does not compile; shell that `bash -n` / `zsh -n` rejects. | every PR |
| Shell quality | `shellcheck` (CI) | Errors fail; warnings are listed. | every PR |
| Workflows | `actionlint` 1.7.7 (CI, container) | Broken GitHub Actions syntax, expressions, unknown inputs. | every PR |
| Dependencies | `audit.py` | A high or critical advisory in production dependencies (`pnpm audit --prod` in `boards/`, `npm audit --omit=dev` in `infra/*`) that is not in the baseline. | every PR and every Monday |
| Does it work | `boards-ci` `api-integration` | API integration tests on a real PostgreSQL 16: routing, authorization, migrations from scratch. | PRs touching `boards/` |
| Types, lint, unit, build, i18n, OpenAPI | `boards-ci` (existing) | per package | PRs touching `boards/` |
| Layer | `layer-ci`, `eval-ci`, `infra-ci` (existing) | hook, script and service tests; L1 budget per role; genome freshness; closed-items index | by path |

Run locally:

```bash
python3 -I infra/checks/run.py                      # all four checks, all tracked files (~10 s)
python3 -I infra/checks/run.py --base origin/board-agents --only hygiene   # line limit for what you changed
python3 -I infra/checks/audit.py                     # needs network (registry)
python3 -I infra/checks/test_checks.py
make check-repo
```

## Allowlist and baseline — debt, not permission

- `allow.txt` lists findings that cannot be fixed, one per line with the reason: upstream Kaneo migration history
  and the published press kit. A finding that can be fixed gets fixed.
- `audit-baseline.json` records the advisories known on the day the gate was switched on (2026-11-01: 67 in total;
  5 critical and 20 high in `boards/`, 1 high in `infra/ops-console`). Each one is an open bug. An upgrade that fixes
  some runs `audit.py --prune`, so the file only shrinks. `--write-baseline` accepts today's list; it is an edit a
  reviewer must see.

## Product toggles

Automation that tAI-Boards product settings can switch off — the evolution process, the pipeline's automatic
parts — is listed in [`boards/docs/pipeline-settings.md`](../../boards/docs/pipeline-settings.md). These repository gates are not among the toggles: a
red check means a defect, not a preference.
