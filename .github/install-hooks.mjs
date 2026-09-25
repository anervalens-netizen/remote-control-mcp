import {spawnSync} from 'node:child_process';
const check=spawnSync('git',['rev-parse','--is-inside-work-tree'],{stdio:'ignore'});
if(check.status===0){const result=spawnSync('git',['config','core.hooksPath','.githooks'],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
