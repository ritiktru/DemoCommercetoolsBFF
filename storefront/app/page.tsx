'use client';
import { useEffect, useState, type FormEvent } from 'react';

type Store = { key: string; name: string };
type Money = { currencyCode: string; centAmount: number };
type Product = { id: string; name?: string; sku?: string; brand?: unknown; price?: Money };
type Cart = {
  id: string;
  version: number;
  totalPrice: Money;
  lineItems: Array<{
    id: string;
    name: Record<string, string>;
    quantity: number;
    totalPrice: Money;
    variant: { sku?: string };
  }>;
  shippingInfo?: {
    shippingMethodName?: string;
    price?: Money;
    discountedPrice?: { value?: Money };
  };
};
type ShippingMethod = { id: string; name: string; isDefault?: boolean; price?: Money };
type Address = {
  firstName: string;
  lastName: string;
  streetName: string;
  city: string;
  state: string;
  postalCode: string;
};
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(options: object): void;
          renderButton(element: HTMLElement, options: object): void;
        };
      };
    };
    ctc?: (method: string, options: object) => void;
  }
}

const DEMO_PERCENT_CODE = 'POC10';
const DEMO_PERCENT = 10;
const DEMO_FLAT_CODE = 'FLAT25';
const DEMO_FREE_SHIP_CODE = 'FREESHIP';

