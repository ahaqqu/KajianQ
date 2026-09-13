/**
 * Generates a throwaway Ed25519 keypair for bypass-token tests, exported as
 * the base64 encodings the mint/verify helpers consume (`pkcs8` private,
 * `raw` public). Shared by every test that exercises ADR-0041 bypass tokens —
 * the rate package's own contract tests and the API middleware tests.
 */
export const generateEd25519KeypairB64 = async (): Promise<{
  privateKeyPkcs8B64: string;
  publicKeyRawB64: string;
}> => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    privateKeyPkcs8B64: Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString(
      "base64",
    ),
    publicKeyRawB64: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString(
      "base64",
    ),
  };
};
