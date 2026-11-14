# tAIBE — команды слоя: git worktrees, проверки, ИИ-контур разработки.
# Worktrees — worktrees/README.md, .claude/rules/07-worktrees.md. Usage: make wt-fix NAME=notion-5xx-retry

WT_BASE ?= board-agents
# 0 — worktree без своих зависимостей (документы, eval, слой); гейт досок без них остановит хук PreToolUse
WT_DEPS ?= 1
TRACK ?=
NAME ?=

.PHONY: help wt-help wt-list wt-add wt-deps wt-check wt-rm wt-feature wt-fix wt-refactor wt-spike wt-review \
	check check-eval check-layer check-boards check-infra check-repo genome-check done-index evolve focus

help: wt-help
	@echo ""
	@echo "Проверки: make check (репозиторий + eval + слой + infra) · make check-boards (pnpm-гейты досок)"
	@echo "Геномы:   make genome-check · закрытое: make done-index"
	@echo "Эволюция: make evolve (версии слоя, L1 по ролям, дубли) · make focus PLAN='eval/board/plan-*.json'"
	@echo "ИИ-контур: npm run mcp-hub:status | llm-gateway:status | ai-council:status (корневой package.json)"

wt-help:
	@echo "Git worktrees (worktrees/<track>/<topic>, ветка <track>/<topic>, база $(WT_BASE)):"
	@echo "  make wt-add TRACK=fix NAME=notion-5xx-retry"
	@echo "  make wt-fix NAME=…  · wt-feature · wt-refactor · wt-spike · wt-review"
	@echo "  make wt-list"
	@echo "  make wt-deps TRACK=fix NAME=x    # pnpm install в boards/ (wt-add делает сам; WT_DEPS=0 — пропустить)"
	@echo "  make wt-check TRACK=fix NAME=x   # зависимости свои и свежие?"
	@echo "  make wt-rm TRACK=fix NAME=x"

wt-list:
	@git worktree list

wt-add:
	@test -n "$(TRACK)" || (echo "TRACK required (feature|fix|refactor|spike|review)" && exit 1)
	@test -n "$(NAME)" || (echo "NAME required (kebab-case topic)" && exit 1)
	@[ "$(WT_LIMIT_CHECK)" = 0 ] || { python3 -I eval/tools/wt_gc.py check-limit "$(CURDIR)"; rc=$$?; [ $$rc -ne 3 ]; }
	@mkdir -p "worktrees/$(TRACK)"
	@if git show-ref --verify --quiet "refs/heads/$(TRACK)/$(NAME)"; then \
		git worktree add "worktrees/$(TRACK)/$(NAME)" "$(TRACK)/$(NAME)"; \
	else \
		git worktree add "worktrees/$(TRACK)/$(NAME)" -b "$(TRACK)/$(NAME)" "$(WT_BASE)"; \
	fi
	@if [ "$(WT_DEPS)" = 0 ]; then \
		echo "→ зависимости пропущены (WT_DEPS=0); до гейтов досок: make wt-deps TRACK=$(TRACK) NAME=$(NAME)"; \
	else \
		infra/scripts/dev/wt-deps.sh install "worktrees/$(TRACK)/$(NAME)"; \
	fi
	@echo "→ cd worktrees/$(TRACK)/$(NAME)"

wt-deps:
	@test -n "$(TRACK)" || (echo "TRACK required" && exit 1)
	@test -n "$(NAME)" || (echo "NAME required" && exit 1)
	infra/scripts/dev/wt-deps.sh install "worktrees/$(TRACK)/$(NAME)"

wt-check:
	@test -n "$(TRACK)" || (echo "TRACK required" && exit 1)
	@test -n "$(NAME)" || (echo "NAME required" && exit 1)
	@infra/scripts/dev/wt-deps.sh check "worktrees/$(TRACK)/$(NAME)/boards" && echo "→ зависимости свои и свежие"

wt-rm:
	@test -n "$(TRACK)" || (echo "TRACK required" && exit 1)
	@test -n "$(NAME)" || (echo "NAME required" && exit 1)
	git worktree remove "worktrees/$(TRACK)/$(NAME)"

wt-feature:
	$(MAKE) wt-add TRACK=feature NAME=$(NAME)
wt-fix:
	$(MAKE) wt-add TRACK=fix NAME=$(NAME)
wt-refactor:
	$(MAKE) wt-add TRACK=refactor NAME=$(NAME)
wt-spike:
	$(MAKE) wt-add TRACK=spike NAME=$(NAME)
wt-review:
	$(MAKE) wt-add TRACK=review NAME=$(NAME)

check: check-repo check-eval check-layer check-infra

# Детерминированные проверки репозитория без модели: секреты, гигиена, полнота данных, синтаксис (infra/checks).
check-repo:
	python3 -I infra/checks/test_checks.py
	python3 -I infra/checks/run.py

check-eval:
	python3 -I -m unittest discover -s eval/nerve -p 'test_*.py'
	python3 -I -m unittest discover -s eval/pipeline -p 'test_*.py'
	python3 -I -m unittest discover -s eval/pipeline/reflex -p 'test_*.py'
	python3 -I -m unittest discover -s eval/pipeline/genome -p 'test_*.py'
	python3 -I -m unittest discover -s eval/swarm -p 'test_*.py'
	python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'

check-layer:
	@for t in .claude/hooks/test_*.py .claude/scripts/test_*.py eval/tools/test_*.py; do python3 "$$t" || exit 1; done
	bash .claude/scripts/sync-agent-skills.sh --check
	python3 -I eval/evolve/catalog.py --check

check-infra:
	node --test infra/llm-gateway/test/*.test.mjs
	node --test infra/owner-queue-mcp/test/*.test.mjs
	cd infra/owner-queue-bot && node --test test/*.test.mjs
	cd infra/ai-council && python3 selftest.py
	python3 -I -m unittest discover -s infra/mcp-hub -p 'test_*.py'
	python3 infra/scripts/misc/done-index.py --check
	python3 .claude/scripts/docs_linkcheck.py
	@for f in infra/scripts/dev-ai/*.sh infra/scripts/dev-ai/lib/*.sh infra/scripts/dev/*.sh; do bash -n "$$f" || exit 1; done

check-boards:
	cd boards && pnpm lint && pnpm typecheck && pnpm test

genome-check:
	cd eval/pipeline/genome && python3 -I build.py --check

done-index:
	python3 infra/scripts/misc/done-index.py

# Версии слоя — из git (catalog.py); здесь — отчёт: версии, L1 по ролям против бюджета, дубли.
evolve:
	python3 -I eval/evolve/catalog.py
	python3 -I eval/evolve/dupes.py --top 10

PLAN ?= eval/board/plan-*.json
focus:
	python3 -I eval/tools/queue_focus.py $(PLAN)
