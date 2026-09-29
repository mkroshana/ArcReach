/**
 * Password rules shared by every place a password is set: admin create/reset (/api/users),
 * self-service change (PUT /api/settings) and the forms that call them.
 *
 * Has no Node-only imports so client components can check before submitting.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Returns why `password` can not be used, or null when it meets the policy. Non-strings are rejected. */
export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `A password of at least ${MIN_PASSWORD_LENGTH} characters is required.`;
  }
  return null;
}
