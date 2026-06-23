import fs from 'node:fs';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';

export async function persistCredential(tokenPath: string, payload: string): Promise<void> {
  await atomicCredentialWrite(tokenPath, payload, { mode: 0o600 });
  fs.readFileSync(tokenPath, 'utf8');
}
