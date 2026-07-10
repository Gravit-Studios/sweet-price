import { calculatePricing, formatCurrency } from './pricing.js';
import { signUp, signIn, signOut, getSession, onAuthStateChange, changePassword, updateEmail } from './auth.js';
import { parseRoute, navigate, onRouteChange } from './router.js';
import { compressImageToWebp } from './imageCompression.js';
import { lookupCep } from './cep.js';
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
    unit: '',
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
    ingredients: [],
    photoFile: null,
    photoPreviewUrl: '',
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
    photoUrl: '',
    photoFile: null,
    photoPreviewUrl: '',
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
  selectedProducts: new Set(),
  expenseCategories: [],
  profitTiers: [],
  suppliers: [],
  dataLoading: false,
  statusMessage: '',
  expensesSnapshot: '[]',
  tiersSnapshot: '[]',
  detailSnapshot: '{}',
  settingsSnapshot: '{}',
  companySnapshot: '{}',
  pendingAction: null,
  ingredientSearch: '',
  supplierSearch: '',
  ingredientColumnFilters: {},
  openIngredientFilterColumn: null,

  profile: { fullName: '', role: 'user' },
  settings: { fullName: '', email: '' },
  company: {
    name: '', cnpj: '',
    cep: '', street: '', neighborhood: '', city: '', state: '', number: '', complement: '',
    ifoodUrl: '', link99Url: '', keetaUrl: '',
  },
  cepLookup: { loading: false, error: '' },
  profileMenuOpen: false,
  mobileMenuOpen: false,
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
  // Cada tecla digitada recria esse elemento do zero (innerHTML novo) e o
  // refoca aqui. Sem isso, a transição de border-color/box-shadow do :focus
  // (ver _forms.scss) tocava de novo a cada letra, dando a impressão de tela
  // piscando. Só suprimimos a transição neste refoco programático — o foco
  // "de verdade" (clique, tab) continua com a transição suave.
  el.classList.add('no-transition');
  el.focus();
  if (typeof restore.selStart === 'number' && el.setSelectionRange) {
    try { el.setSelectionRange(restore.selStart, restore.selEnd); } catch { /* ignore */ }
  }
  requestAnimationFrame(() => el.classList.remove('no-transition'));
}

// ---------------- Dados do usuário ----------------

