// Existing feature tests run as a signed-in administrator. Authentication tests
// import server/app.js directly and never use this fixture wrapper.
import express from 'express';
import {scryptSync} from 'node:crypto';
import {createApp as createRealApp} from '../server/app.js';
const salt='11'.repeat(32),passwordHash=scryptSync('fixture-password-123',Buffer.from(salt,'hex'),64).toString('hex');

export function createApp(store,options={}) {
  const services=createRealApp(store,options);
  if(!services.auth.credentials().username)store.db.prepare('UPDATE admin_credentials SET username=?,salt=?,passwordHash=?,setupDigest=NULL WHERE id=1').run('fixture-admin',salt,passwordHash);
  const token=services.auth.createSession(),wrapper=express();
  wrapper.use((req,res,next)=>{
    req.headers.cookie=`ad_session=${token}`;
    req.headers['x-csrf-token']=services.auth.csrf(token);
    next();
  });
  wrapper.use(services.app);
  return {...services,app:wrapper};
}