const money = (value?: Money) =>
  value
    ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: value.currencyCode }).format(value.centAmount / 100)
    : 'No price';

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
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
  const [address, setAddress] = useState<Address>({
    firstName: '',
    lastName: '',
    streetName: '',
    city: '',
    state: '',
    postalCode: '',
  });
  const [shippingMethods, setShippingMethods] = useState<ShippingMethod[]>([]);
  const [shippingMethodId, setShippingMethodId] = useState('');
  const [discountCode, setDiscountCode] = useState('');
  const [appliedDiscount, setAppliedDiscount] = useState<'percent' | 'flat' | null>(null);
  const [freeShippingApplied, setFreeShippingApplied] = useState(false);
  const [freeShippingCode, setFreeShippingCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/storefront/stores')
      .then(data => {
        setStores(data.stores);
        setStoreKey(data.stores[0]?.key ?? '');
      })
      .catch(error => setStatus(error.message));
    api('/api/auth/me')
      .then(data => {
        setCustomer(data.customer);
        setEmail(data.customer.email);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!storeKey) return;
    setCart(undefined);
    setShowCheckout(false);
    setShippingMethods([]);
    setShippingMethodId('');
    setDiscountCode('');
    setAppliedDiscount(null);
    setFreeShippingApplied(false);
    setStatus('Loading assortment…');
    api(`/api/storefront/stores/${storeKey}/products`)
      .then(data => {
        setProducts(data.products);
        setStatus(`${data.products.length} products available`);
      })
      .catch(error => setStatus(error.message));
  }, [storeKey]);

  async function signIn() {
    try {
      const challenge = await api('/api/auth/google/challenge');
      if (!window.google) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://accounts.google.com/gsi/client';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Google sign-in failed to load'));
          document.head.appendChild(script);
        });
      }
      const target = document.getElementById('google-signin');
      if (!target || !window.google) return;
      target.replaceChildren();
      window.google.accounts.id.initialize({
        client_id: challenge.clientId,
        nonce: challenge.nonce,
        callback: async ({ credential }: { credential: string }) => {
          try {
            const data = await api('/api/auth/google', {
              method: 'POST',
              body: JSON.stringify({ idToken: credential }),
            });
            setCustomer(data.customer);
            setEmail(data.customer.email);
            setStatus('Signed in. You can add products.');
            target.replaceChildren();
          } catch (error) {
            setStatus((error as Error).message);
          }
        },
      });
      window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large' });
      setStatus('Complete Google sign-in.');
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function add(product: Product) {
    if (!product.sku || !product.price) {
      setStatus('This product has no Store price.');
      return;
    }
    setBusy(true);
    try {
      const current: Cart =
        cart ?? (await api(`/api/storefront/stores/${storeKey}/carts`, { method: 'POST', body: '{}' })).cart;
      const data = await api(`/api/storefront/stores/${storeKey}/cart-items`, {
        method: 'POST',
        body: JSON.stringify({ cartId: current.id, version: current.version, sku: product.sku, quantity: 1 }),
      });
      setCart(data.cart);
      setShowCheckout(false);
      setShippingMethods([]);
      setShippingMethodId('');
      setStatus(`${product.name} added to cart.`);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setQty(lineItemId: string, quantity: number) {
    if (!cart) return;
    setBusy(true);
    try {
      const data = await api(`/api/storefront/stores/${storeKey}/cart-items/update`, {
        method: 'POST',
        body: JSON.stringify({
          cartId: cart.id,
          version: cart.version,
          lineItemId,
          quantity,
        }),
      });
      setCart(data.cart);
      if (!data.cart.lineItems.length) {
        setShowCheckout(false);
        setShippingMethods([]);
        setShippingMethodId('');
      }
      setStatus(quantity === 0 ? 'Item removed.' : 'Quantity updated.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function lineFor(product: Product) {
    return cart?.lineItems.find(item => item.variant.sku === product.sku);
  }

  function updateAddress(field: keyof Address, value: string) {
    setAddress(previous => ({ ...previous, [field]: value }));
  }

  async function selectShipping(methodId: string, currentCart = cart) {
    if (!currentCart || !methodId) return;
    setShippingMethodId(methodId);
    const data = await api(`/api/storefront/stores/${storeKey}/checkout-shipping`, {
      method: 'POST',
      body: JSON.stringify({ cartId: currentCart.id, shippingMethodId: methodId }),
    });
    setCart(data.cart);
    return data.cart as Cart;
  }

  async function saveAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cart) return;
    setBusy(true);
    try {
      const data = await api(`/api/storefront/stores/${storeKey}/checkout-address`, {
        method: 'POST',
        body: JSON.stringify({ cartId: cart.id, email, address }),
      });
      setCart(data.cart);
      const methods = await api(`/api/storefront/stores/${storeKey}/carts/${data.cart.id}/shipping-methods`);
      setShippingMethods(methods.shippingMethods);
      const nextId =
        methods.shippingMethods.find((method: ShippingMethod) => method.isDefault)?.id ??
        methods.shippingMethods[0]?.id ??
        '';
      if (nextId) {
        await selectShipping(nextId, data.cart);
        setStatus('Delivery method added to total. Apply FREESHIP to waive shipping.');
      } else {
        setShippingMethodId('');
        setStatus('No delivery method matches this address.');
      }
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyDiscount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cart) {
      setStatus('Add a product before applying a code.');
      return;
    }
    setBusy(true);
    try {
      const data = await api(`/api/storefront/stores/${storeKey}/discount`, {
        method: 'POST',
        body: JSON.stringify({ cartId: cart.id, version: cart.version, code: discountCode }),
      });
      setCart(data.cart);
      if (data.type === 'shipping') {
        setFreeShippingApplied(true);
        setStatus(`${DEMO_FREE_SHIP_CODE} applied. Shipping is $0.`);
      } else {
        setAppliedDiscount(data.type);
        setDiscountCode('');
        setStatus(
          data.type === 'flat'
            ? `${DEMO_FLAT_CODE} applied ($25 off).`
            : `${DEMO_PERCENT_CODE} applied (${DEMO_PERCENT}% off).`,
        );
      }
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeDiscount() {
    if (!cart) return;
    setBusy(true);
    try {
      const data = await api(`/api/storefront/stores/${storeKey}/discount/remove`, {
        method: 'POST',
        body: JSON.stringify({ cartId: cart.id, version: cart.version, kind: 'product' }),
      });
      setCart(data.cart);
      setAppliedDiscount(null);
      setStatus('Discount code removed.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyFreeShipping() {
    if (!cart) {
      setStatus('Add a product and select delivery first.');
      return;
    }
    const charge =
      cart.shippingInfo?.price ??
      shippingMethods.find(method => method.id === shippingMethodId)?.price;
    if (!charge || charge.centAmount <= 0) {
      setStatus('No shipping charge');
      return;
    }
    if (freeShippingCode.trim().toUpperCase() !== DEMO_FREE_SHIP_CODE) {
      setStatus(`Invalid code. Use ${DEMO_FREE_SHIP_CODE}.`);
      return;
    }
    setBusy(true);
    try {
      const data = await api(`/api/storefront/stores/${storeKey}/discount`, {
        method: 'POST',
        body: JSON.stringify({ cartId: cart.id, version: cart.version, code: DEMO_FREE_SHIP_CODE }),
      });
      setCart(data.cart);
      setFreeShippingApplied(true);
      setFreeShippingCode('');
      setStatus(`${DEMO_FREE_SHIP_CODE} applied. Shipping $0.`);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeFreeShipping() {
    if (!cart) return;
    setBusy(true);
    try {
      const data = await api(`/api/storefront/stores/${storeKey}/discount/remove`, {
        method: 'POST',
        body: JSON.stringify({ cartId: cart.id, version: cart.version, kind: 'shipping' }),
      });
      setCart(data.cart);
      setFreeShippingApplied(false);
      setStatus('Free shipping removed.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!cart || !shippingMethodId) return;
    setBusy(true);
    try {
      const selected = await api(`/api/storefront/stores/${storeKey}/checkout-shipping`, {
        method: 'POST',
        body: JSON.stringify({ cartId: cart.id, shippingMethodId }),
      });
      setCart(selected.cart);
      const data = await api(`/api/storefront/stores/${storeKey}/checkout-session`, {
        method: 'POST',
        body: JSON.stringify({ cartId: selected.cart.id }),
      });
      if (!window.ctc) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://unpkg.com/@commercetools/checkout-browser-sdk@latest/browser/sdk.js';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Checkout SDK failed to load'));
          document.head.appendChild(script);
        });
      }
      if (!window.ctc) throw new Error('Checkout SDK is unavailable');
      window.ctc('paymentFlow', {
        projectKey: 'sobeys-dev',
        region: 'us-central1.gcp',
        sessionId: data.sessionId,
        locale: 'en-CA',
        logInfo: true,
        logWarn: true,
        logError: true,
      });
      setStatus('Checkout payment is ready.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selectedShipping = shippingMethods.find(method => method.id === shippingMethodId);
  const itemsTotal = cart
    ? {
      currencyCode: cart.totalPrice.currencyCode,
      centAmount: cart.lineItems.reduce((sum, item) => sum + item.totalPrice.centAmount, 0),
    }
    : undefined;
  const listedShipping = cart?.shippingInfo?.price ?? selectedShipping?.price;
  const shippingCharge = {
    currencyCode: cart?.totalPrice.currencyCode ?? 'CAD',
    centAmount: freeShippingApplied ? 0 : (listedShipping?.centAmount ?? 0),
  };
  const displayTotal = itemsTotal
    ? {
      currencyCode: itemsTotal.currencyCode,
      centAmount: itemsTotal.centAmount + shippingCharge.centAmount,
    }
    : undefined;

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">COMMERCE POC</span>
          <h1>Fresh picks by store</h1>
          <p>Select a Sobeys location to test Store-scoped assortments, Channel prices, and carts.</p>
        </div>
        <div className="account">
          {customer ? (
            <>
              <span>Signed in</span>
              <strong>{customer.email}</strong>
            </>
          ) : (
            <>
              <button onClick={signIn}>Sign in with Google</button>
              <div id="google-signin" />
            </>
          )}
        </div>
      </header>
      <section className="toolbar">
        <label>
          Shopping at
          <select value={storeKey} onChange={event => setStoreKey(event.target.value)}>
            {stores.map(store => (
              <option key={store.key} value={store.key}>
                {store.name} ({store.key.replace('sobeys-', '')})
              </option>
            ))}
          </select>
        </label>
        <div className="status" role="status">
          {status}
        </div>
      </section>
      <div className="layout">
        <section>
          <div className="sectionTitle">
            <h2>Available products</h2>
            <span>{products.length} items</span>
          </div>
          <div className="grid">
            {products.map(product => (
              <article key={product.id}>
                <div className="image">{String(product.brand ?? 'Sobeys').slice(0, 1)}</div>
                <span className="brand">{String(product.brand ?? 'Grocery')}</span>
                <h3>{product.name}</h3>
                <p className="sku">SKU {product.sku}</p>
                <div className="productFooter">
                  <strong>{money(product.price)}</strong>
                  {lineFor(product) ? (
                    <div className="qtyStepper">
                      <button type="button" disabled={busy} onClick={() => void setQty(lineFor(product)!.id, lineFor(product)!.quantity - 1)}>−</button>
                      <span>{lineFor(product)!.quantity}</span>
                      <button type="button" disabled={busy} onClick={() => void setQty(lineFor(product)!.id, lineFor(product)!.quantity + 1)}>+</button>
                    </div>
                  ) : (
                    <button disabled={!product.price || busy} onClick={() => add(product)}>Add</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
        <aside>
          <div className="cartHead">
            <h2>Your cart</h2>
            <span>{cart?.lineItems.reduce((sum, item) => sum + item.quantity, 0) ?? 0}</span>
          </div>
          {!cart?.lineItems.length ? (
            <div className="empty">
              <div>🛒</div>
              <p>Your selected products will appear here.</p>
            </div>
          ) : (
            <>
              {cart.lineItems.map(item => (
                <div className="cartItem" key={item.id}>
                  <div>
                    <strong>{item.name['en-CA'] ?? Object.values(item.name)[0]}</strong>
                    <small>
                      {item.variant.sku} · Qty {item.quantity}
                    </small>
                  </div>
                  <span>{money(item.totalPrice)}</span>
                </div>
              ))}
              <div className="total">
                <span>Items</span>
                <strong>{money(itemsTotal)}</strong>
              </div>
              <div className="total">
                <span>
                  Shipping
                  {selectedShipping
                    ? ` (${selectedShipping.name})`
                    : cart.shippingInfo?.shippingMethodName
                      ? ` (${cart.shippingInfo.shippingMethodName})`
                      : ''}
                </span>
                <strong>{shippingCharge ? money(shippingCharge) : 'Select delivery'}</strong>
              </div>
              <div className="total">
                <span>Total</span>
                <strong>{money(displayTotal)}</strong>
              </div>
              {appliedDiscount && (
                <div className="cartItem">
                  <div>
                    <strong>{appliedDiscount === 'flat' ? DEMO_FLAT_CODE : DEMO_PERCENT_CODE}</strong>
                    <small>{appliedDiscount === 'flat' ? '$25 off' : `${DEMO_PERCENT}% off`}</small>
                  </div>
                  <button type="button" disabled={busy} onClick={removeDiscount}>
                    Remove
                  </button>
                </div>
              )}
              <form onSubmit={applyDiscount} className="checkoutForm">
                <label>
                  Discount code
                  <input
                    value={discountCode}
                    onChange={event => setDiscountCode(event.target.value)}
                    placeholder={`${DEMO_PERCENT_CODE} or ${DEMO_FLAT_CODE}`}
                    autoComplete="off"
                  />
                </label>
                <div className="checkoutActions">
                  <button disabled={busy || !discountCode.trim()} type="submit">
                    {appliedDiscount ? 'Replace discount' : 'Apply code'}
                  </button>
                </div>
              </form>
              {(listedShipping?.centAmount ?? 0) <= 0 && !freeShippingApplied ? (
                <p className="status">No shipping charge</p>
              ) : freeShippingApplied ? (
                <div className="cartItem">
                  <div>
                    <strong>{DEMO_FREE_SHIP_CODE}</strong>
                    <small>Shipping $0.00</small>
                  </div>
                  <button type="button" disabled={busy} onClick={removeFreeShipping}>
                    Remove
                  </button>
                </div>
              ) : (
                <form
                  className="checkoutForm"
                  onSubmit={event => {
                    event.preventDefault();
                    void applyFreeShipping();
                  }}
                >
                  <label>
                    Free shipping code
                    <input
                      value={freeShippingCode}
                      onChange={event => setFreeShippingCode(event.target.value)}
                      placeholder={DEMO_FREE_SHIP_CODE}
                      autoComplete="off"
                    />
                  </label>
                  <div className="checkoutActions">
                    <button disabled={busy || !freeShippingCode.trim()} type="submit">
                      Apply code
                    </button>
                  </div>
                </form>
              )}
              <button className="checkoutButton" disabled={busy} onClick={() => setShowCheckout(true)}>
                Checkout
              </button>
            </>
          )}
        </aside>
      </div>
      {showCheckout && cart && (
        <section className="checkoutPanel">
          <h2>Checkout</h2>
          <p>Enter your delivery address. Billing uses the same address for this demo.</p>
          <form onSubmit={saveAddress} className="checkoutForm">
            <label>
              Email
              <input type="email" required value={email} onChange={event => setEmail(event.target.value)} />
            </label>
            <label>
              First name
              <input required value={address.firstName} onChange={event => updateAddress('firstName', event.target.value)} />
            </label>
            <label>
              Last name
              <input required value={address.lastName} onChange={event => updateAddress('lastName', event.target.value)} />
            </label>
            <label>
              Street address
              <input required value={address.streetName} onChange={event => updateAddress('streetName', event.target.value)} />
            </label>
            <label>
              City
              <input required value={address.city} onChange={event => updateAddress('city', event.target.value)} />
            </label>
            <label>
              Province
              <input required placeholder="ON" value={address.state} onChange={event => updateAddress('state', event.target.value)} />
            </label>
            <label>
              Postal code
              <input required placeholder="M5V 1A1" value={address.postalCode} onChange={event => updateAddress('postalCode', event.target.value)} />
            </label>
            <div className="checkoutActions">
              <button disabled={busy} type="submit">
                Save address and find delivery
              </button>
            </div>
          </form>
          {shippingMethods.length > 0 && (
            <div className="shippingChoice">
              <label>
                Delivery method
                <select
                  value={shippingMethodId}
                  onChange={event => {
                    const methodId = event.target.value;
                    setBusy(true);
                    selectShipping(methodId)
                      .then(() => setStatus('Shipping added to total.'))
                      .catch(error => setStatus((error as Error).message))
                      .finally(() => setBusy(false));
                  }}
                >
                  {shippingMethods.map(method => (
                    <option key={method.id} value={method.id}>
                      {method.name}
                      {method.price ? ` — ${money(method.price)}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={busy || !shippingMethodId} onClick={pay}>
                Continue to payment
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}