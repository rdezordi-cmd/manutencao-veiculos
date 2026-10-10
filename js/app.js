import { sb, run, isConfigured } from './db.js';
import * as fipe from './fipe.js';
import {
  esc, brl, kmf, plural, today, fmtDate, planStatus, CATEGORIES, VEHICLE_TYPES, typeIcon, defaultPlansFor,
} from './util.js';

const state = {
  started: false, user: null, households: [], hid: null,
  vehicles: [], plans: [], services: [], members: [],
};
const reportFilter = { vehicle: '', year: '' };

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const tabbar = document.getElementById('tabbar');
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
const toastEl = document.getElementById('toast');

// =====================================================================
// Helpers de UI
// =====================================================================

function setTitle(t) {
  titleEl.textContent = t;
  document.title = t === 'Manutenções' ? t : `${t} · Manutenções`;
}

let toastTimer;
function toast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ''), 3500);
}

function fail(e) {
  console.error(e);
  toast(e?.message || String(e), 'error');
}

function openModal(html) {
  modalBody.innerHTML = html;
  modalBody.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
  if (!modal.open) modal.showModal();
  return modalBody;
}
function closeModal() {
  if (modal.open) modal.close();
  modalBody.innerHTML = '';
}

// Envia um formulário desabilitando o botão enquanto salva
function onSubmit(form, handler) {
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btns = form.querySelectorAll('button');
    btns.forEach((b) => (b.disabled = true));
    try {
      await handler(e);
    } catch (err) {
      fail(err);
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  };
}

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
const shortModel = (m) => m.split(' ').slice(0, 2).join(' ');
const vName = (v) => v.nickname || `${v.brand} ${shortModel(v.model)}`;
const vehicleById = (id) => state.vehicles.find((v) => v.id === id);
const household = () => state.households.find((h) => h.id === state.hid);
const isOwner = () => state.members.some((m) => m.user_id === state.user.id && m.role === 'owner');
const sum = (list) => list.reduce((t, s) => t + Number(s.cost || 0), 0);
const appUrl = () => location.origin + location.pathname;

const STATUS_LABEL = { overdue: 'Vencido', soon: 'Em breve', ok: 'Em dia' };
const pill = (status, text) => `<span class="pill ${status}">${text ?? STATUS_LABEL[status]}</span>`;

const intervalText = (p) =>
  [p.interval_km && `a cada ${kmf(p.interval_km)}`, p.interval_months && `${p.interval_months} meses`]
    .filter(Boolean).join(' ou ');

function dueText(a) {
  const next = [];
  const rem = [];
  if (a.nextKm != null) {
    next.push(kmf(a.nextKm));
    rem.push(a.remKm < 0 ? `${kmf(-a.remKm)} atrasado` : a.remKm === 0 ? 'no limite de km' : `faltam ${kmf(a.remKm)}`);
  }
  if (a.nextDate) {
    next.push(fmtDate(a.nextDate));
    rem.push(a.remDays < 0 ? `${plural(-a.remDays, 'dia')} atrasado` : a.remDays === 0 ? 'vence hoje' : `faltam ${plural(a.remDays, 'dia')}`);
  }
  return `Próxima: ${next.join(' ou ')} · ${rem.join(' / ')}`;
}

// =====================================================================
// Dados
// =====================================================================

async function loadHouseholds() {
  state.households = await run(sb.from('households').select('*').order('created_at'));
  const saved = localStorage.getItem('hid');
  state.hid = state.households.find((h) => h.id === saved)?.id ?? state.households[0]?.id ?? null;
}

async function loadData() {
  const hid = state.hid;
  const [vehicles, members] = await Promise.all([
    run(sb.from('vehicles').select('*').eq('household_id', hid).order('created_at')),
    run(sb.from('household_members').select('*').eq('household_id', hid).order('joined_at')),
  ]);
  const ids = vehicles.map((v) => v.id);
  let plans = [];
  let services = [];
  if (ids.length) {
    [plans, services] = await Promise.all([
      run(sb.from('maintenance_plans').select('*').in('vehicle_id', ids).order('name')),
      run(sb.from('services').select('*, service_plans(plan_id)').in('vehicle_id', ids)
        .order('service_date', { ascending: false }).order('created_at', { ascending: false })),
    ]);
  }
  services.forEach((s) => (s.plan_ids = (s.service_plans || []).map((x) => x.plan_id)));
  Object.assign(state, { vehicles, members, plans, services });
}

async function refresh() {
  try {
    await loadData();
    route(false);
  } catch (e) {
    fail(e);
  }
}

function planItems(v, { includeInactive = false } = {}) {
  const sv = state.services.filter((s) => s.vehicle_id === v.id);
  return state.plans
    .filter((p) => p.vehicle_id === v.id && (includeInactive || p.active))
    .map((p) => ({ plan: p, vehicle: v, ...planStatus(p, v, sv) }));
}

const RANK = { overdue: 0, soon: 1, ok: 2 };
function urgency(a) {
  const byKm = a.remKm != null ? a.remKm / a.plan.interval_km : Infinity;
  const byDays = a.remDays != null ? a.remDays / (a.plan.interval_months * 30) : Infinity;
  return Math.min(byKm, byDays);
}
const byUrgency = (a, b) => RANK[a.status] - RANK[b.status] || urgency(a) - urgency(b);

const allAlerts = () => state.vehicles.flatMap((v) => planItems(v)).filter((a) => a.status !== 'ok').sort(byUrgency);

