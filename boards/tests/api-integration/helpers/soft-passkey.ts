import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

// TB-31 R-6: a software authenticator for the integration tests. It answers
// like navigator.credentials.create()/get() with an ES256 (P-256) key and
// "none" attestation, for the origin and rpID the tests run on (setup.ts:
// KANEO_CLIENT_URL = http://localhost:5173).

export const ORIGIN = "http://localhost:5173";
const RP_ID = "localhost";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

// Just enough CBOR (RFC 8949) for an attestation object and a COSE key.
function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  const bytes = Buffer.alloc(3);
  bytes[0] = (major << 5) | 25;
  bytes.writeUInt16BE(length, 1);
  return bytes;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value);
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([head(2, value.length), value]);
  }
  const parts = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest();
const b64url = (data: Buffer) => data.toString("base64url");

export class SoftPasskey {
  private readonly rawId = randomBytes(16);
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  counter = 0;

  get credentialId(): string {
    return b64url(this.rawId);
  }

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
  }

  private authenticatorData(flags: number, tail = Buffer.alloc(0)): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([
      sha256(Buffer.from(RP_ID)),
      Buffer.from([flags]),
      count,
      tail,
    ]);
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }),
    );
  }

  /** navigator.credentials.create() → RegistrationResponseJSON. */
  create({ challenge }: { challenge: string }, { uv = true } = {}) {
    const credential = Buffer.concat([
      Buffer.alloc(16), // AAGUID: none
      Buffer.from([0, this.rawId.length]),
      this.rawId,
      this.coseKey(),
    ]);
    const authData = this.authenticatorData(
      FLAG_UP | FLAG_AT | (uv ? FLAG_UV : 0),
      credential,
    );
    const attestation = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", challenge)),
        attestationObject: b64url(attestation),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() → AuthenticationResponseJSON. */
  get(
    { challenge }: { challenge: string },
    { uv = true, counter = this.counter + 1 } = {},
  ) {
    this.counter = counter;
    const authData = this.authenticatorData(FLAG_UP | (uv ? FLAG_UV : 0));
    const clientData = this.clientData("webauthn.get", challenge);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientData)]),
      this.keys.privateKey,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
