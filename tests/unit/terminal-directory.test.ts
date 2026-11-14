import { describe, expect, it } from 'vitest';
import { parseTerminalDirectory } from '../../src/renderer/src/terminal-directory';

describe('shell directory reports', () => {
  it.each([
    ['file://server/work/My%20Project/%E6%97%A5', '/work/My Project/日'],
    ['file:///work/%23notes%3F', '/work/#notes?'],
    ['file://[2001:db8::1]/', '/'],
    ['file://different-host/work', '/work'],
  ])('reads the path from %s', (report, path) => {
    expect(parseTerminalDirectory(report)).toBe(path);
  });

  it.each([
    '/work',
    'https://server/work',
    'file://server',
    'file://user@server/work',
    'file://server:22/work',
    'file://server/work?query',
    'file://server/work#fragment',
    'file:///work/%FF',
    'file:///work/%00',
    'file:///work/%1B',
    'file:///work/%E2%80%AE',
    'file:///work/\n',
    `file:///${'a'.repeat(4096)}`,
    `file:///${'%41'.repeat(6000)}`,
  ])('refuses invalid or oversized directory reports', (report) => {
    expect(parseTerminalDirectory(report)).toBeUndefined();
  });
});
