-- SweetHub — schema do Supabase
-- Rode este arquivo inteiro no SQL Editor do seu projeto Supabase
-- (Dashboard -> SQL Editor -> New query -> colar -> Run)

create extension if not exists "pgcrypto";
-- unaccent: usado na geração do slug do cardápio público (handle_new_user),
-- pra transliterar "í", "ç", "ã" etc. em vez de tratá-los como pontuação.
create extension if not exists "unaccent";

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
  -- Cardápio público (recurso do plano Vitrine): logotipo e slug único do
  -- link (#/cardapio/:slug). O slug é gerado uma única vez no cadastro (ver
  -- handle_new_user abaixo) e nunca regenerado depois, pra não quebrar
  -- links já compartilhados.
  logo_url text,
  slug text not null unique,
  created_at timestamptz not null default now(),
  role text not null default 'user' constraint profiles_role_check check (role in ('user', 'admin')),
  approval_status text not null default 'pending'
    constraint profiles_approval_status_check check (approval_status in ('pending', 'approved', 'rejected')),
  -- Gratuito é permanente (sem prazo, sem cartão) — os limites de uso vêm
  -- de src/planLimits.js no client (nº de receitas/ingredientes etc.), não
  -- de uma data de expiração. Controle e Vitrine exigem pagamento
  -- confirmado antes de liberar o acesso: o cadastro fica represado em
  -- payment_status = 'pending' até o webhook do Mercado Pago confirmar (ver
  -- supabase/functions/mercadopago-webhook). Controle e Vitrine compartilham
  -- os recursos avançados (fornecedores, clientes, gestão da empresa,
  -- receitas ilimitadas); Vitrine acrescenta o cardápio público por cima.
  plan text not null default 'gratuito' constraint profiles_plan_check check (plan in ('gratuito', 'controle', 'vitrine')),
  -- Preenchidos pelo webhook do Mercado Pago ao confirmar o pagamento
  -- (mensal/anual e a data da próxima cobrança, ver preapproval). Ficam
  -- nulos até a primeira confirmação (ver Configurações no client, que
  -- mostra "ativado manualmente" quando ausentes — caso de contas antigas
  -- ajustadas à mão antes da integração existir).
  plan_billing_cycle text constraint profiles_plan_billing_cycle_check check (plan_billing_cycle in ('mensal', 'anual')),
  plan_renews_at timestamptz,
  -- Preferência do usuário (aba Configurações). Mapeia direto pro conceito
  -- de auto_recurring do Mercado Pago (preapproval): true = assinatura seguiria
  -- renovando no próximo ciclo; false = já foi "desativada a renovação
  -- automática" e o acesso vale até plan_renews_at. Por enquanto é só
  -- informativo — não corta o acesso sozinho (ver planStatus no client);
  -- o cancelamento de verdade da assinatura no Mercado Pago também seta isso
  -- pra false via webhook.
  plan_auto_renew boolean not null default true,
  -- Fluxo de pagamento (Controle/Vitrine escolhidos na landing page): a
  -- conta nasce com payment_status = 'pending' e pending_plan/
  -- pending_billing_cycle guardando o que foi escolhido — o acesso fica
  -- bloqueado (ver planStatus) até o webhook confirmar o pagamento e mover
  -- pending_plan pra plan de verdade. 'none' é o valor de contas gratuitas
  -- normais, que nunca passam por isso.
  payment_status text not null default 'none'
    constraint profiles_payment_status_check check (payment_status in ('none', 'pending', 'paid')),
  pending_plan text constraint profiles_pending_plan_check check (pending_plan in ('controle', 'vitrine')),
  pending_billing_cycle text constraint profiles_pending_billing_cycle_check check (pending_billing_cycle in ('mensal', 'anual')),
  -- ID da assinatura (preapproval) ativa no Mercado Pago — necessário pra
  -- cancelar a assinatura antiga num upgrade/downgrade e pra reconciliar
  -- notificações de renovação do webhook.
  mercadopago_preapproval_id text,
  -- Downgrade agendado (Controle→Gratuito ou Vitrine→Controle): o cliente já
  -- pagou o período atual, então mantém os recursos até plan_renews_at — o
  -- webhook aplica essa troca só na próxima renovação (cancelando a
  -- assinatura no Mercado Pago se for pra Gratuito, ou trocando de plano se
  -- for pra Controle) e depois limpa este campo.
  scheduled_plan text constraint profiles_scheduled_plan_check check (scheduled_plan in ('gratuito', 'controle', 'vitrine')),
  -- Recurso do plano Controle: aviso a cada 30 dias pra revisar os preços
  -- das receitas (ver pricesNeedReview no client). Nulo até a primeira
  -- revisão marcada; nesse caso o client usa created_at como referência.
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
      public.unaccent(coalesce(nullif(new.raw_user_meta_data ->> 'company_name', ''), split_part(new.email, '@', 1))),
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
-- customers — clientes do usuário (recurso do plano Controle — gestão da empresa)
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
  -- Cardápio público (recurso do plano Vitrine): campos exibidos só quando
  -- published = true e a conta é 'vitrine' (ver views public_* mais abaixo).
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

