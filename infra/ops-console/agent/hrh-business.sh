#!/usr/bin/env bash
# Бизнес-метрики HR Helper для BUSINESS_CMDS агента: один вызов — одно число, только агрегаты (без
# персональных данных; компании и пользователи — те же определения, что видит ИИ-совет). Ставится в
# /opt/hrh-ops вместе с агентом (install.sh).
#
#   BUSINESS_CMDS={"companies":"/opt/hrh-ops/hrh-business.sh companies", … — полный список в docs/ops/p0-slo-alerts.md}
#   BUSINESS_INTERVAL_SEC=300   (окна правил P0 рассчитаны на 300 с и отчёт агента раз в 15 с)
#
# Ключ метрики уходит в консоль как biz_<ключ> — по нему заведены правила алертов (P0: STT, Telegram, токены).
# Postgres — в контейнере стека: HRH_PG_CONTAINER (по умолчанию backend-postgres-1). Запрос — только чтение,
# с таймаутами: зависшая база не держит агента, а метрика просто пропускает интервал.
# Метрики приложения — из /metrics backend и Session Manager внутри их контейнеров (в сеть стека агент не ходит),
# ответы API Telegram — из журнала nginx (docker logs). Сбой чтения — код выхода ≠ 0 и пустой вывод: агент
# пропускает ключ и сообщает о нём консоли, а не присылает 0.
# Выселения сессий считаются за последний час по истории значений счётчика: она лежит в HRH_STATE_DIR, по
# умолчанию — StateDirectory юнита агента (/var/lib/hrh-ops; остальная ФС для агента только на чтение).
set -euo pipefail

pg="${HRH_PG_CONTAINER:-backend-postgres-1}"
backend="${HRH_BACKEND_CONTAINER:-backend-backend-1}"
sm="${HRH_SM_CONTAINER:-backend-telegram-sessions-1}"
nginx="${HRH_NGINX_CONTAINER:-backend-nginx-1}"
redis_queue="${HRH_REDIS_QUEUE_CONTAINER:-backend-redis-queue-1}"
state_dir="${HRH_STATE_DIR:-${STATE_DIRECTORY:-/var/lib/hrh-ops}}"

# Учётные данные — из окружения самого контейнера Postgres: на хосте они не хранятся.
pg_value() {
  timeout 15 docker exec -i \
    -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5s -c lock_timeout=1s' \
    "$pg" sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" -Atq -v ON_ERROR_STOP=1' <<<"$1"
}

# Текст /metrics процесса изнутри его контейнера: адрес фиксирован, наружу ничего не открывается.
metrics_of() {
  timeout 15 docker exec "$1" node -e "fetch('$2').then(r=>r.ok?r.text():Promise.reject(r.status)).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))"
}

# Сумма значений метрики Prometheus (все серии с этим именем) из текста /metrics. С --required серии обязаны быть:
# их нет (backend не достучался до Redis, процесс не тот) — код 1, а не «0, всё в норме».
metric_sum() {
  local required=0
  [ "$1" = --required ] && { required=1; shift; }
  awk -v name="$1" -v req="$required" '$1 == name || index($1, name "{") == 1 { s += $NF; n++ }
    END { if (req && !n) exit 1; print s + 0 }'
}

# Секунд с запуска контейнера (docker inspect, без exec). Вызывать как up=$(uptime_of …): внутри $(…) bash не
# выходит по set -e сам, поэтому сбой — явный exit 1, иначе date -d "" дал бы «полночь» и ложный малый аптайм.
uptime_of() {
  local started
  started=$(timeout 10 docker inspect -f '{{.State.StartedAt}}' "$1") || exit 1
  [ -n "$started" ] || exit 1
  echo $(( $(date +%s) - $(date -d "$started" +%s) ))
}

