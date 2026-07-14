import { calculatePricing, calculateIngredientCost, formatCurrency } from './pricing.js';
import { signUp, signIn, signOut, getSession, onAuthStateChange, changePassword, updateEmail } from './auth.js';
import { parseRoute, navigate, onRouteChange } from './router.js';
import { compressImageToWebp } from './imageCompression.js';
import { lookupCep } from './cep.js';
import * as db from './db.js';

// Verificação de captcha no cadastro (evita contas automatizadas em massa) —
// a validação de verdade acontece no lado do Supabase (Authentication >
// Attack protection), que precisa ter a secret key correspondente
// configurada lá; aqui só renderizamos o widget e mandamos o token junto do
// signUp.
const RECAPTCHA_SITE_KEY = '6LdyZlItAAAAAK3jDCs3bvwYVjhFexmQvhNa0ASc';

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

// Vira âncora de seção (categoria do cardápio público) — só letras/números,
// sem acento, hífen no resto.
function slugify(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function toNumberSafe(value) {
  const normalized = String(value ?? '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Formata um número (vindo do banco, ex.: 126.99) pro padrão brasileiro de
// exibição em input editável (126,99) — sem isso, um valor preenchido
// automaticamente a partir de um número já salvo mostrava o ponto do
// JavaScript em vez da vírgula que o resto do app usa.
function toDecimalString(value) {
  const num = typeof value === 'number' ? value : toNumberSafe(value);
  return num ? String(num).replace('.', ',') : '';
}

// Máscara de dinheiro (padrão PDV/app de banco): os dígitos digitados
// preenchem da direita pra esquerda, os 2 últimos sempre viram os centavos —
// assim "2400" já aparece como "24,00" sem o usuário precisar digitar a
// vírgula. Aplicada em todo input dentro de um .input-prefix (ver listener
// de 'input' mais abaixo), então cobre tanto campos controlados (data-field/
// data-ingredient-field/data-modal-field) quanto os lidos via FormData no
// submit — a máscara mexe direto no value do elemento antes de qualquer um
// desses caminhos ler o valor.
function applyMoneyMask(input) {
  const digits = input.value.replace(/\D/g, '');
  input.value = digits ? (Number(digits) / 100).toFixed(2).replace('.', ',') : '';
  input.setSelectionRange(input.value.length, input.value.length);
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('pt-BR');
}

// Nome de exibição para contas sem "nome completo" salvo: deriva algo
// apresentável do e-mail em vez de mostrar o endereço cru.
function nameFromEmail(email) {
  const prefix = String(email ?? '').split('@')[0];
  return prefix.replace(/[._-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

// ---------------- Planos (teste grátis / básico / controle / vitrine) ------
// Sem checkout automático ainda (Mercado Pago pendente): o teste grátis dá
// acesso nível Básico por 7 dias; expirado sem plano pago, o acesso fica
// bloqueado. A troca de plano é manual (banco de dados) até o checkout
// existir — por isso o botão de upgrade só mostra uma mensagem.
// Controle e Vitrine compartilham os recursos "avançados" (fornecedores,
// clientes, gestão da empresa, receitas ilimitadas) — Vitrine só acrescenta
// o cardápio público por cima, então é sempre um superconjunto de Controle.
const CONTROLE_ONLY_ROUTES = { fornecedores: 'Fornecedores', clientes: 'Clientes', empresa: 'Empresa' };
const FREE_RECIPE_LIMIT = 5;
const FREE_PROFIT_TIER_LIMIT = 1;

function planStatus(profile) {
  if (profile.plan === 'trial') {
    return profile.trialEndsAt && new Date(profile.trialEndsAt) > new Date() ? 'trial' : 'expired';
  }
  return profile.plan; // 'basico' | 'controle' | 'vitrine'
}

function isControlePlan(profile) {
  const status = planStatus(profile);
  return status === 'controle' || status === 'vitrine';
}

function isVitrinePlan(profile) {
  return planStatus(profile) === 'vitrine';
}

function trialDaysLeft(profile) {
  if (!profile.trialEndsAt) return 0;
  const ms = new Date(profile.trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// Recurso do plano Controle: lembrete pra revisar os preços das receitas a
// cada 30 dias (custos de ingrediente/despesa podem ter mudado desde a
// última vez). Conta a partir da última revisão marcada ou, se nunca
// marcou, da criação da conta.
const PRICE_REVIEW_INTERVAL_DAYS = 30;

function pricesNeedReview(profile) {
  if (!isControlePlan(profile)) return false;
  const reference = profile.lastPriceReviewAt || profile.createdAt;
  if (!reference) return false;
  const days = (Date.now() - new Date(reference).getTime()) / (24 * 60 * 60 * 1000);
  return days >= PRICE_REVIEW_INTERVAL_DAYS;
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
    // Campos do cardápio público (recurso do plano Vitrine) — ver renderMenuFields.
    menuCategory: '',
    menuDescription: '',
    menuPrice: '',
    // Nome do nível de lucro escolhido como preço no cardápio, ou 'custom'
    // quando o usuário prefere digitar um valor à parte dos sugeridos.
    menuPriceTier: '',
    menuPublished: false,
    errors: {},
  };
}

const state = {
  session: null,
  authMode: 'signin',
  authError: '',
  authLoading: false,
  cookieConsent: localStorage.getItem('cookieConsent') === 'accepted',

  route: { path: 'inicio', param: undefined },

  savedIngredients: [],
  savedProducts: [],
  selectedProducts: new Set(),
  expenseCategories: [],
  profitTiers: [],
  suppliers: [],
  customers: [],
  dataLoading: false,
  statusMessage: '',
  detailSnapshot: '{}',
  settingsSnapshot: '{}',
  companySnapshot: '{}',
  pendingAction: null,
  ingredientSearch: '',
  supplierSearch: '',
  productSearch: '',
  customerSearch: '',
  ingredientColumnFilters: {},
  openIngredientFilterColumn: null,

  // Falso até o primeiro carregamento do perfil de verdade (ver
  // loadUserData): enquanto isso, o profile abaixo é só um placeholder, e
  // shellHtml() não deve usá-lo pra decidir aprovação/trial (ver
  // profileLoaded em shellHtml).
  profileLoaded: false,
  profile: { fullName: '', role: 'user', approvalStatus: 'approved', plan: 'trial', trialEndsAt: null },
  settings: { fullName: '', email: '' },
  company: {
    name: '', cnpj: '',
    cep: '', street: '', neighborhood: '', city: '', state: '', number: '', complement: '',
    ifoodUrl: '', link99Url: '', keetaUrl: '',
    logoUrl: '', logoFile: null, logoPreviewUrl: '', slug: '',
  },
  cepLookup: { loading: false, error: '' },
  publicMenu: { slug: null, loading: false, company: null, products: [], error: '' },
  menuLightboxUrl: null,
  profileMenuOpen: false,
  mobileMenuOpen: false,
  openNavMenu: null,
  adminAlertsOpen: false,
  priceReviewAlertOpen: false,
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
    const profile = await db.getProfile(userId);
    state.profile = {
      fullName: profile.full_name || '',
      role: profile.role || 'user',
      approvalStatus: profile.approval_status || 'approved',
      plan: profile.plan || 'trial',
      trialEndsAt: profile.trial_ends_at || null,
      planBillingCycle: profile.plan_billing_cycle || null,
      planRenewsAt: profile.plan_renews_at || null,
      createdAt: profile.created_at || null,
      lastPriceReviewAt: profile.last_price_review_at || null,
    };
    state.profileLoaded = true;
    // Conta ainda não aprovada pelo super admin: não carrega o resto dos
    // dados nem libera o app — só a tela de "aguardando aprovação".
    if (state.profile.role !== 'admin' && state.profile.approvalStatus !== 'approved') {
      return;
    }
    const [ingredients, products, expenseCategories, profitTiers, suppliers, customers] = await Promise.all([
      db.listIngredients(userId),
      db.listProducts(userId),
      db.ensureDefaultExpenseCategories(userId),
      db.ensureDefaultProfitTiers(userId, isControlePlan(state.profile) ? 3 : FREE_PROFIT_TIER_LIMIT),
      db.listSuppliers(userId),
      db.listCustomers(userId),
    ]);
    state.savedIngredients = ingredients;
    state.savedProducts = products;
    state.expenseCategories = expenseCategories;
    state.profitTiers = profitTiers;
    state.suppliers = suppliers;
    state.customers = customers;
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
      logoUrl: profile.logo_url || '',
      logoFile: null,
      logoPreviewUrl: '',
      slug: profile.slug || '',
    };
    state.settingsSnapshot = JSON.stringify(state.settings);
    state.companySnapshot = companySnapshotOf(state.company);
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
        packagePrice: toDecimalString(item.package_price),
        packageAmount: toDecimalString(item.package_amount),
        usedAmount: toDecimalString(item.used_amount),
        unit: item.unit,
      })),
      photoUrl: product.photo_url || '',
      photoFile: null,
      photoPreviewUrl: '',
      menuCategory: product.category || '',
      menuDescription: product.description || '',
      menuPrice: product.menu_price ? toDecimalString(product.menu_price) : '',
      menuPriceTier: '',
      menuPublished: Boolean(product.published),
      errors: {},
    };
    // Preço no cardápio nasce como um select com os níveis de lucro já
    // cadastrados (ver renderMenuFields); aqui só decidimos qual opção vem
    // pré-selecionada: o nível cujo preço bate com o salvo, "Informar outro
    // preço" se o valor salvo não bate com nenhum nível, ou o primeiro nível
    // (preenchendo o preço) quando a receita ainda não tem preço definido.
    const pricing = pricingFor(state.detail);
    const savedPrice = toNumberSafe(state.detail.menuPrice);
    if (savedPrice > 0) {
      const match = pricing.tiers.find((tier) => Math.abs(tier.unitPrice - savedPrice) < 0.005);
      state.detail.menuPriceTier = match ? match.name : 'custom';
    } else if (pricing.tiers.length > 0) {
      state.detail.menuPriceTier = pricing.tiers[0].name;
      state.detail.menuPrice = toDecimalString(pricing.tiers[0].unitPrice);
    } else {
      state.detail.menuPriceTier = 'custom';
    }
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
  state.openNavMenu = null;
  // Evita que um erro/aviso de uma página (ex.: limite de receitas) continue
  // aparecendo depois que o usuário já navegou pra outro lugar.
  state.statusMessage = '';
  if (!state.session) {
    if (route.path === 'cadastro') state.authMode = 'signup';
    if (route.path === 'entrar') state.authMode = 'signin';
  }
  if (route.path === 'produto' && route.param && state.detail.productId !== route.param) {
    ensureDetailLoaded(route.param);
    return;
  }
  // Cardápio público: acessível independente de sessão (o próprio lojista
  // também pode estar logado ao clicar em "Ver cardápio"), então não passa
  // pelas checagens de auth abaixo.
  if (route.path === 'cardapio') {
    if (route.param && state.publicMenu.slug !== route.param) ensurePublicMenuLoaded(route.param);
    else render();
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
    if (action === 'approve') await db.adminApproveUser(userId);
    if (action === 'suspend') await db.adminSuspendUser(userId);
    if (action === 'reactivate') await db.adminReactivateUser(userId);
    if (action === 'delete') await db.adminDeleteUser(userId);
    await loadAdminUsers();
    showSuccess(
      action === 'approve' ? 'Acesso aprovado.'
        : action === 'suspend' ? 'Usuário suspenso.'
          : action === 'reactivate' ? 'Usuário reativado.' : 'Usuário excluído.',
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
    state.customers = [];
    state.ingredientSearch = '';
    state.supplierSearch = '';
    state.productSearch = '';
    state.customerSearch = '';
    state.ingredientColumnFilters = {};
    state.openIngredientFilterColumn = null;
    state.profileLoaded = false;
    state.profile = { fullName: '', role: 'user', approvalStatus: 'approved', plan: 'trial', trialEndsAt: null };
    state.settings = { fullName: '', email: '' };
    state.settingsSnapshot = '{}';
    state.company = {
      name: '', cnpj: '',
      cep: '', street: '', neighborhood: '', city: '', state: '', number: '', complement: '',
      ifoodUrl: '', link99Url: '', keetaUrl: '',
      logoUrl: '', logoFile: null, logoPreviewUrl: '', slug: '',
    };
    state.companySnapshot = '{}';
    state.cepLookup = { loading: false, error: '' };
    state.profileMenuOpen = false;
    state.mobileMenuOpen = false;
  }
  render();
});

// ---------------- Modais (sucesso / edição) ----------------

function showSuccess(message, duration = 1800) {
  state.successModal = message;
  render();
  setTimeout(() => {
    if (state.successModal === message) {
      state.successModal = '';
      render();
    }
  }, duration);
}

// Cada re-render (a cada tecla digitada, por exemplo) recria o DOM do modal
// do zero, o que replicaria a animação de entrada (fade/pop) a cada
// keystroke e dava a impressão de tela "piscando". Essa flag marca se o
// modal atualmente aberto já tocou a animação uma vez, para as próximas
// renderizações do mesmo modal pularem a animação.
let modalHasAnimatedIn = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openModal(type, data = {}) {
  // Se o mesmo modal já estiver aberto (ex.: duplo clique/toque no botão que
  // abre), só atualiza os dados em vez de reabrir — reabrir reiniciava a
  // animação de entrada, dando a impressão de que o modal "pisca"/aparece
  // duas vezes.
  if (state.activeModal?.type === type) {
    state.activeModal = { ...state.activeModal, error: '', loading: false, ...data };
    render();
    return;
  }
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
    menuCategory: editor.menuCategory,
    menuDescription: editor.menuDescription,
    menuPrice: editor.menuPrice,
    menuPriceTier: editor.menuPriceTier,
    menuPublished: editor.menuPublished,
  });
}

// Mesma ideia acima, mas pra Empresa — logoFile é um Blob (não serializa de
// forma útil), então vira só um booleano "trocou o logotipo".
function companySnapshotOf(company) {
  return JSON.stringify({ ...company, logoFile: Boolean(company.logoFile), logoPreviewUrl: undefined });
}

// Só as páginas com um "Salvar alterações" persistente entram na checagem:
// edição de receita, configurações e empresa. Despesas, lucro, ingredientes
// e fornecedores salvam na hora (modal), sem estado "não salvo" para checar.
function hasUnsavedChanges() {
  if (state.route.path === 'produto') return detailSnapshotOf(state.detail) !== state.detailSnapshot;
  if (state.route.path === 'configuracoes') return JSON.stringify(state.settings) !== state.settingsSnapshot;
  if (state.route.path === 'empresa') return companySnapshotOf(state.company) !== state.companySnapshot;
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
  upload: '<path d="M12 15V4"/><path d="M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
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
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  arrowUpRight: '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
  storefront: '<path d="M4 9l1.2-4.5A1 1 0 0 1 6.2 4h11.6a1 1 0 0 1 1 .75L20 9"/><path d="M4 9h16v2a2 2 0 0 1-2 2h0a2 2 0 0 1-2-2 2 2 0 0 1-2 2h0a2 2 0 0 1-2-2 2 2 0 0 1-2 2h0a2 2 0 0 1-2-2 2 2 0 0 1-2 2h0a2 2 0 0 1-2-2V9Z"/><path d="M5 13v7h14v-7"/><path d="M10 20v-4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V20"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none"/>',
  facebook: '<path d="M14 8.5h2.5V5H14c-2.2 0-4 1.8-4 4v2H8v3.5h2V21h3.5v-6.5H16l.5-3.5h-3V9c0-.5.5-.5.5-.5Z"/>',
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
  return `<div class="banner"><img src="/assets/background/bg-login.webp" alt="" class="banner-photo" /><div class="banner-overlay"></div><div class="banner-inner"><div class="banner-content"><p class="eyebrow">Doce Preço</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></div></div>`;
}

