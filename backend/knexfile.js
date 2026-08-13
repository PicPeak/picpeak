require('dotenv').config();

// Database configuration for different environments
// Shared with the engine guard (#1038) so both resolve the identical path.
const { resolveSqliteFilename } = require('./src/utils/sqlitePath');
// One resolution of the PostgreSQL target for the whole application (#1038).
// The development and production blocks used to carry different host/user/
// database defaults, so a process that probed or migrated against one could
// hand over to a process that opened another.
const { pgConnectionFromEnv } = require('./src/utils/pgConnection');

const sqliteConnection = (filenameEnv) => ({
  filename: resolveSqliteFilename(filenameEnv)
});

const baseSqliteConfig = {
  client: 'sqlite3',
  connection: sqliteConnection(),
  useNullAsDefault: true,
  migrations: {
    directory: './migrations'
  },
  seeds: {
    directory: './seeds'
  }
};

const config = {
  development: {
    client: process.env.DATABASE_CLIENT || 'sqlite3',
    connection: process.env.DATABASE_CLIENT === 'pg' ? pgConnectionFromEnv() : {
      filename: resolveSqliteFilename(process.env.DATABASE_PATH || './data/photo_sharing.db')
    },
    useNullAsDefault: process.env.DATABASE_CLIENT !== 'pg',
    migrations: {
      directory: './migrations'
    },
    seeds: {
      directory: './seeds'
    }
  },

  test: (() => {
    const client = process.env.DATABASE_CLIENT || 'sqlite3';
    const isPostgres = client === 'pg';

    return {
      ...baseSqliteConfig,
      client,
      useNullAsDefault: !isPostgres,
      connection: isPostgres
        ? {
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 5432,
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || 'postgres',
            database: process.env.DB_NAME || 'photo_sharing_test'
          }
        : sqliteConnection(process.env.TEST_DATABASE_PATH || './data/photo_sharing_test.db')
    };
  })(),

  production: {
    client: process.env.DATABASE_CLIENT || 'pg',
    // Support both Postgres and SQLite in production based on DATABASE_CLIENT
    connection: (process.env.DATABASE_CLIENT || 'pg') === 'pg'
      ? {
          ...pgConnectionFromEnv(),
          // Connection stability settings
          connectionTimeoutMillis: 30000,
          idleTimeoutMillis: 30000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 0
        }
      : {
          filename: resolveSqliteFilename(process.env.DATABASE_PATH || './data/photo_sharing.db')
        },
    useNullAsDefault: (process.env.DATABASE_CLIENT || 'pg') !== 'pg',
    pool: (process.env.DATABASE_CLIENT || 'pg') === 'pg'
      ? {
          min: 5,
          max: 25,
          acquireTimeoutMillis: 60000,
          createTimeoutMillis: 60000,
          idleTimeoutMillis: 30000,
          reapIntervalMillis: 1000,
          createRetryIntervalMillis: 200,
          propagateCreateError: false
        }
      : undefined,
    migrations: {
      directory: './migrations'
    },
    acquireConnectionTimeout: 60000
  }
};
const env = process.env.NODE_ENV || 'development';

module.exports = config[env] || config.development;
