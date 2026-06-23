#!/usr/bin/env npx tsx
/**
 * IPC Contract Validator
 *
 * Validates the IPC contract definitions.
 *
 * Usage:
 *   npx tsx scripts/validate-ipc.ts
 *   npm run validate:ipc
 *
 * Checks:
 * 1. All Zod schemas in the contract parse correctly
 * 2. No duplicate channel names within or across domains
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function loadContract() {
  const contractPath = path.join(ROOT, 'src/shared/ipc/contracts.ts');
  return await import(contractPath) as { ipcContract: Record<string, Record<string, { channel: string; request: unknown; response: unknown }>> };
}

function getChannelNames(channels: Record<string, { channel: string }>): string[] {
  return Object.values(channels).map(c => c.channel);
}

async function main() {
  console.log('🔍 IPC Contract Validator');
  console.log('=========================\n');

  let hasErrors = false;

  // Load the contract
  console.log('📖 Loading IPC contract...');
  let contract;
  try {
    contract = await loadContract();
    console.log('   ✅ Contract loaded successfully\n');
  } catch (error) {
    console.error('   ❌ Failed to load contract:', error);
    process.exit(1);
  }

  const { ipcContract } = contract;

  // Validate schemas
  console.log('📋 Validating Zod schemas...');
  const domains = Object.entries(ipcContract);

  for (const [domainName, domainChannels] of domains) {
    const channelEntries = Object.entries(domainChannels);
    for (const [key, channelDef] of channelEntries) {
      if (!channelDef.request || !channelDef.response) {
        console.error(`   ❌ ${domainName}.${key}: Missing request or response schema`);
        hasErrors = true;
      }
    }
  }
  if (!hasErrors) {
    console.log('   ✅ All schemas valid\n');
  }

  // Check for duplicate channels
  console.log('🔎 Checking for duplicate channels...');
  const allChannelNames: string[] = [];
  const duplicates: string[] = [];

  for (const [, domainChannels] of domains) {
    const names = getChannelNames(domainChannels as Record<string, { channel: string }>);
    for (const name of names) {
      if (allChannelNames.includes(name)) {
        duplicates.push(name);
        hasErrors = true;
      }
      allChannelNames.push(name);
    }
  }

  if (duplicates.length > 0) {
    console.error(`   ❌ Duplicate channels found: ${duplicates.join(', ')}`);
  } else {
    console.log('   ✅ No duplicate channels\n');
  }

  console.log('');

  if (hasErrors) {
    console.error('❌ Validation failed with errors\n');
    process.exit(1);
  } else {
    console.log('✅ Validation passed\n');
  }
}

main().catch((error) => {
  console.error('❌ Validator failed:', error);
  process.exit(1);
});