async function createDefaultPlans(vehicle) {
  const rows = defaultPlansFor(vehicle.vehicle_type).map((p) => ({
    ...p, vehicle_id: vehicle.id, start_km: vehicle.current_km, start_date: today(),
  }));
  await run(sb.from('maintenance_plans').insert(rows));
}

// =====================================================================
// Inicialização e rotas
// =====================================================================

async function start() {
  try {
    if (!state.user) {
      Object.assign(state, { households: [], hid: null, vehicles: [], plans: [], services: [], members: [] });
      return renderLogin();
    }
    view.innerHTML = '<p class="muted center">Carregando…</p>';
    await loadHouseholds();
    if (!state.hid) return renderOnboarding();
    await loadData();
    route();
  } catch (e) {
    fail(e);
    view.innerHTML = `<div class="card"><p>Erro ao carregar: ${esc(e.message)}</p>
      <button class="btn" onclick="location.reload()">Tentar novamente</button></div>`;
  }
}

function route(scrollTop = true) {
  if (!state.user || !state.hid) return;
  const [r = '', id] = location.hash.replace(/^#\/?/, '').split('/');
  const tab = r === 'veiculo' ? 'veiculos' : r || 'painel';
  tabbar.hidden = false;
  tabbar.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (scrollTop) window.scrollTo(0, 0);
  switch (r) {
    case 'veiculos': return viewVehicles();
    case 'veiculo': return viewVehicle(id);
    case 'relatorios': return viewReports();
    case 'garagem': return viewHousehold();
    default: return viewDashboard();
  }
}

// Ações acionadas por elementos com data-act (delegação de eventos)
const ACTIONS = {
  'service-new': (d) => serviceForm({ vehicle_id: d.vehicle, plan_ids: d.plan ? [d.plan] : [] }),
  'service-edit': (d) => serviceForm(state.services.find((s) => s.id === d.id)),
  'plan-new': (d) => planForm({ vehicle_id: d.vehicle }),
  'plan-edit': (d) => planForm(state.plans.find((p) => p.id === d.id)),
  'plan-defaults': async (d) => {
    await createDefaultPlans(vehicleById(d.vehicle));
    toast('Plano padrão criado');
    await refresh();
  },
  'vehicle-new': () => vehicleForm(),
  'vehicle-edit': (d) => vehicleForm(vehicleById(d.id)),
  km: (d) => kmForm(vehicleById(d.id)),
  'export-csv': () => exportCsv(),
  'hh-rename': async () => {
    const name = prompt('Novo nome da garagem:', household().name);
    if (!name?.trim()) return;
    await run(sb.from('households').update({ name: name.trim() }).eq('id', state.hid));
    household().name = name.trim();
    route(false);
  },
  'hh-share': async () => {
    const h = household();
    const text = `Entre na garagem "${h.name}" no app de manutenções com o código ${h.invite_code}: ${appUrl()}`;
    if (navigator.share) {
      await navigator.share({ title: 'Convite', text }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(text);
      toast('Convite copiado!');
    }
  },
  'hh-newcode': async () => {
    if (!confirm('Gerar um novo código? O código atual deixará de funcionar.')) return;
    household().invite_code = await run(sb.rpc('regenerate_invite', { p_household: state.hid }));
    route(false);
  },
  'hh-remove': async (d) => {
    if (!confirm('Remover este membro da garagem?')) return;
    await run(sb.from('household_members').delete().eq('household_id', state.hid).eq('user_id', d.id));
    await refresh();
  },
  'hh-leave': async () => {
    if (!confirm(`Sair da garagem "${household().name}"?`)) return;
    await run(sb.from('household_members').delete().eq('household_id', state.hid).eq('user_id', state.user.id));
    localStorage.removeItem('hid');
    await start();
  },
  'hh-join': () => householdForm('join'),
  'hh-create': () => householdForm('create'),
  logout: () => sb.auth.signOut(),
};

async function handleAction(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !ACTIONS[el.dataset.act]) return;
  e.preventDefault();
  try {
    await ACTIONS[el.dataset.act](el.dataset);
  } catch (err) {
    fail(err);
  }
}

function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  if (!isConfigured) {
    tabbar.hidden = true;
    view.innerHTML = `<div class="card"><h2>Configuração pendente</h2>
      <p>Edite <code>js/config.js</code> com a URL e a chave <i>anon</i> do seu projeto Supabase.
      Veja o passo a passo no README.</p></div>`;
    return;
  }

  view.addEventListener('click', handleAction);
  modalBody.addEventListener('click', handleAction);
  document.getElementById('btn-refresh').onclick = () => state.hid && refresh().then(() => toast('Atualizado'));
  window.addEventListener('hashchange', () => route());

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') setTimeout(newPasswordForm, 0);
    const uid = session?.user?.id ?? null;
    if (state.started && uid === (state.user?.id ?? null)) return; // ex.: renovação de token
    state.started = true;
    state.user = session?.user ?? null;
    setTimeout(start, 0); // não chamar o Supabase dentro do callback
  });
}

// =====================================================================
// Login e boas-vindas
// =====================================================================

