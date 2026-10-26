const CFG = window.EP_CONFIG;
const DISC = CFG.DISCIPLINES;
const STATUS = ["미착수", "진행 중", "완료"];
const IMPACT = ["없음", "낮음", "보통", "높음"];
const BUCKET = "punch-photos";

const app = document.getElementById("app");
const configured = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("YOUR-PROJECT");
const sb = configured ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

const S = { session: null, me: null, systems: [], punches: [], profiles: {}, photoCount: {}, loaded: false };
const F = { q: "", sys: "", status: "open", grade: "", disc: "", impact: "", mine: false, late: false };
try { Object.assign(F, JSON.parse(localStorage.getItem("ep-filter") || "{}")); } catch (e) {}

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtTime = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const code = (p) => `${p.system_id}-${String(p.seq ?? 0).padStart(3, "0")}`;
const sysName = (id) => S.systems.find((s) => s.id === id)?.name || "";
const who = (id) => { const p = S.profiles[id]; return p ? (p.name || p.email || "이름 없음") + (p.company ? ` (${p.company})` : "") : "–"; };
const isLate = (p) => p.status !== "완료" && p.target_date && p.target_date < today();
const byId = (id) => S.punches.find((p) => p.id === Number(id));
const isBlocked = (p) => p.status !== "완료" && (p.depends_on || []).some((d) => { const x = byId(d); return x && x.status !== "완료"; });
const waitingOn = (p) => S.punches.filter((x) => (x.depends_on || []).includes(p.id));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 3000);
}
function fail(e, what = "저장") {
  console.error(e);
  toast(`${what}하지 못했습니다: ${e?.message || e}`);
}
function saveFilter() { try { localStorage.setItem("ep-filter", JSON.stringify(F)); } catch (e) {} }

function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map((o) => `<button type="button" data-v="${esc(o.v ?? o)}" aria-pressed="${(o.v ?? o) === value}">${esc(o.l ?? o)}</button>`).join("")}</div>`;
}
function bindSeg(root) {
  $$("[data-seg]", root).forEach((el) => el.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", el).forEach((x) => x.setAttribute("aria-pressed", x === b));
    el.dispatchEvent(new CustomEvent("segchange", { detail: b.dataset.v }));
  }));
}
const segVal = (root, name) => $(`[data-seg="${name}"] [aria-pressed="true"]`, root)?.dataset.v;
function chips(name, options, selected = []) {
  return `<div class="chips">${options.map((o) => `<label><input type="checkbox" name="${name}" value="${esc(o)}" ${selected.includes(o) ? "checked" : ""}>${esc(o)}</label>`).join("")}</div>`;
}
const chipVals = (root, name) => $$(`input[name="${name}"]:checked`, root).map((i) => i.value);

/* ---------------- photos ---------------- */
async function compress(file, max = 1600, quality = 0.8) {
  if (!file.type.startsWith("image/")) throw new Error("이미지 파일만 올릴 수 있습니다");
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
}
async function uploadPhotos(files, punchId, updateId = null) {
  let n = 0;
  for (const f of files) {
    const blob = await compress(f);
    const path = `${punchId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
    const ins = await sb.from("photos").insert({ punch_id: punchId, update_id: updateId, path });
    if (ins.error) throw ins.error;
    n++;
  }
  return n;
}
async function signed(paths) {
  if (!paths.length) return {};
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) { console.error(error); return {}; }
  return Object.fromEntries(data.map((d) => [d.path, d.signedUrl]));
}
function photoPicker(id) {
  return `<div class="photo-pick">
    <div class="row">
      <label class="btn sm" for="${id}-cam">사진 촬영</label>
      <label class="btn sm" for="${id}-lib">사진 선택</label>
      <span class="small muted" id="${id}-n"></span>
    </div>
    <input id="${id}-cam" type="file" accept="image/*" capture="environment" hidden>
    <input id="${id}-lib" type="file" accept="image/*" multiple hidden>
    <div class="prev" id="${id}-prev"></div>
  </div>`;
}
function bindPicker(root, id) {
  const files = [];
  const draw = () => {
    $(`#${id}-n`, root).textContent = files.length ? `${files.length}장 선택됨` : "";
    $(`#${id}-prev`, root).innerHTML = "";
    files.forEach((f, i) => {
      const img = document.createElement("img"); img.src = URL.createObjectURL(f); img.title = "누르면 제외";
      img.onclick = () => { files.splice(i, 1); draw(); };
      $(`#${id}-prev`, root).appendChild(img);
    });
  };
  for (const s of ["cam", "lib"]) $(`#${id}-${s}`, root).addEventListener("change", (e) => { files.push(...e.target.files); e.target.value = ""; draw(); });
  return files;
}
document.getElementById("lightbox").onclick = (e) => (e.currentTarget.hidden = true);
document.addEventListener("click", (e) => {
  const img = e.target.closest("img[data-full]"); if (!img) return;
  const lb = document.getElementById("lightbox"); $("img", lb).src = img.dataset.full; lb.hidden = false;
});

/* ---------------- data ---------------- */
async function loadAll() {
  const [sys, pun, prof, ph] = await Promise.all([
    sb.from("systems").select("*").order("sort").order("id"),
    sb.from("punches").select("*").order("system_id").order("seq"),
    sb.from("profiles").select("id,name,company,email,role,approved,created_at"),
    sb.from("photos").select("punch_id"),
  ]);
  for (const r of [sys, pun, prof, ph]) if (r.error) throw r.error;
  S.systems = sys.data; S.punches = pun.data;
  S.profiles = Object.fromEntries(prof.data.map((p) => [p.id, p]));
  S.photoCount = {}; ph.data.forEach((x) => (S.photoCount[x.punch_id] = (S.photoCount[x.punch_id] || 0) + 1));
  S.loaded = true;
}
let reloadTimer = null;
function subscribe() {
  sb.channel("ep-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "punches" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "punch_updates" }, scheduleReload)
    .subscribe();
}
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    if (document.querySelector("form[data-dirty]")) return; // 입력 중인 화면은 건드리지 않음
    try { await loadAll(); route(); } catch (e) { console.error(e); }
  }, 800);
}

