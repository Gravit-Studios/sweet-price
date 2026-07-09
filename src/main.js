import { calculatePricing, formatCurrency } from './pricing.js';
import { signUp, signIn, signOut, getSession, onAuthStateChange } from './auth.js';
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

function defaultWizard() {
  return {
    step: 1,
    productName: '',
    yieldAmount: '1',
    ingredients: [newIngredient()],
  };
}

function defaultDetail() {
  return {
    loading: false,
    productId: null,
    productName: '',
    yieldAmount: '',
    ingredients: [],
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
    const [ingredients, products, history, expenseCategories, profitTiers, suppliers] = await Promise.all([
      db.listIngredients(userId),
      db.listProducts(userId),
      db.listHistory(userId, 30),
      db.ensureDefaultExpenseCategories(userId),
      db.ensureDefaultProfitTiers(userId),
      db.listSuppliers(userId),
    ]);
    state.savedIngredients = ingredients;
    state.savedProducts = products;
    state.history = history;
    state.expenseCategories = expenseCategories;
    state.profitTiers = profitTiers;
    state.suppliers = suppliers;
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
    };
  } catch (error) {
    state.statusMessage = `Erro ao abrir produto: ${error.message}`;
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
  render();
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
  }
  render();
});

// ---------------- Fragmentos de UI reutilizáveis ----------------

function banner(title, subtitle) {
  return `<div class="banner">${headerArt}<div class="banner-content"><p class="eyebrow">Delícias da Tai</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></div>`;
}

function statusBox() {
  return state.statusMessage ? `<p class="status-message">${escapeHtml(state.statusMessage)}</p>` : '';
}

function loadingMsg() {
  return '<p class="muted">Carregando...</p>';
}

function emptyState(message, showCta) {
  return `<div class="empty-state"><p>${escapeHtml(message)}</p>${showCta ? '<button type="button" data-action="start-wizard">Criar produto</button>' : ''}</div>`;
}

function fieldFor(editorKey, key, label, value, mode = 'text') {
  return `<label>${label}<input data-editor="${editorKey}" data-field="${key}" inputmode="${mode}" value="${escapeHtml(value)}" /></label>`;
}

function basicFields(editorKey, editor) {
  return `<div class="field-grid">
    ${fieldFor(editorKey, 'productName', 'Nome do produto', editor.productName)}
    ${fieldFor(editorKey, 'yieldAmount', 'Rendimento (Qnt. por forma)', editor.yieldAmount, 'decimal')}
  </div>`;
}

function ingredientRows(editorKey, ingredients) {
  const picker = state.savedIngredients.length > 0 ? `
    <select data-role="ingredient-picker-${editorKey}">
      <option value="">Usar da base...</option>
      ${state.savedIngredients.map((si) => `<option value="${si.id}">${escapeHtml(si.name)}</option>`).join('')}
    </select>
    <button type="button" class="ghost" data-action="use-ingredient" data-editor="${editorKey}">Adicionar selecionado</button>` : '';

  return `
  <div class="ingredient-grid header-row" aria-hidden="true"><span>Ingrediente</span><span>Preço da compra</span><span>Qtd. comprada</span><span>Qtd. usada</span><span>Un.</span><span></span></div>
  ${ingredients.map((ingredient) => `
    <div class="ingredient-grid" data-ingredient="${ingredient.id}">
      <input aria-label="Ingrediente" data-editor="${editorKey}" data-ingredient-field="name" value="${escapeHtml(ingredient.name)}" />
      <input aria-label="Preço da compra" inputmode="decimal" data-editor="${editorKey}" data-ingredient-field="packagePrice" value="${escapeHtml(ingredient.packagePrice)}" />
      <input aria-label="Quantidade comprada" inputmode="decimal" data-editor="${editorKey}" data-ingredient-field="packageAmount" value="${escapeHtml(ingredient.packageAmount)}" />
      <input aria-label="Quantidade usada" inputmode="decimal" data-editor="${editorKey}" data-ingredient-field="usedAmount" value="${escapeHtml(ingredient.usedAmount)}" />
      <input aria-label="Unidade" data-editor="${editorKey}" data-ingredient-field="unit" value="${escapeHtml(ingredient.unit)}" />
      <button class="ghost" type="button" data-action="remove-ingredient" data-editor="${editorKey}" data-id="${ingredient.id}">Remover</button>
    </div>`).join('')}
  <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
    <button type="button" data-action="add-ingredient" data-editor="${editorKey}">Adicionar ingrediente</button>
    ${picker}
  </div>`;
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
      <strong>${escapeHtml(product.name)}</strong>
      <span class="muted">Rendimento: ${product.yield_amount} un.</span>
    </div>`).join('')}</div>`;
}

