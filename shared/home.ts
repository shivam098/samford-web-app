import { bool, num, rows, text, type Data } from './model.js';
export const homeCards = [
  { id: 'visits', label: "Today's visits" },
  { id: 'referrals', label: 'New referrals' },
  { id: 'results', label: 'Results to review' },
  { id: 'admissions', label: 'My admissions' },
  { id: 'pending', label: 'Pending work' }
] as const;
export function defaultHomeLayout(): Data { return { cards: homeCards.map(card => ({ id: card.id, visible: true, rows: 5 })) }; }
export function layoutFromPreferences(preferences: Data): Data {
  const requested = text(preferences, 'homeOrder', homeCards.map(card => card.id).join(',')).split(',').filter(id => homeCards.some(card => card.id === id));
  const order = [...new Set([...requested, ...homeCards.map(card => card.id)])];
  const hidden = text(preferences, 'hiddenCards').split(',');
  const perCard = preferences.cardRows && typeof preferences.cardRows === 'object' && !Array.isArray(preferences.cardRows) ? preferences.cardRows : {};
  return { cards: order.filter(id => homeCards.some(card => card.id === id)).map(id => ({ id, visible: !hidden.includes(id), rows: num(perCard, id, num(preferences, 'rows', 5)) })) };
}
export function preferencesFromLayout(layout: Data): Data {
  const cards = rows(layout, 'cards');
  return { homeOrder: cards.map(card => text(card, 'id')).join(','), hiddenCards: cards.filter(card => !bool(card, 'visible')).map(card => text(card, 'id')).join(','),
    cardRows: Object.fromEntries(cards.map(card => [text(card, 'id'), num(card, 'rows', 5)])), rows: num(cards.find(card => card.id === 'visits') ?? {}, 'rows', 5) };
}
export const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function repeatedRosterDates(month: string, days: string[]): string[] {
  if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) return [];
  const start = new Date(`${month}-01T12:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  return Array.from({ length: end }, (_, index) => {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), index + 1, 12));
    return { date: date.toISOString().slice(0, 10), weekday: weekdays[(date.getUTCDay() + 6) % 7] };
  }).filter(day => days.includes(day.weekday)).map(day => day.date);
}