function renderLogin() {
  tabbar.hidden = true;
  setTitle('Manutenções');
  view.innerHTML = `
    <div class="card auth">
      <div class="logo">🚗🔧</div>
      <h2>Controle de manutenções</h2>
      <p class="muted">Revisões, serviços e custos dos veículos da família.</p>
      <form id="lf">
        <label>E-mail<input type="email" name="email" required autocomplete="email"></label>
        <label>Senha<input type="password" name="password" required minlength="6" autocomplete="current-password"></label>
        <button class="btn primary block" value="in">Entrar</button>
        <button class="btn block" value="up">Criar conta</button>
      </form>
      <button class="link" id="forgot">Esqueci minha senha</button>
      <p class="muted" id="auth-msg"></p>
    </div>`;
  const form = view.querySelector('#lf');
  const msg = view.querySelector('#auth-msg');
  onSubmit(form, async (e) => {
    const email = form.email.value.trim();
    const password = form.password.value;
    if (e.submitter?.value === 'up') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
      if (error) throw error;
      if (!data.session) msg.textContent = 'Conta criada! Confirme pelo link enviado ao seu e-mail e depois entre.';
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message === 'Invalid login credentials' ? 'E-mail ou senha inválidos' : error.message);
    }
  });
  view.querySelector('#forgot').onclick = async () => {
    const email = form.email.value.trim();
    if (!email) return toast('Digite seu e-mail primeiro', 'error');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
    if (error) return fail(error);
    msg.textContent = 'Enviamos um link para redefinir a senha.';
  };
}

function newPasswordForm() {
  const m = openModal(`
    <form id="npf"><h2>Nova senha</h2>
      <label>Nova senha<input type="password" name="password" required minlength="6" autocomplete="new-password"></label>
      <div class="actions"><span class="grow"></span><button class="btn primary">Salvar</button></div>
    </form>`);
  const form = m.querySelector('#npf');
  onSubmit(form, async () => {
    const { error } = await sb.auth.updateUser({ password: form.password.value });
    if (error) throw error;
    closeModal();
    toast('Senha alterada');
  });
}

function renderOnboarding() {
  tabbar.hidden = true;
  setTitle('Bem-vindo');
  view.innerHTML = `
    <div class="card">
      <h2>Criar uma garagem</h2>
      <p class="muted">A garagem reúne os veículos da família. Depois é só convidar os outros pelo código.</p>
      <form id="cf">
        <label>Nome<input name="name" required value="Garagem da família"></label>
        <button class="btn primary block">Criar garagem</button>
      </form>
    </div>
    <div class="card">
      <h2>Recebeu um código?</h2>
      <form id="jf">
        <label>Código de convite<input name="code" required maxlength="12" class="upper" autocomplete="off"></label>
        <button class="btn block">Entrar na garagem</button>
      </form>
    </div>
    <p class="center"><button class="link" data-act="logout">Sair (${esc(state.user.email)})</button></p>`;
  const cf = view.querySelector('#cf');
  const jf = view.querySelector('#jf');
  onSubmit(cf, () => enterHousehold(sb.rpc('create_household', { p_name: cf.name.value })));
  onSubmit(jf, () => enterHousehold(sb.rpc('join_household', { p_code: jf.code.value })));
}

async function enterHousehold(rpc) {
  const h = await run(rpc);
  localStorage.setItem('hid', h.id);
  closeModal();
  location.hash = '#/';
  await start();
  toast(`Garagem "${h.name}"`);
}

function householdForm(mode) {
  const m = openModal(`
    <form id="hf"><h2>${mode === 'join' ? 'Entrar em uma garagem' : 'Criar nova garagem'}</h2>
      ${mode === 'join'
        ? '<label>Código de convite<input name="value" required maxlength="12" class="upper" autocomplete="off"></label>'
        : '<label>Nome<input name="value" required></label>'}
      <div class="actions"><span class="grow"></span><button type="button" class="btn" data-close>Cancelar</button>
      <button class="btn primary">${mode === 'join' ? 'Entrar' : 'Criar'}</button></div>
    </form>`);
  const form = m.querySelector('#hf');
  onSubmit(form, () => enterHousehold(mode === 'join'
    ? sb.rpc('join_household', { p_code: form.value.value })
    : sb.rpc('create_household', { p_name: form.value.value })));
}

// =====================================================================
// Telas
// =====================================================================

const alertItem = (a) => `
  <li class="item">
    <div class="grow">
      <div class="row"><b>${esc(a.plan.name)}</b>${pill(a.status)}</div>
      <small>${esc(vName(a.vehicle))} · ${dueText(a)}</small>
    </div>
    <button class="btn small" data-act="service-new" data-vehicle="${a.vehicle.id}" data-plan="${a.plan.id}">Registrar</button>
  </li>`;

function vehicleItem(v) {
  const alerts = planItems(v).filter((a) => a.status !== 'ok');
  const worst = alerts.some((a) => a.status === 'overdue') ? 'overdue' : alerts.length ? 'soon' : 'ok';
  return `
    <li><a class="item" href="#/veiculo/${v.id}">
      <div class="avatar">${typeIcon(v.vehicle_type)}</div>
      <div class="grow">
        <b>${esc(vName(v))}</b>
        <small>${esc(v.brand)}${v.model_year ? ' · ' + esc(v.model_year) : ''}${v.plate ? ' · ' + esc(v.plate) : ''}</small>
        <small>${kmf(v.current_km)}</small>
      </div>
      ${pill(worst, alerts.length ? plural(alerts.length, 'alerta') : 'Em dia')}
    </a></li>`;
}

