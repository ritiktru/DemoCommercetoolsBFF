import { Suspense } from 'react';
import Loader from '../../Loader';
import ProductView from '../../ProductView';

async function Product({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <ProductView productKey={key} />;
}
export default function Page({ params }: { params: Promise<{ key: string }> }) {
  return <Suspense fallback={<Loader label="Loading product…" />}><Product params={params} /></Suspense>;
}