/* ---------------- shell ---------------- */
const TABS = [["#/dash", "현황"], ["#/list", "Punch 목록"], ["#/impact", "선·후행 Impact"]];
function shell(active, body, fab = true) {
  const admin = S.me?.role === "admin";
  const tabs = [...TABS, ...(admin ? [["#/admin", "관리"]] : [])];
  app.innerHTML = `
  <header class="top"><div class="top-in">
    <div class="top-row">
      <div class="brand"><b>EP</b><span>${esc(CFG.PROJECT_TITLE)}</span></div>
      <div class="who"><span>${esc(S.me?.name || S.me?.email || "")}</span><button id="logout">로그아웃</button></div>
    </div>
    <nav class="tabs">${tabs.map(([h, l]) => `<a href="${h}" class="${active === h ? "on" : ""}">${l}</a>`).join("")}</nav>
  </div></header>
  <main>${body}</main>
  ${fab ? `<a class="btn primary fab" href="#/new">+ Punch 등록</a>` : ""}`;
  $("#logout").onclick = async () => { await sb.auth.signOut(); };
}

/* ---------------- dashboard ---------------- */
function viewDash() {
  const P = S.punches, n = (f) => P.filter(f).length;
  const kpi = (v, l, href, warn) => `<a class="kpi ${warn ? "warn" : ""}" href="${href}"><span class="n">${v}</span><span class="l">${l}</span></a>`;
  const cards = S.systems.map((s) => {
    const L = P.filter((p) => p.system_id === s.id), t = L.length;
    const s0 = L.filter((p) => p.status === "미착수").length, s1 = L.filter((p) => p.status === "진행 중").length, s2 = t - s0 - s1;
    const a = L.filter((p) => p.grade === "A" && p.status !== "완료").length;
    const hi = L.filter((p) => p.status !== "완료" && p.impact_level === "높음").length;
    const late = L.filter(isLate).length;
    return `<a class="sys" href="#/list" data-sys="${esc(s.id)}">
      <div class="t"><span class="id">${esc(s.id)}</span><span class="nm" title="${esc(s.name)}">${esc(s.name)}</span><span class="mono small muted">${t ? Math.round((s2 / t) * 100) : 0}%</span></div>
      <div class="bar">${t ? `<i style="width:${(s2 / t) * 100}%;background:var(--s2)"></i><i style="width:${(s1 / t) * 100}%;background:var(--s1)"></i><i style="width:${(s0 / t) * 100}%;background:var(--s0)"></i>` : ""}</div>
      <div class="meta"><span>잔여 ${t - s2}/${t}</span><span class="${a ? "hot" : ""}">A ${a}</span><span class="${hi ? "hot" : ""}">Impact 높음 ${hi}</span><span class="${late ? "hot" : ""}">경과 ${late}</span></div>
    </a>`;
  }).join("");
  shell("#/dash", `
    <div class="row between"><h2>전체 현황</h2>
      <div class="ms">${CFG.MILESTONES.map((m) => `<span>${esc(m.label)} <b>${esc(m.date)}</b></span>`).join("")}<span>오늘 ${today()}</span></div></div>
    <section class="kpis">
      ${kpi(P.length, "전체 Punch", "#/list?all")}
      ${kpi(n((p) => p.status === "미착수"), "미착수", "#/list?status=미착수")}
      ${kpi(n((p) => p.status === "진행 중"), "진행 중", "#/list?status=진행 중")}
      ${kpi(n((p) => p.status === "완료"), "완료", "#/list?status=완료")}
      ${kpi(n((p) => p.grade === "A" && p.status !== "완료"), "A등급 미완료", "#/list?grade=A", true)}
      ${kpi(n((p) => p.status !== "완료" && p.impact_level === "높음"), "후행 Impact 높음", "#/impact", true)}
    </section>
    <div class="row between"><h2>시스템별 현황</h2><div class="legend"><span class="l2">완료</span><span class="l1">진행 중</span><span>미착수</span></div></div>
    <section class="systems">${cards || `<div class="empty">시스템이 없습니다. 관리 탭에서 추가하세요.</div>`}</section>
    <p class="small muted">등급 기준: <b>A</b> Early Power(First fire·동기화) 전 반드시 완료 · <b>B</b> 상업운전·인계 전 완료 · <b>C</b> 운전에 지장 없는 경미 사항</p>`);
  $$(".sys").forEach((a) => a.addEventListener("click", () => { Object.assign(F, { sys: a.dataset.sys, status: "open", grade: "", disc: "", impact: "", mine: false, late: false, q: "" }); saveFilter(); }));
}

