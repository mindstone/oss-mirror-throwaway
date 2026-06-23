/**
 * Team avatar utilities for author attribution in What's New.
 * 
 * Since we don't have real team member photos, we use randomized Rebel
 * character avatars. The avatar selection is deterministic based on author
 * name, so the same author always gets the same avatar.
 */

// Import all rebel character avatars
import rebel1 from '@renderer/assets/team-avatars/rebel-1.png';
import rebel2 from '@renderer/assets/team-avatars/rebel-2.png';
import rebel3 from '@renderer/assets/team-avatars/rebel-3.png';
import rebel4 from '@renderer/assets/team-avatars/rebel-4.png';
import rebel5 from '@renderer/assets/team-avatars/rebel-5.png';
import rebel6 from '@renderer/assets/team-avatars/rebel-6.png';
import rebel7 from '@renderer/assets/team-avatars/rebel-7.png';
import rebel8 from '@renderer/assets/team-avatars/rebel-8.png';
import rebel9 from '@renderer/assets/team-avatars/rebel-9.png';
import rebel10 from '@renderer/assets/team-avatars/rebel-10.png';

const REBEL_AVATARS = [
  rebel1, rebel2, rebel3, rebel4, rebel5,
  rebel6, rebel7, rebel8, rebel9, rebel10,
];

/**
 * Simple hash function to convert a string to a number.
 * Used for deterministic avatar selection based on author name.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Get a deterministic avatar URL for an author name.
 * The same author name will always return the same avatar.
 * 
 * @param authorName - The author's name from changelog metadata
 * @returns URL to the avatar image
 */
export function getAuthorAvatar(authorName: string): string {
  const index = hashString(authorName.toLowerCase()) % REBEL_AVATARS.length;
  return REBEL_AVATARS[index];
}
