import { basename, normalize } from 'pathe';
import { createId as sharedCreateId } from '@shared/utils/id';

/**
 * String manipulation utility functions
 */

/**
 * Normalize path: converts backslashes to forward slashes, collapses
 * multiple slashes, and resolves . and .. segments.
 */
export const normalizePath = (value: string): string => {
  if (!value) return '';
  return normalize(value);
};

/**
 * Extract filename from a path string
 */
export const getFileName = (value: string): string => {
  if (!value) return '';
  return basename(value);
};

/**
 * Generate a unique ID using crypto.randomUUID or fallback to random string
 */
export const createId = (): string => sharedCreateId();

/**
 * Try to parse and format text as JSON
 * Returns formatted JSON if valid, otherwise returns original text
 */
export const tryFormatJSON = (text: string): { isJSON: boolean; formatted: string } => {
  try {
    const parsed = JSON.parse(text);
    return {
      isJSON: true,
      formatted: JSON.stringify(parsed, null, 2)
    };
  } catch {
    return {
      isJSON: false,
      formatted: text
    };
  }
};
