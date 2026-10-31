import { describe, expect, it } from 'vitest';
import {
  childPath,
  connectionSchema,
  remotePath,
  terminalInputSchema,
  terminalSizeSchema,
} from '../../src/shared/validation';

describe('IPC input validation', () => {
  const password = {
    host: 'example.com',
    port: 22,
    username: 'deploy',
    auth: 'password',
    password: 'secret',
  };
  it('accepts and normalizes connection fields', () => {
    expect(connectionSchema.parse({ ...password, host: ' example.com ' }).host).toBe('example.com');
  });
  it.each([0, 65536, 2.5])('rejects invalid port %s', (port) => {
    expect(() => connectionSchema.parse({ ...password, port })).toThrow();
  });
  it.each(['', 'bad host', 'host\0', '../host', 'bad\nname'])(
    'rejects malformed host %j',
    (host) => {
      expect(() => connectionSchema.parse({ ...password, host })).toThrow();
    },
  );
  it('requires the selected authentication credential', () => {
    expect(() => connectionSchema.parse({ ...password, password: '' })).toThrow();
    expect(() => connectionSchema.parse({ ...password, auth: 'key' })).toThrow();
    expect(
      connectionSchema.parse({
        ...password,
        auth: 'key',
        keyId: 'bc9c39a3-cd46-4aa2-8ff1-189c51db11f5',
      }).auth,
    ).toBe('key');
  });
  it('rejects unknown privileged fields', () => {
    expect(() => connectionSchema.parse({ ...password, privateKeyPath: '/etc/shadow' })).toThrow();
  });
  it('uses remote POSIX paths on every local OS', () => {
    expect(remotePath('/home/deploy/../app')).toBe('/home/app');
    expect(childPath('/home/app', "space 'quote' 日本語.txt")).toBe(
      "/home/app/space 'quote' 日本語.txt",
    );
    expect(childPath('/', 'file')).toBe('/file');
  });
  it.each(['relative', 'C:\\Users\\file', '/bad\0name'])(
    'rejects invalid remote path %j',
    (path) => {
      expect(() => remotePath(path)).toThrow();
    },
  );
  it.each(['', '.', '..', '../escape', '/absolute', 'bad\0name'])(
    'rejects unsafe child name %j',
    (name) => {
      expect(() => childPath('/root', name)).toThrow();
    },
  );
  it('bounds terminal messages and dimensions', () => {
    expect(terminalInputSchema.parse('\u0003')).toBe('\u0003');
    expect(() => terminalInputSchema.parse('a'.repeat(65537))).toThrow();
    expect(terminalSizeSchema.parse({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(() => terminalSizeSchema.parse({ cols: 0, rows: 24 })).toThrow();
    expect(() => terminalSizeSchema.parse({ cols: 80, rows: 1001 })).toThrow();
  });
});
