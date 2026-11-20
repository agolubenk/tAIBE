---
paths:
  - "apps/**/*.spec.ts"
  - "apps/**/*.test.ts"
  - "apps/**/*.test.tsx"
  - "packages/**/*.test.ts"
---

# Тестирование

## Текущее состояние (файлы тестов, сверено 2026-10-08)

Backend: **505** unit (`src/**/*.spec.ts`) + **10** API e2e (`test/*.e2e-spec.ts`, supertest) · Frontend: **211** unit
(Vitest) + **16** Playwright (`e2e/`) · Пакеты: **40** (`utils` — 29, `dto` — 11) · Session Manager 3 · ops-консоль 5 ·
диаризация (pytest) · iOS (Swift Testing). Coverage backend — `npm run test:coverage --workspace=@hr-helper/nestjs-api-v2`.
❌ Тесты `packages/dto` не подключены (нет скрипта `test:run`) · ❌ `ci-packages.yml` не запускает тесты пакетов.
Карта слоёв и команд — `docs/qa/README.md`; роль QA — `docs/qa/CLAUDE.md`; Playwright — `apps/frontend/e2e/CLAUDE.md`.

## Приоритеты покрытия (P0 → P3)

**P0 (релиз-критичные — добавлять немедленно при изменении):**
- Auth: login, refresh, 2FA, logout
- RBAC: permission matrix, tenant isolation
- AgentInvokerService: invoke routing, fallback
- BaseAgent: run lifecycle (enabled check → HITL check → runImpl → runLog)

**P1 (при каждой новой фиче):**
- Новый агент → unit тест с mock AI provider
- Новый controller → e2e тест через supertest
- Изменённый mapper/transformer → unit тест

**P2 (happy path):**
- AI providers: mock SDK, тест primary→fallback логики
- Zod schemas: parse success + parse failure cases

**P3 (edge cases — по мере времени):**
- Concurrent agent calls
- Outbox processor double-processing prevention

## Что тестировать

✅ Pure functions, mappers, Zod schemas, regression на баг
✅ Агентная логика (BaseAgent.run lifecycle)
✅ AI provider fallback логика
❌ God Methods целиком до декомпозиции (декомпозировать сначала)

## Где размещать

- Colocated `*.spec.ts` или `features/<domain>/__tests__/`
- Mock/fixtures → `examples/`, не в `features/`

## Frontend (Vitest)

```typescript
// vitest.config.ts уже настроен
// Тестировать: hooks, utils, Zod schemas, context logic
describe('useQueryKey', () => {
  it('should return unique key per params', () => { ... })
})
```

## Backend (@nestjs/testing + Vitest — `vi.fn()`, не `jest.fn()`)

```typescript
// Unit тест агента с mock AI provider
describe('SalaryRangeAnalystAgent', () => {
  let agent: SalaryRangeAnalystAgent

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SalaryRangeAnalystAgent,
        { provide: AiExecutionLayerService, useValue: mockAiService },
        { provide: AgentRegistryService, useValue: mockRegistry },
        { provide: AgentRunLogService, useValue: mockRunLog },
        { provide: AgentHitlService, useValue: { requiresApproval: vi.fn().mockResolvedValue(false) } },
      ],
    }).compile()
    agent = module.get(SalaryRangeAnalystAgent)
  })

  it('should return salary range for valid payload', async () => {
    mockAiService.execute.mockResolvedValue({ content: '{"min": 100000, "max": 150000}' })
    const result = await agent.run({ role: 'Senior Engineer', location: 'Moscow' }, mockCtx)
    expect(result.min).toBe(100000)
  })
})
```

## PR

Новая логика → тест добавлен или обновлён. Агент без теста → комментарий WHY в PR.
