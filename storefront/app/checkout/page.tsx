'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, money, type Money } from '../api';
import LineItem from '../LineItem';
import Loader from '../Loader';
import { useStore } from '../StoreProvider';

type Address = { firstName: string; lastName: string; streetName: string; city: string; state: string; postalCode: string; phone: string };
type ShippingMethod = { id: string; name: string; isDefault?: boolean };
const blank: Address = { firstName: '', lastName: '', streetName: '', city: '', state: '', postalCode: '', phone: '' };

// Global Payments hosted fields: card data is typed into GP iframes and only a single-use token reaches our BFF.
type CardForm = { on(event: string, handler: (response: { paymentReference?: string; reasons?: Array<{ message?: string }> }) => void): void; dispose?(): void };
type GlobalPaymentsJs = { configure(options: object): void; creditCard: { form(target: string, options: object): CardForm } };
declare global { interface Window { GlobalPayments?: GlobalPaymentsJs } }
function loadGlobalPayments(): Promise<GlobalPaymentsJs> {
  if (window.GlobalPayments) return Promise.resolve(window.GlobalPayments);
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src: 'https://js.globalpay.com/4.1.11/globalpayments.js', async: true });
    script.onload = () => window.GlobalPayments ? resolve(window.GlobalPayments) : reject(new Error('Payment form failed to load'));
    script.onerror = () => reject(new Error('Payment form failed to load'));
    document.head.append(script);
  });
}

function AddressFields({ value, onChange, prefix }: { value: Address; onChange: (next: Address) => void; prefix: string }) {
  const field = (name: keyof Address, label: string, autoComplete: string, required = true) =>
    <label>{label}<input required={required} autoComplete={`${prefix} ${autoComplete}`} value={value[name]} onChange={event => onChange({ ...value, [name]: event.target.value })} /></label>;
  return <div className="checkoutForm">
    {field('firstName', 'First name', 'given-name')}{field('lastName', 'Last name', 'family-name')}
    <div className="wide">{field('streetName', 'Street address', 'address-line1')}</div>
    {field('city', 'City', 'address-level2')}{field('state', 'State / province / county', 'address-level1')}
    {field('postalCode', 'Postal code', 'postal-code')}{field('phone', 'Phone (optional)', 'tel', false)}
  </div>;
}

