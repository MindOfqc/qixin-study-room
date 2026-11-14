// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// study-cloud.js 依赖 worker-mailer，Worker 专有的 cloudflare:sockets 在 Node 里不可用。
vi.mock('worker-mailer', () => ({
  WorkerMailer: {
    connect: async () => ({ send: async () => {}, close: async () => {} }),
  },
}));

const { default: worker } = await import('../../cloudflare/chat-worker/worker.js');

const ADMIN_USER_ID = '3edfc331-d007-4610-8538-603d31f93fba';
const ADMIN_TOKEN = 'admin-token';
const PLAIN_TOKEN = 'plain-token';
const AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD=';

function createEnv() {
  const rows: Record<string, unknown>[] = [];
  const avatarStore = new Map<string, string>();
  const sessions: Record<string, unknown> = {
    [ADMIN_TOKEN]: {
      user_id: ADMIN_USER_ID,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      username: 'ordeal',
      is_admin: 1,
    },
    [PLAIN_TOKEN]: {
      user_id: 'plain-user',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      username: 'visitor',
      is_admin: 0,
    },
  };

  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const statement = {
          bind: (...values: unknown[]) => {
            args = values;
            return statement;
          },
          first: async () => {
            if (sql.includes('FROM study_sessions s JOIN study_users u')) {
              return sessions[String(args[0])] ?? null;
            }
            if (sql.startsWith('SELECT created_at FROM chat_messages')) {
              const mine = rows
                .filter((row) => row.author_id === args[0])
                .sort((a, b) =>
                  String(b.created_at).localeCompare(String(a.created_at)),
                );
              return mine[0] ?? null;
            }
            return null;
          },
          all: async () => {
            if (sql.includes('FROM chat_authors')) {
              return {
                results: args
                  .map((id, index) => ({
                    author_id: id,
                    avatar: avatarStore.get(String(id)),
                  }))
                  .filter((row) => row.avatar !== undefined),
              };
            }
            const limit = Number(args[0]);
            const sorted = [...rows].sort((a, b) =>
              String(b.created_at).localeCompare(String(a.created_at)),
            );
            return { results: sorted.slice(0, limit) };
          },
          run: async () => {
            if (sql.startsWith('INSERT INTO chat_messages')) {
              rows.push({
                id: args[0],
                author_id: args[1],
                author_name: args[2],
                content: args[3],
                created_at: args[4],
                author_is_admin: args[5],
              });
            }
            if (sql.startsWith('INSERT INTO chat_authors')) {
              avatarStore.set(String(args[0]), String(args[1]));
            }
            return { success: true };
          },
        };
        return statement;
      },
    },
  };
  return { env, rows, avatarStore };
}

