// Cliente da API pública da Tabela FIPE (https://deividfortuna.github.io/fipe/v2/)
import { FIPE_TOKEN } from './config.js';

const BASE = 'https://fipe.parallelum.com.br/api/v2';
const TTL = 7 * 24 * 3600 * 1000;
const mem = new Map();

async function get(path) {
  if (mem.has(path)) return mem.get(path);
  const key = 'fipe:' + path;
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached && Date.now() - cached.t < TTL) {
      mem.set(path, cached.v);
      return cached.v;
    }
  } catch { /* cache indisponível */ }

  const res = await fetch(BASE + path, { headers: FIPE_TOKEN ? { 'X-Subscription-Token': FIPE_TOKEN } : {} });
  if (!res.ok) throw new Error(`Tabela FIPE indisponível (${res.status})`);
  const value = await res.json();
  mem.set(path, value);
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); } catch { /* cheio */ }
  return value;
}

export const brands = (type) => get(`/${type}/brands`);
export const models = (type, brand) => get(`/${type}/brands/${brand}/models`);
export const years = (type, brand, model) => get(`/${type}/brands/${brand}/models/${model}/years`);
export const detail = (type, brand, model, year) => get(`/${type}/brands/${brand}/models/${model}/years/${year}`);

// A FIPE usa o ano 32000 para veículos zero km
export const yearLabel = (name) => name.replace(/^32000\b/, '0 km');
