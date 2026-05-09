import { createClient, defineSchema, z, type ConnectionState, type PendingOp } from '@meridian-sync/client';

// ─── Schema Definition ───────────────────────────────────────────────────────

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

// ─── Client Initialization ───────────────────────────────────────────────────

const serverUrl = 'ws://localhost:3000/sync';

// Setup fake auth token for demo
const fakeAuthToken = `demo-token-${Math.random().toString(36).slice(2, 6)}`;

const db = createClient({
  schema,
  serverUrl,
  auth: {
    getToken: async () => fakeAuthToken,
  },
  debug: true,
  onConnectionChange: updateConnectionStatus,
  onRollback: (op: PendingOp, reason: string) => {
    alert(`Change rejected: ${reason}`);
  }
});

// ─── UI Elements ─────────────────────────────────────────────────────────────

const todoForm = document.getElementById('todo-form') as HTMLFormElement;
const todoInput = document.getElementById('todo-input') as HTMLInputElement;
const todoList = document.getElementById('todo-list') as HTMLUListElement;
const statusBadge = document.getElementById('conn-status') as HTMLDivElement;
const queueList = document.getElementById('queue-list') as HTMLUListElement;
const queueCount = document.getElementById('queue-count') as HTMLSpanElement;
const presenceList = document.getElementById('presence-list') as HTMLUListElement;
const peerCount = document.getElementById('peer-count') as HTMLSpanElement;
const cursorsContainer = document.getElementById('cursors-container') as HTMLDivElement;

// ─── App Logic ───────────────────────────────────────────────────────────────

// 1. Reactive Query for Todos
db.todos.find().subscribe((todos) => {
  // Sort by createdAt desc
  const sorted = [...todos].sort((a, b) => (b.createdAt as number) - (a.createdAt as number));
  renderTodos(sorted);
});

// 2. Add Todo
todoForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = todoInput.value.trim();
  if (!title) return;

  await db.todos.put({
    id: crypto.randomUUID(),
    title,
    done: false,
    createdAt: Date.now(),
  });

  todoInput.value = '';
});

// 3. Toggle/Delete Todo (Event Delegation)
todoList.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const item = target.closest('.todo-item') as HTMLElement;
  if (!item) return;

  const id = item.dataset.id!;

  if (target.classList.contains('checkbox')) {
    const isDone = item.classList.contains('done');
    await db.todos.update(id, { done: !isDone });
  }

  if (target.classList.contains('delete-btn')) {
    await db.todos.delete(id);
  }
});

// 4. Debug Queue Monitoring
setInterval(async () => {
  const pending = await db.debug.getPendingOps();
  queueCount.textContent = pending.length.toString();
  
  queueList.innerHTML = pending.map(op => `
    <li class="debug-item">
      [${op.status}] ${op.op.field}
    </li>
  `).join('');
}, 1000);

// 5. Presence (Cursors)
const myColor = ['#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'][Math.floor(Math.random() * 5)];
const myName = 'User ' + Math.floor(Math.random() * 1000);

document.addEventListener('mousemove', (e) => {
  db.presence.set({
    x: e.clientX,
    y: e.clientY,
    color: myColor,
    name: myName
  });
});

db.presence.subscribe((peers) => {
  const peerIds = Object.keys(peers);
  peerCount.textContent = peerIds.length.toString();

  // Render debug list
  presenceList.innerHTML = peerIds.map(id => {
    const p = peers[id] as any;
    return `<li class="debug-item" style="border-color: ${p.color}">${p.name}</li>`;
  }).join('');

  // Render cursors
  cursorsContainer.innerHTML = peerIds.map(id => {
    const p = peers[id] as any;
    if (!p.x || !p.y) return '';
    return `
      <div class="cursor" style="transform: translate(${p.x}px, ${p.y}px)">
        <svg class="cursor-arrow" fill="${p.color}" viewBox="0 0 24 24">
          <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L5.5 3.21z"/>
        </svg>
        <div class="cursor-name" style="background: ${p.color}">${p.name}</div>
      </div>
    `;
  }).join('');
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderTodos(todos: any[]) {
  todoList.innerHTML = todos.map(todo => `
    <li class="todo-item ${todo.done ? 'done' : ''}" data-id="${todo.id}">
      <div class="checkbox"></div>
      <span class="todo-text">${escapeHtml(todo.title)}</span>
      <button class="delete-btn">✕</button>
    </li>
  `).join('');
}

function updateConnectionStatus(state: ConnectionState) {
  const dot = statusBadge.querySelector('.status-dot')!;
  const text = statusBadge.querySelector('.status-text')!;
  
  dot.className = `status-dot ${state}`;
  text.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
