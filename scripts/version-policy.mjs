export function parseVersion(value) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) throw new Error('Use X.Y.Z or X.Y.Z-alpha.N, -beta.N, or -rc.N.');
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    stage: match[4] ?? 'stable',
    iteration: Number(match[5] ?? 0),
  };
}

export function assertUpgrade(current, next) {
  const from = parseVersion(current);
  const to = parseVersion(next);
  const stages = { alpha: 0, beta: 1, rc: 2, stable: 3 };
  const a = [from.major, from.minor, from.patch, stages[from.stage], from.iteration];
  const b = [to.major, to.minor, to.patch, stages[to.stage], to.iteration];
  const index = a.findIndex((value, i) => value !== b[i]);
  if (index < 0 || b[index] < a[index])
    throw new Error('The new version must be newer than the current version.');
}

export function validateMetadata(pkg, lock, changelog, tag, readme) {
  parseVersion(pkg.version);
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version)
    throw new Error('package-lock.json version does not match package.json.');
  if (!changelog.includes(`## [${pkg.version}]`))
    throw new Error('Add a changelog entry for the application version.');
  if (!pkg.description?.trim()) throw new Error('Application description is required.');
  if (tag && tag !== `v${pkg.version}`)
    throw new Error('Release tag must match the application version.');
  if (tag) {
    const heading = changelog.split('\n').find((line) => line.startsWith(`## [${pkg.version}]`));
    if (!/— \d{4}-\d{2}-\d{2}$/.test(heading ?? ''))
      throw new Error('Date the changelog entry before tagging a release.');
  }
  if (readme !== undefined && !readme.includes(`**Status: ${pkg.version},`))
    throw new Error('README application version does not match package.json.');
}
