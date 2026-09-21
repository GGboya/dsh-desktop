/** Desktop-wide pnpm policy applied to every package-manager operation. */

/**
 * DSH Desktop accepts explicitly requested package versions immediately.
 * Keep this process-local: never rewrite a user's pnpm configuration file.
 */
export const PNPM_IGNORE_MINIMUM_RELEASE_AGE = '--config.minimumReleaseAge=0'

/**
 * Desktop owns a Profile's manifest and rewrites it on purpose: recovery
 * restores a configuration the lockfile has not caught up with, and the install
 * that follows is what reconciles the two. pnpm freezes the lockfile by default
 * whenever `CI` is set, which turns that reconciliation into an error, so opt
 * out for every Desktop-driven operation instead of trusting the environment.
 */
export const PNPM_RECONCILE_LOCKFILE = '--config.frozen-lockfile=false'

const DESKTOP_POLICY: readonly string[] = [PNPM_IGNORE_MINIMUM_RELEASE_AGE, PNPM_RECONCILE_LOCKFILE]
const withoutPolicy = (argv: readonly string[]): string[] => argv.filter(argument => !DESKTOP_POLICY.includes(argument))

/** Prefix a direct pnpm argv without adding the same Desktop policy twice. */
export function withDesktopPnpmPolicy(argv: readonly string[]): string[] {
  return [...DESKTOP_POLICY, ...withoutPolicy(argv)]
}

/** The pnpm shim takes its entry path first, so its policy has to trail the argv. */
export function withTrailingDesktopPnpmPolicy(argv: readonly string[]): string[] {
  return [...withoutPolicy(argv), ...DESKTOP_POLICY]
}

/**
 * `dsh plugin` ultimately resolves the Desktop pnpm shim, which owns the
 * policy arguments. Remove eagerly forwarded copies before that boundary.
 */
export function withoutForwardedDesktopPnpmPolicy(argv: readonly string[]): string[] {
  if (argv[0] !== 'plugin') return [...argv]
  return [argv[0], ...withoutPolicy(argv.slice(1))]
}
