import type { PairingStatus, TokenResult, StageState, ClaimResult } from '../shared/ipc';

export interface ZoiaBridge {
  pairing: {
    status(): Promise<PairingStatus>;
    start(deviceName?: string): Promise<PairingStatus>;
    onChange(cb: (status: PairingStatus) => void): () => void;
  };
  token: {
    get(): Promise<TokenResult>;
  };
  stage: {
    get(): Promise<StageState>;
    claim(): Promise<ClaimResult>;
    release(): Promise<{ ok: boolean; released?: boolean }>;
  };
}

declare global {
  interface Window {
    zoia: ZoiaBridge;
  }
}
