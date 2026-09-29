import type { Metadata } from 'next';
import './styles.css';
export const metadata: Metadata = { title: 'Sobeys Commerce POC', description: 'Store-scoped commercetools demo' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-CA"><body>{children}</body></html>;
}
