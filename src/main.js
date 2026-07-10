import { calculatePricing, formatCurrency } from './pricing.js';
import { signUp, signIn, signOut, getSession, onAuthStateChange, changePassword, updateEmail } from './auth.js';
import { parseRoute, navigate, onRouteChange } from './router.js';
import { headerArt } from './headerArt.js';
import * as db from './db.js';

// ---------------- Helpers de estado / formatação ----------------

function newIngredient(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    ingredientId: null,
    name: '',
    packagePrice: '',
    packageAmount: '',
    usedAmount: '',
    unit: 'g',
    ...overrides,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function toNumberSafe(value) {
  const normalized = String(value ?? '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Nome de exibição para contas sem "nome completo" salvo: deriva algo
// apresentável do e-mail em vez de mostrar o endereço cru.
function nameFromEmail(email) {
  const prefix = String(email ?? '').split('@')[0];
  return prefix.replace(/[._-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function defaultWizard() {
  return {
    step: 1,
    productName: '',
    yieldAmount: '1',
    ingredients: [newIngredient()],
    errors: {},
  };
}

function defaultDetail() {
  return {
    loading: false,
    productId: null,
    productName: '',
    yieldAmount: '',
    ingredients: [],
    errors: {},
  };
}

const state = {
  session: null,
  authMode: 'signin',
  authError: '',
  authLoading: false,

  route: { path: 'inicio', param: undefined },

  savedIngredients: [],
  savedProducts: [],
  history: [],
  expenseCategories: [],
  profitTiers: [],
  suppliers: [],
  dataLoading: false,
  statusMessage: '',

  profile: { fullName: '', role: 'user' },
  profileMenuOpen: false,
  successModal: '',
  activeModal: null,
  openCombobox: null,

  admin: { users: [], loading: false, error: '' },

  wizard: defaultWizard(),
  detail: defaultDetail(),
};

const app = document.querySelector('#root');

function getEditor(key) {
  return key === 'wizard' ? state.wizard : state.detail;
}

function pricingFor(editor) {
  return calculatePricing({
    ingredients: editor.ingredients,
    expenseCategories: state.expenseCategories,
    profitTiers: state.profitTiers,
    yieldAmount: editor.yieldAmount,
  });
}

// ---------------- Foco: captura/restauração entre re-renders ----------------

function captureFocus() {
  const el = document.activeElement;
  if (!el || !app.contains(el)) return null;
  let selector = null;
  if (el.dataset.ingredientField) {
    const rowId = el.closest('[data-ingredient]')?.dataset.ingredient;
    selector = `[data-ingredient="${rowId}"][data-ingredient-field="${el.dataset.ingredientField}"]`;
  } else if (el.dataset.field) {
    selector = `[data-editor="${el.dataset.editor}"][data-field="${el.dataset.field}"]`;
  } else if (el.dataset.expenseField) {
    selector = `[data-expense-id="${el.dataset.expenseId}"][data-expense-field="${el.dataset.expenseField}"]`;
  } else if (el.dataset.tierField) {
    selector = `[data-tier-id="${el.dataset.tierId}"][data-tier-field="${el.dataset.tierField}"]`;
  } else if (el.name) {
    selector = `[name="${el.name}"]`;
  }
  if (!selector) return null;
  return { selector, selStart: el.selectionStart, selEnd: el.selectionEnd };
}

function restoreFocus(restore) {
  if (!restore) return;
  const el = app.querySelector(restore.selector);
  if (!el) return;
  el.focus();
  if (typeof restore.selStart === 'number' && el.setSelectionRange) {
    try { el.setSelectionRange(restore.selStart, restore.selEnd); } catch { /* ignore */ }
  }
}

// ---------------- Dados do usuário ----------------

async function loadUserData() {
  if (!state.session) return;
  state.dataLoading = true;
  render();
  try {
    const userId = state.session.user.id;
    const [ingredients, products, history, expenseCategories, profitTiers, suppliers, profile] = await Promise.all([
      db.listIngredients(userId),
      db.listProducts(userId),
      db.listHistory(userId, 30),
      db.ensureDefaultExpenseCategories(userId),
      db.ensureDefaultProfitTiers(userId),
      db.listSuppliers(userId),
      db.getProfile(userId),
    ]);
    state.savedIngredients = ingredients;
    state.savedProducts = products;
    state.history = history;
    state.expenseCategories = expenseCategories;
    state.profitTiers = profitTiers;
    state.suppliers = suppliers;
    state.profile = { fullName: profile.full_name || '', role: profile.role || 'user' };
  } catch (error) {
    state.statusMessage = `Erro ao carregar dados: ${error.message}`;
  } finally {
    state.dataLoading = false;
    render();
  }
}

async function ensureDetailLoaded(id) {
  state.detail = { ...defaultDetail(), loading: true };
  render();
  try {
    const { product, items } = await db.loadProductWithIngredients(id);
    state.detail = {
      loading: false,
      productId: product.id,
      productName: product.name,
      yieldAmount: String(product.yield_amount),
      ingredients: items.length > 0
        ? items.map((item) => newIngredient({
            ingredientId: item.ingredient_id,
            name: item.name,
            packagePrice: String(item.package_price),
            packageAmount: String(item.package_amount),
            usedAmount: String(item.used_amount),
            unit: item.unit,
          }))
        : [newIngredient()],
      errors: {},
    };
  } catch (error) {
    state.statusMessage = `Erro ao abrir receita: ${error.message}`;
    state.detail = { ...defaultDetail(), loading: false };
  }
  render();
}

function startWizard() {
  state.wizard = defaultWizard();
  state.statusMessage = '';
}

// ---------------- Roteamento ----------------

function handleRouteChange(route) {
  state.route = route;
  if (route.path === 'produto' && route.param && state.detail.productId !== route.param) {
    ensureDetailLoaded(route.param);
    return;
  }
  if (route.path === 'admin' && state.profile.role === 'admin' && !state.admin.loading && state.admin.users.length === 0) {
    loadAdminUsers();
    return;
  }
  render();
}

async function loadAdminUsers() {
  state.admin = { users: [], loading: true, error: '' };
  render();
  try {
    const users = await db.adminListUsers();
    state.admin = { users, loading: false, error: '' };
  } catch (error) {
    state.admin = { users: [], loading: false, error: error.message };
  }
  render();
}

async function handleAdminAction(action, userId) {
  const confirmMessages = {
    suspend: 'Suspender o acesso deste usuário?',
    delete: 'Excluir permanentemente este usuário e todos os dados dele? Esta ação não pode ser desfeita.',
  };
  if (confirmMessages[action] && !window.confirm(confirmMessages[action])) return;
  try {
    if (action === 'suspend') await db.adminSuspendUser(userId);
    if (action === 'reactivate') await db.adminReactivateUser(userId);
    if (action === 'delete') await db.adminDeleteUser(userId);
    await loadAdminUsers();
    showSuccess(
      action === 'suspend' ? 'Usuário suspenso.' : action === 'reactivate' ? 'Usuário reativado.' : 'Usuário excluído.',
    );
  } catch (error) {
    state.admin.error = error.message;
    render();
  }
}

onRouteChange(handleRouteChange);

getSession().then((session) => {
  state.session = session;
  if (session) loadUserData();
  handleRouteChange(parseRoute());
});

onAuthStateChange((session) => {
  const hadSession = Boolean(state.session);
  state.session = session;
  if (session && !hadSession) loadUserData();
  if (!session) {
    state.savedIngredients = [];
    state.savedProducts = [];
    state.history = [];
    state.expenseCategories = [];
    state.profitTiers = [];
    state.suppliers = [];
    state.profile = { fullName: '', role: 'user' };
    state.profileMenuOpen = false;
  }
  render();
});

// ---------------- Modais (sucesso / edição) ----------------

function showSuccess(message) {
  state.successModal = message;
  render();
  setTimeout(() => {
    if (state.successModal === message) {
      state.successModal = '';
      render();
    }
  }, 1800);
}

function openModal(type, data = {}) {
  state.activeModal = { type, error: '', loading: false, ...data };
  render();
}

function closeModal() {
  state.activeModal = null;
  render();
}

// ---------------- Fragmentos de UI reutilizáveis ----------------

const ICON_PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9h14v-9"/><path d="M9.5 19v-5h5v5"/>',
  box: '<path d="M3 8l9-4 9 4-9 4-9-4Z"/><path d="M3 8v8l9 4 9-4V8"/><path d="M12 12v8"/>',
  leaf: '<path d="M5 19c8 0 14-6 14-14 0 0-14-2-14 8 0 3 2 6 2 6Z"/><path d="M5 19c0-4 2-7 5-9"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10.5h18"/><circle cx="16.5" cy="14.5" r="1.1" fill="currentColor" stroke="none"/>',
  trending: '<path d="M4 16l6-6 4 4 6-8"/><path d="M15 6h5v5"/>',
  truck: '<rect x="2" y="8" width="12" height="8"/><path d="M14 11h4l3 3v2h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  star: '<path d="M12 3l2.6 5.8 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3 1.4-6.3-4.8-4.3 6.4-.6Z"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13 7l4 4"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M13 10l2 2"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"/>',
};

function icon(name, extraClass = '') {
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

const AVATAR_COLORS = ['#c8795b', '#e8586f', '#a8564c', '#8f3f37', '#d98a4f', '#b2603f'];

function avatarColorFor(name) {
  const sum = String(name).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function banner(title, subtitle) {
  return `<div class="banner">${headerArt}<div class="banner-overlay"></div><div class="banner-content"><p class="eyebrow">Delícias da Tai</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></div>`;
}

function statusBox() {
  return state.statusMessage ? `<p class="status-message">${escapeHtml(state.statusMessage)}</p>` : '';
}

function loadingMsg() {
  return '<p class="muted">Carregando...</p>';
}

function emptyState(message, showCta) {
  return `<div class="empty-state"><p>${escapeHtml(message)}</p>${showCta ? '<button type="button" data-action="start-wizard">Criar receita</button>' : ''}</div>`;
}

// Padrão de campo do projeto: label acima do input, erro (se houver) abaixo.
function fieldFor(editorKey, key, label, value, mode = 'text', error = '') {
  return `<label>${label}<input class="${error ? 'is-invalid' : ''}" data-editor="${editorKey}" data-field="${key}" inputmode="${mode}" value="${escapeHtml(value)}" />${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ''}</label>`;
}

function basicFields(editorKey, editor) {
  const errors = editor.errors || {};
  return `<div class="field-grid">
    ${fieldFor(editorKey, 'productName', 'Nome da receita', editor.productName, 'text', errors.productName)}
    ${fieldFor(editorKey, 'yieldAmount', 'Rendimento (Qnt. por forma)', editor.yieldAmount, 'decimal', errors.yieldAmount)}
  </div>`;
}

// Lê a quantidade comprada da embalagem e define o teto permitido para a
// quantidade usada na receita (não pode ultrapassar o que foi comprado).
function maxUsedAmount(ingredient) {
  const max = toNumberSafe(ingredient.packageAmount);
  return max > 0 ? max : null;
}

// Combobox de busca: input de texto + lista filtrada da base de ingredientes,
// clicável (não é só um <input list> de HTML, é o mesmo padrão reutilizado
// em qualquer lugar que precise buscar um ingrediente salvo).
function ingredientNameCell(editorKey, ingredient) {
  const rowId = ingredient.id;
  const isOpen = state.openCombobox === rowId;
  const query = ingredient.name.trim().toLowerCase();
  const options = query
    ? state.savedIngredients.filter((si) => si.name.toLowerCase().includes(query))
    : state.savedIngredients;
  return `
    <div class="combobox">
      <input aria-label="Ingrediente" autocomplete="off" placeholder="Buscar na base..." data-editor="${editorKey}" data-ingredient-field="name" value="${escapeHtml(ingredient.name)}" />
      ${isOpen && options.length ? `
        <div class="combobox-list">
          ${options.map((si) => `<button type="button" class="combobox-option" data-action="select-ingredient-option" data-editor="${editorKey}" data-row-id="${rowId}" data-ingredient-id="${si.id}">${escapeHtml(si.name)}</button>`).join('')}
        </div>` : ''}
    </div>`;
}

function ingredientRows(editorKey, ingredients, invalidIds = new Set()) {
  return `
  <div class="ingredient-grid header-row" aria-hidden="true"><span>Ingrediente</span><span>Preço da compra</span><span>Qtd. comprada</span><span>Qtd. usada</span><span>Un.</span><span></span></div>
  ${ingredients.map((ingredient) => {
    const max = maxUsedAmount(ingredient);
    const usedInvalid = invalidIds.has(ingredient.id);
    return `
    <div class="ingredient-grid" data-ingredient="${ingredient.id}">
      ${ingredientNameCell(editorKey, ingredient)}
      <input aria-label="Preço da compra" inputmode="decimal" data-editor="${editorKey}" data-ingredient-field="packagePrice" value="${escapeHtml(ingredient.packagePrice)}" />
      <input aria-label="Quantidade comprada" inputmode="decimal" data-editor="${editorKey}" data-ingredient-field="packageAmount" value="${escapeHtml(ingredient.packageAmount)}" />
      <input aria-label="Quantidade usada" inputmode="decimal" required class="${usedInvalid ? 'is-invalid' : ''}" placeholder="${max ? `Máx. ${max}` : 'Obrigatório'}" data-editor="${editorKey}" data-ingredient-field="usedAmount" value="${escapeHtml(ingredient.usedAmount)}" />
      <input aria-label="Unidade" data-editor="${editorKey}" data-ingredient-field="unit" value="${escapeHtml(ingredient.unit)}" />
      <button class="ghost" type="button" data-action="remove-ingredient" data-editor="${editorKey}" data-id="${ingredient.id}">Remover</button>
    </div>`;
  }).join('')}
  <div class="ingredient-rows-actions">
    <button type="button" data-action="add-ingredient" data-editor="${editorKey}">Adicionar ingrediente</button>
  </div>`;
}

function validateIngredientAmounts(ingredients) {
  const active = ingredients.filter((i) => i.name.trim());
  if (active.length === 0) {
    return { message: 'Adicione pelo menos um ingrediente da base.', invalidIds: new Set() };
  }
  const invalidIds = new Set(active.filter((i) => toNumberSafe(i.usedAmount) <= 0).map((i) => i.id));
  if (invalidIds.size > 0) {
    return { message: 'Informe a quantidade usada de cada ingrediente selecionado.', invalidIds };
  }
  return null;
}

function tiersTable(pricing) {
  return `<table style="width:100%; border-collapse:collapse;">
    <thead><tr style="text-align:left; color:#8e6a61; font-size:0.82rem;">
      <th style="padding:8px;">Nível</th><th style="padding:8px;">Preço un.</th><th style="padding:8px;">Preço/forma</th><th style="padding:8px;">Lucro líq. un.</th><th style="padding:8px;">Lucro líq. total</th>
    </tr></thead>
    <tbody>
      ${pricing.tiers.map((tier) => `
        <tr style="border-top:1px solid #f0ded6;">
          <td style="padding:10px 8px; font-weight:800; color:#8f3f37;">${escapeHtml(tier.name)}</td>
          <td style="padding:10px 8px; font-weight:800;">${formatCurrency(tier.unitPrice)}</td>
          <td style="padding:10px 8px;">${formatCurrency(tier.totalPrice)}</td>
          <td style="padding:10px 8px;">${formatCurrency(tier.netProfitUnit)}</td>
          <td style="padding:10px 8px;">${formatCurrency(tier.netProfitTotal)}</td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

function pricingResultBlock(editor) {
  const pricing = pricingFor(editor);
  return `<aside class="panel summary-panel">
    <p class="eyebrow">Resultado</p><h2>Custo e preços sugeridos</h2>
    <dl>
      <div><dt>Custo dos ingredientes</dt><dd>${formatCurrency(pricing.ingredientsCost)}</dd></div>
      <div><dt>Despesas alocadas</dt><dd>${formatCurrency(pricing.expensesCost)}</dd></div>
      <div><dt>Custo total da receita</dt><dd>${formatCurrency(pricing.totalCost)}</dd></div>
      <div class="highlight"><dt>Custo por unidade</dt><dd>${formatCurrency(pricing.unitCost)}</dd></div>
    </dl>
    <div style="margin-top:18px; overflow-x:auto;">${tiersTable(pricing)}</div>
  </aside>`;
}

function productCardGrid(list) {
  return `<div class="card-grid">${list.map((product) => `
    <div class="item-card" data-action="open-produto" data-id="${product.id}">
      <div class="item-card-top">
        <span class="item-avatar" style="background:${avatarColorFor(product.name)}">${escapeHtml(product.name.trim().charAt(0).toUpperCase() || '?')}</span>
        <strong>${escapeHtml(product.name)}</strong>
      </div>
      <span class="muted">Rendimento: ${product.yield_amount} un.</span>
      <span class="item-card-link">Ver detalhes ${icon('arrow')}</span>
    </div>`).join('')}</div>`;
}

// ---------------- Modal overlay ----------------

function editIngredientModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Editar ingrediente</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="edit-ingredient" class="modal-form">
        <label>Nome<input name="name" value="${escapeHtml(data.name)}" required /></label>
        <div class="field-grid">
          <label>Preço da embalagem (R$)<input name="packagePrice" inputmode="decimal" value="${escapeHtml(data.packagePrice)}" required /></label>
          <label>Qtd. da embalagem<input name="packageAmount" inputmode="decimal" value="${escapeHtml(data.packageAmount)}" required /></label>
        </div>
        <div class="field-grid">
          <label>Unidade<input name="unit" value="${escapeHtml(data.unit)}" required /></label>
          <label>Categoria<input name="category" value="${escapeHtml(data.category)}" /></label>
        </div>
        <label>Marca<input name="brand" value="${escapeHtml(data.brand)}" /></label>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Salvando...' : 'Salvar alterações'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function editProfileModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Informações pessoais</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="edit-profile" class="modal-form">
        <label>Nome completo<input name="fullName" value="${escapeHtml(data.fullName)}" required /></label>
        <label>E-mail<input name="email" type="email" value="${escapeHtml(data.email)}" required /></label>
        <p class="form-hint">Alterar o e-mail exige confirmação por um link enviado ao novo endereço.</p>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Salvando...' : 'Salvar alterações'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
      <div class="modal-danger-zone">
        <p class="form-hint">Excluir sua conta remove permanentemente seus dados (receitas, ingredientes, histórico) conforme a LGPD. Esta ação não pode ser desfeita.</p>
        <button type="button" class="danger" data-action="open-delete-account">Excluir minha conta</button>
      </div>
    </div>`;
}

function changePasswordModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Trocar senha</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="change-password" class="modal-form">
        <label>Senha atual<input name="currentPassword" type="password" minlength="6" required /></label>
        <label>Nova senha<input name="newPassword" type="password" minlength="6" required /></label>
        <label>Confirmar nova senha<input name="confirmPassword" type="password" minlength="6" required /></label>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Salvando...' : 'Trocar senha'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function deleteAccountModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Excluir minha conta</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <p>Isso vai excluir permanentemente sua conta e todos os seus dados (receitas, ingredientes, despesas, histórico). Não é possível desfazer.</p>
      <p>Digite <strong>EXCLUIR</strong> para confirmar.</p>
      <form data-form="delete-account" class="modal-form">
        <input name="confirmText" placeholder="EXCLUIR" required />
        <div class="save-actions">
          <button type="submit" class="danger" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Excluindo...' : 'Excluir minha conta'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function modalOverlay() {
  if (state.successModal) {
    return `<div class="modal-overlay">
      <div class="modal-box modal-success">
        <div class="success-check">${icon('check')}</div>
        <p>${escapeHtml(state.successModal)}</p>
      </div>
    </div>`;
  }
  if (!state.activeModal) return '';
  const data = state.activeModal;
  const content = {
    'edit-ingredient': editIngredientModal,
    'edit-profile': editProfileModal,
    'change-password': changePasswordModal,
    'delete-account': deleteAccountModal,
  }[data.type];
  if (!content) return '';
  return `<div class="modal-overlay">${content(data)}</div>`;
}

// ---------------- Páginas ----------------

function renderDashboard() {
  const ultimoProduto = state.savedProducts[0];
  const ultimoHistorico = state.history[0];
  const ultimoMedia = ultimoHistorico?.tiers?.find((t) => t.name === 'Média') ?? ultimoHistorico?.tiers?.[0];

  return `
    ${banner('Calculadora de precificação para confeitaria', 'Acompanhe suas receitas, ingredientes e o histórico de preços em um só lugar.')}
    ${statusBox()}
    <div class="highlight-grid">
      <div class="highlight-card">
        <div class="highlight-icon highlight-icon-box">${icon('box')}</div>
        <span class="eyebrow">Receitas cadastradas</span>
        <strong>${state.savedProducts.length}</strong>
        <button type="button" class="ghost" data-action="goto" data-route="produtos">Ver receitas ${icon('arrow')}</button>
      </div>
      <div class="highlight-card">
        <div class="highlight-icon highlight-icon-star">${icon('star')}</div>
        <span class="eyebrow">Última receita cadastrada</span>
        ${ultimoProduto
          ? `<strong class="highlight-name">${escapeHtml(ultimoProduto.name)}</strong>
             <span class="muted">${ultimoMedia ? `Preço médio: ${formatCurrency(ultimoMedia.unitPrice)}` : `Rendimento: ${ultimoProduto.yield_amount} un.`}</span>
             <button type="button" class="ghost" data-action="open-produto" data-id="${ultimoProduto.id}">Abrir receita ${icon('arrow')}</button>`
          : '<strong class="highlight-name">—</strong><span class="muted">Nenhuma receita ainda.</span>'}
      </div>
      <div class="highlight-card highlight-card-cta">
        <div class="highlight-icon highlight-icon-cta">${icon('plus')}</div>
        <span class="eyebrow">Nova receita</span>
        <strong>Monte uma nova ficha</strong>
        <button type="button" data-action="start-wizard">Começar ${icon('arrow')}</button>
      </div>
    </div>
    <div class="panel">
      <div class="section-header"><h2>Receitas cadastradas</h2></div>
      ${state.dataLoading ? loadingMsg() : (state.savedProducts.length ? productCardGrid(state.savedProducts) : emptyState('Nenhuma receita salva ainda.', true))}
    </div>`;
}

function renderProdutosPage() {
  return `
    <div class="section-header">
      <div><p class="eyebrow">Receitas</p><h2>Suas receitas salvas</h2></div>
      <button type="button" data-action="start-wizard">+ Nova receita</button>
    </div>
    ${statusBox()}
    ${state.dataLoading ? loadingMsg() : (state.savedProducts.length ? productCardGrid(state.savedProducts) : `<div class="panel">${emptyState('Você ainda não salvou nenhuma receita.', true)}</div>`)}
  `;
}

function renderProdutoDetalhe(id) {
  if (state.detail.loading || state.detail.productId !== id) return loadingMsg();
  const editor = state.detail;
  return `
    <div class="section-header">
      <div><p class="eyebrow">Receita</p><h2>${escapeHtml(editor.productName || 'Receita')}</h2></div>
      <button type="button" class="ghost" data-action="goto" data-route="produtos">Voltar para receitas</button>
    </div>
    ${statusBox()}
    <div class="panel">${basicFields('detail', editor)}</div>
    <div class="panel">
      <h3>Ingredientes e embalagens usados</h3>
      ${editor.errors.ingredients ? `<p class="form-error">${escapeHtml(editor.errors.ingredients)}</p>` : ''}
      ${ingredientRows('detail', editor.ingredients, editor.errors.invalidIngredientIds || new Set())}
    </div>
    <div class="content-grid">
      <div class="panel cost-panel">
        <h3>Ações</h3>
        <div class="save-actions">
          <button type="button" data-action="save-detail">Salvar alterações</button>
          <button type="button" class="ghost" data-action="save-history-detail">Salvar cálculo no histórico</button>
          <button type="button" class="danger" data-action="delete-detail" data-id="${id}">Excluir receita</button>
        </div>
      </div>
      ${pricingResultBlock(editor)}
    </div>`;
}

function renderWizard() {
  const editor = state.wizard;
  const stepLabels = ['Nome', 'Ingredientes', 'Rendimento', 'Revisão'];
  return `
    <div class="section-header">
      <div><p class="eyebrow">Nova receita</p><h2>Vamos montar sua ficha de precificação</h2></div>
      <button type="button" class="ghost" data-action="goto" data-route="produtos">Cancelar</button>
    </div>
    ${statusBox()}
    <div class="wizard-steps">
      ${stepLabels.map((label, i) => `<div class="wizard-step ${editor.step === i + 1 ? 'active' : ''}">${i + 1}. ${label}</div>`).join('')}
    </div>
    <div class="panel">
      ${editor.step === 1 ? `<div class="field-grid">${fieldFor('wizard', 'productName', 'Nome da receita', editor.productName, 'text', editor.errors.productName)}</div>` : ''}
      ${editor.step === 2 ? `
        <h3>Selecione os ingredientes/embalagens da base e informe a quantidade usada</h3>
        ${editor.errors.ingredients ? `<p class="form-error">${escapeHtml(editor.errors.ingredients)}</p>` : ''}
        ${ingredientRows('wizard', editor.ingredients, editor.errors.invalidIngredientIds || new Set())}` : ''}
      ${editor.step === 3 ? `<div class="field-grid">${fieldFor('wizard', 'yieldAmount', 'Quantas unidades saem dessa receita (Qnt. por forma)', editor.yieldAmount, 'decimal', editor.errors.yieldAmount)}</div>` : ''}
      ${editor.step === 4 ? renderWizardReview(editor) : ''}
    </div>
    <div class="wizard-actions">
      <button type="button" class="ghost" data-action="wizard-back" ${editor.step === 1 ? 'disabled' : ''}>Voltar</button>
      ${editor.step < 4
        ? '<button type="button" data-action="wizard-next">Avançar</button>'
        : '<button type="button" data-action="wizard-save">Salvar receita</button>'}
    </div>`;
}

function renderWizardReview(editor) {
  const pricing = pricingFor(editor);
  return `<div class="wizard-review">
    <h3>${escapeHtml(editor.productName || 'Receita sem nome')}</h3>
    <p class="muted">Rendimento: ${escapeHtml(editor.yieldAmount || '0')} un. · ${editor.ingredients.length} item(ns)</p>
    <dl>
      <div><dt>Custo dos ingredientes</dt><dd>${formatCurrency(pricing.ingredientsCost)}</dd></div>
      <div><dt>Despesas alocadas</dt><dd>${formatCurrency(pricing.expensesCost)}</dd></div>
      <div><dt>Custo total</dt><dd>${formatCurrency(pricing.totalCost)}</dd></div>
      <div><dt>Custo por unidade</dt><dd>${formatCurrency(pricing.unitCost)}</dd></div>
    </dl>
    <div style="margin-top:16px; overflow-x:auto;">${tiersTable(pricing)}</div>
  </div>`;
}

function renderIngredientesPage() {
  const list = state.savedIngredients.length > 0
    ? `<ul class="saved-list">${state.savedIngredients.map((i) => `
        <li>
          <span>${escapeHtml(i.name)} <small class="muted">(${formatCurrency(i.package_price)} / ${i.package_amount}${escapeHtml(i.unit)}${i.category ? ` · ${escapeHtml(i.category)}` : ''}${i.brand ? ` · ${escapeHtml(i.brand)}` : ''})</small></span>
          <span class="saved-list-actions">
            <button type="button" class="ghost" data-action="open-edit-ingredient" data-id="${i.id}">Editar</button>
            <button type="button" class="ghost" data-action="delete-saved-ingredient" data-id="${i.id}">Excluir</button>
          </span>
        </li>`).join('')}</ul>`
    : emptyState('Nenhum ingrediente cadastrado ainda.', false);

  return `
    <div class="section-header"><div><p class="eyebrow">Base de ingredientes</p><h2>Ingredientes e embalagens</h2></div></div>
    ${statusBox()}
    <div class="panel">
      ${state.dataLoading ? loadingMsg() : list}
      <form data-form="new-ingredient" class="new-ingredient-form" style="grid-template-columns: 1.6fr 1fr 1fr 0.8fr 1fr 1fr auto;">
        <input name="name" placeholder="Nome" required />
        <input name="packagePrice" inputmode="decimal" placeholder="Preço (R$)" required />
        <input name="packageAmount" inputmode="decimal" placeholder="Kg/Gramas" required />
        <input name="unit" placeholder="Un. (g, ml, un)" value="g" required />
        <input name="category" placeholder="Categoria" />
        <input name="brand" placeholder="Marca" />
        <button type="submit">Adicionar</button>
      </form>
    </div>`;
}

function renderDespesasPage() {
  const total = state.expenseCategories.reduce((sum, e) => sum + toNumberSafe(e.monthly_value) * (toNumberSafe(e.percentage) / 100), 0);
  return `
    <div class="section-header"><div><p class="eyebrow">Base de despesas</p><h2>Custos fixos mensais</h2></div></div>
    <p>Cada despesa é alocada por receita usando o percentual informado (ex.: R$250 de energia × 1% = R$2,50 por receita).</p>
    ${statusBox()}
    <div class="panel">
      <div class="ingredient-grid header-row" aria-hidden="true" style="grid-template-columns: 1.4fr 1fr 1fr 1fr 80px;"><span>Despesa</span><span>Valor mensal (R$)</span><span>% por receita</span><span>Alocado</span><span></span></div>
      ${state.expenseCategories.map((expense) => {
        const allocated = toNumberSafe(expense.monthly_value) * (toNumberSafe(expense.percentage) / 100);
        return `<div class="ingredient-grid" style="grid-template-columns: 1.4fr 1fr 1fr 1fr 80px;" data-expense-id="${expense.id}">
          <input aria-label="Despesa" data-expense-id="${expense.id}" data-expense-field="name" value="${escapeHtml(expense.name)}" />
          <input aria-label="Valor mensal" inputmode="decimal" placeholder="R$ 0,00" data-expense-id="${expense.id}" data-expense-field="monthly_value" value="${toNumberSafe(expense.monthly_value) ? escapeHtml(expense.monthly_value) : ''}" />
          <input aria-label="Percentual" inputmode="decimal" data-expense-id="${expense.id}" data-expense-field="percentage" value="${escapeHtml(expense.percentage)}" />
          <span class="muted" style="align-self:center;">${formatCurrency(allocated)}</span>
          <button type="button" class="ghost" data-action="delete-expense" data-id="${expense.id}">Excluir</button>
        </div>`;
      }).join('')}
      <div class="save-actions">
        <button type="button" data-action="add-expense">Adicionar despesa</button>
        <button type="button" data-action="save-expenses">Salvar despesas</button>
      </div>
      <p class="status-message" style="margin-top:16px;">Total alocado por receita: <strong>${formatCurrency(total)}</strong></p>
    </div>`;
}

function percentFromMultiplier(multiplier) {
  const percent = toNumberSafe(multiplier) * 100;
  return Number.isInteger(percent) ? String(percent) : String(Math.round(percent * 100) / 100);
}

function renderLucroPage() {
  return `
    <div class="section-header"><div><p class="eyebrow">Base de lucro</p><h2>Níveis de margem</h2></div></div>
    <p>Cada nível multiplica o custo por unidade para sugerir o preço de venda (ex.: margem de 250% = custo × 2,5 no nível Mínimo).</p>
    ${statusBox()}
    <div class="panel">
      <div class="ingredient-grid header-row" aria-hidden="true" style="grid-template-columns: 1fr 1fr;"><span>Nível</span><span>Margem (%)</span></div>
      ${state.profitTiers.map((tier) => `
        <div class="ingredient-grid" style="grid-template-columns: 1fr 1fr;" data-tier-id="${tier.id}">
          <input aria-label="Nome do nível" data-tier-id="${tier.id}" data-tier-field="name" value="${escapeHtml(tier.name)}" />
          <div class="input-suffix">
            <input aria-label="Margem em porcentagem" inputmode="decimal" data-tier-id="${tier.id}" data-tier-field="multiplierPercent" value="${escapeHtml(percentFromMultiplier(tier.multiplier))}" />
            <span class="suffix">%</span>
          </div>
        </div>`).join('')}
      <div class="save-actions"><button type="button" data-action="save-tiers">Salvar níveis de lucro</button></div>
    </div>`;
}

function renderFornecedoresPage() {
  const list = state.suppliers.length > 0
    ? `<ul class="saved-list">${state.suppliers.map((s) => `
        <li>
          <span>${escapeHtml(s.name)} <small class="muted">${escapeHtml(s.phone || '')}${s.contact_name ? ` · ${escapeHtml(s.contact_name)}` : ''}${s.email ? ` · ${escapeHtml(s.email)}` : ''}</small></span>
          <span class="saved-list-actions"><button type="button" class="ghost" data-action="delete-supplier" data-id="${s.id}">Excluir</button></span>
        </li>`).join('')}</ul>`
    : emptyState('Nenhum fornecedor cadastrado ainda.', false);

  return `
    <div class="section-header"><div><p class="eyebrow">Base de fornecedores</p><h2>Contatos</h2></div></div>
    ${statusBox()}
    <div class="panel">
      ${state.dataLoading ? loadingMsg() : list}
      <form data-form="new-supplier" class="new-ingredient-form" style="grid-template-columns: 1.4fr 1fr 1fr 1fr 1fr 1fr auto;">
        <input name="name" placeholder="Nome" required />
        <input name="phone" placeholder="Telefone" />
        <input name="address" placeholder="Endereço" />
        <input name="site" placeholder="Site" />
        <input name="contact_name" placeholder="Contato" />
        <input name="email" type="email" placeholder="E-mail" />
        <button type="submit">Adicionar</button>
      </form>
    </div>`;
}

function renderHistoricoPage() {
  if (!state.history.length) return `<div class="panel">${emptyState('Nenhum cálculo salvo ainda.', false)}</div>`;
  return `<div class="panel">${state.history.map((h) => `
      <div style="padding:14px 0; border-bottom:1px solid #f0ded6;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong>${escapeHtml(h.product_name)}</strong>
          <small class="muted">${new Date(h.created_at).toLocaleString('pt-BR')}</small>
        </div>
        <div style="display:flex; gap:18px; flex-wrap:wrap;">
          ${(h.tiers || []).map((t) => `<span class="muted">${escapeHtml(t.name)}: <strong style="color:#8f3f37;">${formatCurrency(t.unitPrice)}</strong></span>`).join('')}
        </div>
      </div>`).join('')}</div>`;
}

function renderAdminUsersList() {
  if (!state.admin.users.length) return emptyState('Nenhum usuário encontrado.', false);
  return `<ul class="saved-list">${state.admin.users.map((u) => {
    const banned = u.bannedUntil && new Date(u.bannedUntil) > new Date();
    return `
    <li>
      <span>${escapeHtml(u.fullName || u.email)} <small class="muted">${escapeHtml(u.email)}${u.role === 'admin' ? ' · admin' : ''}${banned ? ' · suspenso' : ''}</small></span>
      <span class="saved-list-actions">
        ${banned
          ? `<button type="button" class="ghost" data-action="admin-reactivate" data-id="${u.id}">Reativar</button>`
          : `<button type="button" class="ghost" data-action="admin-suspend" data-id="${u.id}">Suspender</button>`}
        ${u.role === 'admin' ? '' : `<button type="button" class="danger" data-action="admin-delete" data-id="${u.id}">Excluir</button>`}
      </span>
    </li>`;
  }).join('')}</ul>`;
}

function renderAdminPage() {
  if (state.profile.role !== 'admin') {
    return `<div class="panel">${emptyState('Acesso restrito a administradores.', false)}</div>`;
  }
  return `
    <div class="section-header"><div><p class="eyebrow">Super admin</p><h2>Usuários cadastrados</h2></div></div>
    <p>Suspender bloqueia o acesso sem apagar dados. Excluir remove permanentemente a conta e todos os dados do usuário (LGPD).</p>
    ${statusBox()}
    <div class="panel">
      ${state.admin.loading ? loadingMsg() : state.admin.error ? `<p class="auth-error">${escapeHtml(state.admin.error)}</p>` : renderAdminUsersList()}
    </div>`;
}

function renderPage() {
  switch (state.route.path) {
    case 'produtos': return renderProdutosPage();
    case 'produto': return renderProdutoDetalhe(state.route.param);
    case 'novo-produto': return renderWizard();
    case 'ingredientes': return renderIngredientesPage();
    case 'despesas': return renderDespesasPage();
    case 'lucro': return renderLucroPage();
    case 'fornecedores': return renderFornecedoresPage();
    case 'historico': return renderHistoricoPage();
    case 'admin': return renderAdminPage();
    default: return renderDashboard();
  }
}

// ---------------- Shell / autenticação ----------------

function navItem(route, label) {
  const active = state.route.path === route;
  return `<li><button type="button" class="nav-link ${active ? 'active' : ''}" data-action="goto" data-route="${route}">${label}</button></li>`;
}

function shellHtml() {
  const displayName = state.profile.fullName || nameFromEmail(state.session.user.email);
  return `
    <div class="shell">
      <header class="navbar">
        <div class="navbar-inner">
          <button type="button" class="brand" data-action="goto" data-route="inicio">
            <span class="brand-mark"></span> Delícias da Tai
          </button>
          <ul class="nav-list">
            ${navItem('produtos', 'Receitas')}
            ${navItem('ingredientes', 'Ingredientes')}
            ${navItem('despesas', 'Despesas')}
            ${navItem('lucro', 'Lucro')}
            ${navItem('fornecedores', 'Fornecedores')}
            ${navItem('historico', 'Histórico')}
            ${state.profile.role === 'admin' ? navItem('admin', 'Admin') : ''}
          </ul>
          <div class="navbar-user">
            <div class="profile-menu">
              <button type="button" class="profile-trigger" data-action="toggle-profile-menu">
                <span class="navbar-email">${escapeHtml(displayName)}</span>${icon('chevronDown')}
              </button>
              ${state.profileMenuOpen ? `
                <div class="profile-dropdown">
                  <button type="button" class="profile-dropdown-item" data-action="open-edit-profile">${icon('pencil')}Atualizar informações pessoais</button>
                  <button type="button" class="profile-dropdown-item" data-action="open-change-password">${icon('key')}Trocar senha</button>
                </div>` : ''}
            </div>
            <button type="button" class="ghost icon-btn" data-action="logout" title="Sair">${icon('logout')}</button>
          </div>
        </div>
      </header>
      <div class="main-area">
        <div class="page">${renderPage()}</div>
      </div>
    </div>
    ${modalOverlay()}`;
}

function authHtml() {
  const isSignUp = state.authMode === 'signup';
  return `
    <div class="auth-page">
      <div class="auth-form-side">
        <div class="auth-brand"><span class="brand-mark"></span> Delícias da Tai</div>
        <div class="auth-form-inner">
          <p class="eyebrow">${isSignUp ? 'Comece agora' : 'Bem-vinda de volta'}</p>
          <h1 class="auth-title">${isSignUp ? 'Crie sua conta' : 'Entre na sua conta'}</h1>
          <p class="auth-subtitle">Calcule o preço ideal dos seus doces com base no custo real de ingredientes e despesas.</p>
          <form data-form="auth">
            ${isSignUp ? '<label>Nome<input name="fullName" type="text" required /></label>' : ''}
            <label>E-mail<input name="email" type="email" required /></label>
            <label>Senha<input name="password" type="password" minlength="6" required /></label>
            ${isSignUp ? `
              <label class="consent-field">
                <input name="consent" type="checkbox" required />
                <span>Concordo com o tratamento dos meus dados pessoais para uso do app, conforme a LGPD.</span>
              </label>` : ''}
            ${state.authError ? `<p class="auth-error">${escapeHtml(state.authError)}</p>` : ''}
            <button type="submit" class="auth-submit" ${state.authLoading ? 'disabled' : ''}>
              <span>${state.authLoading ? 'Aguarde...' : isSignUp ? 'Criar conta' : 'Entrar'}</span>${icon('arrow')}
            </button>
          </form>
          <p class="auth-switch">
            ${isSignUp ? 'Já tem conta?' : 'Não tem conta?'}
            <button type="button" data-action="auth-tab" data-mode="${isSignUp ? 'signin' : 'signup'}">${isSignUp ? 'Entrar' : 'Criar conta'}</button>
          </p>
        </div>
      </div>
      <div class="auth-visual">
        <img src="/assets/bg-login.webp" alt="" class="auth-visual-photo" />
        <div class="auth-visual-overlay"></div>
        <blockquote class="auth-quote">
          <p>&ldquo;Preço certo é doce garantido: cada receita com a margem que ela merece.&rdquo;</p>
        </blockquote>
      </div>
    </div>`;
}

function render() {
  const restore = captureFocus();
  app.innerHTML = state.session ? shellHtml() : authHtml();
  restoreFocus(restore);
}

// ---------------- Ações: autenticação ----------------

async function handleAuthSubmit(form) {
  const formData = new FormData(form);
  const email = formData.get('email');
  const password = formData.get('password');
  const fullName = formData.get('fullName');

  state.authLoading = true;
  state.authError = '';
  render();

  try {
    if (state.authMode === 'signup') {
      await signUp(email, password, fullName);
      state.authError = 'Conta criada! Verifique seu e-mail para confirmar o acesso, se necessário.';
    } else {
      await signIn(email, password);
    }
  } catch (error) {
    state.authError = error.message;
  } finally {
    state.authLoading = false;
    render();
  }
}

// ---------------- Ações: wizard ----------------

function wizardNext() {
  const ed = state.wizard;
  ed.errors = {};
  if (ed.step === 1 && !ed.productName.trim()) {
    ed.errors.productName = 'Dê um nome à receita antes de continuar.';
    render();
    return;
  }
  if (ed.step === 2) {
    const error = validateIngredientAmounts(ed.ingredients);
    if (error) {
      ed.errors.ingredients = error.message;
      ed.errors.invalidIngredientIds = error.invalidIds;
      render();
      return;
    }
  }
  if (ed.step === 3 && toNumberSafe(ed.yieldAmount) <= 0) {
    ed.errors.yieldAmount = 'Informe quantas unidades saem dessa receita.';
    render();
    return;
  }
  ed.step = Math.min(4, ed.step + 1);
  render();
}

async function handleWizardSave() {
  const ed = state.wizard;
  ed.errors = {};
  const validationError = validateIngredientAmounts(ed.ingredients);
  if (validationError) {
    ed.errors.ingredients = validationError.message;
    ed.errors.invalidIngredientIds = validationError.invalidIds;
    ed.step = 2;
    render();
    return;
  }
  try {
    const saved = await db.saveProduct(
      state.session.user.id,
      null,
      {
        name: ed.productName || 'Receita sem nome',
        yield_amount: Math.max(1, Math.floor(toNumberSafe(ed.yieldAmount) || 1)),
      },
      ed.ingredients,
    );
    await loadUserData();
    showSuccess('Receita criada com sucesso!');
    navigate(`#/produto/${saved.id}`);
    ensureDetailLoaded(saved.id);
  } catch (error) {
    state.statusMessage = `Erro ao salvar: ${error.message}`;
    render();
  }
}

// ---------------- Ações: produto (página de detalhe) ----------------

async function handleSaveDetail() {
  const ed = state.detail;
  ed.errors = {};
  const validationError = validateIngredientAmounts(ed.ingredients);
  if (validationError) {
    ed.errors.ingredients = validationError.message;
    ed.errors.invalidIngredientIds = validationError.invalidIds;
    render();
    return;
  }
  try {
    await db.saveProduct(
      state.session.user.id,
      ed.productId,
      {
        name: ed.productName || 'Receita sem nome',
        yield_amount: Math.max(1, Math.floor(toNumberSafe(ed.yieldAmount) || 1)),
      },
      ed.ingredients,
    );
    showSuccess('Alterações salvas.');
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro ao salvar: ${error.message}`;
    render();
  }
}

async function handleDeleteDetail(id) {
  try {
    await db.deleteProduct(id);
    await loadUserData();
    navigate('#/produtos');
  } catch (error) {
    state.statusMessage = `Erro ao excluir: ${error.message}`;
    render();
  }
}

async function handleSaveHistoryFromDetail() {
  const ed = state.detail;
  try {
    const pricing = pricingFor(ed);
    await db.saveHistoryEntry(state.session.user.id, {
      productId: ed.productId,
      productName: ed.productName || 'Receita sem nome',
      ...pricing,
    });
    showSuccess('Cálculo salvo no histórico.');
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro ao salvar histórico: ${error.message}`;
    render();
  }
}

// ---------------- Ações: ingredientes / despesas / lucro / fornecedores ----------------

async function handleNewSavedIngredient(form) {
  const formData = new FormData(form);
  const draft = {
    name: formData.get('name'),
    packagePrice: toNumberSafe(formData.get('packagePrice')),
    packageAmount: toNumberSafe(formData.get('packageAmount')),
    unit: formData.get('unit'),
    category: formData.get('category') || '',
    brand: formData.get('brand') || '',
  };
  try {
    await db.createIngredient(state.session.user.id, draft);
    await loadUserData();
    showSuccess('Ingrediente cadastrado!');
  } catch (error) {
    state.statusMessage = `Erro ao cadastrar ingrediente: ${error.message}`;
    render();
  }
}

async function handleDeleteSavedIngredient(id) {
  try {
    await db.deleteIngredient(id);
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro ao excluir ingrediente: ${error.message}`;
    render();
  }
}

async function handleSaveExpenses() {
  try {
    await Promise.all(state.expenseCategories.map((expense) => db.updateExpenseCategory(expense.id, {
      name: expense.name,
      monthly_value: toNumberSafe(expense.monthly_value),
      percentage: toNumberSafe(expense.percentage),
    })));
    showSuccess('Despesas salvas.');
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro ao salvar despesas: ${error.message}`;
    render();
  }
}

async function handleAddExpense() {
  try {
    await db.createExpenseCategory(state.session.user.id, {
      name: 'Nova despesa', monthly_value: 0, percentage: 1, position: state.expenseCategories.length,
    });
    await loadUserData();
    showSuccess('Despesa adicionada!');
  } catch (error) {
    state.statusMessage = `Erro: ${error.message}`;
    render();
  }
}

async function handleDeleteExpense(id) {
  try {
    await db.deleteExpenseCategory(id);
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro: ${error.message}`;
    render();
  }
}

async function handleSaveTiers() {
  try {
    await Promise.all(state.profitTiers.map((tier) => db.updateProfitTier(tier.id, {
      name: tier.name,
      multiplier: toNumberSafe(tier.multiplier),
    })));
    showSuccess('Níveis de lucro salvos.');
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro ao salvar níveis de lucro: ${error.message}`;
    render();
  }
}

async function handleNewSupplier(form) {
  const formData = new FormData(form);
  const draft = {
    name: formData.get('name'),
    phone: formData.get('phone') || '',
    address: formData.get('address') || '',
    site: formData.get('site') || '',
    contact_name: formData.get('contact_name') || '',
    email: formData.get('email') || '',
  };
  try {
    await db.createSupplier(state.session.user.id, draft);
    await loadUserData();
    showSuccess('Fornecedor cadastrado!');
  } catch (error) {
    state.statusMessage = `Erro ao cadastrar fornecedor: ${error.message}`;
    render();
  }
}

// ---------------- Ações: modais (ingrediente / perfil / senha / conta) ----------------

function openEditIngredientModal(id) {
  const source = state.savedIngredients.find((i) => i.id === id);
  if (!source) return;
  openModal('edit-ingredient', {
    ingredientId: source.id,
    name: source.name,
    packagePrice: String(source.package_price),
    packageAmount: String(source.package_amount),
    unit: source.unit,
    category: source.category || '',
    brand: source.brand || '',
  });
}

async function handleEditIngredientSubmit(form) {
  const formData = new FormData(form);
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.updateIngredient(state.activeModal.ingredientId, {
      name: formData.get('name'),
      packagePrice: toNumberSafe(formData.get('packagePrice')),
      packageAmount: toNumberSafe(formData.get('packageAmount')),
      unit: formData.get('unit'),
      category: formData.get('category') || '',
      brand: formData.get('brand') || '',
    });
    await loadUserData();
    closeModal();
    showSuccess('Ingrediente atualizado com sucesso!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

function openEditProfileModal() {
  openModal('edit-profile', { fullName: state.profile.fullName, email: state.session.user.email });
}

async function handleEditProfileSubmit(form) {
  const formData = new FormData(form);
  const fullName = formData.get('fullName');
  const email = formData.get('email');
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.updateProfile(state.session.user.id, { full_name: fullName });
    if (email !== state.session.user.email) {
      await updateEmail(email);
    }
    state.profile.fullName = fullName;
    closeModal();
    showSuccess(email !== state.session.user.email
      ? 'Dados salvos! Confirme o novo e-mail pelo link que enviamos.'
      : 'Dados pessoais atualizados!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

async function handleChangePasswordSubmit(form) {
  const formData = new FormData(form);
  const currentPassword = formData.get('currentPassword');
  const newPassword = formData.get('newPassword');
  const confirmPassword = formData.get('confirmPassword');
  if (newPassword !== confirmPassword) {
    state.activeModal.error = 'A confirmação não bate com a nova senha.';
    render();
    return;
  }
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await changePassword(state.session.user.email, currentPassword, newPassword);
    closeModal();
    showSuccess('Senha alterada com sucesso!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

function openDeleteAccountModal() {
  openModal('delete-account');
}

async function handleDeleteAccountSubmit(form) {
  const formData = new FormData(form);
  if (formData.get('confirmText') !== 'EXCLUIR') {
    state.activeModal.error = 'Digite EXCLUIR para confirmar.';
    render();
    return;
  }
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.deleteOwnAccount();
    state.activeModal = null;
    await signOut();
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

async function handleDeleteSupplier(id) {
  try {
    await db.deleteSupplier(id);
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro ao excluir fornecedor: ${error.message}`;
    render();
  }
}

// ---------------- Listeners globais ----------------

app.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.ingredientField) {
    const ed = getEditor(target.dataset.editor);
    const rowId = target.closest('[data-ingredient]').dataset.ingredient;
    const field = target.dataset.ingredientField;
    ed.ingredients = ed.ingredients.map((i) => {
      if (i.id !== rowId) return i;
      const updated = { ...i, [field]: target.value };
      if (field === 'name') {
        const match = state.savedIngredients.find((si) => si.name.trim().toLowerCase() === target.value.trim().toLowerCase());
        updated.ingredientId = match ? match.id : null;
        if (match) {
          updated.packagePrice = String(match.package_price);
          updated.packageAmount = String(match.package_amount);
          updated.unit = match.unit;
        }
      }
      return updated;
    });
    if (field === 'name') state.openCombobox = rowId;
    render();
    return;
  }
  if (target.dataset.field) {
    getEditor(target.dataset.editor)[target.dataset.field] = target.value;
    render();
    return;
  }
  if (target.dataset.expenseField) {
    state.expenseCategories = state.expenseCategories.map((e) => (e.id === target.dataset.expenseId ? { ...e, [target.dataset.expenseField]: target.value } : e));
    render();
    return;
  }
  if (target.dataset.tierField === 'multiplierPercent') {
    const decimal = toNumberSafe(target.value) / 100;
    state.profitTiers = state.profitTiers.map((t) => (t.id === target.dataset.tierId ? { ...t, multiplier: decimal } : t));
    render();
    return;
  }
  if (target.dataset.tierField) {
    state.profitTiers = state.profitTiers.map((t) => (t.id === target.dataset.tierId ? { ...t, [target.dataset.tierField]: target.value } : t));
    render();
  }
});

// Ao sair do campo "quantidade usada", trava no máximo comprado (blur não
// dispara a cada tecla, então não atrapalha a digitação).
app.addEventListener('blur', (event) => {
  const target = event.target;
  if (!target.dataset || target.dataset.ingredientField !== 'usedAmount') return;
  const ed = getEditor(target.dataset.editor);
  const rowId = target.closest('[data-ingredient]')?.dataset.ingredient;
  const row = ed.ingredients.find((i) => i.id === rowId);
  if (!row) return;
  const max = maxUsedAmount(row);
  if (max && toNumberSafe(row.usedAmount) > max) {
    ed.ingredients = ed.ingredients.map((i) => (i.id === rowId ? { ...i, usedAmount: String(max) } : i));
    render();
  }
}, true);

// Abre o combobox de ingrediente ao focar no campo de nome.
app.addEventListener('focus', (event) => {
  const target = event.target;
  if (!target.dataset || target.dataset.ingredientField !== 'name') return;
  const rowId = target.closest('[data-ingredient]')?.dataset.ingredient;
  if (rowId && state.openCombobox !== rowId) {
    state.openCombobox = rowId;
    render();
  }
}, true);

app.addEventListener('submit', (event) => {
  event.preventDefault();
  const formType = event.target.dataset.form;
  if (formType === 'auth') handleAuthSubmit(event.target);
  if (formType === 'new-ingredient') {
    handleNewSavedIngredient(event.target);
    event.target.reset();
  }
  if (formType === 'new-supplier') {
    handleNewSupplier(event.target);
    event.target.reset();
  }
  if (formType === 'edit-ingredient') handleEditIngredientSubmit(event.target);
  if (formType === 'edit-profile') handleEditProfileSubmit(event.target);
  if (formType === 'change-password') handleChangePasswordSubmit(event.target);
  if (formType === 'delete-account') handleDeleteAccountSubmit(event.target);
});

app.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const editorKey = el.dataset.editor;
  const id = el.dataset.id;

  switch (action) {
    case 'goto':
      navigate(`#/${el.dataset.route}`);
      break;
    case 'open-produto':
      navigate(`#/produto/${id}`);
      break;
    case 'start-wizard':
      startWizard();
      navigate('#/novo-produto');
      render();
      break;
    case 'logout':
      signOut();
      break;
    case 'auth-tab':
      state.authMode = el.dataset.mode;
      state.authError = '';
      render();
      break;
    case 'add-ingredient':
      getEditor(editorKey).ingredients.push(newIngredient());
      render();
      break;
    case 'remove-ingredient': {
      const ed = getEditor(editorKey);
      ed.ingredients = ed.ingredients.filter((i) => i.id !== id);
      render();
      break;
    }
    case 'wizard-next':
      wizardNext();
      break;
    case 'wizard-back':
      state.wizard.step = Math.max(1, state.wizard.step - 1);
      render();
      break;
    case 'wizard-save':
      handleWizardSave();
      break;
    case 'save-detail':
      handleSaveDetail();
      break;
    case 'delete-detail':
      handleDeleteDetail(id);
      break;
    case 'save-history-detail':
      handleSaveHistoryFromDetail();
      break;
    case 'delete-saved-ingredient':
      handleDeleteSavedIngredient(id);
      break;
    case 'save-expenses':
      handleSaveExpenses();
      break;
    case 'add-expense':
      handleAddExpense();
      break;
    case 'delete-expense':
      handleDeleteExpense(id);
      break;
    case 'save-tiers':
      handleSaveTiers();
      break;
    case 'delete-supplier':
      handleDeleteSupplier(id);
      break;
    case 'open-edit-ingredient':
      openEditIngredientModal(id);
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'toggle-profile-menu':
      state.profileMenuOpen = !state.profileMenuOpen;
      render();
      break;
    case 'open-edit-profile':
      state.profileMenuOpen = false;
      openEditProfileModal();
      break;
    case 'open-change-password':
      state.profileMenuOpen = false;
      openModal('change-password');
      break;
    case 'open-delete-account':
      openDeleteAccountModal();
      break;
    case 'admin-suspend':
      handleAdminAction('suspend', id);
      break;
    case 'admin-reactivate':
      handleAdminAction('reactivate', id);
      break;
    case 'admin-delete':
      handleAdminAction('delete', id);
      break;
    case 'select-ingredient-option': {
      const source = state.savedIngredients.find((si) => si.id === el.dataset.ingredientId);
      if (!source) break;
      const ed = getEditor(editorKey);
      const rowId = el.dataset.rowId;
      ed.ingredients = ed.ingredients.map((i) => (i.id === rowId ? {
        ...i,
        ingredientId: source.id,
        name: source.name,
        packagePrice: String(source.package_price),
        packageAmount: String(source.package_amount),
        unit: source.unit,
      } : i));
      state.openCombobox = null;
      render();
      break;
    }
    default:
      break;
  }
});

// Fecha o menu de perfil e o combobox de ingrediente ao clicar fora deles,
// e fecha o modal ao clicar no fundo.
app.addEventListener('click', (event) => {
  if (state.profileMenuOpen && !event.target.closest('.profile-menu')) {
    state.profileMenuOpen = false;
    render();
  }
  if (state.openCombobox && !event.target.closest('.combobox')) {
    state.openCombobox = null;
    render();
  }
  if (event.target.classList.contains('modal-overlay')) {
    closeModal();
  }
});

render();
