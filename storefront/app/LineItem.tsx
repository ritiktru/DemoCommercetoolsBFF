'use client';
import { localName, money, unitPrice, type LineItemData } from './api';
import { useStore } from './StoreProvider';

// "£10.00 × 2 = £20.00": unit price, quantity, line total (struck through when a discount lowers it).
export default function LineItem({ item, controls = false }: { item: LineItemData; controls?: boolean }) {
  const { busy, setQuantity } = useStore();
  const unit = unitPrice(item);
  const full = unit ? unit.centAmount * item.quantity : item.totalPrice.centAmount;
  const image = item.variant.images?.[0]?.url;
  return <div className="lineItem">
    <div className="thumb">{image ? <img src={image} alt="" loading="lazy" /> : localName(item.name).slice(0, 1)}</div>
    <div className="lineBody">
      <strong>{localName(item.name)}</strong><small>SKU {item.variant.sku}</small>
      <div className="calc">{unit && <>{money(unit)} × {item.quantity} = </>}{full > item.totalPrice.centAmount && <s className="was">{money({ ...item.totalPrice, centAmount: full })}</s>} <strong>{money(item.totalPrice)}</strong></div>
      {controls && <div className="qty"><button disabled={busy} aria-label="Decrease quantity" onClick={() => setQuantity(item.id, item.quantity - 1)}>−</button><span>{item.quantity}</span><button disabled={busy || item.quantity >= 99} aria-label="Increase quantity" onClick={() => setQuantity(item.id, item.quantity + 1)}>+</button><button className="link" disabled={busy} onClick={() => setQuantity(item.id, 0)}>Remove</button></div>}
    </div>
  </div>;
}
