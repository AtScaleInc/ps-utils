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
import { BooleanParameter, ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";

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
      name = "license-key";
      description =
        "AtScale license key to embed in the values.yaml. " +
        "Written to atscale-entitlement.entitlement.licenseKey. " +
        "If omitted the field is left blank and the key can be uploaded via the UI after install.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "output-file";
      description = "Output file path for the generated values.yaml";
      required = false;
      defaultValue = "values.yaml";
    })(),
    new (class extends BooleanParameter {
      name = "enable-mcp";
      description =
        "Enable the AtScale MCP server sub-chart (atscale-mcp.enabled). " +
        "Accepts true/false, yes/no, 1/0, on/off, or standalone flag. Defaults to false.";
      required = false;
      defaultValue = false;
      isFlag = true;
    })(),
    new (class extends BooleanParameter {
      name = "minimal";
      description =
        "Emit additional Helm values that reduce the hardware footprint: " +
        "disables telemetry, removes the Redis replica, and shrinks default PVC sizes.";
      required = false;
      defaultValue = false;
      isFlag = true;
    })(),
    new (class extends BooleanParameter {
      name = "external-postgres";
      description =
        "Emit Helm values that point AtScale at an externally-managed PostgreSQL instance " +
        "instead of the bundled `db` sub-chart: disables the in-cluster database and wires " +
        "each service's externalDatabase block to Kubernetes secrets. The connection " +
        "credentials (host/port/user/password) are NOT taken as inputs — stubbed secret " +
        "manifests are emitted as a header comment for the operator to fill in and apply. " +
        "Keycloak is pinned to a dedicated `keycloak` Postgres schema (KC_DB_SCHEMA) rather " +
        "than `public`; the operator must create that schema before install (a CREATE SCHEMA " +
        "statement is included in the emitted header comment). " +
        "Verified against AtScale Helm chart 2026.5.0.";
      required = false;
      defaultValue = false;
      isFlag = true;
    })(),
    new (class extends BooleanParameter {
      name = "gatekeeper-compliant";
      description =
        "Emit Helm values that satisfy common OPA Gatekeeper constraints: sets " +
        "image.pullPolicy=Always and serviceAccount.create=true per subchart, and " +
        "resource requests/limits via global.resourcesPreset (poc when combined with " +
        "--minimal, otherwise prod). Some constraints cannot be met via values.yaml " +
        "and require a namespace exemption; these are listed in a comment in the output. " +
        "Verified against AtScale Helm chart 2026.5.0.";
      required = false;
      defaultValue = false;
      isFlag = true;
    })(),
  ];
}

type Params = {
  hostname: string;
  "cert-file"?: string;
  "key-file"?: string;
  "license-key"?: string;
  "output-file": string;
  "enable-mcp": boolean;
  "minimal": boolean;
  "external-postgres": boolean;
  "gatekeeper-compliant": boolean;
};
export type GenerateAtScaleInstallYamlParams = Params;

// ── Values assembly helpers ─────────────────────────────────────────────────────

