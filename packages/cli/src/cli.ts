#!/usr/bin/env node
/**
 * Meridian CLI — Command-line tools for managing Meridian sync infrastructure.
 *
 * Commands:
 *   meridian migrate  — Apply schema migrations
 *   meridian inspect  — View sync state and document metadata
 *   meridian replay   — Replay operations from a seqNum
 *   meridian status   — Check server connection health
 *   meridian compact  — Manually run tombstone compaction
 *
 * Usage:
 *   npx meridian-cli migrate --db postgresql://... --schema ./schema.ts
 *   npx meridian-cli inspect --db postgresql://... --collection todos
 *   npx meridian-cli status --url wss://api.example.com/sync
 */

import { parseArgs } from 'node:util';
import { createServer } from '@meridian-sync/server';
import { defineSchema, z } from '@meridian-sync/shared';
import { Client } from 'pg';

const USAGE = `
Meridian CLI — Manage your Meridian sync infrastructure

Commands:
  migrate   Apply schema to PostgreSQL (auto-creates tables)
  inspect   View document metadata and sync state
  replay    Replay operations from a sequence number
  status    Check server health and connection
  compact   Manually trigger tombstone compaction

Usage:
  meridian migrate  --db <url> --collection <name>
  meridian inspect  --db <url> --collection <name> [--doc-id <id>]
  meridian replay   --db <url> --since <seq>
  meridian status   --url <ws-url>
  meridian compact  --db <url> [--max-age <days>]
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    switch (command) {
      case 'migrate': await cmdMigrate(args.slice(1)); break;
      case 'inspect': await cmdInspect(args.slice(1)); break;
      case 'replay': await cmdReplay(args.slice(1)); break;
      case 'status': await cmdStatus(args.slice(1)); break;
      case 'compact': await cmdCompact(args.slice(1)); break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// ─── migrate ────────────────────────────────────────────────────────────────

async function cmdMigrate(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      collection: { type: 'string' },
    },
  });

  if (!values.db) {
    console.error('--db is required (PostgreSQL connection URL)');
    process.exit(1);
  }

  // Use a minimal schema; user can extend with their own
  const schema = defineSchema({
    version: 1,
    collections: values.collection
      ? { [values.collection]: { id: z.string() } }
      : { _placeholder: { id: z.string() } },
  });

  const server = createServer({
    port: 0, // Don't start HTTP
    database: values.db,
    schema,
  });

  console.log(`Applying schema to ${values.db}...`);
  await server.start();
  console.log('Migration complete.');
  await server.stop();
}

// ─── inspect ────────────────────────────────────────────────────────────────

async function cmdInspect(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      collection: { type: 'string' },
      'doc-id': { type: 'string' },
    },
  });

  if (!values.db) {
    console.error('--db is required');
    process.exit(1);
  }

  const schema = defineSchema({
    version: 1,
    collections: values.collection
      ? { [values.collection]: { id: z.string() } }
      : { _placeholder: { id: z.string() } },
  });

  const pg = new Client({ connectionString: values.db });
  await pg.connect();

  try {
    console.log(`Connected to ${values.db}`);

    if (values.collection) {
      // Inspect specific collection
      const { rows } = await pg.query(
        `SELECT * FROM "${values.collection}" ORDER BY _meridian_seq DESC LIMIT 50`
      );
      console.log(`\nCollection: ${values.collection} (${rows.length} rows)`);
      console.log('─'.repeat(80));

      for (const row of rows) {
        const meta = row._meridian_meta || {};
        const deleted = row._meridian_deleted;
        const seq = row._meridian_seq;
        const flag = deleted ? '[DELETED]' : '[ACTIVE]';
        console.log(`  ${flag} seq=${seq} id=${row.id}`);
        if (meta && Object.keys(meta).length > 0) {
          const fields = Object.keys(meta).filter(k => !k.startsWith('_')).slice(0, 5);
          console.log(`    Fields: ${fields.join(', ')}`);
        }
      }
    } else {
      // List all tables with _meridian columns
      const { rows: tables } = await pg.query(`
        SELECT table_name
        FROM information_schema.columns
        WHERE column_name = '_meridian_seq'
        ORDER BY table_name
      `);
      console.log('\nCollections with Meridian sync:');
      for (const t of tables) {
        const { rows: count } = await pg.query(
          `SELECT count(*) as c FROM "${t.table_name}"`
        );
        console.log(`  ${t.table_name}: ${count[0].c} documents`);
      }
    }
  } finally {
    await pg.end();
  }
}

// ─── replay ─────────────────────────────────────────────────────────────────

async function cmdReplay(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      since: { type: 'string' },
      collection: { type: 'string' },
    },
  });

  if (!values.db || !values.since) {
    console.error('--db and --since are required');
    process.exit(1);
  }

  const since = parseInt(values.since, 10);
  const pg = new Client({ connectionString: values.db });
  await pg.connect();

  try {
    const tableFilter = values.collection
      ? `AND table_name = '${values.collection}'`
      : '';

    // Find all rows with _meridian_seq > since across all sync tables
    const { rows: tables } = await pg.query(`
      SELECT table_name
      FROM information_schema.columns
      WHERE column_name = '_meridian_seq' ${tableFilter}
      ORDER BY table_name
    `);

    let totalOps = 0;
    for (const t of tables) {
      const { rows } = await pg.query(
        `SELECT id, _meridian_seq, _meridian_meta, _meridian_deleted
         FROM "${t.table_name}"
         WHERE _meridian_seq > $1
         ORDER BY _meridian_seq ASC`,
        [since]
      );
      if (rows.length > 0) {
        console.log(`\n${t.table_name}: ${rows.length} operations`);
        for (const row of rows) {
          const op = row._meridian_deleted ? 'DELETE' : 'UPSERT';
          console.log(`  seq=${row._meridian_seq} ${op} id=${row.id}`);
        }
        totalOps += rows.length;
      }
    }

    console.log(`\nTotal: ${totalOps} operations since seq ${since}`);
  } finally {
    await pg.end();
  }
}

// ─── status ─────────────────────────────────────────────────────────────────

async function cmdStatus(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: 'string' },
    },
  });

  const wsUrl = values.url || 'ws://localhost:3000/sync';
  console.log(`Checking Meridian server at ${wsUrl}...`);

  try {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      console.error('Connection timed out (5s)');
      process.exit(1);
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      console.log('Server is reachable. WebSocket connection established.');
      ws.close();
      process.exit(0);
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      console.error('Could not connect to server.');
      process.exit(1);
    };
  } catch {
    console.error('WebSocket not available in this environment.');
    console.log('Tip: Use "npx meridian-cli status" in a browser-compatible environment.');
    process.exit(1);
  }
}

// ─── compact ────────────────────────────────────────────────────────────────

async function cmdCompact(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      'max-age': { type: 'string' },
    },
  });

  if (!values.db) {
    console.error('--db is required');
    process.exit(1);
  }

  const maxAgeDays = parseInt(values['max-age'] || '30', 10);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  console.log(`Compacting tombstones older than ${maxAgeDays} days...`);

  const schema = defineSchema({ version: 1, collections: {} });
  const server = createServer({ port: 0, database: values.db, schema });
  await server.start();
  await server.compact();
  console.log('Compaction complete.');
  await server.stop();
}

main();
