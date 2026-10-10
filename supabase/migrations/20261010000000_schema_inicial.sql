-- =====================================================================
-- Manutenção de Veículos — schema do banco (Supabase / Postgres)
-- Rode este arquivo inteiro no SQL Editor do Supabase (uma vez).
-- =====================================================================

-- ---------- Tabelas ---------------------------------------------------

-- Garagem: agrupa os veículos compartilhados por uma família
create table public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  email        text,
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index on public.household_members (user_id);

create table public.vehicles (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  vehicle_type    text not null default 'cars' check (vehicle_type in ('cars', 'motorcycles', 'trucks')),
  brand           text not null,
  model           text not null,
  model_year      text,
  -- dados da Tabela FIPE (opcionais)
  fipe_brand_code text,
  fipe_model_code text,
  fipe_year_code  text,
  fipe_code       text,
  fipe_value      text,
  fipe_ref        text,
  nickname        text,
  plate           text,
  color           text,
  current_km      integer not null default 0 check (current_km >= 0),
  km_updated_at   date default current_date,
  created_at      timestamptz not null default now()
);
create index on public.vehicles (household_id);

-- Itens do plano de manutenção (ex.: óleo a cada 10.000 km ou 12 meses)
create table public.maintenance_plans (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  name            text not null,
  interval_km     integer check (interval_km > 0),
  interval_months integer check (interval_months > 0),
  -- referência inicial (última vez feito antes de usar o app)
  start_km        integer not null default 0 check (start_km >= 0),
  start_date      date not null default current_date,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  check (interval_km is not null or interval_months is not null)
);
create index on public.maintenance_plans (vehicle_id);

-- Serviços realizados (histórico)
create table public.services (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  service_date date not null default current_date,
  km           integer check (km >= 0),
  category     text not null default 'Revisão',
  description  text not null,
  shop         text,
  cost         numeric(12, 2) not null default 0 check (cost >= 0),
  notes        text,
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index on public.services (vehicle_id, service_date desc);

-- Quais itens do plano foram feitos em cada serviço
create table public.service_plans (
  service_id uuid not null references public.services(id) on delete cascade,
  plan_id    uuid not null references public.maintenance_plans(id) on delete cascade,
  primary key (service_id, plan_id)
);
create index on public.service_plans (plan_id);

-- ---------- Funções auxiliares de permissão ---------------------------

create or replace function public.is_member(hid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from household_members where household_id = hid and user_id = auth.uid());
$$;

create or replace function public.is_owner(hid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from household_members where household_id = hid and user_id = auth.uid() and role = 'owner');
$$;

create or replace function public.can_access_vehicle(vid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from vehicles v
    join household_members m on m.household_id = v.household_id
    where v.id = vid and m.user_id = auth.uid()
  );
$$;

-- ---------- RPCs: criar / entrar em garagem ---------------------------

create or replace function public.create_household(p_name text) returns public.households
language plpgsql security definer set search_path = public as $$
declare h households;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  insert into households (name, created_by)
    values (coalesce(nullif(trim(p_name), ''), 'Minha garagem'), auth.uid())
    returning * into h;
  insert into household_members (household_id, user_id, role, email)
    values (h.id, auth.uid(), 'owner', auth.jwt() ->> 'email');
  return h;
end $$;

create or replace function public.join_household(p_code text) returns public.households
language plpgsql security definer set search_path = public as $$
declare h households;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  select * into h from households where invite_code = upper(trim(p_code));
  if not found then raise exception 'Código de convite inválido'; end if;
  insert into household_members (household_id, user_id, role, email)
    values (h.id, auth.uid(), 'member', auth.jwt() ->> 'email')
    on conflict do nothing;
  return h;
end $$;

create or replace function public.regenerate_invite(p_household uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not is_owner(p_household) then raise exception 'Apenas o dono pode gerar um novo código'; end if;
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  update households set invite_code = c where id = p_household;
  return c;
end $$;

revoke execute on function public.create_household(text), public.join_household(text), public.regenerate_invite(uuid) from public, anon;
grant execute on function public.create_household(text), public.join_household(text), public.regenerate_invite(uuid) to authenticated;

-- ---------- Atualiza o km do veículo ao registrar serviço -------------

create or replace function public.bump_vehicle_km() returns trigger
language plpgsql as $$
begin
  if new.km is not null then
    update public.vehicles
       set current_km = new.km,
           km_updated_at = greatest(coalesce(km_updated_at, new.service_date), new.service_date)
     where id = new.vehicle_id and current_km < new.km;
  end if;
  return new;
end $$;

create trigger services_bump_km
  after insert or update of km on public.services
  for each row execute function public.bump_vehicle_km();

-- ---------- Row Level Security ----------------------------------------

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.vehicles          enable row level security;
alter table public.maintenance_plans enable row level security;
alter table public.services          enable row level security;
alter table public.service_plans     enable row level security;

-- households: inserção só via create_household()
create policy "membros veem a garagem"   on public.households for select using (public.is_member(id));
create policy "dono edita a garagem"     on public.households for update using (public.is_owner(id)) with check (public.is_owner(id));
create policy "dono exclui a garagem"    on public.households for delete using (public.is_owner(id));

-- household_members: inserção só via create/join_household()
create policy "membros veem membros"     on public.household_members for select using (public.is_member(household_id));
create policy "sair ou dono remove"      on public.household_members for delete using (user_id = auth.uid() or public.is_owner(household_id));

create policy "membros gerenciam veículos" on public.vehicles for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

create policy "membros gerenciam planos" on public.maintenance_plans for all
  using (public.can_access_vehicle(vehicle_id)) with check (public.can_access_vehicle(vehicle_id));

create policy "membros gerenciam serviços" on public.services for all
  using (public.can_access_vehicle(vehicle_id)) with check (public.can_access_vehicle(vehicle_id));

create policy "membros gerenciam itens do serviço" on public.service_plans for all
  using (exists (select 1 from public.services s where s.id = service_id and public.can_access_vehicle(s.vehicle_id)))
  with check (exists (select 1 from public.services s where s.id = service_id and public.can_access_vehicle(s.vehicle_id)));
