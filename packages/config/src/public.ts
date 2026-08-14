import { z } from 'zod';

/**
 * Browser-safe configuration.
 *
 * Every value here is compiled into the client bundle and is world-readable.
 * Adding a secret to this schema leaks it. The `NEXT_PUBLIC_` prefix is
 * enforced below so a server-only variable cannot be pulled in by mistake.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

export type PublicEnv = z.infer<typeof publicSchema>;

const FORBIDDEN_KEY = /(SECRET|PASSWORD|TOKEN|PRIVATE|_KEY$|API_KEY|DSN|DATABASE_URL)/i;

export function loadPublicEnv(source: Record<string, string | undefined>): PublicEnv {
  for (const key of Object.keys(publicSchema.shape)) {
    if (!key.startsWith('NEXT_PUBLIC_')) {
      throw new Error(`Public env key "${key}" must start with NEXT_PUBLIC_`);
    }
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`Public env key "${key}" looks like a secret and must not be exposed`);
    }
  }

  const parsed = publicSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid public environment configuration:\n${problems}`);
  }
  return parsed.data;
}