# Выселения сессий за последний час: сумма приростов счётчика по истории замеров («время значение» построчно,
# хранится 65 минут). Падение счётчика — перезапуск SM, тогда прирост = значение. Первый замер — 0. Сначала запись
# истории, потом вывод: не сохранилось — нет и числа.
evictions_last_hour() {
  local value="$1" f="$state_dir/tg_evictions" now
  now=$(date +%s)
  mkdir -p "$state_dir"
  { if [ -f "$f" ]; then awk -v now="$now" 'NF == 2 && $1 >= now - 3900 && $1 < now' "$f"; fi; echo "$now $value"; } >"$f.tmp"
  mv "$f.tmp" "$f"
  awk -v now="$now" 'NR > 1 && $1 >= now - 3600 { s += ($2 >= p) ? $2 - p : $2 } { p = $2 } END { print s + 0 }' "$f"
}

# Доля ошибок среди ответов nginx на /api/v1/integrations/telegram/* за 5 минут (интервал замера), %. nginx видит и
# ошибки, которые backend бросает исключением, и 502, когда backend лежит: счётчик запросов backend пишет только
# успешно завершённые. Журнал — combined: путь в поле 7, код ответа в поле 9, время в поле 4.
#   $1 = 5xx — ошибки платформы: все 5xx, кроме 503 (backend упал или не отвечает, ошибка кода) — critical;
#   $1 = 503 — отказы по аккаунтам: backend отвечает 503 на circuit breaker SM, FLOOD_WAIT, конфликт владения
#              сессией, таймаут MTProto. Это проблема одного аккаунта, а не платформы — warning.
#   (nginx сам 503 не отдаёт: limit_req_status 429.)
# Меньше трёх ошибок за 5 минут — 0: одиночный ночной сбой не должен будить. Ошибки должны быть хотя бы в 3 разных
# минутах окна: короткий всплеск на стыке двух замеров не даёт «два замера подряд» (правило ждёт ≥ 6 минут ошибок —
# «> 5 % 10 минут» таблицы 16.10). Первые 8 минут после запуска backend или SM — 0: 502/503 деплоя (до ~3 минут
# простоя и загрузка) попадают в окно, которое заканчивается раньше. Упавший и не поднявшийся backend так не
# прячется — его StartedAt не меняется.
tg_api_pct() {
  local mode="$1" log up_backend up_sm
  up_backend=$(uptime_of "$backend")
  up_sm=$(uptime_of "$sm")
  if [ "$up_backend" -lt 480 ] || [ "$up_sm" -lt 480 ]; then echo 0.00; return; fi
  log=$(timeout 20 docker logs --since 300s --tail 50000 "$nginx" 2>/dev/null)
  awk -v mode="$mode" '$7 ~ /^\/api\/v1\/integrations\/telegram\// {
      t++
      bad = (mode == "503") ? ($9 == "503") : ($9 ~ /^5[0-9][0-9]$/ && $9 != "503")
      if (bad) { e++; m[substr($4, 2, 17)] = 1 }
    }
    END { n = 0; for (k in m) n++; printf "%.2f\n", (t > 0 && e >= 3 && n >= 3) ? e * 100 / t : 0 }' <<<"$log"
}

