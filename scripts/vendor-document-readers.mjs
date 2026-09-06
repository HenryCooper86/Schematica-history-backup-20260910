// Reproduce the committed browser distributions. Run: node scripts/vendor-document-readers.mjs
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
const packages = [
 {name:'pdfjs-dist',version:'6.3.289',folder:'pdfjs',integrity:'sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==',files:['build/pdf.mjs','build/pdf.worker.mjs','LICENSE','cmaps','standard_fonts']},
 {name:'mammoth',version:'1.12.2',folder:'mammoth',integrity:'sha512-MH2vkgafD/2MYUaEOtoXLKrHQZ7yLYTHGQgyLNtYZHiUxU1K1QQ+8qMFquDAfhBm06wSGSws3J+Q9QTsKtR44g==',files:['mammoth.browser.min.js','LICENSE']},
];
for (const pkg of packages) {
 const temp=await mkdtemp(join(tmpdir(),'schematica-vendor-'));
 try {
  const source=`https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
  const response=await fetch(source); if(!response.ok)throw Error(`Download failed: ${response.status}`);
  const tar=Buffer.from(await response.arrayBuffer());
  if(`sha512-${createHash('sha512').update(tar).digest('base64')}`!==pkg.integrity)throw Error('Package integrity mismatch');
  await writeFile(join(temp,'package.tgz'),tar);
  execFileSync('tar',['-xzf',join(temp,'package.tgz'),'-C',temp,...pkg.files.map(f=>`package/${f}`)]);
  const target=new URL(`vendor/${pkg.folder}/`,root); await mkdir(target,{recursive:true});
  const assets=[];
  async function copyAsset(file, destination) {
   const input=join(temp,'package',file);
   const children=await readdir(input,{withFileTypes:true}).catch(error=>{if(error.code==='ENOTDIR')return null;throw error;});
   if(children){await mkdir(new URL(destination+'/',target),{recursive:true});for(const child of children.sort((a,b)=>a.name.localeCompare(b.name)))await copyAsset(file+'/'+child.name,destination+'/'+child.name);}
   else {await copyFile(input,new URL(destination,target));assets.push({file:destination,sha256:createHash('sha256').update(await readFile(input)).digest('hex')});}
  }
  for(const file of pkg.files)await copyAsset(file,file.startsWith('build/')?file.slice(6):file);
  await writeFile(new URL('SOURCE.json',target),JSON.stringify({package:pkg.name,version:pkg.version,source,integrity:pkg.integrity,assets},null,2)+'\n');
 }finally{await rm(temp,{recursive:true,force:true});}
}
