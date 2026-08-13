import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";

export interface TokenCipher {
  encrypt(plaintext: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
}

export class Aes256GcmTokenCipher implements TokenCipher {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new AppError("CONFIGURATION_ERROR", "Token encryption key must be exactly 32 bytes.", {
        httpStatus: 500,
      });
    }
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  decrypt(ciphertext: string, context: string): string {
    const [version, encodedIv, encodedTag, encodedPayload, ...extra] = ciphertext.split(".");
    if (version !== "v1" || !encodedIv || !encodedTag || !encodedPayload || extra.length > 0) {
      throw new AppError("CONFIGURATION_ERROR", "Stored provider token has an unsupported format.", {
        httpStatus: 500,
      });
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(encodedIv, "base64url"));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedPayload, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      throw new AppError("CONFIGURATION_ERROR", "Stored provider token could not be decrypted.", {
        httpStatus: 500,
        cause: error,
      });
    }
  }
}
