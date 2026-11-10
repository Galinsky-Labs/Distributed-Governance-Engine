/** Content-free browser failure annotations alongside Node's normal spec log. */
const property=value=>String(value).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A').replaceAll(',','%2C').replaceAll(':','%3A');
const body=value=>String(value).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
export default async function* githubFailures(events){
 for await(const event of events){
  if(event.type!=='test:fail')continue;
  const data=event.data??{},error=data.details?.error,cause=error?.cause??error;
  const stack=typeof cause?.stack==='string'?cause.stack:'';
  const frame=stack.match(/\/(tests\/[A-Za-z0-9_./-]+\.mjs):(\d+):(\d+)/);
  const file=frame?.[1]??String(data.file??'').match(/(?:^|\/)(tests\/[A-Za-z0-9_./-]+\.mjs)$/)?.[1];
  const line=Number(frame?.[2]??data.line),column=Number(frame?.[3]??data.column);
  const type=/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(cause?.name??'')?cause.name:'TestFailure';
  const location=file&&!file.split('/').includes('..')?`,file=${property(file)}${Number.isSafeInteger(line)&&line>0?`,line=${line}`:''}${Number.isSafeInteger(column)&&column>0?`,col=${column}`:''}`:'';
  // Never copy assertion values, stack text, fixtures, document bodies or credentials.
  yield `::error title=Browser test failed${location}::${body(type+': '+String(data.name??'Unnamed test').slice(0,240))}\n`;
 }
}
