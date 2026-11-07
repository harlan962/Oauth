import {resolve} from 'node:path';
import {Store} from '../server/store.js';
import {AdminAuth} from '../server/admin-auth.js';
import {acquireRuntimeLock} from '../server/runtime-lock.js';

const directory=resolve(process.env.ACCOUNT_DESK_DATA_DIR || 'data');
const release=acquireRuntimeLock(directory);
let store;
try {
  store=new Store(directory);
  const auth=new AdminAuth(store);auth.reset();
  console.log('后台登录已重置，旧登录会话已失效。账号和 API 密钥保留。');
  console.log(`启动项目后，使用 ${auth.codePath} 中的一次性设置码重新设置管理员。`);
} finally {store?.close();release();}
