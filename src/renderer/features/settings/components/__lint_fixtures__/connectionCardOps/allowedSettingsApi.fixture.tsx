export async function allowedConnectionCardSettingsApiMembers(): Promise<void> {
  await window.settingsApi.mcpValidateServer({ serverName: 'Example' });
  await window.settingsApi.get();
  await window.settingsApi.update(await window.settingsApi.get());
}
