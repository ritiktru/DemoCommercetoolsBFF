'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, money, type Money } from './api';
import Loader from './Loader';
import { useStore } from './StoreProvider';

type Product = { id: string; key?: string; name?: string; sku?: string; brand?: unknown; image?: string; price?: Money; discountedPrice?: Money };
const PAGE_SIZE = 12;

export default function Home() {
  const { stores, storeKey, setStoreKey, addItem, busy, message } = useStore();
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!storeKey) return;
    setLoading(true); setStatus('');
    // Served from the 15-minute server cache and the browser HTTP cache after the first load.
    api(`/api/storefront/stores/${storeKey}/products`).then(data => { setProducts(data.products); setStatus(`${data.products.length} products available`); }).catch(error => setStatus(error.message)).finally(() => setLoading(false));
  }, [storeKey]);

  const pages = Math.ceil(products.length / PAGE_SIZE);
  return <main>
    {(loading || !storeKey) && <Loader label="Loading products…" />}
    <header><div><span className="eyebrow">COMMERCE POC</span><h1>Fresh picks by store</h1><p>Pick a Store to see its live assortment, prices, discounts, and cart from commercetools.</p></div></header>
    <section className="toolbar"><label>Shopping at<select value={storeKey} onChange={event => { setPage(1); setStoreKey(event.target.value); }}>{stores.map(store => <option key={store.key} value={store.key}>{store.name}</option>)}</select></label><div className="status" role="status">{message || status}</div></section>
    <section><div className="sectionTitle"><h2>Available products</h2><span>{products.length} items</span></div>
      <div className="grid">{products.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(product => <article key={product.id}>
        <Link className="image" href={`/products/${product.key}`} aria-label={`View ${product.name}`}>{product.image ? <img src={product.image} alt={product.name ?? ''} loading="lazy" /> : String(product.brand ?? product.name ?? '?').slice(0, 1)}</Link>
        {product.brand ? <span className="brand">{String(product.brand)}</span> : null}<h3><Link href={`/products/${product.key}`}>{product.name}</Link></h3><p className="sku">SKU {product.sku}</p>
        <div className="productFooter"><strong>{product.discountedPrice ? <><s className="was">{money(product.price)}</s> {money(product.discountedPrice)}</> : money(product.price)}</strong><button disabled={!product.price || !product.sku || busy} onClick={() => addItem(product.sku!, product.name)}>Add</button></div></article>)}</div>
      {products.length > PAGE_SIZE && <nav className="pager" aria-label="Product pages"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></nav>}
    </section>
  </main>;
}
