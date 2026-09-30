import type { Metadata } from 'next';
import { Suspense } from 'react';
import './styles.css';
import Header from './Header';
import StoreProvider from './StoreProvider';
export const metadata: Metadata = { title: 'Sobeys Commerce POC', description: 'Store-scoped commercetools demo' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-GB"><body><StoreProvider><Suspense fallback={null}><Header /></Suspense>{children}</StoreProvider></body></html>;
}
