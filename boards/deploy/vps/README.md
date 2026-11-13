# t-boards on the VPS (scheme A)

t-boards answers only inside WireGuard: `https://d4dev.admin.hrhelper.space` from a device in the tunnel. The public
A record exists only so Let's Encrypt can issue the certificate over HTTP-01. The product's other subdomains stay
public and need no tunnel.

Each device joins in one of two modes, chosen per peer:

- **split** — only `10.77.0.0/24` goes through the tunnel; everything else leaves the device as usual.
- **full** — all traffic goes through the VPS and reaches the internet from its address, like an ordinary VPN. The
  product's public sites on the same VPS still land on the edge nginx.

In both modes the device maps the subdomain to the tunnel address: `10.77.0.1 d4dev.admin.hrhelper.space` in
`/etc/hosts`. Public DNS points at the VPS's public address, where the edge nginx answers.

```
Mac ──WireGuard 10.77.0.2 → 10.77.0.1:51820/udp──▶ VPS
    https://d4dev…:443 ── wg0, -d 10.77.0.1, REDIRECT 443→8443 ──▶ tls (nginx, host network, 10.77.0.1:8443)
                                                    └─▶ app 127.0.0.1:5180 (kaneo image: nginx :5173 + API :1337)
                                                         └─▶ postgres 16 (own volume, no ports)
    full mode, everything else ── TB-WG chain ── MASQUERADE out of the external interface ──▶ internet
                                                    backup: pg_dump -Fc every 2 h → /opt/t-boards/backups
Mac LaunchAgent ── ssh over the tunnel, forced `cat latest.dump` ──▶ ~/t-boards-backups (copy off the VPS)
```

The product's edge nginx keeps `0.0.0.0:443`. That is why t-boards has its own TLS terminator on the tunnel address
and the redirect rule lives in the tunnel's rules script. The product's certbot sidecar renews every certificate in its volume,
ours included. The `tls` container reloads every 12 h to pick up the renewed certificate.

wg-quick runs `/etc/wireguard/t-boards-rules.sh up|down` on start and stop. The script holds every firewall rule of
the tunnel:

- 443 to `10.77.0.1` is redirected to 8443;
- tunnel traffic is NATed out of the external interface;
- nothing from outside may address `10.77.0.0/24`;
- the `TB-WG` chain is hooked into `FORWARD` and Docker's `DOCKER-USER` and rebuilt in order on every start. When wg0
  starts before Docker, the script creates `DOCKER-USER` and Docker keeps it. It lets
  the tunnel reach the internet and the product's published ports, the same reach the internet has, and drops the
  rest, so the VPS's internal Docker networks stay out of reach. Containers may not open connections into the
  tunnel. The one exception is the app (bridge `br-tboards`, address `10.78.0.2`, both fixed in `compose.yml`) to the
  Mac's claude-mem proxy (`CLAUDE_MEM_WORKER_HOST:PORT` from `/opt/t-boards/.env`), and only its replies come back.
  postgres and backup on the same bridge and other containers cannot reach it, nor the Mac's other ports. The VPS
  host and host-network containers cannot reach the proxy either (chain `TB-WG-OUT` in `OUTPUT`); the Mac's other
  ports stay open to them, as before. Behind the filter the proxy also asks for a token (see «Memory proxy token»).
  After changing that address in `.env`, re-run
  `wg-setup.sh` with the Mac's key; `install.sh` warns while the rules disagree and stops if the app did not get its
  address (subnet `10.78.0.0/28` taken).

`ip_forward` stays on through `/etc/sysctl.d/99-t-boards-wg.conf`.

## Files

