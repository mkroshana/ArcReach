import { describe, it, expect } from 'vitest';
import { planLeadPlaceholders, type LeadPlaceholderRow } from '../../lib/leadPlaceholders';

function lead(email: string, name: string | null, company: string | null = null): LeadPlaceholderRow {
  return { id: email, email, name, company };
}

const ids = (rows: LeadPlaceholderRow[]) => rows.map((row) => row.id);

describe('planLeadPlaceholders', () => {
  it('clears a name that is exactly the local part of the email', () => {
    const plan = planLeadPlaceholders([lead('info@acme.com', 'info'), lead('john.smith@acme.com', 'john.smith')]);
    expect(ids(plan.names)).toEqual(['info@acme.com', 'john.smith@acme.com']);
    expect(plan.caseVariantNames).toEqual([]);
  });

  it('matches the local part of an email stored before emails were lowercased', () => {
    const plan = planLeadPlaceholders([lead('John@Acme.com', 'John')]);
    expect(ids(plan.names)).toEqual(['John@Acme.com']);
  });

  it('keeps a name that matches the local part only ignoring case or spaces apart, as it may be real', () => {
    const plan = planLeadPlaceholders([lead('john@acme.com', 'John'), lead('jane@acme.com', ' jane ')]);
    expect(plan.names).toEqual([]);
    expect(ids(plan.caseVariantNames)).toEqual(['john@acme.com', 'jane@acme.com']);
  });

  it('leaves real names and empty names alone', () => {
    const plan = planLeadPlaceholders([
      lead('john@acme.com', 'John Smith'),
      lead('info@acme.com', 'Jane'),
      lead('sales@acme.com', null),
      lead('@acme.com', ''),
      lead('no-address', 'no-address'),
    ]);
    expect(plan.names).toEqual([]);
    expect(plan.caseVariantNames).toEqual([]);
  });

  it("clears the 'Unknown', 'Self Employed' and 'External Node' companies exactly as they were written", () => {
    const plan = planLeadPlaceholders([
      lead('a@acme.com', 'Ann', 'Unknown'),
      lead('b@acme.com', 'Bob', 'Self Employed'),
      lead('g@acme.com', 'Gus', 'External Node'),
      lead('c@acme.com', 'Cat', 'unknown'),
      lead('d@acme.com', 'Dan', 'Self-Employed'),
      lead('h@acme.com', 'Hal', 'External node'),
      lead('e@acme.com', 'Eve', 'Acme'),
      lead('f@acme.com', 'Fay', null),
    ]);
    expect(ids(plan.companies)).toEqual(['a@acme.com', 'b@acme.com', 'g@acme.com']);
    expect(plan.names).toEqual([]);
  });

  it('lists a lead with both placeholders under names and companies', () => {
    const plan = planLeadPlaceholders([lead('info@acme.com', 'info', 'Unknown')]);
    expect(ids(plan.names)).toEqual(['info@acme.com']);
    expect(ids(plan.companies)).toEqual(['info@acme.com']);
  });
});