function servicesList(list, showVehicle) {
  if (!list.length) return '<p class="muted card">Nenhum serviço registrado.</p>';
  return `<ul class="list">${list.map((s) => {
    const v = vehicleById(s.vehicle_id);
    const meta = [fmtDate(s.service_date), s.km != null && kmf(s.km), s.category, showVehicle && v && vName(v), s.shop]
      .filter(Boolean).map(esc).join(' · ');
    return `<li class="item tap" data-act="service-edit" data-id="${s.id}">
      <div class="grow"><b>${esc(s.description)}</b><small>${meta}</small></div>
      <b class="money">${brl(s.cost)}</b></li>`;
  }).join('')}</ul>`;
}

function viewDashboard() {
  setTitle(household()?.name || 'Painel');
  if (!state.vehicles.length) {
    view.innerHTML = `
      <div class="card empty">
        <div class="logo">🚗</div>
        <h2>Nenhum veículo ainda</h2>
        <p class="muted">Cadastre o primeiro veículo escolhendo marca e modelo pela Tabela FIPE.</p>
        <button class="btn primary" data-act="vehicle-new">+ Adicionar veículo</button>
      </div>`;
    return;
  }
  const alerts = allAlerts();
  const year = today().slice(0, 4);
  const yearTotal = sum(state.services.filter((s) => s.service_date.startsWith(year)));
  const alertClass = alerts.some((a) => a.status === 'overdue') ? 'bad' : alerts.length ? 'warn' : 'good';
  view.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${state.vehicles.length}</b><span>${state.vehicles.length === 1 ? 'veículo' : 'veículos'}</span></div>
      <div class="stat ${alertClass}"><b>${alerts.length}</b><span>${alerts.length === 1 ? 'alerta' : 'alertas'}</span></div>
      <div class="stat"><b>${brl(yearTotal)}</b><span>gasto em ${year}</span></div>
    </div>
    <h2>Alertas de manutenção</h2>
    ${alerts.length ? `<ul class="list">${alerts.map(alertItem).join('')}</ul>` : '<p class="card muted">Tudo em dia! 🎉</p>'}
    <h2>Veículos</h2>
    <ul class="list">${state.vehicles.map(vehicleItem).join('')}</ul>
    <h2>Últimos serviços</h2>
    ${servicesList(state.services.slice(0, 5), true)}
    <button class="fab" data-act="service-new">+ Serviço</button>`;
}

function viewVehicles() {
  setTitle('Veículos');
  view.innerHTML = `
    ${state.vehicles.length
      ? `<ul class="list">${state.vehicles.map(vehicleItem).join('')}</ul>`
      : '<p class="card muted">Nenhum veículo cadastrado.</p>'}
    <button class="btn primary block" data-act="vehicle-new">+ Adicionar veículo</button>`;
}

function viewVehicle(id) {
  const v = vehicleById(id);
  if (!v) {
    location.hash = '#/veiculos';
    return;
  }
  setTitle(vName(v));
  const sv = state.services.filter((s) => s.vehicle_id === id);
  const items = planItems(v, { includeInactive: true })
    .sort((a, b) => (a.plan.active === b.plan.active ? 0 : a.plan.active ? -1 : 1) || byUrgency(a, b));

  view.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="avatar big">${typeIcon(v.vehicle_type)}</div>
        <div class="grow">
          <h2 class="flush">${esc(vName(v))}</h2>
          <small>${esc(v.brand)} ${esc(v.model)}</small>
          <small>${[v.model_year, v.plate && 'Placa ' + v.plate, v.color].filter(Boolean).map(esc).join(' · ')}</small>
        </div>
      </div>
      <div class="kv">
        <div><span>Km atual</span><b>${kmf(v.current_km)}</b><small>em ${fmtDate(v.km_updated_at)}</small></div>
        <div><span>Gasto total</span><b>${brl(sum(sv))}</b><small>${plural(sv.length, 'serviço')}</small></div>
        ${v.fipe_value ? `<div><span>Valor FIPE</span><b>${esc(v.fipe_value)}</b><small>${esc(v.fipe_ref || '')}</small></div>` : ''}
      </div>
      <div class="actions wrap">
        <button class="btn" data-act="km" data-id="${v.id}">Atualizar km</button>
        <button class="btn" data-act="vehicle-edit" data-id="${v.id}">Editar</button>
        <button class="btn primary" data-act="service-new" data-vehicle="${v.id}">+ Serviço</button>
      </div>
    </div>

    <div class="section-head"><h2>Plano de manutenção</h2>
      <button class="btn small" data-act="plan-new" data-vehicle="${v.id}">+ Item</button></div>
    ${items.length
      ? `<ul class="list">${items.map((a) => `
          <li class="item tap ${a.plan.active ? '' : 'inactive'}" data-act="plan-edit" data-id="${a.plan.id}">
            <div class="grow">
              <div class="row"><b>${esc(a.plan.name)}</b>${a.plan.active ? pill(a.status) : pill('', 'Pausado')}</div>
              <small>${intervalText(a.plan)} · última: ${fmtDate(a.lastDate)} / ${kmf(a.lastKm)}</small>
              <small>${dueText(a)}</small>
            </div>
          </li>`).join('')}</ul>`
      : `<div class="card"><p class="muted">Nenhum item no plano de manutenção.</p>
          <button class="btn small" data-act="plan-defaults" data-vehicle="${v.id}">Adicionar itens padrão</button></div>`}

    <h2>Histórico</h2>
    ${servicesList(sv, false)}`;
}

