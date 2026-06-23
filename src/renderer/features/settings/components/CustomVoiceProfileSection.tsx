import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Label } from '@renderer/components/ui';
import type { AppSettings, VoiceProfile } from '@shared/types';
import { SettingRow } from './SettingRow';
import styles from './SettingsSurface.module.css';

interface CustomVoiceProfileSectionProps {
  voiceSettings: AppSettings['voice'];
  sharedOpenAiKey?: string | null;
  updateVoice: <K extends keyof AppSettings['voice']>(key: K, value: AppSettings['voice'][K]) => void;
}

interface EditorFormState {
  name: string;
  sttBaseUrl: string;
  sttModel: string;
  apiKey: string;
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
}

interface EditorState {
  mode: 'create' | 'edit';
  id: string;
  createdAt: number;
  form: EditorFormState;
}

const generateProfileId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
};

const trimToUndefined = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const inferNameFromBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';

  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(normalized).hostname.replace(/^www\./, '');
  } catch {
    return trimmed;
  }
};

const createEmptyEditorState = (): EditorState => ({
  mode: 'create',
  id: generateProfileId(),
  createdAt: Date.now(),
  form: {
    name: '',
    sttBaseUrl: '',
    sttModel: 'whisper-1',
    apiKey: '',
    ttsBaseUrl: '',
    ttsModel: '',
    ttsVoice: '',
  },
});

const toEditorState = (profile: VoiceProfile): EditorState => ({
  mode: 'edit',
  id: profile.id,
  createdAt: profile.createdAt,
  form: {
    name: profile.name,
    sttBaseUrl: profile.sttBaseUrl,
    sttModel: profile.sttModel,
    apiKey: profile.apiKey ?? '',
    ttsBaseUrl: profile.ttsBaseUrl ?? '',
    ttsModel: profile.ttsModel ?? '',
    ttsVoice: profile.ttsVoice ?? '',
  },
});

