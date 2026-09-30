'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { money } from './api';
import LineItem from './LineItem';
import { useStore } from './StoreProvider';

export default function Header() {
  const { cart, count, customer, signOut } = useStore();
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => { const close = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false); window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
  const link = (href: string, label: string) => <Link href={href} className={path === href ? 'active' : undefined}>{label}</Link>;
  return <div className="siteHeader"><nav>
    <Link href="/" className="brand-mark">Sobeys<span>Commerce POC</span></Link>
    <div className="siteNav">
      {link('/', 'Home')}
      <div className="miniCart">
        <button className="cartToggle" aria-expanded={open} onClick={() => setOpen(!open)}>🛒 Cart{count > 0 && <b>{count}</b>}</button>
        {open && <><div className="backdrop" onClick={() => setOpen(false)} /><div className="miniPanel" role="dialog" aria-label="Cart">
          {!cart?.lineItems.length ? <p className="empty">Your cart is empty.</p> : <>
            <div className="miniItems">{cart.lineItems.map(item => <LineItem key={item.id} item={item} />)}</div>
            <div className="total"><span>Total</span><strong>{money(cart.totalPrice)}</strong></div>
            <div className="miniActions"><Link className="button ghost" href="/cart">View cart</Link><Link className="button" href="/checkout">Checkout</Link></div></>}
        </div></>}
      </div>
      {customer ? <><span className="who" title={customer.email}>{customer.email}</span><button className="link" onClick={signOut}>Sign out</button></>
        : <>{link('/login', 'Sign in')}<Link className="button" href="/signup">Create account</Link></>}
    </div>
  </nav></div>;
}
