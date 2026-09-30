/** First character of a word, whole even when it lies outside the BMP, or '' for an empty word. */
function firstChar(word: string): string {
  return Array.from(word.trim())[0] || '';
}

/**
 * Initials for the profile avatar, never invented: the first and last name's
 * initials, or when both are empty those of the email's local part (split on
 * '.', '_' and '-', ignoring a '+tag'), or '' when there is nothing to take them
 * from, so the avatar shows a person icon instead.
 */
export function profileInitials(firstName: string, lastName: string, email: string): string {
  const fromName = firstChar(firstName) + firstChar(lastName);
  if (fromName) return fromName.toUpperCase();
  const local = email.trim().split('@')[0].split('+')[0];
  const words = local.split(/[._-]+/).filter(Boolean);
  const fromEmail = firstChar(words[0] || '') + (words.length > 1 ? firstChar(words[words.length - 1]) : '');
  return fromEmail.toUpperCase();
}
