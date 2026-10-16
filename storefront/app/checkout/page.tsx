'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import '@adyen/adyen-web/styles/adyen.css';
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
  const dropinRef = useRef<HTMLDivElement>(null);
  const dropin = useRef<{ instance: { unmount(): unknown; submit(): void }; version: number }>(undefined);
  const [paying, setPaying] = useState(false);

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

  // Adyen Drop-in (sessions flow). Card fields and 3-D Secure run inside Adyen's iframes, so card data never reaches
  // this page's code or our servers. The browser's result is not trusted: the BFF confirms it with Adyen before any order.
  async function adyenCheckout(session: { id: string; sessionData?: string }, paymentRef: string) {
    const clientKey = process.env.NEXT_PUBLIC_ADYEN_CLIENT_KEY;
    if (!clientKey) throw new Error('Payments are not configured');
    // Imported on demand: the SDK needs window, so it must not run during server rendering.
    const { AdyenCheckout, Dropin } = await import('@adyen/adyen-web/auto');
    const failed = (text: string) => { closeDropin(); setVerifying(false); setMessage(text); };
    const checkout = await AdyenCheckout({
      // ponytail: TEST environment only; going live needs 'live'/'live-us' and the live client key.
      environment: 'test', clientKey, countryCode: cart?.country ?? 'CA', locale: 'en-CA', session,
      onPaymentCompleted: result => {
        const sessionResult = 'sessionResult' in result ? result.sessionResult : undefined;
        window.location.assign(`/checkout?paymentRef=${encodeURIComponent(paymentRef)}${sessionResult ? `&sessionResult=${encodeURIComponent(sessionResult)}` : ''}`);
      },
      onPaymentFailed: result => failed(`Payment was not completed${result?.resultCode ? ` (${result.resultCode})` : ''}. Please try again.`),
      onError: error => failed(error.message),
    });
    return { checkout, Dropin };
  }

  function closeDropin() { dropin.current?.instance.unmount(); dropin.current = undefined; setPaying(false); }

  async function startPayment() {
    if (!cart || !methodId || !dropinRef.current) return;
    setBusy(true); setMessage('');
    try {
      const { paymentRefId, sessionId, sessionData } = await api(`${base}/checkout/initiate`, { method: 'POST', body: JSON.stringify({ cartId: cart.id }) });
      // Kept so a redirect-based method (PayPal, bank page) can be finished when the shopper comes back.
      sessionStorage.setItem(`adyen:${paymentRefId}`, sessionId);
      const { checkout, Dropin } = await adyenCheckout({ id: sessionId, sessionData }, paymentRefId);
            // Saved cards (signed-in customers) are listed above the new-card form; card fields stay in Adyen's iframes.
      // showPayButton false: our Pay button below submits whichever method is selected. Wallets keep their own button.
      const instance = new Dropin(checkout, {
        showPayButton: false, showStoredPaymentMethods: true, openFirstStoredPaymentMethod: true,
        paymentMethodsConfiguration: { googlepay: { showPayButton: true }, applepay: { showPayButton: true } },
      });
      dropin.current = { instance: instance.mount(dropinRef.current), version: cart.version };
      setPaying(true);
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  // The session's amount is fixed: any cart change (address, delivery) closes Drop-in so a new session is started.
  useEffect(() => { if (dropin.current && dropin.current.version !== cart?.version) closeDropin(); }, [cart?.version]);

  // Back from Adyen: poll until the BFF confirms payment and returns the Order (about 2s apart, up to ~2 minutes).
  useEffect(() => {
    // Adyen appends sessionId and sessionResult to our returnUrl; the BFF trades sessionResult for the pspReference.
    const params = new URLSearchParams(window.location.search);
    const paymentRef = params.get('paymentRef'); const sessionResult = params.get('sessionResult');
    if (!paymentRef || !storeKey) return;
    setVerifying(true);
    // Back from a redirect-based method: Drop-in finishes it with Adyen, then onPaymentCompleted returns here with sessionResult.
    const redirectResult = params.get('redirectResult');
    if (redirectResult) {
      const sessionId = params.get('sessionId') ?? sessionStorage.getItem(`adyen:${paymentRef}`);
      if (!sessionId) { setVerifying(false); setMessage('Payment session not found. Please try again.'); return; }
      adyenCheckout({ id: sessionId }, paymentRef)
        .then(({ checkout }) => checkout.submitDetails({ details: { redirectResult } }))
        .catch(error => { setVerifying(false); setMessage((error as Error).message); });
      return;
    }
    let stopped = false;
    (async () => {
      for (let attempt = 0; attempt < 60 && !stopped; attempt++) {
        try {
          const result = await api(`${base}/order/payment/status?paymentRef=${encodeURIComponent(paymentRef)}${sessionResult ? `&sessionResult=${encodeURIComponent(sessionResult)}` : ''}`);
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
          <p>Your order total is {money(cart.taxedPrice?.totalGross ?? cart.totalPrice)}. Payment details are entered in Adyen's secure form and never reach our servers.</p>
          {!paying && <button className="checkoutButton" disabled={busy} onClick={startPayment}>Continue to payment</button>}
          <div ref={dropinRef} />
          {paying && <button className="checkoutButton" onClick={() => dropin.current?.instance.submit()}>Pay {money(cart.taxedPrice?.totalGross ?? cart.totalPrice)}</button>}</section>}
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
