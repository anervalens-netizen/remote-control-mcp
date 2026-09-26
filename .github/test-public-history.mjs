import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodePublicText,inspectPublicFile} from './check-public-data.mjs';
const scanner=fileURLToPath(new URL('./check-public-data.mjs',import.meta.url));
const roots=[];
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
function fixture(){const d=mkdtempSync(path.join(os.tmpdir(),'public-history-'));roots.push(d);git(d,'init','-q');git(d,'config','user.name','Test fixture');git(d,'config','user.email','fixture@users.noreply.github.com');git(d,'config','core.hooksPath',path.join(d,'unused-hooks'));return d;}
function commit(d,message='Publish sanitized public source baseline'){git(d,'add','--all');git(d,'commit','-qm',message);}
function scan(d,...args){const r=spawnSync(process.execPath,[scanner,...args],{cwd:d,encoding:'utf8'});assert.ok(r.status===0||r.status===1,r.stderr);return JSON.parse(r.stdout);}
let cases=0;
try{
 const d=fixture();writeFileSync(path.join(d,'credentials.json'),'synthetic\n');writeFileSync(path.join(d,'example.txt'),'synthetic\n');commit(d);git(d,'rm','-q','credentials.json');commit(d,'Remove fixture');
 assert.equal(scan(d).status,'PASS');assert.ok(scan(d,'--history','HEAD').issues.some(i=>i.path==='credentials.json'&&i.kind==='private-file-path'));cases++;
 const verifier=['scrypt','a'.repeat(32),'b'.repeat(64)].join(':');
 for(const data of [Buffer.from(verifier),Buffer.from(verifier,'utf16le'),Buffer.concat([Buffer.from([255,254]),Buffer.from(verifier,'utf16le')]),Buffer.concat([Buffer.from([254,255]),Buffer.from(verifier,'utf16le').swap16()])]){
  assert.ok(inspectPublicFile('config.txt',decodePublicText(data)).some(i=>i.kind==='password-verifier'));cases++;
 }
 const m=fixture();writeFileSync(path.join(m,'example.txt'),'synthetic');commit(m);writeFileSync(path.join(m,'example.txt'),'changed');commit(m,verifier);assert.ok(scan(m,'--history','HEAD').issues.some(i=>i.path.startsWith('<commit:')&&i.kind==='password-verifier'));cases++;
 assert.ok(inspectPublicFile('config.txt','RCMCP_AGENT_TOKEN='+ '9'.repeat(64)).some(i=>i.kind==='application-bearer'));cases++;
 const l=fixture();writeFileSync(path.join(l,'example.txt'),'synthetic');commit(l);
 const sha=execFileSync('git',['hash-object','-w','--stdin'],{cwd:l,input:'../outside-fixture',encoding:'utf8'}).trim();
 git(l,'update-index','--add','--cacheinfo','120000',sha,'link.txt');assert.ok(scan(l,'--staged').issues.some(i=>i.kind==='external-symlink'));
 git(l,'commit','-qm','Synthetic link fixture');assert.ok(scan(l,'--history','HEAD').issues.some(i=>i.kind==='external-symlink'));cases++;
 // NUL-delimited tree parsing must retain unusual names rather than normalize them away.
 const n=fixture();
 const content=execFileSync('git',['hash-object','-w','--stdin'],{cwd:n,input:'safe fixture',encoding:'utf8'}).trim();
 const tree=execFileSync('git',['mktree','-z'],{cwd:n,input:`100644 blob ${content}\tname\nwith-tab\t.txt\0`,encoding:'utf8'}).trim();
 const unusualCommit=git(n,'commit-tree',tree,'-m','Publish sanitized public source baseline');
 git(n,'update-ref','HEAD',unusualCommit);
 assert.equal(scan(n,'--history','HEAD').status,'PASS');cases++;
 console.log(`PASS: ${cases} history/encoding/path regression cases.`);
}finally{for(const d of roots)rmSync(d,{recursive:true,force:true});}
