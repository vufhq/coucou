// The Windows Credential Manager entries the backend keeps, under the same
// service as the app's Rust side (secrets.rs, same keyring entry format).
//
// The app had another name once, and its entries another service. An entry
// found only there is copied over on first read: the worker tokens, which the
// computers hold too, and the GitHub sign-in survive the rename.

const SERVICE = "dev.vufh.hq";
const LEGACY_SERVICE = "fr.louisraille.coucou";

export interface KeyringEntry {
  read(): string | null;
  write(value: string): void;
  delete(): void;
}

export async function keyringEntry(key: string): Promise<KeyringEntry> {
  const { Entry } = await import("@napi-rs/keyring");
  const entry = new Entry(SERVICE, key);
  const legacy = new Entry(LEGACY_SERVICE, key);
  return {
    read() {
      const value = entry.getPassword();
      if (value) return value;
      const old = legacy.getPassword();
      if (!old) return null;
      entry.setPassword(old);
      return old;
    },
    write: (value) => entry.setPassword(value),
    delete() {
      try {
        legacy.deletePassword();
      } catch {
        // Never had one.
      }
      entry.deletePassword();
    },
  };
}
