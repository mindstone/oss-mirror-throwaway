export async function rawConnectionCardGlobals(): Promise<void> {
  await window.settingsApi.mcpAddBundledServer({ serverName: 'Example' });
  await window.settingsApi.mcpUpsertServer({ name: 'Example', transport: 'stdio' });
  await window.settingsApi.mcpRemoveServer('Example');
  await window.settingsApi.mcpToggleServerEnabled({ serverId: 'Example' });
}