async function loadUserData() {
  if (!state.session) return;
  state.dataLoading = true;
  render();
  try {
    const userId = state.session.user.id;
    const [ingredients, products, expenseCategories, profitTiers, suppliers, profile] = await Promise.all([
      db.listIngredients(userId),
      db.listProducts(userId),
      db.ensureDefaultExpenseCategories(userId),
      db.ensureDefaultProfitTiers(userId),
      db.listSuppliers(userId),
      db.getProfile(userId),
    ]);
    state.savedIngredients = ingredients;
    state.savedProducts = products;
    state.expenseCategories = expenseCategories;
    state.profitTiers = profitTiers;
    state.suppliers = suppliers;
    state.profile = { fullName: profile.full_name || '', role: profile.role || 'user' };
    state.settings = { fullName: state.profile.fullName, email: state.session.user.email };
    state.company = {
      name: profile.company_name || '',
      cnpj: profile.cnpj || '',
      cep: profile.cep || '',
      street: profile.street || '',
      neighborhood: profile.neighborhood || '',
      city: profile.city || '',
      state: profile.state || '',
      number: profile.address_number || '',
      complement: profile.complement || '',
      ifoodUrl: profile.ifood_url || '',
      link99Url: profile.link_99_url || '',
      keetaUrl: profile.keeta_url || '',
    };
    state.expensesSnapshot = JSON.stringify(expenseCategories);
    state.tiersSnapshot = JSON.stringify(profitTiers);
    state.settingsSnapshot = JSON.stringify(state.settings);
    state.companySnapshot = JSON.stringify(state.company);
    if (state.profile.role === 'admin' && !state.admin.loading && state.admin.users.length === 0) {
      loadAdminUsers();
    }
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
      ingredients: items.map((item) => newIngredient({
        ingredientId: item.ingredient_id,
        name: item.name,
        packagePrice: String(item.package_price),
        packageAmount: String(item.package_amount),
        usedAmount: String(item.used_amount),
        unit: item.unit,
      })),
      photoUrl: product.photo_url || '',
      photoFile: null,
      photoPreviewUrl: '',
      errors: {},
    };
    state.detailSnapshot = detailSnapshotOf(state.detail);
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
  state.mobileMenuOpen = false;
  if (route.path === 'produto' && route.param && state.detail.productId !== route.param) {
    ensureDetailLoaded(route.param);
    return;
  }
  if (state.profile.role === 'admin' && !state.admin.loading && state.admin.users.length === 0) {
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

// Suspender/excluir já passam por um modal de confirmação antes de chegar
// aqui (ver openConfirmAdminSuspend/openConfirmAdminDelete); reativar é uma
// ação reversível e de baixo risco, não precisa de confirmação.
async function handleAdminAction(action, userId) {
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
    state.selectedProducts = new Set();
    state.expenseCategories = [];
    state.profitTiers = [];
    state.suppliers = [];
    state.ingredientSearch = '';
    state.supplierSearch = '';
    state.ingredientColumnFilters = {};
    state.openIngredientFilterColumn = null;
    state.profile = { fullName: '', role: 'user' };
    state.settings = { fullName: '', email: '' };
    state.settingsSnapshot = '{}';
    state.company = {
      name: '', cnpj: '',
      cep: '', street: '', neighborhood: '', city: '', state: '', number: '', complement: '',
      ifoodUrl: '', link99Url: '', keetaUrl: '',
    };
    state.companySnapshot = '{}';
    state.cepLookup = { loading: false, error: '' };
    state.profileMenuOpen = false;
    state.mobileMenuOpen = false;
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

// Cada re-render (a cada tecla digitada, por exemplo) recria o DOM do modal
// do zero, o que replicaria a animação de entrada (fade/pop) a cada
// keystroke e dava a impressão de tela "piscando". Essa flag marca se o
// modal atualmente aberto já tocou a animação uma vez, para as próximas
// renderizações do mesmo modal pularem a animação.
let modalHasAnimatedIn = false;

function openModal(type, data = {}) {
  state.activeModal = { type, error: '', loading: false, ...data };
  modalHasAnimatedIn = false;
  render();
}

function closeModal() {
  // Fechar o modal de "adicionar ingrediente à receita" sem confirmar descarta
  // a linha rascunho que ainda não foi inserida na tabela.
  if (state.activeModal?.type === 'add-recipe-ingredient') {
    const { editorKey, rowId } = state.activeModal;
    const ed = getEditor(editorKey);
    ed.ingredients = ed.ingredients.filter((i) => !(i.id === rowId && i.draft));
  }
  state.activeModal = null;
  state.pendingAction = null;
  render();
}

// Compara o editor de detalhe da receita com o snapshot carregado do banco
// para saber se há alterações não salvas (mesma ideia de despesas/lucro).
function detailSnapshotOf(editor) {
  return JSON.stringify({
    productName: editor.productName,
    yieldAmount: editor.yieldAmount,
    ingredients: editor.ingredients,
    photoChanged: Boolean(editor.photoFile),
  });
}

// Só as páginas com um "Salvar alterações" persistente entram na checagem:
// despesas, lucro e edição de receita.
function hasUnsavedChanges() {
  if (state.route.path === 'despesas') return JSON.stringify(state.expenseCategories) !== state.expensesSnapshot;
  if (state.route.path === 'lucro') return JSON.stringify(state.profitTiers) !== state.tiersSnapshot;
  if (state.route.path === 'produto') return detailSnapshotOf(state.detail) !== state.detailSnapshot;
  if (state.route.path === 'configuracoes') return JSON.stringify(state.settings) !== state.settingsSnapshot;
  if (state.route.path === 'empresa') return JSON.stringify(state.company) !== state.companySnapshot;
  return false;
}

// Envolve qualquer ação que tire o usuário da página atual (navegar, sair):
// se há alterações não salvas, pede confirmação antes de executar.
function requestNavigation(run) {
  if (hasUnsavedChanges()) {
    state.pendingAction = run;
    openModal('confirm-leave');
    return;
  }
  run();
}

function handleConfirmLeave() {
  const run = state.pendingAction;
  closeModal();
  if (run) run();
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
  filter: '<path d="M4 5h16M7 12h10M10 19h4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  cupcake: '<path d="M5 11h14l-1.4 8.6A2 2 0 0 1 15.6 21H8.4a2 2 0 0 1-2-1.4L5 11Z"/><path d="M8 11c0-2.8 1.2-4.5 4-4.5S16 8.2 16 11"/><circle cx="12" cy="4.8" r="1.3"/>',
  camera: '<rect x="3" y="7" width="18" height="12.5" rx="2.2"/><path d="M8.5 7l1.3-2.4h4.4L15.5 7"/><circle cx="12" cy="13.2" r="3.4"/>',
  clipboardList: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M8.5 11h7M8.5 15h7M8.5 8h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.5-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3h-6l-.3 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.5L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7.4 7.4 0 0 0 1.7 1L9 21h6l.3-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.5Z"/>',
  whisk: '<path d="M12 2v6"/><path d="M8 8c0 6 1.5 10 4 10s4-4 4-10"/><path d="M9.5 8c0 5 1 9 2.5 9s2.5-4 2.5-9"/><path d="M12 18v4"/>',
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
  return `<div class="banner"><img src="/assets/bg-login.webp" alt="" class="banner-photo" /><div class="banner-overlay"></div><div class="banner-content"><p class="eyebrow">Sweet Price</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></div>`;
}

function statusBox() {
  return state.statusMessage ? `<p class="status-message">${escapeHtml(state.statusMessage)}</p>` : '';
}

function loadingMsg() {
  return `
    <div class="loading-state" role="status" aria-label="Carregando">
      <span class="loading-whisk">${icon('whisk')}</span>
      <span class="muted">Carregando...</span>
    </div>`;
}

function emptyState(message, showCta) {
  return `<div class="empty-state"><p>${escapeHtml(message)}</p>${showCta ? '<button type="button" data-action="start-wizard">Criar receita</button>' : ''}</div>`;
}

// Ação de "adicionar mais uma linha" (ingrediente, despesa...): um link
// discreto com ícone de + em vez de um botão cheio, usado em qualquer lista
// editável do projeto.
function addRowLink(label, action, editorKey = '') {
  return `<button type="button" class="add-row-link" data-action="${action}"${editorKey ? ` data-editor="${editorKey}"` : ''}>${icon('plus')}<span>${label}</span></button>`;
}

// Cabeçalho padrão de página de base (Despesas, Lucro...): botão "Salvar
// alterações" à direita, desabilitado até o formulário ficar "sujo".
function pageHeaderWithSave(eyebrow, title, saveAction, isDirty) {
  return `<div class="section-header">
    <div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2></div>
    <button type="button" data-action="${saveAction}" ${isDirty ? '' : 'disabled'}>Salvar alterações</button>
  </div>`;
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
      <input aria-label="Ingrediente" autocomplete="off" placeholder="Buscar na base..." data-editor="${editorKey}" data-ingredient="${rowId}" data-ingredient-field="name" value="${escapeHtml(ingredient.name)}" />
      ${isOpen && options.length ? `
        <div class="combobox-list">
          ${options.map((si) => `<button type="button" class="combobox-option" data-action="select-ingredient-option" data-editor="${editorKey}" data-row-id="${rowId}" data-ingredient-id="${si.id}">${escapeHtml(si.name)}</button>`).join('')}
        </div>` : ''}
    </div>`;
}

// Mesma linha de ingrediente, em formato de tabela (usado na edição de uma
// receita já salva, onde a lista tende a ser revisada com mais calma).
// Linhas rascunho (ainda sendo preenchidas no modal de adicionar) ficam de
// fora até serem confirmadas.
function ingredientsTable(editorKey, ingredients, invalidIds = new Set()) {
  const visible = ingredients.filter((i) => !i.draft);
  const addLink = addRowLink('Adicionar ingrediente', 'add-ingredient', editorKey);
  if (visible.length === 0) {
    return `${emptyState('Nenhum ingrediente adicionado ainda.', false)}${addLink}`;
  }
  return `
  <table class="data-table data-table-editable">
    <thead><tr><th>Ingrediente</th><th>Preço da compra</th><th>Qtd. comprada</th><th>Qtd. usada</th><th>Un.</th><th></th></tr></thead>
    <tbody>
      ${visible.map((ingredient) => {
        const max = maxUsedAmount(ingredient);
        const usedInvalid = invalidIds.has(ingredient.id);
        return `
        <tr data-ingredient="${ingredient.id}">
          <td>${ingredientNameCell(editorKey, ingredient)}</td>
          <td><div class="input-prefix"><span class="prefix">R$</span><input aria-label="Preço da compra" inputmode="decimal" placeholder="0,00" data-editor="${editorKey}" data-ingredient="${ingredient.id}" data-ingredient-field="packagePrice" value="${escapeHtml(ingredient.packagePrice)}" /></div></td>
          <td><input aria-label="Quantidade comprada" inputmode="decimal" data-editor="${editorKey}" data-ingredient="${ingredient.id}" data-ingredient-field="packageAmount" value="${escapeHtml(ingredient.packageAmount)}" /></td>
          <td><input aria-label="Quantidade usada" inputmode="decimal" required class="${usedInvalid ? 'is-invalid' : ''}" placeholder="${max ? `Máx. ${max}` : 'Obrigatório'}" data-editor="${editorKey}" data-ingredient="${ingredient.id}" data-ingredient-field="usedAmount" value="${escapeHtml(ingredient.usedAmount)}" /></td>
          <td><input aria-label="Unidade" data-editor="${editorKey}" data-ingredient="${ingredient.id}" data-ingredient-field="unit" value="${escapeHtml(ingredient.unit)}" /></td>
          <td class="data-table-actions"><button class="ghost" type="button" data-action="remove-ingredient" data-editor="${editorKey}" data-id="${ingredient.id}">Remover</button></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  ${addLink}`;
}

function validateIngredientAmounts(ingredients) {
  const active = ingredients.filter((i) => i.name.trim() && !i.draft);
  if (active.length === 0) {
    return { message: 'Adicione pelo menos um ingrediente da base.', invalidIds: new Set() };
  }
  const invalidIds = new Set(active.filter((i) => toNumberSafe(i.usedAmount) <= 0).map((i) => i.id));
  if (invalidIds.size > 0) {
    return { message: 'Informe a quantidade usada de cada ingrediente selecionado.', invalidIds };
  }
  return null;
}

// Um bloco por nível de lucro (Mínimo/Média/Máximo), cada um com seus
// valores lado a lado — em vez de uma tabela larga que corta em painéis
// estreitos.
function tiersTable(pricing) {
  return `<div class="tiers-list">
    ${pricing.tiers.map((tier) => `
      <div class="tier-row">
        <strong class="tier-name">${escapeHtml(tier.name)}</strong>
        <div class="tier-stats">
          <div><span>Preço un.</span><strong>${formatCurrency(tier.unitPrice)}</strong></div>
          <div><span>Preço/forma</span><strong>${formatCurrency(tier.totalPrice)}</strong></div>
          <div><span>Lucro líq. un.</span><strong>${formatCurrency(tier.netProfitUnit)}</strong></div>
          <div><span>Lucro líq. total</span><strong>${formatCurrency(tier.netProfitTotal)}</strong></div>
        </div>
      </div>`).join('')}
  </div>`;
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
    <div style="margin-top:18px;">${tiersTable(pricing)}</div>
  </aside>`;
}

// Custo/preço sugerido de uma receita a partir dos itens já trazidos junto
// com a listagem (db.listProducts inclui os ingredientes de cada receita).
function pricingForProduct(product) {
  return calculatePricing({
    ingredients: (product.ingredients || []).map((item) => ({
      packagePrice: item.package_price,
      packageAmount: item.package_amount,
      usedAmount: item.used_amount,
    })),
    expenseCategories: state.expenseCategories,
    profitTiers: state.profitTiers,
    yieldAmount: product.yield_amount,
  });
}

function productsTable(list) {
  const allSelected = list.length > 0 && list.every((p) => state.selectedProducts.has(p.id));
  return `<div class="table-scroll"><table class="data-table data-table-clickable">
    <thead><tr>
      <th class="data-table-checkbox"><input type="checkbox" aria-label="Selecionar todas" data-action="toggle-select-all-products" ${allSelected ? 'checked' : ''} /></th>
      <th>Receita</th><th>Qnt. por forma</th><th>Preço un.</th><th></th>
    </tr></thead>
    <tbody>
      ${list.map((product) => {
        const pricing = pricingForProduct(product);
        const mainTier = pricing.tiers.find((t) => t.name === 'Média') || pricing.tiers[0];
        const priceUn = mainTier ? formatCurrency(mainTier.unitPrice) : formatCurrency(pricing.unitCost);
        const checked = state.selectedProducts.has(product.id);
        return `
        <tr data-action="open-produto" data-id="${product.id}">
          <td class="data-table-checkbox"><input type="checkbox" aria-label="Selecionar receita" data-action="toggle-select-product" data-id="${product.id}" ${checked ? 'checked' : ''} /></td>
          <td>
            <div class="table-row-title">
              ${product.photo_url
                ? `<img class="item-avatar item-avatar-photo" src="${escapeHtml(product.photo_url)}" alt="" />`
                : `<span class="item-avatar" style="background:${avatarColorFor(product.name)}">${escapeHtml(product.name.trim().charAt(0).toUpperCase() || '?')}</span>`}
              <strong>${escapeHtml(product.name)}</strong>
            </div>
          </td>
          <td>${product.yield_amount} un.</td>
          <td>${priceUn}</td>
          <td class="data-table-actions"><span class="item-card-link">Ver detalhes ${icon('arrow')}</span></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

// Upload de foto de receita: usado tanto no wizard quanto no detalhe. O
// arquivo só é enviado ao Supabase Storage na hora de salvar; até lá, a
// prévia é só local (URL.createObjectURL).
function photoUploadField(editorKey, editor) {
  const previewSrc = editor.photoPreviewUrl || editor.photoUrl || '';
  return `
    <div class="photo-upload">
      ${previewSrc
        ? `<img src="${previewSrc}" alt="Prévia da foto da receita" class="photo-preview" />`
        : `<div class="photo-placeholder">${icon('box')}</div>`}
      <label class="photo-upload-btn">
        ${icon('plus')}<span>${previewSrc ? 'Trocar foto' : 'Escolher foto'}</span>
        <input type="file" accept="image/*" data-photo-input="${editorKey}" hidden />
      </label>
    </div>`;
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
          <label>Preço da embalagem<div class="input-prefix"><span class="prefix">R$</span><input name="packagePrice" inputmode="decimal" placeholder="0,00" value="${escapeHtml(data.packagePrice)}" required /></div></label>
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
      <p>Isso vai excluir permanentemente sua conta e todos os seus dados (receitas, ingredientes, despesas). Não é possível desfazer.</p>
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

function addExpenseModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Adicionar despesa</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="add-expense" class="modal-form">
        <label>Nome da despesa<input name="name" required /></label>
        <div class="field-grid">
          <label>Valor mensal<div class="input-prefix"><span class="prefix">R$</span><input name="monthlyValue" inputmode="decimal" placeholder="0,00" /></div></label>
          <label>% por receita<input name="percentage" inputmode="decimal" value="1" required /></label>
        </div>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Adicionando...' : 'Adicionar despesa'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function addIngredientModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Adicionar ingrediente</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="new-ingredient" class="modal-form">
        <label>Nome<input name="name" required /></label>
        <div class="field-grid">
          <label>Preço da compra<div class="input-prefix"><span class="prefix">R$</span><input name="packagePrice" inputmode="decimal" placeholder="0,00" required /></div></label>
          <label>Qtd. comprada<input name="packageAmount" inputmode="decimal" placeholder="Kg/Gramas" required /></label>
        </div>
        <div class="field-grid">
          <label>Unidade<input name="unit" value="g" required /></label>
          <label>Categoria<input name="category" /></label>
        </div>
        <label>Marca<input name="brand" /></label>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Adicionando...' : 'Adicionar'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function addSupplierModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Adicionar fornecedor</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="new-supplier" class="modal-form">
        <label>Nome<input name="name" required /></label>
        <div class="field-grid">
          <label>Telefone<input name="phone" /></label>
          <label>E-mail<input name="email" type="email" /></label>
        </div>
        <label>Endereço<input name="address" /></label>
        <div class="field-grid">
          <label>Site<input name="site" /></label>
          <label>Contato<input name="contact_name" /></label>
        </div>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Adicionando...' : 'Adicionar'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function confirmLeaveModal() {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Sair sem salvar?</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      <p>Você tem alterações não salvas nesta página. Se sair agora, elas serão perdidas.</p>
      <div class="save-actions">
        <button type="button" class="danger" data-action="confirm-leave">Sair sem salvar</button>
        <button type="button" class="ghost" data-action="close-modal">Continuar editando</button>
      </div>
    </div>`;
}

// Modal de "adicionar ingrediente" na edição de uma receita: reaproveita a
// mesma linha/combobox da tabela, só que a linha (rascunho) fica escondida da
// tabela até o usuário clicar em "Inserir".
// Modal de "adicionar ingrediente" (usado tanto no wizard quanto na edição de
// uma receita já salva): mesma linha/combobox da tabela, com "Inserir" no
// final da linha em vez de "Remover" — a linha (rascunho) só entra na tabela
// de fato depois de confirmada.
function addRecipeIngredientModal(data) {
  const ed = getEditor(data.editorKey);
  const draft = ed.ingredients.find((i) => i.id === data.rowId);
  if (!draft) return '';
  const max = maxUsedAmount(draft);
  const invalid = data.invalidFields || {};
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Adicionar ingrediente</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      <div class="modal-form">
        <label>Ingrediente
          <select class="${invalid.name ? 'is-invalid' : ''}" data-editor="${data.editorKey}" data-ingredient="${draft.id}" data-ingredient-field="name">
            <option value="">Selecione um ingrediente</option>
            ${state.savedIngredients.map((si) => `<option value="${escapeHtml(si.name)}" ${draft.name === si.name ? 'selected' : ''}>${escapeHtml(si.name)}</option>`).join('')}
          </select>
          ${invalid.name ? '<span class="form-error">Selecione um ingrediente.</span>' : ''}
        </label>
        <label>Preço da compra<div class="input-prefix"><span class="prefix">R$</span><input aria-label="Preço da compra" inputmode="decimal" placeholder="0,00" data-editor="${data.editorKey}" data-ingredient="${draft.id}" data-ingredient-field="packagePrice" value="${escapeHtml(draft.packagePrice)}" /></div></label>
        <label>Qtd. comprada<input aria-label="Quantidade comprada" inputmode="decimal" data-editor="${data.editorKey}" data-ingredient="${draft.id}" data-ingredient-field="packageAmount" value="${escapeHtml(draft.packageAmount)}" /></label>
        <label>Qtd. usada
          <input class="${invalid.usedAmount ? 'is-invalid' : ''}" aria-label="Quantidade usada" inputmode="decimal" placeholder="${max ? `Máx. ${max}` : 'Obrigatório'}" data-editor="${data.editorKey}" data-ingredient="${draft.id}" data-ingredient-field="usedAmount" value="${escapeHtml(draft.usedAmount)}" />
          ${invalid.usedAmount ? '<span class="form-error">Informe a quantidade usada.</span>' : ''}
        </label>
        <label>Unidade<input aria-label="Unidade" placeholder="g, ml, un..." data-editor="${data.editorKey}" data-ingredient="${draft.id}" data-ingredient-field="unit" value="${escapeHtml(draft.unit)}" /></label>
        <div class="save-actions">
          <button type="button" data-action="confirm-add-recipe-ingredient">Inserir</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </div>
    </div>`;
}

// Modal de confirmação genérico para ações destrutivas/sensíveis (excluir
// ingrediente/receita, suspender/excluir usuário no admin...). O rótulo do
// botão de confirmação é configurável; por padrão é "Excluir".
function confirmDeleteModal(data) {
  const confirmLabel = data.confirmLabel || 'Excluir';
  const confirmLoadingLabel = data.confirmLoadingLabel || 'Excluindo...';
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>${escapeHtml(data.title)}</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <p>${escapeHtml(data.message)}</p>
      <div class="save-actions">
        <button type="button" class="danger" data-action="confirm-delete" ${data.loading ? 'disabled' : ''}>${data.loading ? confirmLoadingLabel : confirmLabel}</button>
        <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
      </div>
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
    'change-password': changePasswordModal,
    'delete-account': deleteAccountModal,
    'add-expense': addExpenseModal,
    'confirm-delete': confirmDeleteModal,
    'add-ingredient': addIngredientModal,
    'add-supplier': addSupplierModal,
    'confirm-leave': confirmLeaveModal,
    'add-recipe-ingredient': addRecipeIngredientModal,
  }[data.type];
  if (!content) return '';
  const overlayClass = modalHasAnimatedIn ? 'modal-overlay no-anim-overlay' : 'modal-overlay';
  modalHasAnimatedIn = true;
  return `<div class="${overlayClass}">${content(data)}</div>`;
}

// ---------------- Páginas ----------------

// Só considera http(s) — evita esquemas como javascript: em links salvos
// pelo próprio usuário no formulário da página Empresa.
function isHttpUrl(value) {
  return /^https?:\/\//i.test(value || '');
}

// Fonte única dos apps de delivery suportados: usada tanto nos campos de
// configuração (Empresa) quanto nos atalhos da home. Cor + marca dão um
// selo visual reconhecível sem depender de logos externos.
const DELIVERY_BRANDS = [
  { key: 'ifoodUrl', label: 'iFood', mark: 'iF', color: '#EA1D2C' },
  { key: 'link99Url', label: '99', mark: '99', color: '#FF6B00' },
  { key: 'keetaUrl', label: 'Keeta', mark: 'K', color: '#0F172A' },
];

function deliveryBadge(brand, extraClass = '') {
  return `<span class="delivery-badge ${extraClass}" style="background:${brand.color};" aria-hidden="true">${brand.mark}</span>`;
}

function deliveryShortcuts() {
  const links = DELIVERY_BRANDS
    .map((brand) => ({ brand, url: state.company[brand.key] }))
    .filter((l) => isHttpUrl(l.url));
  if (!links.length) return '';
  return `<div class="delivery-shortcuts">
    ${links.map((l) => `<a class="delivery-shortcut" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${deliveryBadge(l.brand, 'delivery-badge-sm')}<span>${escapeHtml(l.brand.label)}</span></a>`).join('')}
  </div>`;
}

function renderDashboard() {
  const ultimoProduto = state.savedProducts[0];

  return `
    ${banner('Calculadora de precificação para confeitaria', 'Acompanhe suas receitas, ingredientes e o histórico de preços em um só lugar.')}
    ${deliveryShortcuts()}
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
             <span class="muted">Rendimento: ${ultimoProduto.yield_amount} un.</span>
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
      ${state.dataLoading ? loadingMsg() : (state.savedProducts.length ? productsTable(state.savedProducts) : emptyState('Nenhuma receita salva ainda.', true))}
    </div>`;
}

function renderProdutosPage() {
  const selectedCount = state.selectedProducts.size;
  return `
    <div class="section-header">
      <div><p class="eyebrow">Receitas</p><h2>Suas receitas salvas</h2></div>
      <button type="button" data-action="start-wizard">+ Nova receita</button>
    </div>
    ${statusBox()}
    ${selectedCount > 0 ? `
      <div class="bulk-actions-bar">
        <span>${selectedCount} receita${selectedCount === 1 ? '' : 's'} selecionada${selectedCount === 1 ? '' : 's'}</span>
        <div class="bulk-actions-buttons">
          <button type="button" class="ghost" data-action="clear-product-selection">Cancelar seleção</button>
          <button type="button" class="danger" data-action="confirm-bulk-delete-products">Excluir selecionadas</button>
        </div>
      </div>` : ''}
    <div class="panel">
      ${state.dataLoading ? loadingMsg() : (state.savedProducts.length ? productsTable(state.savedProducts) : emptyState('Você ainda não salvou nenhuma receita.', true))}
    </div>
  `;
}

function renderProdutoDetalhe(id) {
  if (state.detail.loading || state.detail.productId !== id) return loadingMsg();
  const editor = state.detail;
  const isDirty = detailSnapshotOf(editor) !== state.detailSnapshot;
  return `
    <div class="section-header">
      <div><p class="eyebrow">Receita</p><h2>${escapeHtml(editor.productName || 'Receita')}</h2></div>
      <div class="section-header-actions">
        <button type="button" class="ghost" data-action="goto" data-route="produtos">Voltar</button>
        <button type="button" class="danger" data-action="delete-detail" data-id="${id}" data-name="${escapeHtml(editor.productName)}">Excluir receita</button>
        <button type="button" data-action="save-detail" ${isDirty ? '' : 'disabled'}>Salvar alterações</button>
      </div>
    </div>
    ${statusBox()}
    <div class="panel">
      <h3>Foto da receita</h3>
      ${photoUploadField('detail', editor)}
    </div>
    <div class="panel">${basicFields('detail', editor)}</div>
    <div class="panel">
      <h3>Ingredientes e embalagens usados</h3>
      ${editor.errors.ingredients ? `<p class="form-error">${escapeHtml(editor.errors.ingredients)}</p>` : ''}
      ${ingredientsTable('detail', editor.ingredients, editor.errors.invalidIngredientIds || new Set())}
    </div>
    ${pricingResultBlock(editor)}`;
}

function renderWizard() {
  const editor = state.wizard;
  const steps = [
    { label: 'Nome', icon: 'pencil' },
    { label: 'Ingredientes', icon: 'leaf' },
    { label: 'Rendimento', icon: 'cupcake' },
    { label: 'Foto', icon: 'camera' },
    { label: 'Revisão', icon: 'clipboardList' },
  ];
  const lastStep = steps.length;
  return `
    <div class="section-header">
      <div><p class="eyebrow">Nova receita</p><h2>Vamos montar sua ficha de precificação</h2></div>
      <button type="button" class="ghost" data-action="goto" data-route="produtos">Cancelar</button>
    </div>
    ${statusBox()}
    <div class="stepper">
      ${steps.map((step, i) => {
        const stepNum = i + 1;
        const status = stepNum < editor.step ? 'done' : stepNum === editor.step ? 'active' : 'upcoming';
        return `<div class="stepper-item ${status}">
          <span class="stepper-dot">${icon(status === 'done' ? 'check' : step.icon)}</span>
          <span class="stepper-label">${step.label}</span>
        </div>`;
      }).join('')}
    </div>
    ${editor.step === 2 ? '<h3>Selecione os ingredientes/embalagens da base e informe a quantidade usada</h3>' : ''}
    ${editor.step === 4 ? '<h3>Adicione uma foto da receita (opcional)</h3>' : ''}
    <div class="panel">
      ${editor.step === 1 ? `<div class="field-grid">${fieldFor('wizard', 'productName', 'Nome da receita', editor.productName, 'text', editor.errors.productName)}</div>` : ''}
      ${editor.step === 2 ? `
        ${editor.errors.ingredients ? `<p class="form-error">${escapeHtml(editor.errors.ingredients)}</p>` : ''}
        ${ingredientsTable('wizard', editor.ingredients, editor.errors.invalidIngredientIds || new Set())}` : ''}
      ${editor.step === 3 ? `<div class="field-grid">${fieldFor('wizard', 'yieldAmount', 'Quantas unidades saem dessa receita (Qnt. por forma)', editor.yieldAmount, 'decimal', editor.errors.yieldAmount)}</div>` : ''}
      ${editor.step === 4 ? photoUploadField('wizard', editor) : ''}
      ${editor.step === 5 ? renderWizardReview(editor) : ''}
    </div>
    <div class="wizard-actions">
      <button type="button" class="ghost" data-action="wizard-back" ${editor.step === 1 ? 'disabled' : ''}>Voltar</button>
      ${editor.step < lastStep
        ? '<button type="button" data-action="wizard-next">Avançar</button>'
        : '<button type="button" data-action="wizard-save">Salvar receita</button>'}
    </div>`;
}

function renderWizardReview(editor) {
  const pricing = pricingFor(editor);
  const photoSrc = editor.photoPreviewUrl || editor.photoUrl || '';
  const itemCount = editor.ingredients.filter((i) => !i.draft).length;
  return `<div class="wizard-review">
    <div class="wizard-review-header">
      ${photoSrc ? `<img src="${photoSrc}" alt="" class="wizard-review-photo" />` : ''}
      <div>
        <h3>${escapeHtml(editor.productName || 'Receita sem nome')}</h3>
        <p class="muted">Rendimento: ${escapeHtml(editor.yieldAmount || '0')} un. · ${itemCount} item(ns)</p>
      </div>
    </div>
    <dl>
      <div><dt>Custo dos ingredientes</dt><dd>${formatCurrency(pricing.ingredientsCost)}</dd></div>
      <div><dt>Despesas alocadas</dt><dd>${formatCurrency(pricing.expensesCost)}</dd></div>
      <div><dt>Custo total</dt><dd>${formatCurrency(pricing.totalCost)}</dd></div>
      <div><dt>Custo por unidade</dt><dd>${formatCurrency(pricing.unitCost)}</dd></div>
    </dl>
    <div style="margin-top:16px;">${tiersTable(pricing)}</div>
  </div>`;
}

// Colunas filtráveis da tabela de ingredientes: nome da coluna -> como ler o
// valor "de exibição" de cada linha (usado tanto para listar as opções do
// filtro quanto para comparar contra o filtro ativo).
const INGREDIENT_COLUMNS = [
  { key: 'name', label: 'Nome', value: (i) => i.name },
  { key: 'category', label: 'Categoria', value: (i) => i.category || '—' },
  { key: 'price', label: 'Preço', value: (i) => formatCurrency(i.package_price) },
  { key: 'amount', label: 'Qtd.', value: (i) => `${i.package_amount}${i.unit}` },
  { key: 'brand', label: 'Marca', value: (i) => i.brand || '—' },
];

// Cabeçalho de coluna com ícone de filtro: abre uma lista com os valores
// distintos daquela coluna (a partir de todos os ingredientes) para marcar/
// desmarcar — útil quando a base de ingredientes cresce bastante.
function filterableTh(column, allRows) {
  const isOpen = state.openIngredientFilterColumn === column.key;
  const active = state.ingredientColumnFilters[column.key];
  const hasActive = active && active.size > 0;
  const options = Array.from(new Set(allRows.map(column.value))).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return `<th>
    <span class="th-filter">
      <span>${escapeHtml(column.label)}</span>
      <button type="button" class="th-filter-btn ${hasActive ? 'active' : ''}" data-action="toggle-ingredient-filter" data-column="${column.key}">${icon('filter')}</button>
      ${isOpen ? `
        <div class="th-filter-menu">
          ${options.map((opt) => `
            <label class="th-filter-option">
              <input type="checkbox" data-filter-column="${column.key}" data-filter-value="${escapeHtml(opt)}" ${active && active.has(opt) ? 'checked' : ''} />
              <span>${escapeHtml(opt)}</span>
            </label>`).join('')}
          ${hasActive ? `<button type="button" class="th-filter-clear" data-action="clear-ingredient-filter" data-column="${column.key}">Limpar filtro</button>` : ''}
        </div>` : ''}
    </span>
  </th>`;
}

function renderIngredientesPage() {
  const query = state.ingredientSearch.trim().toLowerCase();
  const searched = query
    ? state.savedIngredients.filter((i) => i.name.toLowerCase().includes(query)
      || (i.category || '').toLowerCase().includes(query)
      || (i.brand || '').toLowerCase().includes(query))
    : state.savedIngredients;
  const filtered = searched.filter((i) => INGREDIENT_COLUMNS.every(({ key, value }) => {
    const active = state.ingredientColumnFilters[key];
    return !active || active.size === 0 || active.has(value(i));
  }));
  const list = filtered.length > 0
    ? `<div class="table-scroll"><table class="data-table">
        <thead><tr>${INGREDIENT_COLUMNS.map((column) => filterableTh(column, state.savedIngredients)).join('')}<th></th></tr></thead>
        <tbody>
          ${filtered.map((i) => `
            <tr>
              <td>${escapeHtml(i.name)}</td>
              <td>${i.category ? escapeHtml(i.category) : '—'}</td>
              <td>${formatCurrency(i.package_price)}</td>
              <td>${escapeHtml(String(i.package_amount))}${escapeHtml(i.unit)}</td>
              <td>${i.brand ? escapeHtml(i.brand) : '—'}</td>
              <td class="data-table-actions">
                <button type="button" class="ghost" data-action="open-edit-ingredient" data-id="${i.id}">Editar</button>
                <button type="button" class="ghost" data-action="delete-saved-ingredient" data-id="${i.id}">Excluir</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>`
    : emptyState(query ? 'Nenhum ingrediente encontrado.' : 'Nenhum ingrediente cadastrado ainda.', false);

  return `
    <div class="section-header">
      <div><p class="eyebrow">Base de ingredientes</p><h2>Ingredientes e embalagens</h2></div>
      <button type="button" data-action="add-ingredient-modal">Adicionar novo</button>
    </div>
    ${statusBox()}
    <div class="panel">
      <input class="search-input" type="search" name="ingredientSearch" data-search="ingredients" placeholder="Buscar por nome, categoria ou marca..." value="${escapeHtml(state.ingredientSearch)}" />
      ${state.dataLoading ? loadingMsg() : list}
    </div>`;
}

function renderDespesasPage() {
  const total = state.expenseCategories.reduce((sum, e) => sum + toNumberSafe(e.monthly_value) * (toNumberSafe(e.percentage) / 100), 0);
  const isDirty = JSON.stringify(state.expenseCategories) !== state.expensesSnapshot;
  return `
    ${pageHeaderWithSave('Base de despesas', 'Custos fixos mensais', 'save-expenses', isDirty)}
    <p>Cada despesa é alocada por receita usando o percentual informado (ex.: R$250 de energia × 1% = R$2,50 por receita).</p>
    ${statusBox()}
    <div class="panel">
      <div class="ingredient-grid header-row" aria-hidden="true" style="grid-template-columns: 1.4fr 1fr 1fr 1fr 80px;"><span>Despesa</span><span>Valor mensal (R$)</span><span>% por receita</span><span>Alocado</span><span></span></div>
      ${state.expenseCategories.map((expense) => {
        const allocated = toNumberSafe(expense.monthly_value) * (toNumberSafe(expense.percentage) / 100);
        return `<div class="ingredient-grid" style="grid-template-columns: 1.4fr 1fr 1fr 1fr 80px;" data-expense-id="${expense.id}">
          <input aria-label="Despesa" data-expense-id="${expense.id}" data-expense-field="name" value="${escapeHtml(expense.name)}" />
          <div class="input-prefix"><span class="prefix">R$</span><input aria-label="Valor mensal" inputmode="decimal" placeholder="0,00" data-expense-id="${expense.id}" data-expense-field="monthly_value" value="${toNumberSafe(expense.monthly_value) ? escapeHtml(expense.monthly_value) : ''}" /></div>
          <input aria-label="Percentual" inputmode="decimal" data-expense-id="${expense.id}" data-expense-field="percentage" value="${escapeHtml(expense.percentage)}" />
          <span class="muted" style="align-self:center;">${formatCurrency(allocated)}</span>
          <button type="button" class="ghost" data-action="delete-expense" data-id="${expense.id}">Excluir</button>
        </div>`;
      }).join('')}
      ${addRowLink('Adicionar despesa', 'add-expense')}
      <p class="status-message" style="margin-top:16px;">Total alocado por receita: <strong>${formatCurrency(total)}</strong></p>
    </div>`;
}

function percentFromMultiplier(multiplier) {
  const percent = toNumberSafe(multiplier) * 100;
  return Number.isInteger(percent) ? String(percent) : String(Math.round(percent * 100) / 100);
}

function renderLucroPage() {
  const isDirty = JSON.stringify(state.profitTiers) !== state.tiersSnapshot;
  return `
    ${pageHeaderWithSave('Base de lucro', 'Níveis de margem', 'save-tiers', isDirty)}
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
    </div>`;
}

function renderFornecedoresPage() {
  const query = state.supplierSearch.trim().toLowerCase();
  const filtered = query
    ? state.suppliers.filter((s) => s.name.toLowerCase().includes(query)
      || (s.contact_name || '').toLowerCase().includes(query)
      || (s.email || '').toLowerCase().includes(query))
    : state.suppliers;
  const list = filtered.length > 0
    ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Nome</th><th>Telefone</th><th>Contato</th><th>E-mail</th><th></th></tr></thead>
        <tbody>
          ${filtered.map((s) => `
            <tr>
              <td>${escapeHtml(s.name)}</td>
              <td>${s.phone ? escapeHtml(s.phone) : '—'}</td>
              <td>${s.contact_name ? escapeHtml(s.contact_name) : '—'}</td>
              <td>${s.email ? escapeHtml(s.email) : '—'}</td>
              <td class="data-table-actions"><button type="button" class="ghost" data-action="delete-supplier" data-id="${s.id}">Excluir</button></td>
            </tr>`).join('')}
        </tbody>
      </table></div>`
    : emptyState(query ? 'Nenhum fornecedor encontrado.' : 'Nenhum fornecedor cadastrado ainda.', false);

  return `
    <div class="section-header">
      <div><p class="eyebrow">Base de fornecedores</p><h2>Contatos</h2></div>
      <button type="button" data-action="add-supplier-modal">Adicionar novo</button>
    </div>
    ${statusBox()}
    <div class="panel">
      <input class="search-input" type="search" name="supplierSearch" data-search="suppliers" placeholder="Buscar por nome, contato ou e-mail..." value="${escapeHtml(state.supplierSearch)}" />
      ${state.dataLoading ? loadingMsg() : list}
    </div>`;
}

function renderConfiguracoesPage() {
  const isDirty = JSON.stringify(state.settings) !== state.settingsSnapshot;
  return `
    ${pageHeaderWithSave('Configurações', 'Perfil', 'save-settings', isDirty)}
    ${statusBox()}
    <div class="panel">
      <div class="field-grid">
        <label>Nome completo<input name="fullName" data-settings-field="fullName" value="${escapeHtml(state.settings.fullName)}" required /></label>
        <label>E-mail<input name="email" type="email" data-settings-field="email" value="${escapeHtml(state.settings.email)}" required /></label>
      </div>
      <p class="form-hint">Alterar o e-mail exige confirmação por um link enviado ao novo endereço.</p>
    </div>
    <div class="panel">
      <h3>Segurança</h3>
      <p class="muted">Troque sua senha periodicamente para manter sua conta segura.</p>
      <button type="button" class="ghost" data-action="open-change-password">Trocar senha</button>
    </div>
    <div class="panel">
      <h3>Zona de risco</h3>
      <p class="form-hint">Excluir sua conta remove permanentemente seus dados (receitas, ingredientes, despesas) conforme a LGPD. Esta ação não pode ser desfeita.</p>
      <button type="button" class="danger" data-action="open-delete-account">Excluir minha conta</button>
    </div>`;
}

function renderEmpresaPage() {
  const isDirty = JSON.stringify(state.company) !== state.companySnapshot;
  return `
    ${pageHeaderWithSave('Empresa', 'Dados da empresa', 'save-company', isDirty)}
    ${statusBox()}
    <div class="panel">
      <div class="field-grid">
        <label>Nome<input name="companyName" data-company-field="name" value="${escapeHtml(state.company.name)}" /></label>
        <label>CNPJ<input name="cnpj" data-company-field="cnpj" value="${escapeHtml(state.company.cnpj)}" placeholder="00.000.000/0000-00" /></label>
      </div>
    </div>
    <div class="panel">
      <h3>Endereço</h3>
      <div class="field-grid">
        <label>CEP<input name="cep" data-company-field="cep" value="${escapeHtml(state.company.cep)}" placeholder="00000-000" maxlength="9" /></label>
      </div>
      ${state.cepLookup.loading ? '<p class="form-hint">Buscando endereço...</p>' : ''}
      ${state.cepLookup.error ? `<p class="form-error">${escapeHtml(state.cepLookup.error)}</p>` : ''}
      <div class="field-grid" style="margin-top:16px;">
        <label>Logradouro<input name="street" data-company-field="street" value="${escapeHtml(state.company.street)}" /></label>
        <label>Bairro<input name="neighborhood" data-company-field="neighborhood" value="${escapeHtml(state.company.neighborhood)}" /></label>
      </div>
      <div class="field-grid" style="margin-top:16px;">
        <label>Cidade<input name="city" data-company-field="city" value="${escapeHtml(state.company.city)}" /></label>
        <label>Estado (UF)<input name="state" data-company-field="state" value="${escapeHtml(state.company.state)}" maxlength="2" /></label>
      </div>
      <div class="field-grid" style="margin-top:16px;">
        <label>Número<input name="number" data-company-field="number" value="${escapeHtml(state.company.number)}" /></label>
        <label>Complemento<input name="complement" data-company-field="complement" value="${escapeHtml(state.company.complement)}" /></label>
      </div>
    </div>
    <div class="panel">
      <h3>Links de delivery</h3>
      <p class="muted">Adicione os links da sua loja nos apps de entrega para exibir atalhos na página inicial.</p>
      <div class="delivery-field-list">
        ${DELIVERY_BRANDS.map((brand) => `
          <div class="delivery-field-row">
            ${deliveryBadge(brand)}
            <label>${escapeHtml(brand.label)}<input name="${brand.key}" type="url" data-company-field="${brand.key}" value="${escapeHtml(state.company[brand.key])}" placeholder="https://..." /></label>
          </div>`).join('')}
      </div>
    </div>`;
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
          : `<button type="button" class="ghost" data-action="admin-confirm-suspend" data-id="${u.id}">Suspender</button>`}
        ${u.role === 'admin' ? '' : `<button type="button" class="danger" data-action="admin-confirm-delete" data-id="${u.id}">Excluir</button>`}
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
  // Conta admin só enxerga o painel de usuários (visão de uma página só) —
  // exceto as páginas legais do footer, que continuam acessíveis a todos.
  if (state.profile.role === 'admin' && state.route.path !== 'termos' && state.route.path !== 'privacidade') {
    return renderAdminPage();
  }
  switch (state.route.path) {
    case 'produtos': return renderProdutosPage();
    case 'produto': return renderProdutoDetalhe(state.route.param);
    case 'novo-produto': return renderWizard();
    case 'ingredientes': return renderIngredientesPage();
    case 'despesas': return renderDespesasPage();
    case 'lucro': return renderLucroPage();
    case 'fornecedores': return renderFornecedoresPage();
    case 'admin': return renderAdminPage();
    case 'configuracoes': return renderConfiguracoesPage();
    case 'empresa': return renderEmpresaPage();
    case 'termos': return renderTermosPage();
    case 'privacidade': return renderPrivacidadePage();
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
  const isAdmin = state.profile.role === 'admin';
  return `
    <div class="shell">
      <header class="navbar">
        <div class="navbar-inner">
          <button type="button" class="brand" data-action="goto" data-route="inicio">
            <span class="brand-mark"></span> Sweet Price
          </button>
          ${isAdmin ? '' : `
          <ul class="nav-list ${state.mobileMenuOpen ? 'open' : ''}">
            ${navItem('produtos', 'Receitas')}
            ${navItem('ingredientes', 'Ingredientes')}
            ${navItem('despesas', 'Despesas')}
            ${navItem('lucro', 'Lucro')}
            ${navItem('fornecedores', 'Fornecedores')}
            ${navItem('empresa', 'Empresa')}
          </ul>`}
          <div class="navbar-user">
            <div class="profile-menu">
              <button type="button" class="profile-trigger" data-action="toggle-profile-menu">
                <span class="navbar-email">${escapeHtml(displayName)}</span>${icon('chevronDown')}
              </button>
              ${state.profileMenuOpen ? `
                <div class="profile-dropdown">
                  ${isAdmin ? '' : `<button type="button" class="profile-dropdown-item" data-action="goto" data-route="configuracoes">${icon('settings')}Configurações</button>`}
                  <button type="button" class="profile-dropdown-item" data-action="open-change-password">${icon('key')}Trocar senha</button>
                </div>` : ''}
            </div>
            <span class="navbar-divider" aria-hidden="true"></span>
            <button type="button" class="text-link" data-action="logout">Sair</button>
          </div>
          ${isAdmin ? '' : `<button type="button" class="navbar-menu-toggle" data-action="toggle-mobile-menu" aria-label="Abrir menu">${icon(state.mobileMenuOpen ? 'close' : 'menu')}</button>`}
        </div>
      </header>
      <div class="main-area">
        <div class="page">${renderPage()}</div>
      </div>
      ${siteFooter()}
    </div>
    ${modalOverlay()}`;
}

function siteFooter() {
  const year = new Date().getFullYear();
  return `
    <footer class="site-footer">
      <div class="site-footer-inner">
        <span>&copy; ${year} Sweet Price. Todos os direitos reservados.</span>
        <nav class="site-footer-links">
          <button type="button" data-action="goto" data-route="termos">Termos de uso</button>
          <button type="button" data-action="goto" data-route="privacidade">Privacidade</button>
        </nav>
        <span class="site-footer-badge">Powered by: <strong>Gravit</strong></span>
      </div>
    </footer>`;
}

function renderLegalPage(title, paragraphs) {
  return `
    <div class="section-header">
      <div><p class="eyebrow">Sweet Price</p><h2>${escapeHtml(title)}</h2></div>
      <button type="button" class="ghost" data-action="goto" data-route="inicio">Voltar</button>
    </div>
    <div class="panel">
      ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
    </div>`;
}

function renderTermosPage() {
  return renderLegalPage('Termos de uso', [
    'Ao usar o Sweet Price, você concorda em utilizar a ferramenta para calcular preços e organizar receitas, ingredientes e despesas do seu próprio negócio.',
    'Os cálculos apresentados são estimativas baseadas nos dados informados por você; a conferência dos valores antes de aplicá-los é de responsabilidade do usuário.',
    'Não é permitido usar a plataforma para armazenar dados de terceiros sem autorização, nem tentar acessar contas ou dados de outros usuários.',
    'Podemos atualizar estes termos periodicamente; o uso contínuo do app após uma atualização representa a aceitação dos novos termos.',
  ]);
}

function renderPrivacidadePage() {
  return renderLegalPage('Política de privacidade', [
    'Coletamos apenas os dados necessários para o funcionamento do app: nome, e-mail e as informações que você cadastra (receitas, ingredientes, despesas e fornecedores).',
    'Seus dados não são vendidos nem compartilhados com terceiros para fins de marketing.',
    'Você pode atualizar suas informações pessoais, trocar sua senha ou excluir permanentemente sua conta e todos os seus dados a qualquer momento, pelo menu de perfil.',
    'Em conformidade com a LGPD, você tem direito a solicitar acesso, correção ou exclusão dos seus dados pessoais.',
  ]);
}

function authHtml() {
  const isSignUp = state.authMode === 'signup';
  return `
    <div class="auth-page">
      <div class="auth-form-side">
        <div class="auth-brand"><span class="brand-mark"></span> Sweet Price</div>
        <div class="auth-form-inner">
          <p class="eyebrow">${isSignUp ? 'Comece agora' : 'Bem-vindo de volta'}</p>
          <h1 class="auth-title">${isSignUp ? 'Crie sua conta' : 'Acesse sua conta'}</h1>
          <p class="auth-subtitle">${isSignUp ? 'Calcule o preço ideal dos seus doces com base no custo real de ingredientes e despesas.' : 'O parceiro online da sua confeitaria.'}</p>
          <form data-form="auth">
            ${isSignUp ? '<label>Nome<input name="fullName" type="text" required /></label><label>Nome da empresa<input name="companyName" type="text" /></label>' : ''}
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
    </div>
    ${modalOverlay()}`;
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
  const companyName = formData.get('companyName');

  state.authLoading = true;
  state.authError = '';
  render();

  try {
    if (state.authMode === 'signup') {
      await signUp(email, password, fullName, companyName);
      form.reset();
      state.authMode = 'signin';
      state.authLoading = false;
      showSuccess('Conta criada! Verifique seu e-mail para confirmar o acesso, se necessário.');
      return;
    }
    await signIn(email, password);
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
  ed.step = Math.min(5, ed.step + 1);
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
    const photoUrl = ed.photoFile
      ? await db.uploadProductPhoto(state.session.user.id, ed.photoFile)
      : null;
    const saved = await db.saveProduct(
      state.session.user.id,
      null,
      {
        name: ed.productName || 'Receita sem nome',
        yield_amount: Math.max(1, Math.floor(toNumberSafe(ed.yieldAmount) || 1)),
        ...(photoUrl ? { photo_url: photoUrl } : {}),
      },
      ed.ingredients.filter((i) => i.name.trim() && !i.draft),
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
    const photoUrl = ed.photoFile
      ? await db.uploadProductPhoto(state.session.user.id, ed.photoFile)
      : ed.photoUrl || null;
    await db.saveProduct(
      state.session.user.id,
      ed.productId,
      {
        name: ed.productName || 'Receita sem nome',
        yield_amount: Math.max(1, Math.floor(toNumberSafe(ed.yieldAmount) || 1)),
        photo_url: photoUrl,
      },
      ed.ingredients.filter((i) => i.name.trim() && !i.draft),
    );
    ed.photoFile = null;
    state.detailSnapshot = detailSnapshotOf(ed);
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

async function handleBulkDeleteProducts() {
  const ids = Array.from(state.selectedProducts);
  try {
    await Promise.all(ids.map((id) => db.deleteProduct(id)));
    state.selectedProducts.clear();
    await loadUserData();
    showSuccess(`${ids.length} receita${ids.length === 1 ? '' : 's'} excluída${ids.length === 1 ? '' : 's'}.`);
  } catch (error) {
    state.statusMessage = `Erro ao excluir: ${error.message}`;
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
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.createIngredient(state.session.user.id, draft);
    await loadUserData();
    closeModal();
    showSuccess('Ingrediente cadastrado!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
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

async function handleAddExpenseSubmit(form) {
  const formData = new FormData(form);
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.createExpenseCategory(state.session.user.id, {
      name: formData.get('name'),
      monthly_value: toNumberSafe(formData.get('monthlyValue')),
      percentage: toNumberSafe(formData.get('percentage')) || 1,
      position: state.expenseCategories.length,
    });
    await loadUserData();
    closeModal();
    showSuccess('Despesa adicionada!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
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
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.createSupplier(state.session.user.id, draft);
    await loadUserData();
    closeModal();
    showSuccess('Fornecedor cadastrado!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
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

async function handleSaveSettings() {
  const draft = state.settings;
  try {
    await db.updateProfile(state.session.user.id, { full_name: draft.fullName });
    const emailChanged = draft.email !== state.session.user.email;
    if (emailChanged) {
      await updateEmail(draft.email);
    }
    state.profile.fullName = draft.fullName;
    state.settingsSnapshot = JSON.stringify(draft);
    showSuccess(emailChanged
      ? 'Dados salvos! Confirme o novo e-mail pelo link que enviamos.'
      : 'Configurações salvas!');
    render();
  } catch (error) {
    state.statusMessage = `Erro ao salvar: ${error.message}`;
    render();
  }
}

async function handleSaveCompany() {
  const draft = state.company;
  try {
    await db.updateProfile(state.session.user.id, {
      company_name: draft.name,
      cnpj: draft.cnpj,
      cep: draft.cep,
      street: draft.street,
      neighborhood: draft.neighborhood,
      city: draft.city,
      state: draft.state,
      address_number: draft.number,
      complement: draft.complement,
      ifood_url: draft.ifoodUrl,
      link_99_url: draft.link99Url,
      keeta_url: draft.keetaUrl,
    });
    state.companySnapshot = JSON.stringify(draft);
    showSuccess('Dados da empresa salvos!');
    render();
  } catch (error) {
    state.statusMessage = `Erro ao salvar: ${error.message}`;
    render();
  }
}

// Busca o endereço pelo CEP (ViaCEP) e preenche logradouro/bairro/cidade/UF
// automaticamente; número e complemento continuam manuais.
async function handleCepLookup(cepDigits) {
  state.cepLookup = { loading: true, error: '' };
  render();
  try {
    const result = await lookupCep(cepDigits);
    state.company.street = result.street;
    state.company.neighborhood = result.neighborhood;
    state.company.city = result.city;
    state.company.state = result.state;
    state.cepLookup = { loading: false, error: '' };
  } catch (error) {
    state.cepLookup = { loading: false, error: error.message };
  }
  render();
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

function openConfirmDeleteIngredient(id) {
  const source = state.savedIngredients.find((i) => i.id === id);
  openModal('confirm-delete', {
    kind: 'ingredient',
    id,
    title: 'Excluir ingrediente',
    message: `Tem certeza que deseja excluir "${source?.name || 'este ingrediente'}"? Essa ação não pode ser desfeita.`,
  });
}

function openConfirmDeleteProduct(id, name) {
  openModal('confirm-delete', {
    kind: 'product',
    id,
    title: 'Excluir receita',
    message: `Tem certeza que deseja excluir "${name || 'esta receita'}"? Essa ação não pode ser desfeita.`,
  });
}

function openConfirmBulkDeleteProducts() {
  const count = state.selectedProducts.size;
  openModal('confirm-delete', {
    kind: 'bulk-products',
    title: 'Excluir receitas selecionadas',
    message: `Tem certeza que deseja excluir ${count} receita${count === 1 ? '' : 's'} selecionada${count === 1 ? '' : 's'}? Essa ação não pode ser desfeita.`,
  });
}

function openConfirmAdminSuspend(user) {
  openModal('confirm-delete', {
    kind: 'admin-suspend',
    id: user.id,
    title: 'Suspender usuário',
    message: `Suspender o acesso de "${user.fullName || user.email}"? O usuário fica bloqueado até ser reativado.`,
    confirmLabel: 'Suspender',
    confirmLoadingLabel: 'Suspendendo...',
  });
}

function openConfirmAdminDelete(user) {
  openModal('confirm-delete', {
    kind: 'admin-delete',
    id: user.id,
    title: 'Excluir usuário',
    message: `Excluir permanentemente a conta de "${user.fullName || user.email}" e todos os dados dele? Essa ação não pode ser desfeita.`,
  });
}

async function handleConfirmDelete() {
  const modal = state.activeModal;
  if (!modal) return;
  closeModal();
  if (modal.kind === 'ingredient') await handleDeleteSavedIngredient(modal.id);
  if (modal.kind === 'product') await handleDeleteDetail(modal.id);
  if (modal.kind === 'bulk-products') await handleBulkDeleteProducts();
  if (modal.kind === 'admin-suspend') await handleAdminAction('suspend', modal.id);
  if (modal.kind === 'admin-delete') await handleAdminAction('delete', modal.id);
}

// Abre o modal de adicionar ingrediente (wizard ou edição de receita): cria
// uma linha rascunho (escondida da tabela) que só entra de fato ao confirmar.
function openAddRecipeIngredientModal(editorKey) {
  const ed = getEditor(editorKey);
  const draft = newIngredient({ draft: true });
  ed.ingredients.push(draft);
  openModal('add-recipe-ingredient', { editorKey, rowId: draft.id });
}

function handleConfirmAddRecipeIngredient() {
  const { editorKey, rowId } = state.activeModal || {};
  const ed = getEditor(editorKey);
  const draft = ed.ingredients.find((i) => i.id === rowId);
  if (!draft) {
    closeModal();
    return;
  }
  const invalidFields = {
    name: !draft.name.trim(),
    usedAmount: toNumberSafe(draft.usedAmount) <= 0,
  };
  if (invalidFields.name || invalidFields.usedAmount) {
    state.activeModal.invalidFields = invalidFields;
    render();
    return;
  }
  delete draft.draft;
  closeModal();
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

app.addEventListener('change', async (event) => {
  const target = event.target;
  if (!target.dataset) return;
  if (target.dataset.filterColumn) {
    const column = target.dataset.filterColumn;
    const value = target.dataset.filterValue;
    const set = state.ingredientColumnFilters[column] || new Set();
    if (target.checked) set.add(value); else set.delete(value);
    state.ingredientColumnFilters[column] = set;
    render();
    return;
  }
  if (!target.dataset.photoInput) return;
  const file = target.files?.[0];
  if (!file) return;
  const ed = getEditor(target.dataset.photoInput);
  const compressed = await compressImageToWebp(file);
  ed.photoFile = compressed;
  ed.photoPreviewUrl = URL.createObjectURL(compressed);
  render();
});

// Enquanto o usuário está compondo um caractere (acento via dead-key, IME de
// outros idiomas...), o navegador ainda não decidiu o caractere final. Se a
// gente re-renderizar (substitui o <input> por um novo nó) no meio dessa
// composição, ela quebra e sobra lixo tipo "'i" em vez de "í" — e a troca de
// nó também é o que fazia a tela "piscar" ao digitar. Então ignoramos os
// eventos de input enquanto `isComposing` estiver true; o evento final de
// input (que sempre vem logo depois do compositionend) já chega com o
// caractere certo e dispara o render normalmente.
let isComposing = false;
app.addEventListener('compositionstart', () => { isComposing = true; });
app.addEventListener('compositionend', () => { isComposing = false; });

app.addEventListener('input', (event) => {
  if (isComposing) return;
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
      if (field === 'usedAmount') {
        const max = maxUsedAmount(updated);
        if (max && toNumberSafe(updated.usedAmount) > max) updated.usedAmount = String(max);
      }
      return updated;
    });
    if (field === 'name') state.openCombobox = rowId;
    if (state.activeModal?.invalidFields?.[field] && state.activeModal.rowId === rowId) {
      state.activeModal.invalidFields[field] = false;
    }
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
    return;
  }
  if (target.dataset.search === 'ingredients') {
    state.ingredientSearch = target.value;
    render();
    return;
  }
  if (target.dataset.search === 'suppliers') {
    state.supplierSearch = target.value;
    render();
    return;
  }
  if (target.dataset.settingsField) {
    state.settings[target.dataset.settingsField] = target.value;
    render();
    return;
  }
  if (target.dataset.companyField) {
    const field = target.dataset.companyField;
    state.company[field] = target.value;
    render();
    if (field === 'cep') {
      const digits = target.value.replace(/\D/g, '');
      if (digits.length === 8) handleCepLookup(digits);
    }
  }
});

// Abre o combobox de ingrediente ao focar no campo de nome.
app.addEventListener('focus', (event) => {
  const target = event.target;
  if (!target.dataset || target.dataset.ingredientField !== 'name') return;
  if (!target.closest('.combobox')) return;
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
  if (formType === 'new-ingredient') handleNewSavedIngredient(event.target);
  if (formType === 'new-supplier') handleNewSupplier(event.target);
  if (formType === 'edit-ingredient') handleEditIngredientSubmit(event.target);
  if (formType === 'change-password') handleChangePasswordSubmit(event.target);
  if (formType === 'delete-account') handleDeleteAccountSubmit(event.target);
  if (formType === 'add-expense') handleAddExpenseSubmit(event.target);
});

app.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const editorKey = el.dataset.editor;
  const id = el.dataset.id;

  switch (action) {
    case 'goto':
      requestNavigation(() => navigate(`#/${el.dataset.route}`));
      break;
    case 'open-produto':
      requestNavigation(() => navigate(`#/produto/${id}`));
      break;
    case 'toggle-select-product':
      if (state.selectedProducts.has(id)) state.selectedProducts.delete(id);
      else state.selectedProducts.add(id);
      render();
      break;
    case 'toggle-select-all-products': {
      const allIds = state.savedProducts.map((p) => p.id);
      const allSelected = allIds.length > 0 && allIds.every((pid) => state.selectedProducts.has(pid));
      if (allSelected) state.selectedProducts.clear();
      else allIds.forEach((pid) => state.selectedProducts.add(pid));
      render();
      break;
    }
    case 'clear-product-selection':
      state.selectedProducts.clear();
      render();
      break;
    case 'confirm-bulk-delete-products':
      openConfirmBulkDeleteProducts();
      break;
    case 'start-wizard':
      startWizard();
      navigate('#/novo-produto');
      render();
      break;
    case 'logout':
      requestNavigation(() => signOut());
      break;
    case 'confirm-leave':
      handleConfirmLeave();
      break;
    case 'auth-tab':
      state.authMode = el.dataset.mode;
      state.authError = '';
      render();
      break;
    case 'add-ingredient':
      openAddRecipeIngredientModal(editorKey);
      break;
    case 'confirm-add-recipe-ingredient':
      handleConfirmAddRecipeIngredient();
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
      openConfirmDeleteProduct(id, el.dataset.name);
      break;
    case 'delete-saved-ingredient':
      openConfirmDeleteIngredient(id);
      break;
    case 'confirm-delete':
      handleConfirmDelete();
      break;
    case 'save-expenses':
      handleSaveExpenses();
      break;
    case 'add-expense':
      openModal('add-expense');
      break;
    case 'add-ingredient-modal':
      openModal('add-ingredient');
      break;
    case 'toggle-ingredient-filter':
      state.openIngredientFilterColumn = state.openIngredientFilterColumn === el.dataset.column ? null : el.dataset.column;
      render();
      break;
    case 'clear-ingredient-filter':
      delete state.ingredientColumnFilters[el.dataset.column];
      render();
      break;
    case 'add-supplier-modal':
      openModal('add-supplier');
      break;
    case 'delete-expense':
      handleDeleteExpense(id);
      break;
    case 'save-tiers':
      handleSaveTiers();
      break;
    case 'save-settings':
      handleSaveSettings();
      break;
    case 'save-company':
      handleSaveCompany();
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
    case 'toggle-mobile-menu':
      state.mobileMenuOpen = !state.mobileMenuOpen;
      render();
      break;
    case 'open-change-password':
      state.profileMenuOpen = false;
      openModal('change-password');
      break;
    case 'open-delete-account':
      openDeleteAccountModal();
      break;
    case 'admin-confirm-suspend': {
      const user = state.admin.users.find((u) => u.id === id);
      if (user) openConfirmAdminSuspend(user);
      break;
    }
    case 'admin-reactivate':
      handleAdminAction('reactivate', id);
      break;
    case 'admin-confirm-delete': {
      const user = state.admin.users.find((u) => u.id === id);
      if (user) openConfirmAdminDelete(user);
      break;
    }
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
  if (state.openIngredientFilterColumn && !event.target.closest('.th-filter')) {
    state.openIngredientFilterColumn = null;
    render();
  }
  if (state.mobileMenuOpen && !event.target.closest('.nav-list') && !event.target.closest('.navbar-menu-toggle')) {
    state.mobileMenuOpen = false;
    render();
  }
  if (event.target.classList.contains('modal-overlay')) {
    closeModal();
  }
});

// Avisa também ao fechar a aba ou recarregar a página com alterações não salvas.
window.addEventListener('beforeunload', (event) => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});

render();
