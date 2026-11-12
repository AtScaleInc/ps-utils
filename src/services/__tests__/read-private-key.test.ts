import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, createPrivateKey } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { SqlService } from "../SqlService.js";

// Test-only passphrase for keys generated on the fly; not a real credential.
const PASS = "test-passphrase";

const read = (file: string, passphrase?: string): string =>
  (new SqlService() as any).readPrivateKeyAsPem(file, passphrase);

describe("SqlService.readPrivateKeyAsPem", () => {
  let dir: string;
  const files: Record<string, string> = {};

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-utils-key-"));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const enc = { cipher: "aes-256-cbc", passphrase: PASS };
    const write = (name: string, data: string | Buffer) => {
      files[name] = path.join(dir, name);
      fs.writeFileSync(files[name], data);
    };
    write("plain.p8", privateKey.export({ type: "pkcs8", format: "pem" }));
    write("plain.der", privateKey.export({ type: "pkcs8", format: "der" }));
    write("rsa.pem", privateKey.export({ type: "pkcs1", format: "pem" }));
    write("enc.p8", privateKey.export({ type: "pkcs8", format: "pem", ...enc }));
    write("enc.der", privateKey.export({ type: "pkcs8", format: "der", ...enc }));
    write("rsa-enc.pem", privateKey.export({ type: "pkcs1", format: "pem", ...enc }));
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const expectUnencryptedPkcs8 = (pem: string) => {
    expect(pem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(() => createPrivateKey(pem)).not.toThrow();
  };

  it("reads unencrypted PKCS#8 PEM, PKCS#8 DER and PKCS#1 PEM keys", () => {
    for (const f of ["plain.p8", "plain.der", "rsa.pem"]) expectUnencryptedPkcs8(read(files[f]));
  });

  it("decrypts encrypted PEM and DER keys with privateKeyPassword", () => {
    for (const f of ["enc.p8", "enc.der", "rsa-enc.pem"]) expectUnencryptedPkcs8(read(files[f], PASS));
  });

  it("ignores a password supplied for an unencrypted key", () => {
    expectUnencryptedPkcs8(read(files["plain.p8"], PASS));
  });

  it("says the key is encrypted when the password is missing, instead of an ASN.1 error", () => {
    for (const f of ["enc.p8", "enc.der", "rsa-enc.pem"]) {
      expect(() => read(files[f])).toThrow(/is encrypted; set privateKeyPassword/);
    }
  });

  it("reports a wrong password without leaking it", () => {
    expect(() => read(files["enc.p8"], "wrong-pass")).toThrow(/Could not read private key/);
    expect(() => read(files["enc.p8"], "wrong-pass")).not.toThrow(/wrong-pass/);
  });
});
