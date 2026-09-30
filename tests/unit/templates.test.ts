import { describe, it, expect } from 'vitest';
import { personalizeEmail, personalizePreview } from '../../lib/personalize';
import { isDispatchForStep } from '../../lib/dispatchAudit';

// The template and campaign editors preview a subject with personalizePreview.
describe('Template Resolver Logic', () => {
  it('should replace firstName and company variables correctly', () => {
    const input = 'Hi {{firstName}}, how is everything at {{company}}?';
    const output = personalizePreview(input);
    expect(output).toBe('Hi Emily, how is everything at Stark Industries?');
  });

  it('should allow custom variables for replacement override', () => {
    const input = 'Hello {{firstName}}, greetings from {{company}}!';
    const output = personalizeEmail(input, { name: 'Mark', company: 'Oscorp' }, () => 0);
    expect(output).toBe('Hello Mark, greetings from Oscorp!');
  });

  it('should resolve simple spintax pattern using the first option', () => {
    const input = '{Quick question|Hello|Hi} regarding outreach.';
    const output = personalizePreview(input);
    expect(output).toBe('Quick question regarding outreach.');
  });

  it('should resolve mixed variables and spintax together', () => {
    const input = '{Hey|Hello} {{firstName}}, check out {this case study|our tool} for {{company}}.';
    const output = personalizeEmail(input, { name: 'Tony', company: 'Stark Ind' }, () => 0);
    expect(output).toBe('Hey Tony, check out this case study for Stark Ind.');
  });

  it('should handle empty input strings gracefully', () => {
    expect(personalizePreview('')).toBe('');
  });
});

// scripts/audit-dispatches.ts infers a legacy dispatch's step with isDispatchForStep.
describe('isDispatchForStep Heuristic', () => {
  it('should match exact subjects', () => {
    expect(isDispatchForStep('Outreach', 'Outreach')).toBe(true);
  });

  it('should match subjects with personalized variables', () => {
    expect(isDispatchForStep('Welcome Emily!', 'Welcome {{firstName}}!')).toBe(true);
    expect(isDispatchForStep('Quick question regarding Stark Industries outreach', 'Quick question regarding {{company}} outreach')).toBe(true);
  });

  it('should match subjects with spintax', () => {
    expect(isDispatchForStep('Hi Emily', '{Hi|Hello} {{firstName}}')).toBe(true);
  });

  it('should match single characters or digits', () => {
    expect(isDispatchForStep('2', '2 {{firstName}}')).toBe(true);
    expect(isDispatchForStep('22', '22')).toBe(true);
    expect(isDispatchForStep('22', '2 {{firstName}}')).toBe(false); // should not match partial words
  });

  it('should handle missing subjects gracefully', () => {
    expect(isDispatchForStep('', '')).toBe(false);
    expect(isDispatchForStep('Welcome', '')).toBe(false);
    expect(isDispatchForStep('', 'Welcome')).toBe(false);
  });
});
