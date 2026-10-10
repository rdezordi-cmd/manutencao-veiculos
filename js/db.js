import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const isConfigured = !SUPABASE_URL.includes('SEU-PROJETO') && !SUPABASE_ANON_KEY.includes('SUA-CHAVE');

export const sb = isConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Executa uma query do Supabase e lança o erro, se houver
export async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
