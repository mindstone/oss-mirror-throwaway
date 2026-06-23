import { describe, expect, it } from 'vitest';
import { extractSlackThreadIdentity } from '../slackThreadIdentity';

describe('extractSlackThreadIdentity', () => {
  it('uses thread_ts when present', () => {
    expect(extractSlackThreadIdentity({
      team: { id: 'T1' },
      channel: 'C1',
      thread_ts: '1000.000001',
      ts: '999.000001',
    })).toEqual({
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '1000.000001',
    });
  });

  it('falls back to ts when thread_ts is absent', () => {
    expect(extractSlackThreadIdentity({
      team: { id: 'T1' },
      channel: 'C1',
      ts: '1000.000002',
    })).toEqual({
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '1000.000002',
    });
  });

  it('returns null when the channel is missing', () => {
    expect(extractSlackThreadIdentity({
      team: { id: 'T1' },
      ts: '1000.000003',
    })).toBeNull();
  });

  it('accepts channel as an object or string', () => {
    expect(extractSlackThreadIdentity({
      team: 'T1',
      channel: { id: 'C1' },
      ts: '1000.000004',
    })).toEqual({
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '1000.000004',
    });

    expect(extractSlackThreadIdentity({
      team: 'T1',
      channel: 'C2',
      ts: '1000.000005',
    })).toEqual({
      teamId: 'T1',
      channelId: 'C2',
      threadTs: '1000.000005',
    });
  });

  it('accepts team as an object or string', () => {
    expect(extractSlackThreadIdentity({
      team: { id: 'T1' },
      channel: 'C1',
      ts: '1000.000006',
    })).toEqual({
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '1000.000006',
    });

    expect(extractSlackThreadIdentity({
      team: 'T2',
      channel: 'C1',
      ts: '1000.000007',
    })).toEqual({
      teamId: 'T2',
      channelId: 'C1',
      threadTs: '1000.000007',
    });
  });
});
