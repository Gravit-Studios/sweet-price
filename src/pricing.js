export const BRL_FORMATTER = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;

  const sanitized = String(value)
    .trim()
    .replace(/[^\d,.-]/g, '');

  if (!sanitized) return 0;

  const lastComma = sanitized.lastIndexOf(',');
  const lastDot = sanitized.lastIndexOf('.');
  const separatorIndex = Math.max(lastComma, lastDot);
  const decimalSeparator = lastComma > lastDot ? ',' : '.';
  const hasSingleSeparator = (lastComma === -1) !== (lastDot === -1);
  const digitsAfterSeparator = separatorIndex >= 0 ? sanitized.length - separatorIndex - 1 : 0;
  const shouldTreatAsThousands = hasSingleSeparator && digitsAfterSeparator === 3;

  const normalized = shouldTreatAsThousands
    ? sanitized.replace(/[,.]/g, '')
    : sanitized
      .replace(decimalSeparator === ',' ? /\./g : /,/g, '')
      .replace(decimalSeparator, '.');
  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatCurrency(value) {
  return BRL_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

export function calculateIngredientCost(ingredient) {
  const packagePrice = toNumber(ingredient.packagePrice);
  const packageAmount = toNumber(ingredient.packageAmount);
  const usedAmount = toNumber(ingredient.usedAmount);

  if (packagePrice <= 0 || packageAmount <= 0 || usedAmount <= 0) return 0;

  return (packagePrice / packageAmount) * usedAmount;
}

// Custo de uma categoria de despesa alocado à receita: valor mensal x percentual (ex.: R$250 x 1% = R$2,50)
export function calculateExpenseCost(expense) {
  const monthlyValue = toNumber(expense.monthly_value ?? expense.monthlyValue);
  const percentage = toNumber(expense.percentage);
  return monthlyValue * (percentage / 100);
}

// Preço de venda arredondado para cima até o real fechado (não vender com trocado)
export function roundUpToWholeReal(value) {
  return Math.ceil(value - 1e-9);
}

export function calculatePricing({
  ingredients = [],
  expenseCategories = [],
  profitTiers = [],
  yieldAmount = 1,
}) {
  const ingredientsCost = ingredients.reduce(
    (sum, ingredient) => sum + calculateIngredientCost(ingredient),
    0,
  );
  const expensesCost = expenseCategories.reduce(
    (sum, expense) => sum + calculateExpenseCost(expense),
    0,
  );
  const totalCost = ingredientsCost + expensesCost;
  const safeYield = Math.max(1, Math.floor(toNumber(yieldAmount) || 1));
  const unitCost = totalCost / safeYield;

  const tiers = profitTiers.map((tier) => {
    const multiplier = Math.max(0, toNumber(tier.multiplier));
    const rawUnitPrice = unitCost * multiplier;
    const unitPrice = roundUpToWholeReal(rawUnitPrice);
    const totalPrice = unitPrice * safeYield;
    const netProfitUnit = unitPrice - unitCost;
    const netProfitTotal = netProfitUnit * safeYield;
    return {
      id: tier.id,
      name: tier.name,
      multiplier,
      unitPrice,
      totalPrice,
      netProfitUnit,
      netProfitTotal,
    };
  });

  return {
    ingredientsCost,
    expensesCost,
    totalCost,
    unitCost,
    yieldAmount: safeYield,
    tiers,
  };
}
