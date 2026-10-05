'use strict';
const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default('info'),

  POSTGRES_HOST: z.string().default('database'),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('comms-stack'),
  JWT_AUDIENCE: z.string().default('comms-dashboard'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).default(900),
  SESSION_MAX_SECONDS: z.coerce.number().int().min(60).default(12 * 3600),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),

  ADMIN_PASSWORD: z.string().min(1),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),

  AMI_HOST: z.string().min(1),
  AMI_PORT: z.coerce.number().int().default(5038),
  AMI_USER: z.string().min(1),
  AMI_PASS: z.string().min(1),

  SERVER_HOSTNAME: z.string().default('communications.local'),
  EXT_1001_PASSWORD: z.string().min(1),
  EXT_1002_PASSWORD: z.string().min(1),
});

function loadConfig(env = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report which variables are wrong, never their values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    db: {
      host: e.POSTGRES_HOST,
      port: e.POSTGRES_PORT,
      database: e.POSTGRES_DB,
      user: e.POSTGRES_USER,
      password: e.POSTGRES_PASSWORD,
    },
    jwt: {
      secret: e.JWT_SECRET,
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
      accessTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      sessionMaxSeconds: e.SESSION_MAX_SECONDS,
    },
    cookieSecure: e.COOKIE_SECURE === 'true',
    adminPassword: e.ADMIN_PASSWORD,
    loginRateLimit: { max: e.LOGIN_RATE_LIMIT_MAX, windowSeconds: e.LOGIN_RATE_LIMIT_WINDOW_SECONDS },
    ami: { host: e.AMI_HOST, port: e.AMI_PORT, username: e.AMI_USER, secret: e.AMI_PASS },
    serverHostname: e.SERVER_HOSTNAME,
    extensionPasswords: { 1001: e.EXT_1001_PASSWORD, 1002: e.EXT_1002_PASSWORD },
  };
}

module.exports = { loadConfig };