/* ---------------- list ---------------- */
function applyQuery(q) {
  if (!q) return;
  const p = new URLSearchParams(q);
  Object.assign(F, { sys: "", status: "", grade: "", disc: "", impact: "", mine: false, late: false, q: "" });
  if (p.has("status")) F.status = p.get("status");
  if (p.has("grade")) { F.grade = p.get("grade"); F.status = "open"; }
  saveFilter();
}
function filtered() {
  const q = F.q.trim().toLowerCase(), uid = S.session.user.id;
  return S.punches.filter((p) =>
    (!F.sys || p.system_id === F.sys) &&
    (!F.status || (F.status === "open" ? p.status !== "완료" : p.status === F.status)) &&
    (!F.grade || p.grade === F.grade) &&
    (!F.disc || p.discipline === F.disc) &&
    (!F.impact || p.impact_level === F.impact) &&
    (!F.mine || p.created_by === uid || p.updated_by === uid) &&
    (!F.late || isLate(p)) &&
    (!q || [code(p), p.title, p.description, p.location, p.vendor, p.assignee, p.impact_note].join(" ").toLowerCase().includes(q))
  );
}
function cardHtml(p) {
  const blocked = isBlocked(p);
  return `<a class="card g${esc(p.grade)}" href="#/p/${p.id}">
    <div><div class="code">${esc(code(p))} · ${esc(p.discipline || "공종 미지정")}${p.location ? " · " + esc(p.location) : ""}</div>
      <div class="title">${esc(p.title)}</div></div>
    <div class="side"><span class="st s${STATUS.indexOf(p.status)}">${esc(p.status)}</span>
      <div class="prog" title="${p.progress}%"><i style="width:${p.progress}%"></i></div></div>
    <div class="info">
      <span class="pill g-${esc(p.grade)}">${esc(p.grade)}등급</span>
      ${p.impact_level !== "없음" ? `<span class="pill imp-${esc(p.impact_level)}">Impact ${esc(p.impact_level)}${p.delay_days ? ` · ${p.delay_days}일` : ""}</span>` : ""}
      ${p.downstream?.length ? `<span>후행 영향: ${esc(p.downstream.join(", "))}</span>` : ""}
      ${blocked ? `<span class="blocked">선행 Punch 대기</span>` : ""}
      <span class="${isLate(p) ? "late" : ""}">목표 ${esc(p.target_date || "–")}</span>
      ${p.vendor ? `<span>${esc(p.vendor)}</span>` : ""}
      ${S.photoCount[p.id] ? `<span>사진 ${S.photoCount[p.id]}</span>` : ""}
      <span>수정 ${esc(fmtTime(p.updated_at))} ${esc(who(p.updated_by))}</span>
    </div></a>`;
}
function viewList(query) {
  applyQuery(query);
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`;
  shell("#/list", `
    <section class="filters">
      <input class="q" id="f-q" type="search" placeholder="제목, 내용, 위치, Vendor 검색" value="${esc(F.q)}">
      <select id="f-sys">${opt("", "모든 시스템", F.sys)}${S.systems.map((s) => opt(s.id, `${s.id} ${s.name}`, F.sys)).join("")}</select>
      <select id="f-status">${opt("", "모든 상태", F.status)}${opt("open", "미완료 전체", F.status)}${STATUS.map((s) => opt(s, s, F.status)).join("")}</select>
      <select id="f-grade">${opt("", "모든 등급", F.grade)}${["A", "B", "C"].map((g) => opt(g, g + "등급", F.grade)).join("")}</select>
      <select id="f-disc">${opt("", "모든 공종", F.disc)}${DISC.map((d) => opt(d, d, F.disc)).join("")}</select>
      <select id="f-impact">${opt("", "모든 Impact", F.impact)}${IMPACT.map((d) => opt(d, "Impact " + d, F.impact)).join("")}</select>
    </section>
    <div class="row between">
      <div class="row">
        <label class="row small"><input type="checkbox" id="f-mine" ${F.mine ? "checked" : ""}> 내가 등록·수정한 것</label>
        <label class="row small"><input type="checkbox" id="f-late" ${F.late ? "checked" : ""}> 목표일 경과</label>
      </div>
      <div class="row"><span class="small muted" id="cnt"></span><button class="btn sm" id="reset">필터 해제</button><button class="btn sm" id="xls">Excel 내보내기</button></div>
    </div>
    <section class="list" id="list"></section>`);
  const draw = () => {
    const L = filtered();
    $("#cnt").textContent = `${L.length}건 / 전체 ${S.punches.length}건`;
    $("#list").innerHTML = L.map(cardHtml).join("") || `<div class="empty">${S.punches.length ? "조건에 맞는 Punch가 없습니다." : "아직 등록된 Punch가 없습니다. 오른쪽 아래 ‘+ Punch 등록’으로 첫 항목을 입력하세요."}</div>`;
  };
  for (const [id, k] of [["f-q", "q"], ["f-sys", "sys"], ["f-status", "status"], ["f-grade", "grade"], ["f-disc", "disc"], ["f-impact", "impact"]])
    $("#" + id).addEventListener("input", (e) => { F[k] = e.target.value; saveFilter(); draw(); });
  $("#f-mine").onchange = (e) => { F.mine = e.target.checked; saveFilter(); draw(); };
  $("#f-late").onchange = (e) => { F.late = e.target.checked; saveFilter(); draw(); };
  $("#reset").onclick = () => { Object.assign(F, { q: "", sys: "", status: "", grade: "", disc: "", impact: "", mine: false, late: false }); saveFilter(); viewList(); };
  $("#xls").onclick = exportExcel;
  draw();
}

/* ---------------- punch form (new / edit) ---------------- */
function viewForm(id) {
  const p = id ? byId(id) : { system_id: F.sys || S.systems[0]?.id, grade: "A", status: "미착수", progress: 0, impact_level: "없음", upstream: [], downstream: [], depends_on: [] };
  if (!p) return viewMissing();
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`;
  shell("#/list", `
    <form class="panel" id="pf" style="display:flex;flex-direction:column;gap:16px">
      <div class="row between"><h2>${id ? `Punch 수정 · ${esc(code(p))}` : "Punch 등록"}</h2><a class="btn sm" href="${id ? `#/p/${id}` : "#/list"}">취소</a></div>
      <div class="form">
        <label class="f">시스템<select name="system_id" required>${S.systems.map((s) => opt(s.id, `${s.id} ${s.name}`, p.system_id)).join("")}</select></label>
        <label class="f">원인 공종<select name="discipline"><option value="">선택</option>${DISC.map((d) => opt(d, d, p.discipline)).join("")}</select></label>
        <label class="f full">작업 제목<input name="title" required maxlength="200" value="${esc(p.title)}" placeholder="예: Lube oil flushing 미착수 (PCC 전원 미확보)"></label>
        <label class="f full">상세 내용<textarea name="description" rows="3" placeholder="현재 상태, 남은 작업, 필요한 자재·인력">${esc(p.description)}</textarea></label>
        <label class="f">위치 / KKS<input name="location" value="${esc(p.location)}" placeholder="예: 11MBV, GT Bldg EL+6.0"></label>
        <label class="f">Vendor / 시공사<input name="vendor" value="${esc(p.vendor)}" placeholder="예: Siemens, 협력사명"></label>
        <label class="f">담당자<input name="assignee" value="${esc(p.assignee)}" placeholder="부서/이름"></label>
        <div class="f"><span class="small muted">Punch 등급</span>${seg("grade", [{ v: "A", l: "A · EP 전 필수" }, { v: "B", l: "B · 인계 전" }, { v: "C", l: "C · 경미" }], p.grade)}</div>
        <div class="f full"><span class="small muted">상태</span>${seg("status", STATUS, p.status)}</div>
        <label class="f">진척률 <span class="mono" id="pv">${p.progress}%</span><input type="range" name="progress" min="0" max="100" step="5" value="${p.progress}"></label>
        <label class="f">목표일<input type="date" name="target_date" value="${esc(p.target_date || "")}"></label>
        <label class="f">예상 완료일<input type="date" name="forecast_date" value="${esc(p.forecast_date || "")}"></label>
      </div>
      <h2>선·후행 Impact</h2>
      <div class="form">
        <div class="f full"><span class="small muted">Impact 수준</span>${seg("impact_level", IMPACT, p.impact_level)}</div>
        <div class="f full"><span class="small muted">이 작업이 기다리는 선행 공종</span>${chips("upstream", DISC, p.upstream)}</div>
        <div class="f full"><span class="small muted">이 작업 때문에 영향받는 후행 공종</span>${chips("downstream", DISC, p.downstream)}</div>
        <label class="f">예상 지연 (일)<input type="number" name="delay_days" min="0" value="${p.delay_days ?? ""}"></label>
        <label class="f full">Impact 내용<textarea name="impact_note" rows="2" placeholder="예: Flushing 지연 시 Turning gear 운전 불가, Cold commissioning 착수 지연">${esc(p.impact_note)}</textarea></label>
      </div>
      ${id ? "" : `<h2>현장 사진</h2>${photoPicker("np")}`}
      <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit" id="save">${id ? "저장" : "등록"}</button></div>
    </form>`, false);
  const f = $("#pf");
  bindSeg(f);
  f.addEventListener("input", () => f.setAttribute("data-dirty", ""));
  f.progress.addEventListener("input", () => ($("#pv").textContent = f.progress.value + "%"));
  $('[data-seg="status"]', f).addEventListener("segchange", (e) => { if (e.detail === "완료") { f.progress.value = 100; $("#pv").textContent = "100%"; } });
  const files = id ? [] : bindPicker(f, "np");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      system_id: f.system_id.value, discipline: f.discipline.value, title: f.title.value.trim(), description: f.description.value.trim(),
      location: f.location.value.trim(), vendor: f.vendor.value.trim(), assignee: f.assignee.value.trim(),
      grade: segVal(f, "grade"), status: segVal(f, "status"), progress: Number(f.progress.value),
      target_date: f.target_date.value || null, forecast_date: f.forecast_date.value || null,
      impact_level: segVal(f, "impact_level"), upstream: chipVals(f, "upstream"), downstream: chipVals(f, "downstream"),
      delay_days: f.delay_days.value === "" ? null : Number(f.delay_days.value), impact_note: f.impact_note.value.trim(),
    };
    $("#save").disabled = true;
    try {
      let pid = id;
      if (id) {
        const r = await sb.from("punches").update(body).eq("id", id); if (r.error) throw r.error;
      } else {
        const r = await sb.from("punches").insert(body).select("id").single(); if (r.error) throw r.error;
        pid = r.data.id;
        await sb.from("punch_updates").insert({ punch_id: pid, note: "Punch 등록", status: body.status, progress: body.progress });
        if (files.length) { toast("사진 올리는 중…"); await uploadPhotos(files, pid); }
      }
      f.removeAttribute("data-dirty");
      await loadAll();
      toast(id ? "저장했습니다" : "등록했습니다");
      location.hash = `#/p/${pid}`;
    } catch (err) { fail(err); $("#save").disabled = false; }
  };
}

