/**
 * Mobile structured diagnostics bundle builder.
 *
 * RN-specific ZIP/share plumbing lives here; cross-surface bundle assembly lives
 * in @core/services/diagnostics.
 */

import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import JSZip from 'jszip';
import { useSessionStore } from '@rebel/cloud-client';
import {
  assembleMobileBundle,
} from '@core/services/diagnostics/diagnosticBundleService';
import { formatMobileBundleAsMarkdown } from '@core/services/diagnostics/manifestFormatters';
import type { MobileDiagnosticsBundle, MobileDiagnosticsSourceBundle } from '@core/services/diagnostics/manifest';
import { gatherMobileDiagnostics, type MobileDiagnosticBundle } from './mobileDiagnostics';

export type MobileStructuredDiagnosticBundle = MobileDiagnosticsBundle;

export interface MobileDiagnosticSharePayload {
  zipUri: string | null;
  zipFilename: string | null;
  markdownFallback: string;
  bundle: MobileStructuredDiagnosticBundle | null;
}

function buildMobileCollectors(diagnostics: MobileDiagnosticBundle) {
  return {
    getSessions: () => useSessionStore.getState().sessions,
    getAppVersion: () => Constants.expoConfig?.version ?? diagnostics.deviceInfo.appVersion ?? 'unknown',
    getPlatform: () => diagnostics.deviceInfo.platform ?? Platform.OS,
    getPlatformVersion: () => diagnostics.deviceInfo.platformVersion ?? String(Platform.Version),
    getRuntimeVersion: () => diagnostics.deviceInfo.runtimeVersion ?? String(Constants.expoConfig?.runtimeVersion ?? 'unknown'),
  };
}

export function buildStructuredBundleFromDiagnostics(
  diagnostics: MobileDiagnosticBundle,
  generatedAt?: string,
): MobileStructuredDiagnosticBundle {
  return assembleMobileBundle(diagnostics as MobileDiagnosticsSourceBundle, {
    collectors: buildMobileCollectors(diagnostics),
    generatedAt,
  });
}

export function formatStructuredBundleAsMarkdown(bundle: MobileStructuredDiagnosticBundle): string {
  return formatMobileBundleAsMarkdown(bundle);
}

function formatMinimalReport(reason: string): string {
  return [
    '# Mindstone Rebel Mobile Diagnostics',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    '',
    `_${reason}_`,
  ].join('\n');
}

async function writeZipBundle(bundle: MobileStructuredDiagnosticBundle): Promise<{ zipUri: string; zipFilename: string }> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(bundle.manifest, null, 2));
  zip.file('health.json', JSON.stringify(bundle.health, null, 2));
  zip.file('sessions-index.json', JSON.stringify(bundle.sessionsIndex, null, 2));
  zip.file('logs/main.ndjson', bundle.logs.mainNdjson ?? '');
  if (bundle.queueSnapshot) zip.file('queue-snapshot.json', JSON.stringify(bundle.queueSnapshot, null, 2));
  if (bundle.continuityState) zip.file('continuity-state.json', JSON.stringify(bundle.continuityState, null, 2));
  if (bundle.catchUpHistory) zip.file('catch-up-history.json', JSON.stringify(bundle.catchUpHistory, null, 2));
  if (bundle.recentEvents && bundle.recentEvents.length > 0) {
    // One JSON object per line, oldest-first — same shape mobile's local
    // buffer persists. Bundle consumers can stream-parse without loading
    // the full file.
    const eventsJsonl = bundle.recentEvents.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    zip.file('events.jsonl', eventsJsonl);
  }

  const zipBase64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const baseDir = Paths.cache ?? Paths.document;
  if (!baseDir) throw new Error('No writable cache/document directory available for diagnostics export.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const zipFilename = `mindstone-mobile-diagnostics-${stamp}.zip`;
  const zipFile = new File(baseDir, zipFilename);
  zipFile.write(zipBase64, { encoding: 'base64' });
  return { zipUri: zipFile.uri, zipFilename };
}

export async function prepareMobileDiagnosticSharePayload(): Promise<MobileDiagnosticSharePayload> {
  try {
    const diagnostics = await gatherMobileDiagnostics();
    if (!diagnostics) {
      return {
        zipUri: null,
        zipFilename: null,
        markdownFallback: formatMinimalReport('Diagnostic gathering failed or timed out.'),
        bundle: null,
      };
    }

    const bundle = buildStructuredBundleFromDiagnostics(diagnostics);
    const markdownFallback = formatStructuredBundleAsMarkdown(bundle);
    try {
      const { zipUri, zipFilename } = await writeZipBundle(bundle);
      return { zipUri, zipFilename, markdownFallback, bundle };
    } catch {
      return { zipUri: null, zipFilename: null, markdownFallback, bundle };
    }
  } catch {
    return {
      zipUri: null,
      zipFilename: null,
      markdownFallback: formatMinimalReport('An unexpected error occurred while generating diagnostics.'),
      bundle: null,
    };
  }
}
