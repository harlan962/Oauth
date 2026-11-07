import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { prepareBrowserNetwork } from '../server/browser-network.js';
import { normalizeBrowserProxy } from '../server/browser-proxy.js';
import { ConnectionBrowser } from '../server/connection-browser.js';
import { OAuthBrowser } from '../server/oauth-browser.js';
import { chromium } from '../server/browser-runtime.js';
import { Server } from 'proxy-chain';

async function listen(server) {server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function refused(url) {
  const socket=net.connect({host:'127.0.0.1',port:Number(new URL(url).port)});
  const error=await new Promise(resolve=>{socket.once('error',resolve);socket.once('connect',()=>{socket.destroy();resolve(null);});});
  assert.equal(error?.code,'ECONNREFUSED');
}
async function fixture(t) {
  const credentials=[],destinations=[],sockets=new Set();let hits=0;
  const target=http.createServer((req,res)=>{hits++;res.end('SOCKS authenticated fixture');});
  const targetPort=await listen(target);
  const socks=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let data=Buffer.alloc(0),stage=0;
    const consume=n=>{const part=data.subarray(0,n);data=data.subarray(n);return part;};
    function receive(chunk){
      data=Buffer.concat([data,chunk]);
      if(stage===0){if(data.length<2||data.length<2+data[1])return;const greeting=consume(2+data[1]);if(greeting[0]!==5||!greeting.subarray(2).includes(2)){socket.end(Buffer.from([5,255]));return;}socket.write(Buffer.from([5,2]));stage=1;}
      if(stage===1){
        if(data.length<2||data.length<3+data[1])return;
        const userLength=data[1],passLength=data[2+userLength];if(data.length<3+userLength+passLength)return;
        const frame=consume(3+userLength+passLength),username=frame.subarray(2,2+userLength).toString(),password=frame.subarray(3+userLength).toString();
        credentials.push({username,password});
        if(username!=='provider-user'||password!=='p@ss:word'){socket.end(Buffer.from([1,1]));return;}
        socket.write(Buffer.from([1,0]));stage=2;
      }
      if(stage===2){
        if(data.length<5)return;
        const length=data[3]===3?7+data[4]:data[3]===1?10:22;if(data.length<length)return;
        const frame=consume(length),host=frame[3]===3?frame.subarray(5,length-2).toString():frame.subarray(4,8).join('.'),port=frame.readUInt16BE(length-2);
        destinations.push({host,port});
        if(host!=='relay-target.test'||port!==targetPort){socket.end(Buffer.from([5,5,0,1,0,0,0,0,0,0]));return;}
        stage=3;socket.removeListener('data',receive);socket.pause();
        const upstream=net.connect(targetPort,'127.0.0.1');sockets.add(upstream);
        upstream.on('error',()=>socket.destroy());upstream.on('close',()=>{sockets.delete(upstream);socket.destroy();});socket.on('close',()=>upstream.destroy());
        upstream.once('connect',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(data.length)upstream.write(data);socket.pipe(upstream);upstream.pipe(socket);socket.resume();});
      }
    }
    socket.on('data',receive);
  });
  const port=await listen(socks);
  t.after(async()=>{for(const socket of sockets)socket.destroy();target.closeAllConnections();await Promise.all([new Promise(r=>socks.close(r)),new Promise(r=>target.close(r))]);});
  return {credentials,destinations,targetPort,port,hits:()=>hits};
}