// Cabeçalho padrão com foto pra cada página interna (Receitas, Ingredientes,
// Despesas, Lucro, Fornecedores, Clientes, Empresa...): mesma ideia do
// banner da Home, só que mais baixo e com o título/ação no lugar do
// section-header simples.
function pageBanner(eyebrow, title, actionsHtml = '') {
  return `<div class="page-banner">
    <img src="/assets/img/pexels-anntarazevich-6035994.webp" alt="" class="page-banner-photo" />
    <div class="page-banner-overlay"></div>
    <div class="page-banner-inner">
      <div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2></div>
      ${actionsHtml}
    </div>
  </div>`;
}

function statusBox() {
  return state.statusMessage ? `<p class="status-message">${escapeHtml(state.statusMessage)}</p>` : '';
}

// SVGs animados (SMIL) exportados de um pacote de ícones — o Chromium não
// decodifica esse tipo de SVG quando usado via <img>/<object> (a animação
// simplesmente não aparece, fica em branco), só quando faz parte de verdade
// do documento. Por isso injetamos o markup inline via fetch (ver
// hydrateInlineSvgs) em vez de referenciar o arquivo direto num <img>.
function inlineSvgPlaceholder(tag, className, src) {
  return `<${tag} class="${className}" data-inline-svg="${src}"></${tag}>`;
}

function loadingMsg() {
  return `
    <div class="loading-state" role="status" aria-label="Carregando">
      ${inlineSvgPlaceholder('span', 'loading-whisk', '/assets/icons/cooking-loader.svg')}
      <span class="muted">Carregando...</span>
    </div>`;
}

function emptyState(message, showCta) {
  return `<div class="empty-state">
    ${inlineSvgPlaceholder('div', 'empty-state-illustration', '/assets/icons/cooking-illustration.svg')}
    <p>${escapeHtml(message)}</p>${showCta ? '<button type="button" data-action="start-wizard">Criar receita</button>' : ''}
  </div>`;
}

// Ação de "adicionar mais uma linha" (ingrediente, despesa...): um link
// discreto com ícone de + em vez de um botão cheio, usado em qualquer lista
// editável do projeto.
function addRowLink(label, action, editorKey = '') {
  return `<button type="button" class="add-row-link" data-action="${action}"${editorKey ? ` data-editor="${editorKey}"` : ''}>${icon('plus')}<span>${label}</span></button>`;
}

// Cabeçalho padrão de página de base (Configurações, Empresa...): botão
// "Salvar alterações" à direita, desabilitado até o formulário ficar "sujo".
function pageHeaderWithSave(eyebrow, title, saveAction, isDirty) {
  return `${pageBanner(eyebrow, title)}
    <div class="action-row">
      <button type="button" class="save-action-btn" data-action="${saveAction}" ${isDirty ? '' : 'disabled'}>Salvar alterações</button>
    </div>
    ${mobileSaveBar(saveAction, isDirty)}`;
}

