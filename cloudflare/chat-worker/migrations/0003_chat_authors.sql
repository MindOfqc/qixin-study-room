-- 对话室作者头像：按作者存一份，消息列表按 author_id 关联返回。
CREATE TABLE IF NOT EXISTS chat_authors (
  author_id TEXT PRIMARY KEY,
  avatar TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