case "${1:-}" in
  companies) pg_value 'select count(*) from tenant_companies where is_active' ;;
  users) pg_value 'select count(*) from tenant_users where is_active' ;;
  db_size_mb) pg_value 'select pg_database_size(current_database()) / 1048576' ;;

  # ── Расшифровка встреч (STT) ──────────────────────────────────────────────
  # Только сбои распознавания: тексты meeting-transcription.service.ts начинаются с «Распознавание» (не удалось,
  # прервалось). Скачивание по ссылке и приём частей падают со своими текстами — это не whisper.
  stt_failed_1h) pg_value "select count(*) from tenant_meeting_recordings where status = 'failed'
    and error_text like 'Распознавание%' and updated_at > now() - interval '1 hour'" ;;
  # Готовые записи, у которых разметка говорящих не выполнилась: транскрипт есть, говорящих нет, и без пометки запись
  # не отличить от разговора одного человека. Тексты пометок — apps/backend/…/stt/meeting-stt.constants.ts
  # («Разметка говорящих не выполнена: …» — сбой, пропавшее аудио, никого не нашла) и meeting-rediarization.service.ts
  # («Повторная диаризация не удалась/прервалась»). Успешная переразметка пометку снимает.
  stt_diarization_failed_1h) pg_value "select count(*) from tenant_meeting_recordings where status = 'ready'
    and (error_text like 'Разметка говорящих не выполнена%' or error_text like 'Повторная диаризация%')
    and updated_at > now() - interval '1 hour'" ;;
  # processing дольше порога: 4 ч, для файлов больше 1,5 ГБ (PS-03) — 6 ч, но не меньше двух длительностей записи,
  # если она известна (whisper на CPU идёт примерно со скоростью звука). Во время распознавания строка не
  # обновляется, а каждый повтор задачи (release → claim) заново ставит processing и сдвигает updated_at.
  stt_stuck) pg_value "select count(*) from tenant_meeting_recordings where status = 'processing'
    and updated_at < now() - greatest(
      case when coalesce(size_bytes, 0) > 1610612736 then interval '6 hours' else interval '4 hours' end,
      coalesce(duration_sec, 0) * 2 * interval '1 second')" ;;
  # Записи без задачи распознавания. Каждой uploaded соответствует задача в waiting или delayed очереди meeting-stt
  # (active уже перевела запись в processing). uploaded старше 30 минут сверх числа таких задач потеряны: сбой
  # постановки только пишется в лог, а Redis без сохранения теряет очереди при перезапуске. Задачи диаризации в той
  # же очереди дают недосчёт, не ложную тревогу.
  stt_orphaned)
    text=$(metrics_of "$backend" 'http://127.0.0.1:3001/api/v1/metrics')
    jobs=$(awk '/^hr_helper_bullmq_(waiting|delayed)_total\{/ && /queue="meeting-stt"/ { s += $NF; n++ } END { if (!n) exit 1; printf "%d\n", s }' <<<"$text")
    uploaded=$(pg_value "select count(*) from tenant_meeting_recordings where status = 'uploaded' and updated_at < now() - interval '30 minutes'")
    echo $(( uploaded > jobs ? uploaded - jobs : 0 )) ;;
  stt_queue_waiting)
    text=$(metrics_of "$backend" 'http://127.0.0.1:3001/api/v1/metrics')
    # Серии нет, когда backend не достучался до Redis: это сбой чтения, а не пустая очередь.
    awk '/^hr_helper_bullmq_waiting_total\{/ && /queue="meeting-stt"/ { s += $NF; n++ } END { if (!n) exit 1; print s + 0 }' <<<"$text" ;;

  # ── Telegram ──────────────────────────────────────────────────────────────
  tg_api_5xx_pct) tg_api_pct 5xx ;;
  tg_api_503_pct) tg_api_pct 503 ;;
  tg_evictions_1h)
    text=$(metrics_of "$sm" 'http://127.0.0.1:3002/metrics')
    # Серии нет до первого выселения (счётчик prom-client с метками) — это 0, а не сбой.
    v=$(metric_sum telegram_session_evictions_total <<<"$text")
    evictions_last_hour "$v" ;;
  # Живые realtime-подписки backend к живым клиентам Session Manager, %. Знаменатель — пул SM, а не таблица сессий:
  # отозванная сессия остаётся строкой в telegram_user_sessions, но клиента в пуле у неё нет. Пул пуст — 100.
  # Клиента без подписки SM выселяет через 15 минут простоя, поэтому правило ждёт 2 замера, а не 3–4.
  # Первые 12 минут после запуска backend — 100: подписки восстанавливает крон раз в 10 минут (деплой — не авария).
  tg_subs_coverage_pct)
    up=$(uptime_of "$backend")
    if [ "$up" -lt 720 ]; then echo 100; exit 0; fi
    text=$(metrics_of "$backend" 'http://127.0.0.1:3001/api/v1/metrics')
    active=$(metric_sum hr_helper_telegram_subscriptions_active <<<"$text")
    text=$(metrics_of "$sm" 'http://127.0.0.1:3002/metrics')
    pool=$(metric_sum --required telegram_active_sessions <<<"$text")
    awk -v a="$active" -v p="$pool" 'BEGIN { c = (p > 0) ? a * 100 / p : 100; printf "%.1f\n", (c > 100) ? 100 : c }' ;;

  # ── Очереди BullMQ ─────────────────────────────────────────────────────────
  # Заполненность Redis очередей, % от maxmemory. Он не вытесняет ключи (noeviction): при заполнении постановка любой
  # задачи падает с ошибкой, поэтому тревога — заранее. maxmemory не задан — сбой чтения, а не 0.
  redis_queue_mem_pct)
    info=$(timeout 10 docker exec "$redis_queue" redis-cli info memory | tr -d '\r')
    awk -F: '$1 == "used_memory" { u = $2 } $1 == "maxmemory" { m = $2 }
      END { if (m + 0 <= 0) exit 1; printf "%.1f\n", u * 100 / m }' <<<"$info" ;;

  # ── Токены Huntflow (компании и личные подключения) ────────────────────────
  # Те же подключения, что обходит планировщик обновления (huntflow-token-refresh.scheduler.ts): активные компании;
  # личные пары — активных пользователей в активных компаниях с режимом per_user или both, кроме выбравших в режиме
  # both общий токен или отключивших личный. Метка у подключения вне этого круга не сбросится никогда — его не
  # считаем. Песочница не в счёт. OFFSET 0 не даёт встроить подзапрос: JSON (сотни КБ у компаний) разбирается один
  # раз на строку — тот же приём, что в huntflow-token-refresh.repository.ts.
  hf_refresh_rejected | hf_refresh_errors_6h)
    if [ "$1" = hf_refresh_rejected ]; then
      cond="coalesce(btrim(j ->> 'refreshToken'), '') <> '' and j ->> 'refreshRejectedAtIso' is not null"
    else
      # Отклонённую пару уже сообщает hf_refresh_rejected (critical) — второй раз её не считаем.
      # Время сравнивается текстом, без приведения: строки toISOString() в UTC сортируются как время, а неверная
      # дата с правильным префиксом («2026-13-45T…») не роняет весь запрос ошибкой ::timestamptz.
      cond="j ->> 'lastRefreshError' is not null and j ->> 'refreshRejectedAtIso' is null
        and j ->> 'lastRefreshAttemptAtIso' ~ '^\d{4}-\d{2}-\d{2}T'
        and j ->> 'lastRefreshAttemptAtIso' > to_char((now() at time zone 'utc') - interval '6 hours', 'YYYY-MM-DD\"T\"HH24:MI:SS')"
    fi
    pg_value "with c as (
        select id, recruiting_content_json #> '{integrations,huntflow_v1}' j from tenant_companies where is_active offset 0
      ), u as (
        select u.profile_extras_json #> '{huntflow_integration_v1}' j, c.j ->> 'credentialScope' scope
        from tenant_users u join c on c.id = u.company_id
        where u.is_active and c.j ->> 'credentialScope' in ('per_user', 'both') offset 0
      ), x as (
        select j from c
        union all
        select j from u where not (scope = 'both' and coalesce(j ->> 'credentialSource', '') in ('company', 'disabled'))
      )
      select count(*) from x where jsonb_typeof(j) = 'object' and coalesce(j ->> 'activeSystem', '') <> 'sandbox' and $cond" ;;

  *)
    echo "использование: $0 companies|users|db_size_mb|stt_failed_1h|stt_diarization_failed_1h|stt_stuck|stt_orphaned|stt_queue_waiting|tg_api_5xx_pct|tg_api_503_pct|tg_evictions_1h|tg_subs_coverage_pct|redis_queue_mem_pct|hf_refresh_rejected|hf_refresh_errors_6h" >&2
    exit 2
    ;;
esac
