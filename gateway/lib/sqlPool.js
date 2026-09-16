'use strict';

const sql = require('mssql');

let _pool = null;

const config = {
    server:   process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '1433', 10),
    database: process.env.DB_DATABASE || 'omnichannel',
    user:     process.env.DB_USERNAME || 'sa',
    password: process.env.DB_PASSWORD || '',
    options: {
        encrypt:                     process.env.DB_ENCRYPT === 'true',
        trustServerCertificate:      process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false',
        enableArithAbort:            true,
    },
    pool: {
        max:              10,
        min:              2,
        idleTimeoutMillis: 30_000,
    },
    connectionTimeout: 15_000,
    requestTimeout:    15_000,
};

/**
 * Singleton connection pool ke SQL Server.
 * Di-lazy-init pada request pertama yang memerlukan DB.
 *
 * @returns {Promise<import('mssql').ConnectionPool>}
 */
async function getSqlPool() {
    if (_pool && _pool.connected) return _pool;

    _pool = await new sql.ConnectionPool(config).connect();
    _pool.on('error', (err) => {
        console.error('SQL Server pool error:', err.message);
        _pool = null;
    });

    return _pool;
}

module.exports = { getSqlPool, sql };