type AnyObj = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively merge `source` into `target` (mutates and returns `target`). */
function deepMerge(target: AnyObj, source: AnyObj): AnyObj {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      deepMerge(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

// ── External PostgreSQL ─────────────────────────────────────────────────────────

// Names of the Kubernetes secrets the operator creates out-of-band. These are fixed
// references only — no credentials are embedded in values.yaml; each secret holds the
// host/port/user/password/database keys consumed via the existingSecret* indirection.
const EXTERNAL_PG_ATSCALE_SECRET  = "atscale-postgres-external";
const EXTERNAL_PG_KEYCLOAK_SECRET = "keycloak-postgres-external";
const EXTERNAL_PG_PGWIRE_SECRET   = "pgwire-postgres-external";

// Postgres schema Keycloak stores its tables in. AtScale defaults Keycloak to the
// `public` schema; on an externally-managed instance we pin it to a dedicated `keycloak`
// schema instead via KC_DB_SCHEMA (a Quarkus setting the bundled Bitnami chart exposes
// only through extraEnvVars). Keycloak/Liquibase creates its tables but NOT the schema,
// so the operator must `CREATE SCHEMA` it before install — see EXTERNAL_POSTGRES_SECRETS.
const EXTERNAL_PG_KEYCLOAK_SCHEMA = "keycloak";

/**
 * Build the Helm values that point AtScale at an externally-managed PostgreSQL instance.
 * Disables the bundled `db` sub-chart (both `global.atscale.db.enabled` and `db.enabled`)
 * and wires each service's `externalDatabase` block to the Kubernetes secrets listed above.
 * Key names and per-service TLS knobs (`sslEnabled` vs `sslMode`) mirror the AtScale
 * external-PostgreSQL guide, verified against chart 2026.5.0. Keycloak is additionally
 * pinned to a dedicated `keycloak` Postgres schema (KC_DB_SCHEMA) rather than `public`.
 */
function buildExternalPostgresValues(): AnyObj {
  // Common existingSecret* mapping shared by every service (points at the atscale secret).
  const base = {
    existingSecret: EXTERNAL_PG_ATSCALE_SECRET,
    existingSecretHostKey: "host",
    existingSecretPortKey: "port",
    existingSecretUserKey: "user",
    existingSecretPasswordKey: "password",
    existingSecretDatabaseKey: "database",
  };
  return {
    global: { atscale: { db: { enabled: false } } },
    db: { enabled: false },
    "atscale-engine": {
      externalDatabase: { ...base, existingSecretSslEnabledKey: "sslEnabled" },
      externalPgwireDatabase: {
        existingSecret: EXTERNAL_PG_PGWIRE_SECRET,
        existingSecretHostKey: "host",
        existingSecretPortKey: "port",
        existingSecretUserKey: "user",
        existingSecretPasswordKey: "password",
        existingSecretDatabaseKey: "database",
      },
    },
    "atscale-api": {
      externalDatabase: { ...base, existingSecretSslEnabledKey: "sslEnabled" },
    },
    "atscale-entitlement": { externalDatabase: { ...base } },
    "atscale-monitor": {
      externalDatabase: { ...base, existingSecretSslEnabledKey: "sslEnabled" },
    },
    "atscale-mcp": {
      externalDatabase: { ...base, existingSecretSslModeKey: "sslMode" },
    },
    keycloak: {
      externalDatabase: {
        existingSecret: EXTERNAL_PG_KEYCLOAK_SECRET,
        existingSecretHostKey: "host",
        existingSecretPortKey: "port",
        existingSecretUserKey: "user",
        existingSecretPasswordKey: "password",
        existingSecretDatabaseKey: "database",
      },
      // Pin Keycloak to a dedicated schema instead of the default `public`. The bundled
      // Bitnami keycloak chart has no schema knob, so this rides through as a raw Quarkus
      // env var. The schema must already exist in the external database (see the secret
      // manifests header comment) — Keycloak creates its tables but not the schema itself.
      extraEnvVars: [{ name: "KC_DB_SCHEMA", value: EXTERNAL_PG_KEYCLOAK_SCHEMA }],
    },
  };
}

/**
 * Stubbed Kubernetes Secret manifests emitted as a header comment when --external-postgres
 * is set. Host/port/user/password are intentionally left as placeholders — the operator
 * fills them in and applies the manifests before (or after) installing AtScale. The three
 * secrets match the databases the external-PostgreSQL guide requires: keycloak, atscale,
 * and pgwire (metadata). If the external database uses TLS, also set
 * global.atscale.tls.caCerts to the PEM chain.
 */
const EXTERNAL_POSTGRES_SECRETS = [
  "--external-postgres: AtScale is wired to an externally-managed PostgreSQL instance.",
  "The bundled `db` sub-chart is disabled; each service reads its connection from a",
  "Kubernetes secret. Credentials are NOT embedded here — fill in the placeholders in the",
  "manifests below and `kubectl apply` them into the AtScale namespace before installing:",
  "",
  "  apiVersion: v1",
  "  kind: Secret",
  "  metadata:",
  `    name: ${EXTERNAL_PG_KEYCLOAK_SECRET}`,
  "    namespace: atscale",
  "  type: Opaque",
  "  stringData:",
  "    host: <YOUR_HOST_HERE>",
  "    port: \"<YOUR_DB_PORT_HERE>\"",
  "    user: keycloak",
  "    password: \"<YOUR_PASSWORD_HERE>\"",
  "    database: keycloak",
  "",
  `  Keycloak is pinned to the '${EXTERNAL_PG_KEYCLOAK_SCHEMA}' schema (KC_DB_SCHEMA), not 'public'.`,
  "  Keycloak creates its tables but NOT the schema, so create it in the keycloak database",
  "  before installing (connected as a superuser or the database owner):",
  `    CREATE SCHEMA IF NOT EXISTS ${EXTERNAL_PG_KEYCLOAK_SCHEMA} AUTHORIZATION keycloak;`,
  "  ---",
  "  apiVersion: v1",
  "  kind: Secret",
  "  metadata:",
  `    name: ${EXTERNAL_PG_ATSCALE_SECRET}`,
  "    namespace: atscale",
  "  type: Opaque",
  "  stringData:",
  "    host: <YOUR_HOST_HERE>",
  "    port: \"<YOUR_DB_PORT_HERE>\"",
  "    user: atscale",
  "    password: \"<YOUR_PASSWORD_HERE>\"",
  "    database: atscale",
  "    sslEnabled: \"false\"",
  "    sslMode: \"disable\"",
  "  ---",
  "  apiVersion: v1",
  "  kind: Secret",
  "  metadata:",
  `    name: ${EXTERNAL_PG_PGWIRE_SECRET}`,
  "    namespace: atscale",
  "  type: Opaque",
  "  stringData:",
  "    host: <YOUR_HOST_HERE>",
  "    port: \"<YOUR_DB_PORT_HERE>\"",
  "    user: atscale_metadata",
  "    password: \"<YOUR_PASSWORD_HERE>\"",
  "    database: pgwire",
  "",
  "If the external database requires TLS, also set global.atscale.tls.caCerts to the",
  "base64-encoded PEM CA chain. Verified against AtScale Helm chart 2026.5.0.",
];

/**
 * Build the subset of Helm values that satisfy common OPA Gatekeeper constraints,
 * verified by rendering AtScale Helm chart 2026.5.0. Sets image.pullPolicy=Always
 * and serviceAccount.create=true per subchart (where the chart exposes the knob),
 * and resource requests/limits — the bulk via global.resourcesPreset, with explicit
 * overrides for subcharts whose partial default `resources` would otherwise defeat
 * the preset (atscale-proxy, redis) and for init containers not covered by it.
 */
function buildGatekeeperValues(preset: "poc" | "prod"): AnyObj {
  const initTelemetry = {
    resources: {
      requests: { cpu: "100m", memory: "100Mi" },
      limits: { cpu: "200m", memory: "200Mi" },
    },
  };
  return {
    global: { resourcesPreset: preset },
    "atscale-entitlement": {
      image: { pullPolicy: "Always" },
      defaultInitContainers: { telemetry: initTelemetry },
    },
    "atscale-engine": {
      image: { pullPolicy: "Always" },
      certImage: {
        pullPolicy: "Always",
        resources: {
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "200m", memory: "256Mi" },
        },
      },
      defaultInitContainers: {
        engineInit: {
          resources: {
            requests: { cpu: "500m", memory: "1000Mi" },
            limits: { cpu: "1000m", memory: "2000Mi" },
          },
        },
        telemetry: initTelemetry,
      },
    },
    "atscale-sml": { image: { pullPolicy: "Always" } },
    "atscale-api": {
      image: { pullPolicy: "Always" },
      defaultInitContainers: { telemetry: initTelemetry },
    },
    "atscale-mcp": {
      image: { pullPolicy: "Always" },
      serviceAccount: { create: true },
    },
    "atscale-proxy": {
      image: { pullPolicy: "Always" },
      serviceAccount: { create: true },
      // Chart ships a partial `resources` (requests.memory only) that overrides the
      // preset, so set a full request/limit pair here to satisfy the limits check.
      resources: {
        requests: { cpu: "200m", memory: "512Mi" },
        limits: { cpu: "500m", memory: "768Mi" },
      },
    },
    "atscale-monitor": {
      image: { pullPolicy: "Always" },
      serviceAccount: { create: true },
    },
    db: {
      image: { pullPolicy: "Always" },
      serviceAccount: { create: true },
      defaultInitContainers: {
        volumePermissions: {
          image: { pullPolicy: "Always" },
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "200m", memory: "256Mi" },
          },
        },
      },
    },
    "in-mem-aggs": {
      image: { pullPolicy: "Always" },
      serviceAccount: { create: true },
    },
    redis: {
      image: { pullPolicy: "Always" },
      serviceAccount: { create: true },
      master: {
        serviceAccount: { create: true },
        resources: {
          requests: { cpu: "100m", memory: "256Mi" },
          limits: { cpu: "250m", memory: "384Mi" },
        },
      },
      replica: {
        serviceAccount: { create: true },
        resources: {
          requests: { cpu: "100m", memory: "256Mi" },
          limits: { cpu: "250m", memory: "384Mi" },
        },
      },
    },
    keycloak: {
      image: { pullPolicy: "Always" },
      serviceAccount: { create: true },
    },
    telemetry: {
      image: { pullPolicy: "Always" },
      serviceAccount: { create: true },
    },
  };
}