| File | Where it runs | What it does |
|---|---|---|
| `wg-setup.sh` | VPS | `wg-setup.sh <public key> <device> split\|full`. The first run creates wg0 (10.77.0.0/24, UDP 51820) and the rules script. Later runs add a peer and upgrade a wg0 from the first kit. Prints the config block for the device with `MTU = 1380`. A new peer gets a PresharedKey, printed once in that block; a peer that is already there is never given one, since that would cut off the device |
| `wg-issue.sh` | VPS | `wg-issue.sh <device> split\|full` makes the keypair and the PresharedKey on the VPS and prints a ready profile (stdout) and a QR (stderr). Both carry the device's private key and PresharedKey: save the profile as `(umask 077; ssh root@VPS 'bash /opt/t-boards/wg-issue.sh phone split' > phone.conf)` and delete it after the import, never redirect stderr to a file or a log, and do not run it through an agent, whose transcript would keep the keys. `--revoke <device>` removes the peer |
| `wg-psk.sh` | VPS | Sets or removes the PresharedKey of one peer by its tunnel address. The address is required. The key never goes into argv or shell history: `ssh -t root@VPS 'bash /opt/t-boards/wg-psk.sh 10.77.0.2'` asks for it with hidden input, or `wg genpsk \| tee >(pbcopy) \| ssh root@VPS 'bash /opt/t-boards/wg-psk.sh 10.77.0.2'`; clear the clipboard after pasting it on the device. Rollback `bash wg-psk.sh --remove 10.77.0.2`. Not through `base64 -d \| bash`: there stdin is the script itself, and wg-psk.sh would read its tail as the key. A failed run leaves `wg0.conf.bak-psk` and prints the rollback, which clears that peer's live key first (an older `wg syncconf` keeps it); the next run stops and prints it again until it is used |
| `wg-selftest.sh` | Mac | Runs the three scripts above in a privileged container with real iptables. Covers split, full, a re-run, PresharedKey and MTU, the shared lock in all three, wg-psk.sh on the live interface and its refusals, backup retention (idle re-runs, several edits in one second, a clock set back, the stop at the 99th) and file modes, live packets to the memory proxy (only the app gets through, also after a Docker restart and when wg0 starts before Docker), the `install.sh` check of those rules, the first-kit upgrade and stop |
| `bundle.sh` | Mac | Packs the amd64 image and these files into `t-boards-<tag>.tar` and writes its sha256 |
| `install.sh` | VPS | Preflight, certificate, secrets, `docker load`, a dump before the update, `up`, health, migrations = journal, admin seed, products seed, a smoke check through TLS |
| `seed/products.json` | VPS, app container | The products (workspaces), their projects and the starting cards. Re-running adds only what is missing and never changes an existing card |
| `compose.yml` | VPS | postgres, app, tls, backup |
| `tls.conf.template` | VPS | `install.sh` renders it into `/opt/t-boards/tls.conf` |
| `backup.sh` | VPS, backup container | Dumps every 2 h and checks each dump with `pg_restore --list`. Keeps 3 days; `latest.dump` points at the newest |
| `mirror-setup.sh` | VPS | Turns the Notion mirror on: asks for the token, checks it reads every database, writes the workspace and databases into `.env`, recreates the app |
| `backup-key.sh` | VPS | Adds the Mac pull key with `restrict`, `from="10.77.0.2"` and `command="cat latest.dump"` |
| `mac/backup-agent.sh` | Mac | `key` / `install` / `remove` for the pull key and the LaunchAgent, which runs every 2 h |
| `mac/pull-backup.sh` | Mac, launchd | Pulls `latest.dump`, checks the `PGDMP` header, skips duplicates, keeps 14 days |
| `mac/restore-check.sh` | Mac | AC-004: restores a dump into a throwaway Postgres and prints the row counts |
| `mac/memory-agent.sh` | Mac | `token` / `install` / `check` / `remove` for the read-only claude-mem proxy `mac/memory-proxy.mjs` (LaunchAgent). `token` makes `~/.t-boards-memory/proxy_token` once (600, directory 700) and never prints it. `check` expects 401 without the header, 200 with it and 405 for POST; without the token file, 200 and 405 |
| `mac/memory-token-push.sh` | Mac | `memory-token-push.sh <vps host>` sends that token to `secrets/claude_mem_proxy_token` on ssh's stdin (never argv, stdout or history), then `up -d app` |
| `selftest.sh` | Mac | Proves the whole kit locally before a delivery |

## Secrets

All secrets live in `/opt/t-boards/secrets` (directory mode 0711). They are passed only as `*_FILE`, never as
environment variables (N-007).

