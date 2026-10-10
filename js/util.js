export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const kmf = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('pt-BR') + ' km');
export const plural = (n, word) => `${n} ${word}${Math.abs(n) === 1 ? '' : 's'}`;

// ---------- Datas (sempre 'AAAA-MM-DD', sem fuso) ----------
const pad = (n) => String(n).padStart(2, '0');
export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => toISO(new Date());
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const fmtDate = (s) => (s ? parseISO(s).toLocaleDateString('pt-BR') : '—');
export function addMonths(s, n) {
  const d = parseISO(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISO(d);
}
export const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

// ---------- Domínio ----------
export const VEHICLE_TYPES = { cars: 'Carro', motorcycles: 'Moto', trucks: 'Caminhão' };
export const typeIcon = (t) => ({ cars: '🚗', motorcycles: '🏍️', trucks: '🚚' })[t] || '🚗';

export const CATEGORIES = [
  'Revisão', 'Troca de óleo', 'Pneus', 'Freios', 'Suspensão', 'Motor', 'Elétrica', 'Arrefecimento',
  'Ar-condicionado', 'Câmbio/Embreagem', 'Funilaria/Pintura', 'Documentação/Impostos', 'Seguro', 'Lavagem', 'Outros',
];

const CAR_PLANS = [
  { name: 'Troca de óleo e filtro', interval_km: 10000, interval_months: 12 },
  { name: 'Filtro de ar do motor', interval_km: 20000, interval_months: 12 },
  { name: 'Filtro de combustível', interval_km: 20000, interval_months: 24 },
  { name: 'Filtro de cabine (ar-condicionado)', interval_km: 15000, interval_months: 12 },
  { name: 'Rodízio e calibragem dos pneus', interval_km: 10000, interval_months: null },
  { name: 'Alinhamento e balanceamento', interval_km: 10000, interval_months: 12 },
  { name: 'Pastilhas de freio (inspeção)', interval_km: 20000, interval_months: null },
  { name: 'Fluido de freio', interval_km: null, interval_months: 24 },
  { name: 'Líquido de arrefecimento', interval_km: 40000, interval_months: 24 },
  { name: 'Velas de ignição', interval_km: 40000, interval_months: 36 },
  { name: 'Correia dentada', interval_km: 60000, interval_months: 48 },
];
const MOTO_PLANS = [
  { name: 'Troca de óleo', interval_km: 5000, interval_months: 6 },
  { name: 'Filtro de óleo', interval_km: 10000, interval_months: 12 },
  { name: 'Lubrificação e ajuste da corrente', interval_km: 1000, interval_months: null },
  { name: 'Kit relação (coroa, pinhão, corrente)', interval_km: 20000, interval_months: null },
  { name: 'Filtro de ar', interval_km: 10000, interval_months: 12 },
  { name: 'Velas de ignição', interval_km: 10000, interval_months: 24 },
  { name: 'Pastilhas de freio (inspeção)', interval_km: 10000, interval_months: null },
  { name: 'Fluido de freio', interval_km: null, interval_months: 24 },
];
export const defaultPlansFor = (type) => (type === 'motorcycles' ? MOTO_PLANS : CAR_PLANS);

// Calcula quando um item do plano vence, a partir do último serviço ligado a ele
// (ou da referência inicial do item, se ainda não houver serviço).
export function planStatus(plan, vehicle, vehicleServices) {
  let lastDate = plan.start_date;
  let lastKm = plan.start_km;
  let latest = null;
  for (const s of vehicleServices) {
    if (!s.plan_ids.includes(plan.id)) continue;
    if (!latest || s.service_date > latest.service_date || (s.service_date === latest.service_date && (s.km ?? 0) > (latest.km ?? 0))) {
      latest = s;
    }
  }
  if (latest && latest.service_date >= lastDate) {
    lastDate = latest.service_date;
    if (latest.km != null) lastKm = latest.km;
  }

  const nextKm = plan.interval_km ? lastKm + plan.interval_km : null;
  const nextDate = plan.interval_months ? addMonths(lastDate, plan.interval_months) : null;
  const remKm = nextKm != null ? nextKm - vehicle.current_km : null;
  const remDays = nextDate ? daysBetween(today(), nextDate) : null;

  let status = 'ok';
  if ((remKm != null && remKm <= 0) || (remDays != null && remDays <= 0)) status = 'overdue';
  else if ((remKm != null && remKm <= Math.max(500, plan.interval_km * 0.1)) || (remDays != null && remDays <= 30)) status = 'soon';

  return { lastDate, lastKm, nextKm, nextDate, remKm, remDays, status };
}
