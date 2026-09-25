import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,lstatSync,readlinkSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const approvedExampleDomains=new Set(['example.com','example.org','example.net','example.invalid','localhost','users.noreply.github.com']);
const syntheticUsers=new Set(['operator','runner','user','test','node','ubuntu','alice','bob','foo']);
const privatePath=/(?:^|\/)(?:\.env(?:\..*)?|devices\.local\.json|credentials(?:\.[^/]*)?|initial-users\.json|seed\.json|templates\.json|template-hashes\.json|mail-defaults\.json|resource-mode\.json)$|\.(?:sqlite(?:3)?|db|pem|key|p12|pfx|jks|keystore|xlsx|xls|csv|apk|aab)$/i;
const privateDirs=/(?:^|\/)(?:\.private|private|\.openai|data|backups|outputs|playwright-report|test-results)(?:\/|$)/;
const sensitivePatterns=[
 ['password-verifier',/scrypt:[a-f0-9]{16,}:[a-f0-9]{32,}|\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}|\$argon2(?:id|i|d)\$/g],
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
 ['access-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-proj-[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g],
];
export function inspectPublicFile(path,text=''){
 const issues=[];
 const add=(kind,index=0)=>issues.push({path,kind,line:text.slice(0,index).split('\n').length});
 if((privatePath.test(path)&&!path.endsWith('.env.example'))||privateDirs.test(path))add('private-file-path');
 if(/(?:^|\/)(?:screenshots|design-screenshots)(?:\/|$)/.test(path)||path.startsWith('public/products/'))add('private-or-generated-asset');
 for(const [kind,pattern] of sensitivePatterns){pattern.lastIndex=0;for(const m of text.matchAll(pattern))add(kind,m.index);}
 if(!/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|LICENSE[^/]*|NOTICE[^/]*)$/.test(path)){
  for(const m of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)){
   const domain=m[1].toLowerCase();
   if(!approvedExampleDomains.has(domain)&&!['.example.invalid','.example','.test','.invalid','.localhost'].some(suffix=>domain.endsWith(suffix))&&m[0]!=='git@github.com')add('non-example-email',m.index);
  }
 }
 for(const m of text.matchAll(/\/home\/([A-Za-z][A-Za-z0-9_.-]*)/g))if(!syntheticUsers.has(m[1]))add('personal-home-directory',m.index);
 return issues;
}
const git=(args,options={})=>execFileSync('git',args,{maxBuffer:80*1024*1024,...options});
export function checkRepository(args=process.argv.slice(2)){
 const staged=args.includes('--staged');const historyIndex=args.indexOf('--history');
 const files=[];const issues=[];
 if(historyIndex>=0){
  const ref=args[historyIndex+1]||'HEAD';
  if(!/^[A-Za-z0-9_./-]+$/.test(ref)||ref.startsWith('-'))throw new Error('Invalid Git reference.');
  const roots=git(['rev-list','--max-parents=0',ref],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  if(roots.length!==1||git(['log','-1','--format=%s',roots[0]],{encoding:'utf8'}).trim()!=='Publish sanitized public source baseline')issues.push({path:'<history>',kind:'legacy-history',line:1});
  const metadata=git(['log','--format=%ae%n%ce',ref],{encoding:'utf8'}).trim().split('\n');
  if(metadata.some(email=>!email.endsWith('@users.noreply.github.com')))issues.push({path:'<history>',kind:'non-noreply-author',line:1});
  const objects=git(['rev-list','--objects',ref],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  const seen=new Set();
  for(const entry of objects){
   const space=entry.indexOf(' ');if(space<0)continue;
   const sha=entry.slice(0,space),path=entry.slice(space+1);if(seen.has(sha))continue;seen.add(sha);
   if(git(['cat-file','-t',sha],{encoding:'utf8'}).trim()!=='blob')continue;
   files.push([path,git(['cat-file','blob',sha])]);
  }
 }else{
  const paths=git(['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  for(const path of paths){
   if(staged){files.push([path,git(['show',`:${path}`])]);continue;}
   if(!existsSync(path))continue;
   if(lstatSync(path).isSymbolicLink()){
    const target=readlinkSync(path);if(target.startsWith('/')||target.split('/').includes('..'))issues.push({path,kind:'external-symlink',line:1});
    continue;
   }
   files.push([path,readFileSync(path)]);
  }
 }
 for(const [path,data] of files)issues.push(...inspectPublicFile(path,data.includes(0)?'':data.toString('utf8')));
 // Never print matching values, credentials or personal content into CI logs.
 console.log(JSON.stringify({status:issues.length?'FAIL':'PASS',filesScanned:files.length,issues}));
 return issues.length?1:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.exitCode=checkRepository();}catch(error){console.error('Public-data verification could not complete: '+error.message.split('\n')[0]);process.exitCode=2;}}
