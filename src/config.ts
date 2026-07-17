import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  title: string;
  owner: string;
  tls: boolean;
  privateKey?: string;
  certificate?: string;
  password: string;
  turnDurationMs: number;
  reconnectWindowMs: number;
  publishServer: boolean;
  publishEndpoint: string;
  publishAddress: string;
  debug: boolean;
  generation: {
    enabled: boolean;
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

export const DEFAULT_CONFIG: ServerConfig = {
  host: '127.0.0.1',
  port: 3001,
  title: '万世战线 Aeonfront',
  owner: 'SrcMax Studio',
  tls: false,
  password: '',
  turnDurationMs: 45_000,
  reconnectWindowMs: 60_000,
  publishServer: false,
  publishEndpoint: '',
  publishAddress: '',
  debug: false,
  generation: { enabled: false, provider: 'openai', baseUrl: '', apiKey: '', model: '' }
};

export function normalizeConfig(input: Record<string, unknown>): ServerConfig {
  const generation = typeof input.generation === 'object' && input.generation ? input.generation as Record<string, unknown> : {};
  const config: ServerConfig = {
    ...DEFAULT_CONFIG,
    host: typeof input.host === 'string' ? input.host : DEFAULT_CONFIG.host,
    port: typeof input.port === 'number' ? input.port : DEFAULT_CONFIG.port,
    title: typeof input.title === 'string' ? input.title : DEFAULT_CONFIG.title,
    owner: typeof input.owner === 'string' ? input.owner : DEFAULT_CONFIG.owner,
    tls: input.tls === true,
    password: typeof input.password === 'string' ? input.password : '',
    turnDurationMs: typeof input.turnDurationMs === 'number' ? input.turnDurationMs : DEFAULT_CONFIG.turnDurationMs,
    reconnectWindowMs: typeof input.reconnectWindowMs === 'number' ? input.reconnectWindowMs : DEFAULT_CONFIG.reconnectWindowMs,
    publishServer: input.publishServer === true,
    publishEndpoint: typeof input.publishEndpoint === 'string' ? input.publishEndpoint : '',
    publishAddress: typeof input.publishAddress === 'string' ? input.publishAddress : '',
    debug: input.debug === true,
    generation: {
      enabled: generation.enabled === true,
      provider: typeof generation.provider === 'string' ? generation.provider : 'openai',
      baseUrl: typeof generation.baseUrl === 'string' ? generation.baseUrl : '',
      apiKey: typeof generation.apiKey === 'string' ? generation.apiKey : '',
      model: typeof generation.model === 'string' ? generation.model : ''
    }
  };
  if (typeof input.privateKey === 'string') config.privateKey = input.privateKey;
  if (typeof input.certificate === 'string') config.certificate = input.certificate;
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) throw new Error('Invalid server port.');
  if (config.turnDurationMs < 1_000) throw new Error('turnDurationMs must be at least 1000.');
  if (config.tls && (!config.privateKey || !config.certificate)) throw new Error('TLS requires privateKey and certificate paths.');
  return config;
}

export function loadConfig(path = process.env.AEONFRONT_CONFIG ?? resolve('config/server.json')): ServerConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, generation: { ...DEFAULT_CONFIG.generation } };
  return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>);
}