export const CustomVoiceProfileSection = ({
  voiceSettings,
  sharedOpenAiKey,
  updateVoice,
}: CustomVoiceProfileSectionProps) => {
  const profiles = useMemo(() => voiceSettings.customProfiles ?? [], [voiceSettings.customProfiles]);
  const activeProfileId = voiceSettings.activeCustomProfileId ?? null;
  const [editorState, setEditorState] = useState<EditorState | null>(() =>
    profiles.length === 0 ? createEmptyEditorState() : null
  );
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  const [showTtsFields, setShowTtsFields] = useState(false);

  useEffect(() => {
    if (profiles.length === 0 && !editorState) {
      setEditorState(createEmptyEditorState());
      setShowValidation(false);
      setShowTtsFields(false);
      return;
    }

    if (editorState?.mode === 'edit' && !profiles.some((profile) => profile.id === editorState.id)) {
      setEditorState(profiles.length === 0 ? createEmptyEditorState() : null);
      setShowValidation(false);
      setShowTtsFields(false);
    }
  }, [editorState, profiles]);

  const persistProfiles = useCallback((nextProfiles: VoiceProfile[], nextActiveProfileId: string | null) => {
    updateVoice('customProfiles', nextProfiles);
    updateVoice('activeCustomProfileId', nextActiveProfileId);
  }, [updateVoice]);

  const startCreatingProfile = useCallback(() => {
    setEditorState(createEmptyEditorState());
    setDeleteConfirmId(null);
    setShowValidation(false);
    setShowTtsFields(false);
  }, []);

  const startEditingProfile = useCallback((profile: VoiceProfile) => {
    setEditorState(toEditorState(profile));
    setDeleteConfirmId(null);
    setShowValidation(false);
    setShowTtsFields(false);
  }, []);

  const cancelEditing = useCallback(() => {
    if (profiles.length === 0) {
      setEditorState(createEmptyEditorState());
    } else {
      setEditorState(null);
    }
    setShowValidation(false);
    setShowTtsFields(false);
  }, [profiles.length]);

  const updateEditorField = useCallback((field: keyof EditorFormState, value: string) => {
    setEditorState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        form: {
          ...prev.form,
          [field]: value,
        },
      };
    });
  }, []);

  const activateProfile = useCallback((profileId: string | null) => {
    updateVoice('activeCustomProfileId', profileId);
  }, [updateVoice]);

  const deleteProfile = useCallback((profileId: string) => {
    const nextProfiles = profiles.filter((profile) => profile.id !== profileId);
    const nextActiveProfileId = activeProfileId === profileId
      ? (nextProfiles[0]?.id ?? null)
      : activeProfileId;
    persistProfiles(nextProfiles, nextActiveProfileId);

    setDeleteConfirmId(null);
    if (editorState?.id === profileId) {
      setEditorState(nextProfiles.length === 0 ? createEmptyEditorState() : null);
      setShowValidation(false);
      setShowTtsFields(false);
    }
  }, [activeProfileId, editorState?.id, persistProfiles, profiles]);

  const saveProfile = useCallback(() => {
    if (!editorState) return;

    const sttBaseUrl = editorState.form.sttBaseUrl.trim();
    const sttModel = editorState.form.sttModel.trim();

    if (!sttBaseUrl || !sttModel) {
      setShowValidation(true);
      return;
    }

    const inferredName = inferNameFromBaseUrl(sttBaseUrl);
    const profile: VoiceProfile = {
      id: editorState.id,
      createdAt: editorState.createdAt,
      name: editorState.form.name.trim() || inferredName || 'Custom voice profile',
      sttBaseUrl,
      sttModel,
      apiKey: trimToUndefined(editorState.form.apiKey),
      ttsBaseUrl: trimToUndefined(editorState.form.ttsBaseUrl),
      ttsModel: trimToUndefined(editorState.form.ttsModel),
      ttsVoice: trimToUndefined(editorState.form.ttsVoice),
    };

    if (editorState.mode === 'create') {
      const nextProfiles = [...profiles, profile];
      persistProfiles(nextProfiles, profile.id);
    } else {
      const nextProfiles = profiles.map((existing) => existing.id === profile.id ? profile : existing);
      persistProfiles(nextProfiles, activeProfileId ?? profile.id);
    }

    setEditorState(null);
    setDeleteConfirmId(null);
    setShowValidation(false);
    setShowTtsFields(false);
  }, [activeProfileId, editorState, persistProfiles, profiles]);

  const sttBaseUrlMissing = showValidation && !!editorState && !editorState.form.sttBaseUrl.trim();
  const sttModelMissing = showValidation && !!editorState && !editorState.form.sttModel.trim();

  return (
    <>
      <SettingRow
        label="Active custom profile"
        description="Choose which custom profile Rebel should use for speech input/output."
        htmlFor="active-custom-voice-profile"
      >
        <select
          id="active-custom-voice-profile"
          value={activeProfileId ?? ''}
          onChange={(event) => activateProfile(event.target.value || null)}
          disabled={profiles.length === 0}
        >
          {profiles.length === 0 ? (
            <option value="">No profiles yet</option>
          ) : (
            profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))
          )}
        </select>
      </SettingRow>

      <SettingRow
        label="Custom voice profiles"
        description="Create and manage OpenAI-compatible STT/TTS profiles."
        variant="stacked"
      >
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {profiles.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {profiles.map((profile) => {
                const isActive = profile.id === activeProfileId;
                return (
                  <div
                    key={profile.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '8px',
                      borderRadius: '8px',
                      border: isActive
                        ? '1px solid rgba(99, 102, 241, 0.45)'
                        : '1px solid rgba(148, 163, 184, 0.2)',
                      background: isActive
                        ? 'rgba(99, 102, 241, 0.08)'
                        : 'var(--color-bg-secondary)',
                    }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => activateProfile(profile.id)}
                      style={{
                        flex: 1,
                        justifyContent: 'flex-start',
                        height: 'auto',
                        padding: '6px 8px',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ minWidth: 0, textAlign: 'left' }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          fontSize: '12px',
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {profile.name}
                          </span>
                          {isActive && (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              fontSize: '11px',
                              color: 'var(--color-success, #22c55e)',
                              flexShrink: 0,
                            }}>
                              <Check size={12} />
                              Active
                            </span>
                          )}
                        </div>
                        <div style={{
                          fontSize: '11px',
                          color: 'var(--color-text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {profile.sttBaseUrl}
                        </div>
                      </div>
                    </Button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEditingProfile(profile)}
                        style={{ padding: '6px' }}
                      >
                        <Pencil size={14} />
                      </Button>
                      {deleteConfirmId === profile.id ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteProfile(profile.id)}
                          style={{ color: 'var(--color-destructive)', padding: '6px 8px' }}
                        >
                          Delete?
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmId(profile.id)}
                          style={{ padding: '6px' }}
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {editorState && (
            <div
              style={{
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid rgba(148, 163, 184, 0.2)',
                background: 'var(--color-bg-secondary)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
                <div>
                  <Label htmlFor="custom-profile-name">Name</Label>
                  <Input
                    id="custom-profile-name"
                    type="text"
                    value={editorState.form.name}
                    onChange={(event) => updateEditorField('name', event.target.value)}
                    placeholder="Acme speech gateway"
                  />
                  <p className={styles.modelConfigHint} style={{ paddingLeft: 0, marginTop: '4px' }}>
                    Leave blank to auto-name from the STT hostname.
                  </p>
                </div>

                <div>
                  <Label htmlFor="custom-profile-api-key">API Key</Label>
                  <Input
                    id="custom-profile-api-key"
                    type="password"
                    value={editorState.form.apiKey}
                    onChange={(event) => updateEditorField('apiKey', event.target.value)}
                    placeholder="Optional"
                  />
                  {!editorState.form.apiKey.trim() && (
                    <p className={styles.modelConfigHint} style={{ paddingLeft: 0, marginTop: '4px' }}>
                      Using shared OpenAI key{sharedOpenAiKey?.trim() ? '.' : ' (set one in AI & Models > Providers).'}
                    </p>
                  )}
                </div>

                <div>
                  <Label htmlFor="custom-profile-stt-base-url">STT Base URL</Label>
                  <Input
                    id="custom-profile-stt-base-url"
                    type="text"
                    value={editorState.form.sttBaseUrl}
                    onChange={(event) => updateEditorField('sttBaseUrl', event.target.value)}
                    placeholder="https://api.openai.com"
                    error={sttBaseUrlMissing}
                  />
                </div>

                <div>
                  <Label htmlFor="custom-profile-stt-model">STT Model</Label>
                  <Input
                    id="custom-profile-stt-model"
                    type="text"
                    value={editorState.form.sttModel}
                    onChange={(event) => updateEditorField('sttModel', event.target.value)}
                    placeholder="whisper-1"
                    error={sttModelMissing}
                  />
                </div>
              </div>

              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowTtsFields((prev) => !prev)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    justifyContent: 'flex-start',
                    paddingLeft: 0,
                    paddingRight: 0,
                  }}
                >
                  <ChevronDown
                    size={14}
                    style={{
                      transform: showTtsFields ? 'rotate(0deg)' : 'rotate(-90deg)',
                      transition: 'transform 120ms ease',
                    }}
                  />
                  Optional text-to-speech settings
                </Button>

                {showTtsFields && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                      gap: '10px',
                      marginTop: '8px',
                    }}
                  >
                    <div>
                      <Label htmlFor="custom-profile-tts-base-url">TTS Base URL</Label>
                      <Input
                        id="custom-profile-tts-base-url"
                        type="text"
                        value={editorState.form.ttsBaseUrl}
                        onChange={(event) => updateEditorField('ttsBaseUrl', event.target.value)}
                        placeholder="https://api.openai.com"
                      />
                    </div>
                    <div>
                      <Label htmlFor="custom-profile-tts-model">TTS Model</Label>
                      <Input
                        id="custom-profile-tts-model"
                        type="text"
                        value={editorState.form.ttsModel}
                        onChange={(event) => updateEditorField('ttsModel', event.target.value)}
                        placeholder="tts-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="custom-profile-tts-voice">TTS Voice</Label>
                      <Input
                        id="custom-profile-tts-voice"
                        type="text"
                        value={editorState.form.ttsVoice}
                        onChange={(event) => updateEditorField('ttsVoice', event.target.value)}
                        placeholder="nova"
                      />
                    </div>
                  </div>
                )}
              </div>

              {(sttBaseUrlMissing || sttModelMissing) && (
                <p className={styles.errorMessage} style={{ marginTop: 0 }}>
                  STT Base URL and STT Model are required.
                </p>
              )}

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <Button size="sm" onClick={saveProfile}>
                  {editorState.mode === 'create' ? 'Create profile' : 'Save profile'}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancelEditing}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {!editorState && profiles.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={startCreatingProfile}
              style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Plus size={14} />
              Add profile
            </Button>
          )}
        </div>
      </SettingRow>
    </>
  );
};
