import type { KeyProtection } from './backup-vault';
import { transferWait } from './transfer-wait';

interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  getSelectedStorageBackend(): string;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
// Fail closed on Linux's hard-coded-password fallback and unrecognized backends.
// The renderer never receives this provider, the wrapped key, or decrypted key bytes.
export function osKeyProtection(
  storage: SecureStorage,
  platform = process.platform,
): KeyProtection {
  const bounded = <T>(operation: () => Promise<T>) =>
    transferWait<T>((cb) => {
      void operation().then(
        (value) => cb(undefined, value),
        (error: Error) => cb(error),
      );
    }, 30000);
  const available = async () => {
    if (platform === 'linux')
      return (
        storage.isEncryptionAvailable() &&
        ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
          storage.getSelectedStorageBackend(),
        )
      );
    return bounded(() => storage.isAsyncEncryptionAvailable());
  };
  return {
    available,
    // Electron 45's asynchronous Linux provider can select a fallback independently
    // of the reported synchronous backend. Use the verified backend on Linux until
    // Electron exposes equivalent provider attestation for its async API.
    wrap: async (value) => {
      if (!(await available())) throw new Error('OS key store is unavailable.');
      return platform === 'linux'
        ? storage.encryptString(value)
        : bounded(() => storage.encryptStringAsync(value));
    },
    unwrap: async (value) => {
      if (!(await available())) throw new Error('OS key store is unavailable.');
      return platform === 'linux'
        ? storage.decryptString(value)
        : (await bounded(() => storage.decryptStringAsync(value))).result;
    },
  };
}
