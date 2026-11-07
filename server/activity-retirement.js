const externalPurpose = 'WorkBuddy 国际版：远端账号池已存在（用户确认）';

export function retireActivity(store) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS workbuddy_registrations (
    accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    username TEXT NOT NULL, selectedAt TEXT NOT NULL
  )`);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) return;
  store.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO workbuddy_registrations(accountId,username,selectedAt)
      SELECT e.accountId,e.username,e.createdAt FROM events e
      JOIN accounts a ON a.id=e.accountId AND a.selectedAt=e.createdAt AND a.purpose=e.detail AND a.username=e.username COLLATE NOCASE
      WHERE e.action='select' AND e.detail=? AND NOT EXISTS (
        SELECT 1 FROM events newer WHERE newer.accountId=e.accountId AND newer.id>e.id AND newer.action IN ('select','release')
      )`).run(externalPurpose);
    db.exec('DROP TABLE events');
  });
  store.compact();
}

// This is current ownership evidence, not an append-only activity log.
export function updateRegistration(store, account, action, detail) {
  if (!['select','release'].includes(action)) return;
  store.db.prepare('DELETE FROM workbuddy_registrations WHERE accountId=?').run(account.id);
  if (action === 'select' && detail === externalPurpose) {
    store.db.prepare(`INSERT INTO workbuddy_registrations(accountId,username,selectedAt)
      SELECT id,username,selectedAt FROM accounts WHERE id=? AND selectedAt IS NOT NULL AND purpose=?`).run(account.id, externalPurpose);
  }
}
