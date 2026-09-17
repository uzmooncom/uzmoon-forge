/**
 * command-env.ts — Safe child process environment builder.
 *
 * Security invariant: Provider API keys and Forge internal vars are NEVER
 * inherited by child processes. PATH and standard OS vars are preserved so
 * commands like `pnpm test` continue to work normally.
 *
 * Responsibility split:
 * - This module strips secrets from the inherited environment.
 * - It does NOT sandbox the child (no seccomp, no chroot).
 * - It does NOT prevent network access by the child.
 * - Secrets removed here are those that would give a child process access to
 *   provider APIs, cloud credentials, or Forge internals.
 */

/**
 * Environment variable names that must be stripped from child environments.
 * Comprehensive list covering major providers and CI/CD systems.
 */
export const STRIPPED_ENV_VARS = new Set<string>([
  // Anthropic
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_ADMIN_KEY",
  // OpenAI / OpenAI-compat
  "OPENAI_API_KEY",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  // GitHub
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_API_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  // AWS
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  // Azure
  "AZURE_OPENAI_API_KEY",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_KEY",
  // Google Cloud
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCP_API_KEY",
  // Forge internals
  "FORGE_API_KEY",
  "FORGE_SECRET",
  "FORGE_DATA_DIR",
  "FORGE_INTERNAL_TOKEN",
  // Common CI/CD / generic secret patterns
  "DATABASE_URL",
  "DB_PASSWORD",
  "DB_SECRET",
  "REDIS_URL",
  "REDIS_PASSWORD",
  "SECRET_KEY",
  "SECRET_KEY_BASE",
  "JWT_SECRET",
  "AUTH_SECRET",
  "ENCRYPTION_KEY",
  "PRIVATE_KEY",
  "SENDGRID_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "NPM_TOKEN",
  "NPM_AUTH_TOKEN",
  "PYPI_TOKEN",
]);

/**
 * Build a safe environment for a child process.
 *
 * Strategy:
 * 1. Start with the current process environment (inherit PATH, HOME, LANG, etc.)
 * 2. Remove all known secret / internal variables
 * 3. Remove any variable whose name looks like an API key pattern
 *
 * The result is a plain object suitable for { env } in child_process.spawn.
 */
export function buildSafeChildEnvironment(
  extra?: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  // Copy all current environment variables
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;

    // Skip explicitly known secret vars (case-sensitive — env vars are case-sensitive on Unix)
    if (STRIPPED_ENV_VARS.has(key)) continue;

    // Skip heuristic API key patterns:
    // - ends with _KEY, _SECRET, _TOKEN, _PASSWORD, _CREDENTIAL, _AUTH
    // - starts with API_ or SECRET_
    if (looksLikeSecretVar(key)) continue;

    env[key] = value;
  }

  // Apply any extra vars (e.g. project-specific vars — none in V1, reserved for future)
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Heuristic: does this environment variable name look like it holds a secret?
 * This catches dynamically-named secrets that aren't in the explicit list.
 *
 * Conservative approach: only strip vars that clearly look like secrets.
 * Avoids stripping things like NODE_OPTIONS or EDITOR.
 */
function looksLikeSecretVar(name: string): boolean {
  const upper = name.toUpperCase();

  // Skip already-covered explicit vars
  if (STRIPPED_ENV_VARS.has(name)) return true;

  // Ends with classic secret suffixes
  if (
    upper.endsWith("_API_KEY") ||
    upper.endsWith("_SECRET_KEY") ||
    upper.endsWith("_SECRET") ||
    upper.endsWith("_AUTH_TOKEN") ||
    upper.endsWith("_ACCESS_TOKEN") ||
    upper.endsWith("_REFRESH_TOKEN") ||
    upper.endsWith("_PASSWORD") ||
    upper.endsWith("_CREDENTIAL") ||
    upper.endsWith("_CREDENTIALS") ||
    upper.endsWith("_PRIVATE_KEY")
  ) {
    return true;
  }

  // Starts with generic secret prefix patterns
  if (upper.startsWith("SECRET_") || upper.startsWith("PRIVATE_")) {
    return true;
  }

  return false;
}

/**
 * Return the set of environment variable names that would be stripped
 * from the current process.env. Useful for testing and audit logging.
 */
export function listStrippedVarNames(): string[] {
  const stripped: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (STRIPPED_ENV_VARS.has(key) || looksLikeSecretVar(key)) {
      stripped.push(key);
    }
  }
  return stripped;
}