-- Não existe policy de "select" pública aqui de propósito: o bucket já é
-- público (serve qualquer objeto por URL direta, sem checar RLS — é para
-- isso que a flag "public" existe), então uma policy de select ampla só
-- serviria para permitir LISTAR todos os arquivos do bucket (expondo os
-- IDs de usuário usados como nome de pasta) sem ganhar nada em troca.
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
-- Cardápio público (recurso do plano Vitrine) — views expostas ao role anon.
-- Uma view (security_invoker = false, padrão) roda com o privilégio do
-- dono (postgres), o que deixa ela ignorar a RLS das tabelas base mesmo
-- assim: a restrição de linha vem do "where plan = 'vitrine'"/"published =
-- true" embutido na própria view, e a restrição de coluna vem da lista
-- explícita de colunas no select (nada sensível como CNPJ/endereço/e-mail
-- é exposto).
-- =========================================================
create or replace view public.public_companies as
  select id, company_name, logo_url, slug, ifood_url, link_99_url, keeta_url
  from public.profiles
  where plan = 'vitrine';

create or replace view public.public_products as
  select pr.id, pr.user_id, pr.name, pr.description, pr.category, pr.menu_price, pr.photo_url, pr.yield_amount
  from public.products pr
  join public.profiles p on p.id = pr.user_id
  where pr.published = true and p.plan = 'vitrine';

grant select on public.public_companies to anon;
grant select on public.public_products to anon;

-- =========================================================
-- Limites do plano Gratuito (ver src/planLimits.js) aplicados no banco —
-- o client já bloqueia a UI antes de chegar aqui, mas sem isso qualquer
-- pessoa com o próprio token dava pra ignorar os limites chamando a API
-- do Supabase direto. Fornecedores/clientes são bloqueio total (recurso
-- exclusivo de Controle/Vitrine, ver CONTROLE_ONLY_ROUTES em main.js); os
-- demais são contagem (20 receitas, 50 ingredientes, 5 categorias de
-- despesa, 10 fotos).
-- =========================================================
create or replace function public.enforce_recipe_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  current_plan text;
  current_count integer;
begin
  select plan into current_plan from public.profiles where id = new.user_id;
  if current_plan = 'gratuito' then
    select count(*) into current_count from public.products where user_id = new.user_id;
    if current_count >= 20 then
      raise exception 'Limite de 20 receitas do plano Gratuito atingido. Faça upgrade para o Controle.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_recipe_limit_trigger on public.products;
create trigger enforce_recipe_limit_trigger
before insert on public.products
for each row execute function public.enforce_recipe_limit();

-- Fotos são um campo do produto (photo_url), não uma tabela à parte — o
-- gate só entra em ação quando uma foto nova está sendo anexada (transição
-- de null pra preenchido), pra trocar a foto de uma receita que já tinha
-- uma não contar como acréscimo.
create or replace function public.enforce_photo_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  current_plan text;
  current_count integer;
  is_new_photo boolean;
