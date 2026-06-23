// Auth store calls the internal cloud-client API module directly.
jest.mock('../../../../cloud-client/src/cloudClient', () => ({
  configure: jest.fn(),
  clearConfig: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue({ status: 'ok', version: '1.0.0' }),
  getSettings: jest.fn().mockResolvedValue({}),
}));

const { initAuthStore, useAuthStore } = require('@rebel/cloud-client');
const cloudClient = require('../../../../cloud-client/src/cloudClient');

beforeAll(() => {
  // Provide an in-memory token storage adapter for tests.
  initAuthStore({
    getToken: jest.fn().mockResolvedValue(null),
    setToken: jest.fn().mockResolvedValue(undefined),
    clearToken: jest.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  // Reset store state
  useAuthStore.setState({
    cloudUrl: null,
    token: null,
    isPaired: false,
    isValidating: false,
    error: null,
  });
});

describe('authStore', () => {
  it('starts unpaired', () => {
    const state = useAuthStore.getState();
    expect(state.isPaired).toBe(false);
    expect(state.cloudUrl).toBeNull();
  });

  it('pairs successfully', async () => {
    await useAuthStore.getState().pair('https://test.fly.dev', 'tok123');
    const state = useAuthStore.getState();
    expect(state.isPaired).toBe(true);
    expect(state.cloudUrl).toBe('https://test.fly.dev');
    expect(state.error).toBeNull();
  });

  it('unpairs', async () => {
    await useAuthStore.getState().pair('https://test.fly.dev', 'tok123');
    await useAuthStore.getState().unpair();
    const state = useAuthStore.getState();
    expect(state.isPaired).toBe(false);
    expect(state.cloudUrl).toBeNull();
  });

  it('handles pairing failure', async () => {
    cloudClient.checkHealth.mockRejectedValueOnce(new Error('Connection refused'));
    await useAuthStore.getState().pair('https://bad.fly.dev', 'tok');
    const state = useAuthStore.getState();
    expect(state.isPaired).toBe(false);
    expect(state.error).toBeTruthy();
  });
});
