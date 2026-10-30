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
  postgres and backup on the same bridge, other containers, the VPS host and host-network containers (chain
  `TB-WG-OUT` in `OUTPUT`) cannot reach it, nor the Mac's other ports. After changing that address in `.env`, re-run
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

`install.sh` generates the first three once and never overwrites them. The database password only takes effect when the
volume is first initialised. A replaced `settings_key` leaves the saved model key unreadable: the admin enters it again.
The app reads `settings_key` once at start, so a new one needs `docker compose -p t-boards up -d app`; anything shorter
than 32 characters counts as no key.

## Notion mirror

The mirror is off until `NOTION_MIRROR_WORKSPACE_ID` and `NOTION_MIRROR_DATABASES` are filled in
`/opt/t-boards/.env` and the token file exists. `bash /opt/t-boards/mirror-setup.sh` does all three. It mirrors into
the HR Helper / Lavaeon product, which `install.sh` creates. By default it lists «Задачи» and «Ошибки» plus `all`: every other
database shared with the integration (… → Connections in Notion) is looked up on each run and mirrored after them.
If the connect form refuses a database, it now names it: open that database in Notion → ⋯ → Connections and add the
integration. A wrong token gets its own message.

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
- From the VPS itself, `10.77.0.1:443` reaches the edge nginx: Docker's OUTPUT DNAT takes it. Local clients on the
  VPS (bot, runner) use `10.77.0.1:8443` or `127.0.0.1:5180`.