// No mobile, o botão "Salvar alterações" some do lugar de origem (ver
// .save-action-btn) e reaparece fixado no final da tela só quando há
// alteração pendente — evita ter que rolar até o topo pra salvar.
function mobileSaveBar(saveAction, isDirty) {
  if (!isDirty) return '';
  return `<div class="mobile-save-bar"><button type="button" data-action="${saveAction}">Salvar alterações</button></div>`;
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

// Campos do cardápio público (recurso do plano Vitrine): categoria, descrição,
// preço de exibição e o interruptor de publicação por receita.
function renderMenuFields(editorKey, editor) {
  const pricing = pricingFor(editor);
  const isCustomPrice = editor.menuPriceTier === 'custom' || pricing.tiers.length === 0;
  return `
    <p class="muted">Preencha e ative "Publicar no cardápio" para essa receita aparecer no seu cardápio online (ver link na página Empresa).</p>
    <div class="field-grid">
      <label>Categoria<input data-editor="${editorKey}" data-field="menuCategory" value="${escapeHtml(editor.menuCategory)}" placeholder="Ex.: Bolos, Doces, Salgados" /></label>
      <label>Preço no cardápio
        <select data-editor="${editorKey}" data-field="menuPriceTier">
          ${pricing.tiers.map((tier) => `<option value="${escapeHtml(tier.name)}" ${editor.menuPriceTier === tier.name ? 'selected' : ''}>${escapeHtml(tier.name)} — ${formatCurrency(tier.unitPrice)}</option>`).join('')}
          <option value="custom" ${isCustomPrice ? 'selected' : ''}>Informar outro preço</option>
        </select>
      </label>
    </div>
    ${isCustomPrice ? `
    <div class="input-prefix" style="margin-top:16px;">
      <span class="prefix">R$</span>
      <input inputmode="decimal" placeholder="0,00" data-editor="${editorKey}" data-field="menuPrice" value="${escapeHtml(editor.menuPrice)}" />
    </div>` : ''}
    <label style="margin-top:16px;">Descrição<textarea data-editor="${editorKey}" data-field="menuDescription" rows="3" placeholder="Uma breve descrição que aparece na página do produto">${escapeHtml(editor.menuDescription)}</textarea></label>
    <label class="consent-field consent-field-inline" style="margin-top:16px;">
      <input type="checkbox" data-action="toggle-menu-published" ${editor.menuPublished ? 'checked' : ''} />
      <span>Publicar no cardápio</span>
    </label>`;
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
// Usado só no wizard (receita ainda sendo montada) — a receita já salva
// mostra a tabela somente leitura (readOnlyIngredientsTable), sem esse combobox.
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
// Receita já salva (editorKey "detail"): a tabela vira só leitura, com o
// custo proporcional já usado (preço x qtd. usada/qtd. comprada) por linha.
// Preço/qtd./unidade do ingrediente são dados da base — editar aqui criaria
// um valor "congelado" divergente da base, que é a fonte única desses dados.
// Só dá pra excluir a linha; qualquer ajuste de preço/embalagem é feito na
// base de Ingredientes e reflete em todas as receitas que o usam.
function readOnlyIngredientsTable(editorKey, visible) {
  const addLink = addRowLink('Adicionar ingrediente', 'add-ingredient', editorKey);
  return `
  <div class="table-scroll">
  <table class="data-table">
    <thead><tr><th>Ingrediente</th><th>Preço da compra</th><th>Qtd. comprada</th><th>Qtd. usada</th><th>Un.</th><th>Preço utilizado</th><th></th></tr></thead>
    <tbody>
      ${visible.map((ingredient) => {
        const usedCost = calculateIngredientCost(ingredient);
        return `
        <tr data-ingredient="${ingredient.id}">
          <td>${escapeHtml(ingredient.name)}</td>
          <td>${formatCurrency(toNumberSafe(ingredient.packagePrice))}</td>
          <td>${escapeHtml(ingredient.packageAmount)}</td>
          <td>${escapeHtml(ingredient.usedAmount)}</td>
          <td>${escapeHtml(ingredient.unit)}</td>
          <td>${formatCurrency(usedCost)}</td>
          <td class="data-table-actions"><button class="ghost" type="button" data-action="remove-ingredient" data-editor="${editorKey}" data-id="${ingredient.id}">Excluir</button></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  </div>
  ${addLink}`;
}

function ingredientsTable(editorKey, ingredients, invalidIds = new Set()) {
  const visible = ingredients.filter((i) => !i.draft);
  const addLink = addRowLink('Adicionar ingrediente', 'add-ingredient', editorKey);
  if (visible.length === 0) {
    return `${emptyState('Nenhum ingrediente adicionado ainda.', false)}${addLink}`;
  }
  if (editorKey === 'detail') return readOnlyIngredientsTable(editorKey, visible);
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
    ${pricing.tiers.map((tier) => {
      const featured = tier.name.trim().toLowerCase() === 'média';
      return `
      <div class="tier-row ${featured ? 'tier-featured' : ''}">
        <div class="tier-header">
          <strong class="tier-name">${escapeHtml(tier.name)}</strong>
          ${featured ? '<span class="tier-badge">Sugerido</span>' : ''}
        </div>
        <div class="tier-stats">
          <div class="tier-stat"><span>Preço un.</span><strong>${formatCurrency(tier.unitPrice)}</strong></div>
          <div class="tier-stat"><span>Preço/forma</span><strong>${formatCurrency(tier.totalPrice)}</strong></div>
          <div class="tier-stat tier-stat-profit"><span>Lucro líq. un.</span><strong>${formatCurrency(tier.netProfitUnit)}</strong></div>
          <div class="tier-stat tier-stat-profit"><span>Lucro líq. total</span><strong>${formatCurrency(tier.netProfitTotal)}</strong></div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// Por ingrediente: peso/valor total comprado (dado da base) ao lado da
// quantidade e do valor efetivamente usados nessa receita (proporcional).
function ingredientUsageList(editor) {
  const used = editor.ingredients.filter((i) => !i.draft && i.name.trim());
  if (!used.length) return '';
  return `
    <div class="ingredient-usage-list summary-section">
      <h3>Ingredientes usados</h3>
      <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Ingrediente</th><th>Peso/qtd. total</th><th>Valor total</th><th>Qtd. utilizada</th><th>Valor utilizado</th></tr></thead>
        <tbody>
          ${used.map((i) => `
          <tr>
            <td>${escapeHtml(i.name)}</td>
            <td>${escapeHtml(i.packageAmount)}${escapeHtml(i.unit)}</td>
            <td>${formatCurrency(toNumberSafe(i.packagePrice))}</td>
            <td>${escapeHtml(i.usedAmount)}${escapeHtml(i.unit)}</td>
            <td>${formatCurrency(calculateIngredientCost(i))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>
    </div>`;
}

function pricingResultBlock(editor) {
  const pricing = pricingFor(editor);
  return `<aside class="panel summary-panel">
    <p class="eyebrow">Resultado</p><h2>Custo e preços sugeridos</h2>
    <div class="summary-section">
      <h3>Custos</h3>
      <dl>
        <div><dt>Custo dos ingredientes</dt><dd>${formatCurrency(pricing.ingredientsCost)}</dd></div>
        <div><dt>Despesas alocadas</dt><dd>${formatCurrency(pricing.expensesCost)}</dd></div>
        <div><dt>Custo total da receita</dt><dd>${formatCurrency(pricing.totalCost)}</dd></div>
        <div class="highlight"><dt>Custo por unidade</dt><dd>${formatCurrency(pricing.unitCost)}</dd></div>
      </dl>
    </div>
    <div class="summary-section">
      <h3>Preços sugeridos</h3>
      ${tiersTable(pricing)}
    </div>
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

function productsTable(list, { selectable = true } = {}) {
  const allSelected = list.length > 0 && list.every((p) => state.selectedProducts.has(p.id));
  return `<div class="table-scroll"><table class="data-table data-table-clickable data-table-cards-mobile">
    <thead><tr>
      <th>${selectable ? `<input type="checkbox" aria-label="Selecionar todas" data-action="toggle-select-all-products" ${allSelected ? 'checked' : ''} /> ` : ''}Receita</th>
      <th>Qnt. por forma</th><th>Preço un.</th><th></th>
    </tr></thead>
    <tbody>
      ${list.map((product) => {
        const pricing = pricingForProduct(product);
        const mainTier = pricing.tiers.find((t) => t.name === 'Média') || pricing.tiers[0];
        const priceUn = mainTier ? formatCurrency(mainTier.unitPrice) : formatCurrency(pricing.unitCost);
        const checked = state.selectedProducts.has(product.id);
        return `
        <tr data-action="open-produto" data-id="${product.id}">
          <td>
            <div class="table-row-title">
              ${selectable ? `<input type="checkbox" aria-label="Selecionar receita" data-action="toggle-select-product" data-id="${product.id}" ${checked ? 'checked' : ''} />` : ''}
              ${product.photo_url
                ? `<img class="item-avatar item-avatar-photo" src="${escapeHtml(product.photo_url)}" alt="" />`
                : `<span class="item-avatar" style="background:${avatarColorFor(product.name)}">${escapeHtml(product.name.trim().charAt(0).toUpperCase() || '?')}</span>`}
              <strong>${escapeHtml(product.name)}</strong>
            </div>
          </td>
          <td data-label="Qnt. por forma">${product.yield_amount} un.</td>
          <td data-label="Preço un.">${priceUn}</td>
          <td class="data-table-actions">
            <button type="button" class="ghost" data-action="open-produto" data-id="${product.id}">Editar</button>
            <button type="button" class="ghost" data-action="delete-product" data-id="${product.id}" data-name="${escapeHtml(product.name)}">Excluir</button>
          </td>
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
    <label class="photo-dropzone ${previewSrc ? 'has-preview' : ''}" data-photo-drop="${editorKey}">
      <input type="file" accept="image/*" data-photo-input="${editorKey}" hidden />
      ${previewSrc
        ? `<img src="${previewSrc}" alt="Prévia da foto da receita" class="photo-preview" />
          <div class="photo-dropzone-text"><strong>Trocar foto</strong><span>PNG ou JPG</span></div>`
        : `<div class="photo-dropzone-icon">${icon('upload')}</div>
          <div class="photo-dropzone-text">
            <p>Arraste uma foto aqui ou <strong>clique para enviar</strong></p>
            <span>PNG ou JPG</span>
          </div>`}
    </label>`;
}

// Logotipo da empresa: mesmo componente visual do upload de foto de receita,
// mas com seus próprios data-attributes (data-logo-*) já que não há um
// "editor" (wizard/detail) por trás — o alvo é sempre state.company.
function logoUploadField() {
  const previewSrc = state.company.logoPreviewUrl || state.company.logoUrl || '';
  return `
    <label class="photo-dropzone logo-dropzone ${previewSrc ? 'has-preview' : ''}" data-logo-drop>
      <input type="file" accept="image/*" data-logo-input hidden />
      ${previewSrc
        ? `<div class="photo-preview-wrap">
            <img src="${previewSrc}" alt="Prévia do logotipo" class="photo-preview" />
            <span class="photo-preview-edit">${icon('pencil')}</span>
          </div>
          <div class="photo-dropzone-text"><strong>Trocar logotipo</strong><span>PNG ou JPG</span></div>`
        : `<div class="photo-dropzone-icon">${icon('upload')}</div>
          <div class="photo-dropzone-text">
            <p>Arraste um logotipo aqui ou <strong>clique para enviar</strong></p>
            <span>PNG ou JPG</span>
          </div>`}
    </label>`;
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
        <label>Nome da despesa<input name="name" data-modal-field="name" value="${escapeHtml(data.name || '')}" required /></label>
        <div class="field-grid">
          <label>Valor mensal<div class="input-prefix"><span class="prefix">R$</span><input name="monthlyValue" inputmode="decimal" placeholder="0,00" data-modal-field="monthlyValue" value="${escapeHtml(data.monthlyValue || '')}" /></div></label>
          <label>% por receita<input name="percentage" inputmode="decimal" data-modal-field="percentage" value="${escapeHtml(data.percentage ?? '1')}" required /></label>
        </div>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Adicionando...' : 'Adicionar despesa'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function editExpenseModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Editar despesa</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="edit-expense" class="modal-form">
        <label>Nome da despesa<input name="name" value="${escapeHtml(data.name)}" required /></label>
        <div class="field-grid">
          <label>Valor mensal<div class="input-prefix"><span class="prefix">R$</span><input name="monthlyValue" inputmode="decimal" placeholder="0,00" value="${escapeHtml(data.monthlyValue)}" /></div></label>
          <label>% por receita<input name="percentage" inputmode="decimal" value="${escapeHtml(data.percentage)}" required /></label>
        </div>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Salvando...' : 'Salvar alterações'}</button>
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
      ${data.successMessage ? `<p class="auth-success">${escapeHtml(data.successMessage)}</p>` : ''}
      <form data-form="new-ingredient" class="modal-form">
        <label>Nome<input name="name" data-modal-field="name" value="${escapeHtml(data.name || '')}" required /></label>
        <div class="field-grid">
          <label>Preço da compra<div class="input-prefix"><span class="prefix">R$</span><input name="packagePrice" inputmode="decimal" placeholder="0,00" data-modal-field="packagePrice" value="${escapeHtml(data.packagePrice || '')}" required /></div></label>
          <label>Qtd. comprada<input name="packageAmount" inputmode="decimal" placeholder="Kg/Gramas" data-modal-field="packageAmount" value="${escapeHtml(data.packageAmount || '')}" required /></label>
        </div>
        <div class="field-grid">
          <label>Unidade<input name="unit" placeholder="Ex: ml, g, un." data-modal-field="unit" value="${escapeHtml(data.unit || '')}" required /></label>
          <label>Categoria<input name="category" data-modal-field="category" value="${escapeHtml(data.category || '')}" /></label>
        </div>
        <label>Marca<input name="brand" data-modal-field="brand" value="${escapeHtml(data.brand || '')}" /></label>
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
        <label>Nome<input name="name" data-modal-field="name" value="${escapeHtml(data.name || '')}" required /></label>
        <div class="field-grid">
          <label>Telefone<input name="phone" data-modal-field="phone" value="${escapeHtml(data.phone || '')}" /></label>
          <label>E-mail<input name="email" type="email" data-modal-field="email" value="${escapeHtml(data.email || '')}" /></label>
        </div>
        <label>Endereço<input name="address" data-modal-field="address" value="${escapeHtml(data.address || '')}" /></label>
        <div class="field-grid">
          <label>Site<input name="site" data-modal-field="site" value="${escapeHtml(data.site || '')}" /></label>
          <label>Contato<input name="contact_name" data-modal-field="contact_name" value="${escapeHtml(data.contact_name || '')}" /></label>
        </div>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Adicionando...' : 'Adicionar'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function editSupplierModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Editar fornecedor</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="edit-supplier" class="modal-form">
        <label>Nome<input name="name" value="${escapeHtml(data.name)}" required /></label>
        <div class="field-grid">
          <label>Telefone<input name="phone" value="${escapeHtml(data.phone)}" /></label>
          <label>E-mail<input name="email" type="email" value="${escapeHtml(data.email)}" /></label>
        </div>
        <label>Endereço<input name="address" value="${escapeHtml(data.address)}" /></label>
        <div class="field-grid">
          <label>Site<input name="site" value="${escapeHtml(data.site)}" /></label>
          <label>Contato<input name="contact_name" value="${escapeHtml(data.contact_name)}" /></label>
        </div>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Salvando...' : 'Salvar alterações'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function addCustomerModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Adicionar cliente</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="new-customer" class="modal-form">
        <label>Nome<input name="name" data-modal-field="name" value="${escapeHtml(data.name || '')}" required /></label>
        <div class="field-grid">
          <label>Telefone<input name="phone" data-modal-field="phone" value="${escapeHtml(data.phone || '')}" /></label>
          <label>E-mail<input name="email" type="email" data-modal-field="email" value="${escapeHtml(data.email || '')}" /></label>
        </div>
        <label>Observações<input name="notes" data-modal-field="notes" value="${escapeHtml(data.notes || '')}" placeholder="Preferências, alergias, etc." /></label>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Adicionando...' : 'Adicionar'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function editCustomerModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Editar cliente</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="edit-customer" class="modal-form">
        <label>Nome<input name="name" value="${escapeHtml(data.name)}" required /></label>
        <div class="field-grid">
          <label>Telefone<input name="phone" value="${escapeHtml(data.phone)}" /></label>
          <label>E-mail<input name="email" type="email" value="${escapeHtml(data.email)}" /></label>
        </div>
        <label>Observações<input name="notes" value="${escapeHtml(data.notes)}" placeholder="Preferências, alergias, etc." /></label>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Salvando...' : 'Salvar alterações'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function addTierModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Adicionar nível de lucro</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="add-tier" class="modal-form">
        <label>Nome do nível<input name="name" placeholder="Ex.: Promoção" data-modal-field="name" value="${escapeHtml(data.name || '')}" required /></label>
        <label>Margem<div class="input-suffix"><input name="multiplierPercent" inputmode="decimal" placeholder="0" data-modal-field="multiplierPercent" value="${escapeHtml(data.multiplierPercent || '')}" required /><span class="suffix">%</span></div></label>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Adicionando...' : 'Adicionar'}</button>
          <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
        </div>
      </form>
    </div>`;
}

function editTierModal(data) {
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>Editar nível de lucro</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <form data-form="edit-tier" class="modal-form">
        <label>Nome do nível<input name="name" value="${escapeHtml(data.name)}" required /></label>
        <label>Margem<div class="input-suffix"><input name="multiplierPercent" inputmode="decimal" value="${escapeHtml(data.multiplierPercent)}" required /><span class="suffix">%</span></div></label>
        <div class="save-actions">
          <button type="submit" ${data.loading ? 'disabled' : ''}>${data.loading ? 'Salvando...' : 'Salvar alterações'}</button>
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
// botão de confirmação é configurável; por padrão é "Excluir". Quando
// data.confirmText é definido (ex.: exclusão de usuário no admin), o botão
// de confirmar só libera depois de digitar exatamente esse texto — barreira
// extra contra clique acidental numa ação irreversível.
function confirmDeleteModal(data) {
  const confirmLabel = data.confirmLabel || 'Excluir';
  const confirmLoadingLabel = data.confirmLoadingLabel || 'Excluindo...';
  const needsTypedConfirm = Boolean(data.confirmText);
  const typedMatches = !needsTypedConfirm || data.confirmInput === data.confirmText;
  return `
    <div class="modal-box">
      <div class="modal-header"><h3>${escapeHtml(data.title)}</h3><button type="button" class="icon-btn ghost" data-action="close-modal">${icon('close')}</button></div>
      ${data.error ? `<p class="auth-error">${escapeHtml(data.error)}</p>` : ''}
      <p>${escapeHtml(data.message)}</p>
      ${needsTypedConfirm ? `
      <label style="margin-top:16px;">Digite "${escapeHtml(data.confirmText)}" para confirmar
        <input data-modal-field="confirmInput" value="${escapeHtml(data.confirmInput || '')}" autocomplete="off" />
      </label>` : ''}
      <div class="save-actions">
        <button type="button" class="danger" data-action="confirm-delete" ${data.loading || !typedMatches ? 'disabled' : ''}>${data.loading ? confirmLoadingLabel : confirmLabel}</button>
        <button type="button" class="ghost" data-action="close-modal">Cancelar</button>
      </div>
    </div>`;
}

function modalOverlay() {
  if (state.successModal) {
    return `<div class="modal-overlay">
      <div class="modal-box modal-success">
        <div class="success-icon">
          ${icon('cupcake')}
          <span class="success-icon-badge">${icon('check')}</span>
        </div>
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
    'edit-expense': editExpenseModal,
    'confirm-delete': confirmDeleteModal,
    'add-ingredient': addIngredientModal,
    'add-supplier': addSupplierModal,
    'edit-supplier': editSupplierModal,
    'add-customer': addCustomerModal,
    'edit-customer': editCustomerModal,
    'add-tier': addTierModal,
    'edit-tier': editTierModal,
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
  { key: 'ifoodUrl', label: 'iFood', logo: '/assets/parceiros/logo-ifood.png' },
  { key: 'link99Url', label: '99', logo: '/assets/parceiros/logo-99-food.png' },
  { key: 'keetaUrl', label: 'Keeta', logo: '/assets/parceiros/logo-keeta.png' },
];

function deliveryBadge(brand, extraClass = '') {
  return `<img class="delivery-badge ${extraClass}" src="${brand.logo}" alt="${escapeHtml(brand.label)}" />`;
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
        <strong>Precificar novo produto</strong>
        <button type="button" data-action="start-wizard">Começar ${icon('arrow')}</button>
      </div>
    </div>
    <div class="panel">
      <div class="section-header"><h2>Receitas cadastradas</h2></div>
      ${state.dataLoading ? loadingMsg() : (state.savedProducts.length ? productsTable(state.savedProducts, { selectable: false }) : emptyState('Nenhuma receita salva ainda.', true))}
    </div>`;
}

function renderProdutosPage() {
  const selectedCount = state.selectedProducts.size;
  const query = state.productSearch.trim().toLowerCase();
  const filtered = query
    ? state.savedProducts.filter((p) => p.name.toLowerCase().includes(query))
    : state.savedProducts;
  return `
    ${pageBanner('Receitas', 'Suas receitas salvas')}
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
      ${state.savedProducts.length ? `
      <div class="search-row">
        <input class="search-input" type="search" name="productSearch" data-search="products" placeholder="Buscar por nome..." value="${escapeHtml(state.productSearch)}" />
        <button type="button" data-action="start-wizard">+ Nova receita</button>
      </div>` : ''}
      ${state.dataLoading ? loadingMsg() : (
        state.savedProducts.length === 0 ? emptyState('Você ainda não salvou nenhuma receita.', true)
          : filtered.length ? productsTable(filtered) : emptyState('Nenhuma receita encontrada.', false)
      )}
    </div>
  `;
}

function renderProdutoDetalhe(id) {
  if (state.detail.loading || state.detail.productId !== id) return loadingMsg();
  const editor = state.detail;
  const isDirty = detailSnapshotOf(editor) !== state.detailSnapshot;
  return `
    <div class="section-header section-header-sticky">
      <div><p class="eyebrow">Receita</p><h2>${escapeHtml(editor.productName || 'Receita')}</h2></div>
      <div class="section-header-actions">
        <button type="button" class="ghost" data-action="goto" data-route="produtos">Voltar</button>
        <button type="button" class="danger" data-action="delete-detail" data-id="${id}" data-name="${escapeHtml(editor.productName)}">Excluir receita</button>
        <button type="button" class="save-action-btn" data-action="save-detail" ${isDirty ? '' : 'disabled'}>Salvar alterações</button>
      </div>
    </div>
    ${mobileSaveBar('save-detail', isDirty)}
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
    ${isVitrinePlan(state.profile) ? `<div class="panel">
      <h3>Cardápio público</h3>
      ${renderMenuFields('detail', editor)}
    </div>` : ''}
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
    <div class="summary-section">
      <h3>Custos</h3>
      <dl>
        <div><dt>Custo dos ingredientes</dt><dd>${formatCurrency(pricing.ingredientsCost)}</dd></div>
        <div><dt>Despesas alocadas</dt><dd>${formatCurrency(pricing.expensesCost)}</dd></div>
        <div><dt>Custo total</dt><dd>${formatCurrency(pricing.totalCost)}</dd></div>
        <div><dt>Custo por unidade</dt><dd>${formatCurrency(pricing.unitCost)}</dd></div>
      </dl>
    </div>
    ${ingredientUsageList(editor)}
    <div class="summary-section">
      <h3>Preços sugeridos</h3>
      ${tiersTable(pricing)}
    </div>
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
    ? `<div class="table-scroll"><table class="data-table data-table-cards-mobile">
        <thead><tr>${INGREDIENT_COLUMNS.map((column) => filterableTh(column, state.savedIngredients)).join('')}<th></th></tr></thead>
        <tbody>
          ${filtered.map((i) => `
            <tr>
              <td><strong>${escapeHtml(i.name)}</strong></td>
              <td data-label="Categoria">${i.category ? escapeHtml(i.category) : '—'}</td>
              <td data-label="Preço">${formatCurrency(i.package_price)}</td>
              <td data-label="Qtd.">${escapeHtml(String(i.package_amount))}${escapeHtml(i.unit)}</td>
              <td data-label="Marca">${i.brand ? escapeHtml(i.brand) : '—'}</td>
              <td class="data-table-actions">
                <button type="button" class="ghost" data-action="open-edit-ingredient" data-id="${i.id}">Editar</button>
                <button type="button" class="ghost" data-action="delete-saved-ingredient" data-id="${i.id}">Excluir</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>`
    : emptyState(query ? 'Nenhum ingrediente encontrado.' : 'Nenhum ingrediente cadastrado ainda.', false);

  return `
    ${pageBanner('Base de ingredientes', 'Ingredientes e embalagens')}
    ${statusBox()}
    <div class="panel">
      <div class="search-row">
        <input class="search-input" type="search" name="ingredientSearch" data-search="ingredients" placeholder="Buscar por nome, categoria ou marca..." value="${escapeHtml(state.ingredientSearch)}" />
        <button type="button" data-action="add-ingredient-modal">Adicionar novo</button>
      </div>
      ${state.dataLoading ? loadingMsg() : list}
    </div>`;
}

function renderDespesasPage() {
  const total = state.expenseCategories.reduce((sum, e) => sum + toNumberSafe(e.monthly_value) * (toNumberSafe(e.percentage) / 100), 0);
  const list = state.expenseCategories.length > 0
    ? `<div class="table-scroll"><table class="data-table data-table-cards-mobile">
        <thead><tr><th>Despesa</th><th>Valor mensal</th><th>% por receita</th><th>Alocado</th><th></th></tr></thead>
        <tbody>
          ${state.expenseCategories.map((expense) => {
            const allocated = toNumberSafe(expense.monthly_value) * (toNumberSafe(expense.percentage) / 100);
            return `
            <tr>
              <td><strong>${escapeHtml(expense.name)}</strong></td>
              <td data-label="Valor mensal">${formatCurrency(expense.monthly_value)}</td>
              <td data-label="% por receita">${escapeHtml(String(expense.percentage))}%</td>
              <td data-label="Alocado">${formatCurrency(allocated)}</td>
              <td class="data-table-actions">
                <button type="button" class="ghost" data-action="open-edit-expense" data-id="${expense.id}">Editar</button>
                <button type="button" class="ghost" data-action="delete-expense" data-id="${expense.id}">Excluir</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`
    : emptyState('Nenhuma despesa cadastrada ainda.', false);

  return `
    ${pageBanner('Base de despesas', 'Custos fixos mensais')}
    ${statusBox()}
    <div class="panel">
      <div class="action-row">
        <button type="button" data-action="add-expense">Adicionar novo</button>
      </div>
      ${state.dataLoading ? loadingMsg() : list}
      ${state.expenseCategories.length > 0 ? `<p class="status-message" style="margin-top:16px;">Total alocado por receita: <strong>${formatCurrency(total)}</strong></p>` : ''}
      <p class="form-hint" style="margin-top:16px;">Cada despesa é alocada por receita usando o percentual informado (ex.: R$250 de energia × 1% = R$2,50 por receita).</p>
    </div>`;
}

function percentFromMultiplier(multiplier) {
  const percent = toNumberSafe(multiplier) * 100;
  return Number.isInteger(percent) ? String(percent) : String(Math.round(percent * 100) / 100);
}

function renderLucroPage() {
  const list = state.profitTiers.length > 0
    ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Nível</th><th>Margem</th><th></th></tr></thead>
        <tbody>
          ${state.profitTiers.map((tier) => `
            <tr>
              <td>${escapeHtml(tier.name)}</td>
              <td>${escapeHtml(percentFromMultiplier(tier.multiplier))}%</td>
              <td class="data-table-actions">
                <button type="button" class="ghost" data-action="open-edit-tier" data-id="${tier.id}">Editar</button>
                <button type="button" class="ghost" data-action="delete-tier" data-id="${tier.id}">Excluir</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>`
    : emptyState('Nenhum nível de lucro cadastrado ainda.', false);

  return `
    ${pageBanner('Base de lucro', 'Níveis de margem')}
    ${statusBox()}
    <div class="panel">
      <div class="action-row">
        <button type="button" data-action="add-tier">Adicionar novo</button>
      </div>
      ${state.dataLoading ? loadingMsg() : list}
      <p class="form-hint" style="margin-top:16px;">Cada nível multiplica o custo por unidade para sugerir o preço de venda (ex.: margem de 250% = custo × 2,5 no nível Mínimo).</p>
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
              <td class="data-table-actions">
                <button type="button" class="ghost" data-action="open-edit-supplier" data-id="${s.id}">Editar</button>
                <button type="button" class="ghost" data-action="delete-supplier" data-id="${s.id}">Excluir</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>`
    : emptyState(query ? 'Nenhum fornecedor encontrado.' : 'Nenhum fornecedor cadastrado ainda.', false);

  return `
    ${pageBanner('Base de fornecedores', 'Contatos')}
    ${statusBox()}
    <div class="panel">
      <div class="search-row">
        <input class="search-input" type="search" name="supplierSearch" data-search="suppliers" placeholder="Buscar por nome, contato ou e-mail..." value="${escapeHtml(state.supplierSearch)}" />
        <button type="button" data-action="add-supplier-modal">Adicionar novo</button>
      </div>
      ${state.dataLoading ? loadingMsg() : list}
    </div>`;
}

// Gestão de clientes — recurso do plano Controle (ver nota em handleRouteChange
// sobre o gate por plano ainda não existir, já que a cobrança não está
// implementada).
function renderClientesPage() {
  const query = state.customerSearch.trim().toLowerCase();
  const filtered = query
    ? state.customers.filter((c) => c.name.toLowerCase().includes(query)
      || (c.email || '').toLowerCase().includes(query)
      || (c.phone || '').toLowerCase().includes(query))
    : state.customers;
  const list = filtered.length > 0
    ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Nome</th><th>Telefone</th><th>E-mail</th><th></th></tr></thead>
        <tbody>
          ${filtered.map((c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td>${c.phone ? escapeHtml(c.phone) : '—'}</td>
              <td>${c.email ? escapeHtml(c.email) : '—'}</td>
              <td class="data-table-actions">
                <button type="button" class="ghost" data-action="open-edit-customer" data-id="${c.id}">Editar</button>
                <button type="button" class="ghost" data-action="delete-customer" data-id="${c.id}">Excluir</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>`
    : emptyState(query ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.', false);

  return `
    ${pageBanner('Base de clientes', 'Clientes')}
    ${statusBox()}
    <div class="panel">
      <div class="search-row">
        <input class="search-input" type="search" name="customerSearch" data-search="customers" placeholder="Buscar por nome, telefone ou e-mail..." value="${escapeHtml(state.customerSearch)}" />
        <button type="button" data-action="add-customer-modal">Adicionar novo</button>
      </div>
      ${state.dataLoading ? loadingMsg() : list}
    </div>`;
}

// Enquanto não existe checkout automático (Mercado Pago pendente), Básico e
// Pro são ativados manualmente — cobrança/renovação só aparecem quando
// alguém preenche esses campos à mão; sem eles, mostra que foi ativado
// manualmente em vez de inventar uma data.
function planInfoPanel(profile) {
  const status = planStatus(profile);
  const rows = [`<div><dt>Plano atual</dt><dd>${planLabel(profile)}</dd></div>`];
  if (status === 'trial') {
    const days = trialDaysLeft(profile);
    rows.push(`<div><dt>Termina em</dt><dd>${formatDate(profile.trialEndsAt)} (${days === 1 ? '1 dia' : `${days} dias`})</dd></div>`);
  } else {
    const cycleLabel = profile.planBillingCycle === 'mensal' ? 'Mensal' : profile.planBillingCycle === 'anual' ? 'Anual' : '';
    rows.push(cycleLabel
      ? `<div><dt>Cobrança</dt><dd>${cycleLabel}</dd></div>`
      : `<div><dt>Cobrança</dt><dd class="dd-muted">Ativado manualmente pela equipe Doce Preço</dd></div>`);
    if (profile.planRenewsAt) {
      rows.push(`<div><dt>${cycleLabel ? 'Renova em' : 'Vence em'}</dt><dd>${formatDate(profile.planRenewsAt)}</dd></div>`);
    }
  }
  const showUpgrade = status !== 'vitrine';
  return `
    <div class="panel summary-panel">
      <h3>Plano</h3>
      <dl class="plan-dl">${rows.join('')}</dl>
      ${showUpgrade ? `
        <p class="form-hint" style="margin-top:16px;">Desbloqueie receitas ilimitadas, gestão de clientes, cardápio online e mais.</p>
        <button type="button" style="margin-top:12px;" data-action="request-upgrade">Fazer upgrade</button>` : ''}
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
    ${planInfoPanel(state.profile)}
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
  const isDirty = companySnapshotOf(state.company) !== state.companySnapshot;
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
      <h3>Logotipo</h3>
      <p class="muted">Aparece no topo do seu cardápio online. O resto da página (produtos, categorias, rodapé) é sempre automático, direto do seu cadastro.</p>
      ${logoUploadField()}
    </div>
    <div class="panel">
      <h3>Seu cardápio online</h3>
      <p class="muted">Uma vitrine simples com suas receitas marcadas como "Publicar no cardápio" (ver na página de cada receita). Compartilhe o link com seus clientes.</p>
      <div class="menu-link-row">
        <input type="text" readonly value="${escapeHtml(publicMenuUrl(state.company.slug))}" data-action="select-menu-link" />
        <button type="button" class="ghost" data-action="copy-menu-link">Copiar link</button>
        <a class="ghost button-like" href="#/cardapio/${escapeHtml(state.company.slug)}" target="_blank" rel="noopener">Ver cardápio</a>
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

// Rótulo do plano pra tabela do super admin: reaproveita planStatus() já
// que o objeto vindo da edge function tem os mesmos campos (plan/trialEndsAt).
function planLabel(u) {
  const status = planStatus(u);
  if (status === 'vitrine') return '<span class="status-pill status-pill-active">Vitrine</span>';
  if (status === 'controle') return '<span class="status-pill status-pill-active">Controle</span>';
  if (status === 'basico') return '<span class="status-pill status-pill-active">Básico</span>';
  if (status === 'expired') return '<span class="status-pill status-pill-danger">Teste expirado</span>';
  const days = trialDaysLeft(u);
  return `<span class="status-pill status-pill-pending">Teste (${days === 1 ? '1 dia' : `${days} dias`})</span>`;
}

function renderAdminUsersList(users = state.admin.users) {
  const visible = users.filter((u) => u.role !== 'admin');
  if (!visible.length) return emptyState('Nenhum usuário encontrado.', false);
  return `<div class="table-scroll">
  <table class="data-table data-table-cards-mobile">
    <thead><tr><th>Empresa</th><th>Nome</th><th>CNPJ</th><th>Status</th><th>Plano</th><th>Data de criação</th><th></th></tr></thead>
    <tbody>
      ${visible.map((u) => {
        const banned = u.bannedUntil && new Date(u.bannedUntil) > new Date();
        const pending = u.approvalStatus === 'pending';
        const statusClass = pending ? 'status-pill-pending' : banned ? 'status-pill-danger' : 'status-pill-active';
        const statusLabel = pending ? 'Aguardando aprovação' : banned ? 'Suspenso' : 'Ativo';
        return `
        <tr>
          <td>${escapeHtml(u.companyName || '—')}</td>
          <td data-label="Nome">${escapeHtml(u.fullName || u.email)}</td>
          <td data-label="CNPJ">${escapeHtml(u.cnpj || '—')}</td>
          <td data-label="Status"><span class="status-pill ${statusClass}">${statusLabel}</span></td>
          <td data-label="Plano">${planLabel(u)}</td>
          <td data-label="Data de criação">${formatDate(u.createdAt)}</td>
          <td class="data-table-actions">
            ${pending ? `<button type="button" class="primary" data-action="admin-approve" data-id="${u.id}">Aprovar</button>` : ''}
            ${pending ? '' : banned
              ? `<button type="button" class="ghost" data-action="admin-reactivate" data-id="${u.id}">Reativar</button>`
              : `<button type="button" class="ghost" data-action="admin-confirm-suspend" data-id="${u.id}">Suspender</button>`}
            <button type="button" class="danger" data-action="admin-confirm-delete" data-id="${u.id}">Excluir</button>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  </div>`;
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

// Recurso exclusivo do plano Controle: em vez da página real, mostra um
// convite pra upgrade (sem checkout ainda, então o botão só avisa que está
// a caminho — ver "request-upgrade" no dispatch de cliques).
function renderUpgradeGate(routePath) {
  const label = CONTROLE_ONLY_ROUTES[routePath];
  return `
    <div class="panel upgrade-gate">
      <p class="eyebrow">Recurso Controle</p>
      <h2>${escapeHtml(label)} é exclusivo do plano Controle</h2>
      <p>Faça upgrade para o plano Controle e desbloqueie ${escapeHtml(label.toLowerCase())}, receitas ilimitadas e todos os outros recursos.</p>
      ${statusBox()}
      <button type="button" data-action="request-upgrade">Fazer upgrade</button>
    </div>`;
}

function renderPage() {
  // Conta admin só enxerga o painel de usuários (visão de uma página só) —
  // exceto as páginas legais do footer, que continuam acessíveis a todos.
  if (state.profile.role === 'admin' && state.route.path !== 'termos' && state.route.path !== 'privacidade') {
    return renderAdminPage();
  }
  if (CONTROLE_ONLY_ROUTES[state.route.path] && !isControlePlan(state.profile)) {
    return renderUpgradeGate(state.route.path);
  }
  switch (state.route.path) {
    case 'produtos': return renderProdutosPage();
    case 'produto': return renderProdutoDetalhe(state.route.param);
    case 'novo-produto': return renderWizard();
    case 'ingredientes': return renderIngredientesPage();
    case 'despesas': return renderDespesasPage();
    case 'lucro': return renderLucroPage();
    case 'fornecedores': return renderFornecedoresPage();
    case 'clientes': return renderClientesPage();
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

// Agrupa páginas relacionadas num só item de navbar com dropdown, em vez de
// uma lista cada vez mais longa de links soltos.
const NAV_GROUPS = [
  { key: 'controle', label: 'Controle', items: [{ route: 'ingredientes', label: 'Ingredientes' }, { route: 'despesas', label: 'Despesas' }, { route: 'lucro', label: 'Lucro' }] },
];

// "Gestão" precisa ser montado a cada render (não é uma constante estática
// como os outros grupos) porque o item "Site" só existe pra conta Vitrine e
// aponta pro link público da própria empresa (depende do slug carregado).
function gestaoGroup() {
  const items = [{ route: 'clientes', label: 'Clientes' }, { route: 'empresa', label: 'Empresa' }];
  if (isVitrinePlan(state.profile) && state.company.slug) {
    items.push({ label: 'Site', external: true, href: publicMenuUrl(state.company.slug) });
  }
  return { key: 'gestao', label: 'Gestão', items };
}

// Alterna a classe "is-open" do trigger + painel de um dropdown de navbar
// direto no DOM (sem passar por render()). Fecha qualquer outro dropdown
// que porventura esteja aberto — só um por vez.
function setNavDropdownOpen(menuKey, opening) {
  app.querySelectorAll('.nav-dropdown-trigger').forEach((btn) => {
    btn.classList.toggle('is-open', opening && btn.dataset.menu === menuKey);
  });
  app.querySelectorAll('.nav-dropdown-menu').forEach((menu) => {
    menu.classList.toggle('is-open', opening && menu.dataset.menu === menuKey);
  });
}

// O painel do dropdown fica sempre montado no DOM (aberto ou não) — só a
// classe "is-open" muda — pra que abrir/fechar seja uma transição de CSS de
// verdade (ver toggle-nav-menu no dispatch de cliques, que alterna a classe
// direto no DOM em vez de passar por um render() completo, que recriaria o
// nó do zero e pularia a animação).
function navDropdown(group) {
  const isActive = group.items.some((item) => item.route === state.route.path);
  const isOpen = state.openNavMenu === group.key;
  return `<li class="nav-dropdown">
    <button type="button" class="nav-link nav-dropdown-trigger ${isActive ? 'active' : ''} ${isOpen ? 'is-open' : ''}" data-action="toggle-nav-menu" data-menu="${group.key}">
      ${group.label}${icon('chevronDown')}
    </button>
    <div class="nav-dropdown-menu ${isOpen ? 'is-open' : ''}" data-menu="${group.key}">
      <div class="nav-dropdown-menu-inner">
        ${group.items.map((item) => (item.external
          ? `<a class="profile-dropdown-item" href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}${icon('arrowUpRight')}</a>`
          : `<button type="button" class="profile-dropdown-item ${state.route.path === item.route ? 'active' : ''}" data-action="goto" data-route="${item.route}">${item.label}</button>`)).join('')}
      </div>
    </div>
  </li>`;
}

// Menu mobile: um drawer deslizando da lateral, ocupando a tela toda (nav +
// conta em um único painel), em vez do dropdown embaixo da navbar + o menu de
// conta separado — os dois viviam soltos e duplicados no mobile.
function mobileDrawer(displayName) {
  return `
    <div class="mobile-drawer-overlay ${state.mobileMenuOpen ? 'open' : ''}">
      <nav class="mobile-drawer">
        <div class="mobile-drawer-header">
          <span class="brand"><span class="brand-mark"></span> Doce Preço</span>
          <div class="mobile-drawer-header-actions">
            ${pricesNeedReview(state.profile) ? priceReviewAlertMenu() : ''}
            <button type="button" class="icon-btn ghost" data-action="toggle-mobile-menu" aria-label="Fechar menu">${icon('close')}</button>
          </div>
        </div>
        <div class="mobile-drawer-plan">${planLabel(state.profile)}</div>
        <ul class="mobile-drawer-nav">
          ${navItem('produtos', 'Receitas')}
          ${navDropdown(NAV_GROUPS[0])}
          ${navItem('fornecedores', 'Fornecedores')}
          ${navDropdown(gestaoGroup())}
        </ul>
        <div class="mobile-drawer-footer">
          <div class="mobile-drawer-user">
            <strong>${escapeHtml(displayName)}</strong>
          </div>
          <button type="button" class="profile-dropdown-item" data-action="goto" data-route="configuracoes">${icon('settings')}Configurações</button>
          <button type="button" class="profile-dropdown-item" data-action="open-change-password">${icon('key')}Trocar senha</button>
          <button type="button" class="profile-dropdown-item" data-action="logout">${icon('logout')}Sair</button>
        </div>
      </nav>
    </div>`;
}

// Conta recém-criada, ainda não aprovada pelo super admin: mostra só uma
// tela de espera (com opção de sair) em vez do app inteiro.
function pendingApprovalHtml(displayName) {
  return `
    <div class="shell">
      <header class="navbar">
        <div class="navbar-inner">
          <button type="button" class="brand" data-action="goto" data-route="inicio">
            <span class="brand-mark"></span> Doce Preço
          </button>
          <div class="navbar-user">
            <span class="navbar-email">${escapeHtml(displayName)}</span>
            <span class="navbar-divider" aria-hidden="true"></span>
            <button type="button" class="text-link" data-action="logout">Sair</button>
          </div>
        </div>
      </header>
      <div class="main-area">
        <div class="page">
          <div class="pending-approval-panel panel">
            <p class="eyebrow">Cadastro recebido</p>
            <h2>Aguardando aprovação</h2>
            <p>Sua conta foi criada com sucesso. Um administrador do Doce Preço precisa aprovar o seu acesso antes de você poder usar o app — isso costuma ser rápido.</p>
          </div>
        </div>
      </div>
      ${siteFooter()}
    </div>`;
}

// Teste grátis (7 dias, nível Básico) acabou e a conta ainda não tem um
// plano pago — bloqueia o app inteiro até a assinatura (sem checkout
// automático ainda, então por enquanto isso é resolvido manualmente).
function trialExpiredHtml(displayName) {
  return `
    <div class="shell">
      <header class="navbar">
        <div class="navbar-inner">
          <button type="button" class="brand" data-action="goto" data-route="inicio">
            <span class="brand-mark"></span> Doce Preço
          </button>
          <div class="navbar-user">
            <span class="navbar-email">${escapeHtml(displayName)}</span>
            <span class="navbar-divider" aria-hidden="true"></span>
            <button type="button" class="text-link" data-action="logout">Sair</button>
          </div>
        </div>
      </header>
      <div class="main-area">
        <div class="page">
          <div class="pending-approval-panel panel">
            <p class="eyebrow">Teste grátis encerrado</p>
            <h2>Seu teste grátis de 7 dias acabou</h2>
            <p>Para continuar usando o Doce Preço, escolha um dos nossos planos pagos.</p>
            ${statusBox()}
            <button type="button" data-action="request-upgrade">Fazer upgrade</button>
          </div>
        </div>
      </div>
      ${siteFooter()}
    </div>`;
}

// Ícone de sino no navbar do super admin, com contagem de contas aguardando
// aprovação e um atalho para aprovar direto do dropdown.
function adminAlertsMenu() {
  const pendingUsers = state.admin.users.filter((u) => u.approvalStatus === 'pending');
  return `
    <div class="alerts-menu">
      <button type="button" class="alerts-trigger" data-action="toggle-admin-alerts" aria-label="Avisos">
        ${icon('bell')}
        ${pendingUsers.length > 0 ? `<span class="alerts-badge">${pendingUsers.length}</span>` : ''}
      </button>
      ${state.adminAlertsOpen ? `
        <div class="profile-dropdown alerts-dropdown">
          ${pendingUsers.length === 0
            ? '<p class="alerts-empty">Nenhum aviso no momento.</p>'
            : pendingUsers.map((u) => `
              <div class="alerts-item">
                <span>${escapeHtml(u.fullName || u.email)} <small class="muted">quer acesso</small></span>
                <button type="button" class="primary" data-action="admin-approve" data-id="${u.id}">Aprovar</button>
              </div>`).join('')}
        </div>` : ''}
    </div>`;
}

// Ícone de sino no navbar de contas Pro: aviso a cada 30 dias pra revisar
// os preços das receitas (ver pricesNeedReview). Reaproveita o mesmo
// componente visual do sino de avisos do admin.
function priceReviewAlertMenu() {
  return `
    <div class="alerts-menu">
      <button type="button" class="alerts-trigger" data-action="toggle-price-review-alert" aria-label="Aviso de revisão de preços">
        ${icon('bell')}
        <span class="alerts-badge">!</span>
      </button>
      ${state.priceReviewAlertOpen ? `
        <div class="profile-dropdown alerts-dropdown">
          <div class="alerts-item alerts-item-stacked">
            <span><strong>Hora de revisar seus preços!</strong><br /><small class="muted">Já se passaram ${PRICE_REVIEW_INTERVAL_DAYS} dias desde a última revisão — seus custos de ingredientes e despesas podem ter mudado.</small></span>
            <button type="button" class="primary" data-action="mark-price-review-done">Marcar como revisado</button>
          </div>
        </div>` : ''}
    </div>`;
}

function profileLoadingHtml() {
  return `<div class="app-boot-loading">${loadingMsg()}</div>`;
}

function shellHtml() {
  // Antes do perfil de verdade carregar, state.profile é só o placeholder
  // (plan: 'trial', trialEndsAt: null) — sem esse gate, os checks abaixo
  // leriam isso como "trial encerrado" por um instante, mesmo pra quem já é
  // Pro (ver profileLoaded em loadUserData).
  if (!state.profileLoaded) {
    return profileLoadingHtml();
  }
  const displayName = state.profile.fullName || nameFromEmail(state.session.user.email);
  const isAdmin = state.profile.role === 'admin';
  if (!isAdmin && state.profile.approvalStatus !== 'approved') {
    return pendingApprovalHtml(displayName);
  }
  if (!isAdmin && planStatus(state.profile) === 'expired') {
    return trialExpiredHtml(displayName);
  }
  const showTrialBanner = !isAdmin && planStatus(state.profile) === 'trial';
  const showUpgradeBanner = !isAdmin && !isVitrinePlan(state.profile);
  return `
    <div class="shell ${showUpgradeBanner ? 'has-upgrade-banner' : ''}">
      <header class="navbar">
        <div class="navbar-inner">
          <button type="button" class="brand" data-action="goto" data-route="inicio">
            <span class="brand-mark"></span> Doce Preço
          </button>
          ${isAdmin ? '' : `
          <ul class="nav-list">
            ${navItem('produtos', 'Receitas')}
            ${navDropdown(NAV_GROUPS[0])}
            ${navItem('fornecedores', 'Fornecedores')}
            ${navDropdown(gestaoGroup())}
          </ul>`}
          <div class="navbar-user">
            ${isAdmin ? adminAlertsMenu() : ''}
            ${!isAdmin && pricesNeedReview(state.profile) ? priceReviewAlertMenu() : ''}
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
          ${isAdmin ? '' : `<button type="button" class="navbar-menu-toggle" data-action="toggle-mobile-menu" aria-label="Abrir menu">${icon('menu')}</button>`}
        </div>
      </header>
      ${isAdmin ? '' : mobileDrawer(displayName)}
      ${showTrialBanner ? trialBanner() : ''}
      <div class="main-area">
        <div class="page">${renderPage()}</div>
      </div>
      ${siteFooter()}
    </div>
    ${showUpgradeBanner ? upgradeBanner() : ''}
    ${cookieBar()}
    ${modalOverlay()}`;
}

function trialBanner() {
  const days = trialDaysLeft(state.profile);
  return `
    <div class="trial-banner">
      <p>Teste grátis: ${days === 1 ? 'falta 1 dia' : `faltam ${days} dias`}.</p>
      <button type="button" class="ghost" data-action="request-upgrade">Fazer upgrade</button>
    </div>`;
}

// Banner fixo no rodapé da tela pra contas Básico/teste grátis (não mostra
// pra quem já é Pro) — convite de upgrade sempre visível, sem depender de
// rolar até algum lugar específico da página.
function upgradeBanner() {
  return `
    <div class="upgrade-banner">
      <div class="upgrade-banner-content">
        <p class="eyebrow">Desbloqueie mais recursos</p>
        <h3>Pronto para saber o preço certo dos seus doces?</h3>
        <p>Vitrine online, fornecedores e gestão completa da sua confeitaria.</p>
      </div>
      <button type="button" data-action="request-upgrade">Fazer upgrade</button>
    </div>`;
}

// Ícones de rede social sem link ainda (ver conversa) — viram <a> reais
// assim que houver contas de verdade pra apontar.
function siteFooter() {
  const year = new Date().getFullYear();
  return `
    <footer class="site-footer">
      <div class="site-footer-inner">
        <span>&copy; ${year} Doce Preço. Todos os direitos reservados.</span>
        <nav class="site-footer-links">
          <button type="button" data-action="goto" data-route="termos">Termos de uso</button>
          <button type="button" data-action="goto" data-route="privacidade">Privacidade</button>
        </nav>
        <div class="site-footer-social">
          <span class="site-footer-social-icon" aria-label="Instagram">${icon('instagram')}</span>
          <span class="site-footer-social-icon" aria-label="Facebook">${icon('facebook')}</span>
        </div>
        <span class="site-footer-badge">Powered by: <strong>Gravit</strong></span>
      </div>
    </footer>`;
}

// ---------------- Landing page pública (vendas) ----------------

const LANDING_BENEFITS = [
  { icon: 'trending', title: 'Nunca mais venda no prejuízo', text: 'Descubra o preço certo de cada doce com base no custo real de ingredientes e despesas.' },
  { icon: 'cupcake', title: 'Receitas sempre organizadas', text: 'Cadastre ingredientes, quantidades e embalagens usados em cada receita, tudo em um só lugar.' },
  { icon: 'wallet', title: 'Despesas sob controle', text: 'Rateie gás, luz, água e outras despesas fixas automaticamente entre suas receitas.' },
  { icon: 'truck', title: 'Fornecedores organizados', text: 'Guarde contatos, preços e condições dos seus fornecedores num só lugar.' },
  { icon: 'clock', title: 'Economize tempo', text: 'Preço sugerido calculado na hora, sem depender de planilha.' },
  { icon: 'shield', title: 'Seus dados protegidos', text: 'Conforme a LGPD, com acesso só seu — você pode excluir tudo quando quiser.' },
];

// Seção "Como funciona": lista editorial de passos com números grandes
// (ver landingStepsBigSection) — a vitrine fica de fora de propósito, é
// recurso exclusivo do plano Vitrine, não faz parte do fluxo básico de todo mundo.
const LANDING_STEPS_BIG = [
  {
    num: '01',
    label: 'Cadastre ingredientes e despesas',
    text: 'Preço de compra, quantidade e as despesas fixas do seu negócio — uma vez só, tudo num lugar.',
  },
  {
    num: '02',
    label: 'Monte suas receitas',
    text: 'Adicione os ingredientes usados e a quantidade de cada um — o custo de cada receita sai sozinho.',
  },
  {
    num: '03',
    label: 'Veja o preço sugerido',
    text: 'Com a margem de lucro que você escolher — mínima, média ou máxima — calculada na hora, sem planilha.',
  },
];

// Uma foto por passo — troca e desce um pouco conforme o scroll (ver
// updateStepsBigPhoto), pra dar mais movimento à seção sem reintroduzir o
// scroll pinado inteiro (abas/mockup) que a seção tinha antes.
const LANDING_STEPS_BIG_PHOTOS = [
  { src: '/assets/img/pexels-anntarazevich-6035994.webp', alt: 'Confeiteira preparando uma receita' },
  { src: '/assets/img/pexels-anntarazevich-6036020.webp', alt: 'Calda de chocolate sendo derramada' },
  { src: '/assets/img/pexels-amar-9329437.webp', alt: 'Doces prontos para servir' },
];

// O teste grátis (7 dias) já dá acesso nível Básico (ver planStatus) — por
// isso vira uma nota no próprio cartão do Básico em vez de um cartão à
// parte. Controle e Vitrine são o antigo "Pro" dividido em dois: Vitrine é
// tudo do Controle + o cardápio público (ver isControlePlan/isVitrinePlan).
const LANDING_PLANS = [
  {
    key: 'basico',
    name: 'Básico',
    price: 19.9,
    priceSuffix: '/mês',
    description: 'Para quem está começando a organizar os preços.',
    note: 'Comece com 7 dias grátis — depois do período, R$ 19,90/mês.',
    features: [
      'Até 5 receitas e 1 nível de lucro',
      'Ingredientes e despesas',
      'Cálculo automático de preço sugerido',
    ],
    highlight: false,
    cta: 'Começar teste grátis',
  },
  {
    key: 'controle',
    name: 'Controle',
    price: 39.9,
    priceSuffix: '/mês',
    description: 'Para quem quer controlar o negócio inteiro.',
    features: [
      'Receitas ilimitadas e 3 níveis de lucro',
      'Tudo do plano Básico',
      'Gestão de fornecedores',
      'Gestão de clientes',
      'Gestão da empresa (CNPJ, endereço, links de delivery)',
    ],
    highlight: true,
    cta: 'Assinar Controle',
  },
  {
    key: 'vitrine',
    icon: 'storefront',
    name: 'Vitrine',
    price: 59.9,
    priceSuffix: '/mês',
    description: 'Para quem quer ter seu cardápio online.',
    features: [
      'Tudo do plano Controle',
      'Vitrine online para vender seus doces',
    ],
    highlight: false,
    cta: 'Assinar Vitrine',
  },
];

function landingNav() {
  return `
    <header class="navbar landing-nav">
      <div class="navbar-inner">
        <button type="button" class="brand" data-action="goto" data-route="inicio">
          <span class="brand-mark"></span> Doce Preço
        </button>
        <ul class="landing-nav-links">
          <li><a href="#beneficios">Benefícios</a></li>
          <li><a href="#como-funciona">Como funciona</a></li>
          <li><a href="#precos">Preços</a></li>
        </ul>
        <div class="landing-nav-actions">
          <button type="button" class="text-link" data-action="goto" data-route="entrar">Entrar</button>
          <button type="button" data-action="goto" data-route="cadastro">Teste grátis</button>
        </div>
      </div>
    </header>`;
}

// Telas "de mentira" (recriadas em HTML/CSS, sem dado real) usadas nos
// mockups da landing — moldura de navegador pras telas internas da
// plataforma, moldura de celular pra vitrine (é lá que o cliente final vê).
function fauxWindow(bodyHtml) {
  return `
    <div class="faux-window">
      <div class="faux-window-bar"><span></span><span></span><span></span></div>
      <div class="faux-window-body">${bodyHtml}</div>
    </div>`;
}

// "Como funciona": lista editorial com números grandes (estilo textos
// grandes sobrepostos de referência) — a foto de destaque troca e desce
// aos poucos conforme o scroll (ver updateStepsBigPhoto), o resto da seção
// não depende de scroll pinado. A altura da pista soma +100vh à distância
// que se quer de fato rolar com o conteúdo preso: o painel sticky (que
// ocupa ~100vh) "gasta" essa altura da pista só ficando parado antes de
// soltar, então sem esse extra o pin soltava bem antes do scroll acabar.
function landingStepsBigSection() {
  return `
    <section class="landing-steps-big" id="como-funciona">
      <div class="landing-steps-big-track" style="height: calc(${LANDING_STEPS_BIG.length * 90}vh + 100vh)">
        <div class="landing-steps-big-sticky">
          <div class="landing-section-inner landing-steps-big-stack">
            <p class="eyebrow">Como funciona</p>
            <h2>Do ingrediente à precificação certa</h2>
            <div class="landing-steps-big-photo">
              ${LANDING_STEPS_BIG_PHOTOS.map((photo, i) => `
                <div class="landing-steps-big-photo-item ${i === 0 ? 'is-active' : ''}" data-step="${i}">
                  <img src="${photo.src}" alt="${escapeHtml(photo.alt)}" />
                </div>`).join('')}
            </div>
            ${LANDING_STEPS_BIG.map((step, i) => `
              <div class="landing-steps-big-row ${i === 0 ? 'is-active' : ''}" data-step="${i}">
                <span class="landing-steps-big-num">${escapeHtml(step.num)}</span>
                <div class="landing-steps-big-text">
                  <h3>${escapeHtml(step.label)}</h3>
                  <p>${escapeHtml(step.text)}</p>
                </div>
              </div>`).join('')}
          </div>
        </div>
      </div>
    </section>`;
}

// Hero: foto full-bleed (degradê já vem na própria imagem, escurecendo a
// esquerda onde fica o texto) com o mockup fake da tela de precificação
// flutuando à direita, cercado de cartõezinhos (depoimento/métrica/selo) com
// leve animação contínua (CSS). A faixa de destaques fecha o rodapé da foto.
function landingHeroV2() {
  return `
    <section class="landing-hero-v2">
      <img src="/assets/background/bg-banner-02.webp" alt="" class="landing-hero-v2-photo" />
      <div class="landing-section-inner landing-hero-v2-inner">
        <div class="landing-hero-v2-copy">
          <p class="eyebrow-pill">Facilite a gestão da sua confeitaria</p>
          <h1>Sua confeitaria no lucro certo</h1>
          <p class="landing-hero-v2-subtitle">Adicione ingredientes, crie receitas e saiba o quanto cobrar!</p>
          <div class="landing-hero-actions">
            <button type="button" data-action="goto" data-route="cadastro">Testar grátis por 7 dias</button>
            <a href="#precos" class="landing-link-cta">Ver planos e preços</a>
          </div>
          <p class="landing-hero-note">Sem cartão de crédito para começar. Cancele quando quiser.</p>
        </div>
        <div class="landing-hero-v2-stage">
          <div class="landing-hero-floater landing-hero-floater-1">
            <span class="landing-hero-floater-avatar" style="background:${avatarColorFor('Marina Duarte')}">MD</span>
            <div><strong>Marina Duarte</strong><small>Doce Ponto Confeitaria</small></div>
          </div>
          ${fauxWindow(`
            <div class="faux-meta faux-meta-highlight"><span>Custo por unidade</span><strong>R$ 2,10</strong></div>
            <div class="faux-tier"><span>Mínimo</span><strong>R$ 4,90</strong></div>
            <div class="faux-tier is-active"><span>Média</span><strong>R$ 6,90</strong></div>
            <div class="faux-tier"><span>Máximo</span><strong>R$ 8,90</strong></div>
          `)}
          <div class="landing-hero-floater landing-hero-floater-2">
            ${icon('trending')}<div><strong>+28%</strong><small>de margem média</small></div>
          </div>
          <div class="landing-hero-floater landing-hero-floater-3">
            ${icon('check')}<div><strong>Margem garantida</strong><small>em cada receita</small></div>
          </div>
        </div>
      </div>
      ${landingHighlightsStrip()}
    </section>`;
}

// Painel escuro full-bleed com foto + cartões flutuantes de recursos —
// reforça a praticidade do dia a dia (mesmo tratamento visual da referência
// usada, seção "Endless Workout Options").
function landingFeaturePanel() {
  const cards = [
    { icon: 'box', title: 'Ingredientes ilimitados', text: 'Cadastre quantos insumos e embalagens usar.', photo: '/assets/img/pexels-anntarazevich-6035994.webp' },
    { icon: 'trending', title: 'Cálculo automático', text: 'Custo e preço sugerido recalculados a cada alteração.', photo: '/assets/img/pexels-anntarazevich-6036020.webp' },
    { icon: 'storefront', title: 'Vitrine sincronizada', text: 'O que você publica aparece na hora pro seu cliente.', photo: '/assets/img/pexels-amar-9329437.webp' },
  ];
  return `
    <section class="landing-feature-panel reveal" id="praticidade">
      <img src="/assets/img/pexels-anntarazevich-6036020.webp" alt="" class="landing-feature-photo" />
      <div class="landing-feature-overlay"></div>
      <div class="landing-section-inner landing-feature-inner">
        <p class="eyebrow-pill landing-feature-eyebrow">Praticidade todo dia</p>
        <h2>Feito pra rotina da sua confeitaria</h2>
        <p class="landing-section-subtitle" style="margin:12px 0 0;color:rgba(255,255,255,0.75)">Sem planilha, sem calculadora, sem achismo — só o preço certo, sempre à mão.</p>
        <div class="landing-feature-cards">
          ${cards.map((c, i) => `
            <div class="landing-feature-card reveal" style="--reveal-delay: ${(i * 0.1).toFixed(2)}s">
              <img src="${c.photo}" alt="" class="landing-feature-card-photo" />
              <span class="landing-feature-card-icon">${icon(c.icon)}</span>
              <h3>${escapeHtml(c.title)}</h3>
              <p>${escapeHtml(c.text)}</p>
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}

const LANDING_HIGHLIGHTS = [
  { icon: 'trending', text: 'Custo real calculado' },
  { icon: 'whisk', text: 'Preço sugerido automático' },
  { icon: 'shield', text: 'Seus dados protegidos' },
];

function landingHighlightsStrip() {
  return `
    <div class="landing-highlights">
      <div class="landing-section-inner landing-highlights-inner">
        ${LANDING_HIGHLIGHTS.map((h) => `
          <div class="landing-highlight">${icon(h.icon)}<span>${escapeHtml(h.text)}</span></div>`).join('')}
      </div>
    </div>`;
}

function landingHtml() {
  return `
    <div class="landing">
      ${landingNav()}
      ${landingHeroV2()}

      <section class="landing-section landing-section-dark" id="beneficios">
        <div class="landing-section-inner">
          <p class="eyebrow">Benefícios</p>
          <h2>Tudo que sua confeitaria precisa pra precificar certo</h2>
          <div class="landing-benefits-grid">
            ${LANDING_BENEFITS.map((b, index) => `
              <div class="landing-benefit-card reveal" style="--reveal-delay: ${(index * 0.08).toFixed(2)}s">
                <div class="landing-benefit-top">
                  <span class="landing-benefit-icon">${icon(b.icon)}</span>
                  <span class="landing-benefit-arrow">${icon('arrowUpRight')}</span>
                </div>
                <h3>${escapeHtml(b.title)}</h3>
                <p>${escapeHtml(b.text)}</p>
              </div>`).join('')}
          </div>
        </div>
      </section>

      ${landingStepsBigSection()}

      ${landingFeaturePanel()}

      <section class="landing-section" id="precos">
        <div class="landing-section-inner">
          <p class="eyebrow-pill">Planos</p>
          <h2><span class="muted-tone">Escolha o plano</span> da sua confeitaria</h2>
          <p class="landing-section-subtitle">O plano Básico começa com 7 dias de teste grátis. Cancele quando quiser.</p>
          <div class="landing-pricing-grid">
            ${LANDING_PLANS.map((plan, index) => `
              <div class="landing-plan-card reveal ${plan.highlight ? 'is-highlight' : ''}" style="--reveal-delay: ${(index * 0.12).toFixed(2)}s">
                ${plan.highlight ? '<span class="landing-plan-badge">Mais popular</span>' : ''}
                <div class="landing-plan-head">
                  <span class="landing-plan-icon">${icon(plan.icon || (plan.highlight ? 'star' : 'cupcake'))}</span>
                  <h3>${escapeHtml(plan.name)}</h3>
                </div>
                <p class="landing-plan-description">${escapeHtml(plan.description)}</p>
                <p class="landing-plan-price">${formatCurrency(plan.price)}<span>${plan.priceSuffix}</span></p>
                ${plan.note ? `<p class="landing-plan-note">${escapeHtml(plan.note)}</p>` : ''}
                <ul class="landing-plan-features">
                  ${plan.features.map((f) => `<li>${icon('check')}<span>${escapeHtml(f)}</span></li>`).join('')}
                </ul>
                <button type="button" class="${plan.highlight ? '' : 'ghost'}" data-action="goto" data-route="cadastro">${escapeHtml(plan.cta)}</button>
              </div>`).join('')}
          </div>
        </div>
      </section>

      <section class="landing-cta">
        <img src="/assets/img/pexels-amar-9329437.webp" alt="" class="landing-cta-photo" />
        <div class="landing-cta-overlay"></div>
        <div class="landing-cta-marquee" aria-hidden="true">
          <div class="landing-cta-marquee-track">
            <span>Comece agora · Comece agora · Comece agora · Comece agora · </span>
            <span>Comece agora · Comece agora · Comece agora · Comece agora · </span>
          </div>
        </div>
        <div class="landing-section-inner landing-cta-inner reveal">
          <h2>Pronta pra saber o preço certo dos seus doces?</h2>
          <button type="button" data-action="goto" data-route="cadastro">Testar grátis por 7 dias</button>
        </div>
      </section>

      ${siteFooter()}
    </div>
    ${cookieBar()}`;
}

// Barra de cookies padrão de mercado: some assim que aceita, guardado no
// localStorage pra não voltar a aparecer nas próximas visitas.
function cookieBar() {
  if (state.cookieConsent) return '';
  return `
    <div class="cookie-bar">
      <p>Usamos cookies para melhorar sua experiência e analisar o uso do site. Ao continuar navegando, você concorda com nossa <button type="button" class="text-link" data-action="goto" data-route="privacidade">Política de Privacidade</button>.</p>
      <button type="button" data-action="accept-cookies">Aceitar</button>
    </div>`;
}

function renderLegalPage(title, paragraphs) {
  return `
    <div class="section-header">
      <div><p class="eyebrow">Doce Preço</p><h2>${escapeHtml(title)}</h2></div>
      <button type="button" class="ghost" data-action="goto" data-route="inicio">Voltar</button>
    </div>
    <div class="panel">
      ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
    </div>`;
}

function renderTermosPage() {
  return renderLegalPage('Termos de uso', [
    'Ao usar o Doce Preço, você concorda em utilizar a ferramenta para calcular preços e organizar receitas, ingredientes e despesas do seu próprio negócio.',
    'Oferecemos um período de teste grátis de 7 dias com acesso completo à ferramenta. Depois desse período, a continuidade do uso depende da contratação de um dos planos pagos (Básico ou Pro).',
    'A cobrança dos planos pagos é processada por uma plataforma de pagamentos parceira (Mercado Pago). O Doce Preço não processa nem armazena os dados do seu cartão em nenhum momento — veja detalhes na Política de Privacidade.',
    'Os cálculos apresentados são estimativas baseadas nos dados informados por você; a conferência dos valores antes de aplicá-los é de responsabilidade do usuário.',
    'Não é permitido usar a plataforma para armazenar dados de terceiros sem autorização, nem tentar acessar contas ou dados de outros usuários.',
    'Podemos atualizar estes termos periodicamente; o uso contínuo do app após uma atualização representa a aceitação dos novos termos.',
  ]);
}

function renderPrivacidadePage() {
  return renderLegalPage('Política de privacidade', [
    'Coletamos apenas os dados necessários para o funcionamento do app: nome, e-mail e as informações que você cadastra (receitas, ingredientes, despesas, fornecedores e clientes).',
    'Não coletamos nem armazenamos dados de cartão de crédito ou débito. Quando você contrata um plano pago, o pagamento é processado diretamente pela plataforma parceira (Mercado Pago), que tem seus próprios controles de segurança; o Doce Preço recebe apenas a confirmação de que o pagamento foi aprovado.',
    'Seus dados não são vendidos nem compartilhados com terceiros para fins de marketing.',
    'Você pode atualizar suas informações pessoais, trocar sua senha ou excluir permanentemente sua conta e todos os seus dados a qualquer momento, pelo menu de perfil.',
    'Em conformidade com a LGPD, você tem direito a solicitar acesso, correção ou exclusão dos seus dados pessoais.',
    'Cookies: o Doce Preço não usa cookies de publicidade, análise ou rastreamento de terceiros. As únicas informações guardadas no seu navegador (por localStorage, não por cookies) são o token que mantém você conectado e a sua escolha sobre o aviso de cookies exibido na primeira visita.',
    'Você pode apagar essas informações quando quiser, limpando os dados de navegação do seu navegador — isso vai exigir que você faça login novamente e o aviso de cookies pode voltar a aparecer.',
  ]);
}

function authHtml() {
  const isSignUp = state.authMode === 'signup';
  return `
    <div class="auth-page">
      <div class="auth-form-side">
        <button type="button" class="auth-brand" data-action="goto" data-route="inicio"><span class="brand-mark"></span> Doce Preço</button>
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
              </label>
              <div class="g-recaptcha" data-sitekey="${RECAPTCHA_SITE_KEY}"></div>` : ''}
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
        <img src="/assets/img/pexels-anntarazevich-6036020.webp" alt="" class="auth-visual-photo" />
        <div class="auth-visual-overlay"></div>
      </div>
    </div>
    ${cookieBar()}
    ${modalOverlay()}`;
}

// Antes do login, a rota decide entre a landing page de vendas e o
// formulário de entrar/cadastrar — o resto (páginas legais) reaproveita o
// mesmo conteúdo usado dentro do app, só que num invólucro público (sem o
// menu/dados de conta do shell autenticado).
function publicHtml() {
  if (state.route.path === 'entrar' || state.route.path === 'cadastro') return authHtml();
  if (state.route.path === 'termos') return publicPageHtml(renderTermosPage());
  if (state.route.path === 'privacidade') return publicPageHtml(renderPrivacidadePage());
  return landingHtml();
}

function publicPageHtml(pageContent) {
  return `
    <div class="shell">
      ${landingNav()}
      <div class="main-area"><div class="page">${pageContent}</div></div>
      ${siteFooter()}
    </div>
    ${cookieBar()}`;
}

// ---------------- Cardápio público (recurso do plano Vitrine) ----------------

function publicMenuUrl(slug) {
  return `${window.location.origin}${window.location.pathname}#/cardapio/${slug}`;
}

async function ensurePublicMenuLoaded(slug) {
  state.publicMenu = { slug, loading: true, company: null, products: [], error: '' };
  render();
  try {
    const company = await db.getPublicCompany(slug);
    if (!company) {
      state.publicMenu = { slug, loading: false, company: null, products: [], error: 'not-found' };
      render();
      return;
    }
    const products = await db.getPublicProducts(company.id);
    state.publicMenu = { slug, loading: false, company, products, error: '' };
  } catch (error) {
    state.publicMenu = { slug, loading: false, company: null, products: [], error: error.message };
  }
  render();
}

const PUBLIC_DELIVERY_BRANDS = [
  { key: 'ifood_url', label: 'iFood', logo: '/assets/parceiros/logo-ifood.png' },
  { key: 'link_99_url', label: '99', logo: '/assets/parceiros/logo-99-food.png' },
  { key: 'keeta_url', label: 'Keeta', logo: '/assets/parceiros/logo-keeta.png' },
];

// Categorias na ordem em que aparecem pela primeira vez na lista de
// produtos — usado tanto pra montar a barra lateral (desktop) quanto o
// menu de categorias (mobile), então fica num único lugar.
function deriveMenuCategories(products) {
  const categories = [];
  for (const product of products) {
    const name = product.category?.trim() || 'Cardápio';
    if (!categories.includes(name)) categories.push(name);
  }
  return categories;
}

function publicMenuHeader(company, categories) {
  const hasNav = categories.length > 1;
  return `
    <header class="menu-header">
      <div class="menu-header-inner">
        <a class="menu-brand" href="#/cardapio/${escapeHtml(company.slug)}">
          ${company.logo_url ? `<img src="${escapeHtml(company.logo_url)}" alt="" class="menu-logo" />` : ''}
          <span>${escapeHtml(company.company_name || 'Cardápio')}</span>
        </a>
        ${hasNav ? `<button type="button" class="navbar-menu-toggle" data-action="toggle-mobile-menu" aria-label="Abrir categorias">${icon('menu')}</button>` : ''}
      </div>
    </header>
    ${hasNav ? publicMenuNavDrawer(company, categories) : ''}`;
}

// Menu de categorias no mobile: mesmo drawer lateral do app logado (mesma
// classe, mesmo estado state.mobileMenuOpen e a mesma ação
// "toggle-mobile-menu" de abrir/fechar/clicar fora) — no desktop a barra
// lateral (.menu-sidebar) já cobre a navegação, então o CSS esconde esse
// drawer lá (ver _menu.scss).
function publicMenuNavDrawer(company, categories) {
  return `
    <div class="mobile-drawer-overlay ${state.mobileMenuOpen ? 'open' : ''}">
      <nav class="mobile-drawer">
        <div class="mobile-drawer-header">
          <span class="brand">${escapeHtml(company.company_name || 'Cardápio')}</span>
          <button type="button" class="icon-btn ghost" data-action="toggle-mobile-menu" aria-label="Fechar categorias">${icon('close')}</button>
        </div>
        <ul class="mobile-drawer-nav">
          ${categories.map((cat) => `<li><button type="button" class="nav-link" data-action="scroll-to-menu-category" data-target="cat-${slugify(cat)}">${escapeHtml(cat)}</button></li>`).join('')}
        </ul>
      </nav>
    </div>`;
}

function publicMenuFooter(company) {
  const links = PUBLIC_DELIVERY_BRANDS
    .map((brand) => ({ brand, url: company[brand.key] }))
    .filter((l) => isHttpUrl(l.url));
  return `
    <footer class="site-footer menu-footer">
      <div class="site-footer-inner">
        <span>&copy; ${new Date().getFullYear()} ${escapeHtml(company.company_name || '')}.</span>
        ${links.length ? `<div class="delivery-shortcuts" style="margin:0;">
          ${links.map((l) => `<a class="delivery-shortcut" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${deliveryBadge(l.brand, 'delivery-badge-sm')}<span>${escapeHtml(l.brand.label)}</span></a>`).join('')}
        </div>` : ''}
        <span class="site-footer-badge">Powered by: <strong>Gravit</strong></span>
      </div>
    </footer>`;
}

function publicMenuHtml() {
  const slug = state.route.param;
  if (!slug || state.publicMenu.slug !== slug) {
    return `<div class="menu-loading">${inlineSvgPlaceholder('span', 'loading-whisk', '/assets/icons/cooking-loader.svg')}</div>`;
  }
  if (state.publicMenu.loading) {
    return `<div class="menu-loading">${inlineSvgPlaceholder('span', 'loading-whisk', '/assets/icons/cooking-loader.svg')}</div>`;
  }
  if (!state.publicMenu.company) {
    return `<div class="menu-empty-page"><h1>Cardápio não encontrado</h1><p>Verifique se o link está correto.</p></div>`;
  }
  return renderPublicMenuList(state.publicMenu);
}

function renderPublicMenuList(menu) {
  const { company, products } = menu;
  const categories = deriveMenuCategories(products);
  const links = PUBLIC_DELIVERY_BRANDS
    .map((brand) => ({ brand, url: company[brand.key] }))
    .filter((l) => isHttpUrl(l.url));
  const deliveryLinksHtml = links.length ? `
    <div class="menu-item-links">
      <div class="delivery-shortcuts">
        ${links.map((l) => `<a class="delivery-shortcut delivery-shortcut-plain" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${deliveryBadge(l.brand, 'delivery-badge-sm')}<span>${escapeHtml(l.brand.label)}</span></a>`).join('')}
      </div>
    </div>` : '';
  return `
    <div class="menu-page">
      ${publicMenuHeader(company, categories)}
      <div class="menu-body">
        ${categories.length > 1 ? `
          <nav class="menu-sidebar">
            ${categories.map((cat) => `<button type="button" data-action="scroll-to-menu-category" data-target="cat-${slugify(cat)}">${escapeHtml(cat)}</button>`).join('')}
          </nav>` : ''}
        <div class="menu-content">
          ${products.length === 0
            ? '<p class="menu-empty">Nenhum produto publicado ainda.</p>'
            : categories.map((cat) => `
              <section class="menu-category" id="cat-${slugify(cat)}">
                <h2>${escapeHtml(cat)}</h2>
                ${products.filter((p) => (p.category?.trim() || 'Cardápio') === cat).map((product) => `
                  <div class="menu-item">
                    ${product.photo_url
                      ? `<button type="button" class="menu-item-photo-btn" data-action="open-menu-lightbox" data-url="${escapeHtml(product.photo_url)}" aria-label="Ampliar foto de ${escapeHtml(product.name)}"><img src="${escapeHtml(product.photo_url)}" alt="" class="menu-item-photo" /></button>`
                      : '<span class="menu-item-photo menu-item-photo-empty"></span>'}
                    <div class="menu-item-info">
                      <div class="menu-item-top"><strong>${escapeHtml(product.name)}</strong><span class="menu-item-price">${formatCurrency(toNumberSafe(product.menu_price))}</span></div>
                      ${product.description ? `<p>${escapeHtml(product.description)}</p>` : ''}
                      ${deliveryLinksHtml}
                    </div>
                  </div>`).join('')}
              </section>`).join('')}
        </div>
      </div>
      ${publicMenuFooter(company)}
      ${state.menuLightboxUrl ? `
        <div class="menu-lightbox" data-action="close-menu-lightbox">
          <button type="button" class="menu-lightbox-close" data-action="close-menu-lightbox" aria-label="Fechar">${icon('close')}</button>
          <img src="${escapeHtml(state.menuLightboxUrl)}" alt="" />
        </div>` : ''}
    </div>`;
}

// Chave da "página atual" pra decidir quando tocar a animação de entrada
// (ver render/lastPageKey abaixo) — só muda ao navegar de verdade (rota,
// parâmetro ou login/logout), nunca a cada re-render por causa de digitação,
// abrir modal etc. (render() roda a cada tecla; sem esse filtro a animação
// tocaria de novo a cada caractere digitado).
let lastPageKey = null;

function render() {
  const restore = captureFocus();
  // dataLoading entra na chave pra a troca do spinner de carregamento pelo
  // conteúdo de verdade (mesma rota, dois renders em loadUserData) também
  // contar como "página nova" e animar — sem isso só o spinner animaria.
  const pageKey = `${state.session ? 'app' : 'public'}:${state.route.path}:${state.route.param || ''}:${state.dataLoading}`;
  const isNewPage = pageKey !== lastPageKey;
  lastPageKey = pageKey;
  // O cardápio público é sempre a mesma página, esteja o visitante logado
  // ou não (ex.: o próprio lojista pré-visualizando o link) — por isso vem
  // antes do shellHtml()/publicHtml() de sempre.
  app.innerHTML = state.route.path === 'cardapio'
    ? publicMenuHtml()
    : (state.session ? shellHtml() : publicHtml());
  restoreFocus(restore);
  // O primeiro filho é sempre o wrapper principal da página (.shell/.landing/
  // .auth-page/...); os demais irmãos (modal, cookie bar, banner de upgrade)
  // não devem deslizar junto — ver padrão em shellHtml/landingHtml/authHtml.
  if (isNewPage) app.firstElementChild?.classList.add('page-enter');
  setupScrollReveal();
  hydrateInlineSvgs();
  renderRecaptchaWidgets();
}

// O script do reCAPTCHA só auto-renderiza [.g-recaptcha] presentes no DOM
// quando a página carrega — como o render() troca o innerHTML todo, um
// widget inserido depois (ex.: ao trocar de "Entrar" pra "Criar conta")
// nunca apareceria sem chamar grecaptcha.render() manualmente aqui.
function renderRecaptchaWidgets() {
  const containers = app.querySelectorAll('.g-recaptcha:not([data-rendered])');
  if (!containers.length) return;
  const tryRender = () => {
    if (typeof grecaptcha === 'undefined' || !grecaptcha.render) {
      setTimeout(tryRender, 200);
      return;
    }
    containers.forEach((el) => {
      if (el.dataset.rendered) return;
      el.dataset.rendered = 'true';
      grecaptcha.render(el, { sitekey: RECAPTCHA_SITE_KEY });
    });
  };
  tryRender();
}

// Busca e injeta o markup de cada [data-inline-svg] ainda vazio (ver
// inlineSvgPlaceholder) — cacheado em memória pra não refazer o fetch a
// cada render() (a cada mudança de estado da página, não só ao navegar).
const inlineSvgCache = new Map();
function hydrateInlineSvgs() {
  app.querySelectorAll('[data-inline-svg]').forEach(async (el) => {
    if (el.childNodes.length) return;
    const src = el.dataset.inlineSvg;
    if (inlineSvgCache.has(src)) {
      el.innerHTML = inlineSvgCache.get(src);
      return;
    }
    try {
      const text = await (await fetch(src)).text();
      inlineSvgCache.set(src, text);
      if (!el.isConnected) return;
      el.innerHTML = text;
    } catch {
      // Sem ilustração/loader animado, mas o resto da página segue normal.
    }
  });
}

// Animação de entrada ao dar scroll (landing page): cada render substitui o
// DOM inteiro, então os elementos observados de antes deixam de existir —
// por isso reobservamos a cada render em vez de configurar uma vez só.
// O observer em si é reaproveitado (criado uma única vez).
let scrollRevealObserver = null;
function setupScrollReveal() {
  const targets = app.querySelectorAll('.reveal');
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  if (!scrollRevealObserver) {
    scrollRevealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          scrollRevealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
  }
  targets.forEach((el) => {
    if (!el.classList.contains('is-visible')) scrollRevealObserver.observe(el);
  });
  updateStepsBigPhoto();
}

// "Como funciona" fica fixa na tela (position: sticky) enquanto a pista alta
// (.landing-steps-big-track) rola por baixo — a cada trecho da pista, acende
// o passo (texto + número) e troca a foto correspondente. Mais leve que o
// scroll pinado antigo (abas/mockup): é só opacidade + crossfade, sem travar
// a rolagem de verdade nem exigir JS pra "soltar" o pin. O deslocamento
// acompanha o scroll 1:1 (só o rAF-throttle abaixo, ~16ms) — um lerp/loop
// próprio aqui já foi tentado e deixava a foto visivelmente atrasada em
// relação ao scroll de verdade, o oposto do que se queria.
let stepsPhotoRaf = null;
const STEPS_PHOTO_TRAVEL = 160;

function updateStepsBigPhoto() {
  const track = app.querySelector('.landing-steps-big-track');
  const sticky = app.querySelector('.landing-steps-big-sticky');
  const photo = app.querySelector('.landing-steps-big-photo');
  if (!track || !sticky || !photo) return;
  const rect = track.getBoundingClientRect();
  // O quanto o sticky fica realmente preso é (altura da pista - altura do
  // próprio painel sticky), não a altura da viewport — usar innerHeight aqui
  // fazia o progresso chegar a 100% bem antes do pin soltar de verdade (foto
  // "travava" no topo pelo resto do scroll da seção).
  const total = rect.height - sticky.getBoundingClientRect().height;
  const progress = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 0;
  photo.style.transform = `translateY(${(progress * STEPS_PHOTO_TRAVEL).toFixed(1)}px)`;
  const stepCount = LANDING_STEPS_BIG_PHOTOS.length;
  const stepIndex = Math.min(stepCount - 1, Math.floor(progress * stepCount));
  if (photo.dataset.activeStep === String(stepIndex)) return;
  photo.dataset.activeStep = String(stepIndex);
  photo.querySelectorAll('[data-step]').forEach((el) => {
    el.classList.toggle('is-active', Number(el.dataset.step) === stepIndex);
  });
  // Passos já vistos ficam acesos (não só o atual) — dá a sensação de ir
  // "completando" a lista conforme rola, em vez de cada passo apagar de
  // novo assim que o próximo acende.
  app.querySelectorAll('.landing-steps-big-row[data-step]').forEach((el) => {
    el.classList.toggle('is-active', Number(el.dataset.step) <= stepIndex);
  });
}

window.addEventListener('scroll', () => {
  if (stepsPhotoRaf) return;
  stepsPhotoRaf = requestAnimationFrame(() => {
    stepsPhotoRaf = null;
    updateStepsBigPhoto();
  });
}, { passive: true });

// ---------------- Ações: autenticação ----------------

async function handleAuthSubmit(form) {
  const formData = new FormData(form);
  const email = formData.get('email');
  const password = formData.get('password');
  const fullName = formData.get('fullName');
  const companyName = formData.get('companyName');

  if (state.authMode === 'signup') {
    const captchaToken = typeof grecaptcha !== 'undefined' ? grecaptcha.getResponse() : '';
    if (!captchaToken) {
      state.authError = 'Confirme que você não é um robô antes de continuar.';
      render();
      return;
    }
    state.authLoading = true;
    state.authError = '';
    render();
    try {
      await signUp(email, password, fullName, companyName, captchaToken);
      form.reset();
      state.authLoading = false;
      navigate('#/entrar');
      showSuccess('Conta criada! Verifique seu e-mail para confirmar o acesso e aguarde a aprovação de um administrador para começar a usar o app.', 3200);
      return;
    } catch (error) {
      state.authError = error.message;
    } finally {
      state.authLoading = false;
      // Token de captcha é de uso único — sem resetar, uma segunda tentativa
      // (ex.: após erro de e-mail já cadastrado) reenviaria o mesmo token.
      if (typeof grecaptcha !== 'undefined') grecaptcha.reset();
      render();
    }
    return;
  }

  state.authLoading = true;
  state.authError = '';
  render();
  try {
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
        category: ed.menuCategory || '',
        description: ed.menuDescription || '',
        menu_price: toNumberSafe(ed.menuPrice),
        published: ed.menuPublished,
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
    // Mantém o modal aberto (em vez de fechar) para deixar cadastrar vários
    // ingredientes em sequência sem precisar reabrir a cada um.
    const modal = state.activeModal;
    modal.loading = false;
    modal.name = '';
    modal.packagePrice = '';
    modal.packageAmount = '';
    modal.unit = '';
    modal.category = '';
    modal.brand = '';
    modal.successMessage = 'Ingrediente cadastrado! Pode adicionar outro.';
    render();
    app.querySelector('[data-form="new-ingredient"] [name="name"]')?.focus();
    setTimeout(() => {
      if (state.activeModal === modal) {
        modal.successMessage = '';
        render();
      }
    }, 2500);
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

function openEditExpenseModal(id) {
  const source = state.expenseCategories.find((e) => e.id === id);
  if (!source) return;
  openModal('edit-expense', {
    expenseId: source.id,
    name: source.name,
    monthlyValue: toDecimalString(source.monthly_value),
    percentage: toDecimalString(source.percentage),
  });
}

async function handleEditExpenseSubmit(form) {
  const formData = new FormData(form);
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.updateExpenseCategory(state.activeModal.expenseId, {
      name: formData.get('name'),
      monthly_value: toNumberSafe(formData.get('monthlyValue')),
      percentage: toNumberSafe(formData.get('percentage')) || 1,
    });
    await loadUserData();
    closeModal();
    showSuccess('Despesa atualizada!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

function openConfirmDeleteExpense(id, name) {
  openModal('confirm-delete', {
    kind: 'expense',
    id,
    title: 'Excluir despesa',
    message: `Tem certeza que deseja excluir "${name || 'esta despesa'}"? Essa ação não pode ser desfeita.`,
  });
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

async function handleAddTierSubmit(form) {
  const formData = new FormData(form);
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.createProfitTier(state.session.user.id, {
      name: formData.get('name'),
      multiplier: toNumberSafe(formData.get('multiplierPercent')) / 100,
      position: state.profitTiers.length,
    });
    await loadUserData();
    closeModal();
    showSuccess('Nível de lucro adicionado!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

function openEditTierModal(id) {
  const source = state.profitTiers.find((t) => t.id === id);
  if (!source) return;
  openModal('edit-tier', {
    tierId: source.id,
    name: source.name,
    multiplierPercent: percentFromMultiplier(source.multiplier),
  });
}

async function handleEditTierSubmit(form) {
  const formData = new FormData(form);
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.updateProfitTier(state.activeModal.tierId, {
      name: formData.get('name'),
      multiplier: toNumberSafe(formData.get('multiplierPercent')) / 100,
    });
    await loadUserData();
    closeModal();
    showSuccess('Nível de lucro atualizado!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

function openConfirmDeleteTier(id, name) {
  openModal('confirm-delete', {
    kind: 'tier',
    id,
    title: 'Excluir nível de lucro',
    message: `Tem certeza que deseja excluir "${name || 'este nível'}"? Essa ação não pode ser desfeita.`,
  });
}

async function handleDeleteTier(id) {
  try {
    await db.deleteProfitTier(id);
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro ao excluir: ${error.message}`;
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
    packagePrice: toDecimalString(source.package_price),
    packageAmount: toDecimalString(source.package_amount),
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
    const logoUrl = draft.logoFile
      ? await db.uploadCompanyLogo(state.session.user.id, draft.logoFile)
      : draft.logoUrl;
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
      logo_url: logoUrl,
    });
    draft.logoUrl = logoUrl;
    draft.logoFile = null;
    draft.logoPreviewUrl = '';
    state.companySnapshot = companySnapshotOf(draft);
    showSuccess('Dados da empresa salvos!');
    render();
  } catch (error) {
    state.statusMessage = `Erro ao salvar: ${error.message}`;
    render();
  }
}

// Marca a revisão de preços como feita agora, reiniciando a contagem dos
// 30 dias até o próximo aviso (ver pricesNeedReview).
async function handleMarkPriceReviewDone() {
  state.priceReviewAlertOpen = false;
  try {
    const now = new Date().toISOString();
    await db.updateProfile(state.session.user.id, { last_price_review_at: now });
    state.profile.lastPriceReviewAt = now;
    showSuccess('Revisão de preços registrada!');
  } catch (error) {
    state.statusMessage = `Erro ao registrar revisão: ${error.message}`;
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
  const confirmText = user.companyName || user.fullName || user.email;
  openModal('confirm-delete', {
    kind: 'admin-delete',
    id: user.id,
    title: 'Excluir usuário',
    message: `Excluir permanentemente a conta de "${user.fullName || user.email}" e todos os dados dele? Essa ação não pode ser desfeita.`,
    confirmText,
  });
}

async function handleConfirmDelete() {
  const modal = state.activeModal;
  if (!modal) return;
  closeModal();
  // Pequena pausa entre o modal de confirmação fechar e o de sucesso abrir
  // (quando o kind mostra um) — sem isso os dois apareciam colados, um pop-in
  // em cima do outro quase instantaneamente, dando a impressão de que o
  // modal "aparece duas vezes".
  await sleep(200);
  if (modal.kind === 'ingredient') await handleDeleteSavedIngredient(modal.id);
  if (modal.kind === 'product') await handleDeleteDetail(modal.id);
  if (modal.kind === 'bulk-products') await handleBulkDeleteProducts();
  if (modal.kind === 'expense') await handleDeleteExpense(modal.id);
  if (modal.kind === 'tier') await handleDeleteTier(modal.id);
  if (modal.kind === 'supplier') await handleDeleteSupplier(modal.id);
  if (modal.kind === 'customer') await handleDeleteCustomer(modal.id);
  if (modal.kind === 'admin-suspend') await handleAdminAction('suspend', modal.id);
  if (modal.kind === 'admin-delete') await handleAdminAction('delete', modal.id);
  if (modal.kind === 'recipe-ingredient') handleRemoveIngredient(modal.editorKey, modal.id);
}

function handleRemoveIngredient(editorKey, id) {
  const ed = getEditor(editorKey);
  ed.ingredients = ed.ingredients.filter((i) => i.id !== id);
  render();
}

function openConfirmRemoveIngredient(editorKey, id, name) {
  openModal('confirm-delete', {
    kind: 'recipe-ingredient',
    id,
    editorKey,
    title: 'Excluir ingrediente da receita',
    message: `Tem certeza que deseja excluir "${name || 'este ingrediente'}" desta receita?`,
    confirmLabel: 'Excluir',
  });
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

function openEditSupplierModal(id) {
  const source = state.suppliers.find((s) => s.id === id);
  if (!source) return;
  openModal('edit-supplier', {
    supplierId: source.id,
    name: source.name,
    phone: source.phone || '',
    address: source.address || '',
    site: source.site || '',
    contact_name: source.contact_name || '',
    email: source.email || '',
  });
}

async function handleEditSupplierSubmit(form) {
  const formData = new FormData(form);
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.updateSupplier(state.activeModal.supplierId, {
      name: formData.get('name'),
      phone: formData.get('phone') || '',
      address: formData.get('address') || '',
      site: formData.get('site') || '',
      contact_name: formData.get('contact_name') || '',
      email: formData.get('email') || '',
    });
    await loadUserData();
    closeModal();
    showSuccess('Fornecedor atualizado!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

function openConfirmDeleteSupplier(id, name) {
  openModal('confirm-delete', {
    kind: 'supplier',
    id,
    title: 'Excluir fornecedor',
    message: `Tem certeza que deseja excluir "${name || 'este fornecedor'}"? Essa ação não pode ser desfeita.`,
  });
}

// ---------------- Ações: clientes (recurso do plano Controle) ----------------

async function handleNewCustomer(form) {
  const formData = new FormData(form);
  const draft = {
    name: formData.get('name'),
    phone: formData.get('phone') || '',
    email: formData.get('email') || '',
    address: formData.get('address') || '',
    notes: formData.get('notes') || '',
  };
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.createCustomer(state.session.user.id, draft);
    await loadUserData();
    closeModal();
    showSuccess('Cliente cadastrado!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

async function handleDeleteCustomer(id) {
  try {
    await db.deleteCustomer(id);
    await loadUserData();
  } catch (error) {
    state.statusMessage = `Erro ao excluir cliente: ${error.message}`;
    render();
  }
}

function openEditCustomerModal(id) {
  const source = state.customers.find((c) => c.id === id);
  if (!source) return;
  openModal('edit-customer', {
    customerId: source.id,
    name: source.name,
    phone: source.phone || '',
    email: source.email || '',
    address: source.address || '',
    notes: source.notes || '',
  });
}

async function handleEditCustomerSubmit(form) {
  const formData = new FormData(form);
  state.activeModal.loading = true;
  state.activeModal.error = '';
  render();
  try {
    await db.updateCustomer(state.activeModal.customerId, {
      name: formData.get('name'),
      phone: formData.get('phone') || '',
      email: formData.get('email') || '',
      address: formData.get('address') || '',
      notes: formData.get('notes') || '',
    });
    await loadUserData();
    closeModal();
    showSuccess('Cliente atualizado!');
  } catch (error) {
    state.activeModal.loading = false;
    state.activeModal.error = error.message;
    render();
  }
}

function openConfirmDeleteCustomer(id, name) {
  openModal('confirm-delete', {
    kind: 'customer',
    id,
    title: 'Excluir cliente',
    message: `Tem certeza que deseja excluir "${name || 'este cliente'}"? Essa ação não pode ser desfeita.`,
  });
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
  if (target.dataset.logoInput !== undefined) {
    const file = target.files?.[0];
    if (file) await loadCompanyLogo(file);
    return;
  }
  if (!target.dataset.photoInput) return;
  const file = target.files?.[0];
  if (!file) return;
  await loadEditorPhoto(target.dataset.photoInput, file);
});

async function loadEditorPhoto(editorKey, file) {
  const ed = getEditor(editorKey);
  const compressed = await compressImageToWebp(file);
  ed.photoFile = compressed;
  ed.photoPreviewUrl = URL.createObjectURL(compressed);
  render();
}

async function loadCompanyLogo(file) {
  const compressed = await compressImageToWebp(file);
  state.company.logoFile = compressed;
  state.company.logoPreviewUrl = URL.createObjectURL(compressed);
  render();
}

// Arrastar e soltar uma imagem sobre a dropzone da foto da receita (wizard
// ou detalhe) ou do logotipo da empresa — mesmo destino final do input de
// arquivo correspondente.
app.addEventListener('dragover', (event) => {
  const zone = event.target.closest?.('[data-photo-drop], [data-logo-drop]');
  if (!zone) return;
  event.preventDefault();
  zone.classList.add('is-dragover');
});

app.addEventListener('dragleave', (event) => {
  const zone = event.target.closest?.('[data-photo-drop], [data-logo-drop]');
  if (!zone) return;
  zone.classList.remove('is-dragover');
});

app.addEventListener('drop', async (event) => {
  const zone = event.target.closest?.('[data-photo-drop], [data-logo-drop]');
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove('is-dragover');
  const file = event.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  if (zone.dataset.logoDrop !== undefined) await loadCompanyLogo(file);
  else await loadEditorPhoto(zone.dataset.photoDrop, file);
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
  if (target.matches?.('.input-prefix input')) applyMoneyMask(target);
  if (target.dataset.field === 'menuPriceTier') {
    const ed = getEditor(target.dataset.editor);
    ed.menuPriceTier = target.value;
    if (target.value !== 'custom') {
      const tier = pricingFor(ed).tiers.find((t) => t.name === target.value);
      if (tier) ed.menuPrice = toDecimalString(tier.unitPrice);
    }
    render();
    return;
  }
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
          updated.packagePrice = toDecimalString(match.package_price);
          updated.packageAmount = toDecimalString(match.package_amount);
          updated.unit = match.unit;
        }
      }
      if (field === 'usedAmount') {
        const max = maxUsedAmount(updated);
        if (max && toNumberSafe(updated.usedAmount) > max) updated.usedAmount = toDecimalString(max);
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
  if (target.dataset.search === 'ingredients') {
    state.ingredientSearch = target.value;
    render();
    return;
  }
  if (target.dataset.search === 'products') {
    state.productSearch = target.value;
    render();
    return;
  }
  if (target.dataset.search === 'suppliers') {
    state.supplierSearch = target.value;
    render();
    return;
  }
  if (target.dataset.search === 'customers') {
    state.customerSearch = target.value;
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
    return;
  }
  // Campos de modais "adicionar novo" (ingrediente/despesa/fornecedor/nível):
  // guarda o que foi digitado no próprio state.activeModal, para que um
  // re-render disparado por algo alheio ao modal (ex.: o token do Supabase
  // se renovando ao voltar o foco na aba) não apague o que já foi escrito.
  if (target.dataset.modalField && state.activeModal) {
    state.activeModal[target.dataset.modalField] = target.value;
    render();
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
  if (formType === 'edit-expense') handleEditExpenseSubmit(event.target);
  if (formType === 'add-tier') handleAddTierSubmit(event.target);
  if (formType === 'edit-tier') handleEditTierSubmit(event.target);
  if (formType === 'edit-supplier') handleEditSupplierSubmit(event.target);
  if (formType === 'new-customer') handleNewCustomer(event.target);
  if (formType === 'edit-customer') handleEditCustomerSubmit(event.target);
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
    case 'toggle-menu-published':
      state.detail.menuPublished = !state.detail.menuPublished;
      render();
      break;
    case 'confirm-bulk-delete-products':
      openConfirmBulkDeleteProducts();
      break;
    case 'start-wizard':
      if (!isControlePlan(state.profile) && state.savedProducts.length >= FREE_RECIPE_LIMIT) {
        state.statusMessage = `Você atingiu o limite de ${FREE_RECIPE_LIMIT} receitas do plano Básico. Faça upgrade para o Controle para cadastrar receitas ilimitadas.`;
        render();
        // O aviso aparece no topo da página — sem isso, clicar em "Começar"
        // com a página rolada pra baixo (ex.: olhando a lista de receitas)
        // parecia não fazer nada.
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      }
      startWizard();
      navigate('#/novo-produto');
      render();
      break;
    case 'request-upgrade':
      state.statusMessage = 'Em breve! Fale com a gente pelo suporte para migrar de plano.';
      render();
      break;
    case 'logout':
      requestNavigation(() => signOut());
      break;
    case 'confirm-leave':
      handleConfirmLeave();
      break;
    case 'auth-tab':
      state.authError = '';
      navigate(`#/${el.dataset.mode === 'signup' ? 'cadastro' : 'entrar'}`);
      break;
    case 'add-ingredient':
      openAddRecipeIngredientModal(editorKey);
      break;
    case 'confirm-add-recipe-ingredient':
      handleConfirmAddRecipeIngredient();
      break;
    case 'remove-ingredient': {
      const ed = getEditor(editorKey);
      const ingredient = ed.ingredients.find((i) => i.id === id);
      openConfirmRemoveIngredient(editorKey, id, ingredient?.name);
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
    case 'delete-product':
      openConfirmDeleteProduct(id, el.dataset.name);
      break;
    case 'delete-saved-ingredient':
      openConfirmDeleteIngredient(id);
      break;
    case 'confirm-delete':
      handleConfirmDelete();
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
    case 'delete-expense': {
      const expense = state.expenseCategories.find((e) => e.id === id);
      openConfirmDeleteExpense(id, expense?.name);
      break;
    }
    case 'open-edit-expense':
      openEditExpenseModal(id);
      break;
    case 'add-tier':
      if (!isControlePlan(state.profile) && state.profitTiers.length >= FREE_PROFIT_TIER_LIMIT) {
        state.statusMessage = `Você atingiu o limite de ${FREE_PROFIT_TIER_LIMIT} nível de lucro do plano Básico. Faça upgrade para o Controle para cadastrar até 3 níveis.`;
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      }
      openModal('add-tier');
      break;
    case 'open-edit-tier':
      openEditTierModal(id);
      break;
    case 'delete-tier': {
      const tier = state.profitTiers.find((t) => t.id === id);
      openConfirmDeleteTier(id, tier?.name);
      break;
    }
    case 'save-settings':
      handleSaveSettings();
      break;
    case 'save-company':
      handleSaveCompany();
      break;
    case 'select-menu-link':
      el.select();
      break;
    case 'copy-menu-link': {
      const input = el.closest('.menu-link-row')?.querySelector('input');
      if (input) {
        input.select();
        navigator.clipboard?.writeText(input.value).then(() => showSuccess('Link copiado!'));
      }
      break;
    }
    case 'delete-supplier': {
      const supplier = state.suppliers.find((s) => s.id === id);
      openConfirmDeleteSupplier(id, supplier?.name);
      break;
    }
    case 'open-edit-supplier':
      openEditSupplierModal(id);
      break;
    case 'add-customer-modal':
      openModal('add-customer');
      break;
    case 'delete-customer': {
      const customer = state.customers.find((c) => c.id === id);
      openConfirmDeleteCustomer(id, customer?.name);
      break;
    }
    case 'open-edit-customer':
      openEditCustomerModal(id);
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
    case 'toggle-nav-menu': {
      const menuKey = el.dataset.menu;
      const opening = state.openNavMenu !== menuKey;
      state.openNavMenu = opening ? menuKey : null;
      // Alterna a classe direto no DOM (em vez de render()) pra abertura e
      // fechamento tocarem a transição de CSS de verdade — um render()
      // completo recriaria o nó já no estado final, sem animação.
      setNavDropdownOpen(menuKey, opening);
      break;
    }
    case 'accept-cookies':
      state.cookieConsent = true;
      localStorage.setItem('cookieConsent', 'accepted');
      render();
      break;
    case 'toggle-admin-alerts':
      state.adminAlertsOpen = !state.adminAlertsOpen;
      render();
      break;
    case 'toggle-price-review-alert':
      state.priceReviewAlertOpen = !state.priceReviewAlertOpen;
      render();
      break;
    case 'mark-price-review-done':
      handleMarkPriceReviewDone();
      break;
    case 'toggle-mobile-menu': {
      state.mobileMenuOpen = !state.mobileMenuOpen;
      // Idem: alterna a classe no overlay já montado em vez de um render()
      // completo, pra o slide-in/out (transform, ver _navbar.scss) animar.
      const overlay = app.querySelector('.mobile-drawer-overlay');
      if (overlay) overlay.classList.toggle('open', state.mobileMenuOpen);
      else render();
      break;
    }
    // Categoria escolhida no menu mobile do cardápio público (mesmo drawer
    // do app logado, ver publicMenuNavDrawer): rola até a seção em vez de
    // navegar por #hash (isso mudaria a rota pra fora de #/cardapio/:slug)
    // e fecha o drawer.
    case 'scroll-to-menu-category': {
      document.getElementById(el.dataset.target)?.scrollIntoView({ behavior: 'smooth' });
      state.mobileMenuOpen = false;
      const overlay = app.querySelector('.mobile-drawer-overlay');
      if (overlay) overlay.classList.remove('open');
      break;
    }
    // Ampliar a foto do produto na vitrine (modal simples, só a imagem sobre
    // fundo escuro) — não há mais página interna do produto pra mostrar a
    // foto grande, então esse é o único jeito de vê-la ampliada.
    case 'open-menu-lightbox':
      state.menuLightboxUrl = el.dataset.url;
      render();
      break;
    case 'close-menu-lightbox':
      state.menuLightboxUrl = null;
      render();
      break;
    case 'open-change-password':
      state.profileMenuOpen = false;
      openModal('change-password');
      break;
    case 'open-delete-account':
      openDeleteAccountModal();
      break;
    case 'admin-approve':
      handleAdminAction('approve', id);
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
        packagePrice: toDecimalString(source.package_price),
        packageAmount: toDecimalString(source.package_amount),
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
  if (state.openNavMenu && !event.target.closest('.nav-dropdown')) {
    const menuKey = state.openNavMenu;
    state.openNavMenu = null;
    setNavDropdownOpen(menuKey, false);
  }
  if (state.adminAlertsOpen && !event.target.closest('.alerts-menu')) {
    state.adminAlertsOpen = false;
    render();
  }
  if (state.priceReviewAlertOpen && !event.target.closest('.alerts-menu')) {
    state.priceReviewAlertOpen = false;
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
  if (state.mobileMenuOpen && !event.target.closest('.mobile-drawer') && !event.target.closest('.navbar-menu-toggle')) {
    state.mobileMenuOpen = false;
    const overlay = app.querySelector('.mobile-drawer-overlay');
    if (overlay) overlay.classList.remove('open');
    else render();
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