| File | Mode and owner |
|---|---|
| `postgres_password` | 0440, owner 70:1001. Postgres reads it as uid 70, the app as gid 1001 |
| `auth_secret` | 0400, owner 1001 |
| `settings_key` | 0400, owner 1001. Seals the notebook model key an instance admin saves in the settings |
| `notion_token` | 0400, owner 1001. Optional: the owner puts it there |
| `notebook_llm_key` | 0400, owner 1001. Optional: the model key for the server's own API address |
| `oq_token` | 0400, owner 1001. The owner-queue agent token of t-boards (TB-102, «Owner queue» below). The owner issues it in the ops-console; `install.sh` never makes it. Read on every call |
| `ssr_push_github_token` | 0400, owner 1001. Optional: the GitHub token of SSR push-back (TB-116, «SSR push-back» below). The owner puts it there; `install.sh` never makes it and logs one line while it is missing. Read on every push |
| `claude_mem_proxy_token` | 0400, owner 1001. The Mac memory proxy token (OPS-19). The Mac owns it: `mac/memory-agent.sh token` makes it, `mac/memory-token-push.sh` delivers it. `install.sh` never makes it and warns while it is missing. The app reads it on every request |

`install.sh` generates the first three once and never overwrites them. The database password only takes effect when the
volume is first initialised. A replaced `settings_key` leaves the saved model key unreadable: the admin enters it again.
The app reads `settings_key` once at start, so a new one needs `docker compose -p t-boards up -d app`; anything shorter
than 32 characters counts as no key.

## Memory proxy token

The tunnel filter lets only the app open connections to the Mac's claude-mem proxy, but it cannot see past the VPS
host: root there, or anything with a raw socket in the host's network, can still talk to the proxy. So the proxy
also wants the header `x-cmem-proxy-token` (OPS-19). It compares it in constant time and answers 401 with an empty
body when the header is missing or wrong. The peer allowlist and the GET-only rule stay as they were. The proxy reads
`~/.t-boards-memory/proxy_token` (`CMEM_PROXY_TOKEN_FILE`) at start. Without that file it runs as before and logs one
warning (rollout mode). A file that is there but unreadable or shorter than 32 characters stops it. The app reads
`/run/tb-secrets/claude_mem_proxy_token` (`CLAUDE_MEM_PROXY_TOKEN_FILE`) on every request and sends no header while it
is missing. Neither side logs the token.

Rollout, in this order (the app must send the header before the proxy asks for it):

1. Mac: `boards/deploy/vps/mac/memory-agent.sh token`. The running proxy does not change yet.
2. Mac: `boards/deploy/vps/mac/memory-token-push.sh <vps host>`.
3. Deploy the b16 bundle (`install.sh`). The app sends the header, and the proxy still accepts reads without it.
4. Mac: `memory-agent.sh install`. The proxy restarts and now requires the token; its `check` prints 401 / 200 / 405.
5. Acceptance, on the VPS in `/opt/t-boards`:
   - `docker inspect t-boards-tls-1 --format '{{.HostConfig.CapDrop}}'` shows `[NET_RAW]`. Every host-network container
     and its dropped capabilities:
     `docker ps -q | xargs docker inspect --format '{{.Name}} {{.HostConfig.NetworkMode}} {{.HostConfig.CapDrop}}' | awk '$2 == "host"'`;
   - from the host, `curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://10.77.0.2:37702/api/health` prints `000`,
     because `TB-WG-OUT` drops it. If it ever gets an answer, that answer must be 401;
   - from the app without the header, 401:
     `docker compose -p t-boards exec -T app node -e 'fetch("http://10.77.0.2:37702/api/health").then(r => console.log(r.status))'`;
   - the app reads memory, 200:
     `docker compose -p t-boards exec -T app node -e 'const t = require("fs").readFileSync(process.env.CLAUDE_MEM_PROXY_TOKEN_FILE, "utf8").trim(); fetch("http://10.77.0.2:37702/api/health", { headers: { "x-cmem-proxy-token": t } }).then(r => console.log(r.status))'`.
     A card's memory is no longer marked stale.
   - A repeated `install.sh` leaves the file in `secrets/` as it is.

Rollback: on the Mac `rm ~/.t-boards-memory/proxy_token && boards/deploy/vps/mac/memory-agent.sh install`. The
proxy is back in rollout mode, and the app's header no longer matters. Rotation: delete the Mac file, then run
`token`, `memory-token-push.sh` and `install` again. Between the push and the restart, reads get 401 for a few seconds.

