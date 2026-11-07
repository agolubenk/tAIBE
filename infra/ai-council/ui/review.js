/* Вкладка «Ревью» — ревью карточек колонок ревью t-boards консилиумом моделей.
   Канон: docs/specs/ai-council.md §17. Подключается из index.html (тег <script src>),
   пользуется его утилитами ($, esc, api, post, toast, ago, dur, emptyRow) — они
   объявлены там на верхнем уровне и видны здесь на момент вызова.

   Весь текст из БД и вывод моделей — только через esc(): это данные, не разметка. */
"use strict";

const RV = {
  sub: "queue", state: null, models: null, board: "", search: "", profileId: "",
  selected: new Set(), editProfile: null, histStatus: "", timer: null,
};
const RV_SUBS = [["queue", "Очередь"], ["profiles", "Профили"], ["agents", "Агенты"],
                 ["boards", "Доски и переходы"], ["history", "История"], ["settings", "Настройки"]];
const RV_VERDICT = { ACCEPT: ["ok", "принято"], FAIL: ["bad", "на доработку"],
                     NEEDS_HUMAN: ["warn", "нужен человек"], INCONCLUSIVE: ["warn", "неоднозначно"] };
const RV_TSTATE = { none: "", proposed: "ждёт подтверждения", applied: "переведено",
                    rejected: "отклонено", skipped: "не применён", failed: "ошибка перехода" };
const BOARD_RU = { bugs: "Ошибки", tasks: "Задачи" };

const rvVerdictTag = (v) => v ? `<span class="tag ${RV_VERDICT[v]?.[0] || ""}">${esc(RV_VERDICT[v]?.[1] || v)}</span>` : "";
const rvStatusTag = (s) => `<span class="tag ${s === "done" ? "done" : s === "failed" ? "failed"
  : s === "running" ? "running" : s === "cancelled" ? "warn" : "queued"}">${esc(s)}</span>`;
const rvAgentLabel = (key) => (RV.state?.agents || []).find((a) => a.key === key)?.label || key;
const rvChecked = (b) => b ? "checked" : "";

async function rvLoad(force = false) {
  if (!RV.state || force) RV.state = await api("/api/review/state");
  return RV.state;
}
async function rvModels() {
  if (!RV.models) RV.models = await api("/api/review/models");
  return RV.models;
}
function rvModelOptions(selected, inheritLabel = "наследовать") {
  const m = RV.models || { local: [], cloud: [] };
  const opts = [`<option value="">${esc(inheritLabel)}</option>`];
  const names = new Set();
  for (const x of m.local) {
    names.add(x.name);
    opts.push(`<option value="${esc(x.name)}" ${x.name === selected ? "selected" : ""}>${esc(x.name)}${
      x.context ? ` · ${Math.round(x.context / 1024)}k` : ""}${x.large ? " · L" : ""}</option>`);
  }
  for (const c of m.cloud) {
    names.add(c);
    opts.push(`<option value="${esc(c)}" ${c === selected ? "selected" : ""}>☁ ${esc(c)}</option>`);
  }
  if (selected && !names.has(selected))
    opts.push(`<option value="${esc(selected)}" selected>${esc(selected)} (не установлена)</option>`);
  return opts.join("");
}