test('authenticated SOCKS5 handles Chromium HTTP and CONNECT tunnels, rejects bad credentials and closes its listener', {timeout:30000}, async t=>{
  const f=await fixture(t);
  const proxy=normalizeBrowserProxy({server:`socks5://provider-user:p%40ss%3Aword@127.0.0.1:${f.port}`});
  const network=await prepareBrowserNetwork(proxy);t.after(()=>network.close());
  assert.deepEqual(Object.keys(network.launchOptions.proxy),['server']);
  assert.match(network.launchOptions.proxy.server,/^http:\/\/127\.0\.0\.1:/);
  const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),...network.launchOptions});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(`http://relay-target.test:${f.targetPort}/`,{timeout:10000});
  assert.match(await page.locator('body').innerText(),/SOCKS authenticated fixture/);
  // Exercise the HTTPS CONNECT transport without requiring a public TLS service.
  const relay=new URL(network.launchOptions.proxy.server);
  const tunnel=net.connect(Number(relay.port),'127.0.0.1');await once(tunnel,'connect');
  tunnel.write(`CONNECT relay-target.test:${f.targetPort} HTTP/1.1\r\nHost: relay-target.test:${f.targetPort}\r\n\r\n`);
  const [connected]=await once(tunnel,'data');assert.match(connected.toString(),/200 Connection Established/);
  tunnel.write(`GET / HTTP/1.1\r\nHost: relay-target.test\r\nConnection: close\r\n\r\n`);
  const [body]=await once(tunnel,'data');assert.match(body.toString(),/SOCKS authenticated fixture/);tunnel.destroy();
  assert.ok(f.credentials.length>=2);assert.ok(f.credentials.every(x=>x.username==='provider-user'&&x.password==='p@ss:word'));
  await browser.close();await network.close();await network.close();await refused(relay.href);
  const wrong=await prepareBrowserNetwork({...proxy,password:'wrong'});t.after(()=>wrong.close());
  const before=f.hits(),wrongUrl=new URL(wrong.launchOptions.proxy.server);
  const status=await new Promise((resolve,reject)=>{const request=http.get({host:'127.0.0.1',port:wrongUrl.port,path:`http://relay-target.test:${f.targetPort}/`},res=>{res.resume();resolve(res.statusCode);});request.on('error',reject);});
  assert.ok(status>=500);assert.equal(f.hits(),before,'authentication failure never falls back to direct');
});

test('diagnostics and OAuth release authenticated SOCKS relays after launch failure and normal close', async()=>{
  const proxy={server:'socks5://127.0.0.1:1',username:'user',password:'secret'};
  const launches=[];
  const failing={executablePath:()=>process.execPath,launch:async options=>{launches.push(options.proxy.server);throw Error('raw secret');}};
  const result=await new ConnectionBrowser({chromium:failing}).check(proxy);
  assert.equal(result.ok,false);assert.doesNotMatch(result.message,/secret/);await refused(launches.at(-1));
  await assert.rejects(new OAuthBrowser({chromium:failing}).open({url:'https://www.workbuddy.ai/auth',account:{username:'fixture'},proxy}),/无法启动/);
  await refused(launches.at(-1));
  const engine={executablePath:()=>process.execPath,launch:async options=>{launches.push(options.proxy.server);return {close:async()=>{},newContext:async()=>({on(){},close:async()=>{},newPage:async()=>({goto:async()=>{}})})};}};
  const session=await new OAuthBrowser({chromium:engine}).open({url:'https://www.workbuddy.ai/auth',account:{username:'fixture'},proxy});
  await session.close();await refused(launches.at(-1));
});

test('direct launch bypasses system proxies and malformed credentials are rejected without leaking links',async()=>{
  assert.deepEqual((await prepareBrowserNetwork(null)).launchOptions,{args:['--no-proxy-server']});
  for(const server of ['socks5://user:pass@host','http://user:%00secret@host:123','http://user:%ZZ@host:123','http://user:secret@host:123/path','socks5://user:'+ 'x'.repeat(256)+'@host:123']){
    assert.throws(()=>normalizeBrowserProxy({server}),error=>!error.message.includes('secret'));
  }
});

test('Chromium uses credentials parsed from an HTTP provider link', {timeout:20000}, async t=>{
  let authenticated=0;
  const upstream=new Server({host:'127.0.0.1',port:0,prepareRequestFunction:({username,password})=>{
    const accepted=username==='provider-user'&&password==='p@ss:word';
    if(accepted)authenticated++;
    return {requestAuthentication:!accepted,customResponseFunction:()=>({statusCode:200,body:'Authenticated HTTP provider'})};
  }});
  await upstream.listen();t.after(()=>upstream.close(true));
  const proxy=normalizeBrowserProxy({server:`http://provider-user:p%40ss%3Aword@127.0.0.1:${upstream.port}`});
  const network=await prepareBrowserNetwork(proxy);t.after(()=>network.close());
  const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),...network.launchOptions});t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto('http://provider-target.test/',{timeout:10000});
  assert.match(await page.locator('body').innerText(),/Authenticated HTTP provider/);
  assert.ok(authenticated>0);
});
