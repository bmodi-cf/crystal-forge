import { describe, it, expect } from 'vitest';
import { slugifyForgeName } from './slug';

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