/**
 * OPA Gatekeeper constraints that AtScale Helm chart 2026.5.0 cannot satisfy through
 * values.yaml alone. Emitted as a header comment when --gatekeeper-compliant is set so
 * the operator knows which items still need a namespace exemption under deny enforcement.
 */
const GATEKEEPER_RESIDUALS = [
  "--gatekeeper-compliant: image.pullPolicy=Always, serviceAccount.create=true, and",
  "resource requests/limits are set across subcharts to satisfy OPA Gatekeeper.",
  "",
  "The following constraints CANNOT be met via values.yaml (chart limitations). Grant a",
  "namespace exemption for the AtScale namespace if enforcement is set to deny:",
  "  * deny-service-account-default — atscale-api, atscale-engine, atscale-entitlement,",
  "    and atscale-sml never set serviceAccountName, so their pods use the default SA.",
  "  * container-must-have-limits-requests — the injected 'otel-logs-collector' telemetry",
  "    sidecar has no settable resources (blocked by the chart's values.schema.json).",
  "  * disallow-environment-secrets — AtScale wires secrets as env vars by design.",
  "",
  "Verified against AtScale Helm chart 2026.5.0.",
];

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

    // ── Assemble values ───────────────────────────────────────────────────
    // Built as a single object (rather than concatenated template fragments) so that
    // overlapping keys across modes merge correctly. Emitting a top-level key more than
    // once produces a duplicate-key document where Helm keeps only the last occurrence.
    const licenseKey = params["license-key"] ?? "";
    const enableMcp = params["enable-mcp"];
    const minimal = params["minimal"];
    const externalPostgres = params["external-postgres"];
    const gatekeeperCompliant = params["gatekeeper-compliant"];

    const values: AnyObj = {
      global: {
        ingressDomain: hostname,
        atscale: { tls: { tlsCrt, tlsKey } },
      },
      "atscale-mcp": { enabled: enableMcp },
    };

    if (licenseKey) {
      deepMerge(values, { "atscale-entitlement": { entitlement: { licenseKey } } });
    }

    if (minimal) {
      // Minimal footprint — disables telemetry, removes the Redis replica, shrinks PVCs.
      deepMerge(values, {
        global: { atscale: { telemetry: { enabled: false, persistence: { size: "10Gi" } } } },
        redis: { replica: { replicaCount: 0 }, master: { persistence: { size: "8Gi" } } },
        db: { persistence: { size: "20Gi" } },
        keycloak: { replicaCount: 1, autoscaling: { enabled: false } },
      });
    }

    if (externalPostgres) {
      // Point AtScale at an externally-managed PostgreSQL instance; disable the bundled db.
      deepMerge(values, buildExternalPostgresValues());
    }

    if (gatekeeperCompliant) {
      // Use the lighter preset when the operator has also asked for a minimal footprint.
      deepMerge(values, buildGatekeeperValues(minimal ? "poc" : "prod"));
    }

    // ── Serialize ─────────────────────────────────────────────────────────
    // lineWidth: 0 prevents the long base64 TLS strings from being folded across lines.
    const toComment = (lines: string[]) =>
      lines.map((l) => (l ? `# ${l}` : "#")).join("\n") + "\n\n";
    const headerBlocks: string[] = [];
    if (externalPostgres) headerBlocks.push(toComment(EXTERNAL_POSTGRES_SECRETS));
    if (gatekeeperCompliant) headerBlocks.push(toComment(GATEKEEPER_RESIDUALS));
    const output = headerBlocks.join("") + stringify(values, { lineWidth: 0 });

    // ── Write output ──────────────────────────────────────────────────────
    const outputPath = path.resolve(params["output-file"]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output, "utf8");
    this.logger.info(`Written → ${outputPath}`);
  }
}
