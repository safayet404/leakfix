// What leakfix looks for. Each rule recognises one kind of credential that leakfix
// knows how to rotate (or, for "generic", at least report).
//
// Detection is deliberately simple and explainable: env-style KEY=value lines
// and connection strings. Broad pattern libraries (gitleaks, trufflehog) find
// far more; leakfix's job is what happens *after* a leak is found.

export type SecretKind = "mongodb-uri" | "jwt-secret" | "smtp-password" | "vercel-token" | "generic";

export interface Rule {
  kind: SecretKind;
  description: string;
  /** Matches the variable name in KEY=value lines. */
  key?: RegExp;
  /** Matches the value itself, wherever it appears. */
  value?: RegExp;
}

export const RULES: Rule[] = [
  {
    kind: "mongodb-uri",
    description: "MongoDB connection string with a username and password",
    value: /mongodb(?:\+srv)?:\/\/[^\s:@/'"]+:[^\s@/'"]+@[^\s'"]+/,
  },
  {
    kind: "jwt-secret",
    description: "Secret used to sign JSON Web Tokens",
    key: /^(?:[A-Z0-9_]*_)?JWT(?:_[A-Z0-9]+)*_SECRET$|^(?:ACCESS|REFRESH)_TOKEN_SECRET$/,
  },
  {
    kind: "smtp-password",
    description: "SMTP / email account password",
    key: /^(?:SMTP|MAIL|EMAIL)_(?:PASS|PASSWORD)$/,
  },
  {
    kind: "vercel-token",
    description: "Vercel access token",
    key: /^VERCEL_(?:ACCESS_)?TOKEN$/,
  },
  {
    kind: "generic",
    description: "Variable whose name suggests a secret",
    key: /(?:SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|TOKEN)$/,
  },
];

/** Values that are obviously placeholders, not real secrets. */
export const PLACEHOLDER = /^(?:|changeme|change_me|your[_-].*|<.*>|\$\{.*\}|x+|\*+|example.*|dummy|test|secret|password|null|undefined)$/i;
