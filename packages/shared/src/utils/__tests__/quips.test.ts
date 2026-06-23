describe('getProcessingQuip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns a quip string from the shared list', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { getProcessingQuip } = await import('../quips');

    expect(getProcessingQuip()).toBe('Surveying the territory.');
  });

  it('does not repeat the previous quip when more than one option exists', async () => {
    const randomValues = [0, 0, 0.2];
    let index = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => randomValues[index++] ?? 0.2);

    const { getProcessingQuip } = await import('../quips');
    const first = getProcessingQuip();
    const second = getProcessingQuip();

    expect(first).toBe('Surveying the territory.');
    expect(second).toBe('Building Rome. Give me a minute.');
    expect(second).not.toBe(first);
  });
});
