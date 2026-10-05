'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, money, type Money } from '../api';
import LineItem from '../LineItem';
import Loader from '../Loader';
import { useStore } from '../StoreProvider';

type Address = { firstName: string; lastName: string; streetName: string; city: string; state: string; postalCode: string; phone: string };
type ShippingMethod = { id: string; name: string; isDefault?: boolean };
const blank: Address = { firstName: '', lastName: '', streetName: '', city: '', state: '', postalCode: '', phone: '' };

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
  const [verifying, setVerifying] = useState(false);

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

  // Adyen Hosted Checkout: the BFF opens a session and we leave for Adyen's page; Adyen returns to /checkout?paymentRef=…
  async function pay() {
    if (!cart || !methodId) return;
    setBusy(true); setMessage('');
    try {
      const { url } = await api(`${base}/checkout/initiate`, { method: 'POST', body: JSON.stringify({ cartId: cart.id }) });
      window.location.assign(url);
    } catch (error) { setMessage((error as Error).message); setBusy(false); }
  }

  // Back from Adyen: poll until the BFF confirms payment and returns the Order (about 2s apart, up to ~2 minutes).
  useEffect(() => {
    const paymentRef = new URLSearchParams(window.location.search).get('paymentRef');
    if (!paymentRef || !storeKey) return;
    setVerifying(true);
    let stopped = false;
    (async () => {
      for (let attempt = 0; attempt < 60 && !stopped; attempt++) {
        try {
          const result = await api(`${base}/order/payment/status?paymentRef=${encodeURIComponent(paymentRef)}`);
          if (result.status === 'failed') {
            setMessage(`Payment was not completed${result.reason ? `: ${result.reason}` : ''}. Please try again.`);
            window.history.replaceState(null, '', '/checkout');
            return;
          }
          if (result.status === 'paid') {
            localStorage.removeItem(`cart:${storeKey}`); setCart(undefined);
            setPlaced({ orderNumber: result.order.orderNumber ?? result.order.id, total: result.order.totalPrice });
            window.history.replaceState(null, '', '/checkout');
            return;
          }
        } catch (error) { setMessage((error as Error).message); return; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (!stopped) setMessage('We have not received payment confirmation yet. Please check again shortly.');
    })().finally(() => { if (!stopped) setVerifying(false); });
    return () => { stopped = true; };
  }, [storeKey]);

  if (verifying) return <Loader label="Confirming your payment…" note="We are processing your payment. Please do not close or refresh this browser tab." />;
  if (!ready) return <Loader label="Loading…" />;
  if (placed) return <main><section className="checkoutPanel"><h1>Thank you, your order is placed</h1><p>Order number <strong>{placed.orderNumber}</strong> · {money(placed.total)}</p><p>Your payment was received.</p><Link className="button" href="/">Continue shopping</Link></section></main>;
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
          <p>Your order total is {money(cart.taxedPrice?.totalGross ?? cart.totalPrice)}. You will be taken to Adyen's secure page to pay.</p>
          <button className="checkoutButton" disabled={busy} onClick={pay}>Pay with Adyen</button></section>}
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
