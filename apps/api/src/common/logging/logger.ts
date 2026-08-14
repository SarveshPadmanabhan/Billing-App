import pino from 'pino';

/**
 * Structured logging (Tech Arch Doc §21).
 *
 * Redaction is the important part: Security Doc §21 forbids logging passwords,
 * tokens, API keys, and payment credentials. The redact list below is applied
 * by pino before serialisation, so a secret cannot reach the log even if a
 * caller passes a whole request object.
 */

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.secret',
  '*.apiKey',
  'body.password',
  'body.token',
  'account.password',
  'user.password',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'ENCRYPTION_KEY',
  'S3_SECRET_ACCESS_KEY',
  'EMAIL_API_KEY',
];

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    // Never serialise a raw Error into the message field — stack traces are
    // for the log, not the response.
    serializers: {
      err: pino.stdSerializers.err,
      req: (req: { id?: string; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
