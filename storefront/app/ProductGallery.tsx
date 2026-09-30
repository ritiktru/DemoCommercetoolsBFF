'use client';
import { useEffect, useState, type MouseEvent } from 'react';

// Whole image by default, hover to zoom in place, click for a full-size view.
export default function ProductGallery({ images, name }: { images: Array<{ url: string; label?: string }>; name: string }) {
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState<{ x: number; y: number }>();
  const [full, setFull] = useState(false);
  useEffect(() => setIndex(0), [images]);
  useEffect(() => {
    if (!full) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [full]);
  const current = images[index];
  if (!current) return <div className="gallery"><div className="galleryMain empty">No image</div></div>;
  const move = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setZoom({ x: (event.clientX - box.left) / box.width * 100, y: (event.clientY - box.top) / box.height * 100 });
  };
  return <div className="gallery">
    <button type="button" className="galleryMain" onMouseMove={move} onMouseLeave={() => setZoom(undefined)} onClick={() => setFull(true)} aria-label="View full size image">
      <img src={current.url} alt={current.label ?? name} style={zoom ? { transform: 'scale(2)', transformOrigin: `${zoom.x}% ${zoom.y}%` } : undefined} />
      <span className="zoomHint">Hover to zoom · click for full size</span>
    </button>
    {images.length > 1 && <div className="thumbs">{images.map((image, i) => <button type="button" key={image.url} className={i === index ? 'on' : ''} onClick={() => setIndex(i)} aria-label={`Image ${i + 1}`}><img src={image.url} alt="" loading="lazy" /></button>)}</div>}
    {full && <div className="lightbox" role="dialog" aria-label={`${name} full size`} onClick={() => setFull(false)}><img src={current.url} alt={current.label ?? name} /><button type="button" aria-label="Close">✕</button></div>}
  </div>;
}
