import { describe, it, expect } from 'vitest';
import { rupees, gutterWidth, percent } from '@/services/format';

describe('rupees', () => {
  it('converts paise to rupees at the render boundary only', () => {
    expect(rupees(10000)).toBe('₹100.00');
    expect(rupees(1)).toBe('₹0.01');
  });

  it('uses a minus sign for shortfalls, not a bracket', () => {
    expect(rupees(-4550)).toBe('−₹45.50');
  });

  it('shows an explicit plus only when asked', () => {
    expect(rupees(4550, { sign: true })).toBe('+₹45.50');
    expect(rupees(4550)).toBe('₹45.50');
  });
});

describe('gutterWidth', () => {
  it('draws nothing when the row ties out', () => {
    expect(gutterWidth(0, 100000)).toBe(0);
  });

  it('keeps a small break visible against a large one — the point of sqrt scaling', () => {
    const small = gutterWidth(100, 10000);
    const linearSmall = (100 / 10000) * 100; // what a linear scale would give
    expect(small).toBeGreaterThan(linearSmall);
    expect(small).toBeGreaterThan(5); // still legible, not a sub-pixel smear
  });

  it('gives the largest break the full width', () => {
    expect(gutterWidth(10000, 10000)).toBeCloseTo(100);
  });

  it('is direction-agnostic — the sign is carried by layout, not width', () => {
    expect(gutterWidth(-500, 10000)).toBeCloseTo(gutterWidth(500, 10000));
  });
});

describe('percent', () => {
  it('renders an em dash for a null score rather than 0%', () => {
    // Live data has no answer key. "—" says that; "0.0%" would be a lie.
    expect(percent(null)).toBe('—');
    expect(percent(0.983)).toBe('98.3%');
  });
});
