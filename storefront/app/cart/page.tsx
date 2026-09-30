'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { money } from '../api';
import LineItem from '../LineItem';
import Loader from '../Loader';
import { useStore } from '../StoreProvider';

export default function CartPage() {
  const { ready, cart, promo, busy, message, count, applyCode, removeCode } = useStore();
  const [code, setCode] = useState('');
  if (!ready) return <Loader label="Loading…" />;
  if (!cart?.lineItems.length) return <main><section className="checkoutPanel"><h1>Your cart</h1><p>Your cart is empty.</p><Link className="button" href="/">Continue shopping</Link></section></main>;

  const itemsTotal = cart.lineItems.reduce((sum, item) => sum + item.totalPrice.centAmount, 0);
  const currency = cart.totalPrice;
  // The promo predicate tests the total before the cart discount, so add that discount back to compare.
  const subtotal = cart.totalPrice.centAmount + (cart.discountOnTotalPrice?.discountedAmount.centAmount ?? 0);
  const threshold = promo?.thresholds.find(entry => entry.currencyCode === currency.currencyCode);
  const reached = !!threshold && subtotal >= threshold.centAmount;
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await applyCode(code); setCode(''); }

  return <main>
    <div className="cartPage">
      <section><h1>Your cart <small>({count} {count === 1 ? 'item' : 'items'})</small></h1>
        <div className="cartList">{cart.lineItems.map(item => <LineItem key={item.id} item={item} controls />)}</div>
        {message && <p className="status" role="status">{message}</p>}</section>
      <aside className="summary"><h2>Order summary</h2>
        {promo && <div className={`promo${reached ? ' on' : ''}`}>{!promo.thresholds.length ? `${promo.percent}% off your order` : !threshold ? `${promo.percent}% off orders of ${money(promo.thresholds[0])} or more (${promo.thresholds.map(entry => entry.currencyCode).join('/')} carts only)` : reached ? `${promo.percent}% cart discount applied` : <>Spend {money({ ...threshold, centAmount: threshold.centAmount - subtotal })} more for {promo.percent}% off<div className="bar"><i style={{ width: `${Math.min(100, subtotal / threshold.centAmount * 100)}%` }} /></div></>}</div>}
        <form className="codeForm" onSubmit={submit}><input placeholder="Discount code" value={code} onChange={event => setCode(event.target.value)} maxLength={64} /><button disabled={busy || !code.trim()} type="submit">Apply</button></form>
        {cart.discountCodes?.map(entry => <div className="codeChip" key={entry.discountCode.id}><span>{entry.discountCode.obj?.code ?? 'Code'}{entry.state !== 'MatchesCart' && ' (not applicable)'}</span><button className="link" disabled={busy} onClick={() => removeCode(entry.discountCode.id)}>Remove</button></div>)}
        <div className="row"><span>Items</span><span>{money({ ...currency, centAmount: itemsTotal })}</span></div>
        {cart.discountOnTotalPrice && <div className="row savings"><span>Cart discount</span><strong>−{money(cart.discountOnTotalPrice.discountedAmount)}</strong></div>}
        <div className="row muted"><span>Shipping</span><span>{cart.shippingInfo?.price ? (cart.shippingInfo.price.centAmount ? money(cart.shippingInfo.price) : 'Free') : 'Calculated at checkout'}</span></div>
        <div className="total"><span>Total</span><strong>{money(cart.totalPrice)}</strong></div>
        <Link className="button checkoutButton" href="/checkout">Proceed to checkout</Link>
        <Link className="link" href="/">Continue shopping</Link></aside>
    </div>
  </main>;
}
