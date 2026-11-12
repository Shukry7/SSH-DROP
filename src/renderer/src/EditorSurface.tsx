import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { editorLanguageExtension, type EditorLanguage } from './editor-language';

export interface EditorSurfaceHandle {
  select: (start: number, end: number) => void;
}

const colors = HighlightStyle.define([
  { tag: tags.keyword, color: '#c4a7ff' },
  { tag: [tags.string, tags.special(tags.string)], color: '#9bd6a5' },
  { tag: [tags.number, tags.bool, tags.null], color: '#f3bb82' },
  { tag: tags.comment, color: '#91a4b8', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.typeName], color: '#86d5ef' },
  { tag: tags.propertyName, color: '#e6c887' },
]);
const theme = EditorView.theme(
  {
    '&': {
      color: '#dce8f2',
      backgroundColor: '#0b121a',
      border: '1px solid #344454',
      borderRadius: '8px',
      overflow: 'hidden',
    },
    '&.cm-focused': { outline: '2px solid #65cbb8', outlineOffset: '2px' },
    '.cm-scroller': {
      height: 'min(45vh, 460px)',
      overflow: 'auto',
      fontFamily: '"Courier Prime", monospace',
      fontSize: '13px',
      lineHeight: '1.5',
    },
    '.cm-content': { padding: '12px 0', minHeight: '100%', caretColor: '#8ce6d3' },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': {
      backgroundColor: '#111d28',
      color: '#96a9bd',
      borderRight: '1px solid #344454',
    },
    '.cm-activeLineGutter': { backgroundColor: '#223442', color: '#e3f4ff' },
    '.cm-cursor': { borderLeftColor: '#8ce6d3' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: '#325e72',
    },
  },
  { dark: true },
);

export function EditorSurface({
  text,
  language,
  busy,
  onChange,
  ref,
}: {
  text: string;
  language: EditorLanguage;
  busy: boolean;
  onChange: (text: string) => void;
  ref: Ref<EditorSurfaceHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const configuration = useRef({ language: new Compartment(), editable: new Compartment() });
  const initial = useRef({ text, language, busy });
  const changed = useRef(onChange);
  useLayoutEffect(() => {
    changed.current = onChange;
  }, [onChange]);
  useImperativeHandle(
    ref,
    () => ({
      select(start, end) {
        const editor = view.current;
        if (!editor) return;
        editor.dispatch({
          selection: { anchor: start, head: end },
          effects: EditorView.scrollIntoView(start, { y: 'center' }),
        });
        editor.focus();
      },
    }),
    [],
  );
  useEffect(() => {
    const compartments = configuration.current;
    const props = initial.current;
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.text,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            { key: 'Mod-Shift-z', run: redo, preventDefault: true },
          ]),
          theme,
          syntaxHighlighting(colors),
          EditorView.contentAttributes.of({
            'aria-label': 'Remote file contents',
            'aria-multiline': 'true',
            spellcheck: 'false',
          }),
          compartments.language.of(editorLanguageExtension(props.language)),
          compartments.editable.of([
            EditorState.readOnly.of(props.busy),
            EditorView.editable.of(!props.busy),
          ]),
          EditorState.transactionFilter.of((transaction) =>
            transaction.newDoc.length <= 1048576 ? transaction : [],
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    editor.focus();
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== text) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    }
  }, [text]);
  useEffect(() => {
    view.current?.dispatch({
      effects: configuration.current.language.reconfigure(editorLanguageExtension(language)),
    });
  }, [language]);
  useEffect(() => {
    view.current?.dispatch({
      effects: configuration.current.editable.reconfigure([
        EditorState.readOnly.of(busy),
        EditorView.editable.of(!busy),
      ]),
    });
  }, [busy]);
  return <div className="editor-surface" ref={host} />;
}
