import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { python } from '@codemirror/lang-python';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';

export const editorLanguages = {
  plain: 'Plain text',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  yaml: 'YAML',
  python: 'Python',
  shell: 'Shell',
} as const;
export type EditorLanguage = keyof typeof editorLanguages;

export function detectEditorLanguage(path: string): EditorLanguage {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  if (/\.(tsx?|mts|cts)$/.test(name)) return 'typescript';
  if (/\.(jsx?|mjs|cjs)$/.test(name)) return 'javascript';
  if (/\.(json|jsonc)$/.test(name)) return 'json';
  if (/\.ya?ml$/.test(name)) return 'yaml';
  if (/\.pyw?$/.test(name)) return 'python';
  if (/\.(sh|bash|zsh)$/.test(name) || ['.bashrc', '.zshrc', '.profile'].includes(name))
    return 'shell';
  return 'plain';
}

export function editorLanguageExtension(language: EditorLanguage) {
  switch (language) {
    case 'javascript':
      return javascript({ jsx: true });
    case 'typescript':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'python':
      return python();
    case 'shell':
      return StreamLanguage.define(shell);
    default:
      return [];
  }
}
