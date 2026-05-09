import { describe, it, expect } from 'vitest';
import { slugifyForgeName, slugToDbName } from './slug';

describe('slugifyForgeName', () => {
  it('lowercases letters', () => {
    expect(slugifyForgeName('Aquaflow')).toBe('aquaflow');
  });

  it('replaces single space with dash', () => {
    expect(slugifyForgeName('Site Survey')).toBe('site-survey');
  });

  it('collapses runs of whitespace into a single dash', () => {
    expect(slugifyForgeName('Site   Survey   Pro')).toBe('site-survey-pro');
  });

  it('trims leading and trailing whitespace', () => {
    expect(slugifyForgeName('   Aquaflow   ')).toBe('aquaflow');
  });

  it('preserves underscores', () => {
    expect(slugifyForgeName('Quote_Builder')).toBe('quote_builder');
  });

  it('preserves dashes', () => {
    expect(slugifyForgeName('Forge-Labs')).toBe('forge-labs');
  });

  it('preserves digits', () => {
    expect(slugifyForgeName('Quote_Builder-2')).toBe('quote_builder-2');
  });

  it('handles a single-word input unchanged in shape', () => {
    expect(slugifyForgeName('PeoplePulse')).toBe('peoplepulse');
  });

  it('handles all-uppercase', () => {
    expect(slugifyForgeName('CRM')).toBe('crm');
  });
});

describe('slugToDbName', () => {
  it('replaces hyphens with underscores', () => {
    expect(slugToDbName('site-survey')).toBe('site_survey');
  });

  it('preserves underscores', () => {
    expect(slugToDbName('quote_builder')).toBe('quote_builder');
  });

  it('preserves digits', () => {
    expect(slugToDbName('quote-builder-2')).toBe('quote_builder_2');
  });

  it('returns single-word slug unchanged in shape', () => {
    expect(slugToDbName('aquaflow')).toBe('aquaflow');
  });

  it('handles all-hyphen edge case', () => {
    expect(slugToDbName('a-b-c-d')).toBe('a_b_c_d');
  });
});
