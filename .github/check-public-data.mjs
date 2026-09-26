import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,readlinkSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const approvedExampleDomains=new Set(['example.com','example.org','example.net','example.invalid','localhost','users.noreply.github.com']);
const syntheticUsers=new Set(['operator','runner','user','test','node','ubuntu','alice','bob','foo']);
const privatePath=/(?:^|\/)(?:\.env(?:\..*)?|devices\.local\.json|credentials(?:\.[^/]*)?|initial-users\.json|seed\.json|templates\.json|template-hashes\.json|mail-defaults\.json|resource-mode\.json)$|\.(?:sqlite(?:3)?|db|pem|key|p12|pfx|jks|keystore|xlsx|xls|csv|apk|aab)$/i;
const privateDirs=/(?:^|\/)(?:\.private|private|\.openai|data|backups|outputs|playwright-report|test-results)(?:\/|$)/;
const sensitivePatterns=[
 ['application-bearer',/\bRCMCP_[A-Z0-9_]*TOKEN["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{24,}/g],
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

// Text containing NUL is not necessarily binary: Git commonly stores UTF-16
// PowerShell/config files. Preserve UTF-8 scanning and decode likely UTF-16.
export function decodePublicText(data){
 if(data.length>=2 && data[0]===0xff && data[1]===0xfe)return data.subarray(2).toString('utf16le');
 if(data.length>=2 && data[0]===0xfe && data[1]===0xff){
  const body=Buffer.from(data.subarray(2));if(body.length%2)throw new Error('Invalid UTF-16 text length');
  return body.swap16().toString('utf16le');
 }
 if(data.length>=8 && data.length%2===0){
  let even=0,odd=0;const sample=Math.min(data.length,4096);
  for(let i=0;i<sample;i++)if(data[i]===0){if(i%2)odd++;else even++;}
  if(odd>sample*0.3 && even<sample*0.1)return data.toString('utf16le');
  if(even>sample*0.3 && odd<sample*0.1)return Buffer.from(data).swap16().toString('utf16le');
 }
 return data.toString('utf8');
}
function externalSymlink(data){
 const target=data.toString('utf8').replaceAll('\\','/');
 return target.startsWith('/')||/^[A-Za-z]:/.test(target)||target.split('/').includes('..');
}
function entries(raw){
 return raw.toString('utf8').split('\0').filter(Boolean).map(entry=>{
  const tab=entry.indexOf('\t');if(tab<0)throw new Error('Invalid Git tree entry');
  return {header:entry.slice(0,tab).split(' '),path:entry.slice(tab+1)};
 });
}
export function scanRepository(args=[]){
 const staged=args.includes('--staged'),historyIndex=args.indexOf('--history');
 if(staged&&historyIndex>=0)throw new Error('Choose staged or history verification, not both.');
 const issues=[],seenEntries=new Set(),contentCache=new Map();let filesScanned=0;
 const blob=sha=>{if(!contentCache.has(sha))contentCache.set(sha,git(['cat-file','blob',sha]));return contentCache.get(sha);};
 function inspect(path,mode,data){
  filesScanned++;
  issues.push(...inspectPublicFile(path,decodePublicText(data)));
  if(mode==='120000'&&externalSymlink(data))issues.push({path,kind:'external-symlink',line:1});
 }
 if(historyIndex>=0){
  const ref=args[historyIndex+1]||'HEAD';
  if(!/^[A-Za-z0-9_./-]+$/.test(ref)||ref.startsWith('-'))throw new Error('Invalid Git reference.');
  const roots=git(['rev-list','--max-parents=0',ref,'--'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  if(roots.length!==1||git(['log','-1','--format=%s',roots[0]],{encoding:'utf8'}).trim()!=='Publish sanitized public source baseline')issues.push({path:'<history>',kind:'legacy-history',line:1});
  const metadata=git(['log','-z','--format=%H%x00%ae%x00%ce%x00%B',ref,'--'],{encoding:'utf8'}).split('\0');
  if(metadata.at(-1)==='')metadata.pop();
  if(metadata.length%4!==0)throw new Error('Invalid Git commit metadata.');
  for(let i=0;i<metadata.length;i+=4){
   const [sha,author,committer,message]=metadata.slice(i,i+4);
   if(!author.endsWith('@users.noreply.github.com')||!committer.endsWith('@users.noreply.github.com'))issues.push({path:'<commit:'+sha+'>',kind:'non-noreply-author',line:1});
   issues.push(...inspectPublicFile('<commit:'+sha+'>',message));
  }
  // A blob ID does not identify its paths. Enumerate every distinct tree and
  // check (path, mode, blob) entries; cache only the byte reads by blob ID.
  const trees=new Set(git(['log','--format=%T',ref,'--'],{encoding:'utf8'}).trim().split('\n').filter(Boolean));
  for(const tree of trees)for(const {header,path} of entries(git(['ls-tree','-rz',tree]))){
   const [mode,type,sha]=header,key=JSON.stringify([path,mode,sha]);if(seenEntries.has(key))continue;seenEntries.add(key);
   if(type!=='blob'){issues.push({path,kind:'uninspected-git-entry',line:1});continue;}
   inspect(path,mode,blob(sha));
  }
 }else{
  for(const {header,path} of entries(git(['ls-files','--stage','-z']))){
   const [mode,sha,stage]=header;
   if(stage!=='0'){issues.push({path,kind:'unmerged-index',line:1});continue;}
   if(mode==='160000'){issues.push({path,kind:'uninspected-git-entry',line:1});continue;}
   if(staged){inspect(path,mode,blob(sha));continue;}
   let info;
   try{info=lstatSync(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   inspect(path,info.isSymbolicLink()?'120000':mode,info.isSymbolicLink()?Buffer.from(readlinkSync(path)):readFileSync(path));
  }
 }
 // Matching values are never emitted, even for commit metadata or fixtures.
 const unique=[...new Map(issues.map(issue=>[JSON.stringify(issue),issue])).values()];
 return {status:unique.length?'FAIL':'PASS',filesScanned,issues:unique};
}
export function checkRepository(args=process.argv.slice(2)){
 const result=scanRepository(args);console.log(JSON.stringify(result));return result.issues.length?1:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.exitCode=checkRepository();}catch(error){console.error('Public-data verification could not complete: '+error.message.split('\n')[0]);process.exitCode=2;}}