// ---------------- Páginas ----------------

function renderDashboard() {
  const ultimo = state.history[0];
  const ultimoMedia = ultimo?.tiers?.find((t) => t.name === 'Média') ?? ultimo?.tiers?.[0];
  return `
    ${banner('Calculadora de precificação para confeitaria', 'Acompanhe seus produtos, ingredientes e o histórico de preços em um só lugar.')}
    ${statusBox()}
    <div class="stat-grid">
      <div class="stat-card"><span>Produtos salvos</span><strong>${state.savedProducts.length}</strong></div>
      <div class="stat-card"><span>Ingredientes cadastrados</span><strong>${state.savedIngredients.length}</strong></div>
      <div class="stat-card"><span>Último preço (média)</span><strong>${ultimoMedia ? formatCurrency(ultimoMedia.unitPrice) : '—'}</strong></div>
    </div>
    <div class="panel">
      <div class="section-header"><h2>Produtos recentes</h2><button type="button" class="ghost" data-action="goto" data-route="produtos">Ver todos</button></div>
      ${state.dataLoading ? loadingMsg() : (state.savedProducts.length ? productCardGrid(state.savedProducts.slice(0, 4)) : emptyState('Nenhum produto salvo ainda.', true))}
    </div>`;
}

function renderProdutosPage() {
  return `
    <div class="section-header">
      <div><p class="eyebrow">Produtos</p><h2>Seus produtos salvos</h2></div>
      <button type="button" data-action="start-wizard">+ Novo produto</button>
    </div>
    ${statusBox()}
    ${state.dataLoading ? loadingMsg() : (state.savedProducts.length ? productCardGrid(state.savedProducts) : `<div class="panel">${emptyState('Você ainda não salvou nenhum produto.', true)}</div>`)}
  `;
}

function renderProdutoDetalhe(id) {
  if (state.detail.loading || state.detail.productId !== id) return loadingMsg();
  const editor = state.detail;
  return `
    <div class="section-header">
      <div><p class="eyebrow">Produto</p><h2>${escapeHtml(editor.productName || 'Produto')}</h2></div>
      <button type="button" class="ghost" data-action="goto" data-route="produtos">Voltar para produtos</button>
    </div>
    ${statusBox()}
    <div class="panel">${basicFields('detail', editor)}</div>
    <div class="panel"><h3>Ingredientes e embalagens usados</h3>${ingredientRows('detail', editor.ingredients)}</div>
    <div class="content-grid">
      <div class="panel cost-panel">
        <h3>Ações</h3>
        <div class="save-actions">
          <button type="button" data-action="save-detail">Salvar alterações</button>
          <button type="button" class="ghost" data-action="save-history-detail">Salvar cálculo no histórico</button>
          <button type="button" class="danger" data-action="delete-detail" data-id="${id}">Excluir produto</button>
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
      <div><p class="eyebrow">Novo produto</p><h2>Vamos montar sua ficha de precificação</h2></div>
      <button type="button" class="ghost" data-action="goto" data-route="produtos">Cancelar</button>
    </div>
    ${statusBox()}
    <div class="wizard-steps">
      ${stepLabels.map((label, i) => `<div class="wizard-step ${editor.step === i + 1 ? 'active' : ''}">${i + 1}. ${label}</div>`).join('')}
    </div>
    <div class="panel">
      ${editor.step === 1 ? `<div class="field-grid">${fieldFor('wizard', 'productName', 'Nome do produto', editor.productName)}</div>` : ''}
      ${editor.step === 2 ? `<h3>Selecione os ingredientes/embalagens da base e informe a quantidade usada</h3>${ingredientRows('wizard', editor.ingredients)}` : ''}
      ${editor.step === 3 ? `<div class="field-grid">${fieldFor('wizard', 'yieldAmount', 'Quantas unidades saem dessa receita (Qnt. por forma)', editor.yieldAmount, 'decimal')}</div>` : ''}
      ${editor.step === 4 ? renderWizardReview(editor) : ''}
    </div>
    <div class="wizard-actions">
      <button type="button" class="ghost" data-action="wizard-back" ${editor.step === 1 ? 'disabled' : ''}>Voltar</button>
      ${editor.step < 4
        ? '<button type="button" data-action="wizard-next">Avançar</button>'
        : '<button type="button" data-action="wizard-save">Salvar produto</button>'}
    </div>`;
}

