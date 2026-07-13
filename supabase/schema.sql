-- Doce Preço — schema do Supabase
-- Rode este arquivo inteiro no SQL Editor do seu projeto Supabase
-- (Dashboard -> SQL Editor -> New query -> colar -> Run)

create extension if not exists "pgcrypto";

-- =========================================================
-- profiles — criado automaticamente no cadastro
-- =========================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  company_name text,
  cnpj text,
  cep text,
  street text,
  neighborhood text,
  city text,
  state text,
  address_number text,
  complement text,
  ifood_url text,
  link_99_url text,
  keeta_url text,
  -- Cardápio público (recurso do plano Pro): logotipo e slug único do link
  -- (#/cardapio/:slug). O slug é gerado uma única vez no cadastro (ver
  -- handle_new_user abaixo) e nunca regenerado depois, pra não quebrar
  -- links já compartilhados.
  logo_url text,
  slug text not null unique,
  created_at timestamptz not null default now(),
  role text not null default 'user' constraint profiles_role_check check (role in ('user', 'admin')),
  approval_status text not null default 'pending'
    constraint profiles_approval_status_check check (approval_status in ('pending', 'approved', 'rejected')),
  -- Teste grátis de 7 dias com acesso de nível Básico; depois disso, sem um
  -- plano pago o acesso fica bloqueado (ver gating no client, main.js).
  -- Sem checkout automático ainda: a troca pra 'basico'/'pro' é manual.
  plan text not null default 'trial' constraint profiles_plan_check check (plan in ('trial', 'basico', 'pro')),
  trial_ends_at timestamptz not null default (now() + interval '7 days'),
  -- Preenchidos manualmente enquanto não há checkout automático (Mercado
  -- Pago pendente): mensal/anual e a data de renovação combinada com o
  -- cliente. Ficam nulos até serem preenchidos à mão (ver Configurações no
  -- client, que mostra "ativado manualmente" quando ausentes).
  plan_billing_cycle text constraint profiles_plan_billing_cycle_check check (plan_billing_cycle in ('mensal', 'anual')),
  plan_renews_at timestamptz,
  -- Recurso do plano Pro: aviso a cada 30 dias pra revisar os preços das
  -- receitas (ver pricesNeedReview no client). Nulo até a primeira revisão
  -- marcada; nesse caso o client usa created_at como referência.
  last_price_review_at timestamptz
);
alter table public.profiles enable row level security;
create policy "Usuário vê o próprio perfil" on public.profiles for select using (auth.uid() = id);
create policy "Usuário atualiza o próprio perfil" on public.profiles for update using (auth.uid() = id);

-- Função auxiliar (security definer) para checar se o usuário atual é admin,
-- sem cair em recursão de RLS ao consultar profiles dentro de uma policy de profiles.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

create policy "Admin vê todos os perfis" on public.profiles for select using (public.is_admin());

-- O primeiro super admin é promovido manualmente, uma única vez, depois de
-- criar a conta pelo cadastro normal do site:
--   update public.profiles set role = 'admin' where id = '<uuid do usuário>';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, company_name, slug)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'company_name',
    lower(regexp_replace(
      coalesce(nullif(new.raw_user_meta_data ->> 'company_name', ''), split_part(new.email, '@', 1)),
      '[^a-zA-Z0-9]+', '-', 'g'
    )) || '-' || substr(new.id::text, 1, 6)
  );
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- =========================================================
-- ingredients — base de insumos/embalagens (Nome, Kg/Preço, Categoria, Marca)
-- =========================================================
create table if not exists public.ingredients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  package_price numeric not null default 0,
  package_amount numeric not null default 0,
  unit text not null default 'g',
  category text default '',
  brand text default '',
  created_at timestamptz not null default now()
);
alter table public.ingredients enable row level security;
create policy "Usuário gerencia os próprios ingredientes" on public.ingredients for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================
-- expense_categories — despesas fixas mensais (Gás, Limpeza, Energia, Água, Internet)
-- cadastradas uma única vez por usuário, com % alocado por receita
-- =========================================================
create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  monthly_value numeric not null default 0,
  percentage numeric not null default 1,
  position integer not null default 0
);
alter table public.expense_categories enable row level security;
create policy "Usuário gerencia as próprias despesas" on public.expense_categories for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================
-- profit_tiers — níveis de lucro (Mínimo, Média, Máximo), multiplicador sobre o custo
-- =========================================================
create table if not exists public.profit_tiers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  multiplier numeric not null default 1,
  position integer not null default 0
);
alter table public.profit_tiers enable row level security;
create policy "Usuário gerencia os próprios níveis de lucro" on public.profit_tiers for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================
-- suppliers — fornecedores
-- =========================================================
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  phone text default '',
  address text default '',
  site text default '',
  contact_name text default '',
  email text default ''
);
alter table public.suppliers enable row level security;
create policy "Usuário gerencia os próprios fornecedores" on public.suppliers for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================
-- customers — clientes do usuário (recurso do plano Pro — gestão da empresa)
-- =========================================================
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  phone text default '',
  email text default '',
  address text default '',
  notes text default '',
  created_at timestamptz not null default now()
);
alter table public.customers enable row level security;
create policy "Usuário gerencia os próprios clientes" on public.customers for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================
-- products — receitas (nome + rendimento; custos vêm de ingredientes + despesas globais)
-- =========================================================
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  yield_amount integer not null default 1,
  photo_url text,
  -- Cardápio público (recurso do plano Pro): campos exibidos só quando
  -- published = true e a conta é 'pro' (ver views public_* mais abaixo).
  category text default '',
  description text default '',
  menu_price numeric not null default 0,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.products enable row level security;
