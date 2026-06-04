import { describe, it, expect } from 'vitest';

// Copy of the resolver function from app/templates/page.tsx to test its logic in isolation
function resolveTemplateText(text: string, variables: Record<string, string> = { firstName: 'Emily', company: 'Stark Industries' }) {
  if (!text) return '';
  let result = text;
  
  // Replace variables
  result = result.replace(/\{\{firstName\}\}/g, variables.firstName || 'Emily');
  result = result.replace(/\{\{company\}\}/g, variables.company || 'Stark Industries');

  // Basic Spintax solver: {A|B|C} -> selects the first option for consistency in preview
  const spintaxRegex = /\{([^{}]+)\}/g;
  result = result.replace(spintaxRegex, (match, options) => {
    const choices = options.split('|');
    return choices[0] || '';
  });

  return result;
}

describe('Template Resolver Logic', () => {
  it('should replace firstName and company variables correctly', () => {
    const input = 'Hi {{firstName}}, how is everything at {{company}}?';
    const output = resolveTemplateText(input);
    expect(output).toBe('Hi Emily, how is everything at Stark Industries?');
  });

  it('should allow custom variables for replacement override', () => {
    const input = 'Hello {{firstName}}, greetings from {{company}}!';
    const output = resolveTemplateText(input, { firstName: 'Mark', company: 'Oscorp' });
    expect(output).toBe('Hello Mark, greetings from Oscorp!');
  });

  it('should resolve simple spintax pattern using the first option', () => {
    const input = '{Quick question|Hello|Hi} regarding outreach.';
    const output = resolveTemplateText(input);
    expect(output).toBe('Quick question regarding outreach.');
  });

  it('should resolve mixed variables and spintax together', () => {
    const input = '{Hey|Hello} {{firstName}}, check out {this case study|our tool} for {{company}}.';
    const output = resolveTemplateText(input, { firstName: 'Tony', company: 'Stark Ind' });
    expect(output).toBe('Hey Tony, check out this case study for Stark Ind.');
  });

  it('should handle empty input strings gracefully', () => {
    expect(resolveTemplateText('')).toBe('');
  });
});