/* ── каркас ───────────────────────────────────────────────────────────── */
async function renderReview() {
  const box = $("#tab-review");
  if (!box.dataset.ready) {
    box.innerHTML = `<div class="toolbar" id="rv-subs"></div><div id="rv-body"></div>`;
    box.dataset.ready = "1";
  }
  $("#rv-subs").innerHTML = RV_SUBS.map(([k, t]) =>
    `<button class="act ${RV.sub === k ? "accent" : ""}" data-rvsub="${k}">${esc(t)}</button>`).join("")
    + `<span class="spacer"></span><span class="sub" id="rv-head"></span>`;
  $("#rv-subs").querySelectorAll("[data-rvsub]").forEach((b) => {
    b.onclick = () => { RV.sub = b.dataset.rvsub; renderReview(); };
  });
  await Promise.all([rvLoad(true), rvModels().catch(() => null)]);
  const s = RV.state, c = s.counts || {};
  $("#rv-head").textContent = `на ревью: ${s.queue_size} (без ревью ${s.queue_unreviewed}) · в очереди ` +
    `${c.queued || 0} · идёт ${c.running || 0} · ждут подтверждения ${s.proposed.length}`;
  const renderers = { queue: rvQueue, profiles: rvProfiles, agents: rvAgents, boards: rvBoards,
                      history: rvHistory, settings: rvSettings };
  await renderers[RV.sub]();
  clearInterval(RV.timer);
  RV.timer = setInterval(() => {
    if (activeTab !== "review") { clearInterval(RV.timer); return; }
    if (RV.sub === "history" || RV.sub === "queue") rvSoftRefresh();
  }, 8000);
}
async function rvSoftRefresh() {
  if (document.querySelector("dialog[open]")) return;     // не дёргаем открытую модалку
  try {
    if (RV.sub === "history") await rvHistory();
    else if (RV.sub === "queue") { await rvLoad(true); await rvQueue(true); }
  } catch (e) { /* фоновое обновление не шумит */ }
}

