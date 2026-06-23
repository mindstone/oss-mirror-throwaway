import { getGreeting } from '../getGreeting';

function mockHour(hour: number): void {
  vi.spyOn(Date.prototype, 'getHours').mockReturnValue(hour);
}

describe('getGreeting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns "Good morning" before noon', () => {
    mockHour(8);
    expect(getGreeting()).toBe('Good morning');
  });

  it('returns "Good afternoon" between noon and 5pm', () => {
    mockHour(14);
    expect(getGreeting()).toBe('Good afternoon');
  });

  it('returns "Good evening" after 5pm', () => {
    mockHour(19);
    expect(getGreeting()).toBe('Good evening');
  });

  it('returns "Good morning" at midnight', () => {
    mockHour(0);
    expect(getGreeting()).toBe('Good morning');
  });

  it('returns "Good afternoon" at exactly noon', () => {
    mockHour(12);
    expect(getGreeting()).toBe('Good afternoon');
  });

  it('returns "Good evening" at exactly 5pm', () => {
    mockHour(17);
    expect(getGreeting()).toBe('Good evening');
  });

  it('includes the name when provided', () => {
    mockHour(8);
    expect(getGreeting('Sam')).toBe('Good morning, Sam');
  });

  it('omits the name when empty', () => {
    mockHour(8);
    expect(getGreeting('')).toBe('Good morning');
  });
});
