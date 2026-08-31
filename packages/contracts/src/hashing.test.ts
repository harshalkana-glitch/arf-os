import { describe, expect, it } from 'vitest';
import { CanonicalisationError, canonicalHash, canonicalJson, sourceHash } from './hashing.js';

describe('canonicalJson', () => {
  it('sorts object keys so insertion order cannot change the hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    const left = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const right = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalHash(left)).toBe(canonicalHash(right));
  });

  it('preserves array order, which is meaningful in an SDL', () => {
    expect(canonicalHash({ p: [1, 2] })).not.toBe(canonicalHash({ p: [2, 1] }));
  });

  it('treats an omitted key and an undefined key as the same document', () => {
    expect(canonicalHash({ a: 1, b: undefined })).toBe(canonicalHash({ a: 1 }));
  });

  it('normalises negative zero', () => {
    expect(canonicalJson({ v: -0 })).toBe('{"v":0}');
    expect(canonicalHash({ v: -0 })).toBe(canonicalHash({ v: 0 }));
  });

  it('rejects non-finite numbers rather than coercing them to null', () => {
    // JSON.stringify would emit null here, making NaN and Infinity hash alike.
    expect(() => canonicalJson({ v: Number.NaN })).toThrow(CanonicalisationError);
    expect(() => canonicalJson({ v: Number.POSITIVE_INFINITY })).toThrow(CanonicalisationError);
  });

  it('names the offending path so a validation failure is actionable', () => {
    expect(() => canonicalJson({ risk: { levels: [1, Number.NaN] } })).toThrow(
      /at risk\.levels\[1\]/,
    );
  });

  it('rejects values that are not JSON', () => {
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(CanonicalisationError);
    expect(() => canonicalJson({ big: 1n })).toThrow(CanonicalisationError);
  });

  it('distinguishes documents that differ only in value type', () => {
    expect(canonicalHash({ v: 1 })).not.toBe(canonicalHash({ v: '1' }));
  });
});

describe('sourceHash', () => {
  it('normalises CRLF so a Windows checkout and a Linux runner agree', () => {
    // TradingView exports and Windows editors produce CRLF; the same Pine
    // revision must not change hash because of the platform that saved it.
    expect(sourceHash('a\r\nb')).toBe(sourceHash('a\nb'));
  });

  it('still distinguishes genuinely different sources', () => {
    expect(sourceHash('a\nb')).not.toBe(sourceHash('a\nc'));
  });

  it('is a lowercase hex sha256', () => {
    expect(sourceHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