/* ---------------- punch detail ---------------- */
async function viewDetail(id) {
  const p = byId(id); if (!p) return viewMissing();
  const [ups, phs] = await Promise.all([
    sb.from("punch_updates").select("*").eq("punch_id", p.id).order("created_at", { ascending: false }),
    sb.from("photos").select("*").eq("punch_id", p.id).order("created_at"),
  ]);
  if (ups.error || phs.error) return fail(ups.error || phs.error, "불러오기");
  const urls = await signed(phs.data.map((x) => x.path));
  const img = (x) => urls[x.path] ? `<img src="${esc(urls[x.path])}" data-full="${esc(urls[x.path])}" alt="현장 사진" loading="lazy">` : "";
  const uid = S.session.user.id, admin = S.me.role === "admin";
  const deps = (p.depends_on || []).map(byId).filter(Boolean);
  const waits = waitingOn(p);
  const depRow = (x, removable) => `<div class="dep"><a href="#/p/${x.id}"><span class="mono small">${esc(code(x))}</span> ${esc(x.title)}</a>
      <span class="row"><span class="st s${STATUS.indexOf(x.status)}">${esc(x.status)}</span>${removable ? `<button class="btn sm" data-undep="${x.id}">빼기</button>` : ""}</span></div>`;
  const generalPhotos = phs.data.filter((x) => !x.update_id);

  shell("#/list", `
    <div class="row between">
      <div><div class="mono small muted">${esc(code(p))} · ${esc(sysName(p.system_id))}</div><h2 style="font-size:19px">${esc(p.title)}</h2></div>
      <div class="row"><a class="btn sm" href="#/list">목록</a><a class="btn sm" href="#/edit/${p.id}">수정</a>
      ${admin || p.created_by === uid ? `<button class="btn sm danger" id="del">삭제</button>` : ""}</div>
    </div>
    <div class="detail">
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <section class="panel" style="display:flex;flex-direction:column;gap:12px">
          <div class="row"><span class="pill g-${esc(p.grade)}">${esc(p.grade)}등급</span><span class="st s${STATUS.indexOf(p.status)}">${esc(p.status)} · ${p.progress}%</span>
            ${isBlocked(p) ? `<span class="blocked">선행 Punch 대기 중</span>` : ""}${isLate(p) ? `<span class="late small">목표일 경과</span>` : ""}</div>
          ${p.description ? `<div style="white-space:pre-wrap">${esc(p.description)}</div>` : ""}
          <dl class="kv">
            <dt>원인 공종</dt><dd>${esc(p.discipline || "–")}</dd>
            <dt>위치 / KKS</dt><dd>${esc(p.location || "–")}</dd>
            <dt>Vendor</dt><dd>${esc(p.vendor || "–")}</dd>
            <dt>담당자</dt><dd>${esc(p.assignee || "–")}</dd>
            <dt>목표일</dt><dd class="mono ${isLate(p) ? "late" : ""}">${esc(p.target_date || "–")}</dd>
            <dt>예상 완료</dt><dd class="mono">${esc(p.forecast_date || "–")}</dd>
            <dt>실제 완료</dt><dd class="mono">${esc(p.done_date || "–")}</dd>
            <dt>등록</dt><dd>${esc(who(p.created_by))} · ${esc(fmtTime(p.created_at))}</dd>
            <dt>최종 수정</dt><dd>${esc(who(p.updated_by))} · ${esc(fmtTime(p.updated_at))}</dd>
          </dl>
          ${generalPhotos.length ? `<div class="thumbs">${generalPhotos.map(img).join("")}</div>` : ""}
        </section>

        <form class="panel" id="uf" style="display:flex;flex-direction:column;gap:12px">
          <h2>진행 상황 입력</h2>
          <textarea name="note" rows="3" placeholder="오늘 한 일, 문제점, 필요한 지원" required></textarea>
          ${seg("status", STATUS, p.status)}
          <label class="f">진척률 <span class="mono" id="upv">${p.progress}%</span><input type="range" name="progress" min="0" max="100" step="5" value="${p.progress}"></label>
          ${photoPicker("up")}
          <div class="row" style="justify-content:flex-end"><button class="btn primary" id="usave">기록 저장</button></div>
        </form>

        <section class="panel" style="display:flex;flex-direction:column;gap:12px">
          <h2>진행 기록 <span class="small muted">${ups.data.length}건</span></h2>
          <div class="timeline">${ups.data.map((u) => {
            const ph = phs.data.filter((x) => x.update_id === u.id);
            return `<div class="tl"><div class="h"><b>${esc(who(u.created_by))}</b><span class="mono">${esc(fmtTime(u.created_at))}</span>
                ${u.status ? `<span class="st s${STATUS.indexOf(u.status)}">${esc(u.status)}</span>` : ""}${u.progress != null ? `<span class="mono">${u.progress}%</span>` : ""}</div>
              ${u.note ? `<div class="note">${esc(u.note)}</div>` : ""}
              ${ph.length ? `<div class="thumbs">${ph.map(img).join("")}</div>` : ""}</div>`;
          }).join("") || `<div class="muted small">기록이 없습니다.</div>`}</div>
        </section>
      </div>

      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <section class="panel" style="display:flex;flex-direction:column;gap:10px">
          <h2>선·후행 Impact</h2>
          <div class="row"><span class="pill imp-${esc(p.impact_level)}">Impact ${esc(p.impact_level)}</span>${p.delay_days ? `<span class="small">예상 지연 <b>${p.delay_days}일</b></span>` : ""}</div>
          <dl class="kv">
            <dt>대기 중인 선행 공종</dt><dd>${esc(p.upstream?.join(", ") || "–")}</dd>
            <dt>영향받는 후행 공종</dt><dd>${esc(p.downstream?.join(", ") || "–")}</dd>
          </dl>
          ${p.impact_note ? `<div style="white-space:pre-wrap">${esc(p.impact_note)}</div>` : ""}
        </section>
        <section class="panel" style="display:flex;flex-direction:column;gap:10px">
          <h2>선행 Punch <span class="small muted">이 작업보다 먼저 끝나야 하는 Punch</span></h2>
          <div class="deps">${deps.map((x) => depRow(x, true)).join("") || `<span class="small muted">없음</span>`}</div>
          <div class="row"><select id="adddep" class="grow"><option value="">선행 Punch 추가…</option>
            ${S.punches.filter((x) => x.id !== p.id && !(p.depends_on || []).includes(x.id)).map((x) => `<option value="${x.id}">${esc(code(x))} ${esc(x.title.slice(0, 60))}</option>`).join("")}</select></div>
        </section>
        <section class="panel" style="display:flex;flex-direction:column;gap:10px">
          <h2>후행 Punch <span class="small muted">이 작업을 기다리는 Punch</span></h2>
          <div class="deps">${waits.map((x) => depRow(x, false)).join("") || `<span class="small muted">없음</span>`}</div>
        </section>
      </div>
    </div>`, false);

  const uf = $("#uf"); bindSeg(uf);
  uf.addEventListener("input", () => uf.setAttribute("data-dirty", ""));
  uf.progress.addEventListener("input", () => ($("#upv").textContent = uf.progress.value + "%"));
  $('[data-seg="status"]', uf).addEventListener("segchange", (e) => { uf.setAttribute("data-dirty", ""); if (e.detail === "완료") { uf.progress.value = 100; $("#upv").textContent = "100%"; } });
  const files = bindPicker(uf, "up");
  uf.onsubmit = async (e) => {
    e.preventDefault();
    const status = segVal(uf, "status"), progress = Number(uf.progress.value);
    $("#usave").disabled = true;
    try {
      const r = await sb.from("punch_updates").insert({ punch_id: p.id, note: uf.note.value.trim(), status, progress }).select("id").single();
      if (r.error) throw r.error;
      if (status !== p.status || progress !== p.progress) {
        const u = await sb.from("punches").update({ status, progress }).eq("id", p.id); if (u.error) throw u.error;
      } else {
        await sb.from("punches").update({ updated_at: new Date().toISOString() }).eq("id", p.id);
      }
      if (files.length) { toast("사진 올리는 중…"); await uploadPhotos(files, p.id, r.data.id); }
      uf.removeAttribute("data-dirty");
      await loadAll(); toast("기록했습니다"); viewDetail(p.id);
    } catch (err) { fail(err); $("#usave").disabled = false; }
  };
  const setDeps = async (list) => {
    const r = await sb.from("punches").update({ depends_on: list }).eq("id", p.id);
    if (r.error) return fail(r.error);
    await loadAll(); viewDetail(p.id);
  };
  $("#adddep").onchange = (e) => e.target.value && setDeps([...(p.depends_on || []), Number(e.target.value)]);
  $$("[data-undep]").forEach((b) => (b.onclick = () => setDeps((p.depends_on || []).filter((d) => d !== Number(b.dataset.undep)))));
  const del = $("#del");
  if (del) {
    let armed = false;
    del.onclick = async () => {
      if (!armed) { armed = true; del.textContent = "한 번 더 누르면 삭제"; setTimeout(() => { armed = false; del.textContent = "삭제"; }, 3000); return; }
      const paths = phs.data.map((x) => x.path);
      const r = await sb.from("punches").delete().eq("id", p.id);
      if (r.error) return fail(r.error, "삭제");
      if (paths.length) await sb.storage.from(BUCKET).remove(paths);
      await loadAll(); toast("삭제했습니다"); location.hash = "#/list";
    };
  }
}

