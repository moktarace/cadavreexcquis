import { useEffect, useRef } from 'react';
import { HEIGHT, WIDTH } from '../palette';
import { indexedToRgba } from '../render';
import type { Project } from '../project';
import type { EditorSession } from '../session';
import { ToyToggle } from '../../ui';

/** Confort de dessin: stylet. */
export function SettingsPanel({ session }: { session: EditorSession }) {
  return (
    <div className="ed-panel ed-settings">
      <ToyToggle checked={session.penOnly} onChange={(penOnly) => session.update({ penOnly })}>Stylet seulement</ToyToggle>
    </div>
  );
}

export function Thumb({ project }: { project: Project }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext('2d')!;
    const rgba = indexedToRgba(project.pixels);
    ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, WIDTH, HEIGHT), 0, 0);
  }, [project]);
  return <canvas ref={ref} width={WIDTH} height={HEIGHT} />;
}
