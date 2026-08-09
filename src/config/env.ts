/**
 * Environment resolution with legacy-prefix fallback.
 *
 * This repository reads `CML_*` variables. The deployed host at
 * /srv/3m-layer/app predates the rename and its env files set
 * `THREE_M_LAYER_*` instead — 54 names whose suffixes are otherwise
 * identical. Deploying this repository onto that host without a fallback
 * would resolve no configuration at all: not the database path, not the
 * actor identity, not the OAuth secrets.
 *
 * So every lookup prefers the current name and falls back to the legacy
 * one. The fallback is a migration aid, not a permanent interface: once
 * the host env files are renamed and verified, `LEGACY_PREFIX` support
 * can be removed without touching any call site.
 *
 * An empty or whitespace-only value counts as unset, so a blank line in
 * an env file falls through to the legacy name rather than masking it.
 */

const CURRENT_PREFIX = "CML_";
const LEGACY_PREFIX = "THREE_M_LAYER_";

function present(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  return value.trim().length > 0 ? value : undefined;
}

/** The legacy name a `CML_*` variable falls back to, or undefined if there isn't one. */
export function legacyNameFor(name: string): string | undefined {
  if (!name.startsWith(CURRENT_PREFIX)) return undefined;
  return LEGACY_PREFIX + name.slice(CURRENT_PREFIX.length);
}

/**
 * Read one variable, preferring its current name over its legacy name.
 * Names outside the `CML_` namespace are read as given.
 */
export function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const current = present(env[name]);
  if (current !== undefined) return current;
  const legacy = legacyNameFor(name);
  return legacy ? present(env[legacy]) : undefined;
}

/** First variable that resolves, in the order given. Each honours the legacy fallback. */
export function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = envValue(name);
    if (value !== undefined) return value;
  }
  return undefined;
}
