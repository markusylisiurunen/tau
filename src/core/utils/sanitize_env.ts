const SENSITIVE_ENV_PATTERNS = [/_KEY$/, /_SECRET$/, /_TOKEN$/, /_PASSWORD$/, /^API_KEY$/];
const ALLOWED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "OLDPWD",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_DEFAULT_PLATFORM",
]);

export function sanitizeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ALLOWED_ENV_VARS.has(key)) {
      sanitized[key] = value;
      continue;
    }
    if (SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