function renderWizardReview(editor) {
  const pricing = pricingFor(editor);
  return `<div class="wizard-review">
    <h3>${escapeHtml(editor.productName || 'Produto sem nome')}</h3>
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
          <span class="saved-list-actions"><button type="button" class="ghost" data-action="delete-saved-ingredient" data-id="${i.id}">Excluir</button></span>
        </li>`).join('')}</ul>`
    : emptyState('Nenhum ingrediente cadastrado ainda.', false);

  return `
    <div class="section-header"><div><p class="eyebrow">Base de produtos</p><h2>Ingredientes e embalagens</h2></div></div>
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
          <input aria-label="Valor mensal" inputmode="decimal" data-expense-id="${expense.id}" data-expense-field="monthly_value" value="${escapeHtml(expense.monthly_value)}" />
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

function renderLucroPage() {
  return `
    <div class="section-header"><div><p class="eyebrow">Base de lucro</p><h2>Níveis de margem</h2></div></div>
    <p>Cada nível multiplica o custo por unidade para sugerir o preço de venda (ex.: custo × 2,5 no nível Mínimo).</p>
    ${statusBox()}
    <div class="panel">
      <div class="ingredient-grid header-row" aria-hidden="true" style="grid-template-columns: 1fr 1fr;"><span>Nível</span><span>Multiplicador</span></div>
      ${state.profitTiers.map((tier) => `
        <div class="ingredient-grid" style="grid-template-columns: 1fr 1fr;" data-tier-id="${tier.id}">
          <input aria-label="Nome do nível" data-tier-id="${tier.id}" data-tier-field="name" value="${escapeHtml(tier.name)}" />
          <input aria-label="Multiplicador" inputmode="decimal" data-tier-id="${tier.id}" data-tier-field="multiplier" value="${escapeHtml(tier.multiplier)}" />
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
    default: return renderDashboard();
  }
}

// ---------------- Shell / autenticação ----------------

function navItem(route, label) {
  const active = state.route.path === route;
  return `<li><button type="button" class="nav-link ${active ? 'active' : ''}" data-action="goto" data-route="${route}">${label}</button></li>`;
}

