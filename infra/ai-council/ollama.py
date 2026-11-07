#!/usr/bin/env python3
"""AI Council — клиент Ollama с модельным локом. Только stdlib.

Канон: docs/specs/ai-council.md §4.

Единственное место, где подсистема соблюдает главное физическое ограничение (C1): машина
24 GB, тяжёлые модели 15–19 GB каждая. Две резидентные одновременно = своп до неюзабельности.
Поэтому загрузка любой L-модели проходит через `large_model()`: взять машинный лок
(`~/.local/state/taibe/council/large-model.lock`, один на Mac для всех хостов, OPS-29) и лок в БД хоста →
вытеснить предыдущую L-модель (`keep_alive: 0`) → загрузить свою. Машинный лок снимает ядро при падении
процесса, лок в БД — с TTL, чтобы упавший воркер не заблокировал очередь навсегда.

Стиль fail-safe скопирован с .claude/scripts/glm_client.py: сетевые/HTTP-сбои возвращают
результат с ok=False, но не бросают — вызывающий код обязан иметь фолбэк, а не падать.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field

DOWN_TTL = 120  # сек: после сетевого сбоя не долбим демона на каждом вызове
# Один локальный инференс консилиума на машину: генерацию и эмбеддинги всех процессов консилиума (воркер,
# облачные полосы воркера, контекст, планировщик) пропускает один файловый лок. Тот же машинный файл берёт шлюз
# моделей (`infra/llm-gateway/src/machine-lock.mjs`, OPS-27). Мимо замка ходят backend продукта в docker (OPS-28),
# роли Continue напрямую и прогрев (OPS-33), так что вместе с ними два инференса параллельно всё ещё возможны. Модельный лок
# (`large_model`, машинный — OPS-29) держит только резидентность L-моделей, S-модели и эмбеддинги идут мимо него.
# Лок — у машины, а не у хоста и не у копии кода: консилиумы всех продуктов-хостов на одном Mac делят
# один файл, иначе два хоста дадут два инференса параллельно. Путь — в домашней папке пользователя вне
# продуктов. Не $TMPDIR и не $XDG_STATE_HOME: у launchd и у терминала они разные, а HOME один.
# Переходного второго лока у хоста (`<хост>/.claude/council/ollama-local.lock`) больше нет (OPS-30): старая копия
# слоя в HR удалена (HR #482, #484), все процессы консилиума исполняют код tAIBE и берут машинный файл.
# AI_COUNCIL_LOCAL_LOCK — только для тестов: один заданный файл вместо машинного.
MACHINE_LOCK_REL = os.path.join(".local", "state", "taibe", "council", "ollama-local.lock")
_LOCK_OVERRIDE = os.environ.get("AI_COUNCIL_LOCAL_LOCK", "").strip()
LOCAL_INFERENCE_LOCK = _LOCK_OVERRIDE or os.path.join(os.path.expanduser("~"), MACHINE_LOCK_REL)
# Модельный лок L-моделей — тоже у машины (OPS-29). Лок в council.db держал «одну L-модель» только внутри хоста:
# у каждого хоста своя база, и два хоста выгружали модели друг друга (пинг-понг 17–18 GB, в окне — две L-модели на
# 24 GB). Порядок постоянный: модельный лок — внешний, на весь блок large_model; лок инференса — внутренний, на
# вызов. Шлюз моделей берёт только лок инференса, поэтому взаимной блокировки нет. С AI_COUNCIL_LOCAL_LOCK (тесты)
# файл лежит рядом с ним.
MACHINE_MODEL_LOCK = (os.path.join(os.path.dirname(_LOCK_OVERRIDE), "large-model.lock") if _LOCK_OVERRIDE
                      else os.path.join(os.path.expanduser("~"), ".local", "state", "taibe", "council", "large-model.lock"))
_model_lock = {"depth": 0}   # процесс держит машинный модельный лок: вложенный large_model — без flock


def _flock_by(handle, deadline: float, wait_seconds: float, path: str = "", what: str = "локальный инференс") -> None:
    while True:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.time() >= deadline:
                holder = local_lock_holder(path) if path else None
                if path and holder is None:      # держатель ушёл между опросом и проверкой — ещё одна попытка
                    try:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        return
                    except BlockingIOError:
                        pass
                who = describe_holder(holder) if path else "держатель неизвестен"
                raise TimeoutError(f"{what} занят другим процессом дольше {int(wait_seconds)} с: {who}. "
                                   "Кто держит — python3 infra/ai-council/supervisor.py status")
            time.sleep(0.25)


@contextmanager
def machine_model_slot(model: str, holder: str, wait_seconds: float):
    """Машинный лок L-модели на блок large_model (OPS-29). Реентерабелен внутри процесса, как прежний лок в БД
    для одного holder: вложенный блок не ждёт сам себя."""
    if _model_lock["depth"]:
        _model_lock["depth"] += 1
        try:
            yield
        finally:
            _model_lock["depth"] -= 1
        return
    path = MACHINE_MODEL_LOCK
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a+") as handle:
        _flock_by(handle, time.time() + wait_seconds, wait_seconds, path, what=f"модельный лок под {model}")
        mark_holder(handle, f"council {holder} {model}")
        _model_lock.update(depth=1)
        try:
            yield
        finally:
            _model_lock.update(depth=0)
            clear_mark(handle)
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def mark_holder(handle, who: str) -> None:
    """Держатель пишет «pid кто» в сам файл замка (OPS-31): flock на macOS не виден в lsof, а ожидающие открывают
    тот же файл, поэтому иначе держателя не отличить от очереди."""
    try:
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()} {who}\n")
        handle.flush()
    except OSError:
        pass


def clear_mark(handle) -> None:
    """Перед снятием замка: иначе следующий держатель без отметки (старые копии кода) выглядел бы прежним."""
    try:
        handle.seek(0)
        handle.truncate()
        handle.flush()
    except OSError:
        pass


def _ps(pid: int) -> tuple[str, str] | None:
    """(состояние, команда) процесса; ("", "") — процесса нет; None — ps не ответил."""
    try:
        p = subprocess.run(["ps", "-o", "stat=,command=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    state, _, command = p.stdout.strip().partition(" ")
    return state, command.strip()


def local_lock_holder(path: str | None = None) -> dict | None:
    """Кто держит машинный замок локального инференса: None — свободен, иначе {pid, who, state, command}.
    Замок пробуется на миг (LOCK_NB): взялся — свободен и сразу отпущен; занят — держатель из файла и его
    состояние из ps (T — остановлен Ctrl+Z или SIGSTOP)."""
    path = path or LOCAL_INFERENCE_LOCK
    try:
        handle = open(path, "r")           # flock берётся и на файле только для чтения; запись не нужна
    except FileNotFoundError:
        return None
    except OSError as exc:
        return {"pid": None, "who": "", "state": "", "command": "", "error": f"файл замка не открыть: {exc.strerror}"}
    with handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.seek(0)
            line = (handle.read(200).splitlines() or [""])[0]
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            return None
    parts = line.split(maxsplit=1)
    pid = int(parts[0]) if parts and parts[0].isdigit() else None
    info = {"pid": pid, "who": parts[1] if len(parts) > 1 else "", "state": "", "command": "", "error": "", "path": path}
    if pid:
        ps = _ps(pid)
        if ps is None:
            info["error"] = "ps не ответил — состояние не узнать"
        else:
            info.update(state=ps[0], command=ps[1])
        # Держатель шлюза — дочерний python; остановить могли сам шлюз (node): «gateway <ppid>».
        who = info["who"].split()
        if len(who) == 2 and who[0] == "gateway" and who[1].isdigit():
            parent = _ps(int(who[1]))
            if parent and parent[0].startswith("T"):
                info.update(pid=int(who[1]), who="шлюз моделей", state=parent[0], command=parent[1])
    return info


def describe_holder(h: dict | None) -> str:
    if h is None:
        return "свободен"
    if h.get("error") and not h["pid"]:
        return h["error"]
    if h.get("error"):
        return f"держит pid {h['pid']} ({h['who'] or '?'}) — {h['error']}"
    if not h["pid"]:
        return "занят, держатель не записал pid (старая копия кода)"
    who = f"pid {h['pid']} ({h['who'] or '?'})"
    if h["state"].startswith("T"):
        return f"держит {who} — ОСТАНОВЛЕН (Ctrl+Z или SIGSTOP): kill -CONT {h['pid']} или завершите процесс"
    if not h["state"]:
        return (f"pid {h['pid']} завершён; замок держит процесс без отметки — кто: lsof {h.get('path') or 'файл замка'}")
    argv = h["command"].split(" ", 1)
    command = " ".join([os.path.basename(argv[0])] + argv[1:])   # путь интерпретатора съедал всю строку
    return f"держит {who}, состояние {h['state']}: {command[:100]}"


@contextmanager
def local_inference_slot(wait_seconds: float):
    """Эксклюзивный доступ консилиума к локальному Ollama на время одного HTTP-вызова: между процессами
    консилиума всех хостов и со шлюзом моделей (машинный файл, OPS-27), но не с backend продукта (OPS-28) и не с
    ролями Continue напрямую (OPS-33). Лок файловый (flock):
    снимается и при падении процесса. Не дождались — TimeoutError, вызов не делается."""
    path = LOCAL_INFERENCE_LOCK
    deadline = time.time() + wait_seconds
    with ExitStack() as held:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        handle = held.enter_context(open(path, "a+"))
        _flock_by(handle, deadline, wait_seconds, path)
        held.callback(fcntl.flock, handle.fileno(), fcntl.LOCK_UN)
        mark_holder(handle, "council")
        held.callback(clear_mark, handle)    # LIFO: отметка стирается до снятия замка
        yield
PRESSURE_CRITICAL = 4   # kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical


class MemoryUnavailable(TimeoutError):
    """L-модели некуда загрузиться. Наследник TimeoutError намеренно: воркеры уже
    возвращают прогон в очередь на TimeoutError модельного лока — здесь то же самое,
    только с отложенным повтором (not_before), а не немедленным."""


def _sysctl(name: str) -> str:
    try:
        return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True,
                              timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def memory_snapshot() -> dict | None:
    """Сколько памяти реально доступно под загрузку модели, без своп-трэша (macOS).

    Замер 2026-10-04: при занятом свопе (35.5/36.8 GB) Ollama грузила 17-гигабайтную
    модель дольше своего 5-минутного таймаута — каждая попытка 5 минут гоняла своп и
    падала 500, серия из 95 карточек ушла в пустые воздержания. «Доступно» здесь — то,
    что освобождается быстро: free + speculative + purgeable, плюс inactive, если своп
    ещё есть куда сбрасывать (иначе только файловая часть inactive — грязные анонимные
    страницы при полном свопе не уходят никуда). Не macOS → None (guard не мешает)."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"page size of (\d+)", out)
    if not m:
        return None
    page = int(m.group(1))
    pages = {k.strip(): int(v) for k, v in re.findall(r'^"?([^:"\n]+)"?:\s+(\d+)\.', out, re.M)}
    gb = lambda n: n * page / 2 ** 30                                     # noqa: E731
    swap_free, swap_total = 0.0, 0.0
    usage = _sysctl("vm.swapusage")
    sw = re.search(r"free = ([\d.]+)M", usage)
    st = re.search(r"total = ([\d.]+)M", usage)
    if sw:
        swap_free = float(sw.group(1)) / 1024
    if st:
        swap_total = float(st.group(1)) / 1024
    inactive = pages.get("Pages inactive", 0)
    # total=0 — своп ещё не выделен (свежая загрузка), а не «полон»: macOS создаёт
    # swap-файлы по требованию. Клампим inactive только при реально забитом свопе.
    if swap_total > 0 and swap_free < 4:
        inactive = min(inactive, pages.get("File-backed pages", 0))
    avail = gb(pages.get("Pages free", 0) + pages.get("Pages speculative", 0)
               + pages.get("Pages purgeable", 0) + inactive)
    try:
        pressure = int(_sysctl("kern.memorystatus_vm_pressure_level") or 1)
    except ValueError:
        pressure = 1
    return {"avail_gb": round(avail, 1), "swap_free_gb": round(swap_free, 1), "pressure": pressure}