begin
  is_new_photo := new.photo_url is not null and (tg_op = 'INSERT' or old.photo_url is null);
  if is_new_photo then
    select plan into current_plan from public.profiles where id = new.user_id;
    if current_plan = 'gratuito' then
      select count(*) into current_count from public.products where user_id = new.user_id and photo_url is not null;
      if current_count >= 10 then
        raise exception 'Limite de 10 fotos do plano Gratuito atingido. Faça upgrade para o Controle.';
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_photo_limit_trigger on public.products;
create trigger enforce_photo_limit_trigger
before insert or update on public.products
for each row execute function public.enforce_photo_limit();

create or replace function public.enforce_ingredient_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  current_plan text;
  current_count integer;
begin
  select plan into current_plan from public.profiles where id = new.user_id;
  if current_plan = 'gratuito' then
    select count(*) into current_count from public.ingredients where user_id = new.user_id;
    if current_count >= 50 then
      raise exception 'Limite de 50 ingredientes do plano Gratuito atingido. Faça upgrade para o Controle.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_ingredient_limit_trigger on public.ingredients;
create trigger enforce_ingredient_limit_trigger
before insert on public.ingredients
for each row execute function public.enforce_ingredient_limit();

create or replace function public.enforce_category_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  current_plan text;
  current_count integer;
begin
  select plan into current_plan from public.profiles where id = new.user_id;
  if current_plan = 'gratuito' then
    select count(*) into current_count from public.expense_categories where user_id = new.user_id;
    if current_count >= 5 then
      raise exception 'Limite de 5 categorias de despesa do plano Gratuito atingido. Faça upgrade para o Controle.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_category_limit_trigger on public.expense_categories;
create trigger enforce_category_limit_trigger
before insert on public.expense_categories
for each row execute function public.enforce_category_limit();

create or replace function public.enforce_controle_only()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  current_plan text;
begin
  select plan into current_plan from public.profiles where id = new.user_id;
  if current_plan not in ('controle', 'vitrine') then
    raise exception 'Este recurso é exclusivo do plano Controle. Faça upgrade para continuar.';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_controle_only_suppliers on public.suppliers;
create trigger enforce_controle_only_suppliers
before insert on public.suppliers
for each row execute function public.enforce_controle_only();
drop trigger if exists enforce_controle_only_customers on public.customers;
create trigger enforce_controle_only_customers
before insert on public.customers
for each row execute function public.enforce_controle_only();

-- Essas funções só devem rodar como trigger, nunca chamadas direto via
-- RPC — a invocação de trigger não depende dessa grant (testado: os
-- triggers continuam funcionando depois do revoke), então isso só fecha a
-- porta de RPC direto sem quebrar nada. is_admin() fica de fora de
-- propósito: apesar de também aparecer no advisor de segurança, a policy
-- "Admin vê todos os perfis" chama is_admin() para QUALQUER select
-- autenticado em profiles (não só admins), então revogar essa grant
-- quebraria a leitura do próprio perfil para todo mundo.
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.enforce_recipe_limit() from anon, authenticated;
revoke execute on function public.enforce_photo_limit() from anon, authenticated;
revoke execute on function public.enforce_ingredient_limit() from anon, authenticated;
revoke execute on function public.enforce_category_limit() from anon, authenticated;
revoke execute on function public.enforce_controle_only() from anon, authenticated;

-- Índices
create index if not exists ingredients_user_id_idx on public.ingredients (user_id);
create index if not exists products_user_id_idx on public.products (user_id);
create index if not exists product_ingredients_product_id_idx on public.product_ingredients (product_id);
create index if not exists pricing_history_user_id_idx on public.pricing_history (user_id, created_at desc);
create index if not exists expense_categories_user_id_idx on public.expense_categories (user_id, position);
create index if not exists profit_tiers_user_id_idx on public.profit_tiers (user_id, position);
create index if not exists suppliers_user_id_idx on public.suppliers (user_id);
