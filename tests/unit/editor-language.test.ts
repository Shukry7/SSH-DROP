import { describe, expect, it } from 'vitest';
import {
  detectEditorLanguage,
  editorLanguageExtension,
} from '../../src/renderer/src/editor-language';

describe('editor display language', () => {
  it.each([
    ['/app/index.ts', 'typescript'],
    ['/app/view.TSX', 'typescript'],
    ['/app/index.mjs', 'javascript'],
    ['/app/view.jsx', 'javascript'],
    ['/config/settings.json', 'json'],
    ['/config/settings.jsonc', 'json'],
    ['/config/compose.yml', 'yaml'],
    ['/config/config.YAML', 'yaml'],
    ['/scripts/main.py', 'python'],
    ['/scripts/run.sh', 'shell'],
    ['/home/test/.bashrc', 'shell'],
    ['/home/test/.profile', 'shell'],
    ['/app/unknown.txt', 'plain'],
    ['/app/test.ts.backup', 'plain'],
    ['/folder.json/unknown', 'plain'],
    ['/app/README', 'plain'],
    ['/app/<script>.txt', 'plain'],
  ])('detects only the filename for %s', (path, expected) => {
    expect(detectEditorLanguage(path)).toBe(expected);
  });
  it('keeps unrecognized contents as plain text without executing or guessing them', () => {
    expect(editorLanguageExtension('plain')).toEqual([]);
    expect(detectEditorLanguage('echo $(whoami)')).toBe('plain');
  });
});
