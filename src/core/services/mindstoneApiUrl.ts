/**
 * Public Mindstone API base URL extracted from authService for the B3 carve-out.
 * B6 removes managed cloud/subscription/dashboard endpoints; this stage only relocates the constant.
 */
export const MINDSTONE_API_URL = process.env.REBEL_API_URL || 'https://rebel.mindstone.com';