function postMessage(
  env: unknown,
  input: Record<string, unknown>,
  token?: string,
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return worker.fetch(
    new Request('https://worker.local/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
    env,
  );
}

function listMessages(env: unknown) {
  return worker.fetch(
    new Request('https://worker.local/api/chat?limit=50'),
    env,
  );
}

describe('对话室作者身份', () => {
  let env: unknown;
  let rows: Record<string, unknown>[];
  let avatarStore: Map<string, string>;

  beforeEach(() => {
    ({ env, rows, avatarStore } = createEnv() as unknown as {
      env: unknown;
      rows: Record<string, unknown>[];
      avatarStore: Map<string, string>;
    });
  });

  it('登录的管理员用自己账号发言才带徽章', async () => {
    const response = await postMessage(
      env,
      {
        authorId: ADMIN_USER_ID,
        authorName: 'ordeal',
        content: '有问题在这里留言',
      },
      ADMIN_TOKEN,
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.message.authorIsAdmin).toBe(true);
    expect(rows[0].author_is_admin).toBe(1);

    const listed = await (await listMessages(env)).json();
    expect(listed.messages[0].authorIsAdmin).toBe(true);
  });

  it('未登录发言不带徽章', async () => {
    const response = await postMessage(
      env,
      { authorId: 'guest-user', authorName: '路痴', content: '第一天打卡' },
    );
    expect(response.status).toBe(201);
    expect((await response.json()).message.authorIsAdmin).toBe(false);
    expect(rows[0].author_is_admin).toBe(0);
  });

  it('普通登录账号不带徽章', async () => {
    const response = await postMessage(
      env,
      { authorId: 'plain-user', authorName: 'visitor', content: '在吗' },
      PLAIN_TOKEN,
    );
    expect(response.status).toBe(201);
    expect((await response.json()).message.authorIsAdmin).toBe(false);
  });

  it('拿管理员 token 冒充别人的 authorId 也不打标', async () => {
    const response = await postMessage(
      env,
      { authorId: 'someone-else', authorName: 'ordeal', content: '我是管理员' },
      ADMIN_TOKEN,
    );
    expect(response.status).toBe(201);
    expect((await response.json()).message.authorIsAdmin).toBe(false);
  });

  it('老库里缺 author_is_admin 列的历史消息按普通消息返回', async () => {
    rows.push({
      id: 'legacy-1',
      author_id: 'legacy-user',
      author_name: 'ordeal',
      content: '历史消息',
      created_at: new Date().toISOString(),
    });
    const listed = await (await listMessages(env)).json();
    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0].authorIsAdmin).toBe(false);
  });
});

describe('对话室作者头像', () => {
  let env: unknown;
  let avatarStore: Map<string, string>;

  beforeEach(() => {
    ({ env, avatarStore } = createEnv() as unknown as {
      env: unknown;
      avatarStore: Map<string, string>;
    });
  });

  it('带头像发言后，列表按作者返回头像', async () => {
    const posted = await postMessage(env, {
      authorId: 'guest-user',
      authorName: '路痴',
      content: '换了个头像',
      authorAvatar: AVATAR,
    });
    expect(posted.status).toBe(201);
    expect(avatarStore.get('guest-user')).toBe(AVATAR);

    const listed = await (await listMessages(env)).json();
    expect(listed.authors).toEqual({ 'guest-user': AVATAR });
  });

  it('不同作者各存一份头像，列表一次返回', async () => {
    const cases = [
      {
        authorId: 'guest-a',
        authorName: '路痴甲',
        content: '第一条',
        authorAvatar: 'data:image/png;base64,AAAA',
      },
      {
        authorId: 'guest-b',
        authorName: '路痴乙',
        content: '第二条',
        authorAvatar: 'data:image/webp;base64,BBBB',
      },
    ];
    for (const input of cases) {
      const posted = await postMessage(env, input);
      expect(posted.status).toBe(201);
    }
    expect(avatarStore.size).toBe(2);
    const listed = await (await listMessages(env)).json();
    expect(listed.authors).toEqual({
      'guest-a': 'data:image/png;base64,AAAA',
      'guest-b': 'data:image/webp;base64,BBBB',
    });
  });

  it('不带头像时不写作者表，列表也不返回', async () => {
    const posted = await postMessage(env, {
      authorId: 'guest-user',
      authorName: '路痴',
      content: '没头像',
    });
    expect(posted.status).toBe(201);
    expect(avatarStore.size).toBe(0);
    const listed = await (await listMessages(env)).json();
    expect(listed.authors).toEqual({});
  });

  it('非图片 data URL 的头像直接拒掉', async () => {
    for (const authorAvatar of [
      'data:text/html;base64,PHNjcmlwdD4=',
      'https://evil.local/a.png',
      'data:image/jpeg;base64,/9j/4AAQSkZJRg@',
      'data:image/jpeg;base64,' + 'A'.repeat(20_481),
    ]) {
      const response = await postMessage(env, {
        authorId: 'guest-user',
        authorName: '路痴',
        content: '试试塞东西',
        authorAvatar,
      });
      expect(response.status).toBe(400);
    }
    expect(avatarStore.size).toBe(0);
  });
});
