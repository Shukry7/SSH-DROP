import { useWorkspace } from './WorkspaceContext';
import { useEffect, useId, useRef, useState } from 'react';
import type { ImagePreview as Preview } from '../../shared/image-preview';

export function ImagePreview({
  directory,
  name,
  close,
}: {
  directory: string;
  name: string;
  close: () => void;
}) {
  const { api, active: workspaceActive } = useWorkspace();
  const localId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (workspaceActive && !element?.open) element?.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, [workspaceActive]);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  useEffect(() => {
    const requestId = crypto.randomUUID();
    let current = true;
    void api
      .openImage({ directory, name, requestId })
      .then((result) => {
        if (!current) return;
        if (result.ok) setPreview(result.value);
        else setError(result.error);
      })
      .catch(() => {
        if (current) setError('The image preview could not be loaded.');
      });
    return () => {
      current = false;
      void api.cancelImage(requestId).catch(() => undefined);
    };
  }, [api, directory, name]);
  const loading = !preview && !error;
  return (
    <dialog
      ref={dialog}
      className="image-preview-dialog"
      aria-labelledby={localId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h3 id={localId}>Image preview</h3>
      <p>
        <bdi>
          {directory === '/' ? '' : directory}/{name}
        </bdi>
      </p>
      <p className="muted">
        Read-only · Up to 10 MiB and 8 megapixels · Images are kept in memory.
      </p>
      {loading && <p role="status">Loading image…</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {preview && (
        <>
          <p>
            {preview.width} × {preview.height} pixels · {preview.format.toUpperCase()} ·{' '}
            {(preview.size / 1024).toFixed(1)} KiB{preview.firstFrame ? ' · First frame only' : ''}
          </p>
          <div className="toolbar image-preview-controls" aria-label="Image zoom controls">
            <button className="secondary compact" onClick={() => setZoom('fit')}>
              Fit to window
            </button>
            <button className="secondary compact" onClick={() => setZoom(1)}>
              Actual size
            </button>
            <button
              className="secondary compact"
              disabled={zoom !== 'fit' && zoom <= 0.25}
              onClick={() => setZoom((value) => Math.max(0.25, (value === 'fit' ? 1 : value) / 2))}
            >
              Zoom out
            </button>
            <button
              className="secondary compact"
              disabled={zoom !== 'fit' && zoom >= 4}
              onClick={() => setZoom((value) => Math.min(4, (value === 'fit' ? 1 : value) * 2))}
            >
              Zoom in
            </button>
            <span aria-live="polite">{zoom === 'fit' ? 'Fit' : `${zoom * 100}%`}</span>
          </div>
          <div className="image-preview-viewport">
            <img
              src={preview.dataUrl}
              alt={`Preview of ${name}`}
              draggable={false}
              className={zoom === 'fit' ? 'image-fit' : undefined}
              style={
                zoom === 'fit'
                  ? undefined
                  : { width: preview.width * zoom, height: preview.height * zoom }
              }
              onError={() => {
                setPreview(undefined);
                setError('The preview could not be displayed.');
              }}
            />
          </div>
        </>
      )}
      <div className="toolbar">
        <button className="secondary" autoFocus onClick={close}>
          {loading ? 'Cancel preview' : 'Close preview'}
        </button>
      </div>
    </dialog>
  );
}
