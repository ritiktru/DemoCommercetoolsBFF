'use client';
// Payment admin for the POC: capture, cancel and refund through the BFF (which calls Adyen). OrderIQ owns this in production.
import { useEffect, useState } from 'react';
import { api, money } from '../api';

type Operation = { type: string; amount?: number; status: string; pspReference: string; reason?: string; requestedAt: string };
type Payment = {
  paymentRef: string; status: string; currency: string; amount: number; capturedAmount: number; refundedAmount: number;
  paymentMethod?: string; pspReference?: string; orderNumber?: string; failureReason?: string; operations: Operation[]; createdAt?: string;
};
const cents = (major: string) => Math.round(Number(major) * 100); // ponytail: 2-decimal currencies only (GBP, CAD, USD, EUR)
const major = (minor: number) => (minor / 100).toFixed(2);

export default function Orders() {
  const [key, setKey] = useState('');
  const [payments, setPayments] = useState<Payment[]>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  // The key stays in this tab only; it is sent as X-Admin-Key and checked by the BFF.
  useEffect(() => { const saved = sessionStorage.getItem('adminKey'); if (saved) { setKey(saved); void load(saved); } }, []);

  async function load(adminKey = key) {
    setMessage('');
    try {
      const data = await api('/api/admin/payments', { headers: { 'X-Admin-Key': adminKey } });
      sessionStorage.setItem('adminKey', adminKey); setPayments(data.payments);
    } catch (error) { setPayments(undefined); setMessage((error as Error).message); }
  }

  async function act(payment: Payment, action: 'capture' | 'cancel' | 'refund') {
    const typed = amounts[payment.paymentRef];
    if (action === 'refund' && !confirm(`Refund ${typed || major(payment.capturedAmount - payment.refundedAmount)} ${payment.currency} for ${payment.orderNumber ?? payment.paymentRef}?`)) return;
    setBusy(payment.paymentRef); setMessage('');
    try {
      await api(`/api/admin/payments/${payment.paymentRef}/${action}`, {
        method: 'POST', headers: { 'X-Admin-Key': key },
        body: JSON.stringify(action !== 'cancel' && typed ? { amount: cents(typed) } : {}),
      });
      setAmounts(current => ({ ...current, [payment.paymentRef]: '' }));
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(''); }
  }

  const m = (p: Payment, value: number) => money({ currencyCode: p.currency, centAmount: value });
  return <main>
    <header><div><span className="eyebrow">PAYMENT ADMIN</span><h1>Orders</h1></div></header>
    <section className="checkoutPanel">
      <form className="checkoutForm" onSubmit={event => { event.preventDefault(); void load(); }}>
        <label>Admin key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} /></label>
        <button className="checkoutButton" type="submit">Load payments</button>
      </form>
      {message && <p className="error" role="alert">{message}</p>}
    </section>
    {payments && <section className="checkoutPanel" style={{ overflowX: 'auto' }}>
      {!payments.length ? <p>No payments yet.</p> : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead><tr style={{ textAlign: 'left' }}>
          <th>Created</th><th>Order</th><th>Payment</th><th>Method</th><th>Status</th><th>Held</th><th>Captured</th><th>Refunded</th><th>Actions</th>
        </tr></thead>
        <tbody>{payments.map(p => {
          const canHold = p.status === 'AUTHORISED', canRefund = p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED';
          return <tr key={p.paymentRef} style={{ borderTop: '1px solid var(--line)', verticalAlign: 'top' }}>
            <td>{p.createdAt ? new Date(p.createdAt).toLocaleString() : '—'}</td>
            <td>{p.orderNumber ?? '—'}</td>
            <td title={p.pspReference ?? ''}><code>{p.paymentRef.slice(0, 12)}…</code></td>
            <td>{p.paymentMethod ?? '—'}</td>
            <td><strong>{p.status}</strong>{p.failureReason && <div className="error">{p.failureReason}</div>}
              {p.operations.map(o => <div key={o.pspReference} style={{ color: 'var(--muted)', fontSize: 12 }}>{o.type}{o.amount ? ` ${m(p, o.amount)}` : ''} · {o.status}</div>)}</td>
            <td>{m(p, p.amount)}</td><td>{m(p, p.capturedAmount)}</td><td>{m(p, p.refundedAmount)}</td>
            <td>{(canHold || canRefund) && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input aria-label="Amount" inputMode="decimal" style={{ width: 90 }} placeholder={major(canHold ? p.amount : p.capturedAmount - p.refundedAmount)}
                value={amounts[p.paymentRef] ?? ''} onChange={event => setAmounts(current => ({ ...current, [p.paymentRef]: event.target.value }))} />
              {canHold && <button disabled={busy === p.paymentRef} onClick={() => act(p, 'capture')}>Capture</button>}
              {canHold && <button disabled={busy === p.paymentRef} onClick={() => act(p, 'cancel')}>Cancel</button>}
              {canRefund && <button disabled={busy === p.paymentRef} onClick={() => act(p, 'refund')}>Refund</button>}
            </div>}</td>
          </tr>;
        })}</tbody>
      </table>}
    </section>}
  </main>;
}
