import { homeCards, defaultHomeLayout, preferencesFromLayout } from '../shared/home.js';
import { bool, num, rows, strings, text, type Data } from '../shared/model.js';
import { Store, requireThat } from './store.js';
export function homePolicy(store: Store, department: string): Data {
  const policy = store.all('homeDefault').find(entity => entity.department === department);
  return { layout: policy?.data.layout ?? defaultHomeLayout(), lockedCards: [...new Set(['referrals', 'results', ...strings(policy?.data ?? {}, 'lockedCards')])], version: policy?.version ?? 1 };
}
export function validateHomeLayout(layout: Data, locked: string[]): Data {
  const cards = rows(layout, 'cards');
  requireThat(cards.length === homeCards.length && new Set(cards.map(card => text(card, 'id'))).size === homeCards.length && cards.every(card => homeCards.some(definition => definition.id === text(card, 'id'))), 'Include each Home card exactly once.');
  for (const card of cards) {
    requireThat(typeof card.visible === 'boolean' && Number.isInteger(num(card, 'rows')) && num(card, 'rows') >= 1 && num(card, 'rows') <= 20, 'Each card needs a visibility choice and between 1 and 20 rows.');
    requireThat(!locked.includes(text(card, 'id')) || bool(card, 'visible'), `${text(card, 'id')} is locked by the hospital and cannot be hidden.`);
  }
  return preferencesFromLayout(layout);
}
