import { describe, it, expect } from 'vitest';
import { profileInitials } from '../../lib/profileInitials';

describe('profileInitials never invents initials for the profile avatar (M20)', () => {
  it('takes the first and last name initials', () => {
    expect(profileInitials('roshana', 'Perera', 'roshana@example.com')).toBe('RP');
  });

  it('uses only the name that is filled in, adding no made-up letter', () => {
    expect(profileInitials('Roshana', '', 'someone@example.com')).toBe('R');
    expect(profileInitials('  ', 'Perera', 'someone@example.com')).toBe('P');
  });

  it('falls back to the email address when both names are empty', () => {
    expect(profileInitials('', '', 'roshana.perera@example.com')).toBe('RP');
    expect(profileInitials(' ', '', 'jane_q_public@example.com')).toBe('JP');
    expect(profileInitials('', '', 'admin@example.com')).toBe('A');
    expect(profileInitials('', '', 'ops+alerts@example.com')).toBe('O');
  });

  it('returns nothing, never J and D, when there is no name or email to use', () => {
    expect(profileInitials('', '', '')).toBe('');
    expect(profileInitials('', '', '@example.com')).toBe('');
  });

  it('keeps a character outside the BMP whole', () => {
    expect(profileInitials('\u{1D49C}da', '', '')).toBe('\u{1D49C}');
  });
});
