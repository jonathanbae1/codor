import { beforeEach, describe, expect, it } from 'vitest';

import {
  activeComputerNamespace,
  resetActiveComputerForTest,
  roomKeyPersistenceOwner,
  setActiveComputer,
} from './active-computer.js';

beforeEach(resetActiveComputerForTest);

describe('per-tab active computer context', () => {
  it('namespaces hosted state by the explicitly selected computer', () => {
    setActiveComputer('computer-B');
    expect(activeComputerNamespace()).toBe('computer:computer-B');
    expect(roomKeyPersistenceOwner(true)).toEqual({ kind: 'computer', id: 'computer-B' });
  });

  it('does not guess a hosted owner without a tab context', () => {
    expect(roomKeyPersistenceOwner(true)).toBeUndefined();
  });

  it('preserves the direct single-computer fallback', () => {
    expect(activeComputerNamespace()).toBe('direct');
    expect(roomKeyPersistenceOwner(false)).toEqual({ kind: 'direct' });
  });
});
