import 'dotenv/config';
import { createServer, defineSchema, z } from '@meridian-sync/server';

// ─── Schema Definition ───────────────────────────────────────────────────────
// Must match the client exactly

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      id: z.string(),
      title: z.string(),
      done: z.boolean().default(false),
      createdAt: z.number(),
    },
  },
});

// ─── Environment & Config ────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/meridian_demo';

// ─── Server Initialization ───────────────────────────────────────────────────

async function bootstrap() {
  console.log('🔄 Bootstrapping Meridian Server...');

  const server = createServer({
    port: PORT,
    database: DB_URL,
    schema,
    debug: true,
    
    // Fake auth for demo — accepts any token, returns a fake userId
    auth: async (token) => {
      console.log(`🔐 Authenticating token: ${token}`);
      return {
        userId: `user_${Math.random().toString(36).slice(2, 6)}`,
        // namespace: 'demo_tenant_1' // You could use this for multi-tenancy
      };
    },

    compaction: {
      interval: 60 * 1000, // For demo, run compaction every minute
      tombstoneMaxAge: 2 * 60 * 1000, // Delete tombstones older than 2 minutes
    }
  });

  await server.start();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await server.stop();
    process.exit(0);
  });
}

bootstrap().catch(console.error);
