// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { resolveRoomSummaries } from './summary.js';

describe('managed room summaries', () => {
  it('treats a loaded empty list as authoritative', () => {
    const previous = [{
      id: 'computer-A-room',
      name: 'A',
      created_ts: '2026-08-01T00:00:00.000Z',
      working: false,
      attention: false,
      unread: 0,
    }];

    expect(resolveRoomSummaries([], true, previous, {})).toEqual([]);
    expect(resolveRoomSummaries([], false, previous, {})).toEqual(previous);
  });
});
