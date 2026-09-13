import fs from 'node:fs';
const env = {};
for (const file of ['vite-app/.env.example','vite-app/e2e/.env']) for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) { const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) env[m[1]]=m[2].trim(); }
const base=env.VITE_SUPABASE_URL, key=env.VITE_SUPABASE_ANON_KEY;
const auth=await fetch(base+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({email:env.E2E_EMAIL,password:env.E2E_PASSWORD})});
if(!auth.ok) throw Error('Sign-in status '+auth.status);
const session=await auth.json();
const cases=[
 ['reverse embed','tickets_read?select=id,total,ticket_lines(kind,label,quantity,unit_rate,line_order)&ticket_lines.order=line_order.asc&limit=1',200],
 ['forward embed','tickets_read?select=id,total,profiles(name),jobs(job_number,clients(name))&limit=1',200],
 ['archive shape','tickets_read?select=id,total,profiles(name),ticket_lines(kind,label,unit,quantity,unit_rate,line_order)&limit=1',200],
 ['metadata','tickets?select=id,status,work_date&limit=1',200],
 ['total denial','tickets?select=total&limit=1',403],
 ['wildcard denial','tickets?select=*&limit=1',403],
 ['token denial','tickets?select=approval_token&limit=1',403]
];
let failures=0;
for(const [name,path,status] of cases){const r=await fetch(base+'/rest/v1/'+path,{headers:{apikey:key,Authorization:'Bearer '+session.access_token}});const body=await r.json();let pass=r.status===status;if(status===403)pass&&=body.code==='42501';else pass&&=Array.isArray(body)&&body.length>0;if(name==='reverse embed')pass&&=Array.isArray(body[0]?.ticket_lines)&&typeof body[0]?.total==='number'; console.log(JSON.stringify({name,pass,status:r.status,...(status===403?{code:body.code}:{rows:body.length})}));if(!pass)failures++;}
console.log('Failures: '+failures);process.exitCode=failures?1:0;
