import { useEffect, useRef, useState } from "react";
import { createMascotRenderer } from "./mascotRenderer";

export function AuthMascot() {
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    setAnimated(false);
    if (typeof WebGLRenderingContext === "undefined") return;
    const image = imageRef.current!;
    const canvas = canvasRef.current!;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let renderer: ReturnType<typeof createMascotRenderer> = null;
    let frame = 0;
    let disposed = false;
    let lost = false;
    let visible = false;
    let lastDraw = -Infinity;
    const start = performance.now();
    const enabled = () => !disposed && !lost && visible && !document.hidden && !preference.matches;
    function tick(now: number) {
      frame = 0;
      if (!enabled() || !renderer) return;
      if (now - lastDraw >= 1000 / 30) {
        renderer.draw((now - start) / 1000);
        lastDraw = now;
      }
      frame = requestAnimationFrame(tick);
    }
    function update() {
      if (!enabled() || !image.complete || !image.naturalWidth) {
        cancelAnimationFrame(frame);
        frame = 0;
        if (!disposed) setAnimated(false);
        return;
      }
      try {
        renderer ??= createMascotRenderer(canvas, image);
        if (!renderer) return;
        renderer.resize();
        renderer.draw((performance.now() - start) / 1000);
        setAnimated(true);
        if (!frame) frame = requestAnimationFrame(tick);
      } catch {
        renderer?.dispose();
        renderer = null;
        setAnimated(false);
      }
    }
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    const resize = new ResizeObserver(update);
    intersection.observe(image);
    resize.observe(image);
    function contextLost(event: Event) { event.preventDefault(); lost = true; update(); }
    function contextRestored() { lost = false; renderer?.dispose(); renderer = null; update(); }
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    image.addEventListener("load", update);
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      intersection.disconnect();
      resize.disconnect();
      image.removeEventListener("load", update);
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      renderer?.dispose();
    };
  }, []);

  return (
    <div className="auth-mascot-scene" data-animated={animated}>
      <img ref={imageRef} src="/auth-companion-cutout.webp" alt="团团在桌前举着对话气泡，陪你开始工作" width={1448} height={1086} loading="lazy" draggable={false} />
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
