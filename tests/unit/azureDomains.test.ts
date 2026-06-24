import { describe, it, expect } from 'vitest';
import { getVerifiedDomains, resolveAzureFromAddress } from '../../lib/azureDomains';

describe('getVerifiedDomains', () => {
  it('returns the normalized, de-duped domain list', () => {
    expect(getVerifiedDomains({ azureSenderDomains: ['A.com', 'a.com', ' b.com '] }))
      .toEqual(['a.com', 'b.com']);
  });

  it('falls back to the legacy single field when the array is empty', () => {
    expect(getVerifiedDomains({ azureSenderDomains: [], azureSenderDomain: 'Legacy.com' }))
      .toEqual(['legacy.com']);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(getVerifiedDomains(null)).toEqual([]);
    expect(getVerifiedDomains({})).toEqual([]);
  });
});

describe('resolveAzureFromAddress', () => {
  const settings = { azureSenderDomains: ['thejobshelpers.com', 'outbound.acme.com'] };

  it('returns the sender address unchanged when its domain is verified', () => {
    expect(resolveAzureFromAddress('John@thejobshelpers.com', settings))
      .toBe('John@thejobshelpers.com');
  });

  it('throws when the sender domain is not verified', () => {
    expect(() => resolveAzureFromAddress('john@gmail.com', settings))
      .toThrow(/not in the verified/i);
  });

  it('throws on a malformed sender address', () => {
    expect(() => resolveAzureFromAddress('not-an-email', settings)).toThrow(/valid address/i);
  });
});
