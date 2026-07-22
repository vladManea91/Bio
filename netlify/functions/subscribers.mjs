import { requireAdmin, text } from '../../lib/http.mjs';
import { openStore } from '../../lib/store.mjs';

/** Admin only. Downloads the list as CSV for Kit, Beehiiv, anywhere. */
export default async (req) => {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const store = await openStore('receipts');
  const list = (await store.get('subscribers')) || { people: [] };
  const rows = [['email', 'signed_up_at', 'source', 'ref']];
  for (const p of list.people) rows.push([p.email, p.at, p.source || '', p.ref || '']);

  const csv = rows
    .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  return text(csv, {
    type: 'text/csv; charset=utf-8',
    headers: { 'content-disposition': 'attachment; filename="subscribers.csv"' }
  });
};

export const config = { path: '/api/subscribers' };
