// Types for `bitwarden-account.mjs`, so the client's tests can import the stand-in account.

export interface StandInLogin {
  id?: string;
  name: string;
  username?: string | null;
  password?: string | null;
  ownKey?: boolean;
  deleted?: boolean;
  viewPassword?: boolean;
}

export interface StandInAccount {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sync: Record<string, any>;
  orgKey: Uint8Array;
  orgId: string;
}

export function b64(bytes: Uint8Array): string;
export function sealType2(plain: string | Uint8Array, key64: Uint8Array): Promise<string>;
export function masterKey(password: string, email: string, iterations: number): Promise<Uint8Array>;
export function makeAccount(o: {
  email: string;
  password: string;
  iterations?: number;
  role?: number;
  collections?: { id?: string; name: string; logins: StandInLogin[] }[];
  personal?: StandInLogin[];
}): Promise<StandInAccount>;