## Notion mirror

The mirror is off until `NOTION_MIRROR_WORKSPACE_ID` and `NOTION_MIRROR_DATABASES` are filled in
`/opt/t-boards/.env` and the token file exists. `bash /opt/t-boards/mirror-setup.sh` does all three. It mirrors into
the HR Helper / Lavaeon product, which `install.sh` creates. By default it lists «Задачи» and «Ошибки» plus `all`: every other
database shared with the integration (… → Connections in Notion) is looked up on each run and mirrored after them.
If the connect form refuses a database, it now names it: open that database in Notion → ⋯ → Connections and add the
integration. A wrong token gets its own message.

## Owner queue (TB-102)

t-boards puts every pending «да» request into the owner queue (ops-console) as an item `d-tba-<id>-<nonce>` and
applies the owner's answer itself. It is off until all four are set:

1. In the ops-console, issue an agent token named `t-boards` (scope `agent`, products `hr-helper`). The name is
   `OQ_TOKEN_NAME`: an item whose last writer has another name is treated as edited by someone else (R-4). The queue
   journal writes the author as `token:<name>`; t-boards adds the prefix itself, so `t-boards` and `token:t-boards` both
   work (TB-111).
2. Put the token into `/opt/t-boards/secrets/oq_token` (0400, owner 1001), never on the command line:
   `install -m 0400 -o 1001 /dev/stdin /opt/t-boards/secrets/oq_token`, then paste and Ctrl-D.
3. Add to `/opt/t-boards/.env`: `OQ_URL=https://ops.admin.hrhelper.space`, `OQ_TOKEN_NAME=t-boards`,
   `OQ_WORKSPACE_PRODUCTS=<workspaceId>=hr-helper,<workspaceId>=hr-helper` (Lavaeon and aiBoards&eval; a workspace not
   listed gets no items, only the t-boards UI).
4. `cd /opt/t-boards && docker compose -p t-boards up -d app`.

`install.sh` keeps the `OQ_*` lines of `.env` on every update. Off again: remove the three lines and `up -d app`.
While it is off, the journal has one `queue.skip` row per start and «да» works in the t-boards UI.

## SSR push-back (TB-93, TB-116)

The app commits the served SSR versions back into each product's repo: right after a rollback and nightly
(scheduler `10 3 * * *`). Each workspace pushes only into the repo that `SSR_PUSH_REPOS` names for it. It is off until both are
set:

1. On GitHub, make a fine-grained token: repository access — only the repos listed in `SSR_PUSH_REPOS`; permission
   Contents — read and write. Nothing else.
2. Put it into `/opt/t-boards/secrets/ssr_push_github_token` (0400, owner 1001), never on the command line or the
   screen. In bash on the VPS run the line below, paste the token (it is not echoed) and press Enter:
   `read -rs T && printf '%s\n' "$T" | install -m 0400 -o 1001 /dev/stdin /opt/t-boards/secrets/ssr_push_github_token; unset T`.
   `printf` is a bash builtin, so the token is not in any process's arguments.
3. Add to `/opt/t-boards/.env`: `SSR_PUSH_REPOS=<workspaceId>=<owner>/<repo>,<workspaceId>=<owner>/<repo>`.
4. `cd /opt/t-boards && docker compose -p t-boards up -d app`.
5. Check, without printing the token:
   `docker compose -p t-boards exec -T app node -e 'let t = ""; try { t = require("fs").readFileSync(process.env.SSR_PUSH_GITHUB_TOKEN_FILE, "utf8").trim(); } catch {} console.log(t ? "token: present" : "token: missing", "| repos:", process.env.SSR_PUSH_REPOS || "(none)")'`.
   That GitHub takes the token for a repo (200; 401 — a wrong token, 404 — the repo is not in its access list):
   `docker compose -p t-boards exec -T app node -e 'const t = require("fs").readFileSync(process.env.SSR_PUSH_GITHUB_TOKEN_FILE, "utf8").trim(); fetch("https://api.github.com/repos/<owner>/<repo>", { headers: { Authorization: "Bearer " + t } }).then(r => console.log(r.status))'`.

