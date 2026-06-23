import { stripSensitiveSettingsForClient } from '@shared/cloudSettingsPolicy';

describe('settingsRender models namespace parity', () => {
  it('strips sensitive fields from models without requiring legacy claude in API response', () => {
    const rawSettings = {
      modelsNamespaceSchemaVersion: 2,
      models: {
        apiKey: 'secret-models-key',
        workingProfileId: 'profile-models-working',
        oauthToken: 'secret-models-token',
        model: 'claude-opus-4-7',
      },
    };

    const payload = stripSensitiveSettingsForClient(rawSettings);

    expect((payload.models as any).apiKey).toBeNull();
    expect((payload.models as any).oauthToken).toBeNull();
    expect((payload.models as any).workingProfileId).toBe('profile-models-working');
    expect((payload.models as any).model).toBe('claude-opus-4-7');
    expect(payload).not.toHaveProperty('claude');
  });

  it('preserves models namespace schema version on the wire', () => {
    const rawSettings = {
      modelsNamespaceSchemaVersion: 2,
      models: { apiKey: 'k', workingProfileId: 'p' },
    };

    const payload = stripSensitiveSettingsForClient(rawSettings);

    expect((payload as any).modelsNamespaceSchemaVersion).toBe(2);
  });
});
