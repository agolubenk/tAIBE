"""Прайс API Claude — один на весь eval (GL-1, план замера 14.11): смена прайса — одна правка здесь.

$ за 1M токенов: (вход, выход, чтение кэша). Запись кэша — от цены входа: на 5 мин × 1,25, на 1 ч × 2. Модель
ищется по первому ключу, который входит в её имя, в порядке словаря: `opus-5-5` раньше `opus-5`. Неизвестная
модель — по `opus-5-5`. На подписке $ — мерило расхода лимита, а не счёт.

Импортируют: eval/nerve/budget.py, eval/tools/{context_audit,call_purpose,wake_anatomy,spend}.py.
"""
PRICES = {'fable': (10, 50, 0.25), 'opus-5-5': (4, 20, 0.2), 'opus-5': (5, 25, 0.5), 'opus-4': (5, 25, 0.5),
          'sonnet': (2, 10, 0.2), 'haiku-5-5': (0.1, 0.5, 0.01)}
DEFAULT = 'opus-5-5'
# Статьи расхода одного вызова — те же ключи, что в отчёте и JSON context_audit.py.
PARTS = ('вход', 'запись кэша 5 мин', 'запись кэша 1 ч', 'чтение кэша', 'выход')


def price(model):
    for k in PRICES:
        if k in (model or ''):
            return PRICES[k]
    return PRICES[DEFAULT]


def _tokens(u):
    """(вход, запись 5 мин, запись 1 ч, чтение кэша, выход) из usage ответа."""
    cw = u.get('cache_creation_input_tokens', 0) or 0
    c1 = (u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens', 0) or 0
    return (u.get('input_tokens', 0) or 0, cw - c1, c1, u.get('cache_read_input_tokens', 0) or 0,
            u.get('output_tokens', 0) or 0)


def call_cost(u, model):
    """$ одного вызова по статьям PARTS."""
    pi, po, pr = price(model)
    i, w5, w1, r, o = _tokens(u)
    return dict(zip(PARTS, (i * pi / 1e6, w5 * 1.25 * pi / 1e6, w1 * 2 * pi / 1e6, r * pr / 1e6, o * po / 1e6)))


def call_usd(u, model):
    """$ одного вызова одним числом (та же формула, что была в budget.py: суммы бит в бит прежние)."""
    pi, po, pr = price(model)
    i, w5, w1, r, o = _tokens(u)
    return (i * pi + w5 * 1.25 * pi + w1 * 2 * pi + r * pr + o * po) / 1e6


def context_tokens(u):
    """Контекст вызова: вход + запись кэша + чтение кэша."""
    i, w5, w1, r, _ = _tokens(u)
    return i + w5 + w1 + r
