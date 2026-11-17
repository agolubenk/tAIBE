#!/usr/bin/env python3
"""Замки 1mcp прошлой загрузки — в сторону, до старта хаба (OPS-82; случаи 06.11, 11.11, 16.11).

После перезагрузки (или сбоя питания) в папке конфига хаба остаются server.pid, runtime.owner/owner.json и
admin/runtime-scope-admin-*.lock прошлого процесса. 1mcp с ними не стартует («Server error: <private>»), хаб :3050
молчит, а с ним MCP t-boards, owner-queue и остальные. Замок считается прошлым, только если в нём bootId другой
загрузки: pid после перезагрузки может принадлежать чужому живому процессу. Замки admin — с pid прошлого владельца.
Файлы не удаляются: переименовываются в <имя>.stale-boot-<дата>, как это делали руками.

  python3 -I infra/scripts/dev-ai/mcp-hub-stale.py [CONFIG_DIR]    (без аргумента — ~/.config/hr-helper-mcp-hub)
Код 0 всегда: сбой этой уборки не должен мешать старту хаба.
"""
import json
import subprocess
import sys
import time
from pathlib import Path


def boot_id():
    try:
        if sys.platform == "darwin":
            return subprocess.run(["sysctl", "-n", "kern.bootsessionuuid"], capture_output=True, text=True,
                                  timeout=5).stdout.strip()
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip().upper()
    except (OSError, subprocess.SubprocessError):
        return ""


def read(path):
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) else None


def stale_owner(cfg, now_boot):
    """pid прошлой загрузки из server.pid или runtime.owner/owner.json; None — замков прошлой загрузки нет."""
    for f in (cfg / "server.pid", cfg / "runtime.owner" / "owner.json"):
        d = read(f)
        boot = str(((d or {}).get("processIdentity") or {}).get("bootId") or "").upper()
        if boot and now_boot and boot != now_boot.upper():
            return (d or {}).get("pid")
    return None


def main(argv):
    cfg = Path(argv[1] if len(argv) > 1 else Path.home() / ".config" / "hr-helper-mcp-hub")
    pid = stale_owner(cfg, boot_id())
    if pid is None:
        return 0
    tag = ".stale-boot-" + time.strftime("%Y%m%d-%H%M")
    moves = [cfg / "server.pid", cfg / "runtime.owner"]
    moves += [f for f in (cfg / "admin").glob("runtime-scope-admin-*.lock") if (read(f) or {}).get("pid") == pid]
    for f in moves:
        if f.exists():
            dst = f.with_name(f.name + tag)
            f.rename(dst)
            print(f"mcp-hub: замок прошлой загрузки (pid {pid}) → {dst.name}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as exc:  # noqa: BLE001 — уборка не держит старт хаба
        print(f"mcp-hub: уборка замков не вышла ({exc.__class__.__name__}) — старт как есть", file=sys.stderr)
        sys.exit(0)