_CTX_CACHE: dict[str, int | None] = {}
_TAG_SIZES: dict[str, float] = {}


@dataclass
class Completion:
    ok: bool
    text: str = ""
    data: dict | None = None       # распарсенный JSON, если запрашивался structured output
    model: str = ""
    ms: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    error: str = ""


@dataclass
class OllamaClient:
    base_url: str = "http://127.0.0.1:11434"
    request_timeout: int = 300
    keep_alive_active: str = "10m"
    store: object | None = None            # store.Store — для модельного лока
    holder: str = "council"
    large: dict = field(default_factory=dict)   # {model_name: size_gb}
    # B-72 (2026-08-30): без явного num_ctx демон грузит модели с дефолтным потолком
    # 4096 независимо от n_ctx_train, и это молча обрывало ~24% прогонов (JSON срезался
    # до конца генерации). Единое ФИКСИРОВАННОЕ значение на все вызовы намеренно — не
    # считаем per-call от размера промпта: разный num_ctx на один и тот же резидентный
    # процесс заставляет Ollama пересоздавать runner (эффективно реload модели), что для
    # L-тира (15-19 GB, C1) means своп на каждый вызов вместо одного на батч.
    # 8192 проверено эмпирически (2026-08-31): VRAM-разница от 4096 незначительна
    # (~15 MB, KV-cache не преаллоцируется). Поднимать выше — сначала проверить фактический
    # VRAM-бюджет L-моделей на машине (см. карточку B-72, п. «что проверить»).
    num_ctx: int = 8192
    memory_guard: bool = True      # не грузить L-модель, которой некуда встать (см. memory_snapshot)
    memory_margin_gb: float = 1.5  # KV-кэш и рабочая память runner'а поверх веса модели
    large_threshold_gb: float = 9.0  # тяжелее — L-тир, даже если не вписана в [models.large]
    _down_until: float = 0.0
    _resident_large: str | None = None

    # ── низкоуровневый HTTP ──────────────────────────────────────────────────
    def _post(self, path: str, body: dict, timeout: int | None = None) -> tuple[dict | None, str]:
        if time.time() < self._down_until:
            return None, "ollama недоступна (кэш-маркер сбоя)"
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        wait = timeout or self.request_timeout
        try:
            with local_inference_slot(wait), \
                    urllib.request.urlopen(req, timeout=timeout or self.request_timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace")), ""
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            return None, f"HTTP {exc.code}: {detail}"       # ошибка API ≠ «сеть лежит»
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            # Таймаут одного вызова (долгая загрузка модели, длинная генерация) — не «демон
            # лежит»: маркер сбоя на 120 с валил бы и вызовы S-моделей, которые отвечают.
            if isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError):
                return None, f"таймаут вызова ({timeout or self.request_timeout}s): {exc}"
            self._down_until = time.time() + DOWN_TTL
            return None, f"сеть/демон: {exc}"
        except json.JSONDecodeError as exc:
            return None, f"невалидный JSON от Ollama: {exc}"

    def alive(self) -> bool:
        try:
            with urllib.request.urlopen(self.base_url + "/api/tags", timeout=2) as resp:
                return resp.status == 200
        except (urllib.error.URLError, OSError):
            return False

    def installed_models(self) -> list[str]:
        try:
            with urllib.request.urlopen(self.base_url + "/api/tags", timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            return [m["name"] for m in data.get("models", [])]
        except (urllib.error.URLError, OSError, ValueError, KeyError):
            return []

    def loaded_models(self) -> list[dict]:
        try:
            with urllib.request.urlopen(self.base_url + "/api/ps", timeout=5) as resp:
                return json.loads(resp.read().decode("utf-8", "replace")).get("models", [])
        except (urllib.error.URLError, OSError, ValueError):
            return []

    # ── модельный лок (C1) ───────────────────────────────────────────────────
    def model_size_gb(self, model: str) -> float:
        """Вес модели: из [models.large], иначе фактический размер из /api/tags (кэш)."""
        if model in self.large:
            return float(self.large[model] or 0)
        if not _TAG_SIZES or time.time() - _TAG_SIZES.get("__at__", 0) > 300:
            try:
                with urllib.request.urlopen(self.base_url + "/api/tags", timeout=5) as resp:
                    models = json.loads(resp.read().decode("utf-8", "replace")).get("models", [])
                _TAG_SIZES.clear()
                _TAG_SIZES.update({m["name"]: m.get("size", 0) / 2 ** 30 for m in models})
                _TAG_SIZES["__at__"] = time.time()
            except (urllib.error.URLError, OSError, ValueError, KeyError):
                pass
        return float(_TAG_SIZES.get(model, 0.0))

    def is_large(self, model: str) -> bool:
        """L-тир: в [models.large] ИЛИ фактически тяжелее порога. Без второго условия
        модель, выбранная в UI (ревью, привязки ролей), но не вписанная в конфиг, шла бы
        мимо модельного лока и memory-guard — и вставала бы в память рядом с 30B."""
        if model in self.large:
            return True
        return self.large_threshold_gb > 0 and self.model_size_gb(model) >= self.large_threshold_gb

    def unload(self, model: str) -> None:
        """keep_alive=0 → Ollama выгружает модель немедленно, освобождая память."""
        self._post("/api/generate", {"model": model, "keep_alive": 0, "prompt": ""}, timeout=60)

    def memory_check(self, model: str) -> tuple[bool, str]:
        """Встанет ли L-модель в память без своп-трэша. Уже резидентная — да всегда.
        Выгружаемое (все остальные резидентные модели: L выгружает large_model, S —
        планировщик Ollama) засчитывается в доступное. При critical-давлении грузим,
        только если выгрузкой освобождаем не меньше, чем займём."""
        if not self.memory_guard or not self.is_large(model):
            return True, ""
        loaded = self.loaded_models()
        if any((m.get("name") or m.get("model")) == model for m in loaded):
            return True, ""
        snap = memory_snapshot()
        if snap is None:
            return True, ""
        need = self.model_size_gb(model) + self.memory_margin_gb
        evictable = sum(m.get("size", 0) for m in loaded) / 2 ** 30
        why = (f"нет памяти под {model}: нужно ~{need:.1f} GB, доступно ~{snap['avail_gb']:.1f} "
               f"+ выгружаемое {evictable:.1f} GB, своп свободен {snap['swap_free_gb']:.1f} GB, "
               f"давление {snap['pressure']}")
        if snap["pressure"] >= PRESSURE_CRITICAL and evictable < need:
            return False, why
        if snap["avail_gb"] + evictable < need:
            return False, why
        return True, ""

    @contextmanager
    def large_model(self, model: str, wait_seconds: int = 1800):
        """Эксклюзивное владение тяжёлой моделью на время блока.

        Вне блока никакая другая L-модель в память не загружается — ни этим процессом,
        ни соседним воркером, ни планировщиком. Это и есть инвариант max_resident_large=1.
        """
        if not self.is_large(model):
            yield                      # S-тир лока не требует — помещается вместе
            return

        deadline = time.time() + wait_seconds
        with machine_model_slot(model, self.holder, wait_seconds):
            yield from self._large_model_db(model, deadline, wait_seconds)

    def _large_model_db(self, model: str, deadline: float, wait_seconds: int):
        """Лок в council.db хоста — под машинным: старые копии кода на том же хосте видят только его, а status
        показывает модель."""
        acquired = False
        while True:                    # хотя бы одна попытка: машинный лок мог достаться у самого дедлайна
            if self.store is None or self.store.acquire_model_lock(self.holder, model):
                acquired = True
                break
            if time.time() >= deadline:
                break
            time.sleep(2.0)
        if not acquired:
            raise TimeoutError(
                f"не удалось взять модельный лок под {model} за {wait_seconds}s — "
                "держит другой воркер (таблица locks); кто держит — python3 infra/ai-council/supervisor.py status"
            )

        try:
            # Проверка — под локом и ДО выгрузки: соседний воркер не загрузит своё между
            # проверкой и загрузкой, а резидентную L-модель не выгружаем зря, если новой
            # всё равно некуда встать.
            fits, why = self.memory_check(model)
            if not fits:
                raise MemoryUnavailable(why)
            # Вытесняем чужие резидентные L-модели: иначе 18.6 + 17.4 GB на 24 GB машине.
            for loaded in self.loaded_models():
                name = loaded.get("name") or loaded.get("model", "")
                if name and name != model and self.is_large(name):
                    self.unload(name)
            self._resident_large = model
            yield
        finally:
            if self.store is not None:
                self.store.release_model_lock(self.holder)

    # ── генерация ────────────────────────────────────────────────────────────
    def chat(self, model: str, messages: list[dict], *, schema: dict | None = None,
             temperature: float = 0.2, max_tokens: int = 1200,
             timeout: int | None = None, retries: int = 1,
             options: dict | None = None, extra: dict | None = None) -> Completion:
        """Один chat-вызов. schema → structured output Ollama (`format`), а не уговоры
        в промпте: слабые модели ломают формат систематически, схема это чинит на уровне
        сэмплинга.

        options — поверх дефолтов (ревью: тонкая настройка агента, уже прошедшая белый
        список review_catalog.PARAM_SPEC); extra — поля верхнего уровня (think, keep_alive).
        Консилиум проработки их не передаёт — его поведение не меняется."""
        body: dict = {
            "model": model,
            "messages": messages,
            "stream": False,
            "keep_alive": self.keep_alive_active,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
                "num_ctx": self.num_ctx,
                **(options or {}),
            },
            **(extra or {}),
        }
        if schema is not None:
            body["format"] = schema

        last_error = ""
        for attempt in range(retries + 1):
            started = time.time()
            data, error = self._post("/api/chat", body, timeout=timeout)
            elapsed = int((time.time() - started) * 1000)
            if data is None:
                last_error = error
                if attempt < retries:
                    time.sleep(1.5 * (attempt + 1))
                continue

            text = (data.get("message") or {}).get("content", "").strip()
            parsed = None
            if schema is not None and text:
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError as exc:
                    last_error = f"ответ не распарсился как JSON: {exc}"
                    if attempt < retries:
                        # Показываем модели её же ошибку — второй заход обычно чинит.
                        messages = messages + [
                            {"role": "assistant", "content": text[:2000]},
                            {"role": "user", "content":
                                f"Ответ невалиден как JSON ({exc}). Верни ТОЛЬКО валидный JSON "
                                "по схеме, без markdown-обёртки и без пояснений."},
                        ]
                        body["messages"] = messages
                        continue
                    return Completion(False, text, None, model, elapsed,
                                      data.get("prompt_eval_count", 0),
                                      data.get("eval_count", 0), last_error)

            return Completion(
                ok=True, text=text, data=parsed, model=model, ms=elapsed,
                tokens_in=data.get("prompt_eval_count", 0),
                tokens_out=data.get("eval_count", 0),
            )

        return Completion(False, "", None, model, 0, 0, 0, last_error)

    def context_length(self, model: str) -> int | None:
        """Окно модели из /api/show (`<arch>.context_length`). Кэш на процесс: метаданные
        модели не меняются, а dry-run ревью спрашивает их на каждого агента."""
        if model in _CTX_CACHE:
            return _CTX_CACHE[model]
        data, _err = self._post("/api/show", {"model": model}, timeout=15)
        value = None
        for key, val in ((data or {}).get("model_info") or {}).items():
            if key.endswith(".context_length") and isinstance(val, int):
                value = val
                break
        if data is not None:
            _CTX_CACHE[model] = value
        return value

    def embed(self, model: str, texts: list[str]) -> list[list[float]] | None:
        data, error = self._post("/api/embed", {"model": model, "input": texts}, timeout=120)
        if data is None:
            return None
        return data.get("embeddings")


