import { execFileSync } from "node:child_process";

export function createOmcErrorFixture(path, mode = "new", count = 2) {
  execFileSync("python3", ["-c", `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); mode=sys.argv[2]
c.execute('CREATE TABLE schema_migrations(version INTEGER)')
c.execute('INSERT INTO schema_migrations VALUES (?)',(59 if mode=='new' else 58,))
if mode != 'missing':
 c.execute('''CREATE TABLE error_events (
 id INTEGER PRIMARY KEY,instance_id TEXT,event_key TEXT,auth_id TEXT,auth_index TEXT,
 provider TEXT,model TEXT,status_code INTEGER,code TEXT,body TEXT,retryable INTEGER,
 auth_status TEXT,auth_disabled INTEGER,auth_unavailable INTEGER,quota_exceeded INTEGER,
 quota_reason TEXT,next_retry_after_ms INTEGER,next_recover_at_ms INTEGER,backoff_level INTEGER,
 timestamp_ms INTEGER,created_at_ms INTEGER)''')
 if mode=='new':
  for col,kind in [('cooldown_model','TEXT'),('auth_quota_aggregate','INTEGER'),('model_quota_inherited','INTEGER'),('model_quota_exceeded','INTEGER'),('model_quota_reason','TEXT'),('model_next_retry_after_ms','INTEGER'),('model_next_recover_at_ms','INTEGER'),('model_backoff_level','INTEGER')]:
   c.execute('ALTER TABLE error_events ADD COLUMN '+col+' '+kind)
 for i in range(1,int(sys.argv[3])+1):
  c.execute('''INSERT INTO error_events (id,instance_id,event_key,auth_id,auth_index,provider,model,status_code,code,body,retryable,auth_status,auth_disabled,auth_unavailable,quota_exceeded,quota_reason,next_retry_after_ms,next_recover_at_ms,backoff_level,timestamp_ms,created_at_ms)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (i,'default','err-key-'+str(i),'credential-secret','auth-9','openai','model-a',429,'rate_limit','Bearer token-value email=user@example.com credential-secret',1,'cooldown sk-proj-privatetoken123',0,1,1,'quota',1795137000000,1795140000000,2,1795136400000+i,1795136401000+i))
 if mode=='new': c.execute("UPDATE error_events SET cooldown_model='model-a',auth_quota_aggregate=1,model_quota_inherited=0,model_quota_exceeded=1,model_quota_reason='daily',model_next_retry_after_ms=1795137000000,model_next_recover_at_ms=1795140000000,model_backoff_level=3")
c.commit();c.close()
`, path, mode, String(count)], { encoding: "utf8" });
}