export default function Checkout() {
  const { ready, storeKey, cart, setCart, customer } = useStore();
  const [email, setEmail] = useState('');
  const [shipping, setShipping] = useState<Address>(blank);
  const [billing, setBilling] = useState<Address>(blank);
  const [sameBilling, setSameBilling] = useState(true);
  const [methods, setMethods] = useState<ShippingMethod[]>([]);
  const [methodId, setMethodId] = useState('');
  const [placed, setPlaced] = useState<{ orderNumber: string; total: Money }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const base = `/api/storefront/stores/${storeKey}`;
  useEffect(() => { if (customer) setEmail(customer.email); }, [customer]);

  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!cart) return;
    setBusy(true); setMessage('');
    const clean = ({ phone, ...rest }: Address) => ({ ...rest, ...(phone.trim() && { phone: phone.trim() }) });
    try {
      const saved = await api(`${base}/checkout-address`, { method: 'POST', body: JSON.stringify({ cartId: cart.id, email, address: clean(shipping), ...(!sameBilling && { billingAddress: clean(billing) }) }) });
      setCart(saved.cart);
      const found = await api(`${base}/carts/${cart.id}/shipping-methods`);
      setMethods(found.shippingMethods);
      const first = found.shippingMethods.find((method: ShippingMethod) => method.isDefault) ?? found.shippingMethods[0];
      if (!first) { setMessage('No delivery method is available for this address.'); return; }
      await chooseMethod(first.id, saved.cart);
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  // Selecting a method writes it to the cart so shipping and tax show in the summary before payment.
  async function chooseMethod(id: string, current: typeof cart = cart) {
    if (!current) return;
    setMethodId(id);
    try { setCart((await api(`${base}/checkout-shipping`, { method: 'POST', body: JSON.stringify({ cartId: current.id, shippingMethodId: id }) })).cart); }
    catch (error) { setMessage((error as Error).message); }
  }

  const cardForm = useRef<CardForm>(undefined);
  const [paying, setPaying] = useState(false);
  const closeCardForm = () => {
    cardForm.current?.dispose?.(); cardForm.current = undefined;
    document.getElementById('card-form')?.replaceChildren();
    setPaying(false);
  };
  useEffect(() => closeCardForm, []);

  // The BFF fixes the amount from the cart and returns a tokenize-only access token; the card form then yields a
  // single-use token that the BFF charges server-to-server before creating the order.
  async function startPayment() {
    if (!cart || !methodId) return;
    setBusy(true); setMessage(''); closeCardForm();
    try {
      const [gp, started] = await Promise.all([loadGlobalPayments(), api(`${base}/payments`, { method: 'POST', body: JSON.stringify({ cartId: cart.id }) })]);
      gp.configure({ accessToken: started.accessToken, apiVersion: '2021-03-22', env: started.env });
      const form = gp.creditCard.form('#card-form', { style: 'gp-default', enableSavedPaymentMethods: false });
      cardForm.current = form; setPaying(true);
      form.on('token-error', response => setMessage(response.reasons?.[0]?.message ?? 'Check your card details'));
      form.on('token-success', async ({ paymentReference }) => {
        setBusy(true); setMessage('');
        try {
          const { order } = await api(`${base}/payments/charge`, { method: 'POST', body: JSON.stringify({ cartId: cart.id, paymentId: started.paymentId, cardToken: paymentReference }) });
          closeCardForm(); localStorage.removeItem(`cart:${storeKey}`); setCart(undefined);
          setPlaced({ orderNumber: order.orderNumber ?? order.id, total: order.totalPrice });
        } catch (error) { closeCardForm(); setMessage((error as Error).message); }
        finally { setBusy(false); }
      });
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  if (!ready) return <Loader label="Loading…" />;
  if (placed) return <main><section className="checkoutPanel"><h1>Thank you, your order is placed</h1><p>Order number <strong>{placed.orderNumber}</strong> · {money(placed.total)}</p><p>Your payment was received. We will confirm your order shortly.</p><Link className="button" href="/">Continue shopping</Link></section></main>;
  if (!cart?.lineItems.length) return <main><section className="checkoutPanel"><h1>Checkout</h1><p>Your cart is empty.</p><Link className="button" href="/">Continue shopping</Link></section></main>;

  const readyToPay = !!cart.shippingInfo && methods.length > 0;
  return <main>
    <header><div><span className="eyebrow">SECURE CHECKOUT</span><h1>Checkout</h1></div></header>
    <div className="layout checkoutLayout">
      <div>
        <form onSubmit={saveDetails}>
          <section className="checkoutPanel"><h2>1. Contact</h2>
            <div className="checkoutForm"><div className="wide"><label>Email<input type="email" required autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></label></div></div></section>
          <section className="checkoutPanel"><h2>2. Shipping address</h2><AddressFields prefix="shipping" value={shipping} onChange={setShipping} /></section>
          <section className="checkoutPanel"><h2>3. Billing address</h2>
            <label className="check"><input type="checkbox" checked={sameBilling} onChange={event => setSameBilling(event.target.checked)} /> Same as shipping address</label>
            {!sameBilling && <AddressFields prefix="billing" value={billing} onChange={setBilling} />}</section>
          <button className="checkoutButton" disabled={busy} type="submit">{methods.length ? 'Update details' : 'Continue to delivery'}</button>
        </form>
        {methods.length > 0 && <section className="checkoutPanel"><h2>4. Delivery method</h2>
          {methods.map(method => <label className="check" key={method.id}><input type="radio" name="delivery" checked={method.id === methodId} onChange={() => chooseMethod(method.id)} /> {method.name}</label>)}</section>}
        {readyToPay && <section className="checkoutPanel"><h2>5. Payment</h2>
          <p>Your order total is {money(cart.taxedPrice?.totalGross ?? cart.totalPrice)}.</p>
          <div id="card-form" />
          {!paying && <button className="checkoutButton" disabled={busy} onClick={startPayment}>{message ? 'Try payment again' : 'Pay by card'}</button>}</section>}
        {message && <p className="error" role="alert">{message}</p>}
      </div>
      <aside>
        <div className="cartHead"><h2>Order summary</h2><Link className="link" href="/cart">Edit cart</Link></div>
        {cart.lineItems.map(item => <LineItem key={item.id} item={item} />)}
        {cart.discountOnTotalPrice && <div className="savings"><span>Cart discount</span><strong>−{money(cart.discountOnTotalPrice.discountedAmount)}</strong></div>}
        <div className="codeChip"><span>Shipping{cart.shippingInfo?.shippingMethodName ? ` (${cart.shippingInfo.shippingMethodName})` : ''}</span><span>{cart.shippingInfo?.price ? (cart.shippingInfo.price.centAmount ? money(cart.shippingInfo.price) : 'Free') : 'Calculated next'}</span></div>
        {cart.taxedPrice?.totalTax && <div className="codeChip"><span>Tax included</span><span>{money(cart.taxedPrice.totalTax)}</span></div>}
        <div className="total"><span>Total</span><strong>{money(cart.taxedPrice?.totalGross ?? cart.totalPrice)}</strong></div>
      </aside>
    </div>
  </main>;
}
