"""Local RAM, disk and latency of open-notebook v1.15.1 (OPS-13, TB-66).

Analysis: docs/integrations/open-notebook/README.md. Run once, by the owner,
under the machine lock:

    .claude/scripts/heavy-gate.sh python3 -I <copy of this file> <report.json>

It runs its own compose project «tb-on-f2bs» in the folder of the copy: two
images (lfnovo/open_notebook:v1.15.1, surrealdb/surrealdb:v2), ports
127.0.0.1:15055 (API) and 127.0.0.1:18502 (UI) only, synthetic text, no model
keys, random passwords that are never printed. It writes numbers only. At the
end it removes its containers, volumes and data, and the images it pulled
itself (an image that was there before stays).
"""
import json
import os
import secrets
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = "tb-on-f2bs"
API = "http://127.0.0.1:15055"
WEB = "http://127.0.0.1:18502"
IMAGES = ["lfnovo/open_notebook:v1.15.1", "surrealdb/surrealdb:v2"]
PASSWORD = secrets.token_hex(24)

COMPOSE = f"""
services:
  surrealdb:
    image: surrealdb/surrealdb:v2
    command: ["start", "--log", "warn", "--user", "tb", "--pass", "{secrets.token_hex(16)}", "rocksdb:/mydata/mydatabase.db"]
    user: root
    volumes: ["./surreal_data:/mydata"]
  open_notebook:
    image: lfnovo/open_notebook:v1.15.1
    ports: ["127.0.0.1:18502:8502", "127.0.0.1:15055:5055"]
    environment:
      - OPEN_NOTEBOOK_ENCRYPTION_KEY={secrets.token_hex(32)}
      - OPEN_NOTEBOOK_PASSWORD={PASSWORD}
      - SURREAL_URL=ws://surrealdb:8000/rpc
      - SURREAL_USER=tb
      - SURREAL_PASSWORD=__SPASS__
      - SURREAL_NAMESPACE=open_notebook
      - SURREAL_DATABASE=open_notebook
    volumes: ["./notebook_data:/app/data"]
    depends_on: [surrealdb]
"""


def sh(*args, check=True, capture=True):
    r = subprocess.run(args, cwd=HERE, capture_output=capture, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"failed: {' '.join(args[:4])} rc={r.returncode} {r.stderr[-300:]}")
    return r.stdout


def compose(*args, **kw):
    return sh("docker", "compose", "-p", PROJECT, "-f", "compose.yml", *args, **kw)


def http(method, url, body=None, form=None, auth=True, timeout=30):
    headers = {}
    data = None
    if auth:
        headers["Authorization"] = f"Bearer {PASSWORD}"
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception:
        return 0, b""


def to_mb(text):
    num = float("".join(c for c in text if c.isdigit() or c == "."))
    unit = text.lstrip("0123456789.").strip().lower()
    return num * {"b": 1e-6, "kib": 1 / 1024, "kb": 1e-3, "mib": 1, "mb": 1, "gib": 1024, "gb": 1000}.get(unit, 1)


def stats():
    out = sh("docker", "stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}")
    rows = {}
    for line in out.splitlines():
        name, mem, cpu = line.split("|")
        if not name.startswith(PROJECT):
            continue
        rows[name.replace(PROJECT + "-", "").rsplit("-", 1)[0]] = (
            to_mb(mem.split("/")[0]),
            float(cpu.rstrip("%") or 0),
        )
    return rows


def sample(seconds, during=None):
    seen = {}
    end = time.time() + seconds
    while time.time() < end:
        if during:
            during()
        for name, (mem, cpu) in stats().items():
            seen.setdefault(name, []).append((mem, cpu))
    return {
        name: {
            "mem_avg_mb": round(statistics.mean(m for m, _ in v)),
            "mem_max_mb": round(max(m for m, _ in v)),
            "cpu_avg_pct": round(statistics.mean(c for _, c in v), 1),
        }
        for name, v in seen.items()
    }


def du_mb(path):
    out = sh("du", "-sk", path, check=False)
    return round(int(out.split()[0]) / 1024, 1) if out else 0


def present(image):
    return subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0