function viewReports() {
  setTitle('Custos');
  const f = reportFilter;
  if (f.vehicle && !vehicleById(f.vehicle)) f.vehicle = '';
  const years = [...new Set(state.services.map((s) => s.service_date.slice(0, 4)))].sort().reverse();
  const list = state.services.filter((s) =>
    (!f.vehicle || s.vehicle_id === f.vehicle) && (!f.year || s.service_date.startsWith(f.year)));
  const total = sum(list);

  const group = (keyFn) => {
    const m = new Map();
    list.forEach((s) => {
      const k = keyFn(s);
      m.set(k, (m.get(k) || 0) + Number(s.cost || 0));
    });
    return [...m];
  };
  const bars = (rows) => {
    const max = Math.max(...rows.map((r) => r[1]), 1);
    return `<ul class="bars">${rows.map(([label, val]) => `
      <li><span class="lbl">${esc(label)}</span>
        <span class="bar"><i style="width:${((val / max) * 100).toFixed(1)}%"></i></span>
        <span class="val">${brl(val)}</span></li>`).join('')}</ul>`;
  };

  const byCategory = group((s) => s.category).sort((a, b) => b[1] - a[1]);
  let byPeriod;
  if (f.year) {
    const months = new Map(group((s) => s.service_date.slice(5, 7)));
    byPeriod = Array.from({ length: 12 }, (_, i) => {
      const mm = String(i + 1).padStart(2, '0');
      const label = new Date(2000, i, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
      return [label, months.get(mm) || 0];
    });
  } else {
    byPeriod = group((s) => s.service_date.slice(0, 4)).sort((a, b) => a[0].localeCompare(b[0]));
  }
  const byVehicle = f.vehicle ? null : group((s) => vName(vehicleById(s.vehicle_id))).sort((a, b) => b[1] - a[1]);

  // custo por km rodado (somente com um veículo selecionado)
  let perKm = '';
  if (f.vehicle) {
    const kms = list.map((s) => s.km).filter((k) => k != null);
    if (!f.year) kms.push(vehicleById(f.vehicle).current_km);
    const span = kms.length > 1 ? Math.max(...kms) - Math.min(...kms) : 0;
    if (span > 0) perKm = `<div class="stat"><b>${brl(total / span)}</b><span>por km</span></div>`;
  }

  view.innerHTML = `
    <div class="filters">
      <select id="rf-vehicle"><option value="">Todos os veículos</option>
        ${state.vehicles.map((v) => `<option value="${v.id}" ${v.id === f.vehicle ? 'selected' : ''}>${esc(vName(v))}</option>`).join('')}
      </select>
      <select id="rf-year"><option value="">Todos os anos</option>
        ${years.map((y) => `<option ${y === f.year ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
    </div>
    <div class="stats">
      <div class="stat"><b>${brl(total)}</b><span>total</span></div>
      <div class="stat"><b>${list.length}</b><span>${list.length === 1 ? 'serviço' : 'serviços'}</span></div>
      ${perKm || `<div class="stat"><b>${brl(list.length ? total / list.length : 0)}</b><span>média/serviço</span></div>`}
    </div>
    ${list.length ? `
      <h2>${f.year ? 'Por mês' : 'Por ano'}</h2><div class="card">${bars(byPeriod)}</div>
      <h2>Por categoria</h2><div class="card">${bars(byCategory)}</div>
      ${byVehicle && state.vehicles.length > 1 ? `<h2>Por veículo</h2><div class="card">${bars(byVehicle)}</div>` : ''}
      <button class="btn block" data-act="export-csv">Exportar CSV</button>`
    : '<p class="card muted">Nenhum serviço no período.</p>'}`;

  view.querySelector('#rf-vehicle').onchange = (e) => { f.vehicle = e.target.value; viewReports(); };
  view.querySelector('#rf-year').onchange = (e) => { f.year = e.target.value; viewReports(); };
}

function exportCsv() {
  const f = reportFilter;
  const list = state.services.filter((s) =>
    (!f.vehicle || s.vehicle_id === f.vehicle) && (!f.year || s.service_date.startsWith(f.year)));
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Data', 'Veículo', 'Placa', 'Km', 'Categoria', 'Descrição', 'Oficina', 'Valor', 'Observações'];
  const rows = list.map((s) => {
    const v = vehicleById(s.vehicle_id);
    return [s.service_date, vName(v), v.plate, s.km, s.category, s.description, s.shop,
      Number(s.cost).toFixed(2).replace('.', ','), s.notes];
  });
  const csv = '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `manutencoes-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function viewHousehold() {
  const h = household();
  setTitle('Garagem');
  view.innerHTML = `
    <div class="card">
      <div class="section-head"><h2 class="flush">${esc(h.name)}</h2>
        ${isOwner() ? '<button class="btn small" data-act="hh-rename">Renomear</button>' : ''}</div>
      <p class="muted">Para convidar alguém da família: a pessoa cria uma conta no app e usa este código em
        “Entrar em uma garagem”.</p>
      <div class="invite"><code>${esc(h.invite_code)}</code>
        <button class="btn small primary" data-act="hh-share">Compartilhar</button></div>
      ${isOwner() ? '<button class="link" data-act="hh-newcode">Gerar novo código</button>' : ''}
    </div>

    <h2>Membros</h2>
    <ul class="list">${state.members.map((m) => `
      <li class="item"><div class="grow"><b>${esc(m.email || '—')}</b>
        <small>${m.role === 'owner' ? 'Dono' : 'Membro'}${m.user_id === state.user.id ? ' · você' : ''}</small></div>
        ${isOwner() && m.user_id !== state.user.id
          ? `<button class="btn small danger" data-act="hh-remove" data-id="${m.user_id}">Remover</button>` : ''}
      </li>`).join('')}</ul>

    ${state.households.length > 1 ? `
      <h2>Trocar de garagem</h2>
      <select id="hh-switch">${state.households.map((x) =>
        `<option value="${x.id}" ${x.id === state.hid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}

    <h2>Conta</h2>
    <div class="card">
      <p>Conectado como <b>${esc(state.user.email)}</b></p>
      <div class="actions wrap">
        <button class="btn" data-act="hh-join">Entrar em outra garagem</button>
        <button class="btn" data-act="hh-create">Criar nova garagem</button>
        ${isOwner() ? '' : '<button class="btn danger" data-act="hh-leave">Sair desta garagem</button>'}
        <button class="btn" data-act="logout">Sair da conta</button>
      </div>
    </div>
    <p class="muted center">Dica: no celular, use “Adicionar à tela inicial” para instalar como aplicativo.</p>`;

  const sw = view.querySelector('#hh-switch');
  if (sw) sw.onchange = async () => {
    state.hid = sw.value;
    localStorage.setItem('hid', sw.value);
    await refresh();
  };
}

// =====================================================================
// Formulários
// =====================================================================

function vehicleForm(v = null) {
  const isNew = !v;
  v = v || { vehicle_type: 'cars', current_km: 0 };
  // seleção atual na Tabela FIPE
  const sel = {
    type: v.vehicle_type, brands: [], models: [], years: [],
    brand: null, model: null, year: null,
    detail: v.fipe_code ? { codeFipe: v.fipe_code, price: v.fipe_value, referenceMonth: v.fipe_ref } : null,
  };

  const m = openModal(`
    <form id="vf">
      <h2>${isNew ? 'Novo veículo' : 'Editar veículo'}</h2>
      <label>Tipo<select name="vehicle_type">${Object.entries(VEHICLE_TYPES).map(([k, l]) =>
        `<option value="${k}" ${k === v.vehicle_type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Marca<input name="brand" list="dl-brands" required autocomplete="off" value="${esc(v.brand || '')}" placeholder="Digite para buscar"></label>
      <label>Modelo<input name="model" list="dl-models" required autocomplete="off" value="${esc(v.model || '')}" placeholder="Escolha a marca primeiro"></label>
      <label>Ano / combustível<input name="model_year" list="dl-years" autocomplete="off" value="${esc(v.model_year || '')}"></label>
      <datalist id="dl-brands"></datalist><datalist id="dl-models"></datalist><datalist id="dl-years"></datalist>
      <p class="fipe" id="fipe-info"></p>
      <div class="grid2">
        <label>Apelido<input name="nickname" value="${esc(v.nickname || '')}" placeholder="Ex.: Carro da Ana"></label>
        <label>Placa<input name="plate" value="${esc(v.plate || '')}" maxlength="8" class="upper" autocomplete="off"></label>
      </div>
      <div class="grid2">
        <label>Cor<input name="color" value="${esc(v.color || '')}"></label>
        <label>Km atual<input name="current_km" type="number" min="0" inputmode="numeric" required value="${v.current_km ?? 0}"></label>
      </div>
      ${isNew ? `<label class="check"><input type="checkbox" name="defaults" checked>
        Criar plano de manutenção padrão (óleo, filtros, pneus, freios…)</label>` : ''}
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="btn danger" id="vdel">Excluir</button>'}
        <span class="grow"></span>
        <button type="button" class="btn" data-close>Cancelar</button>
        <button class="btn primary">Salvar</button>
      </div>
    </form>`);

  const form = m.querySelector('#vf');
  const info = m.querySelector('#fipe-info');
  const fill = (id, list) => (m.querySelector(id).innerHTML = list.map((x) => `<option value="${esc(x.name)}">`).join(''));
  const find = (list, name) => list.find((x) => x.name.toLowerCase() === name.trim().toLowerCase()) || null;
  const showInfo = (text) => {
    info.innerHTML = text ?? (sel.detail
      ? `Tabela FIPE ${esc(sel.detail.codeFipe)}: <b>${esc(sel.detail.price)}</b> <small>(${esc(sel.detail.referenceMonth)})</small>`
      : '');
  };

  async function loadBrands() {
    showInfo('Carregando marcas da Tabela FIPE…');
    try {
      sel.brands = await fipe.brands(sel.type);
      fill('#dl-brands', sel.brands);
      showInfo();
    } catch {
      showInfo('Tabela FIPE indisponível agora — digite marca, modelo e ano manualmente.');
    }
  }
  async function loadModels() {
    sel.brand = find(sel.brands, form.brand.value);
    sel.models = [];
    fill('#dl-models', []);
    if (!sel.brand) return;
    try {
      sel.models = await fipe.models(sel.type, sel.brand.code);
      fill('#dl-models', sel.models);
    } catch (e) { showInfo(esc(e.message)); }
  }
  async function loadYears() {
    sel.model = sel.brand ? find(sel.models, form.model.value) : null;
    sel.years = [];
    fill('#dl-years', []);
    if (!sel.model) return;
    try {
      sel.years = (await fipe.years(sel.type, sel.brand.code, sel.model.code)).map((y) => ({ ...y, name: fipe.yearLabel(y.name) }));
      fill('#dl-years', sel.years);
    } catch (e) { showInfo(esc(e.message)); }
  }
  async function loadDetail() {
    sel.year = sel.model ? find(sel.years, form.model_year.value) : null;
    sel.detail = null;
    showInfo();
    if (!sel.year) return;
    try {
      sel.detail = await fipe.detail(sel.type, sel.brand.code, sel.model.code, sel.year.code);
      showInfo();
    } catch (e) { showInfo(esc(e.message)); }
  }

  form.vehicle_type.onchange = () => {
    sel.type = form.vehicle_type.value;
    form.brand.value = form.model.value = form.model_year.value = '';
    sel.brand = sel.model = sel.year = sel.detail = null;
    loadBrands();
  };
  // Reage quando o texto passa a (ou deixa de) corresponder a um item da lista
  form.brand.addEventListener('input', () => {
    if (find(sel.brands, form.brand.value)?.code === sel.brand?.code) return;
    form.model.value = form.model_year.value = '';
    sel.model = sel.year = sel.detail = null;
    showInfo();
    loadModels();
  });
  form.model.addEventListener('input', () => {
    if (find(sel.models, form.model.value)?.code === sel.model?.code) return;
    form.model_year.value = '';
    sel.year = sel.detail = null;
    showInfo();
    loadYears();
  });
  form.model_year.addEventListener('input', () => {
    if (find(sel.years, form.model_year.value)?.code === sel.year?.code) return;
    loadDetail();
  });

  (async () => {
    await loadBrands();
    if (!isNew) {
      await loadModels();
      await loadYears();
      sel.year = find(sel.years, form.model_year.value);
      showInfo();
    }
  })();

  // mantém códigos FIPE salvos se o campo não foi alterado e a API não respondeu
  const keep = (field, code) => (form[field].value.trim() === (v[field] || '') ? v[code] ?? null : null);

  onSubmit(form, async () => {
    const row = {
      household_id: state.hid,
      vehicle_type: sel.type,
      brand: form.brand.value.trim(),
      model: form.model.value.trim(),
      model_year: form.model_year.value.trim() || null,
      fipe_brand_code: sel.brand?.code ?? keep('brand', 'fipe_brand_code'),
      fipe_model_code: sel.model?.code ?? keep('model', 'fipe_model_code'),
      fipe_year_code: sel.year?.code ?? keep('model_year', 'fipe_year_code'),
      fipe_code: sel.detail?.codeFipe ?? null,
      fipe_value: sel.detail?.price ?? null,
      fipe_ref: sel.detail?.referenceMonth ?? null,
      nickname: form.nickname.value.trim() || null,
      plate: form.plate.value.trim().toUpperCase() || null,
      color: form.color.value.trim() || null,
      current_km: Number(form.current_km.value) || 0,
    };
    if (isNew) {
      row.km_updated_at = today();
      const created = await run(sb.from('vehicles').insert(row).select().single());
      if (form.defaults.checked) await createDefaultPlans(created);
      closeModal();
      await loadData();
      location.hash = '#/veiculo/' + created.id;
      route();
    } else {
      if (row.current_km !== v.current_km) row.km_updated_at = today();
      await run(sb.from('vehicles').update(row).eq('id', v.id));
      closeModal();
      await refresh();
    }
    toast('Veículo salvo');
  });

  const del = m.querySelector('#vdel');
  if (del) del.onclick = async () => {
    if (!confirm(`Excluir "${vName(v)}" e todo o histórico dele? Isso não pode ser desfeito.`)) return;
    try {
      await run(sb.from('vehicles').delete().eq('id', v.id));
      closeModal();
      location.hash = '#/veiculos';
      await refresh();
      toast('Veículo excluído');
    } catch (e) { fail(e); }
  };
}

function kmForm(v) {
  const m = openModal(`
    <form id="kf"><h2>Atualizar km</h2>
      <p class="muted">${esc(vName(v))} — atual: ${kmf(v.current_km)}</p>
      <label>Km mostrado no painel<input name="km" type="number" min="0" inputmode="numeric" required value="${v.current_km}"></label>
      <div class="actions"><span class="grow"></span><button type="button" class="btn" data-close>Cancelar</button>
      <button class="btn primary">Salvar</button></div>
    </form>`);
  const form = m.querySelector('#kf');
  form.km.select();
  onSubmit(form, async () => {
    const km = Number(form.km.value);
    if (km < v.current_km && !confirm('O km informado é menor que o atual. Salvar mesmo assim?')) return;
    await run(sb.from('vehicles').update({ current_km: km, km_updated_at: today() }).eq('id', v.id));
    closeModal();
    await refresh();
    toast('Km atualizado');
  });
}

function planForm(p) {
  const isNew = !p.id;
  const v = vehicleById(p.vehicle_id);
  const m = openModal(`
    <form id="pf"><h2>${isNew ? 'Novo item do plano' : 'Editar item do plano'}</h2>
      <label>Nome<input name="name" required value="${esc(p.name || '')}" placeholder="Ex.: Troca de óleo"></label>
      <p class="muted">Avisar no que acontecer primeiro:</p>
      <div class="grid2">
        <label>A cada (km)<input name="interval_km" type="number" min="1" inputmode="numeric" value="${p.interval_km ?? ''}"></label>
        <label>A cada (meses)<input name="interval_months" type="number" min="1" inputmode="numeric" value="${p.interval_months ?? ''}"></label>
      </div>
      <p class="muted">Última vez que foi feito (usado enquanto não houver serviço registrado para este item):</p>
      <div class="grid2">
        <label>Data<input name="start_date" type="date" required value="${p.start_date || today()}"></label>
        <label>Km<input name="start_km" type="number" min="0" inputmode="numeric" required value="${p.start_km ?? v.current_km}"></label>
      </div>
      ${isNew ? '' : `<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Ativo (gera alertas)</label>`}
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="btn danger" id="pdel">Excluir</button>'}
        <span class="grow"></span>
        <button type="button" class="btn" data-close>Cancelar</button>
        <button class="btn primary">Salvar</button>
      </div>
    </form>`);
  const form = m.querySelector('#pf');
  onSubmit(form, async () => {
    const row = {
      vehicle_id: p.vehicle_id,
      name: form.name.value.trim(),
      interval_km: numOrNull(form.interval_km.value),
      interval_months: numOrNull(form.interval_months.value),
      start_date: form.start_date.value,
      start_km: Number(form.start_km.value) || 0,
      active: isNew ? true : form.active.checked,
    };
    if (!row.interval_km && !row.interval_months) throw new Error('Informe o intervalo em km, em meses ou ambos.');
    await run(isNew ? sb.from('maintenance_plans').insert(row) : sb.from('maintenance_plans').update(row).eq('id', p.id));
    closeModal();
    await refresh();
    toast('Plano salvo');
  });
  const del = m.querySelector('#pdel');
  if (del) del.onclick = async () => {
    if (!confirm(`Excluir o item "${p.name}" do plano?`)) return;
    try {
      await run(sb.from('maintenance_plans').delete().eq('id', p.id));
      closeModal();
      await refresh();
    } catch (e) { fail(e); }
  };
}

function serviceForm(s) {
  if (!state.vehicles.length) return toast('Cadastre um veículo primeiro', 'error');
  const isNew = !s.id;
  const vid = s.vehicle_id || state.vehicles[0].id;
  const shops = [...new Set(state.services.map((x) => x.shop).filter(Boolean))];
  const m = openModal(`
    <form id="sf"><h2>${isNew ? 'Registrar serviço' : 'Editar serviço'}</h2>
      <label>Veículo<select name="vehicle_id">${state.vehicles.map((v) =>
        `<option value="${v.id}" ${v.id === vid ? 'selected' : ''}>${esc(vName(v))}</option>`).join('')}</select></label>
      <div class="grid2">
        <label>Data<input type="date" name="service_date" required value="${s.service_date || today()}"></label>
        <label>Km<input type="number" name="km" min="0" inputmode="numeric" value="${s.km ?? (isNew ? vehicleById(vid).current_km : '')}"></label>
      </div>
      <label>Categoria<select name="category">${CATEGORIES.map((c) =>
        `<option ${c === (s.category || 'Revisão') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <fieldset id="plan-checks"></fieldset>
      <label>Descrição<input name="description" value="${esc(s.description || '')}" placeholder="Ex.: Óleo 5W30 + filtro (em branco = itens marcados)"></label>
      <div class="grid2">
        <label>Oficina / local<input name="shop" list="dl-shops" value="${esc(s.shop || '')}"></label>
        <label>Valor (R$)<input type="number" name="cost" min="0" step="0.01" inputmode="decimal" value="${s.cost ?? ''}"></label>
      </div>
      <datalist id="dl-shops">${shops.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <label>Observações<textarea name="notes" rows="2">${esc(s.notes || '')}</textarea></label>
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="btn danger" id="sdel">Excluir</button>'}
        <span class="grow"></span>
        <button type="button" class="btn" data-close>Cancelar</button>
        <button class="btn primary">Salvar</button>
      </div>
    </form>`);

  const form = m.querySelector('#sf');
  const checked = new Set(s.plan_ids || []);
  const renderChecks = () => {
    const plans = state.plans.filter((p) => p.vehicle_id === form.vehicle_id.value && (p.active || checked.has(p.id)));
    const fs = m.querySelector('#plan-checks');
    fs.hidden = !plans.length;
    fs.innerHTML = '<legend>Itens do plano feitos neste serviço</legend>' + plans.map((p) => `
      <label class="check"><input type="checkbox" name="plan" value="${p.id}" ${checked.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('');
  };
  renderChecks();
  form.vehicle_id.onchange = () => {
    checked.clear();
    renderChecks();
    if (isNew) form.km.value = vehicleById(form.vehicle_id.value).current_km;
  };

  onSubmit(form, async () => {
    const planIds = [...form.querySelectorAll('input[name=plan]:checked')].map((i) => i.value);
    const description = form.description.value.trim()
      || planIds.map((id) => state.plans.find((p) => p.id === id)?.name).join(', ')
      || form.category.value;
    const row = {
      vehicle_id: form.vehicle_id.value,
      service_date: form.service_date.value,
      km: numOrNull(form.km.value),
      category: form.category.value,
      description,
      shop: form.shop.value.trim() || null,
      cost: Number(form.cost.value || 0),
      notes: form.notes.value.trim() || null,
    };
    let id = s.id;
    if (isNew) {
      id = (await run(sb.from('services').insert(row).select('id').single())).id;
    } else {
      await run(sb.from('services').update(row).eq('id', id));
      await run(sb.from('service_plans').delete().eq('service_id', id));
    }
    if (planIds.length) {
      await run(sb.from('service_plans').insert(planIds.map((plan_id) => ({ service_id: id, plan_id }))));
    }
    closeModal();
    await refresh();
    toast('Serviço salvo');
  });

  const del = m.querySelector('#sdel');
  if (del) del.onclick = async () => {
    if (!confirm('Excluir este serviço?')) return;
    try {
      await run(sb.from('services').delete().eq('id', s.id));
      closeModal();
      await refresh();
    } catch (e) { fail(e); }
  };
}

boot();
