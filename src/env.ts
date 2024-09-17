import { Static, Type } from '@sinclair/typebox';
import envSchema from 'env-schema';

const schema = Type.Object({
  /**
   * Run mode for this service. Allows you to control how the API runs, typically in an auto-scaled
   * environment. Available values are:
   * * `default`: Runs the ordhook server and the REST API server (this is the default)
   * * `writeonly`: Runs only the ordhook server
   * * `readonly`: Runs only the REST API server
   */
  RUN_MODE: Type.Enum(
    { default: 'default', readonly: 'readonly', writeonly: 'writeonly' },
    { default: 'default' }
  ),

  /** Hostname of the API server */
  API_HOST: Type.String({ default: '0.0.0.0' }),
  /** Port in which to serve the API */
  API_PORT: Type.Number({ default: 3000, minimum: 0, maximum: 65535 }),
  /** Port in which to serve the Admin RPC interface */
  ADMIN_RPC_PORT: Type.Number({ default: 3001, minimum: 0, maximum: 65535 }),
  /** Port in which to receive ordhook events */
  EVENT_PORT: Type.Number({ default: 3099, minimum: 0, maximum: 65535 }),
  /** Event server body limit (bytes) */
  EVENT_SERVER_BODY_LIMIT: Type.Integer({ default: 20971520 }),
  /** Hostname that will be reported to the ordhook node so it can call us back with events */
  EXTERNAL_HOSTNAME: Type.String({ default: '127.0.0.1' }),
  /** Port in which to serve the profiler */
  PROFILER_PORT: Type.Number({ default: 9119 }),

  /** Hostname of the ordhook node we'll use to register predicates */
  ORDHOOK_NODE_RPC_HOST: Type.String({ default: '127.0.0.1' }),
  /** Control port of the ordhook node */
  ORDHOOK_NODE_RPC_PORT: Type.Number({ default: 20456, minimum: 0, maximum: 65535 }),
  /**
   * Authorization token that the ordhook node must send with every event to make sure it's
   * coming from the valid instance. Leave it undefined if you wish to avoid header validation.
   */
  ORDHOOK_NODE_AUTH_TOKEN: Type.Optional(Type.String()),
  /**
   * Register ordhook predicates automatically when the API is first launched. Set this to `false`
   * if you're configuring your predicates manually for any reason.
   */
  ORDHOOK_AUTO_PREDICATE_REGISTRATION: Type.Boolean({ default: true }),
  /**
   * Ordhook ingestion mode. Controls the API's Ordhook payload ingestion behavior:
   * * `default`: The API will stay running and will listen for payloads indefinitely
   * * `replay`: The API will stay running and listening only for payloads marked as "not streaming"
   *   by Ordhook (historical replays). Once Ordhook starts streaming recent blocks from its chain
   *   tip, the API will shut down. Recommended for deployments meant to sync the ordinals chain
   *   from genesis.
   */
  ORDHOOK_INGESTION_MODE: Type.Enum(
    { default: 'default', replay: 'replay' },
    { default: 'default' }
  ),
  /** If the API should automatically shut down when Ordhook ingestion mode is `replay` */
  ORDHOOK_REPLAY_INGESTION_MODE_AUTO_SHUTDOWN: Type.Boolean({ default: true }),

  PGHOST: Type.String(),
  PGPORT: Type.Number({ default: 5432, minimum: 0, maximum: 65535 }),
  PGUSER: Type.String(),
  PGPASSWORD: Type.String(),
  PGDATABASE: Type.String(),
  /** Limit to how many concurrent connections can be created */
  PG_CONNECTION_POOL_MAX: Type.Number({ default: 10 }),
  PG_IDLE_TIMEOUT: Type.Number({ default: 30 }),
  PG_MAX_LIFETIME: Type.Number({ default: 60 }),
  PG_STATEMENT_TIMEOUT: Type.Number({ default: 60_000 }),
});
type Env = Static<typeof schema>;

export const ENV = envSchema<Env>({
  schema: schema,
  dotenv: true,
});
