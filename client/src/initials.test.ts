import { describe, expect, it } from 'vitest';

import { initialsFromAddress } from './initials';

describe('initialsFromAddress', () => {
  it('takes one letter from each of the first two parts of the local part', () => {
    expect(initialsFromAddress('rowan.k@northwind.example')).toBe('RK');
    expect(initialsFromAddress('maria_p@northwind.example')).toBe('MP');
    expect(initialsFromAddress('sam-r@northwind.example')).toBe('SR');
    expect(initialsFromAddress('jordan+billing@northwind.example')).toBe('JB');
  });

  it('takes the first two letters when the local part is one word', () => {
    expect(initialsFromAddress('priya@northwind.example')).toBe('PR');
  });

  it('uses only the local part, never the domain', () => {
    // `n` and `e` from `northwind.example` must not appear.
    expect(initialsFromAddress('lee@northwind.example')).toBe('LE');
  });

  it('handles a local part shorter than two characters', () => {
    expect(initialsFromAddress('j@northwind.example')).toBe('J');
  });

  it('reads non-ASCII letters as letters', () => {
    expect(initialsFromAddress('jörg.öztürk@example.com')).toBe('JÖ');
    expect(initialsFromAddress('陈.伟@example.com')).toBe('陈伟');
  });

  it('gives a dash rather than a guess when there is nothing to read', () => {
    expect(initialsFromAddress('@example.com')).toBe('–');
    expect(initialsFromAddress('...@example.com')).toBe('–');
    expect(initialsFromAddress('')).toBe('–');
  });
});
