import { defineDynamicResource, defineManifest } from '@crxjs/vite-plugin';
import { sharedManifest } from './manifest.shared';

const dynamicContentScriptResource = defineDynamicResource({
  matches: ['<all_urls>'],
});

export const manifestConfig = {
  ...sharedManifest,
  permissions: [...sharedManifest.permissions],
  optional_host_permissions: [...sharedManifest.optional_host_permissions],
  host_permissions: [...sharedManifest.host_permissions],
  web_accessible_resources: [
    {
      ...dynamicContentScriptResource,
      resources: [...dynamicContentScriptResource.resources, 'assets/*.js'],
    },
  ],
} satisfies Parameters<typeof defineManifest>[0];

const manifest = defineManifest(manifestConfig);

export default manifest;
