const SECRET_NAME_PATTERNS = [
  /AWS/i,
  /GITHUB/i,
  /^GH_/i,
  /OPENROUTER/i,
  /ANTHROPIC/i,
  /OPENAI/i,
  /GEMINI/i,
  /GOOGLE.*KEY/i,
  /STRIPE/i,
  /MAILGUN/i,
  /BUGSNAG/i,
  /JWT/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /AURORA/i,
  /ZAP_/i,
  /API_KEY/i,
];

export function sanitizedWorkerEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_NAME_PATTERNS.some((pattern) => pattern.test(key))) safe[key] = value;
  }
  return {
    ...safe,
    CI: "1",
    NODE_ENV: "test",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}