The app reads the token file on every push, so a rotation is a new file, with no restart. Without the file the nightly
job logs one line `SSR push-back skipped: no GitHub token: …` and a rollback answers `push.reason: "not_configured"`.
`install.sh` keeps the `SSR_PUSH_REPOS` line of `.env` on every update and logs one line while the token file is
missing. The old `SSR_PUSH_GITHUB_TOKEN` and `SSR_PUSH_GITHUB_REPO` variables are ignored. Off again: delete the token
file.

## Agents' MCP on the Mac (TB-105)

The agents reach t-boards through the MCP hub on the Mac. The hub runs `boards/packages/mcp/dist` of the main tAIBE
checkout (`infra/scripts/dev-ai/mcp-t-boards.sh`), not the image. A delivery updates only the server. If the delivery
changes `boards/packages/mcp` (a new tool or field), do this after it on the Mac:

1. `git pull` in the main tAIBE checkout, then `(cd boards/packages/mcp && pnpm run build)`.
2. Restart the t-boards child of the hub: `pkill -TERM -f 'node <tAIBE>/boards/packages/mcp/dist/index.js'`. The hub
   starts it again in a few seconds. Other hub servers keep running.
3. Sessions with a cached tool schema reconnect the hub (`/mcp`).

`npm run mcp-hub:status` and `mcp-hub:check` warn when the source is newer than the build or the running process is
older than the build. On 12.11 a stale build dropped `doneRef`, and no agent could request `close_task`.

## Products

`install.sh` seeds three products owned by the admin: HR Helper / Lavaeon, aiBoards&eval and Financial terminal.
aiBoards&eval carries the plan of t-boards, supertick-eval, the infrastructure, the admin host, ideas and goals as a
tree of cards (`TB-…`, `SE-…`, `OPS-…`, `ADM-…`, `IDEA-…`, `GL-…`) with their links and agent fields.
The card key is stored as the card's backlog id, so a later bundle adds new cards and links, brings cards nobody has
edited to the plan (journaled under `seed:products`, undone from the card's history) and leaves edited ones alone.

## Rollback

- **Release:** `cd /opt/t-boards && cp .env.prev .env && docker compose -p t-boards up -d`. A dump taken before every
  update lies in `backups/pre-<tag>-*.dump`.
- **Stop everything:** `docker compose -p t-boards down`. Never add `-v`: the database volume is the only live copy.
- **WireGuard:** `systemctl disable --now wg-quick@wg0 && mv /etc/wireguard/wg0.conf /etc/wireguard/wg0.conf.off && rm -f /etc/sysctl.d/99-t-boards-wg.conf`.
  Stopping wg0 removes every rule. Each change by `wg-setup.sh` or `wg-issue.sh` keeps the previous config as
  `wg0.conf.bak-<time>`; only the newest three stay, since they hold the server PrivateKey. A re-run that changes nothing makes no copy. The three scripts take one
  lock, `wg0.conf.lock`, so they never rewrite the file over each other.
- **Backup key:** `sed -i '/t-boards-backup$/d' /root/.ssh/authorized_keys`.

## Known limits

- Image uploads need S3 (`isStorageConfigured`). None is configured, so uploads are off. All data lives in Postgres
  and is covered by the dump.
- `NOTIFICATION_SECRET_ENCRYPTION_KEY` is read only from env. Notification channels that store secrets stay off until
  the variable supports `_FILE`.
- Memory limits (app 1 GB, postgres 256 MB) are provisional until the K-6 measurements (R-005).
- A device without `/etc/hosts` (a phone) needs a DNS override for the subdomain. There is no DNS server in the
  tunnel yet.
- The backup pull key accepts only `10.77.0.2`, the first peer. The Mac has to be added first.
- The memory proxy token travels as plain HTTP inside the tunnel. Whoever can listen on wg0 on the VPS can read it:
  root on the host, or a host-network container with `NET_RAW`. The `tls` container drops `NET_RAW`. The product's
  own host-network containers are outside this kit; the acceptance command above lists them. Root on the VPS can also
  read the secret file itself.
- From the VPS itself, `10.77.0.1:443` reaches the edge nginx: Docker's OUTPUT DNAT takes it. Local clients on the
  VPS (bot, runner) use `10.77.0.1:8443` or `127.0.0.1:5180`.
