import { supabase, FUNCTIONS_URL } from './supabaseClient.js';

// Os campos de ingrediente da receita são digitados no padrão brasileiro
// (vírgula decimal, ex.: "5,7") e chegam aqui como string — colunas numeric
// do Postgres não aceitam vírgula, então precisam ser convertidos antes de
// salvar.
function toNumber(value) {
  const normalized = String(value ?? '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------- Perfil ----------

export async function getProfile(userId) {
  // maybeSingle (em vez de single) porque uma conta sem linha em profiles
  // (ex.: criada antes do gatilho existir) não pode derrubar o carregamento
  // inteiro dos dados do usuário.
  const { data, error } = await supabase
    .from('profiles')
    .select(`
      full_name, company_name, cnpj, role, approval_status, plan, trial_ends_at,
      plan_billing_cycle, plan_renews_at, created_at, last_price_review_at,
      cep, street, neighborhood, city, state, address_number, complement,
      ifood_url, link_99_url, keeta_url, logo_url, slug
    `)
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? {
    full_name: null, company_name: null, cnpj: null, role: 'user', approval_status: 'approved',
    plan: 'trial', trial_ends_at: null, plan_billing_cycle: null, plan_renews_at: null,
    created_at: null, last_price_review_at: null,
    cep: null, street: null, neighborhood: null, city: null, state: null, address_number: null, complement: null,
    ifood_url: null, link_99_url: null, keeta_url: null, logo_url: null, slug: null,
  };
}

export async function updateProfile(userId, fields) {
  const { data, error } = await supabase.from('profiles').update(fields).eq('id', userId).select().single();
  if (error) throw error;
  return data;
}

export async function uploadCompanyLogo(userId, file) {
  const extension = file.name.split('.').pop() || 'jpg';
  const path = `${userId}/logo-${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from('product-photos').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from('product-photos').getPublicUrl(path);
  return data.publicUrl;
}

// ---------- Cardápio público (sem login — plano Pro, ver views no schema.sql) ----------

export async function getPublicCompany(slug) {
  const { data, error } = await supabase
    .from('public_companies')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getPublicProducts(userId) {
  const { data, error } = await supabase
    .from('public_products')
    .select('*')
    .eq('user_id', userId)
    .order('category', { ascending: true });
  if (error) throw error;
  return data;
}

// ---------- Administração de usuários (via Edge Function, service role no servidor) ----------

async function callAdminFunction(action, extra = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Sessão expirada. Faça login novamente.');

  const response = await fetch(`${FUNCTIONS_URL}/admin-users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Falha ao executar ação administrativa.');
  return body;
}

export function adminListUsers() {
  return callAdminFunction('list').then((res) => res.users);
}

export function adminApproveUser(userId) {
  return callAdminFunction('approve', { userId });
}

export function adminSuspendUser(userId) {
  return callAdminFunction('suspend', { userId });
}

export function adminReactivateUser(userId) {
  return callAdminFunction('reactivate', { userId });
}

export function adminDeleteUser(userId) {
  return callAdminFunction('delete', { userId });
}

export function deleteOwnAccount() {
  return callAdminFunction('self-delete');
}

// ---------- Ingredientes/embalagens (base de Produtos) ----------

export async function listIngredients(userId) {
  const { data, error } = await supabase
    .from('ingredients')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createIngredient(userId, ingredient) {
  const { data, error } = await supabase
    .from('ingredients')
    .insert({
      user_id: userId,
      name: ingredient.name,
      package_price: ingredient.packagePrice,
      package_amount: ingredient.packageAmount,
      unit: ingredient.unit,
      category: ingredient.category ?? '',
      brand: ingredient.brand ?? '',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateIngredient(id, ingredient) {
  const { data, error } = await supabase
    .from('ingredients')
    .update({
      name: ingredient.name,
      package_price: ingredient.packagePrice,
      package_amount: ingredient.packageAmount,
      unit: ingredient.unit,
      category: ingredient.category ?? '',
      brand: ingredient.brand ?? '',
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteIngredient(id) {
  const { error } = await supabase.from('ingredients').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Produtos / receitas ----------

// Sobe a foto para o bucket público "product-photos", numa pasta com o id
// do usuário (as políticas de storage só deixam gravar dentro da própria
// pasta), e devolve a URL pública para salvar em products.photo_url.
export async function uploadProductPhoto(userId, file) {
  const extension = file.name.split('.').pop() || 'jpg';
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from('product-photos').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from('product-photos').getPublicUrl(path);
  return data.publicUrl;
}

// Lista as receitas já com os itens de ingrediente de cada uma (uma única
// consulta extra, agrupada em memória) para dar para calcular o custo/preço
// sugerido de cada receita direto na listagem, sem N+1 consultas.
export async function listProducts(userId) {
  const { data: products, error } = await supabase
    .from('products')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;

  const { data: items, error: itemsError } = await supabase
    .from('product_ingredients')
    .select('*')
    .eq('user_id', userId);
  if (itemsError) throw itemsError;

  const itemsByProduct = new Map();
  for (const item of items) {
    if (!itemsByProduct.has(item.product_id)) itemsByProduct.set(item.product_id, []);
    itemsByProduct.get(item.product_id).push(item);
  }
  return products.map((product) => ({ ...product, ingredients: itemsByProduct.get(product.id) || [] }));
}

export async function loadProductWithIngredients(productId) {
  const { data: product, error: productError } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .single();
  if (productError) throw productError;

  const { data: items, error: itemsError } = await supabase
    .from('product_ingredients')
    .select('*')
    .eq('product_id', productId)
    .order('position', { ascending: true });
  if (itemsError) throw itemsError;

  return { product, items };
}

export async function saveProduct(userId, productId, productData, ingredients) {
  let savedProduct;

  if (productId) {
    const { data, error } = await supabase
      .from('products')
      .update({ ...productData, updated_at: new Date().toISOString() })
      .eq('id', productId)
      .select()
      .single();
    if (error) throw error;
    savedProduct = data;

    const { error: deleteError } = await supabase
      .from('product_ingredients')
      .delete()
      .eq('product_id', productId);
    if (deleteError) throw deleteError;
  } else {
    const { data, error } = await supabase
      .from('products')
      .insert({ user_id: userId, ...productData })
      .select()
      .single();
    if (error) throw error;
    savedProduct = data;
  }

  if (ingredients.length > 0) {
    const rows = ingredients.map((ingredient, index) => ({
      user_id: userId,
      product_id: savedProduct.id,
      ingredient_id: ingredient.ingredientId ?? null,
      name: ingredient.name,
      package_price: toNumber(ingredient.packagePrice),
      package_amount: toNumber(ingredient.packageAmount),
      used_amount: toNumber(ingredient.usedAmount),
      unit: ingredient.unit,
      position: index,
    }));
    const { error: insertError } = await supabase.from('product_ingredients').insert(rows);
    if (insertError) throw insertError;
  }

  return savedProduct;
}

export async function deleteProduct(id) {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Despesas fixas (base global, 1x por usuário) ----------

export async function listExpenseCategories(userId) {
  const { data, error } = await supabase
    .from('expense_categories')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true });
  if (error) throw error;
  return data;
}

const DEFAULT_EXPENSES = ['Gás', 'Limpeza', 'Energia', 'Água', 'Internet'];

export async function ensureDefaultExpenseCategories(userId) {
  const existing = await listExpenseCategories(userId);
  if (existing.length > 0) return existing;
  const rows = DEFAULT_EXPENSES.map((name, index) => ({
    user_id: userId, name, monthly_value: 0, percentage: 1, position: index,
  }));
  const { data, error } = await supabase.from('expense_categories').insert(rows).select();
  if (error) throw error;
  return data.sort((a, b) => a.position - b.position);
}

export async function updateExpenseCategory(id, fields) {
  const { data, error } = await supabase.from('expense_categories').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function createExpenseCategory(userId, fields) {
  const { data, error } = await supabase
    .from('expense_categories')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteExpenseCategory(id) {
  const { error } = await supabase.from('expense_categories').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Níveis de lucro (base global, 1x por usuário) ----------

export async function listProfitTiers(userId) {
  const { data, error } = await supabase
    .from('profit_tiers')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true });
  if (error) throw error;
  return data;
}

const DEFAULT_TIERS = [
  { name: 'Mínimo', multiplier: 2.5 },
  { name: 'Média', multiplier: 2.8 },
  { name: 'Máximo', multiplier: 3.5 },
];

export async function ensureDefaultProfitTiers(userId) {
  const existing = await listProfitTiers(userId);
  if (existing.length > 0) return existing;
  const rows = DEFAULT_TIERS.map((tier, index) => ({ user_id: userId, ...tier, position: index }));
  const { data, error } = await supabase.from('profit_tiers').insert(rows).select();
  if (error) throw error;
  return data.sort((a, b) => a.position - b.position);
}

export async function updateProfitTier(id, fields) {
  const { data, error } = await supabase.from('profit_tiers').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function createProfitTier(userId, fields) {
  const { data, error } = await supabase
    .from('profit_tiers')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteProfitTier(id) {
  const { error } = await supabase.from('profit_tiers').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Fornecedores ----------

export async function listSuppliers(userId) {
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createSupplier(userId, supplier) {
  const { data, error } = await supabase
    .from('suppliers')
    .insert({ user_id: userId, ...supplier })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateSupplier(id, fields) {
  const { data, error } = await supabase.from('suppliers').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteSupplier(id) {
  const { error } = await supabase.from('suppliers').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Clientes (recurso do plano Pro) ----------

export async function listCustomers(userId) {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createCustomer(userId, customer) {
  const { data, error } = await supabase
    .from('customers')
    .insert({ user_id: userId, ...customer })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateCustomer(id, fields) {
  const { data, error } = await supabase.from('customers').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteCustomer(id) {
  const { error } = await supabase.from('customers').delete().eq('id', id);
  if (error) throw error;
}

