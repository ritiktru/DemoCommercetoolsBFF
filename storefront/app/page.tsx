'use client';
import { useEffect, useState, type FormEvent } from 'react';

type Store = { key: string; name: string };
type Money = { currencyCode: string; centAmount: number };
type Product = { id: string; name?: string; sku?: string; brand?: unknown; price?: Money };
type Cart = { id: string; version: number; totalPrice: Money; lineItems: Array<{ id: string; name: Record<string, string>; quantity: number; totalPrice: Money; variant: { sku?: string } }> };
type ShippingMethod = { id: string; name: string; isDefault?: boolean };
type Address = { firstName: string; lastName: string; streetName: string; city: string; state: string; postalCode: string };
declare global { interface Window { google?: { accounts: { id: { initialize(options: object): void; renderButton(element: HTMLElement, options: object): void } } }; ctc?: (method: string, options: object) => void } }

const money = (value?: Money) => value ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: value.currencyCode }).format(value.centAmount / 100) : 'No price';
async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? 'Request failed');
  return body;
}

export default function Home() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeKey, setStoreKey] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Cart>();
  const [customer, setCustomer] = useState<{ email: string }>();
  const [status, setStatus] = useState('Loading stores…');
  const [showCheckout, setShowCheckout] = useState(false);
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState<Address>({ firstName: '', lastName: '', streetName: '', city: '', state: '', postalCode: '' });
  const [shippingMethods, setShippingMethods] = useState<ShippingMethod[]>([]);
  const [shippingMethodId, setShippingMethodId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/storefront/stores').then(data => { setStores(data.stores); setStoreKey(data.stores[0]?.key ?? ''); }).catch(error => setStatus(error.message));
    api('/api/auth/me').then(data => { setCustomer(data.customer); setEmail(data.customer.email); }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!storeKey) return;
    setCart(undefined); setShowCheckout(false); setShippingMethods([]); setShippingMethodId(''); setStatus('Loading assortment…');
    api(`/api/storefront/stores/${storeKey}/products`).then(data => { setProducts(data.products); setStatus(`${data.products.length} products available`); }).catch(error => setStatus(error.message));
  }, [storeKey]);

  async function signIn() {
    try {
      const challenge = await api('/api/auth/google/challenge');
      if (!window.google) await new Promise<void>((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.onload = () => resolve(); script.onerror = () => reject(new Error('Google sign-in failed to load')); document.head.appendChild(script); });
      const target = document.getElementById('google-signin'); if (!target || !window.google) return;
      target.replaceChildren();
      window.google.accounts.id.initialize({ client_id: challenge.clientId, nonce: challenge.nonce, callback: async ({ credential }: { credential: string }) => {
        try { const data = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ idToken: credential }) }); setCustomer(data.customer); setEmail(data.customer.email); setStatus('Signed in. You can add products.'); target.replaceChildren(); }
        catch (error) { setStatus((error as Error).message); }
      } });
      window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large' });
      setStatus('Complete Google sign-in.');
    } catch (error) { setStatus((error as Error).message); }
  }

  async function add(product: Product) {
    if (!product.sku || !product.price) { setStatus('This product has no Store price.'); return; }
    setBusy(true);
    try {
      const current: Cart = cart ?? (await api(`/api/storefront/stores/${storeKey}/carts`, { method: 'POST', body: '{}' })).cart;
      const data = await api(`/api/storefront/stores/${storeKey}/cart-items`, { method: 'POST', body: JSON.stringify({ cartId: current.id, version: current.version, sku: product.sku, quantity: 1 }) });
      setCart(data.cart); setShowCheckout(false); setShippingMethods([]); setStatus(`${product.name} added to cart.`);
    } catch (error) { setStatus((error as Error).message); }
    finally { setBusy(false); }
  }

  function updateAddress(field: keyof Address, value: string) { setAddress(previous => ({ ...previous, [field]: value })); }

  async function saveAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cart) return;
    setBusy(true);
    try {
      const data = await api(`/api/storefront/stores/${storeKey}/checkout-address`, { method: 'POST', body: JSON.stringify({ cartId: cart.id, email, address }) });
      setCart(data.cart);
      const methods = await api(`/api/storefront/stores/${storeKey}/carts/${cart.id}/shipping-methods`);
      setShippingMethods(methods.shippingMethods);
      setShippingMethodId(methods.shippingMethods.find((method: ShippingMethod) => method.isDefault)?.id ?? methods.shippingMethods[0]?.id ?? '');
      setStatus(methods.shippingMethods.length ? 'Select a delivery method, then continue to payment.' : 'No delivery method matches this address. Configure one in commercetools or try another address.');
    } catch (error) { setStatus((error as Error).message); }
    finally { setBusy(false); }
  }

  async function pay() {
    if (!cart || !shippingMethodId) return;
    setBusy(true);
    try {
      const selected = await api(`/api/storefront/stores/${storeKey}/checkout-shipping`, { method: 'POST', body: JSON.stringify({ cartId: cart.id, shippingMethodId }) });
      setCart(selected.cart);
      const data = await api(`/api/storefront/stores/${storeKey}/checkout-session`, { method: 'POST', body: JSON.stringify({ cartId: cart.id }) });
      if (!window.ctc) await new Promise<void>((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://unpkg.com/@commercetools/checkout-browser-sdk@latest/browser/sdk.js'; script.onload = () => resolve(); script.onerror = () => reject(new Error('Checkout SDK failed to load')); document.head.appendChild(script); });
      if (!window.ctc) throw new Error('Checkout SDK is unavailable');
      window.ctc('paymentFlow', { projectKey: 'sobeys-dev', region: 'us-central1.gcp', sessionId: data.sessionId, locale: 'en-CA', logInfo: true, logWarn: true, logError: true });
      setStatus('Checkout payment is ready.');
    } catch (error) { setStatus((error as Error).message); }
    finally { setBusy(false); }
  }

  return <main>
    <header><div><span className="eyebrow">COMMERCE POC</span><h1>Fresh picks by store</h1><p>Select a Sobeys location to test Store-scoped assortments, Channel prices, and carts.</p></div><div className="account">{customer ? <><span>Signed in</span><strong>{customer.email}</strong></> : <><button onClick={signIn}>Sign in with Google</button><div id="google-signin" /></>}</div></header>
    <section className="toolbar"><label>Shopping at<select value={storeKey} onChange={event => setStoreKey(event.target.value)}>{stores.map(store => <option key={store.key} value={store.key}>{store.name} ({store.key.replace('sobeys-', '')})</option>)}</select></label><div className="status" role="status">{status}</div></section>
    <div className="layout"><section><div className="sectionTitle"><h2>Available products</h2><span>{products.length} items</span></div><div className="grid">{products.map(product => <article key={product.id}><div className="image">{String(product.brand ?? 'Sobeys').slice(0, 1)}</div><span className="brand">{String(product.brand ?? 'Grocery')}</span><h3>{product.name}</h3><p className="sku">SKU {product.sku}</p><div className="productFooter"><strong>{money(product.price)}</strong><button disabled={!product.price || busy} onClick={() => add(product)}>Add</button></div></article>)}</div></section>
      <aside><div className="cartHead"><h2>Your cart</h2><span>{cart?.lineItems.reduce((sum, item) => sum + item.quantity, 0) ?? 0}</span></div>{!cart?.lineItems.length ? <div className="empty"><div>🛒</div><p>Your selected products will appear here.</p></div> : <>{cart.lineItems.map(item => <div className="cartItem" key={item.id}><div><strong>{item.name['en-CA'] ?? Object.values(item.name)[0]}</strong><small>{item.variant.sku} · Qty {item.quantity}</small></div><span>{money(item.totalPrice)}</span></div>)}<div className="total"><span>Total</span><strong>{money(cart.totalPrice)}</strong></div><button className="checkoutButton" disabled={busy} onClick={() => setShowCheckout(true)}>Checkout</button></>}</aside></div>
    {showCheckout && cart && <section className="checkoutPanel"><h2>Checkout</h2><p>Enter your delivery address. Billing uses the same address for this demo.</p>
      <form onSubmit={saveAddress} className="checkoutForm">
        <label>Email<input type="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>First name<input required value={address.firstName} onChange={event => updateAddress('firstName', event.target.value)} /></label>
        <label>Last name<input required value={address.lastName} onChange={event => updateAddress('lastName', event.target.value)} /></label>
        <label>Street address<input required value={address.streetName} onChange={event => updateAddress('streetName', event.target.value)} /></label>
        <label>City<input required value={address.city} onChange={event => updateAddress('city', event.target.value)} /></label>
        <label>Province<input required placeholder="ON" value={address.state} onChange={event => updateAddress('state', event.target.value)} /></label>
        <label>Postal code<input required placeholder="M5V 1A1" value={address.postalCode} onChange={event => updateAddress('postalCode', event.target.value)} /></label>
        <div className="checkoutActions"><button disabled={busy} type="submit">Save address and find delivery</button></div>
      </form>
      {shippingMethods.length > 0 && <div className="shippingChoice"><label>Delivery method<select value={shippingMethodId} onChange={event => setShippingMethodId(event.target.value)}>{shippingMethods.map(method => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label><button disabled={busy || !shippingMethodId} onClick={pay}>Continue to payment</button></div>}
    </section>}
  </main>;
}
