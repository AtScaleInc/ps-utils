/**
 * generate-atscale-install-yaml
 *
 * Generates a Helm values.yaml for an AtScale Kubernetes deployment.
 * If no TLS certificate is supplied, a self-signed certificate is generated
 * for the provided hostname using only Node's built-in crypto module.
 *
 * The tlsCrt and tlsKey fields in values.yaml are base64-encoded PEM strings
 * (i.e. the PEM content itself is base64-encoded a second time, as required
 * by the AtScale Helm chart).
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import crypto from "node:crypto";
import ejs from "ejs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Parameter set ──────────────────────────────────────────────────────────────

class GenerateAtScaleInstallYamlParameterSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "hostname";
      description =
        "Fully-qualified domain name (or IP) used as the AtScale ingress domain " +
        "and as the certificate Common Name / SAN when generating a self-signed cert";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "cert-file";
      description =
        "Path to an existing PEM-encoded TLS certificate file. " +
        "If omitted a self-signed certificate is generated automatically.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "key-file";
      description =
        "Path to an existing PEM-encoded private key file. " +
        "Required when --cert-file is provided.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "output-file";
      description = "Output file path for the generated values.yaml";
      required = false;
      defaultValue = "values.yaml";
    })(),
  ];
}

type Params = {
  hostname: string;
  "cert-file"?: string;
  "key-file"?: string;
  "output-file": string;
};

// ── DER / ASN.1 helpers ────────────────────────────────────────────────────────

/** Encode a DER length in definite form. */
function encLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n <= 0xff) return Buffer.from([0x81, n]);
  if (n <= 0xffff) return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
  throw new Error("ASN.1 length too large");
}

/** Wrap one or more buffers with a DER tag. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), encLen(content.length), content]);
}

const SEQ  = (...p: Buffer[]) => der(0x30, ...p);
const SET_ = (...p: Buffer[]) => der(0x31, ...p);
const INT  = (b: Buffer)      => der(0x02, b);
const OID  = (b: number[])    => der(0x06, Buffer.from(b));
const UTF8 = (s: string)      => der(0x0c, Buffer.from(s, "utf8"));
const OCT  = (b: Buffer)      => der(0x04, b);
const BITS = (b: Buffer)      => der(0x03, Buffer.concat([Buffer.from([0x00]), b]));
const CTX  = (n: number, ...p: Buffer[]) => der(0xa0 | n, ...p); // explicit context-specific

/** DER UTCTime (YYMMDDHHMMSSZ). */
function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0");
  const s =
    String(d.getUTCFullYear()).slice(-2) +
    p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
  return der(0x17, Buffer.from(s, "ascii"));
}

// ── Certificate generation ─────────────────────────────────────────────────────

/**
 * Generate a minimal self-signed RSA-2048 / SHA-256 X.509 v3 certificate.
 * Returns PEM-encoded cert and private key strings.
 */
function generateSelfSignedCert(hostname: string): { certPem: string; keyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding:  { type: "spki",  format: "der" } as const,
    privateKeyEncoding: { type: "pkcs8", format: "pem" } as const,
  });

  // Well-known OIDs
  const OID_SHA256_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
  const OID_CN         = [0x55, 0x04, 0x03];
  const OID_SAN        = [0x55, 0x1d, 0x11]; // subjectAltName

  const sigAlg = SEQ(OID(OID_SHA256_RSA), der(0x05)); // AlgorithmIdentifier + NULL

  const now    = new Date();
  const expiry = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  // Issuer / Subject: RDN { CN=hostname }
  const name = SEQ(SET_(SEQ(OID(OID_CN), UTF8(hostname))));

  // SubjectAltName extension: SEQUENCE { [2] dNSName }
  const sanValue = OCT(SEQ(der(0x82, Buffer.from(hostname, "ascii"))));
  const extensions = CTX(3, SEQ(SEQ(OID(OID_SAN), sanValue)));

  const tbs = SEQ(
    CTX(0, INT(Buffer.from([0x02]))),           // version: v3
    INT(Buffer.from([0x01])),                    // serialNumber: 1
    sigAlg,                                      // signature algorithm
    name,                                        // issuer
    SEQ(utcTime(now), utcTime(expiry)),          // validity
    name,                                        // subject
    publicKey as unknown as Buffer,              // subjectPublicKeyInfo (SPKI DER)
    extensions,
  );

  // Sign the TBSCertificate
  const signer = crypto.createSign("SHA256");
  signer.update(tbs);
  const signature = signer.sign(privateKey);

  // Assemble final Certificate DER
  const certDer = SEQ(tbs, sigAlg, BITS(signature));
  const certB64 = certDer.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  const certPem = `-----BEGIN CERTIFICATE-----\n${certB64}\n-----END CERTIFICATE-----\n`;

  return { certPem, keyPem: privateKey };
}

// ── Operation ──────────────────────────────────────────────────────────────────

export class GenerateAtScaleInstallYamlOperation extends Operation<Params> {
  name = "generate-atscale-install-yaml";
  description =
    "Generate a Helm values.yaml for an AtScale Kubernetes deployment, " +
    "optionally creating a self-signed TLS certificate for the provided hostname";
  parameters = new GenerateAtScaleInstallYamlParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const { hostname } = params;

    // ── Resolve TLS cert and key ───────────────────────────────────────────
    let certPem: string;
    let keyPem: string;

    if (params["cert-file"]) {
      if (!params["key-file"]) {
        throw new Error("--key-file is required when --cert-file is provided");
      }
      certPem = fs.readFileSync(path.resolve(params["cert-file"]), "utf8");
      keyPem  = fs.readFileSync(path.resolve(params["key-file"]),  "utf8");
      this.logger.info(`Using certificate from ${params["cert-file"]}`);
    } else {
      this.logger.info(`Generating self-signed certificate for ${hostname}…`);
      ({ certPem, keyPem } = generateSelfSignedCert(hostname));
      this.logger.info("Self-signed certificate generated.");
    }

    // The Helm chart expects the PEM content base64-encoded a second time
    const tlsCrt = Buffer.from(certPem).toString("base64");
    const tlsKey = Buffer.from(keyPem).toString("base64");

    // ── Render template ───────────────────────────────────────────────────
    const templatePath = path.join(__dirname, "values.yaml.ejs");
    const template = fs.readFileSync(templatePath, "utf8");
    const output = ejs.render(template, { hostname, tlsCrt, tlsKey });

    // ── Write output ──────────────────────────────────────────────────────
    const outputPath = path.resolve(params["output-file"]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output, "utf8");
    this.logger.info(`Written → ${outputPath}`);
  }
}