function shellHtml() {
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark"></span> Delícias da Tai</div>
        <ul class="nav-list">
          ${navItem('inicio', 'Início')}
          ${navItem('produtos', 'Produtos')}
          ${navItem('ingredientes', 'Ingredientes')}
          ${navItem('despesas', 'Despesas')}
          ${navItem('lucro', 'Lucro')}
          ${navItem('fornecedores', 'Fornecedores')}
          ${navItem('historico', 'Histórico')}
        </ul>
        <button type="button" class="nav-cta" data-action="start-wizard" style="width:100%">+ Novo produto</button>
      </aside>
      <div class="main-area">
        <div class="topbar">
          <span>Olá, ${escapeHtml(state.session.user.email)}</span>
          <button type="button" class="ghost" data-action="logout">Sair</button>
        </div>
        <div class="page">${renderPage()}</div>
      </div>
    </div>`;
}

function authHtml() {
  const isSignUp = state.authMode === 'signup';
  return `
    <div class="auth-wrap">
      ${banner('Calculadora de precificação para confeitaria', 'Entre com sua conta para salvar produtos, ingredientes e o histórico dos seus cálculos.')}
      <div class="panel auth-panel">
        <div class="auth-tabs">
          <button type="button" class="${!isSignUp ? 'active' : 'ghost'}" data-action="auth-tab" data-mode="signin">Entrar</button>
          <button type="button" class="${isSignUp ? 'active' : 'ghost'}" data-action="auth-tab" data-mode="signup">Criar conta</button>
        </div>
        <form data-form="auth">
          ${isSignUp ? '<label>Nome<input name="fullName" type="text" required /></label>' : ''}
          <label>E-mail<input name="email" type="email" required /></label>
          <label>Senha<input name="password" type="password" minlength="6" required /></label>
          ${state.authError ? `<p class="auth-error">${escapeHtml(state.authError)}</p>` : ''}
          <button type="submit" ${state.authLoading ? 'disabled' : ''}>
            ${state.authLoading ? 'Aguarde...' : isSignUp ? 'Criar conta' : 'Entrar'}
          </button>
        </form>
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
  if (ed.step === 1 && !ed.productName.trim()) {
    state.statusMessage = 'Dê um nome ao produto antes de continuar.';
    render();
    return;
  }
  if (ed.step === 2 && !ed.ingredients.some((i) => i.name.trim())) {
    state.statusMessage = 'Selecione pelo menos um ingrediente da base.';
    render();
    return;
  }
  if (ed.step === 3 && toNumberSafe(ed.yieldAmount) <= 0) {
    state.statusMessage = 'Informe quantas unidades saem dessa receita.';
    render();
    return;
  }
  state.statusMessage = '';
  ed.step = Math.min(4, ed.step + 1);
  render();
}

async function handleWizardSave() {
  const ed = state.wizard;
  try {
    const saved = await db.saveProduct(
      state.session.user.id,
      null,
      {
        name: ed.productName || 'Produto sem nome',
        yield_amount: Math.max(1, Math.floor(toNumberSafe(ed.yieldAmount) || 1)),
      },
      ed.ingredients,
    );
    await loadUserData();
    state.statusMessage = 'Produto criado com sucesso!';
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
  try {
    await db.saveProduct(
      state.session.user.id,
      ed.productId,
      {
        name: ed.productName || 'Produto sem nome',
        yield_amount: Math.max(1, Math.floor(toNumberSafe(ed.yieldAmount) || 1)),
      },
      ed.ingredients,
    );
    state.statusMessage = 'Alterações salvas.';
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
      productName: ed.productName || 'Produto sem nome',
      ...pricing,
    });
    state.statusMessage = 'Cálculo salvo no histórico.';
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

function handleUseIngredientInEditor(editorKey) {
  const select = app.querySelector(`[data-role="ingredient-picker-${editorKey}"]`);
  if (!select || !select.value) return;
  const source = state.savedIngredients.find((i) => i.id === select.value);
  if (!source) return;
  const ed = getEditor(editorKey);
  ed.ingredients.push(newIngredient({
    ingredientId: source.id,
    name: source.name,
    packagePrice: String(source.package_price),
    packageAmount: String(source.package_amount),
    usedAmount: '',
    unit: source.unit,
  }));
  render();
}

async function handleSaveExpenses() {
  try {
    await Promise.all(state.expenseCategories.map((expense) => db.updateExpenseCategory(expense.id, {
      name: expense.name,
      monthly_value: toNumberSafe(expense.monthly_value),
      percentage: toNumberSafe(expense.percentage),
    })));
    state.statusMessage = 'Despesas salvas.';
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
    state.statusMessage = 'Níveis de lucro salvos.';
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
  } catch (error) {
    state.statusMessage = `Erro ao cadastrar fornecedor: ${error.message}`;
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
    ed.ingredients = ed.ingredients.map((i) => (i.id === rowId ? { ...i, [target.dataset.ingredientField]: target.value } : i));
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
  if (target.dataset.tierField) {
    state.profitTiers = state.profitTiers.map((t) => (t.id === target.dataset.tierId ? { ...t, [target.dataset.tierField]: target.value } : t));
    render();
  }
});

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
    case 'use-ingredient':
      handleUseIngredientInEditor(editorKey);
      break;
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
    default:
      break;
  }
});

render();