def build(cfg, store=None, holder: str = "council") -> OllamaClient:
    """Собрать клиент из config.Config."""
    return OllamaClient(
        base_url=cfg.get("models.ollama_url", "http://127.0.0.1:11434"),
        request_timeout=cfg.get("models.request_timeout_seconds", 300),
        keep_alive_active=cfg.get("models.keep_alive_active", "10m"),
        store=store,
        holder=holder,
        large=cfg.large_models(),
        num_ctx=cfg.get("models.num_ctx", 8192),
        memory_guard=bool(cfg.get("models.memory_guard", True)),
        memory_margin_gb=float(cfg.get("models.memory_margin_gb", 1.5)),
        large_threshold_gb=float(cfg.get("models.large_threshold_gb", 9.0)),
    )


if __name__ == "__main__":
    # Диагностика: python3 infra/ai-council/ollama.py
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import config as config_mod

    cfg = config_mod.load(strict=False)
    client = build(cfg)
    print("ollama:", "жива" if client.alive() else "НЕ отвечает", client.base_url)
    if not client.alive():
        sys.exit(1)

    installed = set(client.installed_models())
    print(f"установлено моделей: {len(installed)}")
    missing_any = False
    for profile in ("fast", "deep"):
        print(f"\nпрофиль {profile}:")
        for role, model in cfg.roles(profile).items():
            mark = "✓" if model in installed else "✗ НЕ УСТАНОВЛЕНА"
            tier = "L" if cfg.is_large(model) else "S"
            if model not in installed:
                missing_any = True
            print(f"  [{tier}] {role:20} {model:42} {mark}")
    print("\nрезидентно сейчас:", [m.get("name") for m in client.loaded_models()] or "ничего")
    sys.exit(1 if missing_any else 0)