create policy "Usuário gerencia os próprios produtos" on public.products for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Bucket público para fotos de receitas/produtos. Cada usuário só pode
-- gravar/apagar dentro da própria pasta (product-photos/&lt;user_id&gt;/...);
-- leitura é pública porque a foto do produto não é dado sensível.
insert into storage.buckets (id, name, public)
values ('product-photos', 'product-photos', true)
on conflict (id) do nothing;

create policy "Leitura pública de fotos de produtos" on storage.objects
  for select using (bucket_id = 'product-photos');

create policy "Usuário gerencia as próprias fotos de produtos" on storage.objects
  for all
  using (bucket_id = 'product-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'product-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- =========================================================
-- product_ingredients — itens usados em cada receita
-- =========================================================
create table if not exists public.product_ingredients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  ingredient_id uuid references public.ingredients (id) on delete set null,
  name text not null,
  package_price numeric not null default 0,
  package_amount numeric not null default 0,
  used_amount numeric not null default 0,
  unit text not null default 'g',
  position integer not null default 0
);
alter table public.product_ingredients enable row level security;
create policy "Usuário gerencia os próprios itens de produto" on public.product_ingredients for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================
-- pricing_history — snapshot de cada cálculo (com os 3 cenários de lucro)
-- =========================================================
create table if not exists public.pricing_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  product_name text not null,
  ingredients_cost numeric not null,
  expenses_cost numeric not null default 0,
  total_cost numeric not null,
  unit_cost numeric not null,
  yield_amount integer not null,
  tiers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.pricing_history enable row level security;
create policy "Usuário gerencia o próprio histórico" on public.pricing_history for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================
-- Cardápio público (recurso do plano Pro) — views expostas ao role anon.
-- Uma view (security_invoker = false, padrão) roda com o privilégio do
-- dono (postgres), o que deixa ela ignorar a RLS das tabelas base mesmo
-- assim: a restrição de linha vem do "where plan = 'pro'"/"published =
-- true" embutido na própria view, e a restrição de coluna vem da lista
-- explícita de colunas no select (nada sensível como CNPJ/endereço/e-mail
-- é exposto).
-- =========================================================
create or replace view public.public_companies as
  select id, company_name, logo_url, slug, ifood_url, link_99_url, keeta_url
  from public.profiles
  where plan = 'pro';

create or replace view public.public_products as
  select pr.id, pr.user_id, pr.name, pr.description, pr.category, pr.menu_price, pr.photo_url, pr.yield_amount
  from public.products pr
  join public.profiles p on p.id = pr.user_id
  where pr.published = true and p.plan = 'pro';

grant select on public.public_companies to anon;
grant select on public.public_products to anon;

-- Índices
create index if not exists ingredients_user_id_idx on public.ingredients (user_id);
create index if not exists products_user_id_idx on public.products (user_id);
create index if not exists product_ingredients_product_id_idx on public.product_ingredients (product_id);
create index if not exists pricing_history_user_id_idx on public.pricing_history (user_id, created_at desc);
create index if not exists expense_categories_user_id_idx on public.expense_categories (user_id, position);
create index if not exists profit_tiers_user_id_idx on public.profit_tiers (user_id, position);
create index if not exists suppliers_user_id_idx on public.suppliers (user_id);
