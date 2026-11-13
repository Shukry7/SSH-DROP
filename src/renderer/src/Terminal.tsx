import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { SessionEvent } from '../../shared/contracts';

export type TerminalOutput = (
  event: Extract<SessionEvent, { type: 'terminal' | 'terminal-exit' }>,
) => void;

export function Terminal({
  id,
  subscribe,
  connected,
  visible,
}: {
  id?: string;
  subscribe: (id: string, listener: TerminalOutput) => () => void;
  connected: boolean;
  visible: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const active = useRef(connected && visible);
  const terminal = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);

  useEffect(() => {
    let disposeView = () => {};
    const createView = () => {
      disposeView();
      const view = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Cascadia Code, SFMono-Regular, Consolas, monospace',
        scrollback: 5000,
        allowProposedApi: false,
        theme: {
          background: '#0b1017',
          foreground: '#d6dfeb',
          cursor: '#58e0bb',
          selectionBackground: '#25494a',
        },
      });
      const addon = new FitAddon();
      terminal.current = view;
      fit.current = addon;
      view.loadAddon(addon);
      view.open(element.current!);
      if (element.current?.clientHeight && element.current.clientWidth) addon.fit();
      const subscription = view.onData((data) => {
        if (active.current) void window.sshdrop.input(data, id);
      });
      let frame = 0;
      let disposed = false;
      const resize = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (disposed || !element.current?.clientHeight || !element.current.clientWidth) return;
          addon.fit();
          if (active.current)
            void window.sshdrop.resize({ cols: view.cols, rows: view.rows, terminalId: id });
        });
      };
      const observer = new ResizeObserver(resize);
      observer.observe(element.current!);
      window.addEventListener('resize', resize);
      void document.fonts.ready.then(() => {
        if (!disposed) resize();
      });
      resize();
      disposeView = () => {
        disposed = true;
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', resize);
        subscription.dispose();
        observer.disconnect();
        view.dispose();
        terminal.current = null;
        fit.current = null;
      };
    };
    createView();
    const unsubscribe = id
      ? subscribe(id, (event) => {
          if (event.type === 'terminal')
            terminal.current?.write(event.data, () => {
              void window.sshdrop.acknowledge(event.id);
            });
          if (event.type === 'terminal-exit') {
            active.current = false;
            terminal.current?.writeln(
              '\r\n[Shell closed. Open a new terminal to start another shell.]',
            );
          }
        })
      : undefined;
    return () => {
      unsubscribe?.();
      disposeView();
    };
  }, [id, subscribe]);

  useEffect(() => {
    active.current = connected && visible;
    if (connected && visible && terminal.current) {
      fit.current?.fit();
      void window.sshdrop.resize({
        cols: terminal.current.cols,
        rows: terminal.current.rows,
        terminalId: id,
      });
    }
  }, [connected, id, visible]);

  return (
    <div
      className="terminal-surface"
      ref={element}
      aria-label="Remote SSH terminal"
      hidden={!visible}
      role={id ? 'tabpanel' : undefined}
      id={id ? `terminal-panel-${id}` : undefined}
      aria-labelledby={id ? `terminal-tab-${id}` : undefined}
    />
  );
}
