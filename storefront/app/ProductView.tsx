'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, money, type Money } from './api';
import Loader from './Loader';
import ProductGallery from './ProductGallery';
import { useStore } from './StoreProvider';

type Variant = { id: number; sku?: string; images: Array<{ url: string; label?: string }>; price?: Money; discountedPrice?: Money; attributes: Array<{ name: string; value: unknown }> };
type Product = { id: string; key?: string; name?: string; description?: string; variants: Variant[] };

// Attribute values may be plain, localized ({ 'en-GB': … }) or enums ({ key, label }); return text or nothing.
function text(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ') || undefined;
  const record = value as Record<string, unknown>;
  if ('label' in record) return text(record.label);
  return typeof (record['en-GB'] ?? record['en-US'] ?? record['en-CA']) === 'string' ? String(record['en-GB'] ?? record['en-US'] ?? record['en-CA']) : undefined;
}
const label = (name: string) => name.replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase());
const hidden = (name: string) => /(^|-)code$|^search-/.test(name);

export default function ProductView({ productKey: key }: { productKey: string }) {
  const { storeKey, ready, addItem, busy, message } = useStore();
  const [product, setProduct] = useState<Product>();
  const [error, setError] = useState('');
  const [variantId, setVariantId] = useState<number>();
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (!storeKey) return;
    setProduct(undefined); setError('');
    // Served from the 15-minute server cache and the browser HTTP cache after the first load.
    api(`/api/storefront/stores/${storeKey}/products/${key}`).then(data => { setProduct(data.product); setVariantId(data.product.variants[0]?.id); }).catch(err => setError(err.message));
  }, [storeKey, key]);

  if (error) return <main><section className="checkoutPanel"><h1>Product unavailable</h1><p>{error}</p><Link className="button" href="/">Back to products</Link></section></main>;
  if (!product || !ready) return <Loader label="Loading product…" />;
  const variant = product.variants.find(entry => entry.id === variantId) ?? product.variants[0];
  if (!variant) return <main><p>No variants.</p></main>;
  const images = variant.images.length ? variant.images : product.variants.flatMap(entry => entry.images);
  const specs = variant.attributes.filter(attribute => !hidden(attribute.name)).map(attribute => ({ name: attribute.name, value: text(attribute.value) })).filter((entry): entry is { name: string; value: string } => !!entry.value && entry.name !== 'productspec');
  const sale = variant.discountedPrice;
  const unit = sale ?? variant.price;

  return <main>
    <p className="crumbs"><Link href="/">Products</Link> / {product.name}</p>
    <div className="pdp">
      <ProductGallery images={images} name={product.name ?? ''} />
      <section>
        <h1>{product.name}</h1>
        <p className="sku">SKU {variant.sku}</p>
        <div className="pdpPrice">{unit ? <>{sale && <s className="was">{money(variant.price)}</s>} <strong>{money(unit)}</strong></> : <strong>No price in this Store</strong>}</div>
        {product.variants.length > 1 && <label className="variantPick">Variant<select value={variant.id} onChange={event => setVariantId(Number(event.target.value))}>{product.variants.map(entry => <option key={entry.id} value={entry.id}>{entry.sku}</option>)}</select></label>}
        <div className="buyRow">
          <div className="qty"><button type="button" disabled={quantity <= 1} onClick={() => setQuantity(quantity - 1)} aria-label="Decrease quantity">−</button><span>{quantity}</span><button type="button" disabled={quantity >= 99} onClick={() => setQuantity(quantity + 1)} aria-label="Increase quantity">+</button></div>
          <button className="addBig" disabled={busy || !unit || !variant.sku} onClick={() => addItem(variant.sku!, product.name, quantity)}>{unit ? `Add to cart · ${money({ ...unit, centAmount: unit.centAmount * quantity })}` : 'Unavailable'}</button>
        </div>
        {message && <p className="status" role="status">{message} <Link href="/cart">View cart</Link></p>}
        {product.description && <><h2>Description</h2><p className="desc">{product.description}</p></>}
        {specs.length > 0 && <><h2>Details</h2><dl className="specs">{specs.map(spec => <div key={spec.name}><dt>{label(spec.name)}</dt><dd>{spec.value}</dd></div>)}</dl></>}
      </section>
    </div>
  </main>;
}
