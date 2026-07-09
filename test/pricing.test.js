import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateIngredientCost, calculatePricing, toNumber } from '../src/pricing.js';

describe('pricing helpers', () => {
  it('parses Brazilian decimal strings', () => {
    assert.equal(toNumber('1.234,56'), 1234.56);
    assert.equal(toNumber('7,50'), 7.5);
    assert.equal(toNumber('1,234.56'), 1234.56);
    assert.equal(toNumber('R$ 12,90'), 12.9);
    assert.equal(toNumber('1.000'), 1000);
  });

  it('calculates proportional ingredient cost', () => {
    assert.equal(calculateIngredientCost({ packagePrice: '10', packageAmount: '1000', usedAmount: '250' }), 2.5);
  });

  it('calculates total cost, unit cost and profit tiers using real-world figures', () => {
    // Exemplo real: Açúcar Refinado Caravelas R$3,10/1000g, 120g usados; despesas
    // mensais Gás/Limpeza/Energia/Água a 1%; níveis de lucro 250/280/350%; 14 unidades por forma.
    const result = calculatePricing({
      ingredients: [{ packagePrice: '3,10', packageAmount: '1000', usedAmount: '120' }],
      expenseCategories: [
        { name: 'Gás', monthly_value: 0, percentage: 1 },
        { name: 'Limpeza', monthly_value: 10, percentage: 1 },
        { name: 'Energia', monthly_value: 250, percentage: 1 },
        { name: 'Água', monthly_value: 75, percentage: 1 },
      ],
      profitTiers: [
        { id: 'min', name: 'Mínimo', multiplier: 2.5 },
        { id: 'med', name: 'Média', multiplier: 2.8 },
        { id: 'max', name: 'Máximo', multiplier: 3.5 },
      ],
      yieldAmount: '14',
    });

    assert.equal(result.ingredientsCost.toFixed(2), '0.37');
    assert.equal(result.expensesCost.toFixed(2), '3.35');
    assert.equal(result.totalCost.toFixed(2), '3.72');
    assert.ok(Math.abs(result.unitCost - 0.2657) < 0.001);

    const minimo = result.tiers.find((t) => t.id === 'min');
    assert.equal(minimo.unitPrice, 1); // arredondado para cima até o real fechado
    assert.equal(minimo.totalPrice, 14);
    assert.ok(minimo.netProfitUnit > 0.7 && minimo.netProfitUnit < 0.74);
  });
});
