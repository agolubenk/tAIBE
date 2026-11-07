/* Вкладка «Ревью», часть 2 — редакторы настроек: профили, агенты, доски, настройки.
   Часть 1 (каркас, очередь, dry-run, прогоны, история) — review.js; общее состояние RV и
   хелперы (rvLoad, rvModelOptions, rvChecked, BOARD_RU) объявлены там. Порядок тегов
   <script> в index.html: review.js → review-settings.js → основной скрипт. */
"use strict";

/* ── профили ──────────────────────────────────────────────────────────── */
function rvBlankProfile() {
  const c = RV.state.catalog;
  return { id: "", name: "", is_default: false, version: 0, spec: {
    description: "", method: "ADVERSARIAL", participant_mode: "MANUAL", auto_strategy: "rules",
    agents: ["code_reviewer", "dod_auditor"], judge: "judge", adversary: "devils_advocate", max_agents: 4,
    default_model: "", judge_model: "", stages: [], rubric: c.default_rubric, tokens: { ...c.default_tokens },
    verdict: { ...c.default_verdict }, overrides: {}, context: { use_rag: true, use_git: true,
    include_comments: true, include_council_block: true }, note: "" } };
}

async function rvProfiles() {
  const s = RV.state;
  if (!RV.editProfile) RV.editProfile = JSON.parse(JSON.stringify(s.profiles.find((p) => p.is_default) || s.profiles[0] || rvBlankProfile()));
  const list = s.profiles.map((p) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
    <a href="#" data-rvprof="${esc(p.id)}" style="flex:1">${esc(p.name)}</a>
    ${p.is_default ? `<span class="tag ok">по умолчанию</span>` : ""}
    <span class="tag">${esc((s.catalog.methods.find((m) => m.key === p.spec.method) || {}).label || p.spec.method)}</span>
    <span class="faint">v${p.version}</span></div>`).join("");
  $("#rv-body").innerHTML = `<div class="split">
    <div class="card"><h3>Профили ревью</h3>${list}
      <div class="row" style="margin-top:10px"><button class="act" id="rv-prof-new">+ Новый профиль</button></div></div>
    <div class="card" id="rv-prof-form"></div></div>`;
  $("#rv-body").querySelectorAll("[data-rvprof]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); RV.editProfile = JSON.parse(JSON.stringify(s.profiles.find((p) => p.id === a.dataset.rvprof))); rvProfileForm(); };
  });
  $("#rv-prof-new").onclick = () => { RV.editProfile = rvBlankProfile(); rvProfileForm(); };
  rvProfileForm();
}

function rvProfileForm() {
  const s = RV.state, p = RV.editProfile, sp = p.spec, c = s.catalog;
  const method = c.methods.find((m) => m.key === sp.method) || c.methods[0];
  const reviewers = s.agents.filter((a) => a.kind === "reviewer");
  const adversaries = s.agents.filter((a) => a.kind === "adversary");
  const judges = s.agents.filter((a) => a.kind === "judge");
  const tk = sp.tokens || c.default_tokens, vd = sp.verdict || c.default_verdict, cx = sp.context || {};
  const cs = { ...(c.default_consult || { ask: 0, cross_check: 3, outside_roster: true }), ...(sp.consult || {}) };
  const cs_lim = c.consult_limits || { ask: 4, cross_check: 6 };
  const roster = [...new Set([...(sp.agents || []), sp.adversary, sp.judge].filter(Boolean))];
  const ovRows = roster.map((k) => {
    const ov = (sp.overrides || {})[k] || {}, pr = ov.params || {};
    const agent = s.agents.find((a) => a.key === k) || {};
    return `<tr><td>${esc(agent.label || k)}<div class="faint">${esc(agent.model || "модель профиля")}</div></td>
      <td><select data-ov="${esc(k)}" data-ovf="model">${rvModelOptions(ov.model || "", "как у агента/профиля")}</select></td>
      <td><input type="number" step="0.05" min="0" max="2" style="width:80px" data-ov="${esc(k)}" data-ovf="temperature" value="${pr.temperature ?? ""}" placeholder="${agent.params?.temperature ?? ""}"></td>
      <td><input type="number" min="-1" style="width:90px" data-ov="${esc(k)}" data-ovf="num_predict" value="${pr.num_predict ?? ""}" placeholder="—"></td>
      <td><select data-ov="${esc(k)}" data-ovf="can_block"><option value="">как у агента (${agent.can_block ? "да" : "нет"})</option>
        <option value="1" ${ov.can_block === true ? "selected" : ""}>да</option><option value="0" ${ov.can_block === false ? "selected" : ""}>нет</option></select></td></tr>`;
  }).join("");
  const stagesBlock = method.custom ? `<div class="stack" id="rvf-stages">${(sp.stages && sp.stages.length ? sp.stages : method.stages).map((st, i) => `
      <div class="row" data-stage="${i}"><span class="faint">${i + 1}.</span>
        <select data-stf="type">${c.stage_types.map((t) => `<option ${t === st.type ? "selected" : ""}>${t}</option>`).join("")}</select>
        <select data-stf="flavor">${c.flavors.map((f) => `<option value="${f}" ${f === (st.flavor || "") ? "selected" : ""}>${f || "без оттенка"}</option>`).join("")}</select>
        <input type="text" data-stf="agents" placeholder="агенты через запятую (пусто — состав профиля)" value="${esc((st.agents || []).join(","))}" style="flex:1">
        <button class="act icon" data-stdel="${i}">✕</button></div>`).join("")}
      <div><button class="act" id="rvf-stadd">+ стадия</button></div></div>`
    : `<div class="sub">Стадии метода: ${method.stages.map((st) => esc(st.type + (st.flavor ? "/" + st.flavor : ""))).join(" → ")}</div>`;
  $("#rv-prof-form").innerHTML = `
    <h3>${p.id ? "Профиль v" + p.version : "Новый профиль"}</h3>
    <label class="field"><span>Название</span><input type="text" id="rvf-name" value="${esc(p.name)}" style="flex:2"></label>
    <label class="field"><span>Описание</span><input type="text" id="rvf-desc" value="${esc(sp.description || "")}" style="flex:2"></label>
    <label class="field"><span>Метод ревью<div class="faint">${esc(method.about)}</div></span>
      <select id="rvf-method">${c.methods.map((m) => `<option value="${m.key}" ${m.key === sp.method ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>
    ${stagesBlock}
    <label class="field"><span>Состав консилиума</span><span class="row">
      ${[["MANUAL", "вручную"], ["AUTO", "автоподбор по задаче"], ["HYBRID", "обязательные + автоподбор"]].map(([v, t]) =>
        `<label><input type="radio" name="rvf-mode" value="${v}" ${sp.participant_mode === v ? "checked" : ""}> ${t}</label>`).join("")}</span></label>
    <label class="field"><span>Автоподбор: стратегия · максимум участников</span><span class="row">
      <select id="rvf-strategy"><option value="rules" ${sp.auto_strategy !== "llm" ? "selected" : ""}>правила (сигналы карточки, причины видны)</option>
        <option value="llm" ${sp.auto_strategy === "llm" ? "selected" : ""}>модель выбирает из каталога (+1 вызов)</option></select>
      <input type="number" id="rvf-max" min="1" max="8" value="${sp.max_agents || 4}" style="width:70px"></span></label>
    <div style="padding:7px 0;border-bottom:1px solid var(--line)"><div class="sub">Ревьюеры (для «вручную» — состав, для гибрида — обязательные)</div>
      <div class="chip-row" style="margin-top:6px">${reviewers.map((a) => `<label class="tag" style="cursor:pointer" title="${esc(a.focus || "")}">
        <input type="checkbox" data-rvfagent="${esc(a.key)}" ${rvChecked((sp.agents || []).includes(a.key))}> ${esc(a.label)}${a.can_block ? " ⛔" : ""}${a.enabled === false ? " (выкл)" : ""}</label>`).join("")}</div></div>
    <label class="field"><span>Оппонент · судья</span><span class="row">
      <select id="rvf-adv"><option value="">—</option>${adversaries.map((a) => `<option value="${a.key}" ${a.key === sp.adversary ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select>
      <select id="rvf-judge"><option value="">—</option>${judges.map((a) => `<option value="${a.key}" ${a.key === sp.judge ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select></span></label>
    <label class="field"><span>Модель по умолчанию · модель судьи<div class="faint">для агентов без своей модели</div></span><span class="row">
      <select id="rvf-model">${rvModelOptions(sp.default_model || "", "из настроек ревью")}</select>
      <select id="rvf-jmodel">${rvModelOptions(sp.judge_model || "", "из настроек ревью")}</select></span></label>
    <label class="field"><span>Вход (контекст)<div class="faint">«максимум» — окно модели, но не выше потолка в настройках</div></span><span class="row">
      ${[["inherit", "как у агента"], ["limit", "ограничить до"], ["max", "до максимума модели"]].map(([v, t]) =>
        `<label><input type="radio" name="rvf-in" value="${v}" ${tk.input_mode === v ? "checked" : ""}> ${t}</label>`).join("")}
      <input type="number" id="rvf-inlim" value="${tk.input_limit}" min="2048" step="1024" style="width:100px"> ток.</span></label>
    <label class="field"><span>Выход агента</span><span class="row">
      ${[["inherit", "как у агента"], ["limit", "до"], ["unlimited", "без искусственного лимита"]].map(([v, t]) =>
        `<label><input type="radio" name="rvf-out" value="${v}" ${tk.output_mode === v ? "checked" : ""}> ${t}</label>`).join("")}
      <input type="number" id="rvf-outlim" value="${tk.output_limit}" min="256" step="256" style="width:90px"> ток.</span></label>
    <label class="field"><span>Политика вердикта</span><span class="row">
      <label><input type="checkbox" id="rvf-block" ${rvChecked(vd.blocking)}> вето ролей ⛔</label>
      <label><input type="checkbox" id="rvf-crit" ${rvChecked(vd.reject_on_critical)}> critical = FAIL</label>
      <label><input type="checkbox" id="rvf-major" ${rvChecked(vd.major_needs_human !== false)}> major при accept = нужен человек</label>
      <label><input type="checkbox" id="rvf-inc" ${rvChecked(vd.allow_inconclusive)}> «неоднозначно»</label>
      <label><input type="checkbox" id="rvf-tie" ${rvChecked(vd.judge_tiebreak)}> судья разрешает ничью</label>
      <label title="FAIL — только находки с опорой в диффе, подтверждённые не автором, если автор голосует fail или не голосует (оппонент); иначе и без опоры — человек, не ACCEPT (§17.5)">
        <input type="checkbox" id="rvf-gate" ${rvChecked(vd.evidence_gate !== false)}> гейт улик</label></span></label>
    <label class="field"><span>Переписка агентов<div class="faint">вопросы коллегам по имени и встречная проверка решающих находок</div></span><span class="row">
      <span class="sub">вопросов за прогон</span><input type="number" id="rvf-ask" min="0" max="${cs_lim.ask}" value="${cs.ask}" style="width:60px">
      <span class="sub">встречных проверок</span><input type="number" id="rvf-xcheck" min="0" max="${cs_lim.cross_check}" value="${cs.cross_check}" style="width:60px">
      <label><input type="checkbox" id="rvf-oncall" ${rvChecked(cs.outside_roster !== false)}> можно спросить специалиста вне состава</label></span></label>
    <label class="field"><span>Пороги: accept · fail · мин. уверенность</span><span class="row">
      <input type="number" id="rvf-acc" step="0.05" min="0" max="1" value="${vd.accept_threshold}" style="width:70px">
      <input type="number" id="rvf-fail" step="0.05" min="0" max="1" value="${vd.fail_threshold}" style="width:70px">
      <input type="number" id="rvf-conf" step="0.05" min="0" max="1" value="${vd.min_confidence}" style="width:70px"></span></label>
    <label class="field"><span>Контекст ревьюеров</span><span class="row">
      <label><input type="checkbox" id="rvf-git" ${rvChecked(cx.use_git !== false)}> git (коммиты, дифф, DONE.md)</label>
      <label><input type="checkbox" id="rvf-rag" ${rvChecked(cx.use_rag !== false)}> правила/знания (RAG)</label>
      <label><input type="checkbox" id="rvf-com" ${rvChecked(cx.include_comments !== false)}> комментарии</label>
      <label><input type="checkbox" id="rvf-cb" ${rvChecked(cx.include_council_block !== false)}> блок проработки</label></span></label>
    <details><summary>Модель и параметры агентов в этом профиле (пусто — наследовать)</summary><div><div class="tablewrap"><table>
      <thead><tr><th>Агент</th><th>Модель</th><th>Temp</th><th>Выход</th><th>Вето</th></tr></thead><tbody>${ovRows}</tbody></table></div>
      <div class="faint">Остальные параметры (top_p, top_k, seed, num_ctx…) — на вкладке «Агенты».</div></div></details>
    ${sp.method === "EVALUATIVE" ? `<div style="padding:7px 0"><div class="sub">Рубрика (по строке на критерий)</div>
      <textarea id="rvf-rubric" rows="5">${esc((sp.rubric || c.default_rubric).join("\n"))}</textarea></div>` : ""}
    <div style="padding:7px 0"><div class="sub">Постоянное указание консилиуму в этом профиле</div>
      <textarea id="rvf-note" rows="2">${esc(sp.note || "")}</textarea></div>
    <div class="row" style="margin-top:8px">
      <button class="act accent" id="rvf-save">Сохранить${p.id ? " (новая версия)" : ""}</button>
      ${p.id ? `<button class="act" id="rvf-copy">Сохранить как копию</button>
        ${p.is_default ? "" : `<button class="act" id="rvf-default">Сделать по умолчанию</button>
        <button class="act bad" id="rvf-archive">В архив</button>`}` : ""}</div>`;
  const form = $("#rv-prof-form");
  $("#rvf-method").onchange = (e) => { rvReadProfileForm(); RV.editProfile.spec.method = e.target.value; RV.editProfile.spec.stages = []; rvProfileForm(); };
  if ($("#rvf-stadd")) $("#rvf-stadd").onclick = () => { rvReadProfileForm(); const st = RV.editProfile.spec.stages;
    if (!st.length) st.push(...method.stages.map((x) => ({ ...x }))); st.splice(st.length - 1, 0, { type: "independent", flavor: "", agents: [] }); rvProfileForm(); };
  form.querySelectorAll("[data-stdel]").forEach((b) => { b.onclick = () => { rvReadProfileForm();
    RV.editProfile.spec.stages.splice(+b.dataset.stdel, 1); rvProfileForm(); }; });
  form.querySelectorAll("[data-rvfagent]").forEach((cb) => { cb.onchange = () => { rvReadProfileForm(); rvProfileForm(); }; });
  const save = async (asCopy) => {
    rvReadProfileForm();
    const pp = RV.editProfile;
    try {
      const r = await post("/api/review/profiles", { id: asCopy ? "" : pp.id, name: asCopy ? pp.name + " (копия)" : pp.name, spec: pp.spec });
      RV.editProfile = JSON.parse(JSON.stringify(r.profile));
      toast(`сохранено: «${r.profile.name}» v${r.profile.version}`);
      await rvLoad(true); rvProfiles();
    } catch (err) { toast(err.message, true); }
  };
  $("#rvf-save").onclick = () => save(false);
  if ($("#rvf-copy")) $("#rvf-copy").onclick = () => save(true);
  if ($("#rvf-default")) $("#rvf-default").onclick = async () => {
    try { await post(`/api/review/profiles/${p.id}/default`, {}); toast("профиль по умолчанию"); await rvLoad(true); RV.editProfile = null; rvProfiles(); }
    catch (err) { toast(err.message, true); } };
  if ($("#rvf-archive")) $("#rvf-archive").onclick = async () => {
    try { await post(`/api/review/profiles/${p.id}/archive`, {}); toast("в архиве"); RV.editProfile = null; await rvLoad(true); rvProfiles(); }
    catch (err) { toast(err.message, true); } };
}

function rvReadProfileForm() {
  const p = RV.editProfile, sp = p.spec, val = (id) => $(id)?.value;
  p.name = val("#rvf-name") ?? p.name;
  sp.description = val("#rvf-desc") ?? sp.description;
  sp.method = val("#rvf-method") || sp.method;
  sp.participant_mode = document.querySelector("input[name=rvf-mode]:checked")?.value || sp.participant_mode;
  sp.auto_strategy = val("#rvf-strategy") || "rules";
  sp.max_agents = +(val("#rvf-max") || 4);
  sp.agents = [...document.querySelectorAll("[data-rvfagent]")].filter((x) => x.checked).map((x) => x.dataset.rvfagent);
  sp.adversary = val("#rvf-adv") ?? sp.adversary;
  sp.judge = val("#rvf-judge") ?? sp.judge;
  sp.default_model = val("#rvf-model") ?? "";
  sp.judge_model = val("#rvf-jmodel") ?? "";
  sp.tokens = { input_mode: document.querySelector("input[name=rvf-in]:checked")?.value || "inherit",
    input_limit: +(val("#rvf-inlim") || 10000), output_mode: document.querySelector("input[name=rvf-out]:checked")?.value || "inherit",
    output_limit: +(val("#rvf-outlim") || 2500), compress: true };
  // Поверх сохранённого объекта: поля, которых нет в форме, не теряются при сохранении.
  sp.verdict = { ...(sp.verdict || {}), blocking: $("#rvf-block").checked, reject_on_critical: $("#rvf-crit").checked,
    evidence_gate: $("#rvf-gate") ? $("#rvf-gate").checked : (sp.verdict || {}).evidence_gate !== false,
    major_needs_human: $("#rvf-major").checked,
    allow_inconclusive: $("#rvf-inc").checked, judge_tiebreak: $("#rvf-tie").checked,
    accept_threshold: +val("#rvf-acc"), fail_threshold: +val("#rvf-fail"), min_confidence: +val("#rvf-conf") };
  if ($("#rvf-ask")) sp.consult = { ask: +($("#rvf-ask").value || 0), cross_check: +($("#rvf-xcheck").value || 0),
    outside_roster: $("#rvf-oncall").checked };
  sp.context = { use_git: $("#rvf-git").checked, use_rag: $("#rvf-rag").checked,
    include_comments: $("#rvf-com").checked, include_council_block: $("#rvf-cb").checked };
  if ($("#rvf-rubric")) sp.rubric = $("#rvf-rubric").value.split("\n").map((x) => x.trim()).filter(Boolean);
  sp.note = val("#rvf-note") ?? sp.note;
  const ov = {};
  document.querySelectorAll("[data-ov]").forEach((el) => {
    const k = el.dataset.ov, f = el.dataset.ovf, v = el.value;
    if (v === "") return;
    ov[k] = ov[k] || { model: "", params: {} };
    if (f === "model") ov[k].model = v;
    else if (f === "can_block") ov[k].can_block = v === "1";
    else ov[k].params[f] = +v;
  });
  sp.overrides = ov;
  const stages = [...document.querySelectorAll("#rvf-stages [data-stage]")].map((row) => ({
    type: row.querySelector("[data-stf=type]").value, flavor: row.querySelector("[data-stf=flavor]").value,
    agents: row.querySelector("[data-stf=agents]").value.split(",").map((x) => x.trim()).filter(Boolean) }));
  if (stages.length) sp.stages = stages;
}

/* ── агенты ───────────────────────────────────────────────────────────── */
async function rvAgents() {
  const s = RV.state;
  const rows = s.agents.map((a) => `<tr class="clickable" data-rvagent="${esc(a.key)}">
    <td><b>${esc(a.label)}</b><div class="faint mono">${esc(a.key)}</div></td><td>${esc(a.kind)}</td>
    <td class="mono">${esc(a.model || "наследует")}</td>
    <td class="mono" style="font-size:11px">${esc(Object.entries(a.params || {}).map(([k, v]) => `${k}=${v}`).join(" "))}</td>
    <td>${a.can_block ? `<span class="tag bad">вето</span>` : ""}</td>
    <td>${a.enabled === false ? `<span class="tag">выкл</span>` : `<span class="tag ok">вкл</span>`}</td>
    <td class="sub">${a.builtin ? "встроенный" : "свой"}</td></tr>`).join("");
  $("#rv-body").innerHTML = `<div class="toolbar"><button class="act accent" id="rv-agent-new">+ Новый агент</button>
      <button class="act" id="rv-agent-reset" title="Вернуть встроенным агентам стандартные промпты и параметры">Сбросить встроенных</button>
      <span class="sub">клик по строке — роль, модель, тонкая настройка параметров</span></div>
    <div class="card"><div class="tablewrap"><table><thead><tr><th>Агент</th><th>Тип</th><th>Модель</th><th>Параметры</th>
      <th></th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="card" id="rv-agent-stats"><h3>Вклад ролей</h3><div class="sub">загрузка…</div></div>`;
  rvAgentStats();
  $("#rv-body").querySelectorAll("[data-rvagent]").forEach((tr) => { tr.onclick = () => rvAgentModal(tr.dataset.rvagent); });
  $("#rv-agent-new").onclick = () => rvAgentModal("");
  $("#rv-agent-reset").onclick = async () => {
    if (!confirm("Сбросить встроенных агентов к стандартным настройкам?")) return;
    try { await post("/api/review/agents/reset", {}); toast("встроенные агенты сброшены"); await rvLoad(true); rvAgents(); }
    catch (err) { toast(err.message, true); } };
}

/* Вклад ролей (§17.5): не объём обсуждения, а что роль даёт решению — неснятые и
   уникальные находки, решающие (с опорой в диффе), вопросы коллегам, цена в секундах. */
async function rvAgentStats() {
  const box = $("#rv-agent-stats");
  try {
    const d = await api("/api/review/stats?what=agents");
    const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
    const rows = (d.agents || []).filter((a) => a.runs || a.calls).map((a) => `<tr><td>${esc(a.label)}</td>
      <td class="mono">${a.runs || 0}</td><td class="mono">${a.findings || 0}</td><td class="mono">${pct(a.refuted_share)}</td>
      <td class="mono">${pct(a.unique_share)}</td><td class="mono">${a.decisive || 0}</td>
      <td class="mono">${a.asked || 0}/${a.answered || 0}</td><td class="mono">${a.avg_s ?? "—"} с</td></tr>`).join("");
    box.innerHTML = `<h3>Вклад ролей — ${d.runs} прогонов</h3>
      <div class="sub">снято — доля находок, снятых оппонентом/кодом; уникальные — больше никто в прогоне не нашёл;
        решающие — с опорой в диффе. Пересчёт вердиктов текущей политикой: <code>review_cli.py stats replay</code>.</div>
      <div class="tablewrap"><table><thead><tr><th>Роль</th><th>Прогонов</th><th>Находок</th><th>Снято</th>
      <th>Уникальные</th><th>Решающие</th><th>Спросил/ответил</th><th>⌀ вызов</th></tr></thead>
      <tbody>${rows || emptyRow(8, "прогонов ещё нет")}</tbody></table></div>`;
  } catch (err) { box.innerHTML = `<h3>Вклад ролей</h3><div class="bad-txt">${esc(err.message)}</div>`; }
}

function rvAgentModal(key) {
  const s = RV.state, modal = $("#modal");
  const a = s.agents.find((x) => x.key === key) || { key: "", label: "", kind: "reviewer", focus: "", model: "",
    params: {}, can_block: false, enabled: true, triggers: { always: false, boards: [], keywords: [], modules: [] }, builtin: false };
  const t = a.triggers || {};
  const spec = s.catalog.params;
  const ctx = (RV.models?.local || []).find((m) => m.name === a.model)?.context;
  const params = Object.entries(spec).map(([name, ps]) => {
    const v = (a.params || {})[name];
    let input;
    if (ps.type === "bool") input = `<select data-prm="${name}"><option value="">наследовать</option>
      <option value="true" ${v === true ? "selected" : ""}>да</option><option value="false" ${v === false ? "selected" : ""}>нет</option></select>`;
    else if (ps.type === "list") input = `<input type="text" data-prm="${name}" placeholder="через |" value="${esc((v || []).join("|"))}">`;
    else if (ps.type === "str") input = `<input type="text" data-prm="${name}" value="${esc(v ?? "")}" style="width:110px">`;
    else input = `<input type="number" data-prm="${name}" step="${ps.type === "float" ? "0.01" : "1"}" ${ps.min != null ? `min="${ps.min}"` : ""} ${ps.max != null ? `max="${ps.max}"` : ""} value="${v ?? ""}" style="width:110px">`;
    return `<label class="field"><span>${esc(ps.label)}${ps.hint ? `<div class="faint">${esc(ps.hint)}</div>` : ""}</span>${input}</label>`;
  }).join("");
  $("#m-title").textContent = key ? `Агент: ${a.label}` : "Новый агент";
  $("#m-sub").textContent = a.builtin ? "встроенный — можно править и выключить, удалить нельзя" : "";
  $("#m-body").innerHTML = `<div class="split">
    <div class="card"><h3>Роль</h3>
      <label class="field"><span>Ключ</span><input type="text" id="ra-key" value="${esc(a.key)}" ${key ? "disabled" : ""} placeholder="latin_snake_case"></label>
      <label class="field"><span>Название</span><input type="text" id="ra-label" value="${esc(a.label)}"></label>
      <label class="field"><span>Тип</span><select id="ra-kind">${s.catalog.kinds.map((k) => `<option ${k === a.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
      <div class="sub" style="margin-top:6px">Фокус роли (что ищет, на что смотрит)</div>
      <textarea id="ra-focus" rows="5">${esc(a.focus || "")}</textarea>
      <label class="field"><span>Модель<div class="faint">${ctx ? `окно модели: ${ctx} токенов` : "пусто — модель профиля"}</div></span>
        <select id="ra-model">${rvModelOptions(a.model || "", "модель профиля")}</select></label>
      <label class="field"><span>Право вето (блокирующее ревью)</span><input type="checkbox" id="ra-block" ${rvChecked(a.can_block)}></label>
      <label class="field"><span>Включён</span><input type="checkbox" id="ra-enabled" ${rvChecked(a.enabled !== false)}></label>
      <h3 style="margin-top:12px">Автоподбор — когда звать</h3>
      <label class="field"><span>Всегда</span><input type="checkbox" id="ra-always" ${rvChecked(t.always)}></label>
      <label class="field"><span>Доски</span><span class="row">${["bugs", "tasks"].map((b) => `<label><input type="checkbox" data-raboard="${b}" ${rvChecked((t.boards || []).includes(b))}> ${BOARD_RU[b]}</label>`).join("")}</span></label>
      <div class="sub">Ключевые слова (через запятую, подстрока в тексте карточки)</div>
      <textarea id="ra-kw" rows="2">${esc((t.keywords || []).join(", "))}</textarea>
      <div class="sub">Модули карточки (через запятую)</div>
      <input type="text" id="ra-mod" value="${esc((t.modules || []).join(", "))}" style="width:100%">
    </div>
    <div class="card"><h3>Тонкая настройка модели (локальная, Ollama) — пусто = наследовать</h3>${params}
      <div class="faint" style="margin-top:6px">Лимиты входа/выхода профиля (вкладка «Профили») применяются поверх num_ctx/num_predict агента.</div></div></div>`;
  $("#m-foot").innerHTML = `${key && !a.builtin ? `<button class="act bad" id="ra-del">Удалить</button>` : ""}
    <span class="spacer"></span><button class="act accent" id="ra-save">Сохранить</button>`;
  $("#ra-save").onclick = async () => {
    const prm = {};
    document.querySelectorAll("[data-prm]").forEach((el) => {
      const n = el.dataset.prm, ps = spec[n], v = el.value.trim();
      if (v === "") return;
      prm[n] = ps.type === "bool" ? v === "true" : ps.type === "list" ? v.split("|").filter(Boolean)
        : ps.type === "str" ? v : Number(v);
    });
    const body = { key: key || $("#ra-key").value.trim(), spec: {
      label: $("#ra-label").value, kind: $("#ra-kind").value, focus: $("#ra-focus").value, model: $("#ra-model").value,
      can_block: $("#ra-block").checked, enabled: $("#ra-enabled").checked, params: prm,
      triggers: { always: $("#ra-always").checked,
        boards: [...document.querySelectorAll("[data-raboard]")].filter((x) => x.checked).map((x) => x.dataset.raboard),
        keywords: $("#ra-kw").value.split(",").map((x) => x.trim()).filter(Boolean),
        modules: $("#ra-mod").value.split(",").map((x) => x.trim()).filter(Boolean) } } };
    try { await post("/api/review/agents", body); toast("агент сохранён"); modal.close(); await rvLoad(true); rvAgents(); }
    catch (err) { toast(err.message, true); }
  };
  if ($("#ra-del")) $("#ra-del").onclick = async () => {
    try { await post(`/api/review/agents/${key}/delete`, {}); toast("удалён"); modal.close(); await rvLoad(true); rvAgents(); }
    catch (err) { toast(err.message, true); } };
  if (!modal.open) modal.showModal();
}

/* ── доски ────────────────────────────────────────────────────────────── */
async function rvBoards() {
  const s = RV.state;
  const statuses = {};
  await Promise.all(["bugs", "tasks"].map(async (b) => {
    try { statuses[b] = await api(`/api/review/statuses?board=${b}`); }
    catch (e) { statuses[b] = { statuses: [], source: "error" }; }
  }));
  const sel = (b, field, val, allowEmpty = true) => `<select data-bf="${field}">${allowEmpty ? `<option value="">— не переводить —</option>` : ""}
    ${statuses[b].statuses.map((x) => `<option ${x === val ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
  $("#rv-body").innerHTML = `<div class="card" style="margin-bottom:12px;border-color:var(--warn-bd)">
      <div class="sub">Перевод статуса — единственная запись консилиума в Status (rules/17 §6: финальный статус —
      решение владельца). Политика доски, сохранённая здесь, и есть это решение: без «разрешить перевод» вердикт
      остаётся рекомендацией, с «подтверждением человека» — переход применяется кнопкой на прогоне. Перед записью
      статус карточки перечитывается: если её уже сдвинул человек, переход не применяется.</div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(420px,1fr))">${["bugs", "tasks"].map((b) => {
      const p = s.boards[b];
      return `<div class="card" data-board="${b}"><h3>${BOARD_RU[b]} <span class="faint">статусы: ${esc(statuses[b].source)}</span></h3>
        <label class="field"><span>Ревьюить эту доску</span><input type="checkbox" data-bf="enabled" ${rvChecked(p.enabled)}></label>
        <label class="field"><span>Статус «на ревью» (подпись; очередь — колонки ревью t-boards, sources.tboards.review_slugs)</span>${sel(b, "review_status", p.review_status, false)}</label>
        <label class="field"><span>Профиль доски</span><select data-bf="profile_id"><option value="">профиль по умолчанию</option>
          ${s.profiles.map((x) => `<option value="${esc(x.id)}" ${x.id === p.profile_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
        <label class="field"><span>Автозапуск<div class="faint">не действует: фона нет (Р0 б) — очередь обновляется кнопкой «Обновить из t-boards»</div></span>
          <input type="checkbox" data-bf="auto_run" ${rvChecked(p.auto_run)}></label>
        <label class="field"><span>Комментарий с итогом на карточке<div class="faint">не действует: на доску консилиум не пишет (AUTO-70 ч. 2)</div></span><input type="checkbox" data-bf="post_comment" ${rvChecked(p.post_comment)}></label>
        <label class="field"><span><b>Разрешить перевод статуса</b></span><input type="checkbox" data-bf="allow_transition" ${rvChecked(p.allow_transition)}></label>
        <label class="field"><span>Требовать подтверждение человека</span><input type="checkbox" data-bf="require_human_approval" ${rvChecked(p.require_human_approval)}></label>
        <label class="field"><span>ACCEPT →</span>${sel(b, "on_accept", p.on_accept)}</label>
        <label class="field"><span>FAIL →</span>${sel(b, "on_fail", p.on_fail)}</label>
        <label class="field"><span>Неоднозначно →</span>${sel(b, "on_inconclusive", p.on_inconclusive)}</label>
        <label class="field"><span>Нужен человек →</span>${sel(b, "on_needs_human", p.on_needs_human)}</label>
        <div class="row" style="margin-top:8px"><button class="act accent" data-bsave="${b}">Сохранить</button></div></div>`;
    }).join("")}</div>`;
  $("#rv-body").querySelectorAll("[data-bsave]").forEach((btn) => {
    btn.onclick = async () => {
      const b = btn.dataset.bsave, card = $(`[data-board=${b}]`), spec = {};
      card.querySelectorAll("[data-bf]").forEach((el) => { spec[el.dataset.bf] = el.type === "checkbox" ? el.checked : el.value; });
      if (spec.allow_transition && !spec.require_human_approval &&
          !confirm(`Переводы на доске «${BOARD_RU[b]}» будут применяться БЕЗ подтверждения человека. Продолжить?`)) return;
      try { await post("/api/review/boards", { board: b, spec }); toast(`политика доски «${BOARD_RU[b]}» сохранена`); await rvLoad(true); }
      catch (err) { toast(err.message, true); }
    };
  });
}

/* ── настройки ────────────────────────────────────────────────────────── */
async function rvSettings() {
  const st = RV.state.settings, m = RV.models || {};
  $("#rv-body").innerHTML = `<div class="card" style="max-width:820px"><h3>Настройки ревью</h3>
    <label class="field"><span>Модель по умолчанию<div class="faint">для агентов без модели, если и профиль не задал</div></span>
      <select data-rs="default_model">${rvModelOptions(st.default_model, "—")}</select></label>
    <label class="field"><span>Модель судьи по умолчанию</span><select data-rs="judge_model">${rvModelOptions(st.judge_model, "—")}</select></label>
    <label class="field"><span>Потолок num_ctx<div class="faint">«без лимита»/«до максимума» упираются сюда: 24 GB, L-модель + KV-кэш. Общий num_ctx консилиума: ${m.base_num_ctx || "?"}</div></span>
      <input type="number" data-rs="max_num_ctx" value="${st.max_num_ctx}" min="2048" step="1024" style="width:120px"></label>
    <label class="field"><span>Бюджет времени одного прогона, с</span><input type="number" data-rs="max_wall_seconds" value="${st.max_wall_seconds}" min="120" step="60" style="width:120px"></label>
    <label class="field"><span>Ревью раньше проработок<div class="faint">воркер сначала разбирает очередь ревью</div></span>
      <input type="checkbox" data-rs="priority_over_elaboration" ${rvChecked(st.priority_over_elaboration)}></label>
    <label class="field"><span>Воркер исполняет ревью<div class="faint">выключить — очередь копится, прогоны не идут</div></span>
      <input type="checkbox" data-rs="worker_enabled" ${rvChecked(st.worker_enabled)}></label>
    <div class="sub" style="margin-top:10px">Локальные модели исполняются строго последовательно (один воркер) — параллельный инференс на этой машине недопустим.
      Ollama: ${m.alive ? `жива, моделей ${m.local.length}` : "не отвечает"}.</div></div>`;
  $("#rv-body").querySelectorAll("[data-rs]").forEach((el) => {
    el.onchange = async () => {
      const value = el.type === "checkbox" ? el.checked : el.type === "number" ? +el.value : el.value;
      try { await post("/api/review/settings", { key: el.dataset.rs, value }); toast("сохранено"); await rvLoad(true); }
      catch (err) { toast(err.message, true); }
    };
  });
}
