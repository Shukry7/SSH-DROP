import { describe, expect, it } from 'vitest';
import { assertUpgrade, parseVersion, validateMetadata } from '../../scripts/version-policy.mjs';

describe('application version policy', () => {
  it.each(['0.1.0-alpha.1', '0.1.0-beta.2', '0.1.0-rc.1', '1.0.0'])(
    'accepts release version %s',
    (value) => {
      expect(parseVersion(value)).toBeDefined();
    },
  );
  it.each(['v1.0.0', '01.0.0', '1.0', '1.0.0-alpha.01', '1.0.0-anything.1'])(
    'rejects invalid version %s',
    (value) => {
      expect(() => parseVersion(value)).toThrow();
    },
  );
  it.each([
    ['0.1.0-alpha.1', '0.1.0-alpha.2'],
    ['0.1.0-alpha.2', '0.1.0-beta.1'],
    ['0.1.0-rc.1', '0.1.0'],
    ['0.1.0', '0.2.0'],
    ['0.2.0', '1.0.0'],
  ])('allows forward release %s → %s', (from, to) => {
    expect(() => assertUpgrade(from, to)).not.toThrow();
  });
  it.each([
    ['1.0.0', '1.0.0'],
    ['1.0.0', '0.9.0'],
    ['1.0.0', '1.0.0-rc.1'],
    ['0.1.0-alpha.2', '0.1.0-alpha.1'],
  ])('rejects non-forward release %s → %s', (from, to) => {
    expect(() => assertUpgrade(from, to)).toThrow();
  });
  const pkg = { version: '0.1.0-alpha.1', description: 'SSH workspace' };
  const lock = { version: pkg.version, packages: { '': { version: pkg.version } } };
  const changelog = `## [${pkg.version}] — Unreleased`;
  it('accepts consistent application and release metadata', () => {
    expect(() =>
      validateMetadata(pkg, lock, changelog.replace('Unreleased', '2026-10-30'), `v${pkg.version}`),
    ).not.toThrow();
  });
  it('rejects lockfile drift', () => {
    expect(() => validateMetadata(pkg, { ...lock, version: '0.0.1' }, changelog)).toThrow('lock');
  });
  it('rejects release tags with unfinished changelogs and README version drift', () => {
    expect(() => validateMetadata(pkg, lock, changelog, `v${pkg.version}`)).toThrow(
      'Date the changelog',
    );
    expect(() =>
      validateMetadata(pkg, lock, changelog, undefined, '**Status: 0.0.1, alpha**'),
    ).toThrow('README');
  });
  it('rejects missing changelog, description, or wrong release tag', () => {
    expect(() => validateMetadata(pkg, lock, '')).toThrow('changelog');
    expect(() => validateMetadata({ ...pkg, description: '' }, lock, changelog)).toThrow(
      'description',
    );
    expect(() => validateMetadata(pkg, lock, changelog, 'v9.0.0')).toThrow('tag');
  });
});
