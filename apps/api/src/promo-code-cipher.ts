// Authenticated at-rest encryption for promo code repeat view (admin-only).
// Unlike sk-hbr- API keys (shown once, hash-only storage), an instance admin
// can re-view a promo code: the normalized plaintext is stored AES-256-GCM
// encrypted in promo_codes.code_encrypted.
//
// Key policy (explicit):
//  - key = HKDF-SHA256(serverSecret, salt="hoborouter:promo-code-encryption",
//    info="aes-256-gcm:v1", 32 bytes); serverSecret is the same server-only
//    auth secret (BETTER_AUTH_SECRET / AUTH_SECRET) required >=32 chars in
//    production. No plaintext or hash of the code is ever stored.
//  - Rotation: rotating the auth secret makes every stored code permanently
//    unviewable (decryption fails the GCM tag). Redemption is unaffected —
//    lookup and settlement use only code_hash. Re-view answers 409
//    CODE_UNAVAILABLE, never a 500 and never partial plaintext.
//  - AAD binds each ciphertext to its promo row id, so a ciphertext copied to
//    another row cannot be decrypted there.
//  - No server secret configured (dev/test without one): codes are created
//    with NULL ciphertext and behave like legacy rows — redeemable, never
//    re-viewable.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const HKDF_SALT = "hoborouter:promo-code-encryption";
const HKDF_INFO = "aes-256-gcm:v1";
const IV_LEN = 12;
const TAG_LEN = 16;

const deriveKey = (serverSecret: string): Buffer =>
  Buffer.from(hkdfSync("sha256", serverSecret, HKDF_SALT, HKDF_INFO, 32));

/** AAD: ciphertext is only valid for this exact promo row. */
const aad = (promoId: string): Buffer => Buffer.from(`promo-code-encryption:v1:${promoId}`, "utf8");

/** base64(iv || ciphertext || gcm-tag) of the code, bound to the promo row. */
export const encryptPromoCode = (code: string, serverSecret: string, promoId: string): string => {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(serverSecret), iv, {
    authTagLength: TAG_LEN,
  });
  cipher.setAAD(aad(promoId));
  const ct = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
};

/** Plaintext code, or null on ANY failure (missing/short payload, tag or AAD
 *  mismatch). Callers answer CODE_UNAVAILABLE; failures are never 500s and
 *  never leak partial plaintext. */
export const decryptPromoCode = (
  payload: string,
  serverSecret: string,
  promoId: string,
): string | null => {
  try {
    const raw = Buffer.from(payload, "base64");
    if (raw.length < IV_LEN + TAG_LEN) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(serverSecret),
      raw.subarray(0, IV_LEN),
      { authTagLength: TAG_LEN },
    );
    decipher.setAAD(aad(promoId));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_LEN));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_LEN, raw.length - TAG_LEN)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
};
