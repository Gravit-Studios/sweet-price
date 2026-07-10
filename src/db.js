import { supabase, FUNCTIONS_URL } from './supabaseClient.js';

// ---------- Perfil ----------

export async function getProfile(userId) {
  // maybeSingle (em vez de single) porque uma conta sem linha em profiles
  // (ex.: criada antes do gatilho existir) não pode derrubar o carregamento
  // inteiro dos dados do usuário.
  const { data, error } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? { full_name: null, role: 'user' };
}

export async function updateProfile(userId, fields) {
  const { data, error } = await supabase.from('profiles').update(fields).eq('id', userId).select().single();
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

export async function listProducts(userId) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
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
      package_price: ingredient.packagePrice,
      package_amount: ingredient.packageAmount,
      used_amount: ingredient.usedAmount,
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

export async function deleteSupplier(id) {
  const { error } = await supabase.from('suppliers').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Histórico de precificação ----------

export async function saveHistoryEntry(userId, entry) {
  const { error } = await supabase.from('pricing_history').insert({
    user_id: userId,
    product_id: entry.productId ?? null,
    product_name: entry.productName,
    ingredients_cost: entry.ingredientsCost,
    expenses_cost: entry.expensesCost,
    total_cost: entry.totalCost,
    unit_cost: entry.unitCost,
    yield_amount: entry.yieldAmount,
    tiers: entry.tiers,
  });
  if (error) throw error;
}

export async function listHistory(userId, limit = 30) {
  const { data, error } = await supabase
    .from('pricing_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}
