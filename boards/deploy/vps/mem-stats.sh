#!/usr/bin/env bash
# Memory of the t-boards containers on the VPS (TB-124): samples `docker stats`
# for the first day after a deploy, then reports peak and p95 per container and
# a limit of about peak × 1.5 for compose.yml. Reads only container names and
# memory numbers; writes only its own TSV files.
#
#   mem-stats.sh sample [minutes] [step_s]   # default 1440 min, 60 s; 0 min — one sample
#   mem-stats.sh report [file.tsv]           # default — the newest file
#
# For the whole day, detached from the SSH session:
#   systemd-run --unit=tb-mem-stats --collect /opt/t-boards/mem-stats.sh sample
# Stop early: systemctl stop tb-mem-stats. Files: $TB_MEM_STATS_DIR
# (default /opt/t-boards/mem-stats), one per start, columns: UTC time, service,
# used MiB, limit MiB.
set -euo pipefail
# A decimal point in numbers whatever the SSH session's locale (ru_RU prints «307,0»).
export LC_ALL=C

PROJECT="${TB_COMPOSE_PROJECT:-t-boards}"
DIR="${TB_MEM_STATS_DIR:-/opt/t-boards/mem-stats}"

# "237.4MiB" → MiB; docker prints binary units, some versions decimal ones.
AWK_MIB='function mib(s,  n, u) {
  n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
  if (u == "B") return n / 1048576
  if (u == "KiB" || u == "kB" || u == "KB") return n / 1024
  if (u == "MiB" || u == "MB") return n
  if (u == "GiB" || u == "GB") return n * 1024
  if (u == "TiB" || u == "TB") return n * 1048576
  return -1
}'

containers() {
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT"
}

# One line per running container of the project.
sample_once() {
  local ids now
  ids="$(containers)"
  [ -n "$ids" ] || {
    echo "mem-stats: no running containers of project $PROJECT" >&2
    return 0
  }
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # shellcheck disable=SC2086 # one id per word
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' $ids |
    awk -F'\t' -v now="$now" -v project="$PROJECT" "$AWK_MIB"'
      {
        split($2, part, " / ")
        name = $1
        sub("^" project "[-_]", "", name)
        sub("[-_][0-9]+$", "", name)
        used = mib(part[1]); limit = mib(part[2])
        if (used >= 0) printf "%s\t%s\t%.1f\t%.0f\n", now, name, used, limit
      }'
}

sample() {
  local minutes="${1:-1440}" step="${2:-60}" file start
  [[ "$minutes" =~ ^[0-9]+$ && "$step" =~ ^[1-9][0-9]*$ ]] || {
    echo "mem-stats: sample [minutes] [step_s] — whole numbers" >&2
    exit 2
  }
  install -d -m 0755 "$DIR"
  file="$DIR/mem-$(date -u +%Y%m%dT%H%M%SZ).tsv"
  start="$(date +%s)"
  echo "mem-stats: $file, every $step s for $minutes min" >&2
  while :; do
    # A container recreated between `ps` and `stats` (up -d app) fails one sample, not the day.
    sample_once >>"$file" || echo "mem-stats: $(date -u +%H:%M:%SZ) sample failed, next in $step s" >&2
    [ $(($(date +%s) - start)) -lt $((minutes * 60)) ] || break
    sleep "$step"
  done
  echo "$file"
}

report() {
  local file="${1:-}"
  if [ -z "$file" ]; then
    file="$(find "$DIR" -maxdepth 1 -name 'mem-*.tsv' 2>/dev/null | sort | tail -n 1)"
  fi
  [ -n "$file" ] && [ -s "$file" ] || {
    echo "mem-stats: no samples (${file:-$DIR})" >&2
    exit 1
  }
  echo "$file: $(cut -f1 "$file" | sort -u | wc -l | tr -d ' ') samples, $(head -n 1 "$file" | cut -f1) … $(tail -n 1 "$file" | cut -f1)"
  printf '%-10s %8s %8s %8s %8s %10s\n' service samples p95_MiB peak_MiB limit suggested
  # suggested: peak × 1.5, up to a multiple of 32 MiB, not below 64 MiB.
  sort -t$'\t' -k2,2 -k3,3n "$file" |
    awk -F'\t' '
      function flush() {
        if (n == 0) return
        i = int(n * 0.95 + 0.999999); if (i < 1) i = 1
        s = int((v[n] * 1.5 + 31.999) / 32) * 32; if (s < 64) s = 64
        printf "%-10s %8d %8.0f %8.0f %7.0fm %9dm\n", svc, n, v[i], v[n], limit, s
      }
      $2 != svc { flush(); svc = $2; n = 0 }
      { v[++n] = $3; limit = $4 }
      END { flush() }'
  # A restart or an OOM kill in the window says more than any percentile.
  local id since
  for id in $(containers); do
    docker inspect -f '{{.Name}} restarts={{.RestartCount}}' "$id"
  done
  # OOM kills from the kernel log: State.OOMKilled in Docker forgets a kill once the container restarts.
  since="$(head -n 1 "$file" | cut -f1 | sed 's/T/ /; s/Z$//')"
  if ! command -v journalctl >/dev/null 2>&1; then
    echo "oom kills: no journalctl here — check dmesg | grep oom-kill"
    return 0
  fi
  journalctl -k --utc --since "$since" --no-pager 2>/dev/null | awk -v since="$since" '
    /oom-kill:/ {
      n++; task = $0; memcg = $0
      sub(/.*task=/, "", task); sub(/,.*/, "", task)
      sub(/.*oom_memcg=/, "", memcg); sub(/,.*/, "", memcg)
      last[n % 5] = "  task=" task " oom_memcg=" memcg
    }
    END {
      printf "oom kills since %s UTC: %d\n", since, n
      for (k = (n > 5 ? n - 4 : 1); k <= n; k++) print last[k % 5]
    }' || echo "oom kills: journalctl -k failed, the count above is not complete — check dmesg | grep oom-kill"
}

case "${1:-}" in
  sample) shift; sample "$@" ;;
  report) shift; report "$@" ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