def main():
    # The data folders and compose.yml are made here and removed at the end:
    # refuse a folder that already has any of them.
    for name in ("compose.yml", "surreal_data", "notebook_data"):
        if os.path.exists(os.path.join(HERE, name)):
            raise SystemExit(f"{name} exists in {HERE}: run a copy in an empty folder")
    spass = COMPOSE.split('"--pass", "')[1].split('"')[0]
    with open(os.path.join(HERE, "compose.yml"), "w") as f:
        f.write(COMPOSE.replace("__SPASS__", spass))
    report = {}
    pulled = [image for image in IMAGES if not present(image)]
    t0 = time.time()
    for image in IMAGES:
        sh("docker", "pull", "-q", image)
    report["pull_s"] = round(time.time() - t0)
    report["image_mb"] = {
        i: round(int(sh("docker", "image", "inspect", "-f", "{{.Size}}", i).strip()) / 1e6)
        for i in IMAGES
    }
    try:
        t0 = time.time()
        compose("up", "-d")
        api_ready = web_ready = None
        while time.time() - t0 < 300 and not (api_ready and web_ready):
            if not api_ready and http("GET", API + "/health", auth=False, timeout=3)[0] == 200:
                api_ready = round(time.time() - t0, 1)
            if not web_ready and http("GET", WEB + "/", auth=False, timeout=3)[0] in (200, 307, 308):
                web_ready = round(time.time() - t0, 1)
            time.sleep(1)
        report["ready_s"] = {"api": api_ready, "web": web_ready}
        if not api_ready:
            report["logs_tail"] = compose("logs", "--tail", "15", "open_notebook", check=False)[-1500:]
            return report
        time.sleep(20)
        report["idle_60s"] = sample(60)

        st, body = http("POST", API + "/api/notebooks", body={"name": "tb-probe", "description": "synthetic"})
        report["notebook_create"] = st
        nb = json.loads(body or b"{}").get("id") if st == 200 else None
        words = "board card sector lease forest memory proxy queue owner lens".split()
        add_ms = []
        for i in range(20):
            text = " ".join(words[(i + j) % len(words)] + str(j % 97) for j in range(3000))
            t = time.time()
            st, _ = http(
                "POST",
                API + "/api/sources",
                form={
                    "type": "text",
                    "content": f"probe {i} " + text,
                    "title": f"probe {i}",
                    "notebooks": json.dumps([nb] if nb else []),
                    "embed": "false",
                    "async_processing": "false",
                },
                timeout=120,
            )
            add_ms.append((st, round((time.time() - t) * 1000)))
        report["source_add"] = {
            "status": sorted({s for s, _ in add_ms}),
            "p50_ms": statistics.median(ms for _, ms in add_ms),
            "max_ms": max(ms for _, ms in add_ms),
        }
        search_ms = []

        def one_search():
            t = time.time()
            st, _ = http("POST", API + "/api/search", body={"query": "lease17", "type": "text", "limit": 20})
            search_ms.append((st, (time.time() - t) * 1000))

        report["load_search"] = sample(30, during=lambda: [one_search() for _ in range(5)])
        ok = sorted(ms for s, ms in search_ms if s == 200)
        report["search"] = {
            "n": len(search_ms),
            "status": sorted({s for s, _ in search_ms}),
            "p50_ms": round(statistics.median(ok)) if ok else None,
            "p95_ms": round(ok[int(len(ok) * 0.95) - 1]) if ok else None,
        }
        report["after_load_idle_30s"] = sample(30)
        report["data_mb"] = {
            "surreal_data": du_mb(os.path.join(HERE, "surreal_data")),
            "notebook_data": du_mb(os.path.join(HERE, "notebook_data")),
        }
        report["vm_total_mb"] = round(int(sh("docker", "info", "--format", "{{.MemTotal}}").strip()) / 1e6)
    finally:
        compose("down", "-v", "--remove-orphans", check=False)
        sh("rm", "-rf", os.path.join(HERE, "surreal_data"), os.path.join(HERE, "notebook_data"), os.path.join(HERE, "compose.yml"), check=False)
        for image in pulled:
            sh("docker", "image", "rm", image, check=False)
    return report


if __name__ == "__main__":
    text = json.dumps(main(), ensure_ascii=False, indent=1)
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w") as f:
            f.write(text + "\n")
    print(text)