/* ---------------- impact ---------------- */
function viewImpact() {
  const open = S.punches.filter((p) => p.status !== "완료");
  const rows = DISC.map((src) => {
    const L = open.filter((p) => p.discipline === src);
    return { src, cells: DISC.map((dst) => L.filter((p) => p.downstream?.includes(dst)).length) };
  });
  const hiList = open.filter((p) => p.impact_level === "높음" || p.impact_level === "보통")
    .sort((a, b) => IMPACT.indexOf(b.impact_level) - IMPACT.indexOf(a.impact_level) || (b.delay_days || 0) - (a.delay_days || 0));
  const blocked = open.filter(isBlocked);
  const chains = open.map((p) => ({ p, n: waitingOn(p).filter((x) => x.status !== "완료").length })).filter((x) => x.n).sort((a, b) => b.n - a.n);
  shell("#/impact", `
    <section class="panel" style="display:flex;flex-direction:column;gap:10px">
      <h2>공종 간 Impact <span class="small muted">미완료 Punch 기준 · 행 = 원인 공종, 열 = 영향받는 후행 공종</span></h2>
      <div class="matrix"><table><thead><tr><th class="rh">원인 \\ 후행</th>${DISC.map((d) => `<th>${esc(d)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr><th class="rh">${esc(r.src)}</th>${r.cells.map((v) => `<td class="mono ${v >= 3 ? "v2" : v ? "v1" : ""}">${v || ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    </section>
    <section style="display:flex;flex-direction:column;gap:8px">
      <h2>다른 작업을 막고 있는 Punch <span class="small muted">후행 Punch가 기다리는 순</span></h2>
      <div class="list">${chains.map(({ p, n }) => cardHtml(p).replace('<div class="info">', `<div class="info"><span class="hot">후행 ${n}건 대기</span>`)).join("") || `<div class="empty">없음</div>`}</div>
    </section>
    <section style="display:flex;flex-direction:column;gap:8px">
      <h2>Impact 높음·보통 <span class="small muted">${hiList.length}건</span></h2>
      <div class="list">${hiList.map(cardHtml).join("") || `<div class="empty">없음</div>`}</div>
    </section>
    <section style="display:flex;flex-direction:column;gap:8px">
      <h2>선행 Punch 대기 중 <span class="small muted">${blocked.length}건</span></h2>
      <div class="list">${blocked.map(cardHtml).join("") || `<div class="empty">없음</div>`}</div>
    </section>`);
}

/* ---------------- admin ---------------- */
function viewAdmin() {
  if (S.me.role !== "admin") return viewMissing();
  const users = Object.values(S.profiles).sort((a, b) => (a.approved - b.approved) || a.created_at.localeCompare(b.created_at));
  shell("#/admin", `
    <section class="panel" style="display:flex;flex-direction:column;gap:10px">
      <h2>사용자 승인 <span class="small muted">승인된 사람만 Punch를 보고 입력할 수 있습니다</span></h2>
      <div class="tablebox"><table class="users"><thead><tr><th>이름</th><th>소속</th><th>이메일</th><th>가입</th><th>상태</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.company)}</td><td class="small">${esc(u.email)}</td><td class="mono small">${esc(u.created_at.slice(0, 10))}</td>
        <td>${u.approved ? (u.role === "admin" ? "관리자" : "승인") : `<span class="hot">승인 대기</span>`}</td>
        <td class="row">${u.id === S.me.id ? "" : u.approved
          ? `<button class="btn sm" data-u="${u.id}" data-act="${u.role === "admin" ? "member" : "admin"}">${u.role === "admin" ? "관리자 해제" : "관리자 지정"}</button><button class="btn sm danger" data-u="${u.id}" data-act="revoke">승인 취소</button>`
          : `<button class="btn sm primary" data-u="${u.id}" data-act="approve">승인</button>`}</td></tr>`).join("")}
      </tbody></table></div>
    </section>
    <section class="panel" style="display:flex;flex-direction:column;gap:10px">
      <h2>시스템 관리</h2>
      <div class="tablebox"><table class="users"><thead><tr><th>ID</th><th>이름</th><th>순서</th><th></th></tr></thead><tbody>
      ${S.systems.map((s) => `<tr><td class="mono">${esc(s.id)}</td><td><input data-sn="${esc(s.id)}" value="${esc(s.name)}"></td><td><input data-ss="${esc(s.id)}" type="number" value="${s.sort}" style="width:80px"></td><td><button class="btn sm" data-ssave="${esc(s.id)}">저장</button></td></tr>`).join("")}
      </tbody></table></div>
      <form class="row" id="nsf"><input name="id" placeholder="EP-15" required style="max-width:120px"><input name="name" class="grow" placeholder="시스템 이름" required><button class="btn primary">시스템 추가</button></form>
    </section>`);
  $$("[data-act]").forEach((b) => (b.onclick = async () => {
    const act = b.dataset.act;
    const patch = act === "approve" ? { approved: true } : act === "revoke" ? { approved: false, role: "member" } : { role: act };
    const r = await sb.from("profiles").update(patch).eq("id", b.dataset.u);
    if (r.error) return fail(r.error);
    await loadAll(); toast("변경했습니다"); viewAdmin();
  }));
  $$("[data-ssave]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.ssave;
    const r = await sb.from("systems").update({ name: $(`[data-sn="${id}"]`).value.trim(), sort: Number($(`[data-ss="${id}"]`).value) }).eq("id", id);
    if (r.error) return fail(r.error);
    await loadAll(); toast("저장했습니다"); viewAdmin();
  }));
  $("#nsf").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const r = await sb.from("systems").insert({ id: f.id.value.trim(), name: f.name.value.trim(), sort: S.systems.length + 1 });
    if (r.error) return fail(r.error);
    await loadAll(); toast("추가했습니다"); viewAdmin();
  };
}

/* ---------------- excel ---------------- */
async function exportExcel() {
  if (!window.XLSX) return toast("Excel 모듈을 불러오지 못했습니다. 새로 고침 후 다시 시도하세요.");
  const ups = await sb.from("punch_updates").select("*").order("created_at");
  if (ups.error) return fail(ups.error, "내보내기");
  const L = filtered(), ids = new Set(L.map((p) => p.id));
  const rows = L.map((p) => ({
    "Punch No": code(p), "시스템": p.system_id, "시스템명": sysName(p.system_id), "원인 공종": p.discipline, "제목": p.title, "상세 내용": p.description,
    "위치/KKS": p.location, "등급": p.grade, "상태": p.status, "진척률(%)": p.progress, "Vendor": p.vendor, "담당자": p.assignee,
    "목표일": p.target_date || "", "예상 완료일": p.forecast_date || "", "실제 완료일": p.done_date || "", "목표일 경과": isLate(p) ? "Y" : "",
    "Impact": p.impact_level, "선행 공종": (p.upstream || []).join(", "), "후행 공종": (p.downstream || []).join(", "), "예상 지연(일)": p.delay_days ?? "",
    "Impact 내용": p.impact_note, "선행 Punch": (p.depends_on || []).map(byId).filter(Boolean).map(code).join(", "),
    "사진 수": S.photoCount[p.id] || 0, "등록자": who(p.created_by), "등록일": fmtTime(p.created_at), "최종 수정자": who(p.updated_by), "최종 수정": fmtTime(p.updated_at),
  }));
  const logs = ups.data.filter((u) => ids.has(u.punch_id)).map((u) => {
    const p = byId(u.punch_id);
    return { "Punch No": code(p), "제목": p.title, "일시": fmtTime(u.created_at), "작성자": who(u.created_by), "상태": u.status || "", "진척률(%)": u.progress ?? "", "내용": u.note };
  });
  const sum = S.systems.map((s) => {
    const A = S.punches.filter((p) => p.system_id === s.id), done = A.filter((p) => p.status === "완료").length;
    return { "시스템": s.id, "시스템명": s.name, "전체": A.length, "미착수": A.filter((p) => p.status === "미착수").length, "진행 중": A.filter((p) => p.status === "진행 중").length,
      "완료": done, "완료율(%)": A.length ? Math.round((done / A.length) * 100) : 0, "A등급 미완료": A.filter((p) => p.grade === "A" && p.status !== "완료").length,
      "Impact 높음 미완료": A.filter((p) => p.impact_level === "높음" && p.status !== "완료").length, "목표일 경과": A.filter(isLate).length };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sum), "시스템별 요약");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Punch List");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logs), "진행 기록");
  XLSX.writeFile(wb, `EP_Punch_List_${today()}.xlsx`);
}

/* ---------------- auth screens ---------------- */
function viewSetup() {
  app.innerHTML = `<div class="auth"><h1>설정이 필요합니다</h1><p>config.js에 Supabase Project URL과 anon public key를 넣어 주세요.</p></div>`;
}
function viewAuth(mode = "login", msg = "") {
  app.innerHTML = `<form class="auth" id="af">
    <div class="eyebrow">${esc(CFG.PROJECT_TITLE)}</div>
    <h1>${mode === "login" ? "로그인" : mode === "signup" ? "가입 신청" : "비밀번호 재설정"}</h1>
    ${mode === "signup" ? `<label class="f">이름<input name="name" required autocomplete="name"></label><label class="f">소속 (회사/팀)<input name="company" required placeholder="예: 기계팀, ○○건설"></label>` : ""}
    <label class="f">이메일<input name="email" type="email" required autocomplete="email"></label>
    ${mode !== "reset" ? `<label class="f">비밀번호${mode === "signup" ? " (8자 이상)" : ""}<input name="pw" type="password" required minlength="${mode === "signup" ? 8 : 1}" autocomplete="${mode === "signup" ? "new-password" : "current-password"}"></label>` : ""}
    <div class="err" id="aerr">${esc(msg)}</div>
    <button class="btn primary" id="ago">${mode === "login" ? "로그인" : mode === "signup" ? "가입 신청" : "재설정 메일 보내기"}</button>
    <div class="row between small">
      ${mode === "login" ? `<a href="#" data-m="signup">처음이신가요? 가입 신청</a><a href="#" data-m="reset">비밀번호를 잊었어요</a>` : `<a href="#" data-m="login">로그인으로 돌아가기</a>`}
    </div>
    ${mode === "signup" ? `<p class="small muted">가입 후 관리자가 승인하면 사용할 수 있습니다.</p>` : ""}
  </form>`;
  $$("[data-m]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); viewAuth(a.dataset.m); }));
  $("#af").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, email = f.email.value.trim();
    $("#ago").disabled = true; $("#aerr").textContent = "";
    let r;
    if (mode === "login") r = await sb.auth.signInWithPassword({ email, password: f.pw.value });
    else if (mode === "signup") r = await sb.auth.signUp({ email, password: f.pw.value, options: { data: { name: f.name.value.trim(), company: f.company.value.trim() } } });
    else r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $("#ago").disabled = false;
    if (r.error) { $("#aerr").textContent = authMsg(r.error); return; }
    if (mode === "signup" && !r.data.session) viewAuth("login", "가입 신청이 접수되었습니다. 메일함의 확인 링크를 누른 뒤 로그인하세요.");
    if (mode === "reset") viewAuth("login", "재설정 메일을 보냈습니다. 메일의 링크를 열어 새 비밀번호를 정하세요.");
  };
}
function authMsg(e) {
  const m = e.message || "";
  if (/Invalid login/i.test(m)) return "이메일 또는 비밀번호가 맞지 않습니다.";
  if (/Email not confirmed/i.test(m)) return "메일함의 확인 링크를 먼저 눌러 주세요.";
  if (/already registered/i.test(m)) return "이미 가입된 이메일입니다. 로그인하세요.";
  if (/rate limit/i.test(m)) return "요청이 많아 잠시 막혔습니다. 몇 분 뒤 다시 시도하세요.";
  return m;
}
function viewNewPassword() {
  app.innerHTML = `<form class="auth" id="npf"><h1>새 비밀번호</h1>
    <label class="f">새 비밀번호 (8자 이상)<input name="pw" type="password" minlength="8" required autocomplete="new-password"></label>
    <div class="err" id="nerr"></div><button class="btn primary">저장</button></form>`;
  $("#npf").onsubmit = async (e) => {
    e.preventDefault();
    const r = await sb.auth.updateUser({ password: e.target.pw.value });
    if (r.error) { $("#nerr").textContent = r.error.message; return; }
    toast("비밀번호를 바꿨습니다"); recovering = false; start();
  };
}
function viewPending() {
  app.innerHTML = `<div class="auth"><div class="eyebrow">${esc(CFG.PROJECT_TITLE)}</div><h1>승인 대기 중</h1>
    <p>${esc(S.me?.name || "")}님의 가입 신청이 접수되었습니다. 관리자가 승인하면 바로 사용할 수 있습니다.</p>
    <div class="row"><button class="btn" id="rc">다시 확인</button><button class="btn" id="lo">로그아웃</button></div></div>`;
  $("#rc").onclick = start;
  $("#lo").onclick = () => sb.auth.signOut();
}
function viewMissing() { shell("", `<div class="empty">찾는 항목이 없습니다. <a href="#/list">목록으로</a></div>`); }

/* ---------------- router ---------------- */
function route() {
  if (!S.loaded) return;
  const h = location.hash || "#/dash";
  const [path, query] = h.split("?");
  const m = path.match(/^#\/(\w+)(?:\/(\d+))?/) || [];
  const [, view, id] = m;
  window.scrollTo(0, 0);
  if (view === "list") return viewList(query);
  if (view === "p") return viewDetail(id);
  if (view === "new") return viewForm(null);
  if (view === "edit") return viewForm(id);
  if (view === "impact") return viewImpact();
  if (view === "admin") return viewAdmin();
  return viewDash();
}
window.addEventListener("hashchange", route);

let recovering = false, started = false;
async function start() {
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  if (recovering) return viewNewPassword();
  if (!S.session) { S.loaded = false; return viewAuth("login"); }
  const pr = await sb.from("profiles").select("*").eq("id", S.session.user.id).single();
  if (pr.error) { app.innerHTML = `<div class="auth"><h1>프로필을 불러오지 못했습니다</h1><p>${esc(pr.error.message)}</p><button class="btn" onclick="location.reload()">새로 고침</button></div>`; return; }
  S.me = pr.data;
  if (!S.me.approved) return viewPending();
  try { await loadAll(); } catch (e) { return fail(e, "불러오기"); }
  if (!started) { subscribe(); started = true; }
  route();
}

if (!sb) viewSetup();
else {
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === "PASSWORD_RECOVERY") { recovering = true; viewNewPassword(); }
    else if (ev === "SIGNED_OUT" || (ev === "SIGNED_IN" && S.session?.user?.id !== session?.user?.id)) start();
  });
  start();
}
