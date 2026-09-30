'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Cart, type Money } from './api';

type Store = { key: string; name: string };
type Promo = { name: string; percent: number; thresholds: Money[] };
type Ctx = {
  ready: boolean; stores: Store[]; storeKey: string; setStoreKey: (key: string) => void;
  cart?: Cart; setCart: (cart?: Cart) => void; count: number;
  customer?: { email: string }; refreshCustomer: () => Promise<void>; signOut: () => Promise<void>;
  promo?: Promo; busy: boolean; message: string;
  addItem: (sku: string, name?: string, quantity?: number) => Promise<void>;
  setQuantity: (lineItemId: string, quantity: number) => Promise<Cart | undefined>;
  applyCode: (code: string) => Promise<void>; removeCode: (discountCodeId: string) => Promise<Cart | undefined>;
};
const StoreContext = createContext<Ctx | null>(null);
export const useStore = () => { const value = useContext(StoreContext); if (!value) throw new Error('StoreProvider missing'); return value; };

export default function StoreProvider({ children }: { children: ReactNode }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeKey, setKey] = useState('');
  const [cart, setCart] = useState<Cart>();
  const [customer, setCustomer] = useState<{ email: string }>();
  const [promo, setPromo] = useState<Promo>();
  const [authChecked, setAuthChecked] = useState(false);
  const [cartChecked, setCartChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refreshCustomer = useCallback(async () => {
    setCustomer(await api('/api/auth/me').then(data => data.customer, () => undefined)); setAuthChecked(true);
  }, []);
  useEffect(() => {
    api('/api/storefront/stores').then(data => {
      setStores(data.stores);
      setKey(data.stores.find((store: Store) => store.key === localStorage.getItem('storeKey'))?.key ?? data.stores[0]?.key ?? '');
    }).catch(error => setMessage(error.message));
    api('/api/storefront/promotion').then(data => setPromo(data.promotion)).catch(() => undefined);
    refreshCustomer();
  }, [refreshCustomer]);

  // Restore the shopper's cart: signed-in customers get their active Store cart, guests the one remembered in this browser.
  useEffect(() => {
    if (!storeKey || !authChecked) return;
    localStorage.setItem('storeKey', storeKey); setCart(undefined); setCartChecked(false);
    const guestId = localStorage.getItem(`cart:${storeKey}`);
    const restore = customer ? api(`/api/storefront/stores/${storeKey}/carts`, { method: 'POST', body: '{}' }) : guestId ? api(`/api/storefront/stores/${storeKey}/carts/${guestId}`) : Promise.resolve(null);
    restore.then(data => data && setCart(data.cart)).catch(() => localStorage.removeItem(`cart:${storeKey}`)).finally(() => setCartChecked(true));
  }, [storeKey, authChecked, customer?.email]);
  useEffect(() => { if (cart && !customer && storeKey) localStorage.setItem(`cart:${storeKey}`, cart.id); }, [cart?.id, customer, storeKey]);

  // Every change returns the whole recalculated cart (prices, discounts, totals) from commercetools.
  async function change(path: string, body: object, method = 'POST') {
    if (!cart) return;
    setBusy(true); setMessage('');
    try {
      const data = await api(`/api/storefront/stores/${storeKey}/${path}`, { method, body: JSON.stringify({ cartId: cart.id, version: cart.version, ...body }) });
      setCart(data.cart); return data.cart as Cart;
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function addItem(sku: string, name?: string, quantity = 1) {
    setBusy(true); setMessage('');
    try {
      const current: Cart = cart ?? (await api(`/api/storefront/stores/${storeKey}/carts`, { method: 'POST', body: '{}' })).cart;
      const data = await api(`/api/storefront/stores/${storeKey}/cart-items`, { method: 'POST', body: JSON.stringify({ cartId: current.id, version: current.version, sku, quantity }) });
      setCart(data.cart); setMessage(name ? `${name} added to cart.` : 'Added to cart.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function applyCode(code: string) {
    const updated = await change('discount-codes', { code });
    if (!updated) return;
    const applied = updated.discountCodes?.find(entry => entry.discountCode.obj?.code.toLowerCase() === code.trim().toLowerCase());
    setMessage(applied?.state === 'MatchesCart' ? `Code ${applied.discountCode.obj?.code} applied.` : 'Code added, but it does not apply to this cart yet.');
  }
  async function signOut() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setCustomer(undefined); setCart(undefined);
  }

  return <StoreContext.Provider value={{
    ready: authChecked && cartChecked, stores, storeKey, setStoreKey: setKey, cart, setCart, count: cart?.lineItems.reduce((sum, item) => sum + item.quantity, 0) ?? 0,
    customer, refreshCustomer, signOut, promo, busy, message, addItem, applyCode,
    setQuantity: (lineItemId, quantity) => change('cart-items', { lineItemId, quantity }, 'PATCH'),
    removeCode: discountCodeId => change('discount-codes/remove', { discountCodeId }),
  }}>{children}</StoreContext.Provider>;
}
