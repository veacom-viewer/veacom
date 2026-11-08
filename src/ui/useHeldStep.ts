import { useEffect, useEffectEvent, useState } from 'react';

type Direction = -1 | 1;

/** Step once on press, then repeat with the current value until that pointer is released. */
export function useHeldStep(step: (by: Direction, repeat: number) => boolean, interval: number) {
  const [press, setPress] = useState<{ by: Direction; pointerId: number } | null>(null);
  const repeatStep = useEffectEvent(step);
  useEffect(() => {
    if (!press) return;
    const { by, pointerId } = press;
    let timer = window.setTimeout(tick, 400, 0);
    function tick(repeat: number) {
      if (repeatStep(by, repeat)) timer = window.setTimeout(tick, interval, repeat + 1);
      else stop();
    }
    function stop() { window.clearTimeout(timer); setPress(null); }
    const released = (event: PointerEvent) => { if (event.pointerId === pointerId) stop(); };
    window.addEventListener('pointerup', released, true);
    window.addEventListener('pointercancel', released, true);
    window.addEventListener('lostpointercapture', released, true);
    window.addEventListener('blur', stop);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerup', released, true);
      window.removeEventListener('pointercancel', released, true);
      window.removeEventListener('lostpointercapture', released, true);
      window.removeEventListener('blur', stop);
    };
  }, [press, interval]);
  return (by: Direction, pointerId: number) => {
    setPress(step(by, 0) ? { by, pointerId } : null);
  };
}