/* ── очередь ──────────────────────────────────────────────────────────── */
async function rvQueue(soft = false) {
  const s = RV.state;
  const data = await api("/api/review/queue" + (RV.board ? `?board=${RV.board}` : ""));
  const profiles = s.profiles;
  if (!RV.profileId || !profiles.find((p) => p.id === RV.profileId))
    RV.profileId = (profiles.find((p) => p.is_default) || profiles[0] || {}).id || "";
  const q = RV.search.trim().toLowerCase();
  const cards = data.cards.filter((c) => !q || (c.title || "").toLowerCase().includes(q)
    || (c.backlog_id || "").toLowerCase().includes(q));
  const proposed = s.proposed.length ? `
    <div class="card" style="margin-bottom:12px;border-color:var(--warn-bd)">
      <h3>Переходы ждут подтверждения (${s.proposed.length})</h3>
      ${s.proposed.map((p) => `<div class="row" style="padding:4px 0">
        <span style="flex:1">${esc(p.card_title)} → <b>${esc(p.transition_target)}</b></span>
        <button class="act" data-rvopen="${esc(p.id)}">итог</button>
        <button class="act ok" data-rvapprove="${esc(p.id)}">применить</button>
        <button class="act bad" data-rvreject="${esc(p.id)}">отклонить</button></div>`).join("")}
    </div>` : "";
  const rows = cards.map((c) => {
    const last = c.last_run;
    const weight = c.severity || c.priority || "";
    const lastCell = last ? `${last.verdict ? rvVerdictTag(last.verdict) : rvStatusTag(last.status)}
      ${RV_TSTATE[last.transition_state] ? `<span class="sub">${esc(RV_TSTATE[last.transition_state])}</span>` : ""}
      <span class="faint">${ago(last.finished_at || last.created_at)}</span>` : `<span class="faint">не ревьюилась</span>`;
    return `<tr>
      <td><input type="checkbox" data-rvsel="${esc(c.card_id)}" ${rvChecked(RV.selected.has(c.card_id))}></td>
      <td><span class="tag">${esc(BOARD_RU[c.board] || c.board)}</span></td>
      <td class="wrap"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>
        ${c.backlog_id ? `<span class="faint mono"> ${esc(c.backlog_id)}</span>` : ""}
        ${c.half_baked ? ` <span class="tag warn">half-baked</span>` : ""}</td>
      <td>${weight ? `<span class="tag ${esc(weight)}">${esc(weight)}</span>` : ""}</td>
      <td class="faint">${ago(c.first_seen_at)}</td>
      <td>${lastCell}</td>
      <td style="white-space:nowrap">
        <button class="act" data-rvprep="${esc(c.card_id)}">Проверить</button>
        <button class="act accent" data-rvrun="${esc(c.card_id)}">Запустить</button>
        ${last ? `<button class="act" data-rvopen="${esc(last.id)}">Итог</button>` : ""}</td></tr>`;
  }).join("");
  $("#rv-body").innerHTML = `${proposed}
    <div class="toolbar">
      <select id="rv-board"><option value="">все доски</option>
        <option value="bugs" ${RV.board === "bugs" ? "selected" : ""}>Ошибки</option>
        <option value="tasks" ${RV.board === "tasks" ? "selected" : ""}>Задачи</option></select>
      <input type="text" id="rv-search" placeholder="поиск по названию / ID" value="${esc(RV.search)}">
      <button class="act" id="rv-sync" title="Перечитать карточки колонок ревью из t-boards">⟳ Обновить из t-boards</button>
      <span class="spacer"></span>
      <span class="sub">профиль запуска</span>
      <select id="rv-profile">${profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === RV.profileId ? "selected" : ""}>${
        esc(p.name)}${p.is_default ? " ★" : ""}</option>`).join("")}</select>
      <button class="act accent" id="rv-run-sel" ${RV.selected.size ? "" : "disabled"}>Запустить выбранные (${RV.selected.size})</button>
      <button class="act" id="rv-run-new" title="Все карточки без ревью, кроме half-baked">Запустить все без ревью</button>
    </div>
    <div class="card"><div class="tablewrap"><table>
      <thead><tr><th><input type="checkbox" id="rv-all"></th><th>Доска</th><th>Карточка</th><th>Вес</th>
        <th>На ревью</th><th>Последнее ревью</th><th></th></tr></thead>
      <tbody>${rows || emptyRow(7, data.cards.length ? "ничего не найдено" : "очередь пуста — «Обновить из t-boards»")}</tbody>
    </table></div></div>`;
  const body = $("#rv-body");
  $("#rv-board").onchange = (e) => { RV.board = e.target.value; rvQueue(); };
  $("#rv-search").oninput = debounce((e) => { RV.search = e.target.value; rvQueue(); }, 250);
  if (!soft) $("#rv-search").focus();
  $("#rv-profile").onchange = (e) => { RV.profileId = e.target.value; };
  $("#rv-sync").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "синхронизация…";
    try {
      const r = await post("/api/review/sync", {});
      toast(`t-boards: в колонках ревью ${r.stats.seen}, перечитано ${r.stats.fetched}, ушло ${r.stats.left}` +
            (r.stats.partial ? ` — неполный проход: ${r.stats.error || "повторите"}` : ""), !!r.stats.partial);
      await renderReview();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
  $("#rv-all").onchange = (e) => {
    cards.forEach((c) => e.target.checked ? RV.selected.add(c.card_id) : RV.selected.delete(c.card_id));
    rvQueue(true);
  };
  body.querySelectorAll("[data-rvsel]").forEach((cb) => {
    cb.onchange = () => { cb.checked ? RV.selected.add(cb.dataset.rvsel) : RV.selected.delete(cb.dataset.rvsel);
      $("#rv-run-sel").disabled = !RV.selected.size;
      $("#rv-run-sel").textContent = `Запустить выбранные (${RV.selected.size})`; };
  });
  $("#rv-run-sel").onclick = async () => {
    let n = 0;
    for (const id of RV.selected) {
      try { const r = await post("/api/review/runs", { card: id, profile: RV.profileId }); n += r.queued.length; }
      catch (err) { toast(err.message, true); }
    }
    RV.selected.clear();
    toast(`поставлено в очередь: ${n}`);
    renderReview();
  };
  $("#rv-run-new").onclick = async () => {
    try {
      const r = await post("/api/review/runs", { card: "all", profile: RV.profileId });
      toast(`поставлено: ${r.queued.length}, пропущено (уже в очереди): ${(r.skipped || []).length}`);
      renderReview();
    } catch (err) { toast(err.message, true); }
  };
  body.querySelectorAll("[data-rvprep]").forEach((b) => { b.onclick = () => rvPrepare(b.dataset.rvprep); });
  body.querySelectorAll("[data-rvrun]").forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await post("/api/review/runs", { card: b.dataset.rvrun, profile: RV.profileId });
        toast(r.queued.length ? `в очереди: ${r.queued[0].run_id}` : `пропуск: ${r.skipped[0]?.why || ""}`);
        renderReview();
      } catch (err) { toast(err.message, true); }
    };
  });
  rvBindRunButtons(body);
}

function rvBindRunButtons(scope) {
  scope.querySelectorAll("[data-rvopen]").forEach((b) => { b.onclick = () => rvOpenRun(b.dataset.rvopen); });
  scope.querySelectorAll("[data-rvapprove]").forEach((b) => { b.onclick = () => rvDecide(b.dataset.rvapprove, true); });
  scope.querySelectorAll("[data-rvreject]").forEach((b) => { b.onclick = () => rvDecide(b.dataset.rvreject, false); });
}

async function rvDecide(runId, approve) {
  const comment = approve ? "" : (prompt("Причина отклонения (необязательно)") || "");
  try {
    const r = await post(`/api/review/runs/${runId}/transition`, { approve, comment });
    if (r.ok === false) throw new Error(r.error);
    toast(approve ? (r.ok ? (r.next || "переход подтверждён") : `не подтверждён: ${r.error}`) : "переход отклонён");
    renderReview();
    if ($("#modal").open) rvOpenRun(runId);
  } catch (err) { toast(err.message, true); }
}

/* ── dry-run и разовый запуск ─────────────────────────────────────────── */
async function rvPrepare(cardId, request = {}) {
  const modal = $("#modal");
  $("#m-title").textContent = "Проверка запуска ревью";
  $("#m-sub").textContent = "dry-run: ничего не ставится в очередь и не пишется на доску";
  $("#m-body").innerHTML = `<div class="empty">собираю план…</div>`;
  $("#m-foot").innerHTML = "";
  if (!modal.open) modal.showModal();
  let r;
  try { r = await post("/api/review/prepare", { card: cardId, profile: RV.profileId, request }); }
  catch (err) { $("#m-body").innerHTML = `<div class="empty bad-txt">${esc(err.message)}</div>`; return; }
  const plan = r.plan || { agents: {}, selection: [], participants: [] };
  const s = RV.state;
  $("#m-title").textContent = r.card?.title || "Проверка запуска";
  const reasons = Object.fromEntries((plan.selection || []).map((x) => [x.key, x.reason]));
  const agentRows = Object.entries(plan.agents).map(([k, a]) => `<tr>
    <td><b>${esc(a.label)}</b><div class="faint mono">${esc(k)}</div></td>
    <td>${esc(a.kind)}${a.can_block ? ` <span class="tag bad">вето</span>` : ""}</td>
    <td class="mono">${esc(a.model)}${a.cloud ? ` <span class="tag cloud">облако</span>` : ""}</td>
    <td class="mono">${a.num_ctx ?? "—"}</td><td class="mono">${a.num_predict === -1 ? "∞" : (a.num_predict ?? "—")}</td>
    <td class="mono">${a.input_budget}</td>
    <td class="sub">${esc(reasons[k] || (k === plan.adversary ? "оппонент метода" : k === plan.judge ? "судья" : ""))}
      ${(a.notes || []).map((n) => `<div class="faint">${esc(n)}</div>`).join("")}</td></tr>`).join("");
  const reviewers = s.agents.filter((a) => a.kind === "reviewer" && a.enabled !== false);
  const curAgents = new Set(request.agents || plan.participants);
  $("#m-body").innerHTML = `
    <div class="card" style="margin-bottom:10px"><h3>Проверки</h3>
      ${(r.checks || []).map((c) => `<div>${c.ok ? (c.level === "warn" ? "⚠" : "✓") : "✗"}
        <span class="${c.ok ? (c.level === "warn" ? "warn-txt" : "") : "bad-txt"}">${esc(c.text)}</span></div>`).join("")}
    </div>
    <div class="card" style="margin-bottom:10px"><h3>Состав и эффективные лимиты — ${esc(plan.method_label || "")}</h3>
      <div class="tablewrap"><table><thead><tr><th>Агент</th><th>Тип</th><th>Модель</th><th>num_ctx</th>
        <th>Выход</th><th>Вход под досье</th><th>Почему</th></tr></thead><tbody>${agentRows}</tbody></table></div>
      <div class="sub" style="margin-top:6px">Стадии: ${(plan.stages || []).map((st) => esc(st.type + (st.flavor ? `/${st.flavor}` : ""))).join(" → ")}</div>
    </div>
    <div class="card" style="margin-bottom:10px"><h3>Разовые настройки этого запуска</h3>
      <div class="row"><span class="sub">метод</span><select id="rvp-method"><option value="">как в профиле</option>
        ${s.catalog.methods.map((m) => `<option value="${m.key}" ${request.method === m.key ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
        <span class="sub">модель по умолчанию</span><select id="rvp-model">${rvModelOptions(request.default_model || "", "как в профиле")}</select>
        <label class="tag cloud" style="cursor:pointer" title="Все агенты этого прогона — на GLM Coding API (модели 5.x); расход — облачное окно">
          <input type="checkbox" id="rvp-glm" ${rvChecked(request.cloud_mode === "glm5")}> GLM 5.x</label></div>
      <div class="chip-row" style="margin:8px 0">${reviewers.map((a) => `<label class="tag" style="cursor:pointer">
        <input type="checkbox" data-rvpagent="${esc(a.key)}" ${rvChecked(curAgents.has(a.key))}> ${esc(a.label)}</label>`).join("")}</div>
      <textarea id="rvp-note" rows="2" placeholder="Указание консилиуму для этого прогона (приоритет над выводами)">${esc(request.note || "")}</textarea>
    </div>
    <details><summary>Досье, которое увидят модели (≈${r.dossier_meta?.tokens || 0} токенов, начало)</summary>
      <div><pre class="dump">${esc(r.dossier_preview || "")}</pre></div></details>`;
  const collect = () => {
    const agents = [...document.querySelectorAll("[data-rvpagent]")].filter((x) => x.checked).map((x) => x.dataset.rvpagent);
    const same = agents.length === plan.participants.length && agents.every((a) => plan.participants.includes(a));
    return { method: $("#rvp-method").value, default_model: $("#rvp-model").value,
             note: $("#rvp-note").value.trim(), agents: same && !request.agents ? [] : agents,
             cloud_mode: $("#rvp-glm")?.checked ? "glm5" : "" };
  };
  $("#m-foot").innerHTML = `<span class="spacer"></span>
    <button class="act" id="rvp-recheck">Перепроверить с изменениями</button>
    <button class="act accent" id="rvp-go" ${r.ok ? "" : "title='есть непройденные проверки — запуск всё равно возможен'"}>Запустить ревью</button>`;
  $("#rvp-recheck").onclick = () => rvPrepare(cardId, collect());
  $("#rvp-go").onclick = async () => {
    try {
      const res = await post("/api/review/runs", { card: cardId, profile: RV.profileId, request: collect(), force: true });
      toast(res.queued.length ? `в очереди: ${res.queued[0].run_id}` : "не поставлено");
      modal.close(); renderReview();
    } catch (err) { toast(err.message, true); }
  };
}

/* Опора находки, посчитанная кодом (§17.5): patch/file — в диффе, card — только заявление
   исполнителя в карточке, repo — файл не из изменения, none — без опоры. */
const RV_GROUND = { patch: ["ok", "в диффе"], file: ["ok", "файл изменения"], repo: ["warn", "вне изменения"],
  card: ["warn", "только в карточке"], none: ["bad", "без опоры"] };
const RV_STANCE = { confirms: "подтвердил", refutes: "оспорил", unclear: "не смог решить" };
function rvGroundTag(f) {
  const g = RV_GROUND[f.grounding];
  return g ? `<span class="tag ${g[0]}" title="${esc(f.grounding_why || "")}">${g[1]}</span>` : "";
}

/* ── прогон ───────────────────────────────────────────────────────────── */
async function rvOpenRun(runId) {
  const modal = $("#modal");
  const d = await api(`/api/review/runs/${runId}`);
  const run = d.run, res = run.result || {}, snap = run.snapshot || {};
  $("#m-title").textContent = run.card_title || run.card_id;
  $("#m-sub").innerHTML = `${esc(run.id)} · ${esc(run.profile_name || "")} · ${esc(snap.method || run.method || "")} ·
    ${rvStatusTag(run.status)} ${rvVerdictTag(run.verdict)} · ${dur(run.wall_ms)} ·
    ${d.card?.url ? `<a href="${esc(d.card.url)}" target="_blank" rel="noopener">открыть карточку</a>` : ""}`;
  const votes = Object.entries(res.votes || {}).map(([k, v]) => `<tr><td>${esc(rvAgentLabel(k))}</td>
    <td><span class="tag ${v.vote === "accept" ? "ok" : v.vote === "fail" ? "bad" : "warn"}">${esc(v.vote)}</span></td>
    <td class="mono">${num(v.confidence)}</td><td class="wrap">${esc(v.summary || "")}
    ${(v.missing_evidence || []).length ? `<div class="faint">не хватает: ${esc(v.missing_evidence.join("; "))}</div>` : ""}</td></tr>`).join("");
  const findings = (res.findings || []).map((f) => `<tr style="${f.refuted ? "opacity:.5;text-decoration:line-through" : ""}">
    <td class="mono">${esc(f.id)}</td><td><span class="tag ${f.severity === "critical" ? "bad" : f.severity === "major" ? "warn" : ""}">${esc(f.severity)}</span>
      ${f.severity_raw ? `<div class="faint" title="потолок важности роли / нет опоры в изменённых строках">было ${esc(f.severity_raw)}</div>` : ""}</td>
    <td>${esc(rvAgentLabel(f.by))}${f.via ? `<div class="faint">по вопросу ${esc(rvAgentLabel(f.via))}</div>` : ""}</td>
    <td class="wrap"><b>${esc(f.title)}</b> ${rvGroundTag(f)}<div class="sub">${esc(f.evidence || "")}</div>
    ${f.recommendation ? `<div>→ ${esc(f.recommendation)}</div>` : ""}${f.refuted ? `<div class="faint">снято: ${esc(f.refuted_reason || "")}</div>` : ""}
    ${(f.confirmed_by || []).length ? `<div class="faint">подтвердил: ${esc(f.confirmed_by.map(rvAgentLabel).join(", "))}</div>` : ""}
    ${f.disputed ? `<div class="warn-txt">оспорено: ${esc(f.disputed)}</div>` : ""}</td></tr>`).join("");
  const talk = (res.consults || []).map((c) => `<tr><td>${esc(c.kind === "crosscheck" ? "встречная проверка" : "вопрос")}</td>
    <td>${esc(rvAgentLabel(c.from))} → ${esc(rvAgentLabel(c.to))}${c.about ? ` <span class="mono faint">${esc(c.about)}</span>` : ""}</td>
    <td class="wrap">${esc(c.question || "")}</td>
    <td class="wrap">${c.skipped ? `<span class="faint">пропущено: ${esc(c.skipped)}</span>`
      : `<span class="tag ${c.stance === "confirms" ? "ok" : c.stance === "refutes" ? "warn" : ""}">${esc(RV_STANCE[c.stance] || c.stance || "")}</span>
         ${esc(c.answer || "")}${(c.findings || []).length ? `<div class="faint">новые находки: ${esc(c.findings.join(", "))}</div>` : ""}`}</td></tr>`).join("");
  const pol = res.policy || {};
  const judge = res.judge || {};
  const steps = (d.steps || []).map((st) => `<tr class="clickable" data-rvstep="${st.id}">
    <td>${st.stage_no}</td><td>${esc(st.stage_type)}</td><td>${esc(rvAgentLabel(st.agent_key))}</td>
    <td class="mono">${esc(st.model)}</td><td>${st.ok ? "✓" : `<span class="bad-txt">✗ ${esc(st.error || "")}</span>`}</td>
    <td class="mono">${dur(st.ms)}</td><td class="mono">${st.tokens_in || 0}/${st.tokens_out || 0}</td></tr>`).join("");
  const agents = Object.entries(snap.agents || {}).map(([k, a]) => `<tr><td>${esc(a.label)}</td><td class="mono">${esc(a.model)}</td>
    <td class="mono" style="font-size:11px">${esc(JSON.stringify(a.options || {}))}</td></tr>`).join("");
  const tstate = run.transition_state;
  $("#m-body").innerHTML = `
    <div class="card" style="margin-bottom:10px"><h3>Итог</h3>
      <div style="font-size:15px">${rvVerdictTag(run.verdict)} уверенность ${num(run.confidence)}</div>
      <p>${esc(run.summary || run.error || "—")}</p>
      ${(judge.key_findings || []).length ? `<ul class="tight">${judge.key_findings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${judge.dissent ? `<div class="sub">Особое мнение: ${esc(judge.dissent)}</div>` : ""}
      ${(judge.next_steps || []).length ? `<div class="sub">Шаги: ${esc(judge.next_steps.join("; "))}</div>` : ""}
      <div class="sub" style="margin-top:6px">Политика: ${esc((res.trace || []).join(" · "))}</div>
      ${pol.legacy_verdict && pol.legacy_verdict !== run.verdict ? `<div class="sub">Прежняя политика дала бы ${rvVerdictTag(pol.legacy_verdict)}
        — разница из-за опоры находок и встречной проверки (§17.5)</div>` : ""}
      ${(res.checks_seen || []).length ? `<div class="sub">Проверки с результатом в досье: ${esc(res.checks_seen.map((c) => `${c.check} ${c.result}`).join(", "))}</div>` : ""}
      ${snap.glm ? `<div class="sub"><span class="tag cloud">GLM 5.x</span> все агенты на GLM Coding API</div>` : ""}
      ${snap.escalation ? `<div class="sub"><span class="tag cloud">☁ облако</span> ждал памяти
        ${Math.round((snap.escalation.waited_s || 0) / 60)} мин → ${esc(snap.escalation.provider)}:
        ${esc(Object.entries(snap.escalation.models || {}).map(([k, v]) => `${k} ${v.from} → ${v.to}`).join("; "))}</div>` : ""}
      <div class="sub">Переход: ${esc(RV_TSTATE[tstate] || "—")} ${run.transition_target ? `→ «${esc(run.transition_target)}»` : ""}
        ${esc(run.transition_note || "")} · комментарий на доске: ${esc(run.comment_state)}</div>
    </div>
    <div class="card" style="margin-bottom:10px"><h3>Голоса</h3><div class="tablewrap"><table>
      <thead><tr><th>Агент</th><th>Голос</th><th>Увер.</th><th>Вывод</th></tr></thead><tbody>${votes || emptyRow(4, "нет")}</tbody></table></div></div>
    <div class="card" style="margin-bottom:10px"><h3>Находки (зачёркнуты снятые)</h3><div class="tablewrap"><table>
      <thead><tr><th>ID</th><th>Важность</th><th>Кто</th><th>Что</th></tr></thead><tbody>${findings || emptyRow(4, "нет")}</tbody></table></div></div>
    ${talk ? `<div class="card" style="margin-bottom:10px"><h3>Переписка агентов</h3><div class="tablewrap"><table>
      <thead><tr><th>Тип</th><th>Кто → кому</th><th>Вопрос</th><th>Ответ</th></tr></thead><tbody>${talk}</tbody></table></div></div>` : ""}
    <details><summary>Транскрипт: ${d.steps.length} вызовов (клик — промпт и ответ)</summary><div><div class="tablewrap"><table>
      <thead><tr><th>#</th><th>Стадия</th><th>Агент</th><th>Модель</th><th></th><th>Время</th><th>Токены in/out</th></tr></thead>
      <tbody>${steps}</tbody></table></div></div></details>
    <details><summary>Снимок условий запуска (модели и параметры)</summary><div><div class="tablewrap"><table>
      <thead><tr><th>Агент</th><th>Модель</th><th>options</th></tr></thead><tbody>${agents}</tbody></table></div>
      <pre class="dump">${esc(JSON.stringify({ selection: snap.selection, warnings: snap.warnings, board_policy: snap.board_policy, dossier: res.dossier }, null, 1))}</pre></div></details>
    ${(d.audit || []).length ? `<details><summary>Аудит (${d.audit.length})</summary><div>${d.audit.map((a) =>
      `<div class="mono sub">${new Date(a.at * 1000).toLocaleString()} · ${esc(a.action)} · ${esc(a.actor)} ${esc(a.from_status || "")} ${a.to_status ? "→ " + esc(a.to_status) : ""} ${esc(a.detail || "")}</div>`).join("")}</div></details>` : ""}`;
  // Применить можно только при разрешённом переводе на доске: «нет» в политике — значит нет.
  const allowed = !!RV.state?.boards?.[run.board]?.allow_transition;
  const canDecide = allowed && run.transition_target && run.status === "done"
    && ["proposed", "none", "failed", "skipped"].includes(tstate);
  $("#m-foot").innerHTML = `
    ${["queued", "running"].includes(run.status) ? `<button class="act bad" id="rv-cancel">Отменить</button>` : ""}
    <button class="act" id="rv-rerun">Перезапустить</button><span class="spacer"></span>
    ${canDecide ? `<span class="sub">${tstate === "proposed" ? "политика предлагает" : "рекомендация"}: «${esc(run.transition_target)}»</span>
      <button class="act bad" data-rvreject="${esc(run.id)}">Отклонить</button>
      <button class="act ok" data-rvapprove="${esc(run.id)}">Подтвердить переход</button>` : ""}`;
  rvBindRunButtons($("#m-foot"));
  if ($("#rv-cancel")) $("#rv-cancel").onclick = async () => {
    try { const r = await post(`/api/review/runs/${run.id}/cancel`, {}); toast(r.state); rvOpenRun(run.id); }
    catch (err) { toast(err.message, true); }
  };
  $("#rv-rerun").onclick = async () => {
    try {
      const r = await post("/api/review/runs", { card: run.card_id, profile: run.profile_id, request: run.request || {}, force: true });
      toast(`в очереди: ${r.queued[0]?.run_id || "—"}`); modal.close(); renderReview();
    } catch (err) { toast(err.message, true); }
  };
  $("#m-body").querySelectorAll("[data-rvstep]").forEach((tr) => {
    tr.onclick = async () => {
      const st = (await api(`/api/review/steps/${tr.dataset.rvstep}`)).step;
      const next = tr.nextElementSibling;
      if (next && next.dataset.detail) { next.remove(); return; }
      const row = document.createElement("tr");
      row.dataset.detail = "1";
      row.innerHTML = `<td colspan="7"><div class="sub">params: <span class="mono">${esc(JSON.stringify(st.params))}</span></div>
        <details><summary>Промпт</summary><div><pre class="dump">${esc(st.prompt)}</pre></div></details>
        <pre class="dump">${esc(st.response || st.error || "")}</pre></td>`;
      tr.after(row);
    };
  });
  if (!modal.open) modal.showModal();
}

/* ── история ──────────────────────────────────────────────────────────── */
async function rvHistory() {
  const d = await api("/api/review/runs?limit=100" + (RV.histStatus ? `&status=${RV.histStatus}` : ""));
  const rows = d.runs.map((r) => `<tr class="clickable" data-rvopen="${esc(r.id)}">
    <td class="faint">${ago(r.created_at)}</td><td>${rvStatusTag(r.status)}</td>
    <td class="wrap">${esc(r.card_title)}</td><td>${esc(r.profile_name || "")}<div class="faint">${esc(r.method || "")}</div></td>
    <td>${rvVerdictTag(r.verdict)} ${r.confidence != null ? `<span class="faint">${num(r.confidence)}</span>` : ""}</td>
    <td>${esc(RV_TSTATE[r.transition_state] || "")} ${r.transition_target ? "→ " + esc(r.transition_target) : ""}</td>
    <td class="faint">${esc(r.requested_by || "")}</td><td class="mono">${dur(r.wall_ms)}</td></tr>`).join("");
  $("#rv-body").innerHTML = `<div class="toolbar"><select id="rv-hstatus">
      ${["", "queued", "running", "done", "failed", "cancelled"].map((x) => `<option value="${x}" ${RV.histStatus === x ? "selected" : ""}>${x || "все статусы"}</option>`).join("")}
    </select><span class="sub">обновляется каждые 8 с</span></div>
    <div class="card"><div class="tablewrap"><table><thead><tr><th>Когда</th><th>Статус</th><th>Карточка</th><th>Профиль</th>
      <th>Вердикт</th><th>Переход</th><th>Кто</th><th>Время</th></tr></thead>
      <tbody>${rows || emptyRow(8, "прогонов ещё не было")}</tbody></table></div></div>`;
  $("#rv-hstatus").onchange = (e) => { RV.histStatus = e.target.value; rvHistory(); };
  rvBindRunButtons($("#rv-body"));
}
